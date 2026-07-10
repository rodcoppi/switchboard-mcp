// Integration tests of the server-side agent launcher (POST /api/agents/launch
// → src/server/launcher.ts): a REAL hub on an ephemeral port with its REAL
// dispatcher + launcher, REAL tmux, and a FAKE claude wrapper script in place
// of the real binary (echoes its args, prints the SWITCHBOARD env, prints a
// TUI-readiness marker and holds the pane with `exec cat`) — a real claude is
// NEVER opened here. Skipped when tmux is absent.
//
// The wrapper is what lets us PROVE, by reading the pane, that the launcher
// really passes `--dangerously-skip-permissions` (always) and `-c` (only when
// continue=true), injects SWITCHBOARD_AGENT_NAME/TOKEN into the session env,
// and delivers the in-process kickoff through the guarded nudge path. The
// fallback test uses a wrapper that dies ONLY when called with -c, proving the
// retry really drops the flag.
//
// Hygiene mirrors test/wire.integration.test.ts: fresh temp data dir per test,
// hub on port 0, agent names carry a per-pid prefix so tmux sessions are swept
// in afterEach/afterAll (+ a beforeAll sweep of orphans from SIGKILLed runs),
// and nothing asynchronous is asserted with blind sleeps (pollUntil).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startHub, type Hub } from "../src/server/hub.js";
import { createTmux, type Tmux } from "../src/server/tmux.js";
import type { Agent } from "../src/shared/types.js";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const NAME_PREFIX = `ln-${process.pid}-`; // agent names → sessions sb-ln-<pid>-…
const SESSION_PREFIX = `sb-${NAME_PREFIX}`;
const TOKEN_RE = /^[0-9a-f]{64}$/;

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

describe.skipIf(!hasTmux)("dashboard launch + real hub + real tmux", () => {
  let dir: string;
  let hub: Hub;
  let tmux: Tmux;
  let fakeClaude: string;

  /** agents.json of the hub's data dir — the only place a token legitimately rests. */
  function storedAgents(): Agent[] {
    return JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8")) as Agent[];
  }

  function storedToken(name: string): string {
    const agent = storedAgents().find((a) => a.name === name);
    if (!agent?.token) throw new Error(`token missing for ${name} in agents.json`);
    return agent.token;
  }

  function hubLog(): string {
    return fs.readFileSync(path.join(dir, "logs", "hub.log"), "utf8");
  }

  async function launch(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${hub.url}/api/agents/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function flatPane(session: string): Promise<string> {
    // 80-column panes wrap long lines (the 64-hex token line does); joining
    // without separators reconstructs them (same technique as wire's tests).
    return (await tmux.capturePane(session, 200)).split("\n").join("");
  }

  /** The exact args the fake claude received (short line — never wraps). */
  async function argsLine(session: string): Promise<string> {
    const line = (await tmux.capturePane(session, 200))
      .split("\n")
      .find((l) => l.startsWith("ARGS:"));
    return (line ?? "").trim();
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-ln-int-"));
    // Injected config: fast kickoff so its delivery is observable in-test.
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ kickoffDelayMs: 100, nudgeEnterDelayMs: 50 }),
    );
    // Fake claude: echoes its args, prints the SWITCHBOARD env vars, prints a
    // TUI-readiness marker (so the launcher's kickoff poll fires) and holds
    // the pane open with `exec cat` (cat is on the pane-guard allow-list).
    fakeClaude = path.join(dir, "fake-claude.sh");
    fs.writeFileSync(
      fakeClaude,
      '#!/bin/sh\necho "ARGS: $@"\nprintenv | grep SWITCHBOARD\necho "? for shortcuts"\nexec cat\n',
      { mode: 0o755 },
    );
    fs.chmodSync(fakeClaude, 0o755);
    tmux = createTmux();
    // NO onMessage override: the hub builds its REAL dispatcher + launcher
    // (both over real tmux); only the claude binary and the timing knobs are
    // test-tuned.
    hub = await startHub({
      baseDir: dir,
      port: 0,
      quiet: true,
      launcher: {
        claudeBin: fakeClaude,
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
    for (const session of await raw.listSessions("sb-ln-")) {
      const match = /^sb-ln-(\d+)-/.exec(session);
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

  it("launch: derives the name from the folder, registers, injects NAME/TOKEN env, forces bypass + -c, kicks off server-side, never exposes the token", async () => {
    // A folder whose basename is a valid (and sweepable) agent name; launch
    // with NO name must derive the agent name from it (wire's rule).
    const folder = path.join(dir, `${NAME_PREFIX}api`);
    fs.mkdirSync(folder);
    const name = `${NAME_PREFIX}api`;
    const session = `sb-${name}`;

    const res = await launch({ dir: folder, role: "launched backend", continue: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      agent: Record<string, unknown>;
      replaced: boolean;
      fallback: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.replaced).toBe(false);
    expect(body.fallback).toBe(false);
    // Redacted agent in the response: correct registration, NO token property.
    expect(body.agent).toMatchObject({
      name,
      role: "launched backend",
      cwd: folder,
      tmuxSession: session,
    });
    expect(body.agent).not.toHaveProperty("token");

    // The session env carries the SAME token the register stored (v1.1) and
    // the pane shows the launcher forced `-c --dangerously-skip-permissions`.
    const token = storedToken(name);
    expect(token).toMatch(TOKEN_RE);
    expect(JSON.stringify(body)).not.toContain(token);
    await pollUntil(
      async () => (await flatPane(session)).includes(`SWITCHBOARD_AGENT_TOKEN=${token}`),
      "env vars visible in the pane (printenv)",
    );
    const pane = await flatPane(session);
    expect(pane).toContain(`SWITCHBOARD_AGENT_NAME=${name}`);
    expect(await argsLine(session)).toBe("ARGS: -c --dangerously-skip-permissions");

    // Server-side kickoff: the hub itself (setTimeout in-process, guarded
    // nudge path) injects the join instruction once the "TUI" looks ready —
    // the cat pane echoes the typed kickoff line.
    await pollUntil(
      async () => (await flatPane(session)).includes(`[switchboard] You are the agent '${name}'`),
      "kickoff line injected into the pane",
      15_000,
    );

    // Public listing stays redacted; the hub log never carries the token.
    const agents = (await (await fetch(`${hub.url}/api/agents`)).json()) as Array<
      Record<string, unknown>
    >;
    const listed = agents.find((a) => a.name === name);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty("token");
    expect(hubLog()).not.toContain(token);
  }, 25_000);

  it("launch REPLACES a homonymous live session automatically (replaced:true, no confirmation)", async () => {
    const name = `${NAME_PREFIX}sub`;
    const session = `sb-${name}`;

    // Pre-existing session on the SAME name, tagged with a marker so we can
    // prove it was replaced (not reused).
    await tmux.newSession(session, dir, "cat");
    await tmux.sendKeysLiteral(session, "OLDPANE-MARKER-xyz");
    await tmux.sendEnter(session);
    await pollUntil(
      async () => (await flatPane(session)).includes("OLDPANE-MARKER-xyz"),
      "old pane shows its marker",
    );

    const res = await launch({ dir, name, continue: false });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; replaced: boolean; fallback: boolean };
    expect(body.ok).toBe(true);
    expect(body.replaced).toBe(true);
    expect(body.fallback).toBe(false);

    // The session still EXISTS (a fresh one) and is the NEW incarnation: it
    // shows the injected token (the plain-cat old session never could), no
    // longer carries the old marker, and got NO -c (continue=false).
    const token = storedToken(name);
    await pollUntil(
      async () => (await flatPane(session)).includes(`SWITCHBOARD_AGENT_TOKEN=${token}`),
      "fresh session shows the injected token",
    );
    expect(await tmux.hasSession(session)).toBe(true);
    expect(await flatPane(session)).not.toContain("OLDPANE-MARKER-xyz");
    expect(await argsLine(session)).toBe("ARGS: --dangerously-skip-permissions");
    expect(hubLog()).not.toContain(token);
  }, 20_000);

  it("continue=true over a claude that dies resuming falls back to a fresh session (fallback:true) and drops -c", async () => {
    // Wrapper that dies ONLY when called with -c: the first attempt (resume)
    // kills the session ~instantly, the settle re-check catches it, and the
    // single retry WITHOUT -c must survive — proving the retry really dropped
    // the flag (and not merely raced a slow death).
    fs.writeFileSync(
      fakeClaude,
      '#!/bin/sh\ncase " $* " in *" -c "*) echo "resume failed"; exit 1 ;; esac\n' +
        'echo "ARGS: $@"\nprintenv | grep SWITCHBOARD\necho "? for shortcuts"\nexec cat\n',
      { mode: 0o755 },
    );
    fs.chmodSync(fakeClaude, 0o755);
    const name = `${NAME_PREFIX}fb`;
    const session = `sb-${name}`;

    const res = await launch({ dir, name, continue: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; replaced: boolean; fallback: boolean };
    expect(body.ok).toBe(true);
    expect(body.fallback).toBe(true);
    expect(body.replaced).toBe(false);

    // The surviving session is the RETRY: alive, env injected, and its args
    // carry the bypass but NOT the continue flag.
    const token = storedToken(name);
    await pollUntil(
      async () => (await flatPane(session)).includes(`SWITCHBOARD_AGENT_TOKEN=${token}`),
      "fallback session shows the injected token",
    );
    expect(await tmux.hasSession(session)).toBe(true);
    expect(await argsLine(session)).toBe("ARGS: --dangerously-skip-permissions");

    // The fallback was logged (token never was).
    expect(hubLog()).toMatch(/died resuming the previous conversation/);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(hubLog()).not.toContain(token);
  }, 20_000);

  it("validation failures answer 400 with actionable errors and leave NO session/agent behind", async () => {
    // Nonexistent directory.
    let res = await launch({ dir: path.join(dir, "does-not-exist") });
    expect(res.status).toBe(400);
    let body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Directory does not exist/);

    // Relative directory (the hub cannot resolve it against the operator's shell).
    res = await launch({ dir: "relative/path" });
    expect(res.status).toBe(400);
    body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toMatch(/absolute path/);

    // Missing dir entirely.
    res = await launch({});
    expect(res.status).toBe(400);
    body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toMatch(/"dir" required/);

    // Reserved and invalid names (store rules surfaced as clear errors).
    res = await launch({ dir, name: "operator" });
    expect(res.status).toBe(400);
    body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toMatch(/Reserved name/);

    res = await launch({ dir, name: "Bad_Name" });
    expect(res.status).toBe(400);
    body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toMatch(/Invalid agent name/);

    // "hub" would produce the tmux session "sb-hub" — the launcher must refuse
    // it BEFORE the replace step could ever kill the Hub's own session.
    res = await launch({ dir, name: "hub" });
    expect(res.status).toBe(400);
    body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toMatch(/reserved for the\s+Hub/);

    // Wrong type for continue.
    res = await launch({ dir, continue: "yes" });
    expect(res.status).toBe(400);
    body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toMatch(/"continue" must be a boolean/);

    // No side effects: nothing registered, no tmux session created.
    const agents = (await (await fetch(`${hub.url}/api/agents`)).json()) as unknown[];
    expect(agents).toEqual([]);
    expect(await tmux.listSessions(SESSION_PREFIX)).toEqual([]);
  }, 20_000);
});
