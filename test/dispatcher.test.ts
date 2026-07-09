// Unit tests for the nudge dispatcher (PRD 10.2 — the pseudocode is the
// spec): fake clock + tmux mocked by dependency injection, fully
// deterministic (flush/poll are invoked directly; no real timers).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dispatcher } from "../src/server/dispatcher.js";
import type { DispatcherTmux } from "../src/server/dispatcher.js";
import { Store } from "../src/server/store.js";
import { Logger } from "../src/server/log.js";
import { EventBus } from "../src/server/api.js";
import { DEFAULTS } from "../src/server/config.js";
import type { NudgeResult } from "../src/server/tmux.js";
import type { Agent, Config, SseEvent } from "../src/shared/types.js";

const COOLDOWN = DEFAULTS.nudgeCooldownMs; // 15000

interface NudgeCall {
  session: string;
  text: string;
  enterDelayMs: number;
}

/**
 * tmux mock: liveness controlled by `alive`; pane safety controlled by
 * `unsafePanes` (default: everything safe); every nudge recorded.
 */
function mockTmux(options: { nudgeResult?: () => NudgeResult } = {}) {
  const alive = new Set<string>();
  const unsafePanes = new Set<string>();
  const nudges: NudgeCall[] = [];
  const hasSessionCalls: string[] = [];
  const paneSafetyCalls: string[] = [];
  const tmux: DispatcherTmux = {
    async hasSession(session) {
      hasSessionCalls.push(session);
      return alive.has(session);
    },
    async nudgeSession(session, text, enterDelayMs) {
      nudges.push({ session, text, enterDelayMs });
      return options.nudgeResult ? options.nudgeResult() : { sent: true };
    },
    async isPaneSafeToNudge(session) {
      paneSafetyCalls.push(session);
      return !unsafePanes.has(session);
    },
  };
  return { tmux, alive, unsafePanes, nudges, hasSessionCalls, paneSafetyCalls };
}

let dir: string;
let store: Store;
let bus: EventBus;
let events: SseEvent[];
let nowMs: number;
let config: Config;

const iso = (ms: number) => new Date(ms).toISOString();

function makeDispatcher(tmux: DispatcherTmux): Dispatcher {
  return new Dispatcher({
    store,
    config,
    log: new Logger({ stdout: false, filePath: path.join(dir, "hub.log") }),
    bus,
    tmux,
    now: () => nowMs,
  });
}

function registerOnline(name: string, session = `sb-${name}`): Agent {
  store.registerAgent({ name, role: "", tmuxSession: session, cwd: "" });
  return store.updateAgent(name, { status: "online" });
}

/** Delivers one message through the dispatcher exactly like deliverMessage does. */
function deliver(dispatcher: Dispatcher, from: string, to: string, body: string) {
  const message = store.appendMessage({ from, to, body });
  return dispatcher.onNewMessage(message, store.getAgent(to)!);
}

/** Settles the fire-and-forget nudge chain (mock resolves in microtasks). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-dispatcher-test-"));
  store = new Store(dir, { info() {}, warn() {} });
  bus = new EventBus();
  events = [];
  bus.subscribe((event) => events.push(event));
  nowMs = 1_700_000_000_000;
  config = { ...DEFAULTS };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("onNewMessage — synchronous decision (pseudocode 10.2)", () => {
  it("cooldown produces coalescing: 3 messages in a burst → 1 immediate nudge + pending", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    expect(deliver(dispatcher, "beta", "alpha", "m1")).toBe("nudged");
    expect(deliver(dispatcher, "beta", "alpha", "m2")).toBe("coalesced");
    expect(deliver(dispatcher, "beta", "alpha", "m3")).toBe("coalesced");
    await settle();

    expect(nudges).toHaveLength(1); // exactly ONE nudge for the burst
    expect(nudges[0].session).toBe("sb-alpha");
    expect(dispatcher.pendingAgents).toEqual(["alpha"]);
  });

  it("lastNudgeAt is updated (synchronously) when the nudge is decided", async () => {
    const { tmux } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    expect(store.getAgent("alpha")!.lastNudgeAt).toBeNull();
    expect(deliver(dispatcher, "beta", "alpha", "m1")).toBe("nudged");
    // Synchronous: the cooldown starts at the decision, before tmux completes.
    expect(store.getAgent("alpha")!.lastNudgeAt).toBe(iso(nowMs));
    await settle();
    expect(store.getAgent("alpha")!.lastNudgeAt).toBe(iso(nowMs));
  });

  it("muted → queued_muted, with NO tmux call and no pending", async () => {
    const { tmux, nudges, hasSessionCalls } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.updateAgent("alpha", { muted: true });
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    expect(deliver(dispatcher, "beta", "alpha", "psst")).toBe("queued_muted");
    await settle();
    expect(nudges).toHaveLength(0);
    expect(hasSessionCalls).toHaveLength(0);
    expect(dispatcher.pendingAgents).toEqual([]);
  });

  it("dead tmux (offline status) → queued_offline, status stays offline, no tmux", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    store.registerAgent({ name: "alpha", role: "", tmuxSession: "sb-alpha", cwd: "" });
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });
    expect(store.getAgent("alpha")!.status).toBe("offline");

    expect(deliver(dispatcher, "beta", "alpha", "hi")).toBe("queued_offline");
    await settle();
    expect(nudges).toHaveLength(0);
    expect(store.getAgent("alpha")!.status).toBe("offline");
  });

  it("pane guard aborts on the async path: the agent goes offline with a warn (10.3)", async () => {
    const { tmux, nudges } = mockTmux({
      nudgeResult: () => ({ sent: false, reason: "pane in a shell (bash)" }),
    });
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    expect(deliver(dispatcher, "beta", "alpha", "hi")).toBe("nudged");
    await settle();
    expect(nudges).toHaveLength(1); // attempted…
    expect(store.getAgent("alpha")!.status).toBe("offline"); // …aborted and marked offline
    const updated = events.filter(
      (e) => e.type === "agent_updated" && (e.payload as Agent).name === "alpha",
    );
    expect(updated.length).toBeGreaterThan(0);
    // No nudge_sent was emitted (nothing was typed).
    expect(events.filter((e) => e.type === "nudge_sent")).toHaveLength(0);
  });

  it("an aborted nudge REVERTS lastNudgeAt: recovery does not inherit a cooldown from a nudge that never typed", async () => {
    const { tmux, nudges } = mockTmux({
      nudgeResult: () => ({ sent: false, reason: "pane in a shell (bash)" }),
    });
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    expect(store.getAgent("alpha")!.lastNudgeAt).toBeNull();
    expect(deliver(dispatcher, "beta", "alpha", "hi")).toBe("nudged");
    // SYNCHRONOUS stamp present before the tmux result (it's what coalesces bursts)…
    expect(store.getAgent("alpha")!.lastNudgeAt).toBe(iso(nowMs));
    await settle();
    // …but the guard abort restores the previous value: nothing was typed,
    // so no 15s cooldown can delay the post-recovery delivery.
    expect(nudges).toHaveLength(1);
    expect(store.getAgent("alpha")!.lastNudgeAt).toBeNull();
    expect(store.getAgent("alpha")!.status).toBe("offline");
  });
});

describe("nudge text (10.2 — exact template, one line, no message body)", () => {
  it("one unread: exact text with a single sender", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "secret body of the message");
    await settle();

    expect(nudges[0].text).toBe(
      "[switchboard] 1 new message(s) from: beta. Use the check_messages tool to read them.",
    );
    expect(nudges[0].text).not.toMatch(/[\r\n]/); // ALWAYS a single line (P5)
    expect(nudges[0].text).not.toContain("secret body"); // body NEVER via tmux
    expect(nudges[0].enterDelayMs).toBe(config.nudgeEnterDelayMs);
  });

  it("several coalesced unreads: count and senders aggregated in the flush", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1"); // immediate nudge (1 from beta)
    deliver(dispatcher, "operator", "alpha", "m2"); // coalesced
    await settle();
    expect(nudges).toHaveLength(1);

    nowMs += COOLDOWN; // cooldown expires
    dispatcher.flushPending();
    await settle();

    expect(nudges).toHaveLength(2);
    expect(nudges[1].text).toBe(
      "[switchboard] 2 new message(s) from: beta, operator. Use the check_messages tool to read them.",
    );
  });
});

describe("flushPending (5s timer from 10.2)", () => {
  it("after the cooldown with unread > 0: fires 1 nudge and removes the pending entry", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1");
    deliver(dispatcher, "beta", "alpha", "m2");
    await settle();
    expect(nudges).toHaveLength(1);
    expect(dispatcher.pendingAgents).toEqual(["alpha"]);

    // Cooldown STILL active: flush does nothing.
    nowMs += COOLDOWN - 1;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(1);
    expect(dispatcher.pendingAgents).toEqual(["alpha"]);

    // Cooldown expired + unread > 0: ONE nudge and pending removed.
    nowMs += 1;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(2);
    expect(dispatcher.pendingAgents).toEqual([]);

    // Flush again: nothing pending, nothing fired.
    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(2);
  });

  it("unread == 0 (agent already read): flush does NOT nudge", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1");
    const second = store.appendMessage({ from: "beta", to: "alpha", body: "m2" });
    dispatcher.onNewMessage(second, store.getAgent("alpha")!); // coalesced
    await settle();
    expect(nudges).toHaveLength(1);

    // Agent read everything before the flush (check_messages).
    for (const m of store.unreadFor("alpha")) store.markRead(m.id);

    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(1); // no extra nudge
  });

  it("REGRESSION (pending leak): a debt settled in the flush is DISCARDED and a future message generates exactly 1 nudge", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1"); // nudged
    deliver(dispatcher, "beta", "alpha", "m2"); // coalesced
    await settle();
    expect(nudges).toHaveLength(1);
    expect(dispatcher.pendingAgents).toEqual(["alpha"]);

    // Agent read EVERYTHING (check_messages) before the flush.
    for (const m of store.unreadFor("alpha")) store.markRead(m.id);
    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(1);
    expect(dispatcher.pendingAgents).toEqual([]); // debt settled — no ghost entry

    // Much later, ONE single new message → ONE immediate nudge…
    nowMs += COOLDOWN * 10;
    expect(deliver(dispatcher, "beta", "alpha", "m3")).toBe("nudged");
    await settle();
    expect(nudges).toHaveLength(2);
    expect(dispatcher.pendingAgents).toEqual([]);

    // …and NO duplicate second nudge in the following flush.
    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(2);
  });

  it("REGRESSION (pending leak): an immediate nudge settles the coalescing debt — flush does not re-fire", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1"); // nudged
    deliver(dispatcher, "beta", "alpha", "m2"); // coalesced → pending
    await settle();
    expect(nudges).toHaveLength(1);
    expect(dispatcher.pendingAgents).toEqual(["alpha"]);

    // Cooldown expires WITHOUT the flush running; m3 arrives → an IMMEDIATE
    // nudge covers the 3 unreads and settles the old pending entry.
    nowMs += COOLDOWN;
    expect(deliver(dispatcher, "beta", "alpha", "m3")).toBe("nudged");
    await settle();
    expect(nudges).toHaveLength(2);
    expect(nudges[1].text).toContain("3 new message(s)");
    expect(dispatcher.pendingAgents).toEqual([]);

    // A later flush does NOT repeat the identical nudge.
    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(2);
  });

  it("agent muted after being coalesced: flush suppresses the nudge (mute = 10.1)", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1");
    deliver(dispatcher, "beta", "alpha", "m2");
    await settle();
    store.updateAgent("alpha", { muted: true });

    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(1); // only the initial one; the flush did not nudge the muted agent
  });
});

describe("status polling (10.4)", () => {
  it("emits agent_updated ONLY when the status changes", async () => {
    const { tmux, alive } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    store.registerAgent({ name: "alpha", role: "", tmuxSession: "sb-alpha", cwd: "" });

    const updatesFor = (name: string) =>
      events.filter(
        (e) => e.type === "agent_updated" && (e.payload as Agent).name === name,
      );

    // offline → offline: no change, no event.
    await dispatcher.pollOnce();
    expect(updatesFor("alpha")).toHaveLength(0);
    expect(store.getAgent("alpha")!.status).toBe("offline");

    // offline → online: 1 event.
    alive.add("sb-alpha");
    await dispatcher.pollOnce();
    expect(updatesFor("alpha")).toHaveLength(1);
    expect(store.getAgent("alpha")!.status).toBe("online");

    // online → online: no new event.
    await dispatcher.pollOnce();
    await dispatcher.pollOnce();
    expect(updatesFor("alpha")).toHaveLength(1);

    // online → offline: 1 new event.
    alive.delete("sb-alpha");
    await dispatcher.pollOnce();
    expect(updatesFor("alpha")).toHaveLength(2);
    expect(store.getAgent("alpha")!.status).toBe("offline");
  });

  it("an agent that comes online with unread > 0 is nudged (cooldown expired)", async () => {
    const { tmux, alive, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    store.registerAgent({ name: "alpha", role: "", tmuxSession: "sb-alpha", cwd: "" });
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    // Message arrives with the agent offline → queued_offline, no nudge.
    expect(deliver(dispatcher, "beta", "alpha", "hi")).toBe("queued_offline");
    await settle();
    expect(nudges).toHaveLength(0);

    // Session comes back: polling marks online and delivers the pending nudge.
    alive.add("sb-alpha");
    await dispatcher.pollOnce();
    await settle();
    expect(store.getAgent("alpha")!.status).toBe("online");
    expect(nudges).toHaveLength(1);
    expect(nudges[0].session).toBe("sb-alpha");
  });

  it("an agent that comes online with unread > 0 but in cooldown becomes pending (respects cooldown)", async () => {
    const { tmux, alive, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });
    alive.add("sb-alpha");

    deliver(dispatcher, "beta", "alpha", "m1"); // nudged: cooldown starts
    await settle();
    expect(nudges).toHaveLength(1);

    // Session drops and comes back WITHIN the cooldown, with a second unread.
    store.updateAgent("alpha", { status: "offline" });
    const m2 = store.appendMessage({ from: "beta", to: "alpha", body: "m2" });
    expect(dispatcher.onNewMessage(m2, store.getAgent("alpha")!)).toBe("queued_offline");

    nowMs += 1000; // cooldown (15s) still active
    await dispatcher.pollOnce();
    await settle();
    expect(nudges).toHaveLength(1); // did NOT nudge again
    expect(dispatcher.pendingAgents).toEqual(["alpha"]); // …but became pending

    nowMs += COOLDOWN;
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(2); // the flush delivered after the cooldown
  });

  it("a live session with an unsafe pane does NOT flap online↔offline: quarantine until the guard passes", async () => {
    // The pane is in a shell: the nudge aborts while it stays unsafe.
    let paneSafeNow = false;
    const { tmux, alive, unsafePanes, nudges } = mockTmux({
      nudgeResult: () =>
        paneSafeNow ? { sent: true } : { sent: false, reason: "pane in a shell (bash)" },
    });
    const dispatcher = makeDispatcher(tmux);
    store.registerAgent({ name: "alpha", role: "", tmuxSession: "sb-alpha", cwd: "" });
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });
    alive.add("sb-alpha");
    unsafePanes.add("sb-alpha");

    const updatesForAlpha = () =>
      events.filter(
        (e) => e.type === "agent_updated" && (e.payload as Agent).name === "alpha",
      );

    // 1st poll: normal promotion (no abort history) → online.
    await dispatcher.pollOnce();
    expect(store.getAgent("alpha")!.status).toBe("online");

    // Message arrives → nudged decision → guard aborts → offline + quarantine.
    expect(deliver(dispatcher, "beta", "alpha", "hi")).toBe("nudged");
    await settle();
    expect(nudges).toHaveLength(1);
    expect(store.getAgent("alpha")!.status).toBe("offline");
    const eventsAfterAbort = updatesForAlpha().length;

    // Subsequent polls (live session, pane STILL unsafe): status stable at
    // offline, ZERO new agent_updated, ZERO new nudge attempts —
    // even with the cooldown expired and the flush running.
    nowMs += COOLDOWN;
    await dispatcher.pollOnce();
    await dispatcher.pollOnce();
    dispatcher.flushPending();
    await settle();
    expect(store.getAgent("alpha")!.status).toBe("offline");
    expect(updatesForAlpha().length).toBe(eventsAfterAbort);
    expect(nudges).toHaveLength(1);

    // The pane becomes safe again (claude reopened): the poll promotes online
    // and the delivery goes out IMMEDIATELY (the abort reverted the cooldown).
    paneSafeNow = true;
    unsafePanes.delete("sb-alpha");
    await dispatcher.pollOnce();
    await settle();
    expect(store.getAgent("alpha")!.status).toBe("online");
    expect(nudges).toHaveLength(2);
    expect(events.filter((e) => e.type === "nudge_sent")).toHaveLength(1);
  });

  it("an agent that comes online WITHOUT unread is not nudged", async () => {
    const { tmux, alive, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    store.registerAgent({ name: "alpha", role: "", tmuxSession: "sb-alpha", cwd: "" });

    alive.add("sb-alpha");
    await dispatcher.pollOnce();
    await settle();
    expect(store.getAgent("alpha")!.status).toBe("online");
    expect(nudges).toHaveLength(0);
  });
});

describe("manual nudge (forceNudge — dashboard button, PRD 10.1)", () => {
  it("ignores cooldown and mute, but NEVER the pane guard", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1"); // cooldown active from here
    await settle();
    expect(nudges).toHaveLength(1);

    store.updateAgent("alpha", { muted: true });
    const forced = await dispatcher.forceNudge("alpha"); // muted AND in cooldown
    expect(forced.sent).toBe(true);
    expect(nudges).toHaveLength(2);

    // The pane guard still applies: abort → offline, no success.
    const guarded = mockTmux({ nudgeResult: () => ({ sent: false, reason: "shell" }) });
    const dispatcher2 = makeDispatcher(guarded.tmux);
    registerOnline("gamma");
    const blocked = await dispatcher2.forceNudge("gamma");
    expect(blocked.sent).toBe(false);
    expect(store.getAgent("gamma")!.status).toBe("offline");
  });

  it("unknown agent → {sent:false} with a reason", async () => {
    const { tmux } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    const result = await dispatcher.forceNudge("zeta");
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("unknown");
  });

  it("with 0 unreads uses the dedicated manual-nudge text (never '0 new message(s) ... from: .')", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");

    const result = await dispatcher.forceNudge("alpha");
    expect(result.sent).toBe(true);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].text).toBe(
      "[switchboard] Manual nudge from operator. Use the check_messages tool to check your queue.",
    );
    expect(nudges[0].text).not.toContain("0 new message(s)");
    expect(nudges[0].text).not.toContain("from: .");
    expect(nudges[0].text).not.toMatch(/[\r\n]/); // ALWAYS a single line (P5)
  });
});

describe("lifecycle (start/stop with no dangling handles)", () => {
  it("start is idempotent and stop can be called repeatedly", async () => {
    const { tmux } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    dispatcher.start();
    dispatcher.start(); // no-op
    await settle();
    dispatcher.stop();
    dispatcher.stop(); // no-op — if a handle leaked, vitest would hang here
  });
});
