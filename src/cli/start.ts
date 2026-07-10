// `switchboard start <name>` (PRD section 11) — the command the user runs
// instead of opening `claude` by hand — plus the hidden `kickoff-agent`
// subcommand that the detached kickoff process re-enters through.
//
// Sequence (PRD 11, steps 1-6):
//   1. validate the name (same regex as the store) + hub alive on /api/health;
//   2. refuse if the tmux session already exists (pitfall P7);
//   3. POST /api/agents/register → capability token (v1.1). The token is kept
//      in a local variable, injected into the session env and NEVER printed,
//      logged or returned;
//   4. tmux new-session (via tmux.ts, argv as ARRAY) running
//      `env SWITCHBOARD_AGENT_NAME=<name> SWITCHBOARD_AGENT_TOKEN=<token>
//       claude <claude-args>`; prints the section 9.5 permissions reminder on
//      the first execution (P10);
//   5. TTY → tmux attach (interactive; see defaultAttach for the sanctioned
//      exception to "all tmux via tmux.ts"); no TTY / already inside tmux →
//      prints how to attach;
//   6. kickoff (default ON, --no-kickoff disables): a DETACHED process (the
//      attach of step 5 blocks this terminal) that waits kickoffDelayMs, then
//      polls the TUI for READINESS and only then injects the kickoff line via
//      the guarded nudge path (tmux.nudgeSession).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { defaultBaseDir, loadConfig } from "../server/config.js";
import { AGENT_NAME_RE } from "../server/store.js";
import { createTmux, type NudgeResult, type Tmux } from "../server/tmux.js";
import type { PublicAgent } from "../shared/types.js";
import {
  CliError,
  ensureHubUp,
  defaultHubUrl,
  hubPost,
  runCliAction,
  type OutFn,
} from "./common.js";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/cli.test.ts).
// ---------------------------------------------------------------------------

/**
 * Splits the --claude-args string into argv elements. DECISION (documented as
 * the task demands): no external lib and no `sh -c` passthrough — a simple
 * quote-aware splitter covering the practical subset: tokens separated by
 * whitespace; '…' and "…" group a token (quotes stripped, whitespace
 * preserved); NO escape processing inside quotes (this is not a shell).
 * Unterminated quote → clear error instead of silently guessing. Each element
 * then travels with exact argv semantics through tmux.newSession(array) —
 * see quoteShellArg in tmux.ts.
 */
export function parseClaudeArgs(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const args: string[] = [];
  let current = "";
  let hasCurrent = false;
  let quote: '"' | "'" | null = null;
  for (const ch of raw) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasCurrent = true; // '' counts as an (empty) token
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasCurrent) {
        args.push(current);
        current = "";
        hasCurrent = false;
      }
      continue;
    }
    current += ch;
    hasCurrent = true;
  }
  if (quote !== null) {
    throw new CliError(
      `--claude-args has unterminated quotes (${quote}): ${raw}\n` +
        `Close the quotes — e.g.: --claude-args "--model opus --append-system-prompt 'text with spaces'"`,
    );
  }
  if (hasCurrent) args.push(current);
  return args;
}

/**
 * argv (PRD 11 step 4): `env SWITCHBOARD_AGENT_NAME=<name>
 * SWITCHBOARD_AGENT_TOKEN=<token> claude <claude-args>`. Built as an ARRAY —
 * tmux.newSession preserves each element as one argv of the final process.
 * The token rides ONLY here (env of the agent's session, per the v1.1
 * addendum); callers must never print/log this array. `claudeArgs` accepts
 * the raw --claude-args string OR a pre-parsed argv array — runStart
 * pre-parses in step 1a so bad quoting fails BEFORE the register mutates the
 * hub. `claudeBin` is a test-only injection point (integration tests run
 * `sh`/`cat` instead of a real claude — PRD: "never open a real claude in
 * tests").
 */
export function buildAgentCommand(input: {
  name: string;
  token: string;
  claudeArgs?: string | string[];
  claudeBin?: string;
}): string[] {
  const extraArgs = Array.isArray(input.claudeArgs)
    ? input.claudeArgs
    : parseClaudeArgs(input.claudeArgs);
  return [
    "env",
    `SWITCHBOARD_AGENT_NAME=${input.name}`,
    `SWITCHBOARD_AGENT_TOKEN=${input.token}`,
    input.claudeBin ?? "claude",
    ...extraArgs,
  ];
}

/**
 * EXACT kickoff text from PRD 11 step 6 — one line, never contains the token
 * (the agent reads it from its own env, as the join tool description says).
 */
export function kickoffText(name: string): string {
  return (
    `[switchboard] You are the agent '${name}' on this local agent network. ` +
    `Confirm by calling the join tool with agent_name="${name}". ` +
    `Then continue your work normally; when you receive [switchboard] notifications, use check_messages.`
  );
}

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
export function isTuiReady(pane: string): boolean {
  return (
    pane.includes("? for shortcuts") || // default footer
    pane.includes("│ >") || // legacy input-box left border
    pane.includes("shift+tab to cycle") || // any non-default permission mode
    pane.includes("bypass permissions on") ||
    pane.includes("accept edits on") ||
    pane.includes("plan mode on")
  );
}

// ---------------------------------------------------------------------------
// Kickoff runner (the detached `switchboard kickoff-agent <name>` process).
// ---------------------------------------------------------------------------

/** Narrow tmux surface the kickoff needs (injectable for unit tests). */
export interface KickoffTmux {
  hasSession(session: string): Promise<boolean>;
  capturePane(session: string, lines?: number): Promise<string>;
  nudgeSession(session: string, text: string, enterDelayMs: number): Promise<NudgeResult>;
}

export interface KickoffOptions {
  name: string;
  /** Session override (default: config.tmuxSessionPrefix + name). */
  session?: string;
  /** Config dir (default ~/.switchboard). */
  baseDir?: string;
  tmux?: KickoffTmux;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Initial wait before the first readiness poll (default config.kickoffDelayMs). */
  delayMs?: number;
  /** Delay between kickoff text and Enter (default config.nudgeEnterDelayMs). */
  enterDelayMs?: number;
  /** Extra readiness budget after the initial delay (default 60s). */
  readinessTimeoutMs?: number;
  /** Readiness poll cadence (default 2s). */
  readinessPollMs?: number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits kickoffDelayMs, then polls the pane for TUI readiness and ONLY THEN
 * injects the kickoff line through the guarded nudge path (tmux.nudgeSession:
 * pane-command allow-list, -l/--, separate Enter, TOCTOU re-check).
 *
 * Why the readiness poll exists (spikes/NOTES.md, spike 0.3, wording of
 * claude 2.1.205): in a --dir never trusted before, the TUI sits on the
 * "Quick safety check: Is this a project you created or one you trust?"
 * dialog — a BLIND kickoff after the 8s delay would type text into a menu
 * where DIGITS SELECT OPTIONS. So after the delay we capture-pane every 2s
 * for up to ~60 extra seconds looking for the readiness markers observed in
 * the spike ("? for shortcuts" / "│ >") and give up (message stays queued for
 * a manual join) if they never appear. The pane guard is NOT a substitute for
 * this: the trust dialog runs inside the claude process, so the guard alone
 * would happily type into it.
 */
export async function runKickoffAgent(options: KickoffOptions): Promise<NudgeResult> {
  const config = loadConfig(options.baseDir);
  const session = options.session ?? config.tmuxSessionPrefix + options.name;
  const tmux = options.tmux ?? createTmux();
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const delayMs = options.delayMs ?? config.kickoffDelayMs;
  const enterDelayMs = options.enterDelayMs ?? config.nudgeEnterDelayMs;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 60_000;
  const readinessPollMs = options.readinessPollMs ?? 2_000;

  await sleep(delayMs);

  const deadline = now() + readinessTimeoutMs;
  for (;;) {
    if (!(await tmux.hasSession(session))) {
      return {
        sent: false,
        reason: `session "${session}" no longer exists — kickoff canceled`,
      };
    }
    let pane = "";
    try {
      pane = await tmux.capturePane(session, 200);
    } catch {
      pane = ""; // pane unreadable this round — treated as not ready
    }
    if (isTuiReady(pane)) break;
    if (now() >= deadline) {
      return {
        sent: false,
        reason:
          `the claude TUI did not become ready in ${readinessTimeoutMs}ms after the initial delay ` +
          `(trust dialog pending? accept it in the attach) — kickoff not sent; ` +
          `the agent can call the join tool manually`,
      };
    }
    await sleep(readinessPollMs);
  }

  // Guarded nudge path (PRD 11 step 6: "same function as the dispatcher, with
  // the same pane guard"). Text is one line by construction; no token.
  return tmux.nudgeSession(session, kickoffText(options.name), enterDelayMs);
}

// ---------------------------------------------------------------------------
// start runner.
// ---------------------------------------------------------------------------

/** Narrow tmux surface `start` (and `wire`) need (injectable for integration tests). */
export interface StartTmux {
  hasSession(session: string): Promise<boolean>;
  newSession(session: string, cwd: string, cmd?: string | string[]): Promise<void>;
  /**
   * Used ONLY by wire mode to SUBSTITUTE an existing session (kill it before
   * recreating). Optional so start's callers/test doubles need not provide it;
   * runAgentSession asserts its presence when mode === "wire".
   */
  killSession?(session: string): Promise<void>;
}

export interface StartOptions {
  name: string;
  role?: string;
  /** Working dir for the agent (default: process.cwd()); "~" is expanded. */
  dir?: string;
  /** Kickoff on/off (default true; --no-kickoff sets false). */
  kickoff?: boolean;
  claudeArgs?: string;
  // -- injectables (index.ts uses the defaults; tests override) --------------
  hubUrl?: string;
  /** Config + permissions-reminder marker dir (default ~/.switchboard). */
  baseDir?: string;
  tmux?: StartTmux;
  out?: OutFn;
  isTTY?: boolean;
  /** Running inside tmux already? (default: !!process.env.TMUX). */
  insideTmux?: boolean;
  /**
   * Interactive attach (default: spawn tmux attach with stdio inherit).
   * Resolves with the attach exit code — non-zero means the attach FAILED
   * (e.g. stdin is a pipe: "open terminal failed") and the user never saw
   * the session, so runStart prints how to attach instead of "Detached".
   */
  attach?: (session: string) => Promise<number | void>;
  /** Detached kickoff spawner (default: re-enters via `kickoff-agent`). */
  spawnKickoff?: (name: string, session: string) => void;
  /** Injectable sleep (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Post-create liveness settle window in ms (default START_SETTLE_MS). */
  settleMs?: number;
  /**
   * Hub liveness strategy (default ensureHubUp: auto-starts a background
   * sb-hub when down). Tests inject checkHubHealth-like behavior to keep the
   * old fail-fast without booting anything.
   */
  ensureHub?: (hubUrl: string, opts: { out: OutFn }) => Promise<void>;
  /** TEST-ONLY: binary in place of "claude" (never open a real claude in tests). */
  claudeBin?: string;
}

/** Expands a leading "~" (the shell does not expand it inside --dir values). */
export function expandHome(dir: string): string {
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

/**
 * Section 9.5 permissions reminder (pitfall P10), printed on the FIRST
 * execution only — tracked by a marker file in the data dir.
 */
export const REMINDER_MARKER = ".start-permissions-reminder-shown";

function printPermissionsReminderOnce(baseDir: string, out: OutFn): void {
  const marker = path.join(baseDir, REMINDER_MARKER);
  if (fs.existsSync(marker)) return;
  out(
    `Permissions reminder (only on this first run): for the Switchboard tools to run ` +
      `without an approval prompt on every use, add the allow rule "mcp__switchboard__*" ` +
      `to the permissions in Claude Code's settings.json. Anyone using bypassPermissions is already covered.`,
  );
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString() + "\n");
  } catch {
    // Marker write failure only means the reminder repeats — never fatal.
  }
}

/**
 * DOCUMENTED EXCEPTION to "the CLI never runs tmux outside tmux.ts": attach
 * is INTERACTIVE — it takes over the user's terminal until detach — so it
 * cannot go through execFile (which buffers stdio). spawn with stdio
 * "inherit", args as an array (P9 still holds: no string interpolation), and
 * the exact-match "=" target from the spike findings.
 */
function defaultAttach(session: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", ["attach-session", "-t", `=${session}`], {
      stdio: "inherit",
    });
    child.on("error", reject);
    // Resolve WITH the exit code: `tmux attach` fails immediately when the
    // terminal is not usable ("open terminal failed: not a terminal") or the
    // session died — swallowing that would make runStart print "Detached…
    // keeps running" for a session the user never saw.
    child.on("exit", (code, signal) => resolve(signal !== null ? 1 : (code ?? 1)));
  });
}

/**
 * Default kickoff spawner: a DETACHED re-entry into this same CLI
 * (`switchboard kickoff-agent <name>`, hidden command) — detached + unref +
 * stdio ignore, because the attach in step 5 blocks this terminal and the
 * kickoff must keep running behind it (and survive the CLI exiting). Re-entry
 * uses process.execPath + process.execArgv, which carry the tsx loader flags
 * (verified: tsx re-execs node with --require/--import in execArgv), so the
 * .ts entry resolves without a build step.
 */
function defaultSpawnKickoff(name: string, session: string, out: OutFn = console.log): void {
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    [...process.execArgv, entry, "kickoff-agent", name, session],
    { detached: true, stdio: "ignore" },
  );
  // spawn failures (EMFILE/ENOMEM/EAGAIN under pressure) are emitted
  // ASYNCHRONOUSLY as an "error" event — without a handler they would crash
  // the whole start AFTER its success output. The kickoff is best-effort:
  // warn and move on (same language as runKickoffAgent when it gives up).
  child.on("error", () => {
    out(
      `Could not schedule the kickoff (failed to create the background process) — ` +
        `the agent can call the join tool manually.`,
    );
  });
  child.unref();
}

interface RegisterResponse {
  ok: boolean;
  agent: PublicAgent;
  token: string;
}

export interface StartResult {
  tmuxSession: string;
  cwd: string;
  /**
   * wire only: true when `claude -c` had no resumable conversation and the
   * session was automatically recreated FRESH (without -c) — the owner-chosen
   * auto-fallback instead of failing.
   */
  fallback?: boolean;
}

/**
 * Settle window after new-session: enough for `sh -c` + env to fail on a
 * missing binary/bad args (probe: dies in <1s, usually instantly) without
 * making every start sluggish.
 */
export const START_SETTLE_MS = 400;

/**
 * Wire uses a longer settle: `claude -c` does NOT fail instantly — it launches,
 * tries to resume the folder's conversation, and only then may exit non-zero
 * (observed ~1-2s: e.g. a conversation created in `-p`/print mode makes
 * interactive `-c` abort with "No deferred tool marker found in the resumed
 * session. Provide a prompt to continue."). 400ms would miss that death and
 * print a false "wired" success over a dead session, so wire waits longer.
 */
export const WIRE_SETTLE_MS = 2500;

/** Shared guidance for the concurrent-start race (two starts, same name). */
function concurrentStartHint(name: string): string {
  return (
    `If another "switchboard start ${name}" ran at the same time, note: THIS registration ` +
    `regenerated the agent's token, so the join of the surviving session will fail. ` +
    `Run "switchboard stop ${name}" and then a fresh "switchboard start ${name}".`
  );
}

export interface AgentSessionOptions extends Omit<StartOptions, "claudeArgs"> {
  /**
   * The single behavioral switch between the two entry points: "start" REFUSES
   * an already-existing session (P7); "wire" SUBSTITUTES it (kills the previous
   * incarnation, then recreates). Everything else — register → token →
   * new-session → attach → kickoff — is identical, which is why they share this
   * core instead of copying it.
   */
  mode: "start" | "wire";
  /**
   * Raw --claude-args string (start parses it here) OR a pre-parsed argv array
   * (wire pre-parses in runWire to prepend `-c --dangerously-skip-permissions`,
   * deduped). Either way the fail-fast on bad quoting happens before any HTTP.
   */
  claudeArgs?: string | string[];
}

/**
 * Kills an existing session so wire can re-adopt the name. NEVER asks for
 * confirmation and NEVER refuses — the deliberate opposite of start's P7 guard
 * (owner's decision): wire's contract is "adopt THIS window", so the previous
 * incarnation of the same name is meant to be superseded, silently and fast.
 */
async function replaceExistingSession(
  tmux: StartTmux,
  session: string,
  name: string,
  out: OutFn,
  context: string,
): Promise<void> {
  if (typeof tmux.killSession !== "function") {
    // Only reachable if a caller injects a tmux without killSession in wire
    // mode — a programming error, surfaced clearly instead of crashing.
    throw new CliError(
      `Internal error: "wire" needs a tmux able to kill sessions to replace "${session}".`,
    );
  }
  try {
    await tmux.killSession(session);
  } catch (err) {
    // Benign race: the session may have vanished between the hasSession check
    // and this kill (the user or another process killed it in that window).
    // tmux kill-session then exits non-zero, but the desired end-state — "no
    // old session" — is already true, so only RE-THROW if it is somehow STILL
    // there (a real kill failure); otherwise fall through as a success.
    if (await tmux.hasSession(session)) {
      throw err;
    }
  }
  out(
    `Replaced the existing tmux session "${session}" (${context}) — the previous ` +
      `incarnation of agent "${name}" was terminated before re-adopting the window.`,
  );
}

/** Thin wrapper: `start` is `runAgentSession` in "start" mode (refuse P7). */
export async function runStart(options: StartOptions): Promise<StartResult> {
  return runAgentSession({ ...options, mode: "start" });
}

/**
 * Shared core of `start` and `wire` (PRD section 11 + the wire addendum).
 * The two differ in exactly two spots, both keyed on `options.mode`:
 *   - an already-existing tmux session: start REFUSES it (P7); wire SUBSTITUTES
 *     it (kills + recreates);
 *   - the claude argv: start passes the user's --claude-args as-is; wire
 *     prepends `-c --dangerously-skip-permissions` (runWire does that before
 *     calling here, so this function only sees the final argv array).
 * Every other step — name/dir validation, the sb-hub reservation, the hub
 * liveness check, register → capability token (kept local, NEVER printed),
 * new-session with argv as an ARRAY, the settle re-check, attach and the
 * detached kickoff — is identical.
 */
export async function runAgentSession(options: AgentSessionOptions): Promise<StartResult> {
  const out = options.out ?? console.log;
  const mode = options.mode;
  const name = options.name;

  // 1a. Name validation — same regex as the store (fail fast, before HTTP).
  if (!AGENT_NAME_RE.test(name)) {
    throw new CliError(
      `Invalid agent name: "${name}". Use lowercase letters, digits and hyphens ` +
        `(2 to 31 characters, starting with a letter or digit): ^[a-z0-9][a-z0-9-]{1,30}$`,
    );
  }

  // 1a. --claude-args parse fails fast, BEFORE any HTTP: parsing only in step 4
  // would leave a ghost registration (agent registered, token regenerated, no
  // session) when the quoting is bad. A pre-parsed array (wire) is used as-is —
  // its parse already ran in runWire, equally before any HTTP.
  const claudeArgv = Array.isArray(options.claudeArgs)
    ? options.claudeArgs
    : parseClaudeArgs(options.claudeArgs);

  // Working dir must exist — tmux new-session -c with a bad dir fails late
  // and cryptically; fail here with a clear message instead.
  const cwd = path.resolve(expandHome(options.dir ?? process.cwd()));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new CliError(`Directory does not exist: ${cwd} (--dir flag).`);
  }

  // 1a. "sb-hub" is reserved for the Hub itself: serveHeaderLines and the
  // stop/down instructions tell the human to run/kill `switchboard serve`
  // in that exact session — an agent named to collide with it would either
  // get killed by those instructions or produce a misleading P7 error.
  const config = loadConfig(options.baseDir);
  const tmuxSession = config.tmuxSessionPrefix + name;
  if (tmuxSession === "sb-hub") {
    throw new CliError(
      `The name "${name}" would produce the tmux session "sb-hub", reserved for the Hub itself ` +
        `(the "switchboard serve" recommendation is to run inside it). Choose another agent name.`,
    );
  }

  // 1b. Hub alive? start/wire AUTO-START it in the background when down
  // (owner decision: "everything automatic" — no dedicated terminal for the
  // Hub). Injectable: tests pass checkHubHealth to keep the old fail-fast.
  const hubUrl = options.hubUrl ?? defaultHubUrl(options.baseDir);
  const ensureHub = options.ensureHub ?? ensureHubUp;
  await ensureHub(hubUrl, { out });

  // 2. Existing session. start REFUSES it here (P7, never two starts on one
  // name) — a fast fail BEFORE touching the Hub. wire does NOT kill here: the
  // substitution is DEFERRED to after the register (step 3b). Killing before
  // the register would, if the register then failed (hub crash/validation/rate
  // limit in that small window), leave the user with a dead agent and NO
  // replacement; register-first means a failed register never destroys a
  // running session. wire only REMEMBERS whether the session was already there,
  // so step 3b can word its message accurately ("already open" vs "appeared
  // during registration").
  const tmux: StartTmux = options.tmux ?? createTmux();
  const sessionPreexisted = await tmux.hasSession(tmuxSession);
  if (sessionPreexisted && mode !== "wire") {
    throw new CliError(
      `The tmux session "${tmuxSession}" already exists — the agent "${name}" seems to be running. ` +
        `To see it: tmux attach -t ${tmuxSession}. ` +
        `To stop and start over: switchboard stop ${name} and then run start again.`,
    );
  }

  // 3. Register BEFORE the TUI opens (D4). The response carries the
  // capability token (v1.1) — kept local, injected via env below, NEVER
  // printed or logged (neither here nor hub-side). `role` travels only when
  // the flag was given: a re-attach without --role must PRESERVE the
  // registered role (PRD 8: the registration is reused, not zeroed).
  const registration = await hubPost<RegisterResponse>(hubUrl, "/api/agents/register", {
    name,
    role: options.role,
    cwd,
    tmuxSession,
  });
  const token = registration.token;

  // 3b. Substitution / TOCTOU. A session may exist now either because it was
  // already there before the register (sessionPreexisted — wire deferred it
  // from step 2) OR because a concurrent start/wire raced one in during the
  // register HTTP round-trip. wire, whose contract is "always adopt", kills +
  // recreates it (the ONLY place wire ever kills — register succeeded first);
  // start fails cleanly BEFORE new-session so it never clashes with a duplicate.
  if (await tmux.hasSession(tmuxSession)) {
    if (mode === "wire") {
      await replaceExistingSession(
        tmux,
        tmuxSession,
        name,
        out,
        sessionPreexisted ? "already open" : "appeared during registration",
      );
    } else {
      throw new CliError(
        `The tmux session "${tmuxSession}" appeared during registration. ` + concurrentStartHint(name),
      );
    }
  }

  // 4. Detached session running env + claude, argv as ARRAY (exact argv
  // semantics survive tmux — see tmux.newSession/quoteShellArg). Failures are
  // converted to CliError with the token REDACTED: a raw execFile error would
  // carry the full command line (with SWITCHBOARD_AGENT_TOKEN) to stderr via
  // the generic runCliAction branch (tmux.ts also sanitizes at the source;
  // this is defense in depth for any StartTmux implementation).
  async function createAgentSession(argv: string[]): Promise<void> {
    try {
      await tmux.newSession(
        tmuxSession,
        cwd,
        buildAgentCommand({
          name,
          token,
          claudeArgs: argv,
          claudeBin: options.claudeBin,
        }),
      );
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err))
        .split(token)
        .join("<token-redacted>");
      throw new CliError(
        `Failed to create the tmux session "${tmuxSession}": ${detail}\n` + concurrentStartHint(name),
      );
    }
  }
  await createAgentSession(claudeArgv);

  // 4b. The command may die at birth (typical: "claude" not on PATH, or bad
  // --claude-args) and take the session with it — reporting success there
  // would be a lie. Give it a settle window and re-check.
  //
  // wire AUTO-FALLBACK (owner decision): `claude -c` dies ~1-2s in when the
  // folder has no resumable conversation (or the last one was created in
  // -p/print mode). Instead of failing, wire retries ONCE without the
  // continue flag — a fresh session — and says so. A second death then means
  // the claude command itself is broken, which IS an error.
  const sleep = options.sleep ?? realSleep;
  const settleMs =
    options.settleMs ?? (mode === "wire" ? WIRE_SETTLE_MS : START_SETTLE_MS);
  await sleep(settleMs);
  let fellBack = false;
  if (!(await tmux.hasSession(tmuxSession))) {
    const CONTINUE_FLAGS = ["-c", "--continue"];
    const hadContinue = mode === "wire" && claudeArgv.some((a) => CONTINUE_FLAGS.includes(a));
    if (!hadContinue) {
      const retry = mode === "wire" ? "switchboard wire" : `switchboard start ${name}`;
      throw new CliError(
        `The tmux session "${tmuxSession}" died right after opening — the agent command failed ` +
          `at birth. Is the "claude" binary on the PATH? Are the --claude-args valid? ` +
          `The agent's registration stays in the Hub; fix it and run "${retry}" again.`,
      );
    }
    out(
      `No resumable conversation in ${cwd} — "claude -c" exited right after opening. ` +
        `Retrying with a FRESH session (no -c)...`,
    );
    await createAgentSession(claudeArgv.filter((a) => !CONTINUE_FLAGS.includes(a)));
    await sleep(settleMs);
    if (!(await tmux.hasSession(tmuxSession))) {
      throw new CliError(
        `The tmux session "${tmuxSession}" died even without -c — the claude command itself ` +
          `failed at birth. Is the "claude" binary on the PATH? Are the --claude-args valid? ` +
          `The agent's registration stays in the Hub; fix it and run "switchboard wire" again.`,
      );
    }
    fellBack = true;
  }

  if (mode === "wire") {
    // Word it from the ACTUAL outcome: wire normally forces -c (continue), but
    // the user may express continue as --continue, override it with -r/--resume
    // (buildWireClaudeArgs then omits -c), or the auto-fallback may have
    // recreated the session fresh. Hardcoding "claude -c" would misstate those.
    const continuing =
      !fellBack && (claudeArgv.includes("-c") || claudeArgv.includes("--continue"));
    out(
      `Agent "${name}" wired into the Hub and reopened in tmux session "${tmuxSession}"` +
        (fellBack
          ? ` with a FRESH conversation in ${cwd} (there was no resumable conversation to continue).`
          : continuing
            ? `, continuing this folder's conversation in ${cwd}.`
            : ` in ${cwd}.`),
    );
  } else {
    out(`Agent "${name}" registered in the Hub and tmux session "${tmuxSession}" created in ${cwd}.`);
  }
  printPermissionsReminderOnce(options.baseDir ?? defaultBaseDir(), out);

  // 6 (spawned BEFORE the blocking attach of step 5): detached kickoff.
  const kickoff = options.kickoff ?? true;
  if (kickoff) {
    const spawnKickoff =
      options.spawnKickoff ?? ((n: string, s: string) => defaultSpawnKickoff(n, s, out));
    spawnKickoff(name, tmuxSession);
    out(
      `Kickoff scheduled: in ~${Math.round(config.kickoffDelayMs / 1000)}s (once the TUI is ready) ` +
        `the agent will be instructed to call the join tool. Use --no-kickoff to disable.`,
    );
  }

  // 5. Attach (TTY) or print how to attach.
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  const insideTmux = options.insideTmux ?? process.env.TMUX !== undefined;
  if (isTTY && !insideTmux) {
    const attachExit = (await (options.attach ?? defaultAttach)(tmuxSession)) ?? 0;
    if (attachExit === 0) {
      out(
        `Detached from session "${tmuxSession}". The agent keeps running in the background; ` +
          `use "switchboard stop ${name}" to stop it.`,
      );
    } else {
      // Attach failed (e.g. stdin is a pipe — "open terminal failed"): the
      // user never entered the session, so say how to attach for real.
      out(
        `The tmux attach failed (exit ${attachExit}) — non-interactive terminal? ` +
          `To follow the agent: tmux attach -t ${tmuxSession}. ` +
          `Agent state: switchboard status.`,
      );
    }
  } else if (isTTY) {
    // Inside tmux already (env TMUX set): nesting attach breaks the terminal.
    out(
      `You are already inside a tmux session — nested attach is not supported. ` +
        `In another tab/terminal, run: tmux attach -t ${tmuxSession}`,
    );
  } else {
    out(`Session created in the background. To follow the agent: tmux attach -t ${tmuxSession}`);
  }

  return { tmuxSession, cwd, fallback: fellBack };
}

// ---------------------------------------------------------------------------
// commander wiring.
// ---------------------------------------------------------------------------

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description(
      "Registers an agent in the Hub and opens its Claude Code in a dedicated tmux session.",
    )
    .argument("<name>", "agent name (lowercase letters, digits and hyphens)")
    // NO default value for --role: `role: undefined` means "flag omitted" and
    // the register then PRESERVES the role already stored (re-attach, PRD 8);
    // a default "" would silently erase it on every start without --role.
    .option("--role <description>", "agent role (e.g.: \"API backend\")")
    .option("--dir <dir>", "agent working directory (default: current directory)")
    .option("--no-kickoff", "do not inject the automatic join instruction after opening")
    .option(
      "--claude-args <args>",
      "extra arguments for claude (single/double quotes group)",
    )
    .action(
      async (
        name: string,
        opts: { role?: string; dir?: string; kickoff: boolean; claudeArgs?: string },
      ) => {
        await runCliAction(() =>
          runStart({
            name,
            role: opts.role,
            dir: opts.dir,
            kickoff: opts.kickoff,
            claudeArgs: opts.claudeArgs,
          }).then(() => undefined),
        );
      },
    );
}

/**
 * Hidden re-entry command for the detached kickoff process (see
 * defaultSpawnKickoff). Not part of the public CLI surface (PRD 11) — hence
 * hidden — but running it by hand is harmless: it just waits for readiness
 * and nudges once through the guarded path.
 */
export function registerKickoffAgentCommand(program: Command): void {
  program
    // [session] carries the tmux session the start REGISTERED (source of
    // truth) — recomputing prefix+name here could diverge if the config
    // changed between the spawn and this process reading it.
    .command("kickoff-agent <name> [session]", { hidden: true })
    .description("(internal) waits for the TUI to be ready and injects the join instruction")
    .action(async (name: string, session?: string) => {
      await runCliAction(async () => {
        const result = await runKickoffAgent({ name, session });
        if (!result.sent) {
          // Detached process: stdio is ignored in production, but log anyway
          // for the manual/debug invocation path.
          console.error(`kickoff-agent ${name}: not sent — ${result.reason ?? "unknown reason"}`);
          process.exitCode = 1;
        }
      });
    });
}
