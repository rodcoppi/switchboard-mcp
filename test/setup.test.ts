// Unit tests of `switchboard setup` (src/cli/setup.ts). Pure/injectable
// pieces only — no real claude/apt/npm/tmux side effects, no touching the
// real ~/.claude of this machine: every path goes through a temp homeDir
// (mkdtempSync) and every command through a fake exec that RECORDS instead
// of running. Covers: snippet block insert/replace between markers,
// settings.json merge (preserve + no dupes + create), declining steps,
// --yes non-interactive, step order + final summary, non-TTY error, and
// the sudo-less user-space tmux install.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PERMISSION_ALLOW_RULES,
  PROTOCOL_END,
  PROTOCOL_START,
  installTmuxUserSpace,
  isTmuxVersionSupported,
  mergePermissionAllow,
  parseShortcutChoice,
  parseTmuxVersion,
  runSetup,
  upsertProtocolBlock,
  type SetupExecFn,
  type SetupOptions,
} from "../src/cli/setup.js";
import { CliError } from "../src/cli/common.js";

// ---------------------------------------------------------------------------
// Fake exec: records every command; per-command canned behavior.
// ---------------------------------------------------------------------------

interface FakeExec {
  exec: SetupExecFn;
  calls: string[][]; // [file, ...args] per invocation, in order
}

type ExecHandler = (
  file: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }> | { stdout: string; stderr: string };

/**
 * Handlers are matched by "file arg0 arg1..." prefix (first match wins);
 * unmatched commands succeed with empty output. Rejections model non-zero
 * exits (the SetupExecFn contract).
 */
function makeExec(handlers: Array<[string, ExecHandler]> = []): FakeExec {
  const calls: string[][] = [];
  const exec: SetupExecFn = async (file, args, opts) => {
    calls.push([file, ...args]);
    const joined = [file, ...args].join(" ");
    for (const [prefix, handler] of handlers) {
      if (joined.startsWith(prefix)) return handler(file, args, opts);
    }
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const fail = (message: string): ExecHandler => () => {
  throw new Error(message);
};
const stdout = (text: string): ExecHandler => () => ({ stdout: text, stderr: "" });

// ---------------------------------------------------------------------------
// Temp homeDir world + a happy-path runSetup options factory.
// ---------------------------------------------------------------------------

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-setup-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const claudeMdPath = () => path.join(home, ".claude", "CLAUDE.md");
const settingsPath = () => path.join(home, ".claude", "settings.json");

// baseDir that does not exist → loadConfig returns pure defaults, silently.
const NO_CONFIG_DIR = path.join(os.tmpdir(), "switchboard-none-setup-test");

/** Options for a full happy-path run: everything injected, nothing real. */
function happyOptions(fake: FakeExec, overrides: Partial<SetupOptions> = {}) {
  const printed: string[] = [];
  const ensured: string[] = [];
  const shortcuts: Array<{ startup?: boolean }> = [];
  const options: SetupOptions = {
    yes: true,
    isTTY: false,
    homeDir: home,
    baseDir: NO_CONFIG_DIR,
    hubUrl: "http://127.0.0.1:4577",
    out: (l) => printed.push(l),
    exec: fake.exec,
    env: {}, // no WSL_DISTRO_NAME → shortcut step skips
    ensureHub: async (url) => {
      ensured.push(url);
    },
    shortcut: async (o) => {
      shortcuts.push(o);
    },
    ...overrides,
  };
  return { options, printed, ensured, shortcuts };
}

/** exec where everything is already installed/registered (pure re-run). */
function allGoodExec(): FakeExec {
  return makeExec([
    ["claude --version", stdout("2.1.205 (Claude Code)")],
    ["tmux -V", stdout("tmux 3.4")],
    ["claude mcp get switchboard", stdout("switchboard: Status: Connected")],
    ["which switchboard", stdout("/usr/local/bin/switchboard")],
  ]);
}

// ---------------------------------------------------------------------------
// upsertProtocolBlock — (a) insert between markers, replace in place.
// ---------------------------------------------------------------------------

describe("upsertProtocolBlock", () => {
  const SNIPPET = "## Agent network (Switchboard)\n\n- rule one\n- rule two\n";

  it("empty file → just the marked block (trailing newline)", () => {
    const next = upsertProtocolBlock("", SNIPPET);
    expect(next).toBe(`${PROTOCOL_START}\n${SNIPPET.trim()}\n${PROTOCOL_END}\n`);
  });

  it("appends after existing user content with a blank-line separation", () => {
    const next = upsertProtocolBlock("# My rules\n\n- mine\n", SNIPPET);
    expect(next.startsWith("# My rules\n\n- mine\n\n")).toBe(true);
    expect(next).toContain(`${PROTOCOL_START}\n${SNIPPET.trim()}\n${PROTOCOL_END}`);
  });

  it("second run is idempotent (same content, ONE block)", () => {
    const once = upsertProtocolBlock("# Mine\n", SNIPPET);
    const twice = upsertProtocolBlock(once, SNIPPET);
    expect(twice).toBe(once);
    expect(twice.split(PROTOCOL_START)).toHaveLength(2); // one marker only
  });

  it("replaces IN PLACE without touching content around the markers", () => {
    const before = `# Above\n\n${PROTOCOL_START}\nold snippet v1\n${PROTOCOL_END}\n\n# Below stays\n`;
    const next = upsertProtocolBlock(before, SNIPPET);
    expect(next).toBe(
      `# Above\n\n${PROTOCOL_START}\n${SNIPPET.trim()}\n${PROTOCOL_END}\n\n# Below stays\n`,
    );
    expect(next).not.toContain("old snippet v1");
  });

  it("one marker without the other → clear CliError (never guess)", () => {
    expect(() => upsertProtocolBlock(`x\n${PROTOCOL_START}\ny\n`, SNIPPET)).toThrow(CliError);
    expect(() => upsertProtocolBlock(`x\n${PROTOCOL_END}\ny\n`, SNIPPET)).toThrow(/corrupted/);
  });
});

// ---------------------------------------------------------------------------
// mergePermissionAllow — (b) preserve everything, add both, no dupes.
// ---------------------------------------------------------------------------

describe("mergePermissionAllow", () => {
  it("missing file (undefined) → creates the object with both rules, 2-space pretty", () => {
    const { next, added } = mergePermissionAllow(undefined, PERMISSION_ALLOW_RULES);
    expect(added).toEqual([...PERMISSION_ALLOW_RULES]);
    expect(JSON.parse(next)).toEqual({
      permissions: { allow: [...PERMISSION_ALLOW_RULES] },
    });
    expect(next).toContain('  "permissions"'); // 2-space indentation
    expect(next.endsWith("\n")).toBe(true);
  });

  it("preserves unrelated keys and existing allow entries", () => {
    const raw = JSON.stringify({
      model: "opus",
      permissions: { deny: ["WebFetch"], allow: ["Bash(ls:*)"] },
      hooks: { PostToolUse: [] },
    });
    const { next, added } = mergePermissionAllow(raw, PERMISSION_ALLOW_RULES);
    expect(added).toEqual([...PERMISSION_ALLOW_RULES]);
    expect(JSON.parse(next)).toEqual({
      model: "opus",
      permissions: {
        deny: ["WebFetch"],
        allow: ["Bash(ls:*)", ...PERMISSION_ALLOW_RULES],
      },
      hooks: { PostToolUse: [] },
    });
  });

  it("re-run adds nothing (no dupes)", () => {
    const first = mergePermissionAllow(undefined, PERMISSION_ALLOW_RULES);
    const second = mergePermissionAllow(first.next, PERMISSION_ALLOW_RULES);
    expect(second.added).toEqual([]);
    expect(JSON.parse(second.next)).toEqual(JSON.parse(first.next));
  });

  it("adds only the missing rule when one is already there", () => {
    const raw = JSON.stringify({ permissions: { allow: ["mcp__switchboard__*"] } });
    const { added } = mergePermissionAllow(raw, PERMISSION_ALLOW_RULES);
    expect(added).toEqual(["Bash(printenv:*)"]);
  });

  it("invalid JSON / wrong types → clear CliError (never clobber the file)", () => {
    expect(() => mergePermissionAllow("{broken", PERMISSION_ALLOW_RULES)).toThrow(CliError);
    expect(() => mergePermissionAllow('"a string"', PERMISSION_ALLOW_RULES)).toThrow(
      /not a JSON object/,
    );
    expect(() =>
      mergePermissionAllow('{"permissions": []}', PERMISSION_ALLOW_RULES),
    ).toThrow(/not an object/);
    expect(() =>
      mergePermissionAllow('{"permissions": {"allow": "x"}}', PERMISSION_ALLOW_RULES),
    ).toThrow(/not an array/);
  });
});

// ---------------------------------------------------------------------------
// small pure helpers.
// ---------------------------------------------------------------------------

describe("tmux version helpers", () => {
  it("parses plain, lettered and next- versions", () => {
    expect(parseTmuxVersion("tmux 3.4")).toEqual([3, 4]);
    expect(parseTmuxVersion("tmux 3.3a")).toEqual([3, 3]);
    expect(parseTmuxVersion("tmux next-3.6")).toEqual([3, 6]);
    expect(parseTmuxVersion("garbage")).toBeUndefined();
  });

  it(">= 3.2 gate", () => {
    expect(isTmuxVersionSupported("tmux 3.2")).toBe(true);
    expect(isTmuxVersionSupported("tmux 3.4")).toBe(true);
    expect(isTmuxVersionSupported("tmux 4.0")).toBe(true);
    expect(isTmuxVersionSupported("tmux 3.1c")).toBe(false);
    expect(isTmuxVersionSupported("tmux 2.9")).toBe(false);
    expect(isTmuxVersionSupported("")).toBe(false);
  });
});

describe("parseShortcutChoice", () => {
  it("maps d/s/b (and full words, any case) — anything else skips", () => {
    expect(parseShortcutChoice("d")).toBe("desktop");
    expect(parseShortcutChoice("Desktop")).toBe("desktop");
    expect(parseShortcutChoice("s")).toBe("startup");
    expect(parseShortcutChoice("STARTUP")).toBe("startup");
    expect(parseShortcutChoice("b")).toBe("both");
    expect(parseShortcutChoice("both")).toBe("both");
    expect(parseShortcutChoice("")).toBe("skip");
    expect(parseShortcutChoice("n")).toBe("skip");
    expect(parseShortcutChoice("what")).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// installTmuxUserSpace — sudo-less technique from spikes/NOTES.md.
// ---------------------------------------------------------------------------

describe("installTmuxUserSpace", () => {
  function tempDownloadDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-debs-"));
  }

  it("downloads the .debs, unpacks each with dpkg -x, writes an executable wrapper and verifies -V", async () => {
    const printed: string[] = [];
    const fake = makeExec([
      // apt-get download drops .deb files into its cwd.
      [
        "apt-get download",
        (_file, _args, opts) => {
          fs.writeFileSync(path.join(opts!.cwd!, "tmux_3.4.deb"), "deb");
          fs.writeFileSync(path.join(opts!.cwd!, "libevent-core.deb"), "deb");
          fs.writeFileSync(path.join(opts!.cwd!, "libutempter0.deb"), "deb");
          return { stdout: "", stderr: "" };
        },
      ],
      [path.join(home, ".local", "bin", "tmux") + " -V", stdout("tmux 3.4")],
    ]);

    const wrapperPath = await installTmuxUserSpace({
      exec: fake.exec,
      homeDir: home,
      out: (l) => printed.push(l),
      mkTempDir: tempDownloadDir,
    });

    // Wrapper: bash + LD_LIBRARY_PATH + exec of the real binary, executable.
    expect(wrapperPath).toBe(path.join(home, ".local", "bin", "tmux"));
    const wrapper = fs.readFileSync(wrapperPath, "utf8");
    const toolsDir = path.join(home, ".local", "opt", "switchboard-tools");
    expect(wrapper.startsWith("#!/bin/bash\n")).toBe(true);
    expect(wrapper).toContain(
      `export LD_LIBRARY_PATH="${path.join(toolsDir, "usr", "lib", "x86_64-linux-gnu")}`,
    );
    expect(wrapper).toContain(`exec "${path.join(toolsDir, "usr", "bin", "tmux")}" "$@"`);
    expect(fs.statSync(wrapperPath).mode & 0o111).not.toBe(0);

    // Commands: 1 download + 3 dpkg -x (one per .deb) + 1 verify on the wrapper.
    const dpkg = fake.calls.filter((c) => c[0] === "dpkg" && c[1] === "-x");
    expect(dpkg).toHaveLength(3);
    for (const call of dpkg) expect(call[3]).toBe(toolsDir);
    expect(fake.calls[0][0]).toBe("apt-get");
    expect(fake.calls.at(-1)).toEqual([wrapperPath, "-V"]);
    expect(printed.join("\n")).toContain("tmux installed without sudo");
  });

  it("download failure (offline/non-Debian) → CliError with the sudo instruction", async () => {
    const fake = makeExec([["apt-get download", fail("E: Unable to locate package")]]);
    await expect(
      installTmuxUserSpace({
        exec: fake.exec,
        homeDir: home,
        out: () => {},
        mkTempDir: tempDownloadDir,
      }),
    ).rejects.toThrow(/sudo apt install tmux/);
  });

  it("installed tmux older than 3.2 → CliError (verify gate)", async () => {
    const fake = makeExec([
      [
        "apt-get download",
        (_file, _args, opts) => {
          fs.writeFileSync(path.join(opts!.cwd!, "tmux_3.0.deb"), "deb");
          return { stdout: "", stderr: "" };
        },
      ],
      [path.join(home, ".local", "bin", "tmux") + " -V", stdout("tmux 3.0")],
    ]);
    await expect(
      installTmuxUserSpace({
        exec: fake.exec,
        homeDir: home,
        out: () => {},
        mkTempDir: tempDownloadDir,
      }),
    ).rejects.toThrow(/needs >= 3\.2/);
  });
});

// ---------------------------------------------------------------------------
// runSetup — the wizard end to end (everything faked).
// ---------------------------------------------------------------------------

describe("runSetup", () => {
  it("(f) non-TTY without --yes → clear error instructing to pass --yes", async () => {
    await expect(runSetup({ yes: false, isTTY: false })).rejects.toThrow(/--yes/);
  });

  it("(d)(e) --yes runs non-interactively, steps in order, final summary printed", async () => {
    const fake = makeExec([
      ["claude --version", stdout("2.1.205 (Claude Code)")],
      ["tmux -V", stdout("tmux 3.4")],
      ["claude mcp get switchboard", fail("No MCP server named")],
      ["which switchboard", fail("not found")],
    ]);
    const { options, printed, ensured } = happyOptions(fake, {
      confirm: async () => {
        throw new Error("confirm must NEVER be called with --yes");
      },
      choose: async () => {
        throw new Error("choose must NEVER be called with --yes");
      },
    });
    await runSetup(options);

    // Step headers appear once each, in order.
    const headers = printed.filter((l) => /^\[\d\/7\]/.test(l));
    expect(headers).toEqual([
      "[1/7] Prerequisites",
      "[2/7] MCP registration",
      "[3/7] Agent protocol snippet",
      "[4/7] Claude Code permissions",
      "[5/7] Global command",
      "[6/7] Windows shortcut",
      "[7/7] Hub",
    ]);

    // Actions taken: mcp add, snippet written, permissions written, npm link.
    expect(fake.calls).toContainEqual([
      "claude",
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "switchboard",
      "http://127.0.0.1:4577/mcp",
    ]);
    expect(fs.readFileSync(claudeMdPath(), "utf8")).toContain(PROTOCOL_START);
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8")).permissions.allow).toEqual([
      ...PERMISSION_ALLOW_RULES,
    ]);
    expect(fake.calls).toContainEqual(["npm", "link"]);
    expect(ensured).toEqual(["http://127.0.0.1:4577"]);

    // Final summary block.
    const text = printed.join("\n");
    expect(text).toContain("You're all set!");
    expect(text).toContain("Dashboard:    http://127.0.0.1:4577/");
    expect(text).toContain('run "switchboard wire" in each project folder');
    expect(text).toContain('"Launch agent" form in the dashboard');
  });

  it("(a) second run is idempotent: block replaced in place, user content untouched, no dupes", async () => {
    // Pre-existing CLAUDE.md with the user's own content around a stale block.
    fs.mkdirSync(path.dirname(claudeMdPath()), { recursive: true });
    fs.writeFileSync(
      claudeMdPath(),
      `# My own rules (never touch)\n\n${PROTOCOL_START}\nstale old snippet\n${PROTOCOL_END}\n\n# Also mine\n`,
    );

    const run = async () => {
      const fake = allGoodExec();
      const { options, printed } = happyOptions(fake);
      await runSetup(options);
      return { printed, fake };
    };

    const first = await run();
    const afterFirst = fs.readFileSync(claudeMdPath(), "utf8");
    expect(afterFirst).toContain("# My own rules (never touch)");
    expect(afterFirst).toContain("# Also mine");
    expect(afterFirst).not.toContain("stale old snippet");
    expect(afterFirst).toContain("## Agent network (Switchboard)"); // real snippet content
    expect(afterFirst.split(PROTOCOL_START)).toHaveLength(2); // exactly one block
    expect(first.printed.join("\n")).toContain("Protocol snippet updated");

    const second = await run();
    expect(fs.readFileSync(claudeMdPath(), "utf8")).toBe(afterFirst); // byte-identical
    expect(second.printed.join("\n")).toContain("already up to date");
  });

  it("(b) settings.json: created when missing; re-run reports already present and rewrites nothing", async () => {
    const first = happyOptions(allGoodExec());
    await runSetup(first.options);
    const written = fs.readFileSync(settingsPath(), "utf8");
    expect(JSON.parse(written).permissions.allow).toEqual([...PERMISSION_ALLOW_RULES]);

    const second = happyOptions(allGoodExec());
    await runSetup(second.options);
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe(written);
    expect(second.printed.join("\n")).toContain("Allow rules already present");
  });

  it("(c) declining steps skips them and says so (bypassPermissions consequence included)", async () => {
    const fake = makeExec([
      ["claude --version", stdout("2.1.205 (Claude Code)")],
      ["tmux -V", stdout("tmux 3.4")],
      ["claude mcp get switchboard", fail("No MCP server named")],
      ["which switchboard", fail("not found")],
    ]);
    const { options, printed } = happyOptions(fake, {
      yes: false,
      isTTY: true,
      confirm: async () => false, // decline EVERY confirmation
    });
    await runSetup(options);
    const text = printed.join("\n");

    // MCP add skipped: no `claude mcp add` was executed, manual command shown.
    expect(fake.calls.some((c) => c[0] === "claude" && c[2] === "add")).toBe(false);
    expect(text).toContain("register it later with: claude mcp add");

    // Snippet skipped: file never created, note says how to do it manually.
    expect(fs.existsSync(claudeMdPath())).toBe(false);
    expect(text).toContain("agent-protocol/CLAUDE.snippet.md");

    // Permissions skipped: file never created, bypassPermissions consequence.
    expect(fs.existsSync(settingsPath())).toBe(false);
    expect(text).toContain("bypassPermissions");

    // npm link skipped with the bin-shim alternative.
    expect(fake.calls.some((c) => c[0] === "npm")).toBe(false);
    expect(text).toContain("bin/switchboard.mjs");
  });

  it("missing claude → CliError with the install pointer (before anything else runs)", async () => {
    const fake = makeExec([["claude --version", fail("ENOENT")]]);
    const { options } = happyOptions(fake);
    await expect(runSetup(options)).rejects.toThrow(/was not found on the PATH/);
    // Only the claude probe ran — no mcp/npm/etc.
    expect(fake.calls).toEqual([["claude", "--version"]]);
  });

  it("tmux missing + user declines the install → CliError (tmux is required)", async () => {
    const fake = makeExec([
      ["claude --version", stdout("2.1.205 (Claude Code)")],
      ["tmux -V", fail("ENOENT")],
      ["apt-get --version", stdout("apt 2.7.14")],
    ]);
    const { options } = happyOptions(fake, {
      yes: false,
      isTTY: true,
      confirm: async () => false,
    });
    await expect(runSetup(options)).rejects.toThrow(/tmux is required/);
  });

  it("tmux missing and no apt-get → CliError pointing at the system package manager", async () => {
    const fake = makeExec([
      ["claude --version", stdout("2.1.205 (Claude Code)")],
      ["tmux -V", fail("ENOENT")],
      ["apt-get --version", fail("ENOENT")],
    ]);
    const { options } = happyOptions(fake);
    await expect(runSetup(options)).rejects.toThrow(/no apt-get/);
  });

  it("tmux missing + accepted install: installs user-space and prepends ~/.local/bin to PATH for this run", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const wrapperPath = path.join(home, ".local", "bin", "tmux");
    const fake = makeExec([
      ["claude --version", stdout("2.1.205 (Claude Code)")],
      ["tmux -V", fail("ENOENT")],
      ["apt-get --version", stdout("apt 2.7.14")],
      [
        "apt-get download",
        (_file, _args, opts) => {
          fs.writeFileSync(path.join(opts!.cwd!, "tmux_3.4.deb"), "deb");
          return { stdout: "", stderr: "" };
        },
      ],
      [wrapperPath + " -V", stdout("tmux 3.4")],
      ["claude mcp get switchboard", stdout("registered")],
      ["which switchboard", stdout("/usr/local/bin/switchboard")],
    ]);
    const { options, printed } = happyOptions(fake, {
      env,
      mkTempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-debs-")),
    });
    await runSetup(options);
    expect(fs.existsSync(wrapperPath)).toBe(true);
    expect(env.PATH!.startsWith(path.join(home, ".local", "bin") + path.delimiter)).toBe(true);
    expect(printed.join("\n")).toContain("added to the PATH for this run");
  });

  it("npm link failure is non-fatal: prints the bin-shim alternative and setup finishes", async () => {
    const fake = makeExec([
      ["claude --version", stdout("2.1.205 (Claude Code)")],
      ["tmux -V", stdout("tmux 3.4")],
      ["claude mcp get switchboard", stdout("registered")],
      ["which switchboard", fail("not found")],
      ["npm link", fail("EACCES: permission denied")],
    ]);
    const { options, printed, ensured } = happyOptions(fake);
    await runSetup(options);
    const text = printed.join("\n");
    expect(text).toContain("npm link failed");
    expect(text).toContain("bin/switchboard.mjs");
    expect(ensured).toHaveLength(1); // step 7 still ran
    expect(text).toContain("You're all set!");
  });

  it("WSL + --yes → shortcut runs for BOTH Desktop and Startup (reusing runShortcut)", async () => {
    const { options, shortcuts } = happyOptions(allGoodExec(), {
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    });
    await runSetup(options);
    expect(shortcuts).toEqual([{ startup: false }, { startup: true }]);
  });

  it("WSL interactive: the 4-way menu drives the shortcut (s → startup only; empty → skip)", async () => {
    const startupOnly = happyOptions(allGoodExec(), {
      yes: false,
      isTTY: true,
      confirm: async () => true,
      choose: async () => "s",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    });
    await runSetup(startupOnly.options);
    expect(startupOnly.shortcuts).toEqual([{ startup: true }]);

    const skipped = happyOptions(allGoodExec(), {
      yes: false,
      isTTY: true,
      confirm: async () => true,
      choose: async () => "",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    });
    await runSetup(skipped.options);
    expect(skipped.shortcuts).toEqual([]);
    expect(skipped.printed.join("\n")).toContain('"switchboard shortcut"');
  });

  it("non-WSL: shortcut step is skipped with a note (never calls runShortcut)", async () => {
    const { options, printed, shortcuts } = happyOptions(allGoodExec());
    await runSetup(options);
    expect(shortcuts).toEqual([]);
    expect(printed.join("\n")).toContain("not a WSL session");
  });

  it("everything already done → every step reports ✓ already and nothing is executed twice", async () => {
    // Pre-seed both files exactly as setup would leave them.
    const seed = happyOptions(allGoodExec());
    await runSetup(seed.options);

    const fake = allGoodExec();
    const { options, printed } = happyOptions(fake, {
      confirm: async () => {
        throw new Error("no confirmation should be needed on a fully-done re-run");
      },
      yes: false,
      isTTY: true,
    });
    await runSetup(options);
    const text = printed.join("\n");
    expect(text).toContain('MCP server "switchboard" already registered');
    expect(text).toContain("already up to date");
    expect(text).toContain("Allow rules already present");
    expect(text).toContain('"switchboard" already on the PATH');
    // Nothing mutating ran: no mcp add, no npm link, no apt-get.
    expect(fake.calls.some((c) => c.includes("add") || c[0] === "npm" || c[0] === "apt-get")).toBe(
      false,
    );
  });

  it("never prints anything token-like (setup never even sees a token)", async () => {
    const { options, printed } = happyOptions(allGoodExec());
    await runSetup(options);
    expect(printed.join("\n")).not.toMatch(/SWITCHBOARD_AGENT_TOKEN=|token:/i);
  });
});
