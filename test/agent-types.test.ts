// Unit tests of the agent-type adapter (src/shared/agent-types.ts) — the single
// source of truth for "which coding-agent CLI, opened how, read how".
//
// Two jobs here:
//   1. LOCK THE CLAUDE ARGV. The claude descriptor is a verbatim move of logic
//      that used to live in wire.ts/start.ts, so its argv is asserted
//      EXACTLY — element for element. Any drift is a regression in the default
//      (and only pre-existing) agent type, and this is what catches it.
//   2. PIN THE CODEX ARGV ORDER. `resume` is a SUBCOMMAND and the bypass flag
//      MUST follow it: verified live against codex-cli 0.144.3, where a bypass
//      placed BEFORE the subcommand parses fine and is then silently dropped
//      (clap renders it into the usage line only in the second form). A silent
//      drop = an agent stuck on an approval prompt with no error, so the order
//      is asserted as an ordered array, never a set.
//
// Pure functions only — no hub, no tmux, no ports, no CLI ever executed.

import { describe, expect, it } from "vitest";
import {
  agentTypeDescriptor,
  allAgentTypeDescriptors,
  claudeAgentType,
  codexAgentType,
  invalidAgentTypeMessage,
  isAgentType,
  resolveAgentType,
  AGENT_TYPES,
  CLAUDE_BYPASS_FLAG,
  CODEX_BYPASS_FLAG,
  DEFAULT_AGENT_TYPE,
} from "../src/shared/agent-types.js";
import { parseAgentTypeFlag } from "../src/cli/start.js";
import { buildWireClaudeArgs } from "../src/cli/wire.js";
import { CliError } from "../src/cli/common.js";

// ---------------------------------------------------------------------------
// The type itself.
// ---------------------------------------------------------------------------

describe("AgentType", () => {
  it("claude is the default (what an omitted flag and a legacy record mean)", () => {
    expect(DEFAULT_AGENT_TYPE).toBe("claude");
    expect(AGENT_TYPES).toEqual(["claude", "codex"]);
  });

  it("isAgentType accepts exactly the two, rejects everything else", () => {
    expect(isAgentType("claude")).toBe(true);
    expect(isAgentType("codex")).toBe(true);
    expect(isAgentType("codx")).toBe(false);
    expect(isAgentType("CLAUDE")).toBe(false); // no case-folding: values are ids
    expect(isAgentType("")).toBe(false);
    expect(isAgentType(undefined)).toBe(false);
    expect(isAgentType(null)).toBe(false);
    expect(isAgentType(7)).toBe(false);
  });

  it("resolveAgentType maps anything unknown/absent to claude (legacy records)", () => {
    expect(resolveAgentType("codex")).toBe("codex");
    expect(resolveAgentType("claude")).toBe("claude");
    // An agents.json written before the field existed: those agents were all
    // Claude Code, so undefined is not a guess — it is information.
    expect(resolveAgentType(undefined)).toBe("claude");
    expect(resolveAgentType("nonsense")).toBe("claude");
  });

  it("agentTypeDescriptor resolves by value and never returns undefined", () => {
    expect(agentTypeDescriptor("claude")).toBe(claudeAgentType);
    expect(agentTypeDescriptor("codex")).toBe(codexAgentType);
    expect(agentTypeDescriptor(undefined)).toBe(claudeAgentType);
    expect(agentTypeDescriptor("bogus")).toBe(claudeAgentType);
    expect(allAgentTypeDescriptors().map((d) => d.type)).toEqual(["claude", "codex"]);
  });

  it("the rejection message names the offending value AND both options", () => {
    const message = invalidAgentTypeMessage("codx");
    expect(message).toContain('"codx"');
    expect(message).toContain("claude | codex");
    expect(message).toContain("default: claude");
  });
});

// ---------------------------------------------------------------------------
// claude descriptor — EXACT argv (the regression lock).
// ---------------------------------------------------------------------------

describe("claude descriptor", () => {
  it("binary and labels", () => {
    expect(claudeAgentType.bin).toBe("claude");
    expect(claudeAgentType.type).toBe("claude");
    expect(claudeAgentType.label).toBe("Claude Code");
  });

  it("continue → exactly [-c, --dangerously-skip-permissions]", () => {
    expect(claudeAgentType.buildArgs({ continueConversation: true })).toEqual([
      "-c",
      "--dangerously-skip-permissions",
    ]);
  });

  it("fresh → exactly [--dangerously-skip-permissions] (no -c)", () => {
    expect(claudeAgentType.buildArgs({ continueConversation: false })).toEqual([
      "--dangerously-skip-permissions",
    ]);
    // continueConversation omitted defaults to false.
    expect(claudeAgentType.buildArgs({})).toEqual(["--dangerously-skip-permissions"]);
  });

  it("user extras are appended after the defaults, in order", () => {
    expect(
      claudeAgentType.buildArgs({
        continueConversation: true,
        extraArgs: ["--model", "opus"],
      }),
    ).toEqual(["-c", "--dangerously-skip-permissions", "--model", "opus"]);
  });

  it("does not duplicate a continue the user already asked for (-c / --continue)", () => {
    expect(
      claudeAgentType.buildArgs({ continueConversation: true, extraArgs: ["-c"] }),
    ).toEqual(["--dangerously-skip-permissions", "-c"]);
    expect(
      claudeAgentType.buildArgs({ continueConversation: true, extraArgs: ["--continue"] }),
    ).toEqual(["--dangerously-skip-permissions", "--continue"]);
  });

  it("never forces -c alongside -r/--resume (two conflicting selectors)", () => {
    expect(
      claudeAgentType.buildArgs({ continueConversation: true, extraArgs: ["-r", "abc"] }),
    ).toEqual(["--dangerously-skip-permissions", "-r", "abc"]);
    expect(
      claudeAgentType.buildArgs({ continueConversation: true, extraArgs: ["--resume"] }),
    ).toEqual(["--dangerously-skip-permissions", "--resume"]);
  });

  it("does not duplicate the bypass, nor force it against a --permission-mode", () => {
    expect(
      claudeAgentType.buildArgs({
        continueConversation: true,
        extraArgs: [CLAUDE_BYPASS_FLAG],
      }),
    ).toEqual(["-c", CLAUDE_BYPASS_FLAG]);
    // Recent claude builds reject bypass + permission-mode together (the
    // session would die at birth), so the default stands down.
    expect(
      claudeAgentType.buildArgs({
        continueConversation: true,
        extraArgs: ["--permission-mode", "plan"],
      }),
    ).toEqual(["-c", "--permission-mode", "plan"]);
  });

  it("hasContinue/withoutContinue speak claude's flags", () => {
    expect(claudeAgentType.hasContinue(["-c", CLAUDE_BYPASS_FLAG])).toBe(true);
    expect(claudeAgentType.hasContinue(["--continue"])).toBe(true);
    expect(claudeAgentType.hasContinue([CLAUDE_BYPASS_FLAG])).toBe(false);
    expect(claudeAgentType.withoutContinue(["-c", CLAUDE_BYPASS_FLAG])).toEqual([
      CLAUDE_BYPASS_FLAG,
    ]);
    expect(
      claudeAgentType.withoutContinue(["--continue", CLAUDE_BYPASS_FLAG, "--model", "opus"]),
    ).toEqual([CLAUDE_BYPASS_FLAG, "--model", "opus"]);
  });

  it("isTuiReady: every marker observed on a real claude pane", () => {
    expect(claudeAgentType.isTuiReady("some output\n? for shortcuts")).toBe(true);
    expect(claudeAgentType.isTuiReady("│ > ")).toBe(true);
    expect(claudeAgentType.isTuiReady("⏵⏵ bypass permissions on (shift+tab to cycle)")).toBe(
      true,
    );
    expect(claudeAgentType.isTuiReady("⏵⏵ accept edits on")).toBe(true);
    expect(claudeAgentType.isTuiReady("⏸ plan mode on")).toBe(true);
    expect(claudeAgentType.isTuiReady("")).toBe(false);
    expect(claudeAgentType.isTuiReady("Loading…")).toBe(false);
  });

  it("the trust dialog is NOT ready (a blind kickoff would type into a menu)", () => {
    const dialog =
      "Quick safety check: Is this a project you created or one you trust?\n 1. Yes\n 2. No";
    expect(claudeAgentType.isTuiReady(dialog)).toBe(false);
    expect(claudeAgentType.isTrustDialog(dialog)).toBe(true);
  });

  it("claude NEVER auto-accepts its trust dialog (the human does, in the attach)", () => {
    // This false is load-bearing: flipping it would change the behavior of the
    // default agent type, which this whole feature must leave alone.
    expect(claudeAgentType.autoAcceptTrustDialog).toBe(false);
  });

  it("mcp registration argv (claude's own spelling)", () => {
    expect(claudeAgentType.mcpAddArgs("switchboard", "http://127.0.0.1:4577/mcp")).toEqual([
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "switchboard",
      "http://127.0.0.1:4577/mcp",
    ]);
    expect(claudeAgentType.mcpGetArgs("switchboard")).toEqual(["mcp", "get", "switchboard"]);
  });
});

// ---------------------------------------------------------------------------
// codex descriptor — the argv ORDER is the whole point.
// ---------------------------------------------------------------------------

describe("codex descriptor", () => {
  it("binary and labels", () => {
    expect(codexAgentType.bin).toBe("codex");
    expect(codexAgentType.type).toBe("codex");
    expect(codexAgentType.label).toBe("Codex CLI");
  });

  it("continue → `resume --last` FIRST, bypass AFTER the subcommand", () => {
    // Verified against codex-cli 0.144.3: the bypass flag is declared on both
    // the top-level command and `resume`, but is NOT clap-global — placing it
    // before the subcommand parses and is then SILENTLY DROPPED. Order is
    // therefore correctness, not style.
    expect(codexAgentType.buildArgs({ continueConversation: true })).toEqual([
      "resume",
      "--last",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("fresh → just the bypass (no subcommand at all)", () => {
    expect(codexAgentType.buildArgs({ continueConversation: false })).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(codexAgentType.buildArgs({})).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("user extras land after the bypass, still behind the subcommand", () => {
    expect(
      codexAgentType.buildArgs({
        continueConversation: true,
        extraArgs: ["--model", "o3"],
      }),
    ).toEqual(["resume", "--last", CODEX_BYPASS_FLAG, "--model", "o3"]);
  });

  it("codex's `-c` is --config, NOT continue — it must not suppress the resume", () => {
    // The trap a shared dedup list would fall into: claude's continue flag and
    // codex's config flag are the same two characters with unrelated meanings.
    expect(
      codexAgentType.buildArgs({
        continueConversation: true,
        extraArgs: ["-c", 'model="o3"'],
      }),
    ).toEqual(["resume", "--last", CODEX_BYPASS_FLAG, "-c", 'model="o3"']);
  });

  it("a user's own session subcommand stays first, and the bypass lands after it", () => {
    // The order pitfall again: prepending our bypass would put it BEFORE the
    // user's `resume`, i.e. silently drop it.
    expect(codexAgentType.buildArgs({ continueConversation: true, extraArgs: ["resume"] })).toEqual(
      ["resume", CODEX_BYPASS_FLAG],
    );
    expect(
      codexAgentType.buildArgs({ continueConversation: false, extraArgs: ["fork", "--last"] }),
    ).toEqual(["fork", CODEX_BYPASS_FLAG, "--last"]);
  });

  it("does not duplicate the bypass, nor force it against the user's own policy", () => {
    expect(
      codexAgentType.buildArgs({ continueConversation: true, extraArgs: [CODEX_BYPASS_FLAG] }),
    ).toEqual(["resume", "--last", CODEX_BYPASS_FLAG]);
    for (const own of [
      ["-s", "workspace-write"],
      ["--sandbox", "read-only"],
      ["-a", "never"],
      ["--ask-for-approval", "on-request"],
    ]) {
      expect(codexAgentType.buildArgs({ continueConversation: true, extraArgs: own })).toEqual([
        "resume",
        "--last",
        ...own,
      ]);
    }
  });

  it("hasContinue/withoutContinue speak codex's SUBCOMMAND shape", () => {
    const continuing = codexAgentType.buildArgs({ continueConversation: true });
    expect(codexAgentType.hasContinue(continuing)).toBe(true);
    expect(codexAgentType.hasContinue([CODEX_BYPASS_FLAG])).toBe(false);
    // The fallback retry must drop BOTH the subcommand and its --last:
    // `codex --last` is not a thing at the top level and would die at birth.
    expect(codexAgentType.withoutContinue(continuing)).toEqual([CODEX_BYPASS_FLAG]);
    expect(codexAgentType.withoutContinue([CODEX_BYPASS_FLAG])).toEqual([CODEX_BYPASS_FLAG]);
  });

  it("isTuiReady: the `>_ OpenAI Codex` header means the TUI is up", () => {
    expect(codexAgentType.isTuiReady("╭──────╮\n│ >_ OpenAI Codex (v0.144.3) │")).toBe(true);
    expect(codexAgentType.isTuiReady(">_  OpenAI Codex (v0.144.3)")).toBe(true); // padding tolerated
    expect(codexAgentType.isTuiReady("")).toBe(false);
    expect(codexAgentType.isTuiReady("booting…")).toBe(false);
  });

  it("the trust dialog is NOT ready, and IS detected", () => {
    // Verified live: the header is not on screen while this dialog is up, and
    // Enter accepts its default ("1. Yes, continue").
    const dialog =
      "  Do you trust the contents of this directory?\n  1. Yes, continue\n  2. No, quit";
    expect(codexAgentType.isTrustDialog(dialog)).toBe(true);
    expect(codexAgentType.isTuiReady(dialog)).toBe(false);
    // Belt-and-braces: even if a future build painted the header on the dialog
    // screen, a dialog owning the keyboard must never read as "ready".
    expect(codexAgentType.isTuiReady(`>_ OpenAI Codex (v9)\n${dialog}`)).toBe(false);
  });

  it("a ready pane is not mistaken for the trust dialog", () => {
    expect(codexAgentType.isTrustDialog(">_ OpenAI Codex (v0.144.3)")).toBe(false);
  });

  it("codex DOES auto-accept its trust dialog (nothing else would)", () => {
    // The dashboard launches with no human attached, so the kickoff presses
    // Enter itself — through the pane guard (codex's pane runs `node`).
    expect(codexAgentType.autoAcceptTrustDialog).toBe(true);
  });

  it("mcp registration argv (codex's own spelling: `mcp add <name> --url`)", () => {
    expect(codexAgentType.mcpAddArgs("switchboard", "http://127.0.0.1:4577/mcp")).toEqual([
      "mcp",
      "add",
      "switchboard",
      "--url",
      "http://127.0.0.1:4577/mcp",
    ]);
    expect(codexAgentType.mcpGetArgs("switchboard")).toEqual(["mcp", "get", "switchboard"]);
  });
});

// ---------------------------------------------------------------------------
// --agent flag validation (the CLI's gate) + wire's argv through the adapter.
// ---------------------------------------------------------------------------

describe("parseAgentTypeFlag (--agent)", () => {
  it("omitted → claude (start/wire without the flag behave exactly as before)", () => {
    expect(parseAgentTypeFlag(undefined)).toBe("claude");
  });

  it("accepts both valid values", () => {
    expect(parseAgentTypeFlag("claude")).toBe("claude");
    expect(parseAgentTypeFlag("codex")).toBe("codex");
  });

  it("rejects anything else with a CliError listing the options", () => {
    expect(() => parseAgentTypeFlag("codx")).toThrow(CliError);
    expect(() => parseAgentTypeFlag("codx")).toThrow(/claude \| codex/);
    expect(() => parseAgentTypeFlag("")).toThrow(CliError);
    expect(() => parseAgentTypeFlag("gpt")).toThrow(/Invalid agent type/);
  });
});

describe("buildWireClaudeArgs across agent types", () => {
  it("defaults to claude's argv when no type is given (unchanged contract)", () => {
    expect(buildWireClaudeArgs(undefined)).toEqual(["-c", "--dangerously-skip-permissions"]);
    expect(buildWireClaudeArgs("--model opus")).toEqual([
      "-c",
      "--dangerously-skip-permissions",
      "--model",
      "opus",
    ]);
  });

  it("wire --agent codex continues via the resume subcommand", () => {
    expect(buildWireClaudeArgs(undefined, "codex")).toEqual([
      "resume",
      "--last",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(buildWireClaudeArgs("--model o3", "codex")).toEqual([
      "resume",
      "--last",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "o3",
    ]);
  });

  it("bad quoting still fails fast, whatever the agent type", () => {
    expect(() => buildWireClaudeArgs(`--model "opus`, "codex")).toThrow(CliError);
  });
});
