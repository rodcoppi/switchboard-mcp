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
// Value import for the instanceof mapping below. No runtime cycle: launcher.ts
// imports this module with `import type` only (erased at compile time).
import { LaunchError, type Launcher } from "./launcher.js";

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
  /** Hub start timestamp (epoch ms) for /api/health uptime. */
  startedAt: number;
  /** Hub version string for /api/health (from package.json). */
  version: string;
  /** SSE heartbeat comment interval (default ~25s; injectable for tests). */
  heartbeatMs?: number;
}

export function createApiRouter(options: ApiOptions): express.Router {
  const { store, config, log, bus, onMessage, nudger, launcher, startedAt, version } =
    options;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
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

    try {
      const agent = store.registerAgent({
        // role stays undefined when the field is absent: the store then
        // PRESERVES the registered role on re-attach (PRD 8) instead of
        // silently erasing it with "".
        name: raw.name,
        role: raw.role as string | undefined,
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
          `"continue"?} with "dir" required.`,
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
    if (raw.continue !== undefined && typeof raw.continue !== "boolean") {
      res.status(400).json({
        ok: false,
        error: `Invalid body: field "continue" must be a boolean when present.`,
      });
      return;
    }

    try {
      const result = await launcher.launchAgent({
        dir: raw.dir,
        name: raw.name as string | undefined,
        role: raw.role as string | undefined,
        continueConversation: (raw.continue as boolean | undefined) ?? false,
      });
      log.info(
        `[api] launch: agent ${result.agent.name} launched from the dashboard ` +
          `(replaced=${result.replaced}, fallback=${result.fallback}).`,
      );
      res.status(201).json({
        ok: true,
        agent: result.agent,
        replaced: result.replaced,
        fallback: result.fallback,
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
