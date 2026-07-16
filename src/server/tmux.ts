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
// guard is an ALLOW-LIST (default-DENY, exactly as PRD 10.3 mandates: "only
// nudge if the pane runs node/claude"): only node/claude (+ the claude-code
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

import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
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

/**
 * Default executor: execFile with an args ARRAY (P9), "tmux" from PATH.
 *
 * Failures are RE-THROWN SANITIZED: promisified execFile embeds the FULL
 * command line in err.message ("Command failed: tmux new-session … env
 * SWITCHBOARD_AGENT_TOKEN=<token> claude"), and the Phase 4 `start` passes
 * the capability token through new-session — echoing argv in an error that
 * can reach stderr would violate the v1.1 invariant "token NUNCA
 * impresso/logado". The sanitized message carries only the tmux subcommand,
 * the exit/errno code and tmux's own stderr (e.g. "duplicate session:
 * sb-alpha" — never contains the token); code/stderr also ride as properties
 * for programmatic callers/debugging.
 */
export const defaultExec: ExecFn = async (file, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { encoding: "utf8" });
    return { stdout, stderr };
  } catch (err) {
    const raw = err as NodeJS.ErrnoException & { stderr?: string };
    const stderr = typeof raw.stderr === "string" ? raw.stderr.trim() : "";
    const detail = stderr !== "" ? stderr : String(raw.code ?? "unknown error");
    const sanitized = new Error(
      `${file} ${args[0] ?? ""} failed: ${detail}`,
    ) as Error & { code?: string | number; stderr?: string };
    sanitized.code = raw.code as string | number | undefined;
    sanitized.stderr = stderr;
    throw sanitized;
  }
};

/**
 * ALLOW-LIST for the pane guard (PRD 10.3: "only nudge if the pane runs
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
  /** Present when sent === false: human-readable abort reason (English). */
  reason?: string;
}

/**
 * Quotes ONE argv element for the shell command tmux runs. Context: tmux's
 * `new-session [shell-command]` joins its trailing arguments with spaces and
 * executes the result via `sh -c` — it does NOT preserve argv boundaries. So
 * to give newSession real ARRAY semantics (each element = exactly one argv of
 * the final process — Phase 4 needs this for
 * `env SWITCHBOARD_AGENT_TOKEN=<token> claude <args>`), every element is
 * shell-quoted here before joining. POSIX single-quote strategy: wrap in
 * '…' and escape embedded single quotes as '\'' — safe for ANY content.
 * Exported for direct unit testing.
 */
export function quoteShellArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg; // no quoting needed
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Control mode (tmux -C) — the terminal view's backbone.
//
// Control mode is tmux's OWN protocol for embedding sessions in a GUI (it is
// how iTerm2 does it): a client whose stdio is plain line-based text, safe to
// drive through pipes from Node. What it buys over the previous approach
// (capture-pane snapshot + pipe-pane tee, both separate commands):
//
//   RACE-FREE FIRST FRAME. `%output` notifications and command responses
//   (%begin/%end blocks) arrive on ONE ordered stream: every byte the pane
//   emitted before a `capture-pane` response is already IN that capture, and
//   everything after follows as deltas. capture+pipe had an unclosable gap
//   between the snapshot and the tee — and Claude Code's TUI repaints
//   relative to the cursor several times a second, so any lost or duplicated
//   byte skewed the whole paint (the owner watched text write over other
//   text). There is no atomic snapshot+subscribe outside control mode.
//
//   SIZE AS POLICY, NOT FIGHTS. A control client has a real size
//   (`refresh-client -C WxH`) and a per-client `ignore-size` flag, so "the
//   Windows terminal owns the size while it is attached; the dashboard owns
//   it when alone" is two flag flips. Spike-validated (scratchpad
//   spike-cm2.cjs): with ignore-size set, a real client attaching takes the
//   window; with it cleared, refresh-client -C takes it back. NEVER
//   resize-window on a shared window: it pins the window to window-size
//   manual, after which no client (real or control) drives its size again.
//
// Two protocol gotchas, both spike-verified:
//   - `-CC` DIES when stdio is a pipe (it wants the iTerm2 DCS handshake);
//     plain `-C` works and does not echo commands.
//   - `#` starts a COMMENT in a control-mode command line, so any #{format}
//     argument must be single-quoted.
// ---------------------------------------------------------------------------

export interface ControlClientHandlers {
  /** Raw bytes the pane emitted (decoded from %output's octal escapes). */
  onOutput(paneId: string, bytes: Buffer): void;
  /** The window's layout/size changed (client resize, refresh-client, …). */
  onLayoutChange(): void;
  /** The client died: session killed, server gone, spawn failure. */
  onExit(reason: string): void;
}

export interface ControlClient {
  /**
   * Runs one tmux command through the control stream and resolves with its
   * %begin/%end (ok) or %begin/%error block. Commands are serialized: control
   * mode answers strictly in submission order, so a queue keeps responses
   * matched to their commands without trusting block numbers.
   */
  command(cmd: string): Promise<{ ok: boolean; out: string[] }>;
  kill(): void;
}

/**
 * Decodes the payload of a `%output` line into the pane's original bytes.
 *
 * tmux escapes NON-PRINTABLE bytes as \ooo octal (ESC is \033, etc.) but sends
 * printable UTF-8 RAW — so "código" arrives as the literal characters, already
 * decoded to a JS string by the StringDecoder upstream. A non-escaped char must
 * therefore be re-encoded as UTF-8 (Buffer.from(ch, "utf8")); the old
 * charCodeAt(i) & 0xff turned "ó" (U+00F3) into the single latin-1 byte 0xf3,
 * an invalid UTF-8 lead byte that xterm dropped — accents vanished from the
 * live stream. Octal runs still decode to their exact byte.
 */
export function decodeControlOutput(payload: string): Buffer {
  const parts: Buffer[] = [];
  let text = "";
  const flush = (): void => {
    if (text) {
      parts.push(Buffer.from(text, "utf8"));
      text = "";
    }
  };
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] === "\\" && /^[0-7]{3}$/.test(payload.slice(i + 1, i + 4))) {
      flush();
      parts.push(Buffer.from([parseInt(payload.slice(i + 1, i + 4), 8)]));
      i += 3;
    } else {
      text += payload[i];
    }
  }
  flush();
  return Buffer.concat(parts);
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
  /**
   * `tmux new-session -d -s <s> -c <cwd> [<cmd>]`. `cmd` as a STRING is a raw
   * sh command (legacy behavior, caller owns the quoting); as an ARRAY it has
   * argv semantics — each element becomes exactly one argument of the final
   * process (elements are shell-quoted before tmux's space-join, see
   * quoteShellArg).
   */
  newSession(session: string, cwd: string, cmd?: string | string[]): Promise<void>;
  /** `tmux capture-pane -t =<s>: -p -S -<lines>` (default 200 lines back). */
  capturePane(session: string, lines?: number): Promise<string>;
  /**
   * `tmux send-keys -t =<s>: -H <hex bytes>` — writes ARBITRARY bytes into the
   * pane, so Escape (1b) and Ctrl-C (03) arrive as real control characters
   * rather than as the words "Escape" and "C-c". LOW-LEVEL: no pane guard here;
   * the caller runs it (see terminal.ts).
   */
  sendKeysHex(session: string, bytes: Buffer): Promise<void>;
  /**
   * `tmux -C attach-session -t =<s>` — a long-lived CONTROL MODE client (see
   * the ControlClient docs below). This is the terminal view's backbone.
   */
  attachControlClient(session: string, handlers: ControlClientHandlers): ControlClient;
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
      `Invalid tmux session name: ${JSON.stringify(session)} (empty, containing ":" or spaces).`,
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
        `sendKeysLiteral: text contains \\r/\\n — nudges are ALWAYS a single line (P5). ` +
          `Flatten with replace(/[\\r\\n]+/g, " ") before sending.`,
      );
    }
    await exec("tmux", ["send-keys", "-t", paneTarget(session), "-l", "--", text]);
  }

  async function sendEnter(session: string): Promise<void> {
    assertValidSession(session);
    await exec("tmux", ["send-keys", "-t", paneTarget(session), "Enter"]);
  }

  async function newSession(
    session: string,
    cwd: string,
    cmd?: string | string[],
  ): Promise<void> {
    assertValidSession(session);
    const args = ["new-session", "-d", "-s", session, "-c", cwd];
    if (Array.isArray(cmd)) {
      // Argv semantics: tmux would space-join multiple trailing args into one
      // sh -c string anyway, so we do the join OURSELVES with each element
      // shell-quoted — array boundaries survive exactly (see quoteShellArg).
      args.push(cmd.map(quoteShellArg).join(" "));
    } else if (cmd !== undefined) {
      args.push(cmd);
    }
    await exec("tmux", args);

    // Pass the pane title through to the OUTER terminal (Windows Terminal tab,
    // etc.). Without this tmux swallows the app title and the WT tab shows the
    // launcher command ("wsl.exe") instead of Claude Code's chat name. #T is
    // the current pane title, which the Claude TUI sets to the session name.
    // NOTE: set-option's -t does NOT accept the "=NAME" exact-match prefix that
    // send-keys/has-session use (it errors "no such session: =NAME"); the plain
    // session name is unambiguous here (we just created it). Best-effort: a
    // titling failure must never fail session creation.
    try {
      await exec("tmux", ["set-option", "-t", session, "set-titles", "on"]);
      await exec("tmux", ["set-option", "-t", session, "set-titles-string", "#T"]);
    } catch {
      // older tmux / odd terminal — the session is up, only the tab title lags
    }
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

  async function sendKeysHex(session: string, bytes: Buffer): Promise<void> {
    assertValidSession(session);
    if (bytes.length === 0) return;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
    await exec("tmux", ["send-keys", "-t", paneTarget(session), "-H", ...hex]);
  }

  function attachControlClient(session: string, handlers: ControlClientHandlers): ControlClient {
    assertValidSession(session);
    // Direct spawn, not the ExecFn: a control client is a LONG-LIVED process
    // with a duplex stream, not a run-to-completion command. It is still this
    // file's job — tmux.ts is the only layer of the codebase executing tmux.
    const child = spawn("tmux", ["-C", "attach-session", "-t", sessionTarget(session)], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buf = "";
    let exited = false;
    let bannerDone = false;
    let stderrTail = "";

    // Commands resolve strictly in submission order (control mode answers in
    // order), so a FIFO of pending resolvers is enough — no block-number
    // bookkeeping, no interleaving headaches.
    interface Pending {
      resolve(result: { ok: boolean; out: string[] }): void;
      out: string[];
    }
    const pending: Pending[] = [];
    // True between a %begin and its %end/%error. Load-bearing: INSIDE a block,
    // EVERY line is command output — including lines that start with "%".
    // A pane id is "%19", so `list-panes -F '#{pane_id} …'` answers with lines
    // a notification filter would swallow; that exact bug shipped once and
    // returned empty results for any format starting with #{pane_id}.
    let inBlock = false;

    function fail(reason: string): void {
      if (exited) return;
      exited = true;
      for (const p of pending.splice(0)) p.resolve({ ok: false, out: [reason] });
      handlers.onExit(reason);
    }

    function handleLine(line: string): void {
      if (inBlock) {
        if (line.startsWith("%end") || line.startsWith("%error")) {
          inBlock = false;
          // The very first block is the attach BANNER — no command behind it.
          // Crediting it to the queue would shift every response one command
          // over (the first frame would read list-clients output as a pane
          // state and die).
          if (!bannerDone) {
            bannerDone = true;
            return;
          }
          const p = pending.shift();
          if (p) p.resolve({ ok: line.startsWith("%end"), out: p.out });
          return;
        }
        if (bannerDone && pending[0]) pending[0].out.push(line);
        return;
      }
      if (line.startsWith("%begin")) {
        inBlock = true;
        return;
      }
      if (line.startsWith("%output ")) {
        // "%output %<pane-id> <payload>"
        const space = line.indexOf(" ", 8);
        if (space === -1) return;
        handlers.onOutput(line.slice(8, space), decodeControlOutput(line.slice(space + 1)));
        return;
      }
      if (line.startsWith("%layout-change")) {
        handlers.onLayoutChange();
        return;
      }
      // Every other notification (%session-changed, %exit, …): not our business.
    }

    // StringDecoder, not d.toString("utf8"): capture-pane returns RAW UTF-8 in
    // its command block, and a chunk boundary that falls inside a multi-byte
    // char would turn "é" (c3 a9) into two replacement chars if each chunk were
    // decoded on its own. The decoder holds the trailing partial byte for the
    // next chunk. (%output is octal-escaped ASCII, so it never splits, but the
    // first frame is raw and did — accents vanished from it.)
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (d: Buffer) => {
      buf += decoder.write(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString("utf8")).slice(-300);
    });
    child.on("error", (err) => fail(`tmux control client failed to spawn: ${err.message}`));
    child.on("exit", (code) => {
      fail(
        `tmux control client exited (code ${code ?? "signal"})` +
          (stderrTail.trim() ? `: ${stderrTail.trim()}` : ""),
      );
    });

    return {
      command(cmd: string): Promise<{ ok: boolean; out: string[] }> {
        if (exited) return Promise.resolve({ ok: false, out: ["control client is gone"] });
        // One line per command; a stray newline would submit a second, queue-
        // desyncing command — same defense-in-depth reasoning as sendKeysLiteral.
        if (/[\r\n]/.test(cmd)) {
          return Promise.resolve({ ok: false, out: ["command must be a single line"] });
        }
        return new Promise((resolve) => {
          pending.push({ resolve, out: [] });
          child.stdin.write(cmd + "\n");
        });
      },
      kill(): void {
        if (exited) return;
        // detach-client is the polite exit; the hard kill is the backstop for
        // a wedged client (SIGKILL after a beat, if still alive).
        try {
          child.stdin.write("detach-client\n");
        } catch {
          /* stdin already gone */
        }
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 500).unref?.();
      },
    };
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
          `could not read pane_current_command of session "${session}" ` +
          `(session dead?): ${String((err as Error).message ?? err)} — fail-closed`,
      };
    }
    if (isSafePaneCommand(raw)) return { safe: true };
    return {
      safe: false,
      reason:
        `pane of session "${session}" is not safe for send-keys ` +
        `(pane_current_command=${JSON.stringify(raw)} outside the node/claude/cat allow-list — ` +
        `the text could be executed as a command)`,
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
          `pane became unsafe between the text and the Enter — Enter suppressed ` +
          `(${recheck.reason ?? "unknown reason"})`,
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
    sendKeysHex,
    attachControlClient,
    killSession,
    listSessions,
    isPaneSafeToNudge,
    nudgeSession,
  };
}
