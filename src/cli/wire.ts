// `switchboard wire` — adopts the CURRENT window into the network, continuing
// its conversation.
//
// Product context (owner's decision, validated by spike): the user already has
// a Claude Code window open (plain `claude` in bash, WITHOUT tmux). To join the
// network they LEAVE claude and run `switchboard wire` in the SAME folder; wire
// reopens claude CONTINUING that folder's conversation (`claude -c`) inside a
// tmux session already connected to the Hub.
//
// wire is `start` with two deliberate differences (both live in the shared
// runAgentSession core in start.ts, keyed on mode):
//   1. SUBSTITUTES a homonymous session instead of refusing it (P7) — the owner
//      wants "adopt THIS window", so an existing sb-<name> is killed and
//      recreated with no confirmation;
//   2. the claude argv DEFAULTS to `-c --dangerously-skip-permissions` (+ any
//      extra --claude-args), whereas start defaults to none.
//
// Why those two flags are the wire DEFAULT (and not start's):
//   - `-c` continues the conversation of the adopted folder — the entire point
//     of wire is to not lose the context the user already built in that window;
//   - `--dangerously-skip-permissions` (bypass) lets the adopted agent read its
//     token (`printenv`) and call the join tool with NO approval prompt. wire
//     re-adopts an ALREADY-TRUSTED, already-open window, so the interactive
//     approval that start might want buys nothing here — it would only stall the
//     autonomous kickoff/join. start stays conservative (no bypass by default);
//     wire opts in because its whole premise is an already-trusted context.

import path from "node:path";
import type { Command } from "commander";
import { AGENT_NAME_RE } from "../server/store.js";
import {
  agentTypeDescriptor,
  AGENT_TYPES,
  CLAUDE_BYPASS_FLAG,
  CLAUDE_CONTINUE_ALIAS,
  CLAUDE_CONTINUE_FLAG,
  CLAUDE_PERMISSION_MODE_FLAG,
  CLAUDE_RESUME_ALIAS,
  CLAUDE_RESUME_FLAG,
  DEFAULT_AGENT_TYPE,
  type AgentType,
} from "../shared/agent-types.js";
import { CliError, runCliAction, type OutFn } from "./common.js";
import {
  expandHome,
  parseAgentTypeFlag,
  parseClaudeArgs,
  runAgentSession,
  type StartResult,
  type StartTmux,
} from "./start.js";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/wire.test.ts).
// ---------------------------------------------------------------------------

/**
 * The claude flag constants now live in the agent-type adapter
 * (src/shared/agent-types.ts) alongside codex's, since the defaults wire wants
 * — "continue this folder's conversation, skip approvals" — are a concept both
 * CLIs have, spelled differently. These aliases keep the WIRE_* names working
 * for their existing importers (launcher.ts, test/wire.test.ts); they are, and
 * always were, Claude Code's flags.
 */
export const WIRE_CONTINUE_FLAG = CLAUDE_CONTINUE_FLAG;
export const WIRE_CONTINUE_ALIAS = CLAUDE_CONTINUE_ALIAS;
export const WIRE_RESUME_FLAG = CLAUDE_RESUME_FLAG;
export const WIRE_RESUME_ALIAS = CLAUDE_RESUME_ALIAS;
export const WIRE_BYPASS_FLAG = CLAUDE_BYPASS_FLAG;
export const WIRE_PERMISSION_MODE_FLAG = CLAUDE_PERMISSION_MODE_FLAG;

/**
 * Sanitizes an arbitrary folder name into a candidate agent name: lowercase,
 * accents folded onto their base letter ("São Paulo" → "sao-paulo"),
 * every run of characters outside [a-z0-9-] collapsed to a single hyphen,
 * repeated hyphens collapsed, leading/trailing hyphens trimmed, capped at 31
 * chars (the store's max) without leaving a trailing hyphen. The result is NOT
 * guaranteed valid (an all-punctuation folder collapses to ""); deriveAgentName
 * validates it against AGENT_NAME_RE.
 */
function sanitizeAgentName(raw: string): string {
  let s = raw.toLowerCase();
  // Fold accents FIRST, so a folder named "São Paulo" yields "sao-paulo" and
  // not "s-o-paulo": stripping the diacritic keeps the letter the user typed,
  // whereas the invalid-run rule below would eat it. NFD splits "ã" into
  // "a" + combining tilde; the tilde is then dropped with the rest of U+0300–36F.
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/[^a-z0-9-]+/g, "-"); // any invalid run → one hyphen
  s = s.replace(/-+/g, "-"); // collapse repeated hyphens
  s = s.replace(/^-+/, "").replace(/-+$/, ""); // trim edge hyphens
  if (s.length > 31) s = s.slice(0, 31).replace(/-+$/, "");
  return s;
}

/**
 * Derives the default agent name from the basename of `dir` (the folder whose
 * conversation wire continues). Sanitized to match the store's AGENT_NAME_RE;
 * if the folder cannot yield a valid name (too short, all punctuation, …) it
 * throws a clear CliError telling the user to pass --name explicitly.
 */
export function deriveAgentName(dir: string): string {
  const base = path.basename(path.resolve(expandHome(dir)));
  const candidate = sanitizeAgentName(base);
  if (!AGENT_NAME_RE.test(candidate)) {
    throw new CliError(
      `Could not derive a valid agent name from the folder "${base}". ` +
        `Agent names are lowercase letters, digits and hyphens (2 to 31 characters, ` +
        `starting with a letter or digit). Pass --name <name> explicitly.`,
    );
  }
  return candidate;
}

/**
 * Builds the agent argv for wire: applies the "continue + skip approvals"
 * defaults on top of the user's parsed --claude-args, skipping a default
 * whenever it would DUPLICATE or CONFLICT with something the user provided.
 * The rules are the descriptor's, because each CLI spells them differently:
 *   - claude → prepends `-c --dangerously-skip-permissions`; `-c` is skipped
 *     when the user passed `-c`/`--continue` (duplicate) or `-r`/`--resume`
 *     (conflict: two conversation selectors); the bypass is skipped when the
 *     user passed it or any `--permission-mode <value>` (recent claude builds
 *     reject mixing the two);
 *   - codex → `resume --last --dangerously-bypass-approvals-and-sandbox`, and
 *     note the ORDER: `resume` is a subcommand and the bypass MUST follow it
 *     (see the agent-types.ts header — a bypass placed before the subcommand
 *     is silently dropped).
 * Parsing goes through parseClaudeArgs, so bad quoting throws a CliError here —
 * before wire touches the Hub (no ghost registration).
 */
export function buildWireClaudeArgs(
  raw: string | undefined,
  agentType?: AgentType,
): string[] {
  return agentTypeDescriptor(agentType).buildArgs({
    continueConversation: true, // wire's whole premise: keep the context
    extraArgs: parseClaudeArgs(raw),
  });
}

// ---------------------------------------------------------------------------
// wire runner.
// ---------------------------------------------------------------------------

/** tmux surface wire needs: the shared core plus killSession (SUBSTITUTE). */
export type WireTmux = StartTmux & {
  killSession(session: string): Promise<void>;
};

export interface WireOptions {
  /** Explicit agent name; when omitted it is derived from the --dir basename. */
  name?: string;
  role?: string;
  /**
   * Folder whose conversation to continue (default: current directory — the
   * folder where the user ran `switchboard wire`). "~" is expanded.
   */
  dir?: string;
  /** Kickoff on/off (default true; --no-kickoff sets false). */
  kickoff?: boolean;
  /** Extra args for the agent CLI, appended after its continue + bypass defaults. */
  claudeArgs?: string;
  /** Which agent CLI to reopen the folder with: claude (default) | codex. */
  agentType?: AgentType;
  // -- injectables (index.ts uses the defaults; tests override) --------------
  hubUrl?: string;
  baseDir?: string;
  tmux?: WireTmux;
  out?: OutFn;
  isTTY?: boolean;
  insideTmux?: boolean;
  attach?: (session: string) => Promise<number | void>;
  spawnKickoff?: (name: string, session: string, agentType: AgentType) => void;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
  /** Hub liveness strategy (default: auto-start a background sb-hub; see start.ts). */
  ensureHub?: (hubUrl: string, opts: { out: OutFn }) => Promise<void>;
  /** TEST-ONLY: binary in place of the agent type's own (never open a real one in tests). */
  claudeBin?: string;
}

export async function runWire(options: WireOptions): Promise<StartResult> {
  // The conversation to continue is the one of THIS folder (where the user
  // left claude and ran wire), so --dir defaults to the current directory.
  const dir = expandHome(options.dir ?? process.cwd());

  // Name defaults to the folder name (survives restarts, matches how the user
  // thinks of the window); an explicit --name overrides. The shared core
  // re-validates whatever name we hand it against AGENT_NAME_RE.
  const name = options.name ?? deriveAgentName(dir);

  // Apply the chosen CLI's continue + bypass defaults (deduped) and fail fast
  // on bad --claude-args quoting, BEFORE the shared core touches the Hub. See
  // buildWireClaudeArgs / the file header for why these two are the wire default.
  const agentType = options.agentType ?? DEFAULT_AGENT_TYPE;
  const claudeArgs = buildWireClaudeArgs(options.claudeArgs, agentType);

  return runAgentSession({
    mode: "wire",
    name,
    role: options.role,
    dir,
    kickoff: options.kickoff,
    claudeArgs,
    agentType,
    hubUrl: options.hubUrl,
    baseDir: options.baseDir,
    tmux: options.tmux,
    out: options.out,
    isTTY: options.isTTY,
    insideTmux: options.insideTmux,
    attach: options.attach,
    spawnKickoff: options.spawnKickoff,
    sleep: options.sleep,
    settleMs: options.settleMs,
    ensureHub: options.ensureHub,
    claudeBin: options.claudeBin,
  });
}

// ---------------------------------------------------------------------------
// commander wiring.
// ---------------------------------------------------------------------------

export function registerWireCommand(program: Command): void {
  program
    .command("wire")
    .description(
      "Adopts the current window into the network, continuing its conversation: leave claude, " +
        "run this in the same folder, and it reopens claude (claude -c) inside a dedicated tmux " +
        "session already connected to the Hub. Replaces a homonymous session if one exists.",
    )
    // No default value for --name: omitted → derive from the folder name; and
    // no default for --role (see start): omitted → PRESERVE the stored role.
    .option("--name <name>", "agent name (default: sanitized current folder name)")
    .option("--role <description>", "agent role (e.g.: \"API backend\")")
    .option("--dir <dir>", "folder whose conversation to continue (default: current directory)")
    .option("--no-kickoff", "do not inject the automatic join instruction after opening")
    .option(
      "--agent <type>",
      `which coding agent CLI to reopen the folder with: ${AGENT_TYPES.join(" | ")}`,
      DEFAULT_AGENT_TYPE,
    )
    .option(
      "--claude-args <args>",
      "extra arguments for the agent CLI, added after its continue + skip-approvals defaults",
    )
    .action(
      async (opts: {
        name?: string;
        role?: string;
        dir?: string;
        kickoff: boolean;
        claudeArgs?: string;
        agent?: string;
      }) => {
        await runCliAction(() =>
          runWire({
            name: opts.name,
            role: opts.role,
            dir: opts.dir,
            kickoff: opts.kickoff,
            claudeArgs: opts.claudeArgs,
            agentType: parseAgentTypeFlag(opts.agent),
          }).then(() => undefined),
        );
      },
    );
}
