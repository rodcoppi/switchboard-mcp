// Integration tests of the CODEX agent type end to end: a REAL hub on an
// ephemeral port with its REAL launcher, REAL tmux, and a FAKE codex binary in
// place of the real one — a real codex (or claude) is NEVER opened here.
// Skipped when tmux is absent.
//
// The claude path has its own file (launcher.integration.test.ts) and is left
// completely untouched: it is the regression guard for the default agent type.
// This file only proves the SECOND type works through the same one flow.
//
// The fake codex is written in NODE, not sh, for a load-bearing reason: it must
// report a pane_current_command on the send-keys allow-list so the kickoff can
// actually press Enter on the trust dialog. Real codex reports "node" (that is
// why SAFE_PANE_COMMANDS needed no widening for this feature) — the fake
// reports "node" too, so the guard is exercised for real rather than stubbed.
// It also lets the fake mimic codex's ACTUAL boot sequence: trust dialog first,
// header only AFTER the Enter, which is exactly the ordering the readiness
// markers have to get right.
//
// Hygiene mirrors launcher.integration.test.ts: fresh temp data dir per test,
// hub on port 0 (never 4577/4578), agent names carry a per-pid prefix so tmux
// sessions are swept in afterEach/afterAll (+ a beforeAll sweep of orphans from
// SIGKILLed runs), and nothing asynchronous is asserted with blind sleeps.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startHub, type Hub } from "../src/server/hub.js";
import { createTmux, type Tmux } from "../src/server/tmux.js";
import type { Agent } from "../src/shared/types.js";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const NAME_PREFIX = `cx-${process.pid}-`; // agent names → sessions sb-cx-<pid>-…
const SESSION_PREFIX = `sb-${NAME_PREFIX}`;

/**
 * The fake Codex CLI. Reproduces the boot sequence that matters:
 *   1. echo the argv (so the test can PROVE the exact codex argv was passed);
 *   2. show the trust dialog — and NOT the header, exactly like the real one;
 *   3. on the first stdin line (the kickoff's Enter accepting the dialog),
 *      REDRAW the screen with the `>_ OpenAI Codex` header and no dialog —
 *      i.e. become "ready";
 *   4. echo every later line, so the kickoff's join instruction is observable.
 *
 * It runs on the ALTERNATE SCREEN (ESC[?1049h) and REDRAWS rather than
 * appending, because that is what real codex does — its `--no-alt-screen` flag
 * exists precisely to turn the default OFF — and the readiness markers depend
 * on it. `capture-pane -S -200` reads tmux's HISTORY, which an append-only pane
 * keeps forever; on the alternate screen there is no history, so capture
 * returns only the live screen and an accepted dialog genuinely disappears
 * (verified against tmux directly). An append-only fake would keep the dialog
 * text in the capture forever and never read as ready — a fake artifact, not a
 * product bug, and precisely the wrong thing to design the product around.
 *
 * The pane's stdin is a TTY in canonical mode, so each Enter delivers exactly
 * one "data" event — which is how the trust Enter and the kickoff Enter are
 * told apart here.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const head = [
  "ARGS: " + process.argv.slice(2).join(" "),
  "SWITCHBOARD_AGENT_NAME=" + (process.env.SWITCHBOARD_AGENT_NAME || ""),
];
process.stdout.write("\\x1b[?1049h"); // alternate screen, like the real TUI
const screen = (lines) =>
  process.stdout.write("\\x1b[2J\\x1b[H" + head.concat(lines).join("\\r\\n") + "\\r\\n");
screen([
  "  Do you trust the contents of this directory?",
  "  1. Yes, continue",
  "  2. No, quit",
]);
let trusted = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (!trusted) {
    trusted = true;
    screen([">_ OpenAI Codex (v0.0.0-fake)"]);
    return;
  }
  process.stdout.write("RECEIVED: " + chunk.replace(/[\\r\\n]+/g, "") + "\\r\\n");
});
process.stdin.resume();
`;

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

describe.skipIf(!hasTmux)("codex agent type + real hub + real tmux", () => {
  let dir: string;
  let hub: Hub;
  let tmux: Tmux;
  let fakeCodex: string;

  /** agents.json of the hub's data dir — where a reopen would read the type. */
  function storedAgents(): Agent[] {
    return JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8")) as Agent[];
  }

  function storedAgent(name: string): Agent {
    const agent = storedAgents().find((a) => a.name === name);
    if (!agent) throw new Error(`agent ${name} missing from agents.json`);
    return agent;
  }

  async function launch(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${hub.url}/api/agents/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function pane(session: string): Promise<string> {
    // 80-column panes wrap long lines (the 64-hex token line does); joining
    // without separators reconstructs them (same technique as wire's tests).
    return (await tmux.capturePane(session, 200)).split("\n").join("");
  }

  /** The exact args the fake codex received (short line — never wraps). */
  async function argsLine(session: string): Promise<string> {
    const line = (await tmux.capturePane(session, 200))
      .split("\n")
      .find((l) => l.startsWith("ARGS:"));
    return (line ?? "").trim();
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-codex-int-"));
    // Fast kickoff so its delivery is observable in-test.
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ kickoffDelayMs: 100, nudgeEnterDelayMs: 50 }),
    );
    fakeCodex = path.join(dir, "fake-codex.js");
    fs.writeFileSync(fakeCodex, FAKE_CODEX, { mode: 0o755 });
    fs.chmodSync(fakeCodex, 0o755);
    tmux = createTmux();
    // NO onMessage override: the hub builds its REAL dispatcher + launcher over
    // real tmux; only the agent binary and the timing knobs are test-tuned.
    hub = await startHub({
      baseDir: dir,
      port: 0,
      quiet: true,
      launcher: {
        claudeBin: fakeCodex,
        settleMs: 600,
        readinessPollMs: 100,
        readinessTimeoutMs: 8_000,
      },
    });
  });

  afterEach(async () => {
    for (const session of await tmux.listSessions(SESSION_PREFIX)) {
      await tmux.killSession(session).catch(() => {});
    }
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeAll(async () => {
    const pidAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const raw = createTmux();
    for (const session of await raw.listSessions("sb-cx-")) {
      const match = /^sb-cx-(\d+)-/.exec(session);
      if (match && !pidAlive(Number(match[1]))) {
        await raw.killSession(session).catch(() => {});
      }
    }
  });

  afterAll(async () => {
    const raw = createTmux();
    for (const session of await raw.listSessions(SESSION_PREFIX)) {
      await raw.killSession(session).catch(() => {});
    }
  });

  it("launching with agentType codex: records the type, passes codex's argv, accepts the trust dialog and kicks off", async () => {
    const folder = path.join(dir, `${NAME_PREFIX}api`);
    fs.mkdirSync(folder);
    const name = `${NAME_PREFIX}api`;
    const session = `sb-${name}`;

    const res = await launch({
      dir: folder,
      role: "codex backend",
      continue: true,
      agentType: "codex",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; agent: Record<string, unknown> };
    expect(body.ok).toBe(true);

    // The redacted agent carries the type (the dashboard renders its chip from
    // this) and still never carries the token.
    expect(body.agent).toMatchObject({ name, agentType: "codex", cwd: folder });
    expect(body.agent).not.toHaveProperty("token");

    // THE argv assertion: `resume --last` first, bypass AFTER the subcommand.
    // A bypass placed before the subcommand parses and is silently dropped, so
    // this exact ordering is what keeps a launched codex from stalling on an
    // approval prompt forever.
    await pollUntil(async () => (await argsLine(session)).length > 0, "the fake codex argv");
    expect(await argsLine(session)).toBe(
      "ARGS: resume --last --dangerously-bypass-approvals-and-sandbox",
    );

    // The kickoff sees the trust dialog, presses Enter through the GUARDED path
    // (the fake reports pane_current_command "node", like real codex), and the
    // fake answers by redrawing with its header — which it does ONLY on that
    // Enter, so the header appearing proves the Enter really landed. (The
    // dialog itself is not asserted on screen: the kickoff accepts it ~100ms
    // in, so catching it would be a race.)
    await pollUntil(
      async () => (await pane(session)).includes(">_ OpenAI Codex"),
      "the codex trust dialog to be accepted (header appears)",
    );

    // Now ready, the kickoff injects the join instruction via nudgeSession.
    await pollUntil(
      async () => (await pane(session)).includes("RECEIVED:"),
      "the kickoff join instruction to be delivered",
    );
    const received = await pane(session);
    expect(received).toContain(`[switchboard] You are the agent '${name}'`);
    expect(received).toContain("join");

    // Persisted, so a reopen relaunches codex — not claude.
    expect(storedAgent(name).agentType).toBe("codex");
  });

  it("the persisted type survives a hub reboot (a reopen reads it from agents.json)", async () => {
    const folder = path.join(dir, `${NAME_PREFIX}svc`);
    fs.mkdirSync(folder);
    const name = `${NAME_PREFIX}svc`;

    expect((await launch({ dir: folder, agentType: "codex", continue: false })).status).toBe(201);
    expect(storedAgent(name).agentType).toBe("codex");

    // Reboot the hub against the same data dir: the snapshot replay must bring
    // the type back, otherwise the dashboard's reopen would send "claude".
    await hub.close();
    hub = await startHub({
      baseDir: dir,
      port: 0,
      quiet: true,
      launcher: { claudeBin: fakeCodex, settleMs: 600 },
    });
    const agents = (await (await fetch(`${hub.url}/api/agents`)).json()) as Array<
      Record<string, unknown>
    >;
    expect(agents.find((a) => a.name === name)).toMatchObject({ agentType: "codex" });
  });

  it("a fresh (no-continue) codex launch omits the resume subcommand entirely", async () => {
    const folder = path.join(dir, `${NAME_PREFIX}fresh`);
    fs.mkdirSync(folder);
    const session = `sb-${NAME_PREFIX}fresh`;

    expect((await launch({ dir: folder, agentType: "codex", continue: false })).status).toBe(201);
    await pollUntil(async () => (await argsLine(session)).length > 0, "the fake codex argv");
    expect(await argsLine(session)).toBe("ARGS: --dangerously-bypass-approvals-and-sandbox");
  });

  it("launching without agentType still opens claude (the default is untouched)", async () => {
    const folder = path.join(dir, `${NAME_PREFIX}dflt`);
    fs.mkdirSync(folder);
    const name = `${NAME_PREFIX}dflt`;
    const session = `sb-${name}`;

    // Same fake binary (claudeBin overrides every type), so what this proves is
    // the ARGV and the recorded type: claude's flags, not codex's.
    expect((await launch({ dir: folder, continue: true })).status).toBe(201);
    await pollUntil(async () => (await argsLine(session)).length > 0, "the fake agent argv");
    expect(await argsLine(session)).toBe("ARGS: -c --dangerously-skip-permissions");
    expect(storedAgent(name).agentType).toBe("claude");
  });

  it("an invalid agentType is REJECTED with 400, never silently defaulted", async () => {
    const folder = path.join(dir, `${NAME_PREFIX}bad`);
    fs.mkdirSync(folder);

    const res = await launch({ dir: folder, agentType: "codx" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid agent type");
    expect(body.error).toContain("claude | codex");
    // A typo must not have launched anything.
    expect(await tmux.hasSession(`sb-${NAME_PREFIX}bad`)).toBe(false);
    expect(fs.existsSync(path.join(dir, "agents.json"))).toBe(false);
  });

  it("a non-string agentType is rejected too (400, no launch)", async () => {
    const folder = path.join(dir, `${NAME_PREFIX}num`);
    fs.mkdirSync(folder);

    const res = await launch({ dir: folder, agentType: 7 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid agent type");
  });
});
