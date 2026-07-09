// Nudge dispatcher (PRD section 10.2 — the pseudocode there IS the spec).
// Responsibility: turn "new message for X" into "X was nudged", respecting
// cooldown and security.
//
// Timing contract (PRD section 4, rule 4 — never block the agent's turn):
// the DECISION in onNewMessage is fully synchronous (pure in-memory state)
// and returns the Delivery immediately so the MCP tool answers < 1s; the
// actual tmux nudge runs asynchronously (fire-and-forget, errors logged).
// Consequence: "tmuxAlive(agent)" from the pseudocode maps to the CACHED
// agent.status maintained by the status polling below (10.4) — freshness is
// enforced on the async path by the pane guard, which fail-closes and marks
// the agent offline when the session died between polls.
//
// Cooldown/coalescing (override rule 3: delivery reliability > realtime):
// lastNudgeAt is stamped SYNCHRONOUSLY when a nudge is decided, so a burst
// of messages in the same tick coalesces into ONE nudge + pending entries;
// check_messages then drains everything at once. A nudge that FAILS (guard
// abort / tmux error — nothing was typed) reverts the stamp, so a real
// message is never held hostage to the cooldown of a nudge that never
// happened; the agent is also quarantined (nudgeBlocked) until its pane
// passes the guard again, which kills the online↔offline polling flap.
//
// The nudge text NEVER contains the message body (PRD 10.2): the fragile
// channel (simulated keyboard) carries one short line; the content always
// travels via MCP.

import {
  toPublicAgent,
  type Agent,
  type AgentStatus,
  type Config,
  type Delivery,
  type Message,
  type OnMessage,
} from "../shared/types.js";
import type { Logger } from "./log.js";
import type { Store } from "./store.js";
import type { EventBus } from "./api.js";
import type { NudgeResult } from "./tmux.js";

/** Flush cadence for coalesced (pending) nudges — PRD 10.2: "timer a cada 5s". */
export const FLUSH_INTERVAL_MS = 5000;

/** The narrow tmux surface the dispatcher needs (injectable for unit tests). */
export interface DispatcherTmux {
  hasSession(session: string): Promise<boolean>;
  nudgeSession(session: string, text: string, enterDelayMs: number): Promise<NudgeResult>;
  /** Pane guard probe (fail-closed) — used to break the online↔offline flap. */
  isPaneSafeToNudge(session: string): Promise<boolean>;
}

export interface DispatcherOptions {
  store: Store;
  config: Config;
  log: Logger;
  bus: EventBus;
  tmux: DispatcherTmux;
  /** Injectable clock (epoch ms) for deterministic tests. Default Date.now. */
  now?: () => number;
  /** Flush cadence override for tests (default FLUSH_INTERVAL_MS = 5s). */
  flushIntervalMs?: number;
}

/** Outcome of a manual (forced) nudge — consumed by POST /api/agents/:name/nudge. */
export interface ManualNudgeResult {
  sent: boolean;
  reason?: string;
}

export class Dispatcher {
  private readonly store: Store;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly bus: EventBus;
  private readonly tmux: DispatcherTmux;
  private readonly now: () => number;
  private readonly flushIntervalMs: number;

  /** Agents waiting for a nudge once their cooldown expires (coalescing). */
  private readonly pendingNudge = new Set<string>();
  /**
   * Agents whose LAST nudge attempt failed (pane guard abort or tmux error).
   * Breaks the perpetual online↔offline flap for "session alive but pane on a
   * shell with unread > 0": pollOnce only promotes a quarantined agent back
   * to online after the pane guard passes again, instead of re-marking it
   * online (and re-attempting a doomed nudge) every poll cycle forever.
   * Cleared on the next SUCCESSFUL nudge or when the pane becomes safe.
   */
  private readonly nudgeBlocked = new Set<string>();
  private flushTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  /** Guards against overlapping polls when tmux calls outlast the interval. */
  private pollInFlight = false;

  constructor(options: DispatcherOptions) {
    this.store = options.store;
    this.config = options.config;
    this.log = options.log;
    this.bus = options.bus;
    this.tmux = options.tmux;
    this.now = options.now ?? Date.now;
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  }

  /**
   * The OnMessage extension point wired into hub.ts (bound so it can be
   * passed around as a plain function). PRD 10.2 pseudocode, faithfully:
   *   muted            → queued_muted
   *   tmux dead        → offline + queued_offline
   *   cooldown active  → pendingNudge.add (coalescing) + coalesced
   *   otherwise        → sendNudge (async) + nudged
   */
  readonly onNewMessage: OnMessage = (message: Message, recipient: Agent): Delivery => {
    // Re-read from the store: `recipient` is a live ref, but going through
    // getAgent keeps this correct even if callers pass a stale copy.
    const agent = this.store.getAgent(recipient.name) ?? recipient;

    if (agent.muted) {
      return "queued_muted";
    }
    // "if !tmuxAlive(agent) → marca offline": status IS the cached tmux
    // liveness (polling owns it), so a non-online agent is already marked —
    // the message queues and the polling online-transition delivers later.
    if (agent.status !== "online") {
      return "queued_offline";
    }
    if (this.inCooldown(agent)) {
      this.pendingNudge.add(agent.name); // coalescing
      return "coalesced";
    }
    // The immediate nudge covers ALL unread (count + senders come from the
    // store), so it discharges any coalescing debt — without this delete, a
    // stale pending entry would make the next flush fire a duplicate nudge.
    this.pendingNudge.delete(agent.name);
    this.fireNudge(agent);
    return "nudged";
  };

  /**
   * PRD 10.2 flush timer: for each pending agent whose cooldown expired AND
   * unread > 0 → sendNudge and remove from the set. The decision loop is
   * synchronous; the nudges it fires are async (fire-and-forget).
   * Two additions beyond the pseudocode, both conservative:
   * - muted agents are SKIPPED (kept pending): mute means "nudge suppressed,
   *   message recorded" (PRD 10.1/13) and can be flipped after the message
   *   was coalesced;
   * - non-online agents are SKIPPED (kept pending): the polling
   *   online-transition path is the one that revives them.
   */
  flushPending(): void {
    for (const name of [...this.pendingNudge]) {
      const agent = this.store.getAgent(name);
      if (!agent) {
        this.pendingNudge.delete(name); // unregistered while pending
        continue;
      }
      if (agent.muted) continue;
      if (agent.status !== "online") continue;
      if (this.inCooldown(agent)) continue;
      if (this.store.unreadCount(name) === 0) {
        // Spec: only nudge with unread > 0. The debt is DISCHARGED (agent
        // read everything via check_messages) — drop the entry, otherwise it
        // leaks forever and re-fires a duplicate nudge on a later message.
        this.pendingNudge.delete(name);
        continue;
      }
      this.pendingNudge.delete(name);
      this.fireNudge(agent);
    }
  }

  /**
   * Status polling (PRD 10.4): hasSession per agent every
   * agentPollIntervalMs; updates status and emits agent_updated ONLY on
   * change. An agent that comes online with unread > 0 may be nudged,
   * respecting the cooldown (nudge now, or join the pending set).
   */
  async pollOnce(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      for (const { name, tmuxSession } of this.store.listAgents()) {
        let alive = false;
        try {
          alive = await this.tmux.hasSession(tmuxSession);
        } catch {
          alive = false; // fail-closed: unreadable tmux = not alive
        }
        const next: AgentStatus = alive ? "online" : "offline";
        // Re-read after the await: join/guard may have changed the agent.
        const agent = this.store.getAgent(name);
        if (!agent || agent.status === next) continue;

        // Flap breaker: an agent whose last nudge failed (guard abort — the
        // classic "session alive, pane on a shell" case) is NOT promoted back
        // to online until its pane passes the guard again. Otherwise every
        // poll cycle would flip it online, re-attempt the doomed nudge, abort
        // and flip it offline — unbounded SSE/log noise (PRD 10.3 vs 10.4).
        if (next === "online" && this.nudgeBlocked.has(name)) {
          let safe = false;
          try {
            safe = await this.tmux.isPaneSafeToNudge(tmuxSession);
          } catch {
            safe = false; // fail-closed
          }
          if (!safe) continue; // stays offline, no event, no nudge attempt
          this.nudgeBlocked.delete(name);
        }

        const updated = this.store.updateAgent(name, { status: next });
        this.bus.emit({ type: "agent_updated", payload: toPublicAgent(updated) });
        this.log.info(
          `[dispatcher] polling: ${name} ficou ${next} (tmux ${tmuxSession}).`,
        );

        if (next === "online" && !updated.muted && this.store.unreadCount(name) > 0) {
          if (this.inCooldown(updated)) {
            this.pendingNudge.add(name);
          } else {
            this.pendingNudge.delete(name);
            this.fireNudge(updated);
          }
        }
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * Manual nudge (dashboard button — PRD 10.1: "força um nudge manual").
   * Interpretation of "força" documented here on purpose: it BYPASSES the
   * cooldown and the mute flag (both are politeness/delivery controls that
   * the human operator may override), but NEVER the pane-command guard —
   * that one is a security invariant (PRD 10.3, section 15, pitfall P2) and
   * is not negotiable on any code path.
   */
  async forceNudge(name: string): Promise<ManualNudgeResult> {
    const agent = this.store.getAgent(name);
    if (!agent) {
      return { sent: false, reason: `agente desconhecido: "${name}"` };
    }
    return this.performNudge(agent);
  }

  /** Snapshot of the coalescing set (tests/debug). */
  get pendingAgents(): string[] {
    return [...this.pendingNudge];
  }

  /** Starts the flush (5s) and status-polling timers. Idempotent. */
  start(): void {
    if (this.flushTimer || this.pollTimer) return;
    this.flushTimer = setInterval(() => this.flushPending(), this.flushIntervalMs);
    this.flushTimer.unref(); // never hold the process open
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((err) => {
        this.log.error(`[dispatcher] erro no polling de status:`, err);
      });
    }, this.config.agentPollIntervalMs);
    this.pollTimer.unref();
    // Immediate first poll so status converges right after boot (replay may
    // have loaded agents whose sessions are still alive).
    void this.pollOnce().catch((err) => {
      this.log.error(`[dispatcher] erro no polling inicial:`, err);
    });
  }

  /** Stops both timers. Safe to call multiple times; no dangling handles. */
  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.flushTimer = undefined;
    this.pollTimer = undefined;
  }

  // ------------------------------------------------------------------ internals

  private inCooldown(agent: Agent): boolean {
    if (!agent.lastNudgeAt) return false;
    const last = Date.parse(agent.lastNudgeAt);
    if (Number.isNaN(last)) return false;
    return this.now() - last < this.config.nudgeCooldownMs;
  }

  /** Fire-and-forget wrapper: the decision paths must never await tmux. */
  private fireNudge(agent: Agent): void {
    void this.performNudge(agent).catch((err) => {
      this.log.error(`[dispatcher] erro inesperado nudgando ${agent.name}:`, err);
    });
  }

  /**
   * sendNudge from the PRD 10.2 pseudocode. The prefix up to the first await
   * runs SYNCHRONOUSLY at the call site: the nudge text is composed and
   * lastNudgeAt is stamped before control returns, so bursts arriving in the
   * same tick already see the cooldown (that is what coalesces them).
   * The text is the EXACT template from 10.2, always one line (P5), and
   * NEVER includes the message body.
   */
  private async performNudge(agent: Agent): Promise<ManualNudgeResult> {
    const unread = this.store.unreadCount(agent.name);
    const froms = this.store.unreadSenders(agent.name).join(", ");
    // unread === 0 is only reachable via forceNudge (every automatic path
    // gates on unread > 0): the count/senders template would degenerate into
    // "0 nova(s) mensagem(ns) de: ." — use a purpose-built manual-poke line.
    const text = (
      unread === 0
        ? `[switchboard] Cutucada manual do operator. Use a tool check_messages para verificar sua fila.`
        : `[switchboard] ${unread} nova(s) mensagem(ns) de: ${froms}. ` +
          `Use a tool check_messages para ler.`
    ).replace(/[\r\n]+/g, " "); // nudge é SEMPRE uma linha (P5)
    const at = new Date(this.now()).toISOString();
    // Stamp SYNCHRONOUSLY (same-tick bursts must already see the cooldown —
    // that is what coalesces them), but remember the previous value: a nudge
    // that ends up typing NOTHING must not impose a 15s cooldown on the
    // recovery path (PRD 10.2 stamps only after a successful send).
    const prevNudgeAt = agent.lastNudgeAt;
    this.store.updateAgent(agent.name, { lastNudgeAt: at });

    let result: NudgeResult;
    try {
      result = await this.tmux.nudgeSession(
        agent.tmuxSession,
        text,
        this.config.nudgeEnterDelayMs,
      );
    } catch (err) {
      result = { sent: false, reason: `erro executando tmux: ${String(err)}` };
    }

    if (result.sent) {
      this.nudgeBlocked.delete(agent.name);
      this.bus.emit({ type: "nudge_sent", payload: { agent: agent.name, at, unread } });
      this.log.info(
        `[dispatcher] nudge enviado para ${agent.name} (${unread} não lida(s) de: ${froms}).`,
      );
      return { sent: true };
    }

    // Guard abort or tmux failure: the nudge did NOT complete. PRD 10.3:
    // mark the agent offline, quarantine it (see nudgeBlocked) and log at
    // warn level. Revert the optimistic cooldown stamp (only if no other
    // nudge re-stamped it meanwhile) so delivery is not delayed by up to 15s
    // once the agent actually recovers.
    const reason = result.reason ?? "motivo desconhecido";
    this.log.warn(`[dispatcher] nudge para ${agent.name} ABORTADO: ${reason}.`);
    this.nudgeBlocked.add(agent.name);
    const current = this.store.getAgent(agent.name);
    if (current && current.lastNudgeAt === at) {
      this.store.updateAgent(agent.name, { lastNudgeAt: prevNudgeAt });
    }
    this.markOffline(agent.name); // emitted payload already carries the reverted stamp
    return { sent: false, reason };
  }

  /** Sets status=offline, emitting agent_updated only when it changes. */
  private markOffline(name: string): void {
    const agent = this.store.getAgent(name);
    if (!agent || agent.status === "offline") return;
    const updated = this.store.updateAgent(name, { status: "offline" });
    this.bus.emit({ type: "agent_updated", payload: toPublicAgent(updated) });
  }
}
