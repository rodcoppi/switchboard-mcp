// Persistence layer (PRD sections 8 and 10.4).
//
// - messages.jsonl: append-only source of truth, one JSON record per line.
//   Lines are either full Message objects or read events
//   {"type":"read","messageId":"...","readAt":"..."}. The file is NEVER edited
//   in place; marking a message as read appends a read event and the in-memory
//   state consolidates on replay. Writes use fs.appendFileSync — single
//   process, low volume, synchronous is acceptable and interleaving-proof.
// - agents.json: full snapshot rewritten on every change via temp file +
//   fs.renameSync in the SAME directory (atomic on the same filesystem).
// - Boot: loads agents.json (if present) and replays messages.jsonl line by
//   line to rebuild unread state. Corrupted lines are logged and SKIPPED,
//   never crash the hub.
//
// Broadcast note: the store only holds messages that are already addressed to
// a single recipient (one record per recipient, sharing the same broadcastId).
// Expanding to === "all" into N records is the CALLER's responsibility
// (hub/MCP layer, Phase 2) — the store never fans out.
//
// Size note: enforcing body <= maxMessageBytes is also the caller's
// responsibility (Phase 2, where the tool error message instructs the model
// to use a file + path). The store does not impose it.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import type { Agent, Message } from "../shared/types.js";
import { defaultBaseDir } from "./config.js";

/** Agent name rule (PRD section 8): lowercase alphanumeric + hyphens, 2..31 chars. */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

/**
 * Names with system-level meaning, never registrable as agents. PRD section 8
 * defines the namespaces as disjoint: `from` is "agent name | operator" (the
 * human) and `to` is "agent name | all" (broadcast pseudo-recipient).
 * Allowing them as agent names would let any agent impersonate the human's
 * authority (from:"operator" is the protocol's only trust signal) or collide
 * with broadcast expansion. Enforced here — the single chokepoint through
 * which both REST register and MCP join pass.
 */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set(["operator", "all"]);

/** Sanity cap on registered agents (PRD section 14). */
export const MAX_AGENTS = 50;

/**
 * Capability token (PRD v1.1 addendum): 32 random bytes, hex-encoded (64
 * chars). Generated on register AND on re-attach — regenerating invalidates
 * the previous token, which is correct by definition: registration happens
 * BEFORE the new Claude Code opens (D4), so the previous session holding the
 * old token is dead (P7). The token is delivered ONLY via the
 * SWITCHBOARD_AGENT_TOKEN env var of the agent's tmux session and NEVER
 * logged or listed (section 15).
 */
export function generateAgentToken(): string {
  return randomBytes(32).toString("hex");
}

/** Read event record appended to messages.jsonl by markRead. */
interface ReadEvent {
  type: "read";
  messageId: string;
  readAt: string;
}

/** Minimal logger surface the store needs; satisfied by log.ts Logger and by console. */
export interface StoreLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface RegisterAgentInput {
  name: string;
  /**
   * undefined = "flag/field omitted": a re-register then PRESERVES the role
   * already stored (PRD 8: re-attach reuses the registration, never zeroes
   * it). An explicit "" clears it.
   */
  role?: string;
  tmuxSession: string;
  cwd: string;
}

export class Store {
  readonly baseDir: string;
  private readonly messagesPath: string;
  private readonly agentsPath: string;
  private readonly log: StoreLogger;

  private agents = new Map<string, Agent>();
  private messages: Message[] = []; // append/replay order (ULIDs are time-ordered)
  private messagesById = new Map<string, Message>();
  // Set when a previous append may have left the file without a trailing
  // newline (partial write on ENOSPC, or an unrepairable torn tail found at
  // boot). The next append then starts on a fresh line so a valid record is
  // never glued to torn bytes.
  private needsLeadingNewline = false;

  constructor(baseDir: string = defaultBaseDir(), logger: StoreLogger = console) {
    this.baseDir = baseDir;
    this.messagesPath = path.join(baseDir, "messages.jsonl");
    this.agentsPath = path.join(baseDir, "agents.json");
    this.log = logger;
    fs.mkdirSync(baseDir, { recursive: true });
    this.loadAgentsSnapshot();
    this.replayMessages();
  }

  // ------------------------------------------------------------------ agents

  /**
   * Registers an agent (called by `switchboard start` via REST, BEFORE the
   * Claude Code TUI opens — D4). If the name is already registered, the record
   * is reused and refreshed (logical re-attach, PRD section 8); whether the
   * tmux session may be reused is decided by the caller, not here.
   */
  registerAgent(input: RegisterAgentInput): Agent {
    if (RESERVED_AGENT_NAMES.has(input.name)) {
      throw new Error(
        `Reserved name: "${input.name}". "operator" (the human who owns the system) and "all" ` +
          `(broadcast pseudo-recipient) are system identities — choose another agent name.`,
      );
    }
    if (!AGENT_NAME_RE.test(input.name)) {
      throw new Error(
        `Invalid agent name: "${input.name}". Use lowercase letters, digits and hyphens ` +
          `(2 to 31 characters, starting with a letter or digit): ^[a-z0-9][a-z0-9-]{1,30}$`,
      );
    }

    const existing = this.agents.get(input.name);
    const now = new Date().toISOString();

    if (existing) {
      existing.role = input.role ?? existing.role; // omitted → preserve (PRD 8)
      existing.tmuxSession = input.tmuxSession;
      existing.cwd = input.cwd;
      // Registration happens BEFORE the new Claude Code opens (D4), so at
      // this instant the new incarnation cannot have joined via MCP yet —
      // stale status/mcpConnected from the previous incarnation would be a
      // false positive (PRD section 8: mcpConnected is "true after the first
      // join via MCP"). Phase 3 polling re-derives status; the Phase 2 join
      // re-sets mcpConnected.
      existing.status = "offline";
      existing.mcpConnected = false;
      existing.lastSeenAt = now;
      // Re-attach REGENERATES the capability token (v1.1): the previous
      // session is dead by definition (D4/P7), so the old token must stop
      // working — otherwise anyone who ever saw it could join as this agent.
      existing.token = generateAgentToken();
      this.saveAgentsSnapshot();
      return existing;
    }

    if (this.agents.size >= MAX_AGENTS) {
      throw new Error(
        `Limit of ${MAX_AGENTS} registered agents reached. Remove old agents before registering new ones.`,
      );
    }

    const agent: Agent = {
      name: input.name,
      role: input.role ?? "",
      tmuxSession: input.tmuxSession,
      cwd: input.cwd,
      // Status is derived from tmux has-session polling (Phase 3); a fresh
      // registration starts offline until the poller/MCP proves otherwise.
      status: "offline",
      mcpConnected: false,
      muted: false,
      createdAt: now,
      lastSeenAt: now,
      lastNudgeAt: null,
      token: generateAgentToken(),
    };
    this.agents.set(agent.name, agent);
    this.saveAgentsSnapshot();
    return agent;
  }

  /**
   * NOTE: returns the LIVE Agent object — do not mutate it directly; use
   * updateAgent, the only sanctioned mutation path (it persists the snapshot).
   */
  getAgent(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  /**
   * Deletes an agent's REGISTRATION (post-v1, dashboard history management).
   * Messages are untouched — messages.jsonl is append-only and remains the
   * source of truth; a later re-registration under the same name sees its old
   * unread again. Returns false when the name is unknown.
   */
  removeAgent(name: string): boolean {
    if (!this.agents.delete(name)) return false;
    this.saveAgentsSnapshot();
    return true;
  }

  /**
   * NOTE: the array is a copy, but the Agent objects are LIVE references —
   * do not mutate them directly; use updateAgent.
   */
  listAgents(): Agent[] {
    return [...this.agents.values()];
  }

  /**
   * Merges a partial update into an existing agent and persists the snapshot.
   * Keys explicitly set to `undefined` are ignored (JSON.stringify would drop
   * them from the snapshot and the isAgent guard would then discard the WHOLE
   * record on the next boot — silent loss of the registration). The merged
   * record is validated before anything is mutated or persisted: the store
   * never writes a snapshot it would refuse to read back.
   */
  updateAgent(name: string, patch: Partial<Omit<Agent, "name">>): Agent {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(`Unknown agent: "${name}".`);
    }

    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key === "name" || value === undefined) continue; // name is immutable (Map key)
      cleaned[key] = value;
    }

    const merged = { ...agent, ...cleaned };
    if (!isAgent(merged)) {
      throw new Error(
        `updateAgent("${name}"): patch would produce an invalid record — nothing was changed. ` +
          `Patch: ${JSON.stringify(patch)}`,
      );
    }

    Object.assign(agent, cleaned);
    this.saveAgentsSnapshot();
    return agent;
  }

  /**
   * Boot reconciliation (called once by startHub): MCP sessions live only in
   * the hub's in-memory Map, so by construction NONE survives a hub restart —
   * any mcpConnected=true / status="online" loaded from agents.json is ghost
   * state left by a non-graceful shutdown (kill -9, power loss; only a clean
   * close() resets it via dropSession). Without this, /api/agents and
   * list_agents would report dead agents as connected/online forever.
   */
  resetConnectionState(): void {
    let changed = false;
    for (const agent of this.agents.values()) {
      if (agent.mcpConnected || agent.status === "online") {
        agent.mcpConnected = false;
        agent.status = "offline";
        changed = true;
      }
    }
    if (changed) this.saveAgentsSnapshot();
  }

  // ---------------------------------------------------------------- messages

  /**
   * Appends a new message (already addressed to a single recipient — see the
   * broadcast note at the top). Generates the ULID and timestamps here.
   */
  appendMessage(input: {
    from: string;
    to: string;
    body: string;
    broadcastId?: string | null;
  }): Message {
    for (const field of ["from", "to", "body"] as const) {
      if (typeof input[field] !== "string" || input[field].length === 0) {
        throw new Error(`Invalid message: required field "${field}" missing or empty.`);
      }
    }

    const message: Message = {
      id: ulid(),
      from: input.from,
      to: input.to,
      body: input.body,
      createdAt: new Date().toISOString(),
      readAt: null,
      broadcastId: input.broadcastId ?? null,
    };

    this.appendJsonLine(message);
    this.indexMessage(message);
    return message;
  }

  /**
   * Returns a shallow COPY — mutating it does not touch store state (the only
   * sanctioned way to flip readAt is markRead, which appends the read event).
   */
  getMessage(id: string): Message | undefined {
    const message = this.messagesById.get(id);
    return message ? { ...message } : undefined;
  }

  /** Shallow copies — see getMessage. */
  listMessages(): Message[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /**
   * Marks a message as read by APPENDING a read event to messages.jsonl —
   * never editing the original line in place (PRD section 8) — and updating
   * the in-memory record. Idempotent: returns false for unknown ids or
   * already-read messages, true when the read event was recorded.
   */
  markRead(messageId: string, readAt: string = new Date().toISOString()): boolean {
    const message = this.messagesById.get(messageId);
    if (!message) {
      this.log.warn(`[store] markRead: unknown message "${messageId}" — ignoring.`);
      return false;
    }
    if (message.readAt !== null) {
      return false; // already read; do not append a duplicate event
    }
    const event: ReadEvent = { type: "read", messageId, readAt };
    this.appendJsonLine(event);
    message.readAt = readAt;
    return true;
  }

  /** Unread messages addressed to an agent, in append (time) order. Shallow copies — see getMessage. */
  unreadFor(name: string): Message[] {
    return this.messages
      .filter((m) => m.to === name && m.readAt === null)
      .map((m) => ({ ...m }));
  }

  unreadCount(name: string): number {
    return this.unreadFor(name).length;
  }

  /** Unique senders of unread messages for an agent, in first-appearance order. */
  unreadSenders(name: string): string[] {
    const senders: string[] = [];
    for (const message of this.unreadFor(name)) {
      if (!senders.includes(message.from)) senders.push(message.from);
    }
    return senders;
  }

  // ------------------------------------------------------------- persistence

  private indexMessage(message: Message): void {
    this.messages.push(message);
    this.messagesById.set(message.id, message);
  }

  /**
   * Appends one JSON record + "\n" to messages.jsonl. If a previous append
   * threw mid-write (e.g. ENOSPC: appendFileSync may write partial bytes AND
   * throw), the next append is prefixed with "\n" so the new record starts on
   * a fresh line instead of being glued to the torn bytes.
   */
  private appendJsonLine(record: unknown): void {
    const prefix = this.needsLeadingNewline ? "\n" : "";
    try {
      fs.appendFileSync(this.messagesPath, prefix + JSON.stringify(record) + "\n");
      this.needsLeadingNewline = false;
    } catch (err) {
      this.needsLeadingNewline = true;
      throw err;
    }
  }

  /**
   * Rewrites agents.json in full: write a temp file in the SAME directory,
   * then fs.renameSync over the target (atomic on the same filesystem —
   * readers see either the old or the new snapshot, never a partial write).
   */
  private saveAgentsSnapshot(): void {
    const tempPath = this.agentsPath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(this.listAgents(), null, 2) + "\n");
    fs.renameSync(tempPath, this.agentsPath);
  }

  private loadAgentsSnapshot(): void {
    if (!fs.existsSync(this.agentsPath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.agentsPath, "utf8"));
    } catch (err) {
      this.log.warn(
        `[store] agents.json corrupted (${String(err)}) — starting with zero agents.`,
      );
      return;
    }
    if (!Array.isArray(parsed)) {
      this.log.warn(`[store] agents.json is not an array — starting with zero agents.`);
      return;
    }
    for (const entry of parsed) {
      if (!isAgent(entry)) {
        this.log.warn(`[store] invalid agent record in snapshot — skipping.`);
      } else if (RESERVED_AGENT_NAMES.has(entry.name)) {
        // Legacy data written before the reserved-name guard: loading it would
        // reopen the operator-impersonation / broadcast-collision hole via join.
        this.log.warn(
          `[store] agent with reserved name "${entry.name}" in snapshot — skipping.`,
        );
      } else {
        this.agents.set(entry.name, entry);
      }
    }
  }

  /**
   * Replays messages.jsonl line by line, rebuilding messages and unread state.
   * Each line is either a Message or a ReadEvent. Corrupted or unrecognized
   * lines: log a warn and SKIP — never crash (PRD 10.4).
   */
  private replayMessages(): void {
    if (!fs.existsSync(this.messagesPath)) return;
    const content = fs.readFileSync(this.messagesPath, "utf8");

    // Seal a torn tail left by a crash mid-append (kill -9, ENOSPC, WSL down):
    // without this, the NEXT append would glue a valid record onto the torn
    // line, corrupting it too — silent loss of a confirmed message on the
    // following boot. Sealed, the torn line becomes an isolated corrupted
    // line, skipped below as usual (PRD 10.4).
    if (content.length > 0 && !content.endsWith("\n")) {
      this.log.warn(
        `[store] messages.jsonl did not end in a newline (last line truncated by a crash?) — sealing the file.`,
      );
      try {
        fs.appendFileSync(this.messagesPath, "\n");
      } catch (err) {
        this.needsLeadingNewline = true;
        this.log.warn(
          `[store] could not seal messages.jsonl (${String(err)}) — the next append will start on a new line.`,
        );
      }
    }

    const lines = content.split("\n");
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      if (line.trim() === "") continue;

      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        this.log.warn(
          `[store] messages.jsonl line ${lineNo}: corrupted JSON — skipping.`,
        );
        continue;
      }

      if (isReadEvent(record)) {
        const message = this.messagesById.get(record.messageId);
        if (message) {
          message.readAt = record.readAt;
        } else {
          this.log.warn(
            `[store] messages.jsonl line ${lineNo}: read event for unknown message "${record.messageId}" — skipping.`,
          );
        }
      } else if (isMessage(record)) {
        if (this.messagesById.has(record.id)) {
          // A duplicated line (concatenated backup restore, manual edit) must
          // not enter this.messages twice: the array copy would keep
          // readAt null forever (markRead only reaches the Map's object),
          // jamming the unread count permanently.
          this.log.warn(
            `[store] messages.jsonl line ${lineNo}: duplicated line for id "${record.id}" — skipping.`,
          );
        } else {
          this.indexMessage(record);
        }
      } else {
        this.log.warn(
          `[store] messages.jsonl line ${lineNo}: unrecognized record — skipping.`,
        );
      }
    }
  }
}

// ------------------------------------------------------------- type guards

function isReadEvent(value: unknown): value is ReadEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "read" &&
    typeof v.messageId === "string" &&
    typeof v.readAt === "string"
  );
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.from === "string" &&
    typeof v.to === "string" &&
    typeof v.body === "string" &&
    typeof v.createdAt === "string" &&
    (v.readAt === null || typeof v.readAt === "string") &&
    (v.broadcastId === null || typeof v.broadcastId === "string")
  );
}

function isAgent(value: unknown): value is Agent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.role === "string" &&
    typeof v.tmuxSession === "string" &&
    typeof v.cwd === "string" &&
    (v.status === "online" || v.status === "offline") &&
    typeof v.mcpConnected === "boolean" &&
    typeof v.muted === "boolean" &&
    typeof v.createdAt === "string" &&
    typeof v.lastSeenAt === "string" &&
    (v.lastNudgeAt === null || typeof v.lastNudgeAt === "string") &&
    // token is optional: pre-v1.1 snapshots have no token field (legacy
    // record — the first join claims the name and generates one).
    (v.token === undefined || typeof v.token === "string")
  );
}
