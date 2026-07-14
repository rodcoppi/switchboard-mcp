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
import type { Store } from "./store.js";
// Value imports for the instanceof mapping and the /api/fs/dirs path
// translation below. No runtime cycle: launcher.ts imports this module with
// `import type` only (erased at compile time).
import { LaunchError, normalizeIncomingPath, type Launcher } from "./launcher.js";
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
 * Validates the recipient. Returns a {code, error} object, or null when valid.
 * "all" requires at least one registered agent other than the sender.
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
  if (to === "all") {
    const others = store.listAgents().filter((a) => a.name !== from);
    if (others.length === 0) {
      return {
        code: "invalid",
        error:
          `Broadcast has no recipients: no other agent is registered on the network. ` +
          `Use the list_agents tool to see who is available before sending.`,
      };
    }
    return null;
  }
  if (!store.getAgent(to)) {
    const names = store.listAgents().map((a) => a.name);
    return {
      code: "unknown_recipient",
      error:
        `Unknown recipient: "${to}". Registered agents: ` +
        `${names.length > 0 ? names.join(", ") : "(none)"}. ` +
        `Use the list_agents tool to find who is on the network, or "all" for broadcast.`,
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
  input: { from: string; to: string; body: string },
): DeliverResult {
  const broadcastId = input.to === "all" ? ulid() : null;
  const recipients: Agent[] =
    input.to === "all"
      ? store.listAgents().filter((a) => a.name !== input.from)
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
   * Claude Code projects directory used by GET /api/fs/dirs for the
   * best-effort "conversation" badge (default ~/.claude/projects).
   * Injectable so tests never read the operator's real conversation index.
   */
  claudeProjectsDir?: string;
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
  const { store, config, log, bus, onMessage, nudger, launcher, startedAt, version } =
    options;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const claudeProjectsDir =
    options.claudeProjectsDir ?? path.join(os.homedir(), ".claude", "projects");
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

    // No pair rate limit here: section 14 is the anti-loop layer BETWEEN
    // AGENTS; "operator" is the human, who has the dashboard mute/visibility
    // as their own control plane.
    const result = deliverMessage(store, bus, onMessage, { from: "operator", to, body });
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

    try {
      const result = await launcher.launchAgent({
        dir: raw.dir,
        name: raw.name as string | undefined,
        role: raw.role as string | undefined,
        continueConversation: (raw.continue as boolean | undefined) ?? false,
        openTerminal: (raw.openTerminal as boolean | undefined) ?? false,
        agentType: raw.agentType as AgentType | undefined,
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

  // GET /api/fs/dirs?path=<abs> — the dashboard's folder browser (backs the
  // "Browse…" panel of the Launch agent form). Answers the SUBDIRECTORY NAMES
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

  // GET /api/events — SSE stream of {type, payload} + heartbeat comment
  // every ~25s (keeps proxies/idle sockets alive; comments are ignored by
  // EventSource parsers).
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

  // Fallback for unknown /api routes: JSON 404, never the Express HTML page.
  router.use("/api", (req, res) => {
    res.status(404).json({
      ok: false,
      error: `Unknown route: ${req.method} ${req.originalUrl}.`,
    });
  });

  return router;
}
