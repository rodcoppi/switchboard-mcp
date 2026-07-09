// Unit tests of the Phase 4 CLI helpers (PRD section 11 + task item 8):
// argument validation, --claude-args parsing, env/claude argv assembly (token
// never leaked), EXACT one-line kickoff text, TUI readiness poll (NOTES.md:
// a blind kickoff would type into the trust dialog), status table formatting
// with fake data, relative time, shell quoting of newSession arrays, and the
// logs tail/follow helpers. Pure/injectable pieces only — no hub, no real
// tmux, no ports (the real-world paths live in test/cli.integration.test.ts).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAgentCommand,
  isTuiReady,
  kickoffText,
  parseClaudeArgs,
  runKickoffAgent,
  runStart,
  type KickoffTmux,
} from "../src/cli/start.js";
import { formatStatusTable, type StatusRow } from "../src/cli/status.js";
import { describeDelivery } from "../src/cli/send.js";
import { runLogs, tailLines } from "../src/cli/logs.js";
import { CliError, formatRelative } from "../src/cli/common.js";
import { serveHeaderLines } from "../src/cli/serve.js";
import { createTmux, quoteShellArg, type ExecFn } from "../src/server/tmux.js";
import type { Delivery } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// parseClaudeArgs — documented decision: simple quote-aware splitter, no lib.
// ---------------------------------------------------------------------------

describe("parseClaudeArgs", () => {
  it("undefined/empty → []", () => {
    expect(parseClaudeArgs(undefined)).toEqual([]);
    expect(parseClaudeArgs("")).toEqual([]);
    expect(parseClaudeArgs("   ")).toEqual([]);
  });

  it("simple whitespace split (multiple spaces collapse)", () => {
    expect(parseClaudeArgs("--model opus")).toEqual(["--model", "opus"]);
    expect(parseClaudeArgs("  --model   opus  ")).toEqual(["--model", "opus"]);
  });

  it("single quotes group a token with spaces (quotes removed)", () => {
    expect(parseClaudeArgs("--append-system-prompt 'foo bar baz'")).toEqual([
      "--append-system-prompt",
      "foo bar baz",
    ]);
  });

  it("double quotes group a token with spaces (quotes removed)", () => {
    expect(parseClaudeArgs('--append-system-prompt "foo bar"')).toEqual([
      "--append-system-prompt",
      "foo bar",
    ]);
  });

  it("quotes in the middle of the token and an empty quoted token", () => {
    expect(parseClaudeArgs("-c 'printenv; exec cat'")).toEqual([
      "-c",
      "printenv; exec cat",
    ]);
    expect(parseClaudeArgs("a''b ''")).toEqual(["ab", ""]);
  });

  it("unterminated quotes → clear CliError (never guess)", () => {
    expect(() => parseClaudeArgs("--x 'open")).toThrow(CliError);
    expect(() => parseClaudeArgs('--x "open')).toThrow(/unterminated/);
  });
});

// ---------------------------------------------------------------------------
// buildAgentCommand — PRD 11 step 4, argv as an ARRAY.
// ---------------------------------------------------------------------------

describe("buildAgentCommand", () => {
  it("assembles env NAME/TOKEN + claude (no extra args)", () => {
    expect(buildAgentCommand({ name: "alpha", token: "tok123" })).toEqual([
      "env",
      "SWITCHBOARD_AGENT_NAME=alpha",
      "SWITCHBOARD_AGENT_TOKEN=tok123",
      "claude",
    ]);
  });

  it("appends the parsed claude-args with argv semantics (quotes preserve spaces)", () => {
    expect(
      buildAgentCommand({
        name: "beta",
        token: "t",
        claudeArgs: "--model opus --append-system-prompt 'a b'",
      }),
    ).toEqual([
      "env",
      "SWITCHBOARD_AGENT_NAME=beta",
      "SWITCHBOARD_AGENT_TOKEN=t",
      "claude",
      "--model",
      "opus",
      "--append-system-prompt",
      "a b",
    ]);
  });

  it("injectable claudeBin (tests use sh/cat in place of the real claude)", () => {
    expect(buildAgentCommand({ name: "g", token: "t", claudeBin: "cat" })).toEqual([
      "env",
      "SWITCHBOARD_AGENT_NAME=g",
      "SWITCHBOARD_AGENT_TOKEN=t",
      "cat",
    ]);
  });
});

// ---------------------------------------------------------------------------
// kickoffText — EXACT text from PRD 11 step 6, one line, no token.
// ---------------------------------------------------------------------------

describe("kickoffText", () => {
  it("is EXACTLY the text from PRD 11 step 6", () => {
    expect(kickoffText("alpha")).toBe(
      `[switchboard] You are the agent 'alpha' on this local agent network. ` +
        `Confirm by calling the join tool with agent_name="alpha". ` +
        `Then continue your work normally; when you receive [switchboard] notifications, use check_messages.`,
    );
  });

  it("is always ONE line (P5)", () => {
    expect(kickoffText("beta")).not.toMatch(/[\r\n]/);
  });

  it("NEVER contains the token (the agent reads it from the env)", () => {
    expect(kickoffText("gamma")).not.toMatch(/TOKEN/i);
  });
});

// ---------------------------------------------------------------------------
// isTuiReady — readiness markers from NOTES.md (spike 0.3).
// ---------------------------------------------------------------------------

const TRUST_DIALOG_PANE = [
  "Quick safety check: Is this a project you created or one you trust?",
  "❯ 1. Yes, I trust this folder",
  "  2. No, exit",
].join("\n");

const READY_PANE = ["╭──────╮", "│ > ", "╰──────╯", "  ? for shortcuts"].join("\n");

describe("isTuiReady", () => {
  it("recognizes the '? for shortcuts' marker", () => {
    expect(isTuiReady("bla\n? for shortcuts\n")).toBe(true);
  });

  it("recognizes the input box marker '│ >'", () => {
    expect(isTuiReady("╭──╮\n│ > \n╰──╯")).toBe(true);
  });

  it("recognizes the bypass permissions mode footer (replaces '? for shortcuts')", () => {
    // Observed with claude 2.1.205 + --permission-mode bypassPermissions: the
    // footer loses "? for shortcuts". Without this marker the kickoff of an
    // agent in bypass (which section 9.5 says is "covered") would time out.
    const bypassFooter = [
      "❯ ",
      "────────",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    ].join("\n");
    expect(isTuiReady(bypassFooter)).toBe(true);
  });

  it("recognizes other permission-mode footers (accept edits / plan mode)", () => {
    expect(isTuiReady("❯ \n  accept edits on (shift+tab to cycle)")).toBe(true);
    expect(isTuiReady("❯ \n  plan mode on (shift+tab to cycle)")).toBe(true);
  });

  it("trust dialog (claude 2.1.205) is NOT ready — digits select options", () => {
    expect(isTuiReady(TRUST_DIALOG_PANE)).toBe(false);
  });

  it("empty/unreadable pane is not ready (fail-closed)", () => {
    expect(isTuiReady("")).toBe(false);
    expect(isTuiReady("$ ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runKickoffAgent — initial delay + readiness poll + guarded nudge.
// ---------------------------------------------------------------------------

interface FakeKickoffWorld {
  tmux: KickoffTmux;
  calls: string[]; // ordered method log
  nudges: Array<{ session: string; text: string; enterDelayMs: number }>;
  sleeps: number[];
  now(): number;
  sleep(ms: number): Promise<void>;
}

function makeKickoffWorld(input: {
  panes: string[]; // consumed one per capturePane; last repeats
  hasSession?: boolean;
  nudgeResult?: { sent: boolean; reason?: string };
}): FakeKickoffWorld {
  let t = 0;
  const panes = [...input.panes];
  const world: FakeKickoffWorld = {
    calls: [],
    nudges: [],
    sleeps: [],
    now: () => t,
    sleep: async (ms: number) => {
      world.sleeps.push(ms);
      t += ms;
    },
    tmux: {
      async hasSession() {
        world.calls.push("hasSession");
        return input.hasSession ?? true;
      },
      async capturePane() {
        world.calls.push("capturePane");
        return panes.length > 1 ? panes.shift()! : panes[0];
      },
      async nudgeSession(session, text, enterDelayMs) {
        world.calls.push("nudgeSession");
        world.nudges.push({ session, text, enterDelayMs });
        return input.nudgeResult ?? { sent: true };
      },
    },
  };
  return world;
}

// baseDir that does not exist → loadConfig returns pure defaults, silently.
const NO_CONFIG_DIR = path.join(os.tmpdir(), "switchboard-none-cli-test");

describe("runKickoffAgent", () => {
  it("waits the delay, does NOT type during the trust dialog and only nudges when the TUI is ready", async () => {
    const world = makeKickoffWorld({
      panes: [TRUST_DIALOG_PANE, TRUST_DIALOG_PANE, READY_PANE],
    });
    const result = await runKickoffAgent({
      name: "alpha",
      session: "sb-alpha",
      baseDir: NO_CONFIG_DIR,
      tmux: world.tmux,
      sleep: world.sleep,
      now: world.now,
      delayMs: 8000,
      enterDelayMs: 500,
      readinessTimeoutMs: 60_000,
      readinessPollMs: 2000,
    });

    expect(result.sent).toBe(true);
    // Initial delay BEFORE any look at the pane.
    expect(world.sleeps[0]).toBe(8000);
    // 3 captures (2 trust dialog + 1 ready), nudge ONLY after the last one.
    expect(world.calls.filter((c) => c === "capturePane")).toHaveLength(3);
    expect(world.calls.indexOf("nudgeSession")).toBeGreaterThan(
      world.calls.lastIndexOf("capturePane"),
    );
    // EXACT PRD text, via the guarded nudge path, with the Enter delay.
    expect(world.nudges).toEqual([
      { session: "sb-alpha", text: kickoffText("alpha"), enterDelayMs: 500 },
    ]);
  });

  it("TUI never becomes ready → gives up after the budget WITHOUT nudging (blind kickoff forbidden)", async () => {
    const world = makeKickoffWorld({ panes: [TRUST_DIALOG_PANE] });
    const result = await runKickoffAgent({
      name: "alpha",
      session: "sb-alpha",
      baseDir: NO_CONFIG_DIR,
      tmux: world.tmux,
      sleep: world.sleep,
      now: world.now,
      delayMs: 8000,
      readinessTimeoutMs: 10_000,
      readinessPollMs: 2000,
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/did not become ready/);
    expect(world.nudges).toHaveLength(0);
  });

  it("dead session → cancels without nudging", async () => {
    const world = makeKickoffWorld({ panes: [READY_PANE], hasSession: false });
    const result = await runKickoffAgent({
      name: "alpha",
      session: "sb-alpha",
      baseDir: NO_CONFIG_DIR,
      tmux: world.tmux,
      sleep: world.sleep,
      now: world.now,
      delayMs: 0,
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/no longer exists/);
    expect(world.nudges).toHaveLength(0);
  });

  it("pane guard abort propagates (sent:false with the reason)", async () => {
    const world = makeKickoffWorld({
      panes: [READY_PANE],
      nudgeResult: { sent: false, reason: "pane outside the allow-list" },
    });
    const result = await runKickoffAgent({
      name: "alpha",
      session: "sb-alpha",
      baseDir: NO_CONFIG_DIR,
      tmux: world.tmux,
      sleep: world.sleep,
      now: world.now,
      delayMs: 0,
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("pane outside the allow-list");
  });
});

// ---------------------------------------------------------------------------
// quoteShellArg + newSession with argv as an ARRAY (tmux.ts).
// ---------------------------------------------------------------------------

describe("quoteShellArg / newSession(array)", () => {
  it("quoteShellArg: simple stays raw; spaces and metachars are quoted; ' escaped", () => {
    expect(quoteShellArg("claude")).toBe("claude");
    expect(quoteShellArg("SWITCHBOARD_AGENT_NAME=alpha")).toBe("SWITCHBOARD_AGENT_NAME=alpha");
    expect(quoteShellArg("a b")).toBe("'a b'");
    expect(quoteShellArg("x;rm -rf /")).toBe("'x;rm -rf /'");
    expect(quoteShellArg("it's")).toBe("'it'\\''s'");
    expect(quoteShellArg("")).toBe("''");
  });

  it("newSession(array) joins the shell-quoted elements into a single shell-command", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_file, args) => {
      calls.push([...args]);
      return { stdout: "", stderr: "" };
    };
    const tmux = createTmux({ exec });
    await tmux.newSession("s1", "/tmp", [
      "env",
      "A=b c",
      "claude",
      "--append-system-prompt",
      "x y",
    ]);
    expect(calls).toEqual([
      ["new-session", "-d", "-s", "s1", "-c", "/tmp", "env 'A=b c' claude --append-system-prompt 'x y'"],
    ]);
  });

  it("newSession(string) keeps the legacy behavior (raw command)", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_file, args) => {
      calls.push([...args]);
      return { stdout: "", stderr: "" };
    };
    const tmux = createTmux({ exec });
    await tmux.newSession("s1", "/tmp", "cat");
    expect(calls).toEqual([["new-session", "-d", "-s", "s1", "-c", "/tmp", "cat"]]);
  });
});

// ---------------------------------------------------------------------------
// formatRelative — LAST SEEN like "2min ago".
// ---------------------------------------------------------------------------

describe("formatRelative", () => {
  const now = Date.parse("2026-07-08T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("invalid timestamps → —", () => {
    expect(formatRelative("never", now)).toBe("—");
    expect(formatRelative("", now)).toBe("—");
  });

  it("< 10s → now", () => {
    expect(formatRelative(ago(3_000), now)).toBe("now");
  });

  it("seconds", () => {
    expect(formatRelative(ago(45_000), now)).toBe("45s ago");
  });

  it("minutes (spec example: 2min ago)", () => {
    expect(formatRelative(ago(2 * 60_000), now)).toBe("2min ago");
  });

  it("hours", () => {
    expect(formatRelative(ago(3 * 3_600_000), now)).toBe("3h ago");
  });

  it("days", () => {
    expect(formatRelative(ago(2 * 86_400_000), now)).toBe("2d ago");
  });
});

// ---------------------------------------------------------------------------
// formatStatusTable — fake data, clean formatting.
// ---------------------------------------------------------------------------

describe("formatStatusTable", () => {
  const now = Date.parse("2026-07-08T12:00:00.000Z");
  const rows: StatusRow[] = [
    {
      name: "beta",
      role: "frontend",
      status: "offline",
      mcpConnected: false,
      unreadCount: 0,
      lastSeenAt: new Date(now - 3 * 3_600_000).toISOString(),
      tmuxSession: "sb-beta",
    },
    {
      name: "alpha",
      role: "API backend",
      status: "online",
      mcpConnected: true,
      unreadCount: 2,
      lastSeenAt: new Date(now - 2 * 60_000).toISOString(),
      tmuxSession: "sb-alpha",
    },
  ];

  it("no agents → message pointing to start", () => {
    expect(formatStatusTable([], now)).toMatch(/No registered agents/);
  });

  it("header NAME | ROLE | STATUS | MCP | UNREAD | LAST SEEN and rows sorted by name", () => {
    const lines = formatStatusTable(rows, now).split("\n");
    expect(lines[0]).toMatch(/^NAME\s+ROLE\s+STATUS\s+MCP\s+UNREAD\s+LAST SEEN$/);
    expect(lines[1]).toMatch(/^alpha\s+API backend\s+online\s+yes\s+2\s+2min ago$/);
    expect(lines[2]).toMatch(/^beta\s+frontend\s+offline\s+no\s+0\s+3h ago$/);
  });

  it("columns align (every row has cells at the same positions)", () => {
    const lines = formatStatusTable(rows, now).split("\n");
    const statusColumn = lines[0].indexOf("STATUS");
    expect(lines[1].slice(statusColumn)).toMatch(/^online/);
    expect(lines[2].slice(statusColumn)).toMatch(/^offline/);
  });

  it("empty role becomes — and a long role is truncated with …", () => {
    const longRole = "x".repeat(60);
    const table = formatStatusTable(
      [
        { ...rows[0], name: "a1", role: "" },
        { ...rows[0], name: "a2", role: longRole },
      ],
      now,
    );
    expect(table).toMatch(/a1\s+—/);
    expect(table).toContain("x".repeat(39) + "…");
    expect(table).not.toContain(longRole);
  });

  it("extra fields (e.g. a leaked token) NEVER appear — only the 6 columns are read", () => {
    const secret = "deadbeef".repeat(8);
    const dirty = [{ ...rows[0], token: secret } as unknown as StatusRow];
    expect(formatStatusTable(dirty, now)).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// describeDelivery — send prints the delivery with an explanation.
// ---------------------------------------------------------------------------

describe("describeDelivery", () => {
  it("covers the 4 Delivery values with distinct, non-empty texts", () => {
    const values: Delivery[] = ["nudged", "coalesced", "queued_offline", "queued_muted"];
    const texts = values.map(describeDelivery);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// serveHeaderLines — PRD 11: first line with dashboard + MCP + mcp add.
// ---------------------------------------------------------------------------

describe("serveHeaderLines", () => {
  it("first line carries the dashboard, MCP endpoint and the ready-to-use claude mcp add command", () => {
    const [first, second] = serveHeaderLines("http://127.0.0.1:4577");
    expect(first).toContain("http://127.0.0.1:4577/");
    expect(first).toContain("http://127.0.0.1:4577/mcp");
    expect(first).toContain(
      "claude mcp add --transport http --scope user switchboard http://127.0.0.1:4577/mcp",
    );
    expect(second).toContain("sb-hub");
  });
});

// ---------------------------------------------------------------------------
// runStart — local validations (no hub): name and directory.
// ---------------------------------------------------------------------------

describe("runStart: local validations", () => {
  it("invalid name (same regex as the store) fails BEFORE any HTTP", async () => {
    await expect(
      runStart({ name: "Bad_Name", hubUrl: "http://127.0.0.1:9" }),
    ).rejects.toThrow(/Invalid agent name/);
  });

  it("nonexistent directory fails with a clear message", async () => {
    await expect(
      runStart({ name: "okname", dir: "/does/not/exist", hubUrl: "http://127.0.0.1:9" }),
    ).rejects.toThrow(/Directory does not exist/);
  });

  it("dead hub → clear error telling to run switchboard serve first", async () => {
    await expect(
      runStart({ name: "okname", dir: os.tmpdir(), hubUrl: "http://127.0.0.1:9" }),
    ).rejects.toThrow(/Run "switchboard serve" first/);
  });

  it("invalid --claude-args fails BEFORE any HTTP/tmux (no ghost registration)", async () => {
    const tmuxCalls: string[] = [];
    const tmux = {
      async hasSession(): Promise<boolean> {
        tmuxCalls.push("hasSession");
        return false;
      },
      async newSession(): Promise<void> {
        tmuxCalls.push("newSession");
      },
    };
    await expect(
      runStart({
        name: "okname",
        dir: os.tmpdir(),
        // hub DEAD on purpose: if the parse were not fail-fast, the observed
        // error would be the health check's, not the quote's.
        hubUrl: "http://127.0.0.1:9",
        baseDir: NO_CONFIG_DIR,
        tmux,
        claudeArgs: "--model 'open",
      }),
    ).rejects.toThrow(/unterminated/);
    expect(tmuxCalls).toEqual([]); // neither tmux nor HTTP: nothing was touched
  });

  it('name "hub" is refused (sb-hub session reserved for serve) before any HTTP', async () => {
    await expect(
      runStart({ name: "hub", hubUrl: "http://127.0.0.1:9", baseDir: NO_CONFIG_DIR }),
    ).rejects.toThrow(/reserved for the Hub itself/);
  });
});

// ---------------------------------------------------------------------------
// tailLines + runLogs.
// ---------------------------------------------------------------------------

describe("tailLines", () => {
  it("last n lines (trailing newline ignored)", () => {
    expect(tailLines("a\nb\nc\nd\n", 2)).toEqual(["c", "d"]);
  });

  it("file smaller than n → everything", () => {
    expect(tailLines("a\nb\n", 100)).toEqual(["a", "b"]);
  });

  it("empty content → []", () => {
    expect(tailLines("", 10)).toEqual([]);
  });
});

describe("runLogs", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-cli-logs-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeLog(content: string): string {
    const logDir = path.join(dir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, "hub.log");
    fs.writeFileSync(file, content);
    return file;
  }

  it("missing file → clear error (has the hub run?)", async () => {
    await expect(runLogs({ baseDir: dir })).rejects.toThrow(/Log file does not exist/);
  });

  it("prints the last ~100 lines", async () => {
    writeLog(Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const out: string[] = [];
    await runLogs({ baseDir: dir, out: (l) => out.push(l) });
    expect(out).toHaveLength(100);
    expect(out[0]).toBe("line 51");
    expect(out[99]).toBe("line 150");
  });

  it("-f follows appends (only complete lines) and exits cleanly on abort", async () => {
    const file = writeLog("old\n");
    const out: string[] = [];
    const controller = new AbortController();
    const done = runLogs({
      baseDir: dir,
      follow: true,
      pollMs: 20,
      signal: controller.signal,
      out: (l) => out.push(l),
    });

    // The initial tail comes out first.
    await pollUntil(() => out.includes("old"), "initial tail");

    fs.appendFileSync(file, "new 1\nnew 2\npartial");
    await pollUntil(() => out.includes("new 2"), "complete new lines");
    expect(out).toContain("new 1");
    // A line without a trailing newline was NOT emitted yet.
    expect(out).not.toContain("partial");

    fs.appendFileSync(file, " completed\n");
    await pollUntil(() => out.includes("partial completed"), "completed line");

    controller.abort();
    await done; // resolves cleanly (same path as Ctrl-C)
  });
});

/** Polls fn until truthy or deadline (no blind sleeps). */
async function pollUntil(
  fn: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`Timeout waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
