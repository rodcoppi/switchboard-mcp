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
  type AgentActivity,
  type AgentPermission,
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

/**
 * Idle/working sweep cadence. Faster than the 10s status poll because a turn
 * can begin and end within one status interval, and a stale "working" badge is
 * exactly the kind of thing that makes a dashboard feel dead.
 */
export const ACTIVITY_POLL_INTERVAL_MS = 2500;

/** The narrow tmux surface the dispatcher needs (injectable for unit tests). */
export interface DispatcherTmux {
  hasSession(session: string): Promise<boolean>;
  nudgeSession(session: string, text: string, enterDelayMs: number): Promise<NudgeResult>;
  /** Pane guard probe (fail-closed) — used to break the online↔offline flap. */
  isPaneSafeToNudge(session: string): Promise<boolean>;
  /** Reads the pane to tell idle from working. Optional so test mocks may omit it. */
  capturePane?(session: string, lines?: number): Promise<string>;
}

export interface PaneStatus {
  working: boolean;
  /**
   * A modal question owns the TUI right now ("Do you want to proceed?",
   * trust prompt, development-channel warning). SECURITY-CRITICAL: a nudge
   * types a line and sends Enter ~500ms later, and with one of these open
   * that Enter lands on the HIGHLIGHTED CHOICE — proven on 04/08 with a
   * disposable agent: the nudge accepted a pending Bash permission and the
   * command ran. Never type into a blocked pane.
   */
  blocked: boolean;
  /**
   * "Waiting for N background agents to finish", verbatim, when the TUI shows
   * it. This state has NO "esc to interrupt" (the turn's text is done), so
   * without it the poll reads a waiting agent as idle and the chat renders
   * the conversation as finished while work is still pending.
   */
  waitingFor: string | null;
  permission: AgentPermission | null;
  goalActive: boolean;
  goalFor: string | null; // "21m" from "/goal active (21m)", or null
}

/**
 * Reads the live TUI frame for what the operator wants at a glance. Claude Code
 * and Codex run in the alternate screen (no scrollback), so a captured pane is
 * only the CURRENT frame — never stale.
 *   - working: "esc to interrupt" shows only mid-turn.
 *   - permission/plan: the "⏵⏵ <mode> (shift+tab to cycle)" footer line.
 *   - goalActive: the "/goal active" marker Claude Code prints when a goal runs.
 */
export function parsePaneStatus(pane: string): PaneStatus {
  const working = /esc to interrupt/i.test(pane);
  // Modal prompts, by their own wording (each verified in a live pane).
  const blocked =
    /Do you want to (?:proceed|create|make|allow)/i.test(pane) ||
    /Do you trust the files in this folder\?/i.test(pane) ||
    /Loading development channels/i.test(pane) ||
    /❯\s*\d+\.\s/.test(pane); // the numbered choice list a modal renders
  const waitMatch = pane.match(/Waiting for \d+ background (?:agents?|tasks?) to finish/i);
  const waitingFor = waitMatch ? waitMatch[0] : null;
  const goalMatch = pane.match(/\/goal active(?:\s*\(([^)]+)\))?/i);
  const goalActive = goalMatch !== null;
  const goalFor = goalMatch && goalMatch[1] ? goalMatch[1].trim() : null;
  let permission: AgentPermission | null = null;
  const m = pane.match(/⏵⏵\s*(.+?)\s*\(shift\+tab/i);
  if (m) {
    const t = m[1].toLowerCase();
    permission = t.includes("bypass")
      ? "bypass"
      : t.includes("accept edits")
        ? "acceptEdits"
        : t.includes("plan")
          ? "plan"
          : "default";
  }
  return { working, blocked, waitingFor, permission, goalActive, goalFor };
}

/** Back-compat shim: whether the CLI is mid-turn. */
export function detectWorking(pane: string): boolean {
  return parsePaneStatus(pane).working;
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
  private activityTimer: NodeJS.Timeout | undefined;
  private activityInFlight = false;
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
    // A modal dialog owns the pane: typing now would answer it (proven —
    // see PaneStatus.blocked). Queue instead; the flush delivers once the
    // operator has answered. The cached flag is the fast path; fireNudge
    // re-checks the LIVE pane right before typing (fail-closed).
    if (agent.blocked) {
      this.pendingNudge.add(agent.name);
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
      if (agent.blocked) continue; // a modal still owns the pane — keep waiting
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
          `[dispatcher] polling: ${name} became ${next} (tmux ${tmuxSession}).`,
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
   * Manual nudge (dashboard button — PRD 10.1: "force a manual nudge").
   * Interpretation of "force" documented here on purpose: it BYPASSES the
   * cooldown and the mute flag (both are politeness/delivery controls that
   * the human operator may override), but NEVER the pane-command guard —
   * that one is a security invariant (PRD 10.3, section 15, pitfall P2) and
   * is not negotiable on any code path.
   */
  async forceNudge(name: string): Promise<ManualNudgeResult> {
    const agent = this.store.getAgent(name);
    if (!agent) {
      return { sent: false, reason: `unknown agent: "${name}"` };
    }
    return this.performNudge(agent);
  }

  /** Snapshot of the coalescing set (tests/debug). */
  get pendingAgents(): string[] {
    return [...this.pendingNudge];
  }

  /** Starts the flush (5s), status-polling and activity timers. Idempotent. */
  start(): void {
    if (this.flushTimer || this.pollTimer) return;
    this.flushTimer = setInterval(() => this.flushPending(), this.flushIntervalMs);
    this.flushTimer.unref(); // never hold the process open
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((err) => {
        this.log.error(`[dispatcher] error in status polling:`, err);
      });
    }, this.config.agentPollIntervalMs);
    this.pollTimer.unref();
    // Idle vs working needs a livelier cadence than the 10s status poll — a
    // turn can start and finish inside one status interval — so it runs on its
    // own faster timer. It is cheap: one capture-pane of a few lines per online
    // agent.
    this.activityTimer = setInterval(() => {
      void this.refreshActivityOnce().catch((err) => {
        this.log.error(`[dispatcher] error in activity polling:`, err);
      });
    }, ACTIVITY_POLL_INTERVAL_MS);
    this.activityTimer.unref();
    // Immediate first poll so status converges right after boot (replay may
    // have loaded agents whose sessions are still alive).
    void this.pollOnce().catch((err) => {
      this.log.error(`[dispatcher] error in initial polling:`, err);
    });
  }

  /** Stops all timers. Safe to call multiple times; no dangling handles. */
  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.flushTimer = undefined;
    this.pollTimer = undefined;
    this.activityTimer = undefined;
  }

  /**
   * Idle-vs-working sweep: for each ONLINE agent, read a few lines of its pane
   * and flip `activity` when it crosses the working/idle line. Best-effort and
   * change-only (emits + persists solely on a transition), so a steadily busy
   * or steadily idle agent costs one capture and no writes. Offline agents are
   * left as the status poll set them (idle).
   */
  async refreshActivityOnce(): Promise<void> {
    if (this.activityInFlight) return;
    if (!this.tmux.capturePane) return; // test mock without pane access
    this.activityInFlight = true;
    try {
      for (const { name, tmuxSession } of this.store.listAgents()) {
        const agent = this.store.getAgent(name);
        if (!agent || agent.status !== "online") continue;
        let status: PaneStatus = { working: false, blocked: false, waitingFor: null, permission: null, goalActive: false, goalFor: null };
        try {
          status = parsePaneStatus(await this.tmux.capturePane(tmuxSession, 30));
        } catch {
          /* unreadable pane: treat as idle/unknown, never throw */
        }
        const next: AgentActivity = status.working ? "working" : "idle";
        const blocked = status.blocked;
        // Only write on a real change (any field), so a steady agent is free.
        const permission = status.permission ?? agent.permission;
        const goalFor = status.goalActive ? status.goalFor ?? undefined : undefined;
        // "" (not undefined) when nothing is pending: updateAgent IGNORES
        // undefined keys, so undefined could set the field but never clear it.
        const waitingFor = status.waitingFor ?? "";
        if (
          agent.activity === next &&
          agent.permission === permission &&
          !!agent.goalActive === status.goalActive &&
          (agent.goalFor ?? undefined) === goalFor &&
          (agent.waitingFor ?? "") === waitingFor &&
          !!agent.blocked === blocked
        ) {
          continue;
        }
        const updated = this.store.updateAgent(name, {
          activity: next,
          blocked,
          waitingFor,
          permission,
          goalActive: status.goalActive,
          goalFor,
        });
        this.bus.emit({ type: "agent_updated", payload: toPublicAgent(updated) });
      }
    } finally {
      this.activityInFlight = false;
    }
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
      this.log.error(`[dispatcher] unexpected error nudging ${agent.name}:`, err);
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
    // "0 new message(s) from: ." — use a purpose-built manual-poke line.
    const text = (
      unread === 0
        ? `[switchboard] Manual nudge from operator. Use the check_messages tool to check your queue.`
        : `[switchboard] ${unread} new message(s) from: ${froms}. ` +
          `Use the check_messages tool to read them.`
    ).replace(/[\r\n]+/g, " "); // a nudge is ALWAYS a single line (P5)
    const at = new Date(this.now()).toISOString();
    // Stamp SYNCHRONOUSLY (same-tick bursts must already see the cooldown —
    // that is what coalesces them), but remember the previous value: a nudge
    // that ends up typing NOTHING must not impose a 15s cooldown on the
    // recovery path (PRD 10.2 stamps only after a successful send).
    const prevNudgeAt = agent.lastNudgeAt;
    this.store.updateAgent(agent.name, { lastNudgeAt: at });

    // LIVE re-check right before typing: the cached `blocked` flag is up to
    // one activity poll old, and a modal that opened in between would eat
    // this nudge's Enter as its answer. Fail-CLOSED — an unreadable pane is
    // treated as blocked, exactly like the pane guard.
    if (this.tmux.capturePane) {
      let blockedNow = true;
      try {
        blockedNow = parsePaneStatus(await this.tmux.capturePane(agent.tmuxSession, 30)).blocked;
      } catch {
        /* unreadable → stay blocked */
      }
      if (blockedNow) {
        this.store.updateAgent(agent.name, { lastNudgeAt: prevNudgeAt, blocked: true });
        this.pendingNudge.add(agent.name); // deliver once the modal is answered
        this.log.info(
          `[dispatcher] nudge for ${agent.name} HELD: a modal dialog owns the pane ` +
            `(typing now would answer it). Queued for the next flush.`,
        );
        return { sent: false, reason: "a dialog is open in the pane" };
      }
    }

    let result: NudgeResult;
    try {
      result = await this.tmux.nudgeSession(
        agent.tmuxSession,
        text,
        this.config.nudgeEnterDelayMs,
      );
    } catch (err) {
      result = { sent: false, reason: `error running tmux: ${String(err)}` };
    }

    if (result.sent) {
      this.nudgeBlocked.delete(agent.name);
      this.bus.emit({ type: "nudge_sent", payload: { agent: agent.name, at, unread } });
      this.log.info(
        `[dispatcher] nudge sent to ${agent.name} (${unread} unread from: ${froms}).`,
      );
      return { sent: true };
    }

    // Guard abort or tmux failure: the nudge did NOT complete. PRD 10.3:
    // mark the agent offline, quarantine it (see nudgeBlocked) and log at
    // warn level. Revert the optimistic cooldown stamp (only if no other
    // nudge re-stamped it meanwhile) so delivery is not delayed by up to 15s
    // once the agent actually recovers.
    const reason = result.reason ?? "unknown reason";
    this.log.warn(`[dispatcher] nudge to ${agent.name} ABORTED: ${reason}.`);
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
