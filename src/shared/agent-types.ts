// Agent-type adapter — the SINGLE source of truth for "which coding-agent CLI
// does Switchboard open in a tmux session, and how do we read its TUI".
//
// Switchboard has ONE flow (register → tmux session → readiness poll → guarded
// kickoff nudge). The only things that differ per agent CLI are the binary, the
// argv shape, and the two strings we look for in the pane. Those live here, in
// a descriptor per type, so nothing downstream ever branches on `if codex`.
//
// Home: src/shared/ because BOTH sides import it — src/cli/{start,wire}.ts and
// src/server/{launcher,api,store}.ts. The established direction is "server may
// read pure cli helpers, never the reverse", so a neutral module is the only
// legal home for something both need. This file therefore imports NOTHING from
// src/cli or src/server and stays side-effect-free.
//
// -- The codex argv order is load-bearing (verified live on codex-cli 0.144.3):
//
//   codex resume --last --dangerously-bypass-approvals-and-sandbox
//
// `resume` is a SUBCOMMAND (`codex resume [OPTIONS] [SESSION_ID] [PROMPT]`),
// not a flag like claude's `-c`, and the bypass flag must come AFTER it. The
// flag is declared on BOTH the top-level command and the `resume` subcommand,
// but it is NOT clap-`global`: passing it BEFORE the subcommand parses without
// error and is then SILENTLY DROPPED (the subcommand reads its own field).
// Proof, both invocations closed with a bogus arg to dump clap's usage line:
//   codex --dangerously-bypass-… resume --last --zzz  → "Usage: codex resume --last …"
//   codex resume --last --dangerously-bypass-… --zzz  → "Usage: codex resume --last --dangerously-bypass-… …"
// Only the second echoes the flag, i.e. only the second actually SET it. A
// bypass silently dropped means the agent stalls on an approval prompt forever
// with no error to show — hence buildArgs always emits the subcommand FIRST and
// every flag after it.
//
// Claude's descriptor is a verbatim move of the behavior that used to live in
// wire.ts/start.ts (flags, dedup rules, readiness markers) — byte-identical
// argv, so the existing suite is the regression guard.

// ---------------------------------------------------------------------------
// The type.
// ---------------------------------------------------------------------------

export const AGENT_TYPES = ["claude", "codex"] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

/**
 * What an omitted `--agent` / absent `agentType` means. Also what a LEGACY
 * agents.json record (written before this field existed) resolves to: those
 * agents were all launched with Claude Code, so "claude" is the only correct
 * reading of `undefined` — never a guess.
 */
export const DEFAULT_AGENT_TYPE: AgentType = "claude";

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === "string" && (AGENT_TYPES as readonly string[]).includes(value);
}

/** Anything unknown/absent (legacy records, omitted flags) → the default. */
export function resolveAgentType(value: unknown): AgentType {
  return isAgentType(value) ? value : DEFAULT_AGENT_TYPE;
}

/**
 * The ONE rejection message for a bad agent type, shared by the CLI (wrapped in
 * a CliError) and the REST layer (400 body) so both name the same options.
 */
export function invalidAgentTypeMessage(raw: unknown): string {
  const got = typeof raw === "string" ? `"${raw}"` : JSON.stringify(raw) ?? String(raw);
  return (
    `Invalid agent type: ${got}. Valid values: ${AGENT_TYPES.join(" | ")} ` +
    `(default: ${DEFAULT_AGENT_TYPE}).`
  );
}

// ---------------------------------------------------------------------------
// Claude Code flags (moved verbatim from wire.ts — the constants keep their
// old names as re-exports there so existing imports/tests do not move).
// ---------------------------------------------------------------------------

/** Continue-conversation flag prepended by default (and its long alias). */
export const CLAUDE_CONTINUE_FLAG = "-c";
export const CLAUDE_CONTINUE_ALIAS = "--continue";
/**
 * Resume-a-specific-session flags. When the user picks one we must NOT also
 * force `-c`: `-c` and `-r` are two conflicting conversation selectors and
 * claude rejects the mix.
 */
export const CLAUDE_RESUME_FLAG = "-r";
export const CLAUDE_RESUME_ALIAS = "--resume";
/** Permission-bypass flag prepended by default. */
export const CLAUDE_BYPASS_FLAG = "--dangerously-skip-permissions";
/**
 * The canonical alternate way to express a permission mode. Forcing
 * `--dangerously-skip-permissions` alongside a `--permission-mode <value>` is
 * rejected by recent claude builds (the session would die at birth), so when
 * the user sets a permission mode we do NOT also prepend the bypass default.
 */
export const CLAUDE_PERMISSION_MODE_FLAG = "--permission-mode";

// ---------------------------------------------------------------------------
// Codex CLI flags (codex-cli 0.144.3).
// ---------------------------------------------------------------------------

/**
 * Session-selecting SUBCOMMANDS. Unlike claude's `-c`, continuing a codex
 * conversation means `codex resume --last` — a subcommand plus a flag, which is
 * why buildArgs cannot be a simple "prepend to the user's args".
 */
export const CODEX_RESUME_SUBCOMMAND = "resume";
export const CODEX_FORK_SUBCOMMAND = "fork";
export const CODEX_SESSION_SUBCOMMANDS: readonly string[] = [
  CODEX_RESUME_SUBCOMMAND,
  CODEX_FORK_SUBCOMMAND,
];
/** Continue the most recent session instead of showing the resume picker. */
export const CODEX_LAST_FLAG = "--last";
/** Codex's equivalent of claude's --dangerously-skip-permissions. */
export const CODEX_BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";
/**
 * The user's own ways to express an approval/sandbox policy. Any of these means
 * "I chose the policy" — we then do NOT prepend the bypass default (same
 * reasoning as claude's --permission-mode).
 */
export const CODEX_APPROVAL_FLAGS: readonly string[] = [
  "-a",
  "--ask-for-approval",
  "-s",
  "--sandbox",
];

// NOTE ON CODEX'S `-c`: it is `--config <key=value>`, NOT continue. This is the
// exact trap a shared/global dedup list would fall into — treating `-c` as a
// continue marker for codex would misread `-c model="o3"` as "the user already
// continues" and silently drop the resume. Dedup is per-descriptor for this
// reason; never hoist these lists.

// ---------------------------------------------------------------------------
// The descriptor.
// ---------------------------------------------------------------------------

export interface BuildAgentArgsInput {
  /** true → resume this folder's previous conversation (claude -c / codex resume --last). */
  continueConversation?: boolean;
  /** The user's own extra args (already parsed into argv elements). */
  extraArgs?: readonly string[];
}

export interface AgentTypeDescriptor {
  readonly type: AgentType;
  /** Human label for the dashboard/CLI/docs (e.g. "Claude Code"). */
  readonly label: string;
  /** The binary Switchboard execs inside the tmux session. */
  readonly bin: string;
  /** How this CLI spells "continue", for user-facing messages ("claude -c"). */
  readonly continueHint: string;
  /**
   * The bit of argv that expresses continue, named on its own for the
   * auto-fallback's messages ("Retrying with a FRESH session (no -c)",
   * "died even without -c"). claude: "-c"; codex: "resume".
   */
  readonly continueArgHint: string;
  /**
   * Does the kickoff press Enter when it detects the trust dialog?
   * claude: NO — its flow has always relied on the human accepting it in the
   * attach, and the readiness poll simply waits it out. Keeping that false is
   * what makes this refactor behavior-preserving for claude.
   * codex: YES — Enter accepts its "Do you trust…" default ("1. Yes, continue").
   */
  readonly autoAcceptTrustDialog: boolean;

  /** The FULL argv that follows `bin`, defaults applied and deduped. */
  buildArgs(input: BuildAgentArgsInput): string[];
  /** Does this argv ask the CLI to continue a conversation? */
  hasContinue(argv: readonly string[]): boolean;
  /** The same argv with the continue request removed (the auto-fallback retry). */
  withoutContinue(argv: readonly string[]): string[];
  /** Is the TUI up and accepting a typed line? (NOT while the trust dialog is up.) */
  isTuiReady(pane: string): boolean;
  /** Is the pane showing the "do you trust this folder" dialog? */
  isTrustDialog(pane: string): boolean;
  /** argv for `<bin> mcp add …` registering the Hub (used by setup + docs). */
  mcpAddArgs(serverName: string, url: string): string[];
  /** argv for the idempotency probe `<bin> mcp get <name>`. */
  mcpGetArgs(serverName: string): string[];
}

// -- claude -------------------------------------------------------------------

/**
 * TUI readiness detection (spikes/NOTES.md, spike 0.3): a ready Claude Code
 * pane shows "? for shortcuts" under the input box, whose left border renders
 * as "│ >". While the trust dialog is up ("Quick safety check: Is this a
 * project you created or one you trust?") NONE of these markers are present —
 * and a blind kickoff there would type into a MENU where digits select options.
 *
 * IMPORTANT (observed with claude 2.1.205): a non-default permission mode
 * REPLACES "? for shortcuts" in the footer. Under `--permission-mode
 * bypassPermissions` the footer reads "⏵⏵ bypass permissions on (shift+tab to
 * cycle)" and "? for shortcuts" never appears — so we ALSO accept the
 * permission-mode footer markers, otherwise the kickoff of a bypass-mode agent
 * (the setup section 9.5 explicitly says is "already covered") would time out
 * and never fire. None of these strings appear in the trust dialog.
 */
function claudeIsTuiReady(pane: string): boolean {
  return (
    pane.includes("? for shortcuts") || // default footer
    pane.includes("│ >") || // legacy input-box left border
    pane.includes("shift+tab to cycle") || // any non-default permission mode
    pane.includes("bypass permissions on") ||
    pane.includes("accept edits on") ||
    pane.includes("plan mode on")
  );
}

export const claudeAgentType: AgentTypeDescriptor = {
  type: "claude",
  label: "Claude Code",
  bin: "claude",
  continueHint: "claude -c",
  continueArgHint: CLAUDE_CONTINUE_FLAG,
  autoAcceptTrustDialog: false,

  buildArgs({ continueConversation = false, extraArgs = [] }) {
    const prepend: string[] = [];

    const userContinues =
      extraArgs.includes(CLAUDE_CONTINUE_FLAG) || extraArgs.includes(CLAUDE_CONTINUE_ALIAS);
    const userResumes =
      extraArgs.includes(CLAUDE_RESUME_FLAG) || extraArgs.includes(CLAUDE_RESUME_ALIAS);
    if (continueConversation && !userContinues && !userResumes) {
      prepend.push(CLAUDE_CONTINUE_FLAG);
    }

    const userSetsPermissionMode = extraArgs.includes(CLAUDE_PERMISSION_MODE_FLAG);
    if (!extraArgs.includes(CLAUDE_BYPASS_FLAG) && !userSetsPermissionMode) {
      prepend.push(CLAUDE_BYPASS_FLAG);
    }

    return [...prepend, ...extraArgs];
  },

  hasContinue(argv) {
    return argv.includes(CLAUDE_CONTINUE_FLAG) || argv.includes(CLAUDE_CONTINUE_ALIAS);
  },

  withoutContinue(argv) {
    return argv.filter((a) => a !== CLAUDE_CONTINUE_FLAG && a !== CLAUDE_CONTINUE_ALIAS);
  },

  isTuiReady: claudeIsTuiReady,

  /**
   * Diagnostic only — autoAcceptTrustDialog is false, so nothing ever types
   * here. Wordings observed across claude 2.x builds.
   */
  isTrustDialog(pane) {
    return (
      pane.includes("Quick safety check") ||
      pane.includes("Do you trust the files in this folder") ||
      pane.includes("trust this folder")
    );
  },

  mcpAddArgs(serverName, url) {
    return ["mcp", "add", "--transport", "http", "--scope", "user", serverName, url];
  },

  mcpGetArgs(serverName) {
    return ["mcp", "get", serverName];
  },
};

// -- codex --------------------------------------------------------------------

/**
 * A ready Codex TUI paints its header box line `>_ OpenAI Codex (v0.144.3)`.
 * Verified live: that line is NOT on screen while the trust dialog is up, so it
 * cleanly separates "ready" from "waiting on a dialog where Enter/digits pick
 * an option". The `\s+` tolerates the box's own padding; the explicit
 * trust-dialog veto below is belt-and-braces — readiness must NEVER be true
 * while a dialog owns the keyboard, even if a future build adds the header to
 * the dialog screen.
 */
const CODEX_HEADER_RE = />_\s+OpenAI Codex/;

export const codexAgentType: AgentTypeDescriptor = {
  type: "codex",
  label: "Codex CLI",
  bin: "codex",
  continueHint: "codex resume --last",
  continueArgHint: CODEX_RESUME_SUBCOMMAND,
  // Codex's trust dialog takes Enter on its "1. Yes, continue" default; unlike
  // claude's flow there is no human attached by contract (the dashboard
  // launches headless), so the kickoff accepts it itself — through the guarded
  // path (pane must be on the allow-list; codex's pane_current_command is
  // "node", already allowed, so no security change was needed for this).
  autoAcceptTrustDialog: true,

  buildArgs({ continueConversation = false, extraArgs = [] }) {
    // The user's args may THEMSELVES open with a session subcommand
    // ("resume"/"fork"). If so it must stay first and our bypass must land
    // after it — see the file header on why a flag before the subcommand is
    // silently dropped.
    const rest = [...extraArgs];
    const userSubcommand =
      rest.length > 0 && CODEX_SESSION_SUBCOMMANDS.includes(rest[0])
        ? (rest.shift() as string)
        : undefined;

    const argv: string[] = [];
    if (userSubcommand !== undefined) {
      argv.push(userSubcommand); // the user chose the session shape; respect it
    } else if (continueConversation) {
      argv.push(CODEX_RESUME_SUBCOMMAND, CODEX_LAST_FLAG);
    }

    const userSetsApproval = rest.some(
      (a) => a === CODEX_BYPASS_FLAG || CODEX_APPROVAL_FLAGS.includes(a),
    );
    if (!userSetsApproval) argv.push(CODEX_BYPASS_FLAG);

    argv.push(...rest);
    return argv;
  },

  hasContinue(argv) {
    return argv.length > 0 && CODEX_SESSION_SUBCOMMANDS.includes(argv[0]);
  },

  withoutContinue(argv) {
    if (!codexAgentType.hasContinue(argv)) return [...argv];
    // Drop the subcommand AND its --last: `codex --last` is not a thing at the
    // top level, so leaving it behind would break the fallback retry at birth.
    return argv.slice(1).filter((a) => a !== CODEX_LAST_FLAG);
  },

  isTuiReady(pane) {
    if (codexAgentType.isTrustDialog(pane)) return false;
    return CODEX_HEADER_RE.test(pane);
  },

  isTrustDialog(pane) {
    return (
      pane.includes("Do you trust the contents of this directory") ||
      (pane.includes("Yes, continue") && pane.includes("No, quit"))
    );
  },

  mcpAddArgs(serverName, url) {
    // `codex mcp add <NAME> --url <URL>` — streamable HTTP, the same transport
    // the Hub already serves at /mcp for claude.
    return ["mcp", "add", serverName, "--url", url];
  },

  mcpGetArgs(serverName) {
    return ["mcp", "get", serverName];
  },
};

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

const DESCRIPTORS: Readonly<Record<AgentType, AgentTypeDescriptor>> = {
  claude: claudeAgentType,
  codex: codexAgentType,
};

/**
 * THE lookup. Accepts anything (an omitted flag, a legacy agents.json record,
 * an unvalidated value) and always answers a descriptor — unknown → the default
 * (claude). Callers that must REJECT a bad value validate first with
 * isAgentType + invalidAgentTypeMessage; callers that must merely READ one
 * (the dashboard chip, a reopen of a pre-existing record) resolve it here.
 */
export function agentTypeDescriptor(value?: unknown): AgentTypeDescriptor {
  return DESCRIPTORS[resolveAgentType(value)];
}

/** Every descriptor, for surfaces that enumerate the choice (docs, help text). */
export function allAgentTypeDescriptors(): AgentTypeDescriptor[] {
  return AGENT_TYPES.map((t) => DESCRIPTORS[t]);
}
