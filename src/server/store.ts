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
import { ulid } from "ulid";
import type { Agent, Message } from "../shared/types.js";
import { defaultBaseDir } from "./config.js";

/** Agent name rule (PRD section 8): lowercase alphanumeric + hyphens, 2..31 chars. */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

/** Sanity cap on registered agents (PRD section 14). */
export const MAX_AGENTS = 50;

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
  role: string;
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
    if (!AGENT_NAME_RE.test(input.name)) {
      throw new Error(
        `Nome de agente inválido: "${input.name}". Use minúsculas, dígitos e hífens ` +
          `(2 a 31 caracteres, começando com letra ou dígito): ^[a-z0-9][a-z0-9-]{1,30}$`,
      );
    }

    const existing = this.agents.get(input.name);
    const now = new Date().toISOString();

    if (existing) {
      existing.role = input.role;
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
      this.saveAgentsSnapshot();
      return existing;
    }

    if (this.agents.size >= MAX_AGENTS) {
      throw new Error(
        `Limite de ${MAX_AGENTS} agentes registrados atingido. Remova agentes antigos antes de registrar novos.`,
      );
    }

    const agent: Agent = {
      name: input.name,
      role: input.role,
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
      throw new Error(`Agente desconhecido: "${name}".`);
    }

    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key === "name" || value === undefined) continue; // name is immutable (Map key)
      cleaned[key] = value;
    }

    const merged = { ...agent, ...cleaned };
    if (!isAgent(merged)) {
      throw new Error(
        `updateAgent("${name}"): patch produziria um registro inválido — nada foi alterado. ` +
          `Patch: ${JSON.stringify(patch)}`,
      );
    }

    Object.assign(agent, cleaned);
    this.saveAgentsSnapshot();
    return agent;
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
        throw new Error(`Mensagem inválida: campo obrigatório "${field}" ausente ou vazio.`);
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
      this.log.warn(`[store] markRead: mensagem desconhecida "${messageId}" — ignorando.`);
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
        `[store] agents.json corrompido (${String(err)}) — começando com zero agentes.`,
      );
      return;
    }
    if (!Array.isArray(parsed)) {
      this.log.warn(`[store] agents.json não é um array — começando com zero agentes.`);
      return;
    }
    for (const entry of parsed) {
      if (isAgent(entry)) {
        this.agents.set(entry.name, entry);
      } else {
        this.log.warn(`[store] registro de agente inválido no snapshot — pulando.`);
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
        `[store] messages.jsonl não terminava em newline (última linha truncada por crash?) — selando o arquivo.`,
      );
      try {
        fs.appendFileSync(this.messagesPath, "\n");
      } catch (err) {
        this.needsLeadingNewline = true;
        this.log.warn(
          `[store] não foi possível selar messages.jsonl (${String(err)}) — o próximo append começará em linha nova.`,
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
          `[store] messages.jsonl linha ${lineNo}: JSON corrompido — pulando.`,
        );
        continue;
      }

      if (isReadEvent(record)) {
        const message = this.messagesById.get(record.messageId);
        if (message) {
          message.readAt = record.readAt;
        } else {
          this.log.warn(
            `[store] messages.jsonl linha ${lineNo}: evento read para mensagem desconhecida "${record.messageId}" — pulando.`,
          );
        }
      } else if (isMessage(record)) {
        if (this.messagesById.has(record.id)) {
          // A duplicated line (concatenated backup restore, manual edit) must
          // not enter this.messages twice: the array copy would keep
          // readAt null forever (markRead only reaches the Map's object),
          // jamming the unread count permanently.
          this.log.warn(
            `[store] messages.jsonl linha ${lineNo}: linha duplicada para o id "${record.id}" — pulando.`,
          );
        } else {
          this.indexMessage(record);
        }
      } else {
        this.log.warn(
          `[store] messages.jsonl linha ${lineNo}: registro não reconhecido — pulando.`,
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
    (v.lastNudgeAt === null || typeof v.lastNudgeAt === "string")
  );
}
