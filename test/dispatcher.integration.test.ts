// Integration tests of the Phase 3 dispatcher with REAL tmux (PRD section 16,
// Phase 3 Done When + section 18). Skipped automatically when tmux is absent.
//
// - Test sessions use their own prefix (sb-t3-<pid>-) and are ALWAYS killed
//   in teardown, including on failure (afterEach + afterAll sweep).
// - No hub/HTTP here: the dispatcher is exercised directly through
//   deliverMessage (the exact production path of api.ts/mcp.ts), with a real
//   Store on a temp dir and a REAL tmux wrapper whose ExecFn is wrapped by a
//   recording spy — real behavior plus exact send-keys accounting.
// - No timers are started: pollOnce/flushPending are invoked directly.
//   Anything asynchronous is polled with a deadline (no blind sleeps).
// - NEVER uses ports 4577/4578 (no ports at all, in fact).

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTmux, type ExecFn, type Tmux } from "../src/server/tmux.js";
import { Dispatcher } from "../src/server/dispatcher.js";
import { Store } from "../src/server/store.js";
import { Logger } from "../src/server/log.js";
import { EventBus, deliverMessage } from "../src/server/api.js";
import { DEFAULTS } from "../src/server/config.js";
import type { SseEvent } from "../src/shared/types.js";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const PREFIX = `sb-t3-${process.pid}-`;

const execFileAsync = promisify(execFile);
const realExec: ExecFn = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, args, { encoding: "utf8" });
  return { stdout, stderr };
};

/** Polls fn until truthy or deadline (no blind sleeps). */
async function pollUntil<T>(
  fn: () => T | Promise<T>,
  what: string,
  timeoutMs = 10_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) {
      throw new Error(`Timeout (${timeoutMs}ms) waiting for: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!hasTmux)("dispatcher + real tmux (Phase 3 Done When)", () => {
  let dir: string;
  let store: Store;
  let bus: EventBus;
  let events: SseEvent[];
  let execCalls: string[][];
  let tmux: Tmux;
  let dispatcher: Dispatcher;
  let createdSessions: string[];

  /** send-keys calls (from the spy) aimed at a given session pane target. */
  const sendKeysCallsFor = (session: string) =>
    execCalls.filter((args) => args[0] === "send-keys" && args.includes(`=${session}:`));
  const literalSendKeysFor = (session: string) =>
    sendKeysCallsFor(session).filter((args) => args.includes("-l"));

  async function newTestSession(name: string, cmd?: string): Promise<string> {
    const session = PREFIX + name;
    createdSessions.push(session);
    await tmux.newSession(session, dir, cmd);
    return session;
  }

  function register(name: string, session: string): void {
    store.registerAgent({ name, role: "", tmuxSession: session, cwd: dir });
  }

  function sendToAgent(to: string, body: string) {
    return deliverMessage(store, bus, dispatcher.onNewMessage, {
      from: "operator",
      to,
      body,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-t3-int-"));
    store = new Store(dir, { info() {}, warn() {} });
    bus = new EventBus();
    events = [];
    bus.subscribe((event) => events.push(event));
    execCalls = [];
    const recordingExec: ExecFn = (file, args) => {
      execCalls.push([...args]);
      return realExec(file, args);
    };
    tmux = createTmux({ exec: recordingExec });
    dispatcher = new Dispatcher({
      store,
      config: { ...DEFAULTS },
      log: new Logger({ stdout: false, filePath: path.join(dir, "hub.log") }),
      bus,
      tmux,
    });
    createdSessions = [];
  });

  afterEach(async () => {
    dispatcher.stop();
    for (const session of createdSessions) {
      await tmux.killSession(session).catch(() => {});
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeAll(async () => {
    // Sweep of ORPHAN sessions from previous runs: if a run died by SIGKILL
    // (afterEach/afterAll never ran), leftover sb-t3-<pid>- sessions remain
    // that no future run would sweep (the PREFIX embeds the pid). Here we kill
    // only those of DEAD pids — concurrent runs (live pids) stay intact.
    const pidAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const raw = createTmux();
    for (const session of await raw.listSessions("sb-t3-")) {
      const match = /^sb-t3-(\d+)-/.exec(session);
      if (match && !pidAlive(Number(match[1]))) {
        await raw.killSession(session).catch(() => {});
      }
    }
  });

  afterAll(async () => {
    // Safety sweep: nothing with our prefix survives this file, even after
    // a failure between createdSessions.push and the afterEach.
    const raw = createTmux();
    for (const session of await raw.listSessions(PREFIX)) {
      await raw.killSession(session).catch(() => {});
    }
  });

  it("(a) a session running cat receives the nudge after the message (text visible in capture-pane)", async () => {
    const session = await newTestSession("a", "cat");
    register("alpha", session);

    // Status polling detects the live session and marks it online.
    await dispatcher.pollOnce();
    expect(store.getAgent("alpha")!.status).toBe("online");

    const result = sendToAgent("alpha", "contract ready at /tmp/a.md");
    expect(result.delivery).toBe("nudged");

    // nudge_sent is emitted AFTER the separate Enter — when it arrives, the
    // text → delay(500ms) → Enter cycle has fully completed.
    await pollUntil(
      () => events.some((e) => e.type === "nudge_sent"),
      "nudge_sent event after the separate Enter",
    );

    // The full nudge appears in the pane >= 2 times: the tty echo (typed
    // text, BEFORE the Enter) + the cat output (which ONLY exists if the
    // Enter SUBMITTED the line) — same PASS criterion as spike 0.2
    // (01-sendkeys-basic.sh: "submitted line appeared 2x in the pane"). A
    // single occurrence would prove only the typing, not the submission (P1).
    // Capture lines are re-joined because the 80-column pane wraps the typed
    // line.
    const expectedText =
      "[switchboard] 1 new message(s) from: operator. Use the check_messages tool to read them.";
    await pollUntil(async () => {
      const pane = await tmux.capturePane(session, 200);
      const flat = pane.split("\n").join("");
      return flat.split(expectedText).length - 1 >= 2;
    }, "nudge text visible 2x in capture-pane (echo + cat output post-Enter)");

    // The message body NEVER travels via tmux.
    const pane = await tmux.capturePane(session, 200);
    expect(pane).not.toContain("contract ready");

    // Enter was a SEPARATE send-keys (P1): 1 literal + 1 Enter.
    expect(literalSendKeysFor(session)).toHaveLength(1);
    expect(sendKeysCallsFor(session)).toHaveLength(2);

    // lastNudgeAt recorded and SSE nudge_sent emitted (spec payload).
    expect(store.getAgent("alpha")!.lastNudgeAt).not.toBeNull();
    const nudgeEvents = events.filter((e) => e.type === "nudge_sent");
    expect(nudgeEvents).toHaveLength(1);
    expect(nudgeEvents[0].payload).toMatchObject({ agent: "alpha", unread: 1 });
  }, 20_000);

  it("(b) 3 messages in < 5s generate EXACTLY 1 nudge send-keys (coalescing)", async () => {
    const session = await newTestSession("b", "cat");
    register("beta", session);
    await dispatcher.pollOnce();
    expect(store.getAgent("beta")!.status).toBe("online");

    const d1 = sendToAgent("beta", "m1").delivery;
    const d2 = sendToAgent("beta", "m2").delivery;
    const d3 = sendToAgent("beta", "m3").delivery;
    expect([d1, d2, d3]).toEqual(["nudged", "coalesced", "coalesced"]);

    // Wait for the single nudge to complete (nudge_sent arrives AFTER the Enter) …
    await pollUntil(
      () => events.filter((e) => e.type === "nudge_sent").length >= 1,
      "nudge (text + Enter + nudge_sent) to complete",
    );
    // … and then prove it was EXACTLY one: 1 literal send-keys, 1 Enter,
    // 1 nudge_sent, and the other two messages stayed pending (15s cooldown
    // active, timers off — nothing else can fire).
    expect(literalSendKeysFor(session)).toHaveLength(1);
    expect(sendKeysCallsFor(session)).toHaveLength(2);
    expect(events.filter((e) => e.type === "nudge_sent")).toHaveLength(1);
    expect(dispatcher.pendingAgents).toEqual(["beta"]);
    expect(store.unreadCount("beta")).toBe(3);
  }, 20_000);

  it("(c) MANDATORY: a pane running bash NEVER receives send-keys; the agent goes offline", async () => {
    const session = await newTestSession("c", "bash");
    register("gamma", session);

    // The session EXISTS (has-session passes): polling marks it online.
    await dispatcher.pollOnce();
    expect(store.getAgent("gamma")!.status).toBe("online");

    // The (synchronous, optimistic) decision reports nudged — but the pane
    // guard on the async path aborts BEFORE any send-keys (P2).
    const result = sendToAgent("gamma", "rm -rf / # if this runs, it's RCE");
    expect(result.delivery).toBe("nudged");

    await pollUntil(
      () => store.getAgent("gamma")!.status === "offline",
      "pane guard to abort and mark gamma offline",
    );

    // NO send-keys was executed against the session (neither text nor Enter).
    expect(sendKeysCallsFor(session)).toHaveLength(0);

    // And the pane has NOTHING typed (clean prompt, no [switchboard]).
    const pane = await tmux.capturePane(session, 200);
    expect(pane).not.toContain("[switchboard]");
    expect(pane).not.toContain("rm -rf");

    // No nudge_sent emitted; a manual (forced) nudge ALSO respects the guard.
    expect(events.filter((e) => e.type === "nudge_sent")).toHaveLength(0);
    const forced = await dispatcher.forceNudge("gamma");
    expect(forced.sent).toBe(false);
    expect(sendKeysCallsFor(session)).toHaveLength(0);

    // Anti-flapping: the session stays ALIVE (has-session passes), but the pane
    // stays in a shell — subsequent polls do NOT bring gamma back online
    // (no online↔offline oscillation each cycle, nor new nudge attempts
    // doomed to abort).
    const agentUpdatesBefore = events.filter((e) => e.type === "agent_updated").length;
    await dispatcher.pollOnce();
    await dispatcher.pollOnce();
    expect(store.getAgent("gamma")!.status).toBe("offline");
    expect(events.filter((e) => e.type === "agent_updated")).toHaveLength(agentUpdatesBefore);
    expect(sendKeysCallsFor(session)).toHaveLength(0);
  }, 20_000);

  it("(d) agent with a non-existent session → queued_offline and offline status", async () => {
    const ghost = PREFIX + "ghost"; // never created
    register("delta", ghost);

    await dispatcher.pollOnce(); // has-session fails → stays offline
    expect(store.getAgent("delta")!.status).toBe("offline");

    const result = sendToAgent("delta", "anyone there?");
    expect(result.delivery).toBe("queued_offline");
    expect(store.getAgent("delta")!.status).toBe("offline");
    expect(store.unreadCount("delta")).toBe(1); // recorded, awaiting check_messages

    // No send-keys anywhere.
    expect(execCalls.filter((args) => args[0] === "send-keys")).toHaveLength(0);
  }, 20_000);
});
