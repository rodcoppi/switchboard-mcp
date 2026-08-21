// Unit tests for the nudge dispatcher (PRD 10.2 — the pseudocode is the
// spec): fake clock + tmux mocked by dependency injection, fully
// deterministic (flush/poll are invoked directly; no real timers).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPOSER_HOLD_LIMIT_MS, Dispatcher } from "../src/server/dispatcher.js";
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
  const paneText = new Map<string, string>(); // what capturePane answers per session
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
    async capturePane(session) {
      return paneText.get(session) ?? "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ? for shortcuts";
    },
  };
  return { tmux, alive, unsafePanes, nudges, hasSessionCalls, paneSafetyCalls, paneText };
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

describe("parsePaneStatus", () => {
  it("reads working / permission / goal from a Claude footer", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    const pane = [
      "· Transfiguring… (30m · ↓ 108k tokens)",
      "                                        ◎ /goal active (21m)",
      "❯ ",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents",
    ].join("\n");
    expect(parsePaneStatus(pane)).toEqual({
      working: true,
      blocked: false,
      composerBusy: false,
      composerText: "",
      composerWrapped: true, // the footer sits right under the prompt line
      blockedPrompt: null,
      blockedOptions: [],
      waitingFor: null,
      permission: "bypass",
      goalActive: true,
      goalFor: "21m",
    });
  });

  it("reads plan mode and no goal when idle", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    const pane = "❯ \n  ⏵⏵ plan mode on (shift+tab to cycle) · ? for shortcuts";
    expect(parsePaneStatus(pane)).toEqual({
      working: false,
      blocked: false,
      composerBusy: false,
      composerText: "",
      composerWrapped: true, // the footer sits right under the prompt line
      blockedPrompt: null,
      blockedOptions: [],
      waitingFor: null,
      permission: "plan",
      goalActive: false,
      goalFor: null,
    });
  });

  it("returns null permission when the footer is absent", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    expect(parsePaneStatus("just some output\n")).toEqual({
      working: false,
      blocked: false,
      composerBusy: false,
      composerText: "",
      composerWrapped: false, // no prompt line at all in this frame
      blockedPrompt: null,
      blockedOptions: [],
      waitingFor: null,
      permission: null,
      goalActive: false,
      goalFor: null,
    });
  });

  it("reads the background-wait line — the state with no esc-to-interrupt", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    // Real frame: the turn's text is DONE (no "esc to interrupt"), the input
    // is back, and the only clue that work is pending is the spinner line.
    // Reading this as plain idle was the bug: the chat rendered the
    // conversation as finished while the harness still waited.
    const pane = [
      "● Show — assim que a pesquisa terminar eu te chamo.",
      "✻ Waiting for 1 background agent to finish",
      "❯ ",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ? for shortcuts",
    ].join("\n");
    const status = parsePaneStatus(pane);
    expect(status.working).toBe(false);
    expect(status.waitingFor).toBe("Waiting for 1 background agent to finish");
  });

  it("reads the plural background-wait and the tasks variant", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    expect(parsePaneStatus("✻ Waiting for 3 background agents to finish\n❯ ").waitingFor)
      .toBe("Waiting for 3 background agents to finish");
    expect(parsePaneStatus("✻ Waiting for 2 background tasks to finish\n❯ ").waitingFor)
      .toBe("Waiting for 2 background tasks to finish");
  });
});

describe("blocked: a modal owns the pane (security)", () => {
  // PROVEN on 04/08 with a disposable agent: with "Do you want to proceed?"
  // open, the nudge's Enter (sent ~500ms after the text) landed on the
  // highlighted choice and the pending Bash command RAN. The dispatcher must
  // never type into a pane in this state.
  it("reads the permission dialog, the trust prompt and the channel warning", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    const permission = [
      " Bash command",
      "   touch PROVA.txt",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and always allow",
      "   3. No",
    ].join("\n");
    expect(parsePaneStatus(permission).blocked).toBe(true);
    expect(parsePaneStatus("Do you trust the files in this folder?\n❯ 1. Yes, proceed").blocked).toBe(true);
    expect(parsePaneStatus("WARNING: Loading development channels\n❯ 1. I am using this").blocked).toBe(true);
  });

  it("an ordinary working/idle frame is NOT blocked", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    const working = "· Transfiguring… (30m)\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt";
    expect(parsePaneStatus(working).blocked).toBe(false);
    expect(parsePaneStatus("❯ \n  ⏵⏵ plan mode on (shift+tab to cycle) · ? for shortcuts").blocked).toBe(false);
  });
});

describe("a modal dialog holds the nudge (security regression)", () => {
  const DIALOG = [
    " Bash command",
    "   rm -rf /tmp/x",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   3. No",
  ].join("\n");

  it("types NOTHING while the dialog is open, and delivers after it is answered", async () => {
    const world = mockTmux();
    const dispatcher = makeDispatcher(world.tmux);
    registerOnline("alpha");
    registerOnline("beta");
    world.alive.add("sb-beta");
    world.paneText.set("sb-beta", DIALOG); // a permission prompt owns the pane

    expect(deliver(dispatcher, "alpha", "beta", "oi")).toBe("nudged"); // decision is sync
    await new Promise((r) => setTimeout(r, 20)); // let the async path run
    expect(world.nudges).toHaveLength(0); // ← the Enter that used to answer "Yes"

    // The held nudge must not impose a cooldown on the recovery path.
    expect(store.getAgent("beta")!.lastNudgeAt).toBeNull();

    // Operator answers the dialog; the pane goes back to normal.
    world.paneText.set("sb-beta", "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)");
    // The dialog pane also reads as a busy caret ("❯ 1. Yes"), so both flags
    // clear when it is answered — `blocked` is the one that mattered here.
    store.updateAgent("beta", { blocked: false, composerBusy: false });
    dispatcher.flushPending();
    await new Promise((r) => setTimeout(r, 20));
    expect(world.nudges).toHaveLength(1);
    expect(world.nudges[0].text).toContain("1 new message(s)");
  });

  it("fails CLOSED: an unreadable pane is treated as blocked", async () => {
    const world = mockTmux();
    world.tmux.capturePane = async () => {
      throw new Error("pane gone");
    };
    const dispatcher = makeDispatcher(world.tmux);
    registerOnline("alpha");
    registerOnline("beta");
    world.alive.add("sb-beta");
    deliver(dispatcher, "alpha", "beta", "oi");
    await new Promise((r) => setTimeout(r, 20));
    expect(world.nudges).toHaveLength(0);
  });

  it("the cached blocked flag short-circuits before any tmux call", () => {
    const world = mockTmux();
    const dispatcher = makeDispatcher(world.tmux);
    registerOnline("alpha");
    registerOnline("beta");
    world.alive.add("sb-beta");
    store.updateAgent("beta", { blocked: true });
    expect(deliver(dispatcher, "alpha", "beta", "oi")).toBe("coalesced");
  });
});

describe("composerBusy: never type into a half-written prompt", () => {
  // The owner's complaint, verbatim: "às vezes eu tô digitando coisa e do
  // nada vem um texto do switchboard e cola no meio do meu prompt e envia
  // sozinho". The nudge is text + Enter, so it lands inside whatever he was
  // typing and submits the mix.
  it("sees text waiting at the caret", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    const typing = ["● alguma saída anterior", "❯ mandei o contrato pro marcelo", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
    expect(parsePaneStatus(typing).composerBusy).toBe(true);
  });

  it("an empty caret is free (NBSP padding included)", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    expect(parsePaneStatus("● pronto\n❯ \u00a0\n  ⏵⏵ bypass permissions on").composerBusy).toBe(false);
    expect(parsePaneStatus("● pronto\n❯\n  ? for shortcuts").composerBusy).toBe(false);
  });

  it("reads the LAST caret — earlier ones are conversation history", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    const pane = ["❯ uma pergunta antiga já enviada", "● a resposta do agente", "❯ "].join("\n");
    expect(parsePaneStatus(pane).composerBusy).toBe(false);
  });

  it("queues the nudge instead of typing, and delivers once the prompt clears", async () => {
    const world = mockTmux();
    const dispatcher = makeDispatcher(world.tmux);
    registerOnline("alpha");
    registerOnline("beta");
    world.alive.add("sb-beta");
    world.paneText.set("sb-beta", "❯ estou escrevendo uma coisa longa\n  ⏵⏵ bypass permissions on");

    expect(deliver(dispatcher, "alpha", "beta", "oi")).toBe("nudged");
    await new Promise((r) => setTimeout(r, 20));
    expect(world.nudges).toHaveLength(0); // his sentence survives
    expect(store.getAgent("beta")!.lastNudgeAt).toBeNull(); // no cooldown imposed

    world.paneText.set("sb-beta", "❯ \n  ⏵⏵ bypass permissions on");
    store.updateAgent("beta", { composerBusy: false });
    dispatcher.flushPending();
    await new Promise((r) => setTimeout(r, 20));
    expect(world.nudges).toHaveLength(1);
  });
});

describe("the question a blocked pane is asking", () => {
  // While a dialog owns the TUI the chat cannot reach the input at all —
  // worse, its Enter lands on the highlighted choice. So the dashboard has to
  // SHOW the question and answer it as its own act.
  it("reads the prompt and its choices, in order", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    const pane = [
      " Bash command",
      "   rm -rf /tmp/x",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and always allow access to prova/ from this project",
      "   3. No",
      " Esc to cancel · Tab to amend",
    ].join("\n");
    const st = parsePaneStatus(pane);
    expect(st.blocked).toBe(true);
    expect(st.blockedPrompt).toBe("Do you want to proceed?");
    expect(st.blockedOptions).toEqual([
      "Yes",
      "Yes, and always allow access to prova/ from this project",
      "No",
    ]);
  });

  it("reads the development-channel warning the same way", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    const pane = [
      "  WARNING: Loading development channels",
      "  Channels: server:whatsapp",
      "  ❯ 1. I am using this for local development",
      "    2. Exit",
    ].join("\n");
    const st = parsePaneStatus(pane);
    expect(st.blockedOptions).toEqual(["I am using this for local development", "Exit"]);
    expect(st.blockedPrompt).toBe("Channels: server:whatsapp");
  });

  it("a question WITH previews: the box beside the list is not part of the labels", async () => {
    // Claude Code's AskUserQuestion draws the choices in a left column and a
    // bordered preview box to their right, so one pane line carries both. The
    // owner's dashboard showed "É funcionário, não │ olhar e perguntar que
    // parte do seu dia é exatamente isso: │" on a button (17/08). Verbatim
    // layout of that frame — including the label that wraps to a second line.
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    const pane = [
      " ☐ O take",
      "",
      "Qual é o teu take pro clímax do short?",
      "",
      "  1. A chaveira, não o preço      ┌──────────────────────────────────────┐",
      "❯ 2. Não é pra você ainda         │ CLÍMAX: Isso aí não é pra você       │",
      "  3. É funcionário, não           │ olhar e perguntar que parte do seu   │",
      "    assistente                    │ dia é exatamente isso: abrir três    │",
      "                                  │ sistemas, copiar de um pro outro.    │",
      "                                  └──────────────────────────────────────┘",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    const st = parsePaneStatus(pane);
    expect(st.blocked).toBe(true);
    expect(st.blockedPrompt).toBe("Qual é o teu take pro clímax do short?");
    expect(st.blockedOptions).toEqual([
      "A chaveira, não o preço",
      "Não é pra você ainda",
      "É funcionário, não assistente", // the wrapped continuation belongs to it
    ]);
  });

  it("stripSidePanel keeps the left column and drops a pure-border line", async () => {
    const { stripSidePanel } = await import("../src/server/dispatcher.js");
    expect(stripSidePanel("  2. No   │ preview text │")).toBe("  2. No");
    expect(stripSidePanel("        └────────────┘")).toBe("");
    expect(stripSidePanel("  2. No — plain text, em dash and all")).toBe(
      "  2. No — plain text, em dash and all",
    );
  });

  it("an ordinary frame asks nothing", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    const st = parsePaneStatus("● done\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)");
    expect(st.blockedOptions).toEqual([]);
    expect(st.blockedPrompt).toBeNull();
  });
});

describe("a prompt holding unsent text stops being a silent stall", () => {
  // Waiting is right — typing into a half-written line would submit the
  // operator's words together with ours. But the wait has no end when the text
  // was LEFT there (a chat message whose Enter was refused): the agent is never
  // nudged again and messages pile up as "coalesced". Six agents sat like that
  // at once on 21/08 with nothing on screen or in the log to say why.
  it("warns ONCE per stall, naming the agent and the backlog, and still never types", async () => {
    const { tmux, nudges } = mockTmux();
    const logPath = path.join(dir, "hub.log");
    const dispatcher = new Dispatcher({
      store,
      config,
      log: new Logger({ stdout: false, filePath: logPath }),
      bus,
      tmux,
      now: () => nowMs,
    });
    registerOnline("alpha");
    store.updateAgent("alpha", { composerBusy: true });
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    expect(deliver(dispatcher, "beta", "alpha", "m1")).toBe("coalesced");
    nowMs += COOLDOWN + 1000; // cooldown is not what is holding it
    dispatcher.flushPending();
    dispatcher.flushPending();
    dispatcher.flushPending();
    await settle();

    expect(nudges).toEqual([]); // his half-written line is never typed over
    const held = fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes("holding nudges"));
    expect(held).toHaveLength(1); // once per stall, not once per 5s flush
    expect(held[0]).toContain("alpha");
    expect(held[0]).toContain("1 message(s) waiting");
  });

  it("the moment the line is cleared, the held nudge goes out", async () => {
    const { tmux, nudges } = mockTmux();
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.updateAgent("alpha", { composerBusy: true });
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });

    deliver(dispatcher, "beta", "alpha", "m1");
    nowMs += COOLDOWN + 1000;
    dispatcher.flushPending();
    expect(nudges).toEqual([]);

    store.updateAgent("alpha", { composerBusy: false }); // he sent or cleared it
    dispatcher.flushPending();
    await settle();
    expect(nudges).toHaveLength(1);
    expect(nudges[0].session).toBe("sb-alpha");
  });
});


describe("the composer's ghost is not a half-written sentence", () => {
  // An empty Claude Code composer is not blank: it redraws the LAST message you
  // sent there, dim, as a placeholder. Read as plain text that is indented
  // typing — so every agent that had ever been messaged looked permanently
  // mid-sentence, was never nudged again, and its messages piled up as
  // "coalesced" (six agents deaf at once, 21/08). The only difference is in the
  // SGR codes, which is why the pane is captured with -e. Both frames below are
  // verbatim from the owner's vide-editor pane.
  const E = "\u001b";
  const footer = `${E}[39m  ${E}[38;5;211m\u23f5\u23f5 bypass permissions on${E}[38;5;246m (shift+tab to cycle)${E}[39m`;

  it("a dim placeholder leaves the composer free", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    const pane = [`${E}[39m\u276f ${E}[2mvou ver o s21 agora${E}[0m`, footer].join("\n");
    expect(parsePaneStatus(pane).composerBusy).toBe(false);
  });

  it("text actually typed still holds it", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    expect(parsePaneStatus(`${E}[39m\u276f zz\n${footer}`).composerBusy).toBe(true);
    // …and a frame with no SGR at all behaves exactly as before.
    expect(parsePaneStatus("\u276f meia frase\n  \u23f5\u23f5 bypass permissions on").composerBusy).toBe(true);
    expect(parsePaneStatus("\u276f \n  \u23f5\u23f5 bypass permissions on").composerBusy).toBe(false);
  });

  it("dropDim keeps what is bright and drops what is not", async () => {
    const { dropDim, stripAnsi } = await import("../src/server/dispatcher.js");
    expect(dropDim(`${E}[2mghost${E}[0m`)).toBe("");
    expect(dropDim(`${E}[2mghost${E}[22m real`)).toBe(" real");
    expect(dropDim(`kept ${E}[2mgone${E}[0m kept`)).toBe("kept  kept");
    expect(dropDim("no escapes at all")).toBe("no escapes at all");
    // A colour change is not a dim change: 39m must not clear it.
    expect(dropDim(`${E}[2mghost${E}[39m still ghost`)).toBe("");
    expect(stripAnsi(`${E}[39m\u276f ${E}[2mx${E}[0m`)).toBe("\u276f x");
  });

  it("the rest of the frame still parses through the escapes", async () => {
    const { parsePaneStatus } = await import("../src/server/dispatcher.js");
    const pane = [
      `${E}[38;5;114m\u25cf Do you want to proceed?${E}[39m`,
      `${E}[39m \u276f 1. Yes${E}[0m`,
      `${E}[39m   2. No${E}[0m`,
      `${E}[2mesc to interrupt${E}[0m`,
      footer,
    ].join("\n");
    const st = parsePaneStatus(pane);
    expect(st.blocked).toBe(true);
    expect(st.blockedOptions).toEqual(["Yes", "No"]);
    expect(st.working).toBe(true); // dim or not, the marker is still the marker
    expect(st.permission).toBe("bypass");
  });
});


describe("no message stays in limbo: the hub borrows the line and gives it back", () => {
  // A pane holding unsent text was never typed into — right as a rule, fatal as
  // a permanent one: a line left behind made the agent deaf forever while its
  // messages sat in the store and the dashboard showed it idle. Past
  // COMPOSER_HOLD_LIMIT_MS of the SAME untouched text, the hub saves the line,
  // clears it, nudges, and types it back. It never presses Enter on his words.
  const E = "\u001b";
  const box = "\u2500".repeat(20);
  const frame = (composer: string) =>
    [box, `${E}[39m\u276f ${composer}`, box, "  \u23f5\u23f5 bypass permissions on (shift+tab to cycle)"].join("\n");

  function rescueTmux(script: string[]) {
    const typed: string[] = [];
    const bytes: Buffer[] = [];
    const nudges: NudgeCall[] = [];
    let step = 0;
    const tmux: DispatcherTmux = {
      async hasSession() { return true; },
      async isPaneSafeToNudge() { return true; },
      async nudgeSession(session, text, enterDelayMs) {
        nudges.push({ session, text, enterDelayMs });
        return { sent: true };
      },
      async capturePane() { return script[Math.min(step++, script.length - 1)]; },
      async sendKeysLiteral(_session, text) { typed.push(text); },
      async sendKeysHex(_session, buf) { bytes.push(buf); },
    };
    return { tmux, typed, bytes, nudges };
  }

  async function heldAgent(tmux: DispatcherTmux) {
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.updateAgent("alpha", { composerBusy: true, composerText: "meia frase" });
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });
    deliver(dispatcher, "beta", "alpha", "m1");
    await settle();
    return dispatcher;
  }

  it("delivers the nudge and restores the exact text, without an Enter", async () => {
    // live read (still held) → after the backspaces (free) → performNudge's own
    // live re-check (free) → the restore check (free).
    const { tmux, typed, bytes, nudges } = rescueTmux([
      frame("meia frase"), frame(""), frame(""), frame(""),
    ]);
    const dispatcher = await heldAgent(tmux);

    nowMs += 10_000;
    dispatcher.flushPending(); // starts the clock on this text
    expect(nudges).toEqual([]);

    nowMs += COMPOSER_HOLD_LIMIT_MS + 1000;
    dispatcher.flushPending();
    await settle();

    expect(bytes).toHaveLength(1);
    expect(bytes[0].every((b) => b === 0x7f)).toBe(true); // backspaces only
    expect(bytes[0].length).toBe("meia frase".length + 4);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].text).toContain("new message(s) from: beta");
    expect(typed).toEqual(["meia frase"]); // put back verbatim…
    expect(typed.join("")).not.toContain("\r"); // …and never submitted
  });

  it("a line that MOVED means he is writing — the rescue steps aside", async () => {
    const { tmux, typed, bytes, nudges } = rescueTmux([frame("outra coisa ja")]);
    const dispatcher = await heldAgent(tmux);
    nowMs += 10_000;
    dispatcher.flushPending();
    nowMs += COMPOSER_HOLD_LIMIT_MS + 1000;
    dispatcher.flushPending();
    await settle();
    expect(bytes).toEqual([]);
    expect(nudges).toEqual([]);
    expect(typed).toEqual([]);
  });

  it("text that runs past the prompt line is never borrowed (half of it would be lost)", async () => {
    const wrapped = [box, `${E}[39m\u276f uma frase bem longa`, "que continua aqui embaixo", box].join("\n");
    const { tmux, typed, bytes, nudges } = rescueTmux([wrapped]);
    const dispatcher = makeDispatcher(tmux);
    registerOnline("alpha");
    store.updateAgent("alpha", { composerBusy: true, composerText: "uma frase bem longa" });
    store.registerAgent({ name: "beta", role: "", tmuxSession: "sb-beta", cwd: "" });
    deliver(dispatcher, "beta", "alpha", "m1");
    await settle();
    nowMs += 10_000;
    dispatcher.flushPending();
    nowMs += COMPOSER_HOLD_LIMIT_MS + 1000;
    dispatcher.flushPending();
    await settle();
    expect(bytes).toEqual([]);
    expect(nudges).toEqual([]);
    expect(typed).toEqual([]);
  });

  it("a pane that refuses to clear is left exactly as it was", async () => {
    // live read (held) → after the backspaces: STILL held.
    const { tmux, typed, bytes, nudges } = rescueTmux([frame("meia frase"), frame("meia frase")]);
    const dispatcher = await heldAgent(tmux);
    nowMs += 10_000;
    dispatcher.flushPending();
    nowMs += COMPOSER_HOLD_LIMIT_MS + 1000;
    dispatcher.flushPending();
    await settle();
    expect(bytes).toHaveLength(1); // it tried…
    expect(nudges).toEqual([]);    // …did not nudge…
    expect(typed).toEqual([]);     // …and did not double the text either
  });

  it("a modal dialog is still untouchable — that Enter would answer it", async () => {
    const dialog = [box, "Do you want to proceed?", " \u276f 1. Yes", "   2. No", box].join("\n");
    const { tmux, typed, bytes, nudges } = rescueTmux([dialog]);
    const dispatcher = await heldAgent(tmux);
    nowMs += 10_000;
    dispatcher.flushPending();
    nowMs += COMPOSER_HOLD_LIMIT_MS + 1000;
    dispatcher.flushPending();
    await settle();
    expect(bytes).toEqual([]);
    expect(nudges).toEqual([]);
    expect(typed).toEqual([]);
  });
});
