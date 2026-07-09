// Light integration tests of `switchboard wire`: runWire against a REAL hub on
// an ephemeral port + REAL tmux, with a FAKE claude in place of the real one (a
// tiny wrapper script that prints its args + the SWITCHBOARD env and then holds
// the pane with `exec cat` — a real claude is NEVER opened here; the manual
// Done When flow belongs to the orchestrator). Skipped when tmux is absent.
//
// A wrapper script (not bare sh/cat) is the fake because wire FORCES
// `-c --dangerously-skip-permissions` as the first claude args, and `sh -c` /
// `cat -c` would choke on them; the wrapper ignores its args, which also lets
// us prove — by echoing them into the pane — that wire really passes those two
// defaults.
//
// Hygiene mirrors test/cli.integration.test.ts: fresh temp data dir per test,
// hub on port 0, agent names carry a per-pid prefix so tmux sessions are swept
// in afterEach/afterAll (+ a beforeAll sweep of orphans from SIGKILLed runs),
// and nothing asynchronous is asserted with blind sleeps (pollUntil everywhere).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startHub, type Hub } from "../src/server/hub.js";
import { createTmux, type Tmux } from "../src/server/tmux.js";
import { runWire, type WireTmux } from "../src/cli/wire.js";
import type { Agent } from "../src/shared/types.js";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const NAME_PREFIX = `wr-${process.pid}-`; // agent names → sessions sb-wr-<pid>-…
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

describe.skipIf(!hasTmux)("wire + real hub + real tmux", () => {
  let dir: string;
  let hub: Hub;
  let tmux: Tmux;
  let out: string[];
  let kickoffSpawns: string[];
  let fakeClaude: string;

  const outFn = (line: string) => out.push(line);

  /** agents.json of the hub's data dir — the only place a token legitimately rests. */
  function storedAgents(): Agent[] {
    return JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8")) as Agent[];
  }

  function storedToken(name: string): string {
    const agent = storedAgents().find((a) => a.name === name);
    if (!agent?.token) throw new Error(`token missing for ${name} in agents.json`);
    return agent.token;
  }

  /** Common runWire args: real tmux, fake claude, captured output, spied kickoff. */
  function wireArgs() {
    return {
      hubUrl: hub.url,
      baseDir: dir,
      tmux,
      out: outFn,
      isTTY: false,
      claudeBin: fakeClaude,
      spawnKickoff: (n: string) => kickoffSpawns.push(n),
    };
  }

  async function flatPane(session: string): Promise<string> {
    // 80-column panes wrap long lines (the 64-hex token line does); joining
    // without separators reconstructs them (same technique as start's tests).
    return (await tmux.capturePane(session, 200)).split("\n").join("");
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-wr-int-"));
    hub = await startHub({ baseDir: dir, port: 0, quiet: true });
    tmux = createTmux();
    out = [];
    kickoffSpawns = [];
    // Fake claude: echoes its args, prints the SWITCHBOARD env vars, then holds
    // the pane open with `exec cat` (so the session survives the settle check).
    fakeClaude = path.join(dir, "fake-claude.sh");
    fs.writeFileSync(
      fakeClaude,
      '#!/bin/sh\necho "ARGS: $@"\nprintenv | grep SWITCHBOARD\nexec cat\n',
      { mode: 0o755 },
    );
    fs.chmodSync(fakeClaude, 0o755);
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
    for (const session of await raw.listSessions("sb-wr-")) {
      const match = /^sb-wr-(\d+)-/.exec(session);
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

  it("wire: default name from the folder, registers, injects NAME/TOKEN env, forces -c + bypass, never prints the token", async () => {
    // A folder whose basename is a valid (and sweepable) agent name; wire with
    // NO --name must derive the agent name from it.
    const folder = path.join(dir, `${NAME_PREFIX}api`);
    fs.mkdirSync(folder);
    const name = `${NAME_PREFIX}api`;
    const session = `sb-${name}`;

    const result = await runWire({ ...wireArgs(), dir: folder, role: "adopted backend" });

    expect(result.tmuxSession).toBe(session);
    expect(result.cwd).toBe(folder);

    // Registered (BEFORE the TUI would open, D4) with the derived name, the
    // continued folder as cwd, and NO token on the public surface.
    const agents = (await (await fetch(`${hub.url}/api/agents`)).json()) as Array<
      Record<string, unknown>
    >;
    const registered = agents.find((a) => a.name === name);
    expect(registered).toMatchObject({
      name,
      role: "adopted backend",
      cwd: folder,
      tmuxSession: session,
    });
    expect(registered).not.toHaveProperty("token");

    // The session env carries the SAME token the register stored (v1.1) and the
    // pane shows wire forced `-c --dangerously-skip-permissions` onto claude.
    const token = storedToken(name);
    expect(token).toMatch(TOKEN_RE);
    await pollUntil(
      async () => (await flatPane(session)).includes(`SWITCHBOARD_AGENT_TOKEN=${token}`),
      "env vars visible in the pane (printenv)",
    );
    const pane = await flatPane(session);
    expect(pane).toContain(`SWITCHBOARD_AGENT_NAME=${name}`);
    expect(pane).toContain("--dangerously-skip-permissions");
    expect(pane).toMatch(/ARGS:.*-c/); // the continue flag reached claude too

    // Token never printed by the CLI; kickoff spawned (default ON); non-TTY
    // prints how to attach; the wire success line states the conversation is
    // being continued (the actual -c delivery is asserted on the pane above).
    const printed = out.join("\n");
    expect(printed).not.toContain(token);
    expect(printed).toContain(`tmux attach -t ${session}`);
    expect(printed).toContain("Kickoff scheduled");
    expect(printed).toContain("continuing this folder's conversation");
    expect(kickoffSpawns).toEqual([name]);

    // v1.1: the token is never LOGGED either — hub-side.
    expect(fs.readFileSync(path.join(dir, "logs", "hub.log"), "utf8")).not.toContain(token);
    const messagesPath = path.join(dir, "messages.jsonl");
    if (fs.existsSync(messagesPath)) {
      expect(fs.readFileSync(messagesPath, "utf8")).not.toContain(token);
    }
  }, 20_000);

  it("wire SUBSTITUTES a homonymous session: the old one dies, a fresh one exists (no confirmation)", async () => {
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

    // wire adopts the name: it must kill the old session and recreate it — with
    // NO confirmation prompt (the opposite of start's P7 refusal).
    const result = await runWire({ ...wireArgs(), name, dir, kickoff: false });
    expect(result.tmuxSession).toBe(session);

    // The replacement was announced.
    expect(out.join("\n")).toContain(`Replaced the existing tmux session "${session}"`);

    // The session still EXISTS (a fresh one) and is the NEW incarnation: it
    // shows the injected token (the plain-cat old session never could) and no
    // longer carries the old marker.
    const token = storedToken(name);
    await pollUntil(
      async () => (await flatPane(session)).includes(`SWITCHBOARD_AGENT_TOKEN=${token}`),
      "fresh session shows the injected token",
    );
    expect(await tmux.hasSession(session)).toBe(true);
    expect(await flatPane(session)).not.toContain("OLDPANE-MARKER-xyz");

    // Token never leaked to the CLI output or the hub log.
    expect(out.join("\n")).not.toContain(token);
    expect(fs.readFileSync(path.join(dir, "logs", "hub.log"), "utf8")).not.toContain(token);
  }, 20_000);

  it("wire: an explicit --name overrides the folder-derived default", async () => {
    const folder = path.join(dir, `${NAME_PREFIX}foldername`);
    fs.mkdirSync(folder);
    const name = `${NAME_PREFIX}explicit`;
    const session = `sb-${name}`;

    await runWire({ ...wireArgs(), name, dir: folder, kickoff: false });

    // Registered under the EXPLICIT name, not the folder basename.
    const agents = (await (await fetch(`${hub.url}/api/agents`)).json()) as Array<{ name: string }>;
    expect(agents.map((a) => a.name)).toContain(name);
    expect(agents.map((a) => a.name)).not.toContain(`${NAME_PREFIX}foldername`);
    expect(await tmux.hasSession(session)).toBe(true);
  }, 20_000);

  it("wire with NO --dir/--name derives both from the ACTUAL current directory", async () => {
    // The headline UX end-to-end against a live hub: chdir into the folder and
    // run wire with no args. Exercises the `options.dir ?? process.cwd()`
    // fallback plus derive-name-from-actual-cwd — the path every OTHER test
    // bypasses by passing an explicit dir.
    const folder = path.join(dir, `${NAME_PREFIX}cwd`);
    fs.mkdirSync(folder);
    const name = `${NAME_PREFIX}cwd`;
    const session = `sb-${name}`;
    const prevCwd = process.cwd();
    process.chdir(folder);
    try {
      const result = await runWire({ ...wireArgs(), kickoff: false });
      expect(result.tmuxSession).toBe(session);
      const agents = (await (await fetch(`${hub.url}/api/agents`)).json()) as Array<{
        name: string;
      }>;
      expect(agents.map((a) => a.name)).toContain(name);
      expect(await tmux.hasSession(session)).toBe(true);
    } finally {
      process.chdir(prevCwd);
    }
  }, 20_000);

  it("wire: session that dies during resume (claude -c fails ~1-2s in) is caught with a clear wire error", async () => {
    // The robustness gap this guards: `claude -c` does NOT fail instantly — it
    // launches, tries to resume, and only then may exit (e.g. a -p-mode
    // conversation makes interactive -c abort). start's 400ms settle would miss
    // that and print a false "wired" success over a dead session; WIRE_SETTLE_MS
    // waits long enough. Fake claude here prints + EXITS (no `exec cat`), so the
    // session dies shortly after opening — the settle re-check must catch it.
    const dyingClaude = path.join(dir, "dying-claude.sh");
    fs.writeFileSync(dyingClaude, '#!/bin/sh\necho "resume failed"\nexit 1\n', { mode: 0o755 });
    fs.chmodSync(dyingClaude, 0o755);
    const name = `${NAME_PREFIX}dead`;
    const session = `sb-${name}`;

    await expect(
      runWire({
        ...wireArgs(),
        name,
        dir,
        kickoff: false,
        claudeBin: dyingClaude,
        settleMs: 900, // > the script's exit; the real default is WIRE_SETTLE_MS
      }),
    ).rejects.toThrow(/died right after opening|could not\s+resume/i);

    // The clear error names the resume cause and points to `start` for a fresh
    // session, and no orphan session is left behind.
    expect(await tmux.hasSession(session)).toBe(false);
  }, 20_000);

  it("wire SUBSTITUTES a session that appears DURING registration (post-register TOCTOU race)", async () => {
    // The concurrent-appearance branch of the substitution: the session does
    // NOT exist at the pre-register probe but materializes during the register
    // HTTP round-trip. It must be killed exactly ONCE, AFTER the register (so a
    // failed register never destroys a running session), and the message must
    // name the post-register cause. A hand-built WireTmux drives the sequencing
    // deterministically (real tmux cannot); the hub is real, so register runs.
    const name = `${NAME_PREFIX}race`;
    const session = `sb-${name}`;
    const killed: string[] = [];
    const created: string[] = [];
    let hasCalls = 0;
    const racingTmux: WireTmux = {
      async hasSession() {
        hasCalls += 1;
        // 1st call = pre-register probe: absent (so NOT preexisting).
        // 2nd call = post-register TOCTOU: a concurrent run raced it in.
        // 3rd+ (settle re-check): the freshly created session is alive.
        return hasCalls >= 2;
      },
      async newSession(s) {
        created.push(s);
      },
      async killSession(s) {
        killed.push(s);
      },
    };

    const result = await runWire({
      hubUrl: hub.url,
      baseDir: dir,
      tmux: racingTmux,
      out: outFn,
      isTTY: false,
      claudeBin: fakeClaude,
      spawnKickoff: (n: string) => kickoffSpawns.push(n),
      name,
      kickoff: false,
    });

    expect(result.tmuxSession).toBe(session);
    expect(killed).toEqual([session]); // killed exactly once…
    expect(created).toEqual([session]); // …and recreated
    expect(out.join("\n")).toContain("appeared during registration");

    // Register really happened (agent in the hub) and no token leaked to output.
    const agents = (await (await fetch(`${hub.url}/api/agents`)).json()) as Array<{ name: string }>;
    expect(agents.map((a) => a.name)).toContain(name);
    expect(out.join("\n")).not.toContain(storedToken(name));
  }, 20_000);
});
