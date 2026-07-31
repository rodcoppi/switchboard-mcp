// REST + SSE surface of the hub (PRD section 10.1), consumed by the dashboard
// (Phase 6) and by the CLI (Phase 4). Same process, same port as /mcp.
//
// Also home of two pieces shared with mcp.ts (both sides of the hub speak the
// same message semantics):
// - EventBus: in-process fan-out of SseEvent to every open /api/events stream.
//   EVERY mutation (register, mute, message append, read) emits here.
// - deliverMessage + validation helpers: recipient/size checks and the
//   "all" broadcast expansion (N records sharing one broadcastId, sender
//   excluded — PRD section 8). The store never fans out; this layer does.
//
// Errors are ALWAYS JSON {ok:false, error} with a proper HTTP status. The
// malformed-JSON-body case (SyntaxError thrown inside express.json(), before
// any handler runs — spike NOTES.md finding 5) is handled by the hub-level
// error middleware in hub.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { ulid } from "ulid";
import {
  toPublicAgent,
  type Agent,
  type Config,
  type Delivery,
  type Message,
  type OnMessage,
  type SseEvent,
} from "../shared/types.js";
import type { Logger } from "./log.js";
import { GROUP_NAME_RE, resolveGroup, type Store } from "./store.js";
// Value imports for the instanceof mapping and the /api/fs/dirs path
// translation below. No runtime cycle: launcher.ts imports this module with
// `import type` only (erased at compile time).
import { LaunchError, normalizeIncomingPath, type Launcher } from "./launcher.js";
import { PickError, pickWindowsFolder } from "./winpicker.js";
import { TerminalError } from "./terminal.js";
import { PreviewError, rawMime, readPreview, resolveInScope } from "./filepreview.js";
import { isOpenable, refusalFor, type FileOpener } from "./fileopen.js";
import { MAX_STT_BYTES, SttError, type SttProxy } from "./stt.js";
import { parseConversation, projectDirForCwd } from "./conversation.js";
import {
  codexUsageSnapshot,
  findCodexRolloutForCwd,
  parseCodexRollout,
  type CodexUsageSnapshot,
} from "./codexlog.js";
import type { UsageProbe } from "./usage.js";
import {
  invalidAgentTypeMessage,
  isAgentType,
  resolveAgentType,
  type AgentType,
} from "../shared/agent-types.js";

// ---------------------------------------------------------------------------
// EventBus — SSE fan-out (PRD 10.1: GET /api/events).
// ---------------------------------------------------------------------------

export type SseListener = (event: SseEvent) => void;

export class EventBus {
  private listeners = new Set<SseListener>();

  /** Subscribes a listener; returns the unsubscribe function. */
  subscribe(listener: SseListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: SseEvent): void {
    // Hard guarantee of the v1.1 addendum: no SSE listener ever sees a
    // capability token. Emit call sites already pass redacted payloads, but
    // Agent is structurally assignable to PublicAgent (the token is just an
    // extra property), so a forgotten toPublicAgent at a future call site
    // would leak silently — redact here too, the single fan-out chokepoint.
    if (event.type === "agent_updated") {
      event = { ...event, payload: toPublicAgent(event.payload as Agent) };
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken SSE client must never take the hub down; the res.write
        // failure path already schedules the connection close.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared message semantics (used by POST /api/messages AND the send_message
// MCP tool). All error strings are in English, written FOR the reader to
// self-correct (a model on the MCP side, a human on the REST side).
// ---------------------------------------------------------------------------

export interface RecipientError {
  /**
   * Error class, so REST can map the HTTP status correctly (PRD 10.1: "status
   * HTTP correto"): "unknown_recipient" is a real not-found (404); everything
   * else — empty recipient, self-send, broadcast without recipients — is a
   * validation error (400).
   */
  code: "invalid" | "unknown_recipient";
  error: string;
}

/**
 * Everyone `from` is allowed to message: its own group, minus itself. The
 * operator is in no group and owns the board, so it reaches every agent.
 * Sorted, because these names go into error text a model reads.
 */
export function reachableFrom(store: Store, from: string): string[] {
  const all = store.listAgents().filter((a) => a.name !== from);
  if (from === "operator") return all.map((a) => a.name).sort();
  const sender = store.getAgent(from);
  if (!sender) return [];
  return all
    .filter((a) => resolveGroup(a.group) === resolveGroup(sender.group))
    .map((a) => a.name)
    .sort();
}

/**
 * Validates the recipient. Returns a {code, error} object, or null when valid.
 * "all" requires at least one reachable agent.
 *
 * This is where the group wall stands, because it is the one chokepoint both
 * the MCP send_message and the REST POST /api/messages pass through. An agent
 * outside the sender's group is reported as UNKNOWN rather than forbidden: from
 * inside the group it does not exist, and a model that is told "this one exists
 * but is off limits" tries to work around the limit. The names it can actually
 * use come back with the error, so the retry is a correct one.
 */
export function validateRecipient(
  store: Store,
  from: string,
  to: string,
): RecipientError | null {
  if (typeof to !== "string" || to.length === 0) {
    return {
      code: "invalid",
      error: `Recipient required: provide the name of a registered agent or "all" for broadcast.`,
    };
  }
  if (to === from) {
    return {
      code: "invalid",
      error: `You cannot send a message to yourself ("${to}" is your own name).`,
    };
  }

  const reachable = reachableFrom(store, from);
  if (to === "all") {
    if (reachable.length === 0) {
      return {
        code: "invalid",
        error:
          `Broadcast has no recipients: no other agent is in your group. ` +
          `Use the list_agents tool to see who is available before sending.`,
      };
    }
    return null;
  }
  if (!reachable.includes(to)) {
    return {
      code: "unknown_recipient",
      error:
        `Unknown recipient: "${to}". You can message: ` +
        `${reachable.length > 0 ? reachable.join(", ") : "(nobody — no other agent is in your group)"}. ` +
        `Use the list_agents tool to find who is on the network, or "all" to reach all of them.`,
    };
  }
  return null;
}

/**
 * Enforces a non-empty body and maxMessageBytes (PRD section 14). The size
 * error instructs the sender to write a file and send the absolute path
 * instead of the content. The empty check runs HERE (before the MCP path's
 * rate limiter) so an empty send never burns a pair budget slot nor escapes
 * as a raw store throw instead of the {ok:false, error} envelope.
 */
export function validateBodySize(config: Config, body: string): string | null {
  if (body.length === 0) {
    return `Empty message: send factual and actionable content, or send nothing.`;
  }
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > config.maxMessageBytes) {
    return (
      `Message too large (${bytes} bytes; maximum ${config.maxMessageBytes}). ` +
      `Write the content to a file on disk and send the absolute path instead of the content.`
    );
  }
  return null;
}

export interface DeliverResult {
  delivery: Delivery;
  messages: Message[];
  broadcastId: string | null;
}

// Best-first ranking to summarize a broadcast into the single `delivery`
// field of the send_message output (PRD 9.2 declares one value).
const DELIVERY_RANK: Record<Delivery, number> = {
  nudged: 0,
  coalesced: 1,
  queued_offline: 2,
  queued_muted: 3,
};

/**
 * Appends the message (expanding to === "all" into one record per registered
 * agent except the sender, all sharing one broadcastId), emits
 * message_created for each record, and asks onMessage (the Phase 3 dispatcher
 * extension point) for the delivery outcome of each recipient.
 *
 * Callers MUST have validated recipient and size first — this function only
 * persists and notifies. Never blocks (PRD section 4, rule 4).
 */
export function deliverMessage(
  store: Store,
  bus: EventBus,
  onMessage: OnMessage,
  input: { from: string; to: string; body: string; group?: string },
): DeliverResult {
  const broadcastId = input.to === "all" ? ulid() : null;
  // "all" means everyone the sender is ALLOWED to reach, which for an agent is
  // its own group. A broadcast that leaked into other groups would be the one
  // hole in the wall, and the loudest possible one: it wakes every agent on the
  // machine.
  //
  // The operator reaches everybody, so for the human "all" is the whole board —
  // unless it says which group it means. The dashboard always says, because it
  // shows one room at a time and a broadcast that jumped from the room you are
  // reading to every project on the machine is precisely the accident groups
  // exist to prevent.
  const recipients: Agent[] =
    input.to === "all"
      ? reachableFrom(store, input.from)
          .map((name) => store.getAgent(name)!)
          .filter((a) => input.group === undefined || resolveGroup(a.group) === input.group)
      : [store.getAgent(input.to)!];

  const messages: Message[] = [];
  let delivery: Delivery = "queued_muted"; // lowest rank; every recipient can only improve it
  for (const recipient of recipients) {
    const message = store.appendMessage({
      from: input.from,
      to: recipient.name,
      body: input.body,
      broadcastId,
    });
    messages.push(message);
    bus.emit({ type: "message_created", payload: message });
    const result = onMessage(message, recipient);
    if (DELIVERY_RANK[result] < DELIVERY_RANK[delivery]) delivery = result;
  }

  return { delivery, messages, broadcastId };
}

// ---------------------------------------------------------------------------
// REST + SSE router (PRD section 10.1, endpoint by endpoint).
// ---------------------------------------------------------------------------

/**
 * Manual-nudge surface of the Phase 3 dispatcher (structural type so api.ts
 * does not need to import dispatcher.ts). Undefined when the hub was started
 * with a custom onMessage override (no dispatcher — tests).
 */
export interface ManualNudger {
  forceNudge(name: string): Promise<{ sent: boolean; reason?: string }>;
}

/**
 * The agent-screen bridge (terminal.ts). Structural type, like ManualNudger:
 * undefined when the hub runs with a stubbed onMessage (no tmux, no terminals).
 */
export interface Terminals {
  attachViewer(
    session: string,
    viewer: {
      onGrid(grid: { cols: number; rows: number }): void;
      onBytes(bytes: Buffer): void;
      onEnd(reason: string): void;
    },
  ): Promise<() => void>;
  input(session: string, bytes: Buffer): Promise<void>;
  resize(session: string, cols: number, rows: number): Promise<void>;
}

export interface ApiOptions {
  store: Store;
  config: Config;
  log: Logger;
  bus: EventBus;
  /** Delivery extension point (Phase 3 dispatcher; hub.ts wires it). */
  onMessage: OnMessage;
  /** Manual nudge executor for POST /api/agents/:name/nudge (dispatcher). */
  nudger?: ManualNudger;
  /**
   * Server-side agent launcher for POST /api/agents/launch (the dashboard's
   * "Launch agent" form). Undefined when the hub was started with a custom
   * onMessage override (no tmux — tests): the endpoint then answers 501,
   * exactly like the manual-nudge placeholder.
   */
  launcher?: Launcher;
  /**
   * The agent-screen bridge for the terminal routes. Undefined for the same
   * reason as `launcher` (no tmux → nothing to stream): the routes answer 501.
   */
  terminals?: Terminals;
  /**
   * Claude Code projects directory used by GET /api/fs/dirs for the
   * best-effort "conversation" badge (default ~/.claude/projects).
   * Injectable so tests never read the operator's real conversation index.
   */
  claudeProjectsDir?: string;
  /** Claude /usage bars proxy (OAuth-backed, cached). Undefined → /api/usage = []. */
  usage?: UsageProbe;
  /**
   * Kills an agent's tmux session (POST /api/agents/:name/stop — the
   * dashboard's one-click "stop & remove"). Undefined (tests, stubbed
   * onMessage) → the endpoint answers 501, like launcher/terminals.
   */
  stopper?: (session: string) => Promise<void>;
  /**
   * Opens a file in the Windows default app (POST /api/files/open — the
   * preview's "open" button, for what the dashboard cannot render: video,
   * archives, PDFs). Null off WSL and undefined in tests → the route answers
   * 501, like launcher/terminals.
   */
  fileOpener?: FileOpener | null;
  /**
   * Speech-to-text proxy for POST /api/stt (the composer's dictation mic).
   * Undefined/null → the route answers 501 with configuration instructions.
   */
  stt?: SttProxy | null;
  /** Hub start timestamp (epoch ms) for /api/health uptime. */
  startedAt: number;
  /** Hub version string for /api/health (from package.json). */
  version: string;
  /** SSE heartbeat comment interval (default ~25s; injectable for tests). */
  heartbeatMs?: number;
}

/**
 * GET /api/fs/dirs listing cap: keeps a pathological directory
 * (node_modules-scale) cheap to serialize and render in the dashboard.
 */
const FS_DIRS_CAP = 500;
/** Pathless clipboard images are scratch material, never permanent storage. */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

function sweepExpiredUploads(dir: string, now = Date.now()): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    try {
      if (now - fs.statSync(file).mtimeMs >= UPLOAD_TTL_MS) fs.rmSync(file, { force: true });
    } catch {
      /* raced a deletion / unreadable scratch file — leave it alone */
    }
  }
}

/**
 * GET /api/agents/:name/files bounds. The walk is breadth-first and triple-
 * bounded (depth, vendor dirs, entries visited) so a pathological tree —
 * a node_modules that slipped past the skip list, a runaway generated dir —
 * stays cheap. No caching: a walk this bounded re-runs per keystroke fine.
 */
const AGENT_FILES_SKIP = new Set([
  "node_modules", ".git", "dist", "build", ".next", "target", "__pycache__",
]);
const AGENT_FILES_MAX_DEPTH = 5;
const AGENT_FILES_CAP = 200; // hard ceiling on ?limit
const AGENT_FILES_SCAN_CAP = 20_000; // entries visited before the walk bails

/**
 * Downloads folders that belong to the local operator. WSL's home and the
 * Windows profile are separate trees, while agents casually call both of them
 * "Downloads". Keep the scope narrow: only the Downloads directories, never a
 * whole Windows profile.
 */
function downloadRoots(): string[] {
  const roots = [path.join(os.homedir(), "Downloads")];
  let mounts: fs.Dirent[] = [];
  try {
    mounts = fs.readdirSync("/mnt", { withFileTypes: true });
  } catch {
    /* not WSL */
  }
  for (const mount of mounts) {
    if (!mount.isDirectory() || !/^[a-z]$/i.test(mount.name)) continue;
    const users = path.join("/mnt", mount.name, "Users");
    let profiles: fs.Dirent[];
    try {
      profiles = fs.readdirSync(users, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const profile of profiles) {
      if (!profile.isDirectory()) continue;
      roots.push(path.join(users, profile.name, "Downloads"));
    }
  }
  return [...new Set(roots)].filter((root) => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Resolves a bare filename mentioned in prose. Exact basename only, bounded
 * breadth-first search, no symlink traversal. A Downloads hint changes root
 * priority but never expands the allowed roots.
 */
function findMentionedFile(
  filename: string,
  agentCwd: string,
  preferDownloads: boolean,
): string | null {
  const downloads = downloadRoots().map((root) => ({ root, maxDepth: 3 }));
  const project = agentCwd.trim() === "" ? [] : [{ root: agentCwd, maxDepth: AGENT_FILES_MAX_DEPTH }];
  const searches = preferDownloads ? [...downloads, ...project] : [...project, ...downloads];
  const allowedRoots = searches.map((search) => search.root);
  const needle = filename.toLowerCase();

  for (const { root, maxDepth } of searches) {
    let scanned = 0;
    let level = [""];
    for (let depth = 0; depth < maxDepth && level.length > 0 && scanned < AGENT_FILES_SCAN_CAP; depth++) {
      const next: string[] = [];
      for (const relDir of level) {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (++scanned > AGENT_FILES_SCAN_CAP) break;
          const isDir = entry.isDirectory();
          if (isDir && AGENT_FILES_SKIP.has(entry.name)) continue;
          const rel = relDir === "" ? entry.name : path.join(relDir, entry.name);
          if (isDir) {
            next.push(rel);
            continue;
          }
          if (!entry.isFile() && !entry.isSymbolicLink()) continue;
          if (entry.name.toLowerCase() !== needle) continue;
          try {
            return resolveInScope(path.join(root, rel), allowedRoots);
          } catch {
            /* a symlink escaped scope or raced deletion — keep looking */
          }
        }
      }
      level = next;
    }
  }
  return null;
}

/**
 * Best-effort "this folder has a previous Claude Code conversation" probe for
 * the dir browser badge. Claude Code stores each project's sessions under
 * `<claudeProjectsDir>/<encoded>` where encoded = the absolute path with `/`,
 * `.` and spaces each replaced by `-` (verified empirically on WSL:
 * "/home/me/projects/ai panorama" → "-home-me-projects-ai-panorama"), holding
 * one `.jsonl` per conversation. Any failure — missing dir, permissions,
 * future encoding drift — just means "no badge"; never an error, and never
 * more than directory NAMES read (no file contents).
 */
function hasClaudeConversation(claudeProjectsDir: string, absPath: string): boolean {
  try {
    const encoded = absPath.replace(/[/. ]/g, "-");
    return fs
      .readdirSync(path.join(claudeProjectsDir, encoded), { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

export function createApiRouter(options: ApiOptions): express.Router {
  const { store, config, log, bus, onMessage, nudger, launcher, terminals, usage, stopper, fileOpener, stt, startedAt, version } =
    options;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const claudeProjectsDir =
    options.claudeProjectsDir ?? path.join(os.homedir(), ".claude", "projects");
  const uploadsDir = path.join(store.baseDir, "uploads");
  sweepExpiredUploads(uploadsDir); // also cleans leftovers from an older hub
  const router = express.Router();

  // GET /api/agents → PublicAgent[] with aggregated unreadCount. Redacted:
  // the capability token never appears in listings (v1.1, section 15).
  router.get("/api/agents", (_req, res) => {
    const agents = store
      .listAgents()
      .map((agent) => ({
        ...toPublicAgent(agent),
        unreadCount: store.unreadCount(agent.name),
      }));
    res.json(agents);
  });

  // GET /api/messages?agent=X&limit=200 → Message[], most recent first.
  // The optional agent filter matches either side of the conversation
  // (dashboard: clicking a card shows everything involving that agent).
  router.get("/api/messages", (req, res) => {
    const agent = typeof req.query.agent === "string" ? req.query.agent : undefined;
    let limit = 200;
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        res.status(400).json({
          ok: false,
          error: `Invalid "limit" parameter: ${String(req.query.limit)} (expected a positive integer).`,
        });
        return;
      }
    }
    let messages = store.listMessages();
    if (agent !== undefined) {
      messages = messages.filter((m) => m.from === agent || m.to === agent);
    }
    res.json(messages.reverse().slice(0, limit));
  });

  // POST /api/messages — body {to, body}; from is FIXED as "operator"
  // (the human, via dashboard or `switchboard send`).
  router.post("/api/messages", (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const to = raw.to;
    const body = raw.body;
    if (typeof to !== "string" || typeof body !== "string" || body.length === 0) {
      res.status(400).json({
        ok: false,
        error: `Invalid body: expected {"to": "<agent|all>", "body": "<text>"} with both non-empty.`,
      });
      return;
    }

    const recipientError = validateRecipient(store, "operator", to);
    if (recipientError) {
      // 404 only for a real not-found (unknown recipient); empty/self/
      // broadcast-without-recipients are validation errors → 400 (PRD 10.1).
      const status = recipientError.code === "unknown_recipient" ? 404 : 400;
      res.status(status).json({ ok: false, error: recipientError.error });
      return;
    }
    const sizeError = validateBodySize(config, body);
    if (sizeError) {
      res.status(400).json({ ok: false, error: sizeError });
      return;
    }
    // Optional, and only meaningful with to:"all": scopes the human's broadcast
    // to one group instead of the whole board (see deliverMessage).
    const group = raw.group;
    if (group !== undefined && (typeof group !== "string" || !GROUP_NAME_RE.test(group))) {
      res.status(400).json({
        ok: false,
        error: `Invalid group: "${String(group)}" is not a group name.`,
      });
      return;
    }
    if (typeof group === "string" && store.listAgentsInGroup(group).length === 0) {
      res.status(404).json({
        ok: false,
        error: `Unknown group: "${group}". No agent belongs to it.`,
      });
      return;
    }

    // No pair rate limit here: section 14 is the anti-loop layer BETWEEN
    // AGENTS; "operator" is the human, who has the dashboard mute/visibility
    // as their own control plane.
    const result = deliverMessage(store, bus, onMessage, {
      from: "operator",
      to,
      body,
      group: group as string | undefined,
    });
    log.info(`[api] operator → ${to}: message recorded (delivery=${result.delivery}).`);
    res.status(201).json({
      ok: true,
      delivery: result.delivery,
      messages: result.messages,
      broadcastId: result.broadcastId,
    });
  });

  // POST /api/agents/register — used by `switchboard start` (Phase 4),
  // BEFORE the Claude Code TUI opens (D4). Logical re-attach of an existing
  // name is handled by the store (PRD section 8).
  //
  // KNOWN RESIDUAL RISK (accepted by the v1.1 spec — PRD sections 10.1/15):
  // this endpoint is deliberately unauthenticated (trust boundary = the local
  // machine; "any local process can post to the Hub"). Because
  // re-registering an existing name regenerates AND returns a fresh token, a
  // malicious LOCAL process can obtain a valid token for any agent name and
  // impersonate it via `join` — invalidating the legitimate session's
  // SWITCHBOARD_AGENT_TOKEN as a side effect (its re-join after a hub restart
  // then fails). The capability token therefore only blocks impersonation by
  // processes that know an agent's name but never call this endpoint. Do NOT
  // "fix" this here without PRD approval: requiring the current token to
  // rotate would break the sanctioned re-attach flow (`switchboard start`
  // never holds the old token — it only receives one from this response).
  // The Phase 5 README security note MUST document this residual risk
  // alongside the "never port-forward 4577" warning (PRD 15).
  router.post("/api/agents/register", (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      res.status(400).json({
        ok: false,
        error: `Invalid body: expected {"name", "role"?, "cwd"?, "tmuxSession"?} with "name" required.`,
      });
      return;
    }
    for (const key of ["role", "cwd", "tmuxSession"] as const) {
      if (raw[key] !== undefined && typeof raw[key] !== "string") {
        res.status(400).json({
          ok: false,
          error: `Invalid body: field "${key}" must be a string when present.`,
        });
        return;
      }
    }
    // `switchboard start/wire --agent <type>` reports which CLI it is opening
    // so the dashboard can label the agent and a reopen can reuse the type.
    if (raw.agentType !== undefined && !isAgentType(raw.agentType)) {
      res.status(400).json({ ok: false, error: invalidAgentTypeMessage(raw.agentType) });
      return;
    }

    try {
      const agent = store.registerAgent({
        // role stays undefined when the field is absent: the store then
        // PRESERVES the registered role on re-attach (PRD 8) instead of
        // silently erasing it with "". agentType follows the same rule.
        name: raw.name,
        role: raw.role as string | undefined,
        agentType: raw.agentType as AgentType | undefined,
        group: raw.group as string | undefined,
        cwd: (raw.cwd as string | undefined) ?? "",
        tmuxSession:
          (raw.tmuxSession as string | undefined) ?? config.tmuxSessionPrefix + raw.name,
      });
      bus.emit({ type: "agent_updated", payload: toPublicAgent(agent) });
      // The token itself is NEVER logged (v1.1, section 15).
      log.info(`[api] agent registered: ${agent.name} (tmux: ${agent.tmuxSession}).`);
      // v1.1 (PRD 10.1): the register response is the ONE REST surface that
      // carries the capability token — `switchboard start` (Phase 4) reads it
      // here and injects SWITCHBOARD_AGENT_TOKEN into the agent's tmux
      // session. The embedded agent object stays redacted.
      res.status(201).json({ ok: true, agent: toPublicAgent(agent), token: agent.token });
    } catch (err) {
      // Invalid name or MAX_AGENTS cap — store errors are already in English.
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  // POST /api/agents/launch — the dashboard's "Launch agent" form: the hub
  // itself creates the agent's tmux session running claude (server-side
  // sibling of `switchboard wire`). Body {dir, name?, role?, continue?}.
  // The launcher registers via the store (agent_updated SSE emitted there),
  // replaces a homonymous live session automatically, settles, auto-falls
  // back from a dead `claude -c` and schedules the in-process kickoff. The
  // response agent is REDACTED (toPublicAgent inside the launcher) — the
  // capability token only ever rides the tmux session env, never this HTTP
  // response and never the logs (v1.1, PRD 15).
  router.post("/api/agents/launch", async (req, res) => {
    if (!launcher) {
      // Hub started with a custom onMessage override (no tmux — tests).
      res.status(501).json({
        ok: false,
        error:
          "Launcher unavailable: this hub was started without the tmux launcher " +
          "(custom onMessage).",
      });
      return;
    }
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (typeof raw.dir !== "string" || raw.dir.trim() === "") {
      res.status(400).json({
        ok: false,
        error:
          `Invalid body: expected {"dir": "<absolute directory>", "name"?, "role"?, ` +
          `"continue"?, "agentType"?} with "dir" required.`,
      });
      return;
    }
    for (const key of ["name", "role"] as const) {
      if (raw[key] !== undefined && typeof raw[key] !== "string") {
        res.status(400).json({
          ok: false,
          error: `Invalid body: field "${key}" must be a string when present.`,
        });
        return;
      }
    }
    for (const key of ["continue", "openTerminal"] as const) {
      if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
        res.status(400).json({
          ok: false,
          error: `Invalid body: field "${key}" must be a boolean when present.`,
        });
        return;
      }
    }
    // Which agent CLI to open. Rejected rather than silently defaulted: a typo
    // ("codx") that quietly launched Claude Code would be a baffling surprise.
    if (raw.agentType !== undefined && !isAgentType(raw.agentType)) {
      res.status(400).json({ ok: false, error: invalidAgentTypeMessage(raw.agentType) });
      return;
    }
    // Rejected rather than defaulted, for the reason above and one more: a
    // typo'd group is a group of one, and an agent alone in a room looks
    // identical to a working install right up until it needs to reach someone.
    if (raw.group !== undefined && !GROUP_NAME_RE.test(String(raw.group))) {
      res.status(400).json({
        ok: false,
        error:
          `Invalid group name: "${String(raw.group)}". Use lowercase letters, digits and ` +
          `hyphens (2 to 31 characters, starting with a letter or digit).`,
      });
      return;
    }

    try {
      const result = await launcher.launchAgent({
        dir: raw.dir,
        name: raw.name as string | undefined,
        role: raw.role as string | undefined,
        continueConversation: (raw.continue as boolean | undefined) ?? false,
        openTerminal: (raw.openTerminal as boolean | undefined) ?? false,
        agentType: raw.agentType as AgentType | undefined,
        group: raw.group as string | undefined,
      });
      log.info(
        `[api] launch: agent ${result.agent.name} launched from the dashboard ` +
          `(agent=${resolveAgentType(result.agent.agentType)}, ` +
          `replaced=${result.replaced}, fallback=${result.fallback}).`,
      );
      res.status(201).json({
        ok: true,
        agent: result.agent,
        replaced: result.replaced,
        fallback: result.fallback,
        ...(result.terminalOpened === undefined
          ? {}
          : { terminalOpened: result.terminalOpened }),
      });
    } catch (err) {
      if (err instanceof LaunchError) {
        // Actionable message for the dashboard toast: 400 for input problems,
        // 500 for server-side launch failures — never the generic 500 page.
        res.status(err.status).json({ ok: false, error: err.message });
        return;
      }
      log.error(`[api] unexpected error launching an agent:`, err);
      res.status(500).json({ ok: false, error: "Internal Hub error." });
    }
  });

  // POST /api/agents/:name/terminal — dashboard "open" button: pops a WINDOWS
  // terminal window attached to the agent's live tmux session (WSL interop;
  // wt.exe with a cmd.exe fallback). Owner feedback drove this: an agent
  // running in a detached background session is invisible — "might as well
  // not exist". 409 with the reason when a window cannot open (non-WSL hub,
  // dead session); the reason always includes the manual `tmux attach` line.
  router.post("/api/agents/:name/terminal", async (req, res) => {
    const name = req.params.name;
    if (!store.getAgent(name)) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${name}".` });
      return;
    }
    if (!launcher) {
      res.status(501).json({
        ok: false,
        error:
          "Terminal windows unavailable: this hub was started without the tmux launcher " +
          "(custom onMessage).",
      });
      return;
    }
    const result = await launcher.openTerminal(name);
    if (result.opened) {
      res.json({ ok: true, opened: true });
      return;
    }
    res.status(409).json({ ok: false, error: result.reason ?? "Could not open a window." });
  });

  // POST /api/agents/:name/folder — open the agent's PROJECT FOLDER (its cwd) in
  // Windows Explorer. Unlike /api/files/open this needs no allowlist and no
  // scope check: the path is the agent's cwd from the STORE, which the operator
  // set at launch — trusted input, not a message body. It is strictly less than
  // launch, which already spawns a process in exactly that directory.
  router.post("/api/agents/:name/folder", async (req, res) => {
    const name = req.params.name;
    const agent = store.getAgent(name);
    if (!agent) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${name}".` });
      return;
    }
    const cwd = typeof agent.cwd === "string" ? agent.cwd.trim() : "";
    if (cwd === "") {
      res.status(400).json({ ok: false, error: `"${name}" has no recorded folder.` });
      return;
    }
    if (!fileOpener) {
      res.status(501).json({
        ok: false,
        error: "Opening a folder needs the hub to run under WSL (it hands the path to Windows Explorer).",
      });
      return;
    }
    try {
      const stat = fs.statSync(cwd);
      if (!stat.isDirectory()) {
        res.status(400).json({ ok: false, error: `Not a folder: ${cwd}` });
        return;
      }
    } catch {
      res.status(404).json({ ok: false, error: `Folder not found: ${cwd}` });
      return;
    }
    try {
      await fileOpener.open(cwd);
      log.info(`[files] opened project folder for ${name}: ${cwd}`);
      res.json({ ok: true, path: cwd });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`[files] could not open folder for ${name}: ${reason}`);
      res.status(500).json({ ok: false, error: `Could not open the folder (${reason}).` });
    }
  });

  // GET /api/fs/dirs?path=<abs> — the dashboard's folder browser (backs the
  // "Browse…" panel of the Launch agent form). Answers the SUBDIRECTORY NAMES
  // POST /api/fs/pick — opens the NATIVE Windows folder dialog and answers with
  // the WSL path the operator chose. Body {startIn?: "<path>"}.
  //
  // The hub opens it because a browser will not hand a page a folder's absolute
  // path (see winpicker.ts) — the one thing the launcher needs is the one thing
  // the sandbox withholds. Same interop as the terminal opener, same trust
  // boundary: this reveals a path the operator picked themselves, on a hub bound
  // to 127.0.0.1, next to an endpoint that already launches processes in any
  // directory they name.
  //
  // 503 + fallback:true when there is no Windows to ask (plain Linux, no
  // powershell.exe): the dashboard then opens its own folder browser, which is
  // why this can never be a dead end. 408 when nobody answers the dialog.
  router.post("/api/fs/pick", async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const startIn = typeof raw.startIn === "string" && raw.startIn.trim() !== ""
      ? raw.startIn.trim()
      : undefined;
    try {
      const picked = await pickWindowsFolder(startIn);
      if (picked === null) {
        res.json({ ok: true, cancelled: true });
        return;
      }
      log.info(`[api] folder picked in the Windows dialog: ${picked}`);
      res.json({ ok: true, path: picked });
    } catch (err) {
      if (err instanceof PickError) {
        res.status(err.unsupported ? 503 : 500).json({
          ok: false,
          error: err.message,
          fallback: err.unsupported,
        });
        return;
      }
      // execFile's own timeout kills powershell and lands here: the dialog is
      // still open on the desktop but nobody is listening for it any more.
      res.status(408).json({
        ok: false,
        error: "The folder dialog was not answered in time. Click Browse again, or type the path.",
        fallback: true,
      });
    }
  });

  // GET /api/files/preview?path=<abs path> — file preview for the dashboard.
  // Agents name paths in their messages; the dashboard makes those clickable and
  // shows the file here. SCOPED (see filepreview.ts): reads only under an agent
  // working dir or the operator's home, resolved with realpath so `..`/symlinks
  // cannot escape, because a message body is untrusted (an agent could plant a
  // sensitive path). Everything else is refused, never read.
  // Scope = every agent's cwd (an agent may run outside home) + the operator's
  // home. Empty cwds (legacy records) are dropped. Shared by preview and open:
  // both read a path a MESSAGE named, so both answer to the same boundary.
  function fileScopeRoots(): string[] {
    return [
      ...new Set(
        store
          .listAgents()
          .map((a) => a.cwd)
          .filter((c) => typeof c === "string" && c.trim() !== ""),
      ),
      os.homedir(),
      ...downloadRoots(),
    ];
  }

  router.get("/api/files/preview", (req, res) => {
    const rawPath = typeof req.query.path === "string" ? req.query.path : "";
    try {
      const real = resolveInScope(rawPath, fileScopeRoots());
      res.json({ ok: true, ...readPreview(real), openable: isOpenable(real) });
    } catch (err) {
      const status = err instanceof PreviewError ? err.status : 500;
      res.status(status).json({ ok: false, error: (err as Error).message });
    }
  });

  // POST /api/files/open { path } — hand a file to the Windows default app, for
  // what the dashboard cannot render (a video above all; also archives, PDFs).
  //
  // The scope check ALONE is not enough here, unlike the preview: previewing
  // only reads bytes, but Windows RUNS what it opens, and an agent can write a
  // .bat inside its own working dir — which is in scope. So the allowlist
  // (fileopen.ts) is the second, independent gate, and both must pass.
  router.post("/api/files/open", async (req, res) => {
    if (!fileOpener) {
      res.status(501).json({
        ok: false,
        error:
          "Opening files in a system app needs the hub to run under WSL " +
          "(it hands the path to the Windows shell).",
      });
      return;
    }
    const raw = req.body as { path?: unknown };
    const rawPath = typeof raw?.path === "string" ? raw.path : "";
    let real: string;
    try {
      real = resolveInScope(rawPath, fileScopeRoots());
    } catch (err) {
      const status = err instanceof PreviewError ? err.status : 500;
      res.status(status).json({ ok: false, error: (err as Error).message });
      return;
    }
    if (!isOpenable(real)) {
      res.status(403).json({ ok: false, error: refusalFor(real) });
      return;
    }
    try {
      await fileOpener.open(real);
      log.info(`[files] opened in a system app: ${real}`);
      res.json({ ok: true, path: real });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`[files] could not open ${real}: ${reason}`);
      res.status(500).json({ ok: false, error: `Could not open it (${reason}).` });
    }
  });

  // GET /api/files/raw?path=<abs> — serve the file's bytes to a BROWSER TAB:
  // an .html an agent built opens as the actual site, an image at full size, a
  // PDF in the built-in viewer. Same scope wall as the preview (the path came
  // from a message, so it is untrusted) plus one wall the preview never
  // needed: this response lives on the DASHBOARD's origin, and an
  // agent-authored HTML page runs scripts — without a sandbox it could call
  // this very API with the operator's authority (launch agents, nudge them,
  // open files). `CSP: sandbox allow-scripts` gives the document an OPAQUE
  // origin: its scripts run and the site works, but its requests to the hub
  // stop being same-origin and gain nothing. No allowlist gate: unlike
  // /api/files/open nothing is EXECUTED here — the tab renders bytes inside
  // that sandbox, or downloads them.
  router.get("/api/files/raw", (req, res) => {
    const rawPath = typeof req.query.path === "string" ? req.query.path : "";
    let real: string;
    try {
      real = resolveInScope(rawPath, fileScopeRoots());
    } catch (err) {
      const status = err instanceof PreviewError ? err.status : 500;
      res.status(status).json({ ok: false, error: (err as Error).message });
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      res.status(404).json({ ok: false, error: `File not found: ${real}` });
      return;
    }
    if (!stat.isFile()) {
      res.status(400).json({ ok: false, error: `Not a file: ${real}` });
      return;
    }
    res.setHeader("Content-Type", rawMime(real));
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-popups");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", String(stat.size));
    fs.createReadStream(real)
      .on("error", (err) => {
        log.warn(`[files] raw stream failed for ${real}: ${err.message}`);
        res.destroy(err);
      })
      .pipe(res);
  });

  // POST /api/files/reveal { path } — Windows Explorer with the file SELECTED
  // ("show in folder"). Scope-checked like the preview, and deliberately NOT
  // allowlisted like /api/files/open: revealing never opens or runs the file,
  // Explorer lands on the parent folder with the entry highlighted — pointing
  // at an agent-written .bat is as inert as listing its directory.
  router.post("/api/files/reveal", async (req, res) => {
    if (!fileOpener) {
      res.status(501).json({
        ok: false,
        error:
          "Revealing a file in Explorer needs the hub to run under WSL " +
          "(it hands the path to Windows).",
      });
      return;
    }
    const raw = req.body as { path?: unknown };
    const rawPath = typeof raw?.path === "string" ? raw.path : "";
    let real: string;
    try {
      real = resolveInScope(rawPath, fileScopeRoots());
    } catch (err) {
      const status = err instanceof PreviewError ? err.status : 500;
      res.status(status).json({ ok: false, error: (err as Error).message });
      return;
    }
    try {
      await fileOpener.reveal(real);
      log.info(`[files] revealed in Explorer: ${real}`);
      res.json({ ok: true, path: real });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`[files] could not reveal ${real}: ${reason}`);
      res.status(500).json({ ok: false, error: `Could not show it in the folder (${reason}).` });
    }
  });

  // of one absolute path: never files, never file contents; hidden
  // (dot-prefixed) entries excluded; sorted case-insensitively; capped at
  // FS_DIRS_CAP (truncated:true when the cap hits). `path` omitted → the
  // hub's home directory. Windows Explorer paths (\\wsl$\..., C:\...) are
  // translated exactly like the launch "dir" input. Localhost trust model:
  // this exposes strictly less than POST /api/agents/launch above, which
  // already spawns a process in any directory the operator names (PRD 15:
  // the trust boundary is the machine — the hub binds 127.0.0.1 only).
  router.get("/api/fs/dirs", (req, res) => {
    const rawPath =
      typeof req.query.path === "string" && req.query.path.trim() !== ""
        ? req.query.path
        : os.homedir();
    let target = path.normalize(normalizeIncomingPath(rawPath));
    // Drop trailing slashes (normalize keeps them) so `path`, `parent` and
    // the entry paths stay canonical — except the filesystem root itself.
    if (target.length > 1) target = target.replace(/\/+$/, "");
    if (!path.isAbsolute(target)) {
      res.status(400).json({
        ok: false,
        error:
          `"path" must be an absolute path (got "${rawPath}"). Windows Explorer ` +
          `WSL paths (\\\\wsl$\\<distro>\\...) and drive paths (C:\\...) are ` +
          `accepted and translated automatically.`,
      });
      return;
    }
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(target).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      res.status(400).json({
        ok: false,
        error: `Not a browsable directory: ${target} (it does not exist or is not a directory).`,
      });
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: `Cannot list ${target}: ${err instanceof Error ? err.message : String(err)}.`,
      });
      return;
    }

    // Directories only. Symlinks count when they resolve to one: the launch
    // endpoint's own fs.statSync check follows symlinks, so a symlinked
    // project folder IS launchable and must be navigable here too.
    const names = entries
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => {
        if (entry.isDirectory()) return true;
        if (!entry.isSymbolicLink()) return false;
        try {
          return fs.statSync(path.join(target, entry.name)).isDirectory();
        } catch {
          return false; // broken symlink — not navigable
        }
      })
      .map((entry) => entry.name)
      .sort((a, b) => {
        const la = a.toLowerCase();
        const lb = b.toLowerCase();
        if (la !== lb) return la < lb ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0; // deterministic tie-break
      });

    const truncated = names.length > FS_DIRS_CAP;
    const dirs = (truncated ? names.slice(0, FS_DIRS_CAP) : names).map((name) => {
      const dirPath = path.join(target, name);
      return {
        name,
        path: dirPath,
        hasConversation: hasClaudeConversation(claudeProjectsDir, dirPath),
      };
    });

    res.json({
      ok: true,
      path: target,
      parent: target === "/" ? null : path.dirname(target),
      home: os.homedir(),
      dirs,
      ...(truncated ? { truncated: true } : {}),
    });
  });

  // POST /api/uploads?name=<filename> — RAW binary body (the dashboard's
  // drag-drop / pasted-screenshot attachments). The bytes land in
  // <baseDir>/uploads/<ulid>-<name> and the ABSOLUTE path comes back: the
  // composer swaps its inline [📎 name] token for that path on send, so the
  // agent reads the file from disk — the file itself never rides tmux.
  //
  // Parser interplay (why this works with the global express.json in hub.ts):
  // express.json only touches bodies whose Content-Type is application/json;
  // the dashboard sends application/octet-stream, so the stream reaches the
  // route-level express.raw untouched. If a client DOES label the body
  // application/json, the global parser consumes it first and req.body is an
  // object — the Buffer.isBuffer guard below turns that into an instructive
  // 400 instead of writing garbage.
  router.post(
    "/api/uploads",
    express.raw({ type: "*/*", limit: "25mb" }),
    (req, res) => {
      // basename() drops any path the client sent; the charset strip keeps the
      // name shell- and filesystem-safe; leading dots go too (no hidden files,
      // and ".." collapses to "" → 400). ulid() makes the final name unique.
      const rawName = typeof req.query.name === "string" ? req.query.name : "";
      const name = path
        .basename(rawName)
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^[._]+/, "")
        .slice(0, 120);
      if (name === "") {
        res.status(400).json({
          ok: false,
          error: `Missing or invalid "name": pass the filename as ?name=<file.ext>.`,
        });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({
          ok: false,
          error:
            `Empty or non-binary upload: send the file's raw bytes as the request ` +
            `body with Content-Type application/octet-stream.`,
        });
        return;
      }
      try {
        fs.mkdirSync(uploadsDir, { recursive: true });
        sweepExpiredUploads(uploadsDir);
        const filePath = path.join(uploadsDir, `${ulid()}-${name}`);
        fs.writeFileSync(filePath, req.body);
        const expiresAt = Date.now() + UPLOAD_TTL_MS;
        const expiry = setTimeout(() => {
          try { fs.rmSync(filePath, { force: true }); } catch { /* best effort scratch cleanup */ }
        }, UPLOAD_TTL_MS);
        expiry.unref();
        log.info(`[api] upload stored: ${filePath} (${req.body.length} bytes).`);
        res.status(201).json({ ok: true, path: filePath, name, expiresAt: new Date(expiresAt).toISOString() });
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: `Could not store the upload: ${(err as Error).message}.`,
        });
      }
    },
  );

  // POST /api/stt — the dictation mic's transcription. Raw audio bytes in the
  // body (audio/webm from MediaRecorder; the hub relays whatever MIME the
  // recorder produced), text back. Proxied through Groq Whisper (stt.ts) —
  // Chrome's own Web Speech API needed Google's speech endpoint, which this
  // network blocks. Same parser interplay as /api/uploads above.
  router.post(
    "/api/stt",
    express.raw({ type: "*/*", limit: MAX_STT_BYTES }),
    async (req, res) => {
      if (!stt || !stt.available()) {
        res.status(501).json({
          ok: false,
          error:
            "Dictation engine not installed. Local (recommended, no cloud): download the " +
            "speech model into ~/.switchboard/speech — see src/server/sttlocal.ts. " +
            "Cloud fallback: set GROQ_API_KEY in the hub environment. No restart needed.",
        });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({
          ok: false,
          error: "Empty or non-binary audio: send the recording's raw bytes as the request body.",
        });
        return;
      }
      try {
        const text = await stt.transcribe(req.body, req.headers["content-type"] ?? "audio/webm");
        log.info(`[stt] transcribed ${req.body.length} bytes -> ${text.length} chars.`);
        res.json({ ok: true, text });
      } catch (err) {
        const status = err instanceof SttError ? err.status : 502;
        res.status(status).json({ ok: false, error: (err as Error).message });
      }
    },
  );

  // POST /api/agents/:name/mute — body {muted: boolean}. Messages keep being
  // recorded; only nudges stop (Phase 3 dispatcher reads the flag).
  router.post("/api/agents/:name/mute", (req, res) => {
    const name = req.params.name;
    if (!store.getAgent(name)) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${name}".` });
      return;
    }
    const muted = ((req.body ?? {}) as Record<string, unknown>).muted;
    if (typeof muted !== "boolean") {
      res
        .status(400)
        .json({ ok: false, error: `Invalid body: expected {"muted": true|false}.` });
      return;
    }
    const agent = store.updateAgent(name, { muted });
    bus.emit({ type: "agent_updated", payload: toPublicAgent(agent) });
    log.info(`[api] agent ${name} ${muted ? "muted" : "unmuted"} (mute=${muted}).`);
    res.json({ ok: true, agent: toPublicAgent(agent) });
  });

  // POST /api/agents/:name/display — body {displayName: string}. Sets the
  // free-form name the UI shows (emoji welcome); empty string clears it back
  // to the kebab id. Unlike rename this works on a RUNNING agent: nothing in
  // the protocol reads it — `name` stays the address, the session env, the
  // tmux session — so there is nothing for a live agent to un-do.
  router.post("/api/agents/:name/display", (req, res) => {
    const agent = store.getAgent(String(req.params.name));
    if (!agent) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${req.params.name}".` });
      return;
    }
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (typeof raw.displayName !== "string") {
      res.status(400).json({
        ok: false,
        error: `Invalid body: expected {"displayName": "<text>"} (empty clears it).`,
      });
      return;
    }
    // "" is the CLEARED state (updateAgent skips undefined patch values, so an
    // empty string is how "back to the kebab id" persists; the UI treats any
    // falsy displayName as absent).
    const displayName = raw.displayName.trim().slice(0, 48);
    const updated = store.updateAgent(agent.name, { displayName });
    bus.emit({ type: "agent_updated", payload: toPublicAgent(updated) });
    res.json({ ok: true, agent: toPublicAgent(updated) });
  });

  // POST /api/agents/:name/stop — kills the agent's tmux session (the same
  // thing `switchboard stop <name>` does, exposed to the dashboard so "delete
  // this agent" is one click, not a trip to the CLI). The registration is NOT
  // removed here — that stays DELETE's job — but the record flips offline at
  // once so a follow-up DELETE doesn't race the 10s status poll.
  router.post("/api/agents/:name/stop", async (req, res) => {
    const agent = store.getAgent(String(req.params.name));
    if (!agent) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${req.params.name}".` });
      return;
    }
    if (!stopper) {
      res.status(501).json({
        ok: false,
        error: "Stop unavailable: this hub was started without tmux (custom onMessage).",
      });
      return;
    }
    try {
      await stopper(agent.tmuxSession);
    } catch {
      // Already dead ("no such session") — the goal is convergence, not the kill.
    }
    const updated = store.updateAgent(agent.name, {
      status: "offline",
      mcpConnected: false,
      activity: "idle",
      goalActive: false,
      goalFor: undefined,
    });
    bus.emit({ type: "agent_updated", payload: toPublicAgent(updated) });
    log.info(`[api] agent stopped from the dashboard: ${agent.name} (tmux ${agent.tmuxSession}).`);
    res.json({ ok: true, stopped: agent.name });
  });

  // DELETE /api/agents/:name — removes the agent's REGISTRATION (post-v1,
  // dashboard "Remove" button for history management). Refused while the
  // agent looks online (status is the poller's cache): a live tmux session
  // must be stopped first, otherwise the registry and reality diverge and a
  // later same-name registration would collide with the running session.
  // Messages stay in the append-only JSONL (source of truth).
  router.delete("/api/agents/:name", (req, res) => {
    const name = req.params.name;
    const agent = store.getAgent(name);
    if (!agent) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${name}".` });
      return;
    }
    if (agent.status === "online") {
      res.status(409).json({
        ok: false,
        error:
          `The agent "${name}" looks online (tmux session "${agent.tmuxSession}"). ` +
          `Stop it first — "switchboard stop ${name}" — and then remove it.`,
      });
      return;
    }
    store.removeAgent(name);
    bus.emit({ type: "agent_removed", payload: { name } });
    log.info(`[api] agent registration removed: ${name}.`);
    res.json({ ok: true, removed: name });
  });

  // POST /api/agents/:name/group — body {group: "<group>"}. Moves an agent to
  // another group, i.e. changes who it is allowed to talk to.
  //
  // Works on a RUNNING agent, unlike rename, and the difference is not an
  // oversight. Rename must stop the agent because a live one holds
  // SWITCHBOARD_AGENT_NAME in its session env and would re-join under the old
  // name, undoing the change. Nothing does that to a group: the MCP session maps
  // to the agent's NAME, join never touches the group of an agent that already
  // exists, and every send re-reads the record — so the move takes effect on the
  // agent's next message with no restart at all.
  //
  // The agent is not told. Its join response listed the peers it had then, so
  // after a move it may still try an old one and get the ordinary
  // "Unknown recipient … You can message: …" back, which is the self-correcting
  // path that already exists. Nudging every moved agent would cost it a full
  // turn to learn something its next send teaches for free.
  router.post("/api/agents/:name/group", (req, res) => {
    const name = req.params.name;
    if (!store.getAgent(name)) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${name}".` });
      return;
    }
    const group = ((req.body ?? {}) as Record<string, unknown>).group;
    if (typeof group !== "string" || !GROUP_NAME_RE.test(group)) {
      res.status(400).json({
        ok: false,
        error:
          `Invalid body: expected {"group": "<group>"} — lowercase letters, digits and ` +
          `hyphens (2 to 31 characters, starting with a letter or digit).`,
      });
      return;
    }

    const updated = store.updateAgent(name, { group });
    bus.emit({ type: "agent_updated", payload: toPublicAgent(updated) });
    log.info(`[api] agent ${name} moved to group ${group}.`);
    res.json({ ok: true, agent: toPublicAgent(updated) });
  });

  // GET /api/agents/:name/files/resolve?file=<basename>&hint=downloads — turns
  // a bare filename from conversation prose into one real, scoped path. The
  // dashboard only makes the text interactive after this endpoint confirms it,
  // so domain names and ordinary dotted words never become dead links.
  router.get("/api/agents/:name/files/resolve", (req, res) => {
    const agent = store.getAgent(String(req.params.name));
    if (!agent) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${req.params.name}".` });
      return;
    }
    const filename = typeof req.query.file === "string" ? req.query.file.trim() : "";
    if (
      filename === "" ||
      filename !== path.basename(filename) ||
      filename === "." ||
      filename === ".." ||
      !/^[A-Za-z_][\w+@. -]*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(filename)
    ) {
      res.status(400).json({ ok: false, error: "Expected one bare filename with an extension." });
      return;
    }
    const found = findMentionedFile(filename, agent.cwd || "", req.query.hint === "downloads");
    if (!found) {
      res.status(404).json({ ok: false, error: `File not found for ${agent.name}: ${filename}` });
      return;
    }
    res.json({ ok: true, path: found });
  });

  // GET /api/agents/:name/files?q=<query>&limit=50 — file autocomplete for the
  // dashboard composer's "@" file mentions. Answers files AND directories under
  // the AGENT's cwd whose RELATIVE path contains the query (case-insensitive);
  // directories carry a trailing "/". Breadth-first walk: each depth level is
  // sorted alphabetically and appended before descending, so the response is
  // ordered shallower-first then alphabetical WITHOUT a global sort, and the
  // limit fills with the shallow paths first. Symlinks are listed but never
  // descended into (no cycles). Localhost trust model: this exposes strictly
  // less than /api/files/preview, which already reads file CONTENTS.
  router.get("/api/agents/:name/files", (req, res) => {
    const agent = store.getAgent(String(req.params.name));
    if (!agent) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${req.params.name}".` });
      return;
    }
    if (!agent.cwd || agent.cwd.trim() === "") {
      res.status(409).json({
        ok: false,
        error: `No working directory recorded for "${agent.name}", so its files cannot be listed.`,
      });
      return;
    }
    const q = (typeof req.query.q === "string" ? req.query.q : "").toLowerCase();
    let limit = 50;
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        res.status(400).json({
          ok: false,
          error: `Invalid "limit" parameter: ${String(req.query.limit)} (expected a positive integer).`,
        });
        return;
      }
    }
    limit = Math.min(limit, AGENT_FILES_CAP);

    const files: { path: string; dir: boolean }[] = [];
    let scanned = 0;
    // Relative dir paths of ONE depth level at a time ("" = the cwd itself).
    let level: string[] = [""];
    for (
      let depth = 0;
      depth < AGENT_FILES_MAX_DEPTH &&
      level.length > 0 &&
      files.length < limit &&
      scanned < AGENT_FILES_SCAN_CAP;
      depth++
    ) {
      const next: string[] = [];
      const matches: { path: string; dir: boolean }[] = [];
      for (const relDir of level) {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(path.join(agent.cwd, relDir), { withFileTypes: true });
        } catch {
          continue; // unreadable/vanished dir — skip it, never error
        }
        for (const entry of entries) {
          if (++scanned > AGENT_FILES_SCAN_CAP) break;
          // isDirectory() is false for symlinks, so a symlinked dir is listed
          // as a plain entry and never descended into — the walk cannot cycle.
          const isDir = entry.isDirectory();
          if (isDir && AGENT_FILES_SKIP.has(entry.name)) continue;
          if (!isDir && !entry.isFile() && !entry.isSymbolicLink()) continue; // sockets, FIFOs
          const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
          if (isDir) next.push(rel);
          if (q === "" || rel.toLowerCase().includes(q)) {
            matches.push({ path: isDir ? rel + "/" : rel, dir: isDir });
          }
        }
      }
      matches.sort((a, b) => {
        const la = a.path.toLowerCase();
        const lb = b.path.toLowerCase();
        if (la !== lb) return la < lb ? -1 : 1;
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });
      for (const m of matches) {
        if (files.length >= limit) break;
        files.push(m);
      }
      level = next;
    }
    res.json({ ok: true, files });
  });

  // GET /api/agents/:name/conversation — SSE. The agent's conversation as a
  // clean chat (the "casca"): Claude Code logs every message/tool to JSONL under
  // ~/.claude/projects, and this reads it — no ownership of the agent's process,
  // so the connector stays a connector (a wrapper would spawn the agent to get
  // structured output). First event is the full parsed conversation; then the
  // file is watched and only NEW lines are parsed and pushed.
  router.get("/api/agents/:name/conversation", (req, res) => {
    const agent = store.getAgent(String(req.params.name));
    if (!agent) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${req.params.name}".` });
      return;
    }
    if (!agent.cwd || agent.cwd.trim() === "") {
      res.status(409).json({
        ok: false,
        error: `No working directory recorded for "${agent.name}", so its conversation log cannot be found.`,
      });
      return;
    }

    // Which CLI wrote this agent's log decides both WHERE it lives and HOW it
    // parses: claude keys a per-project dir off the encoded cwd; codex keeps a
    // date tree of rollouts located by scanning for session_meta.cwd.
    const isCodex = resolveAgentType(agent.agentType) === "codex";
    const parser = isCodex ? parseCodexRollout : parseConversation;
    let file: string;
    if (isCodex) {
      const rollout = findCodexRolloutForCwd(agent.cwd);
      if (!rollout) {
        res.status(404).json({
          ok: false,
          error:
            `No codex conversation for "${agent.name}" yet (no rollout in ` +
            `~/.codex/sessions matches ${agent.cwd}). It appears after its first turn.`,
        });
        return;
      }
      file = rollout;
    } else {
      const dir = projectDirForCwd(agent.cwd);
      // The active session = the most-recently-modified .jsonl in the project dir.
      try {
        const jsonls = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => path.join(dir, f))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (jsonls.length === 0) throw new Error("no conversation log yet");
        file = jsonls[0];
      } catch {
        res.status(404).json({
          ok: false,
          error:
            `No conversation log for "${agent.name}" yet (looked in ${dir}). ` +
            `It appears once the agent has talked at least once.`,
        });
        return;
      }
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let offset = 0;
    let carry = ""; // a trailing partial line held for the next read
    let sending = false;

    // Reads from `offset` to EOF, parses only COMPLETE lines, forwards the new
    // chat items, and keeps any partial last line for next time. Serialized so
    // two watch events cannot interleave reads of the same bytes.
    const pump = (initial: boolean): void => {
      if (sending) return;
      sending = true;
      try {
        const size = fs.statSync(file).size;
        if (size < offset) offset = 0; // file rotated/truncated: restart
        if (size > offset) {
          const buf = Buffer.alloc(size - offset);
          const fd = fs.openSync(file, "r");
          try {
            fs.readSync(fd, buf, 0, buf.length, offset);
          } finally {
            fs.closeSync(fd);
          }
          offset = size;
          const text = carry + buf.toString("utf8");
          const nl = text.lastIndexOf("\n");
          const complete = nl === -1 ? "" : text.slice(0, nl);
          carry = nl === -1 ? text : text.slice(nl + 1);
          const parsed = parser(complete.split("\n"));
          // The initial dump is capped to the most recent turns: a long project
          // has thousands, and sending them all made the page render ~40k DOM
          // nodes and choke. Live appends are never capped (they are new).
          const INITIAL_LIMIT = 200;
          const items = initial && parsed.length > INITIAL_LIMIT ? parsed.slice(-INITIAL_LIMIT) : parsed;
          if (items.length > 0 || initial) {
            res.write(`data: ${JSON.stringify({ items, initial })}\n\n`);
          }
        } else if (initial) {
          res.write(`data: ${JSON.stringify({ items: [], initial: true })}\n\n`);
        }
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
      } finally {
        sending = false;
      }
    };

    pump(true);
    // fs.watch is edge-triggered and can miss rapid appends, so a slow poll
    // backs it up — the pump is idempotent (offset-based), so double-firing is
    // harmless.
    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = fs.watch(file, () => pump(false));
    } catch {
      /* watch unsupported here; the poll below still delivers */
    }
    const poll = setInterval(() => pump(false), 1500);
    poll.unref?.();

    req.on("close", () => {
      clearInterval(poll);
      watcher?.close();
    });
  });

  // -------------------------------------------------------------------------
  // The agent's screen (terminal.ts). Three routes: the stream, the keys, the
  // size. tmux is the pty, so there is no second one to manage here.
  // -------------------------------------------------------------------------

  /** Resolves :name → its REGISTERED tmux session (never a recomputed prefix). */
  function terminalTarget(
    name: string,
    res: express.Response,
  ): { session: string } | null {
    if (!terminals) {
      res.status(501).json({
        ok: false,
        error: "This hub runs without tmux, so it has no agent screens to show.",
      });
      return null;
    }
    const agent = store.getAgent(name);
    if (!agent) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${name}".` });
      return null;
    }
    return { session: agent.tmuxSession };
  }

  // GET /api/agents/:name/terminal — SSE. First frame is the screen as it
  // stands (the tee only carries what happens next), then every byte the pane
  // emits. Bytes are base64: SSE is line-based UTF-8 text and a terminal stream
  // is neither.
  router.get("/api/agents/:name/terminal", async (req, res) => {
    const target = terminalTarget(String(req.params.name), res);
    if (!target) return;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // The bridge drives everything: grid first (the panel sizes itself to the
    // pane, never the reverse), then a full synthesized frame, then deltas —
    // race-free by the control stream's ordering (see terminal.ts).
    let detach: (() => void) | undefined;
    let ended = false;
    try {
      detach = await terminals!.attachViewer(target.session, {
        onGrid: (grid) => res.write(`data: ${JSON.stringify(grid)}\n\n`),
        onBytes: (bytes) =>
          res.write(`data: ${JSON.stringify({ b64: bytes.toString("base64") })}\n\n`),
        onEnd: (reason) => {
          if (ended) return;
          ended = true;
          res.write(`data: ${JSON.stringify({ error: reason })}\n\n`);
          res.end();
        },
      });
    } catch (err) {
      log.warn(
        `[api] terminal stream failed for ${String(req.params.name)}: ${(err as Error).message}`,
      );
      res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
      res.end();
      return;
    }

    req.on("close", () => {
      detach?.();
    });
  });

  // POST /api/agents/:name/terminal/input — body {b64: "<base64 bytes>"}.
  // Base64 and not text: Escape and Ctrl-C have to arrive as the bytes 1b and
  // 03, not as the words. The pane guard runs inside terminals.input().
  router.post("/api/agents/:name/terminal/input", async (req, res) => {
    const target = terminalTarget(String(req.params.name), res);
    if (!target) return;
    const b64 = ((req.body ?? {}) as Record<string, unknown>).b64;
    if (typeof b64 !== "string") {
      res.status(400).json({ ok: false, error: `Invalid body: expected {"b64": "<base64>"}.` });
      return;
    }
    try {
      await terminals!.input(target.session, Buffer.from(b64, "base64"));
      res.json({ ok: true });
    } catch (err) {
      const status = err instanceof TerminalError ? err.status : 500;
      res.status(status).json({ ok: false, error: (err as Error).message });
    }
  });

  // POST /api/agents/:name/terminal/resize — body {cols, rows}.
  router.post("/api/agents/:name/terminal/resize", async (req, res) => {
    const target = terminalTarget(String(req.params.name), res);
    if (!target) return;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    try {
      await terminals!.resize(target.session, Number(raw.cols), Number(raw.rows));
      res.json({ ok: true });
    } catch (err) {
      const status = err instanceof TerminalError ? err.status : 500;
      res.status(status).json({ ok: false, error: (err as Error).message });
    }
  });

  // POST /api/groups/:group/rename — body {name: "<newName>"}. Renames a group
  // for every agent in it (Store.renameGroup moves them in one write, so the
  // room can never end up split across two names).
  //
  // Merging is deliberate rather than blocked: renaming "site" to an existing
  // "panorama" puts both sets of agents in one room, which is the obvious
  // reading of the action and the only way to join two groups you already have.
  router.post("/api/groups/:group/rename", (req, res) => {
    const group = req.params.group;
    const next = ((req.body ?? {}) as Record<string, unknown>).name;
    if (typeof next !== "string" || next.length === 0) {
      res.status(400).json({
        ok: false,
        error: `Invalid body: expected {"name": "<new group name>"} with a non-empty name.`,
      });
      return;
    }

    let members;
    try {
      members = store.renameGroup(group, next);
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("Unknown group") ? 404 : 400).json({ ok: false, error: message });
      return;
    }
    for (const agent of members) {
      bus.emit({ type: "agent_updated", payload: toPublicAgent(agent) });
    }
    log.info(`[api] group ${group} renamed to ${next} (${members.length} agent(s)).`);
    res.json({ ok: true, group: next, agents: members.map(toPublicAgent) });
  });

  // POST /api/agents/:name/rename — body {name: "<newName>"}. Post-v1
  // sibling of DELETE above (dashboard ⋯ menu / `switchboard rename`).
  //
  // Refused while the agent looks online, for a reason stronger than DELETE's:
  // a live Claude Code holds SWITCHBOARD_AGENT_NAME in its session env and
  // would re-join under the OLD name, resurrecting it as a second agent. The
  // history follows the agent — the store appends a rename event instead of
  // rewriting the append-only JSONL (see Store.renameAgent).
  router.post("/api/agents/:name/rename", (req, res) => {
    const name = req.params.name;
    const agent = store.getAgent(name);
    if (!agent) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${name}".` });
      return;
    }
    if (agent.status === "online") {
      res.status(409).json({
        ok: false,
        error:
          `The agent "${name}" looks online (tmux session "${agent.tmuxSession}"). ` +
          `Stop it first — "switchboard stop ${name}" — and then rename it.`,
      });
      return;
    }
    const newName = ((req.body ?? {}) as Record<string, unknown>).name;
    if (typeof newName !== "string" || newName.length === 0) {
      res.status(400).json({
        ok: false,
        error: `Invalid body: expected {"name": "<new agent name>"} with a non-empty name.`,
      });
      return;
    }

    let renamed: Agent;
    try {
      renamed = store.renameAgent(name, newName);
    } catch (err) {
      // Invalid/reserved/taken name — store errors are already in English and
      // actionable, so they surface verbatim (the CLI reprints them as-is).
      res.status(400).json({ ok: false, error: (err as Error).message });
      return;
    }

    // Reuses the existing event types: the dashboard's agent_removed handler
    // drops the old card and its agent_updated handler adds the new one — no
    // new client plumbing, and any listener that only knows these two events
    // still converges on the right state.
    if (renamed.name !== name) {
      bus.emit({ type: "agent_removed", payload: { name } });
      log.info(`[api] agent renamed: ${name} → ${renamed.name}.`); // never the token
    }
    bus.emit({ type: "agent_updated", payload: toPublicAgent(renamed) });
    res.json({ ok: true, agent: toPublicAgent(renamed) });
  });

  // POST /api/agents/:name/nudge — manual nudge button (PRD 10.1: "force a
  // manual nudge"). "Force" = bypasses cooldown AND mute (politeness controls
  // the human operator may override), but NEVER the pane-command guard —
  // security invariant (PRD 10.3 / 15 / P2), enforced inside the dispatcher.
  router.post("/api/agents/:name/nudge", async (req, res) => {
    const name = req.params.name;
    if (!store.getAgent(name)) {
      res.status(404).json({ ok: false, error: `Unknown agent: "${name}".` });
      return;
    }
    if (!nudger) {
      // Hub started with a custom onMessage override (no dispatcher — tests).
      res.status(501).json({
        ok: false,
        error:
          "Manual nudge unavailable: this hub was started without the nudge dispatcher " +
          "(custom onMessage).",
      });
      return;
    }
    const result = await nudger.forceNudge(name);
    if (result.sent) {
      log.info(`[api] manual nudge delivered to ${name}.`);
      res.json({ ok: true, nudged: true });
      return;
    }
    // Not an unknown route nor bad input: the nudge was attempted and aborted
    // (pane guard / dead session) → 409 with the reason.
    res.status(409).json({
      ok: false,
      error: `Manual nudge not delivered: ${result.reason ?? "unknown failure"}. ` +
        `The message stays recorded and will be delivered via check_messages.`,
    });
  });

  // GET /api/events — SSE stream of {type, payload} + a heartbeat every ~25s.
  //
  // The heartbeat is a real EVENT, not the usual `: comment`. A comment keeps
  // proxies and idle sockets from timing out, but EventSource parsers drop it,
  // so the browser can never see it — and a stream that died silently then looks
  // exactly like a network where nobody is talking. That case is not exotic
  // here: the dashboard runs in a Windows browser and the hub in WSL2, so every
  // connection crosses WSL2's localhost proxy, which can drop the tunnel without
  // either end raising an error (laptop sleep does the same). The dashboard
  // watchdogs these to tell "quiet" from "dead". The comment goes out too, for
  // the proxies that only need bytes.
  router.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`: connected ${new Date().toISOString()}\n\n`);

    const unsubscribe = bus.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
      res.write(`data: ${JSON.stringify({ type: "heartbeat", payload: { at: new Date().toISOString() } })}\n\n`);
    }, heartbeatMs);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // GET /api/health → {ok, uptime, version}. uptime in seconds.
  router.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      version,
    });
  });

  // Claude plan windows come from its OAuth endpoint; Codex plan windows come
  // from the newest local token_count event. Both are cached here because the
  // underlying sources are append-only logs / a rate-limited network probe.
  let codexCache: { at: number; usage: CodexUsageSnapshot } | null = null;
  const codexUsage = (): CodexUsageSnapshot | null => {
    const hasCodex = store.listAgents().some((a) => resolveAgentType(a.agentType) === "codex");
    if (!hasCodex) return null;
    if (!codexCache || Date.now() - codexCache.at > 30_000) {
      codexCache = { at: Date.now(), usage: codexUsageSnapshot(new Date()) };
    }
    return codexCache.usage;
  };

  router.get("/api/usage", async (_req, res) => {
    const claude = usage ? await usage.getSnapshot() : {
      limits: [], updatedAt: null, stale: true, status: "unavailable" as const, retryAt: null,
    };
    res.json({
      // Keep `limits` for old dashboards; new ones also consume freshness.
      limits: claude.limits,
      claude,
      codex: codexUsage(),
    });
  });

  // Fallback for unknown /api routes: JSON 404, never the Express HTML page.
  router.use("/api", (req, res) => {
    res.status(404).json({
      ok: false,
      error: `Unknown route: ${req.method} ${req.originalUrl}.`,
    });
  });

  return router;
}
