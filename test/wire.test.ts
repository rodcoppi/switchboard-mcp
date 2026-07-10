// Unit tests of the `switchboard wire` helpers (pure/injectable only — no hub,
// no real tmux, no ports; the real-world paths live in
// test/wire.integration.test.ts):
//   - deriveAgentName: basename derivation + sanitization + the invalid→error
//     case (folder that cannot yield a valid name asks for --name);
//   - buildWireClaudeArgs: the -c + --dangerously-skip-permissions default,
//     no duplication when the user already passed them, extra args preserved,
//     and fail-fast on bad quoting;
//   - runWire local validations (no hub): the derived/explicit name and dir
//     reach the shared core, which rejects a nonexistent dir before any HTTP.

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  buildWireClaudeArgs,
  deriveAgentName,
  runWire,
  WIRE_BYPASS_FLAG,
  WIRE_CONTINUE_FLAG,
} from "../src/cli/wire.js";
import { buildAgentCommand } from "../src/cli/start.js";
import { CliError, checkHubHealth, ensureHubUp } from "../src/cli/common.js";
import { AGENT_NAME_RE } from "../src/server/store.js";

// ---------------------------------------------------------------------------
// deriveAgentName — default name = sanitized basename of the folder.
// ---------------------------------------------------------------------------

describe("deriveAgentName", () => {
  it("uses the folder basename verbatim when it is already valid", () => {
    expect(deriveAgentName("/home/rod/projects/api")).toBe("api");
    expect(deriveAgentName("/home/rod/projects/payments-backend")).toBe("payments-backend");
  });

  it("lowercases and replaces invalid characters with hyphens", () => {
    expect(deriveAgentName("/x/My Project")).toBe("my-project");
    expect(deriveAgentName("/x/api_backend")).toBe("api-backend");
    expect(deriveAgentName("/x/2024.01")).toBe("2024-01");
    expect(deriveAgentName("/x/Foo@Bar!!Baz")).toBe("foo-bar-baz");
  });

  it("collapses repeated hyphens and trims leading/trailing junk", () => {
    expect(deriveAgentName("/x/--hidden--")).toBe("hidden");
    expect(deriveAgentName("/x/  spaced  ")).toBe("spaced");
    expect(deriveAgentName("/x/a___b")).toBe("a-b");
  });

  it("every derived name matches the store's AGENT_NAME_RE", () => {
    for (const folder of ["api", "My Project", "2024.01", "payments-backend", "a1"]) {
      expect(AGENT_NAME_RE.test(deriveAgentName(`/x/${folder}`))).toBe(true);
    }
  });

  it("caps overly long folder names at 31 chars without a trailing hyphen", () => {
    const name = deriveAgentName("/x/" + "a".repeat(50));
    expect(name).toBe("a".repeat(31));
    expect(AGENT_NAME_RE.test(name)).toBe(true);
  });

  it("a folder that cannot yield a valid name → clear CliError asking for --name", () => {
    // All-punctuation collapses to "" and a single char is too short (min 2).
    for (const folder of ["...", "@@@", "x"]) {
      expect(() => deriveAgentName(`/x/${folder}`)).toThrow(CliError);
      expect(() => deriveAgentName(`/x/${folder}`)).toThrow(/--name/);
    }
  });
});

// ---------------------------------------------------------------------------
// buildWireClaudeArgs — -c + bypass by default, no duplication, quoting.
// ---------------------------------------------------------------------------

describe("buildWireClaudeArgs", () => {
  it("no extra args → exactly [-c, --dangerously-skip-permissions]", () => {
    expect(buildWireClaudeArgs(undefined)).toEqual([WIRE_CONTINUE_FLAG, WIRE_BYPASS_FLAG]);
    expect(buildWireClaudeArgs("")).toEqual([WIRE_CONTINUE_FLAG, WIRE_BYPASS_FLAG]);
  });

  it("prepends the two defaults before the user's extra args (argv semantics)", () => {
    expect(buildWireClaudeArgs("--model opus")).toEqual([
      WIRE_CONTINUE_FLAG,
      WIRE_BYPASS_FLAG,
      "--model",
      "opus",
    ]);
    expect(buildWireClaudeArgs("--append-system-prompt 'a b'")).toEqual([
      WIRE_CONTINUE_FLAG,
      WIRE_BYPASS_FLAG,
      "--append-system-prompt",
      "a b",
    ]);
  });

  it("does NOT duplicate -c when the user already passed it (nor its --continue alias)", () => {
    expect(buildWireClaudeArgs("-c")).toEqual([WIRE_BYPASS_FLAG, "-c"]);
    expect(buildWireClaudeArgs("--continue --model opus")).toEqual([
      WIRE_BYPASS_FLAG,
      "--continue",
      "--model",
      "opus",
    ]);
  });

  it("does NOT duplicate --dangerously-skip-permissions when the user already passed it", () => {
    expect(buildWireClaudeArgs("--dangerously-skip-permissions")).toEqual([
      WIRE_CONTINUE_FLAG,
      WIRE_BYPASS_FLAG,
    ]);
  });

  it("does NOT force -c when the user resumes a specific session (-r/--resume conflicts with -c)", () => {
    // bypass still prepended; -c suppressed so claude does not see two
    // conflicting conversation selectors.
    expect(buildWireClaudeArgs("-r abc123")).toEqual([WIRE_BYPASS_FLAG, "-r", "abc123"]);
    expect(buildWireClaudeArgs("--resume abc123")).toEqual([
      WIRE_BYPASS_FLAG,
      "--resume",
      "abc123",
    ]);
  });

  it("does NOT force --dangerously-skip-permissions when the user sets --permission-mode (any value)", () => {
    // -c still prepended; bypass suppressed so claude does not reject the
    // --permission-mode + --dangerously-skip-permissions mix.
    expect(buildWireClaudeArgs("--permission-mode bypassPermissions")).toEqual([
      WIRE_CONTINUE_FLAG,
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(buildWireClaudeArgs("--permission-mode plan")).toEqual([
      WIRE_CONTINUE_FLAG,
      "--permission-mode",
      "plan",
    ]);
  });

  it("does not add either default when the user passed both", () => {
    expect(buildWireClaudeArgs("-c --dangerously-skip-permissions --model opus")).toEqual([
      "-c",
      "--dangerously-skip-permissions",
      "--model",
      "opus",
    ]);
  });

  it("bad --claude-args quoting throws a CliError (fail-fast, before any HTTP)", () => {
    expect(() => buildWireClaudeArgs("--model 'open")).toThrow(CliError);
    expect(() => buildWireClaudeArgs("--model 'open")).toThrow(/unterminated/);
  });
});

// ---------------------------------------------------------------------------
// buildWireClaudeArgs + buildAgentCommand — the argv the session runs (no token
// leak; -c + bypass land right after the claude binary).
// ---------------------------------------------------------------------------

describe("wire argv assembly (buildWireClaudeArgs + buildAgentCommand)", () => {
  it("puts env NAME/TOKEN, the binary, then -c + bypass, then extra args in order", () => {
    const cmd = buildAgentCommand({
      name: "api",
      token: "tok123",
      claudeArgs: buildWireClaudeArgs("--model opus"),
      claudeBin: "claude",
    });
    expect(cmd).toEqual([
      "env",
      "SWITCHBOARD_AGENT_NAME=api",
      "SWITCHBOARD_AGENT_TOKEN=tok123",
      "claude",
      "-c",
      "--dangerously-skip-permissions",
      "--model",
      "opus",
    ]);
  });
});

// ---------------------------------------------------------------------------
// runWire — local validations (no hub): reaches the shared core with the right
// name/dir and fails fast (no HTTP) on the pure-validation errors.
// ---------------------------------------------------------------------------

// baseDir that does not exist → loadConfig returns pure defaults, silently.
const NO_CONFIG_DIR = path.join(os.tmpdir(), "switchboard-none-wire-test");

describe("runWire: local validations", () => {
  it("explicit invalid --name fails with the store's regex message, BEFORE any HTTP", async () => {
    await expect(
      runWire({ name: "Bad_Name", dir: os.tmpdir(), hubUrl: "http://127.0.0.1:9", baseDir: NO_CONFIG_DIR }),
    ).rejects.toThrow(/Invalid agent name/);
  });

  it("nonexistent --dir fails with a clear message (name derived from it first)", async () => {
    await expect(
      runWire({ name: "okname", dir: "/does/not/exist", hubUrl: "http://127.0.0.1:9", baseDir: NO_CONFIG_DIR }),
    ).rejects.toThrow(/Directory does not exist/);
  });

  it("bad --claude-args quoting fails BEFORE the hub check (no ghost registration)", async () => {
    const tmuxCalls: string[] = [];
    const tmux = {
      async hasSession(): Promise<boolean> {
        tmuxCalls.push("hasSession");
        return false;
      },
      async newSession(): Promise<void> {
        tmuxCalls.push("newSession");
      },
      async killSession(): Promise<void> {
        tmuxCalls.push("killSession");
      },
    };
    await expect(
      runWire({
        name: "okname",
        dir: os.tmpdir(),
        // hub DEAD on purpose: if the parse were not fail-fast the observed
        // error would be the health check's, not the quote's.
        hubUrl: "http://127.0.0.1:9",
        baseDir: NO_CONFIG_DIR,
        tmux,
        claudeArgs: "--model 'open",
      }),
    ).rejects.toThrow(/unterminated/);
    expect(tmuxCalls).toEqual([]); // nothing touched: neither tmux nor HTTP
  });

  it("dead hub + fail-fast strategy → clear error telling to run switchboard serve first", async () => {
    // The DEFAULT ensureHub now AUTO-STARTS a background hub (owner decision);
    // injecting checkHubHealth keeps the old fail-fast semantics — which is
    // exactly what this test asserts (and how status/send/stop still behave).
    await expect(
      runWire({
        name: "okname",
        dir: os.tmpdir(),
        hubUrl: "http://127.0.0.1:9",
        baseDir: NO_CONFIG_DIR,
        ensureHub: (url) => checkHubHealth(url),
      }),
    ).rejects.toThrow(/Run "switchboard serve" first/);
  });

  it("dead hub + auto-start strategy that cannot boot → clear auto-start error", async () => {
    // The default path when the Hub is down: ensureHubUp boots it in the
    // background. Here the injected boot is a no-op (nothing comes up), so
    // after the (shortened) wait the user gets the actionable failure.
    const printed: string[] = [];
    await expect(
      runWire({
        name: "okname",
        dir: os.tmpdir(),
        hubUrl: "http://127.0.0.1:9",
        baseDir: NO_CONFIG_DIR,
        out: (l) => printed.push(l),
        ensureHub: (url, { out }) =>
          ensureHubUp(url, { out, bootHub: async () => {}, bootTimeoutMs: 300, sleep: async () => {} }),
      }),
    ).rejects.toThrow(/Could not auto-start the Hub/);
    expect(printed.join("\n")).toContain("starting it in the background");
  });

  it("with NO --dir and NO --name, derives the name from the ACTUAL current directory (cwd)", async () => {
    // The headline UX: run wire in the folder, no args. This exercises the
    // real wiring `options.dir ?? process.cwd()` → deriveAgentName(basename),
    // which every other test bypasses by passing an explicit dir. A folder
    // whose basename cannot yield a valid agent name ("x" is too short) proves
    // cwd reached deriveAgentName: the error names that exact basename, and it
    // is raised BEFORE any tmux/HTTP (dead hub never contacted).
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-wr-cwd-"));
    const badFolder = path.join(base, "x"); // basename "x" → too short (min 2)
    fs.mkdirSync(badFolder);
    const prevCwd = process.cwd();
    process.chdir(badFolder);
    try {
      await expect(
        runWire({ hubUrl: "http://127.0.0.1:9", baseDir: NO_CONFIG_DIR }),
      ).rejects.toThrow(/Could not derive a valid agent name from the folder "x"/);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
