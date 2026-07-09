// tmux wrapper (PRD section 10.3) — the ONLY layer of the codebase that
// executes tmux. Everything goes through child_process.execFile with an ARRAY
// of args (never `exec` with an interpolated string — pitfall P9), binary
// "tmux" resolved from PATH.
//
// Target syntax (spikes/NOTES.md, validated on tmux 3.4):
// - target-SESSION commands (has-session, kill-session): `-t "=NAME"` (the
//   leading "=" forces an exact match — without it tmux resolves by prefix
//   and `kill-session -t sb-alpha` could kill sb-alpha-other).
// - target-PANE/WINDOW commands (send-keys, capture-pane, list-panes):
//   `-t "=NAME"` FAILS with "can't find pane"; the correct form is
//   `-t "=NAME:"` (the colon qualifies session:window).
//
// Non-negotiable security guard (PRD 10.3, pitfall P2, section 15): before
// ANY send-keys, the pane's current command is checked. If Claude Code was
// closed but the tmux session survived, the pane is sitting on a SHELL and a
// send-keys there would EXECUTE the nudge text as a command (local RCE). The
// guard is an ALLOW-LIST (default-DENY, exactly as PRD 10.3 mandates: "só
// nudgar se o pane roda node/claude"): only node/claude (+ the claude-code
// variant) and cat (required by the Phase 3 Done When, PRD section 16) may
// receive keys. EVERYTHING else — shells, but also REPLs/remotes that would
// interpret or forward the typed text (python, ssh, nc, psql, pwsh, …) — is
// unsafe, and so is an unreadable/empty pane command (fail-closed). The
// guard also re-runs right before the separate Enter (see nudgeSession):
// text sitting unsubmitted at a prompt is inert; the Enter is what executes.
//
// P1/P5: sendKeysLiteral always passes `-l` (literal; without it tmux
// interprets key names) and `--` before the text (shields texts starting
// with "-"). Text with \r/\n is REJECTED here (a newline would submit
// partial input — the dispatcher already flattens, this is defense in
// depth). Enter goes in a SEPARATE tmux command after a delay (~500ms,
// validated in spike 0.2/0.3): text + Enter in one command types but does
// not submit in TUIs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Injectable executor (unit tests mock it). MUST reject on non-zero exit,
 * like promisified execFile does.
 */
export type ExecFn = (file: string, args: string[]) => Promise<ExecResult>;

const execFileAsync = promisify(execFile);

/** Default executor: execFile with an args ARRAY (P9), "tmux" from PATH. */
export const defaultExec: ExecFn = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, args, { encoding: "utf8" });
  return { stdout, stderr };
};

/**
 * ALLOW-LIST for the pane guard (PRD 10.3: "só nudgar se o pane roda
 * node/claude" — default-deny). Anything NOT here is unsafe: every shell
 * (bash/zsh/pwsh/nu/…), every REPL or remote (python/ssh/psql/nc/…) would
 * interpret or forward the typed nudge as a command. Members:
 * - node / claude / claude-code: the processes a live Claude Code pane shows;
 * - cat: inert (does not interpret input), mandated by the Phase 3 Done When
 *   (PRD section 16) and used by spike 0.2 and the integration tests.
 * Extend DELIBERATELY (with a test) if a real Claude Code build ever reports
 * a different pane_current_command — never widen to "not a shell".
 */
const SAFE_PANE_COMMANDS: ReadonlySet<string> = new Set([
  "node",
  "claude",
  "claude-code",
  "cat",
]);

/**
 * Normalizes one pane_current_command line for the guard: trim, lowercase,
 * basename (defensive: the format normally yields a bare name), and strip a
 * leading "-" (login-shell argv[0] convention, e.g. "-bash").
 */
function normalizePaneCommand(line: string): string {
  let cmd = line.trim().toLowerCase();
  const slash = cmd.lastIndexOf("/");
  if (slash !== -1) cmd = cmd.slice(slash + 1);
  if (cmd.startsWith("-")) cmd = cmd.slice(1);
  return cmd;
}

/**
 * Pure classification of a pane_current_command value (may contain multiple
 * lines when the session has several panes — send-keys would hit one of
 * them, so EVERY pane must be on the allow-list). FAIL-CLOSED / default-deny:
 * empty or unknown → unsafe. Exported for direct unit testing.
 */
export function isSafePaneCommand(raw: string): boolean {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return false; // fail-closed: empty/unknown
  for (const line of lines) {
    const cmd = normalizePaneCommand(line);
    if (!SAFE_PANE_COMMANDS.has(cmd)) return false; // default-deny (PRD 10.3)
  }
  return true; // every pane runs node/claude/claude-code/cat
}

export interface NudgeResult {
  sent: boolean;
  /** Present when sent === false: human-readable abort reason (Portuguese). */
  reason?: string;
}

export interface Tmux {
  /** `tmux has-session -t =<s>` — true/false via exit code, never throws. */
  hasSession(session: string): Promise<boolean>;
  /** `tmux list-panes -t =<s>: -F '#{pane_current_command}'` (trimmed stdout). */
  paneCommand(session: string): Promise<string>;
  /**
   * `tmux send-keys -t =<s>: -l -- <text>`. Throws if text contains \r/\n
   * (defense in depth — P5). LOW-LEVEL: does NOT run the pane guard; every
   * nudge path must go through nudgeSession.
   */
  sendKeysLiteral(session: string, text: string): Promise<void>;
  /** `tmux send-keys -t =<s>: Enter` — always a SEPARATE command (P1). */
  sendEnter(session: string): Promise<void>;
  /** `tmux new-session -d -s <s> -c <cwd> [<cmd>]`. */
  newSession(session: string, cwd: string, cmd?: string): Promise<void>;
  /** `tmux capture-pane -t =<s>: -p -S -<lines>` (default 200 lines back). */
  capturePane(session: string, lines?: number): Promise<string>;
  /** `tmux kill-session -t =<s>`. */
  killSession(session: string): Promise<void>;
  /** Session names starting with prefix; [] when the tmux server is down. */
  listSessions(prefix: string): Promise<string[]>;
  /**
   * THE pane guard (PRD 10.3, non-negotiable). FAIL-CLOSED: error reading the
   * pane, empty output or any shell pane → false. Used by every send-keys
   * path (nudgeSession); never bypassed.
   */
  isPaneSafeToNudge(session: string): Promise<boolean>;
  /**
   * High-level nudge: checks the guard, sends the (flattened) text literally,
   * waits enterDelayMs, RE-CHECKS the guard (TOCTOU: the pane may have fallen
   * back to a shell during the delay) and only then sends Enter as a SEPARATE
   * command. Returns {sent:false, reason} when either check aborts — it never
   * types into an unsafe pane, and never submits Enter into one.
   */
  nudgeSession(session: string, text: string, enterDelayMs: number): Promise<NudgeResult>;
}

export interface TmuxOptions {
  /** Injectable executor for unit tests (default: execFile("tmux", args)). */
  exec?: ExecFn;
  /** Injectable sleep for tests (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Session names come from config.tmuxSessionPrefix + agent name, but the
 * exact-target syntax ("=" / "=…:") breaks with ":" or whitespace — reject
 * early with a clear error instead of producing a wrong tmux target.
 */
function assertValidSession(session: string): void {
  if (session.length === 0 || /[:\s]/.test(session)) {
    throw new Error(
      `Nome de sessão tmux inválido: ${JSON.stringify(session)} (vazio, com ":" ou espaços).`,
    );
  }
}

export function createTmux(options: TmuxOptions = {}): Tmux {
  const exec = options.exec ?? defaultExec;
  const sleep = options.sleep ?? defaultSleep;

  const sessionTarget = (session: string): string => `=${session}`;
  const paneTarget = (session: string): string => `=${session}:`;

  async function hasSession(session: string): Promise<boolean> {
    assertValidSession(session);
    try {
      await exec("tmux", ["has-session", "-t", sessionTarget(session)]);
      return true;
    } catch {
      return false;
    }
  }

  async function paneCommand(session: string): Promise<string> {
    assertValidSession(session);
    const { stdout } = await exec("tmux", [
      "list-panes",
      "-t",
      paneTarget(session),
      "-F",
      "#{pane_current_command}",
    ]);
    return stdout.trim();
  }

  async function sendKeysLiteral(session: string, text: string): Promise<void> {
    assertValidSession(session);
    if (/[\r\n]/.test(text)) {
      // P5: a newline in the middle would submit partial input; the caller
      // (dispatcher) already flattens — reaching here is a programming error.
      throw new Error(
        `sendKeysLiteral: texto contém \\r/\\n — nudges são SEMPRE uma linha (P5). ` +
          `Achate com replace(/[\\r\\n]+/g, " ") antes de enviar.`,
      );
    }
    await exec("tmux", ["send-keys", "-t", paneTarget(session), "-l", "--", text]);
  }

  async function sendEnter(session: string): Promise<void> {
    assertValidSession(session);
    await exec("tmux", ["send-keys", "-t", paneTarget(session), "Enter"]);
  }

  async function newSession(session: string, cwd: string, cmd?: string): Promise<void> {
    assertValidSession(session);
    const args = ["new-session", "-d", "-s", session, "-c", cwd];
    if (cmd !== undefined) args.push(cmd);
    await exec("tmux", args);
  }

  async function capturePane(session: string, lines = 200): Promise<string> {
    assertValidSession(session);
    const { stdout } = await exec("tmux", [
      "capture-pane",
      "-t",
      paneTarget(session),
      "-p",
      "-S",
      `-${lines}`,
    ]);
    return stdout;
  }

  async function killSession(session: string): Promise<void> {
    assertValidSession(session);
    await exec("tmux", ["kill-session", "-t", sessionTarget(session)]);
  }

  async function listSessions(prefix: string): Promise<string[]> {
    try {
      const { stdout } = await exec("tmux", ["list-sessions", "-F", "#{session_name}"]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name !== "" && name.startsWith(prefix));
    } catch {
      // tmux server down (no sessions at all) exits non-zero: empty list.
      return [];
    }
  }

  /** Guard core, shared by isPaneSafeToNudge and nudgeSession (rich reason). */
  async function paneSafety(
    session: string,
  ): Promise<{ safe: boolean; reason?: string }> {
    let raw: string;
    try {
      raw = await paneCommand(session);
    } catch (err) {
      return {
        safe: false,
        reason:
          `não foi possível ler o pane_current_command da sessão "${session}" ` +
          `(sessão morta?): ${String((err as Error).message ?? err)} — fail-closed`,
      };
    }
    if (isSafePaneCommand(raw)) return { safe: true };
    return {
      safe: false,
      reason:
        `pane da sessão "${session}" não é seguro para send-keys ` +
        `(pane_current_command=${JSON.stringify(raw)} fora da allow-list node/claude/cat — ` +
        `o texto poderia ser executado como comando)`,
    };
  }

  async function isPaneSafeToNudge(session: string): Promise<boolean> {
    return (await paneSafety(session)).safe;
  }

  async function nudgeSession(
    session: string,
    text: string,
    enterDelayMs: number,
  ): Promise<NudgeResult> {
    assertValidSession(session);
    // Defense in depth: the dispatcher flattens too, but ANY caller of the
    // high-level nudge gets a single line (P5). The message BODY never comes
    // through here — only the short notification text (PRD 10.2).
    const flat = text.replace(/[\r\n]+/g, " ");

    // Non-negotiable guard (10.3/P2): never send-keys into an unsafe pane.
    const safety = await paneSafety(session);
    if (!safety.safe) {
      return { sent: false, reason: safety.reason };
    }

    await sendKeysLiteral(session, flat);
    await sleep(enterDelayMs); // P1: text and Enter in one command types but does not submit

    // TOCTOU re-check: the pane may have fallen back to a shell during the
    // ~500ms delay (claude crash/Ctrl-C — the exact P2 scenario). Text sitting
    // unsubmitted at a prompt is inert; the Enter is what would EXECUTE it, so
    // the guard runs again immediately before the Enter and suppresses it.
    const recheck = await paneSafety(session);
    if (!recheck.safe) {
      return {
        sent: false,
        reason:
          `pane ficou inseguro entre o texto e o Enter — Enter suprimido ` +
          `(${recheck.reason ?? "motivo desconhecido"})`,
      };
    }

    await sendEnter(session);
    return { sent: true };
  }

  return {
    hasSession,
    paneCommand,
    sendKeysLiteral,
    sendEnter,
    newSession,
    capturePane,
    killSession,
    listSessions,
    isPaneSafeToNudge,
    nudgeSession,
  };
}
