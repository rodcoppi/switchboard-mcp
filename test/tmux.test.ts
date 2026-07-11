// Unit tests for the tmux wrapper (PRD 10.3) with a mocked ExecFn (DI):
// - exact targets per command class: "=NAME" for has-session/kill-session,
//   "=NAME:" for send-keys/capture-pane/list-panes (spikes/NOTES.md, tmux 3.4);
// - send-keys always with -l and -- (P9/P5);
// - pane guard is an ALLOW-LIST (PRD 10.3, default-deny): only
//   node/claude/claude-code/cat are safe; shells, REPLs, ssh, anything else
//   and error/empty are all unsafe (fail-closed);
// - TOCTOU: the guard re-runs before the separate Enter and suppresses it
//   when the pane became unsafe during the delay;
// - newline sanitization (nudgeSession flattens; sendKeysLiteral throws).

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createTmux,
  defaultExec,
  isSafePaneCommand,
  type ExecFn,
  type ExecResult,
} from "../src/server/tmux.js";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

interface RecordedCall {
  file: string;
  args: string[];
}

/**
 * ExecFn mock: records every call and answers via the handler (return string
 * = stdout; throw = non-zero exit, like promisified execFile).
 */
function fakeExec(
  handler: (args: string[]) => string | Promise<string> = () => "",
): { exec: ExecFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: ExecFn = async (file, args): Promise<ExecResult> => {
    calls.push({ file, args });
    const stdout = await handler(args);
    return { stdout, stderr: "" };
  };
  return { exec, calls };
}

describe("exact targets per command (critical finding from NOTES.md, tmux 3.4)", () => {
  it('has-session uses -t "=NAME" (no colon)', async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    expect(await tmux.hasSession("sb-alpha")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("tmux");
    expect(calls[0].args).toEqual(["has-session", "-t", "=sb-alpha"]);
  });

  it("hasSession returns false when exec fails (exit != 0), without throwing", async () => {
    const { exec, calls } = fakeExec(() => {
      throw new Error("can't find session: =sb-alpha");
    });
    const tmux = createTmux({ exec });
    expect(await tmux.hasSession("sb-alpha")).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('kill-session uses -t "=NAME" (no colon)', async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    await tmux.killSession("sb-alpha");
    expect(calls[0].args).toEqual(["kill-session", "-t", "=sb-alpha"]);
  });

  it('list-panes (paneCommand) uses -t "=NAME:" (with colon)', async () => {
    const { exec, calls } = fakeExec(() => "claude\n");
    const tmux = createTmux({ exec });
    expect(await tmux.paneCommand("sb-alpha")).toBe("claude");
    expect(calls[0].args).toEqual([
      "list-panes",
      "-t",
      "=sb-alpha:",
      "-F",
      "#{pane_current_command}",
    ]);
  });

  it('send-keys literal uses -t "=NAME:" with -l and -- before the text (P9/P5)', async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    await tmux.sendKeysLiteral("sb-alpha", "-starts with a hyphen");
    expect(calls[0].args).toEqual([
      "send-keys",
      "-t",
      "=sb-alpha:",
      "-l",
      "--",
      "-starts with a hyphen",
    ]);
  });

  it('sendEnter uses -t "=NAME:" and the Enter key, WITHOUT -l', async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    await tmux.sendEnter("sb-alpha");
    expect(calls[0].args).toEqual(["send-keys", "-t", "=sb-alpha:", "Enter"]);
    expect(calls[0].args).not.toContain("-l");
  });

  it('capture-pane uses -t "=NAME:" with -p -S -<lines>', async () => {
    const { exec, calls } = fakeExec(() => "pane content\n");
    const tmux = createTmux({ exec });
    expect(await tmux.capturePane("sb-alpha", 60)).toBe("pane content\n");
    expect(calls[0].args).toEqual(["capture-pane", "-t", "=sb-alpha:", "-p", "-S", "-60"]);

    // default line count
    await tmux.capturePane("sb-alpha");
    expect(calls[1].args).toEqual(["capture-pane", "-t", "=sb-alpha:", "-p", "-S", "-200"]);
  });

  it("new-session uses -d -s <name> -c <cwd> [<cmd>]", async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    // newSession also runs two best-effort set-option calls (pass the pane
    // title through to the outer terminal) — assert on the new-session calls.
    await tmux.newSession("sb-alpha", "/tmp/repo-a", "claude");
    const newSessions = () => calls.filter((c) => c.args[0] === "new-session");
    expect(newSessions()[0].args).toEqual([
      "new-session",
      "-d",
      "-s",
      "sb-alpha",
      "-c",
      "/tmp/repo-a",
      "claude",
    ]);
    // The title pass-through is applied to the freshly created session.
    // set-option's -t takes the PLAIN name (it rejects the "=NAME" prefix).
    const titleCalls = calls.filter((c) => c.args[0] === "set-option");
    expect(titleCalls).toHaveLength(2);
    expect(titleCalls[0].args).toEqual(["set-option", "-t", "sb-alpha", "set-titles", "on"]);
    expect(titleCalls[1].args).toEqual(["set-option", "-t", "sb-alpha", "set-titles-string", "#T"]);

    await tmux.newSession("sb-beta", "/tmp/repo-b");
    expect(newSessions()[1].args).toEqual(["new-session", "-d", "-s", "sb-beta", "-c", "/tmp/repo-b"]);
  });

  it("listSessions filters by prefix and returns [] when the tmux server is dead", async () => {
    const { exec } = fakeExec(() => "sb-alpha\nsb-beta\nother\n");
    const tmux = createTmux({ exec });
    expect(await tmux.listSessions("sb-")).toEqual(["sb-alpha", "sb-beta"]);

    const dead = createTmux({
      exec: fakeExec(() => {
        throw new Error("no server running");
      }).exec,
    });
    expect(await dead.listSessions("sb-")).toEqual([]);
  });

  it('an invalid session name (empty, ":" or space) is rejected before touching tmux', async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    for (const bad of ["", "a:b", "a b", "a\nb"]) {
      await expect(tmux.hasSession(bad)).rejects.toThrow(/Invalid tmux session name/);
      await expect(tmux.sendKeysLiteral(bad, "x")).rejects.toThrow(/Invalid tmux session name/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("pane guard (PRD 10.3/P2, non-negotiable) — ALLOW-LIST, FAIL-CLOSED", () => {
  it.each(["bash", "zsh", "sh", "dash", "fish", "ksh", "csh", "tcsh", "busybox"])(
    'a pane running the shell "%s" is UNSAFE',
    async (shell) => {
      const { exec } = fakeExec(() => `${shell}\n`);
      const tmux = createTmux({ exec });
      expect(await tmux.isPaneSafeToNudge("sb-alpha")).toBe(false);
    },
  );

  it.each([
    // modern shells the old deny-list did not cover
    "pwsh",
    "powershell",
    "nu",
    "nushell",
    "xonsh",
    "elvish",
    // REPLs/remotes: would interpret or forward the typed text
    "python3",
    "ipython",
    "perl",
    "ruby",
    "psql",
    "mysql",
    "sqlite3",
    "ssh",
    "nc",
    "socat",
    "telnet",
    // anything outside the allow-list is unsafe (default-deny)
    "vim",
    "htop",
  ])('a pane running "%s" (outside the allow-list) is UNSAFE — default-deny', async (cmd) => {
    const { exec } = fakeExec(() => `${cmd}\n`);
    const tmux = createTmux({ exec });
    expect(await tmux.isPaneSafeToNudge("sb-alpha")).toBe(false);
  });

  it.each(["claude", "node", "claude-code", "cat"])(
    'a pane running "%s" (allow-list) is safe',
    async (cmd) => {
      const { exec } = fakeExec(() => `${cmd}\n`);
      const tmux = createTmux({ exec });
      expect(await tmux.isPaneSafeToNudge("sb-alpha")).toBe(true);
    },
  );

  it("empty pane_current_command → unsafe (fail-closed)", async () => {
    const { exec } = fakeExec(() => "");
    const tmux = createTmux({ exec });
    expect(await tmux.isPaneSafeToNudge("sb-alpha")).toBe(false);
  });

  it("error reading the pane (dead session) → unsafe (fail-closed), without throwing", async () => {
    const { exec } = fakeExec(() => {
      throw new Error("can't find pane: =sb-alpha:");
    });
    const tmux = createTmux({ exec });
    expect(await tmux.isPaneSafeToNudge("sb-alpha")).toBe(false);
  });

  it("multiple panes: ANY pane in a shell makes the session unsafe", async () => {
    const { exec } = fakeExec(() => "claude\nbash\n");
    const tmux = createTmux({ exec });
    expect(await tmux.isPaneSafeToNudge("sb-alpha")).toBe(false);
  });

  it("defensive normalization: full path, uppercase and login shell (-bash)", () => {
    expect(isSafePaneCommand("/usr/bin/bash")).toBe(false);
    expect(isSafePaneCommand("BASH")).toBe(false);
    expect(isSafePaneCommand("-bash")).toBe(false);
    expect(isSafePaneCommand("/usr/bin/python3")).toBe(false);
    expect(isSafePaneCommand("/usr/local/bin/claude")).toBe(true);
    expect(isSafePaneCommand("CLAUDE")).toBe(true);
    // cat is safe (does not interpret text as a command) — the Phase 3 Done
    // When requires a `cat` session to receive a nudge (PRD section 16).
    expect(isSafePaneCommand("cat")).toBe(true);
  });
});

describe("nudgeSession (high-level nudge: guard + text + separate Enter)", () => {
  it("safe pane: sends literal text, waits the delay and sends Enter in a SEPARATE command", async () => {
    const timeline: string[] = [];
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === "list-panes") return "claude\n";
      timeline.push(args.join(" "));
      return "";
    });
    let slept = -1;
    const tmux = createTmux({
      exec,
      sleep: async (ms) => {
        slept = ms;
        timeline.push(`sleep ${ms}`);
      },
    });

    const result = await tmux.nudgeSession("sb-alpha", "[switchboard] hi", 500);
    expect(result).toEqual({ sent: true });
    expect(slept).toBe(500);

    // Order: guard (list-panes) → literal text → delay → RE-guard
    // (TOCTOU) → Enter (separate).
    expect(calls.map((c) => c.args[0])).toEqual([
      "list-panes",
      "send-keys",
      "list-panes",
      "send-keys",
    ]);
    expect(timeline).toEqual([
      "send-keys -t =sb-alpha: -l -- [switchboard] hi",
      "sleep 500",
      "send-keys -t =sb-alpha: Enter",
    ]);
  });

  it("TOCTOU: pane becomes unsafe DURING the delay → Enter is SUPPRESSED (re-guard before Enter)", async () => {
    // 1st list-panes (guard): claude. 2nd (re-guard post-delay): bash — claude
    // died along the way and the pane dropped into a shell (P2).
    let paneReads = 0;
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === "list-panes") {
        paneReads += 1;
        return paneReads === 1 ? "claude\n" : "bash\n";
      }
      return "";
    });
    const tmux = createTmux({ exec, sleep: async () => {} });

    const result = await tmux.nudgeSession("sb-alpha", "[switchboard] hi", 500);
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("Enter suppressed");

    // The text was typed (it stays inert at the prompt), but NO Enter was
    // sent — nothing is submitted in an unsafe pane.
    const sendKeys = calls.filter((c) => c.args[0] === "send-keys");
    expect(sendKeys).toHaveLength(1);
    expect(sendKeys[0].args).toContain("-l");
    expect(sendKeys[0].args).not.toContain("Enter");
    expect(paneReads).toBe(2);
  });

  it("unsafe pane (shell): sends NO send-keys and reports the reason", async () => {
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === "list-panes") return "bash\n";
      return "";
    });
    const tmux = createTmux({ exec, sleep: async () => {} });

    const result = await tmux.nudgeSession("sb-alpha", "[switchboard] hi", 500);
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("bash");
    expect(calls.filter((c) => c.args[0] === "send-keys")).toHaveLength(0);
  });

  it("unreadable pane (dead session): fail-closed, no send-keys", async () => {
    const { exec, calls } = fakeExec(() => {
      throw new Error("can't find pane");
    });
    const tmux = createTmux({ exec, sleep: async () => {} });

    const result = await tmux.nudgeSession("sb-alpha", "hi", 0);
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("fail-closed");
    expect(calls.filter((c) => c.args[0] === "send-keys")).toHaveLength(0);
  });

  it("flattens \\r/\\n of the text before typing (a nudge is ALWAYS one line — P5)", async () => {
    const { exec, calls } = fakeExec((args) =>
      args[0] === "list-panes" ? "claude\n" : "",
    );
    const tmux = createTmux({ exec, sleep: async () => {} });

    await tmux.nudgeSession("sb-alpha", "line1\nline2\r\nline3", 0);
    const literal = calls.find((c) => c.args.includes("-l"))!;
    expect(literal.args[literal.args.length - 1]).toBe("line1 line2 line3");
  });

  it("sendKeysLiteral THROWS for text with a newline (defense in depth)", async () => {
    const { exec, calls } = fakeExec();
    const tmux = createTmux({ exec });
    await expect(tmux.sendKeysLiteral("sb-alpha", "a\nb")).rejects.toThrow(/single line/);
    await expect(tmux.sendKeysLiteral("sb-alpha", "a\rb")).rejects.toThrow(/single line/);
    expect(calls).toHaveLength(0); // nothing reached tmux
  });
});

// ---------------------------------------------------------------------------
// defaultExec (REAL tmux): the failure NEVER echoes the argv in the
// message/stack — the raw "Command failed: …" from promisified execFile would
// carry the whole command line, and in start's new-session it contains the
// SWITCHBOARD_AGENT_TOKEN (v1.1 invariant: the token is never printed/logged).
// ---------------------------------------------------------------------------

describe.skipIf(!hasTmux)("defaultExec: sanitized error (real tmux)", () => {
  it("a tmux command error does not contain the arguments (a token in the argv would never leak)", async () => {
    const secretArg = "SECRET_ARGV_deadbeef1234";
    const err = await defaultExec("tmux", [
      "send-keys",
      "-t",
      "=nonexistent-session-sanitization:",
      "-l",
      "--",
      secretArg,
    ]).then(
      () => undefined,
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(secretArg);
    expect(String(err!.stack ?? "")).not.toContain(secretArg);
    // Still diagnosable: subcommand + tmux's own stderr.
    expect(err!.message).toMatch(/^tmux send-keys failed: /);
  });
});
