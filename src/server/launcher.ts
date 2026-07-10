// Server-side agent launcher — the hub itself creates an agent's tmux session
// running claude, so the operator can spin up intercommunicating agents from
// the web dashboard without touching a terminal (owner-approved feature).
//
// This is the HUB-SIDE sibling of `switchboard wire` (src/cli/wire.ts): it
// reuses wire's product decisions — name derived from the folder basename,
// homonymous session SUBSTITUTED without confirmation (the dashboard is an
// operator surface), `--dangerously-skip-permissions` always (the launched
// agent must read its token via printenv and call join with NO approval
// prompt) and `-c` when the operator asks to continue the folder's previous
// conversation — but registers DIRECTLY on the store (same process, no HTTP
// round-trip) and schedules the kickoff INSIDE the hub process (setTimeout,
// unref) instead of a detached CLI re-entry.
//
// Import policy: this module IMPORTS pure helpers from src/cli (deriveAgentName,
// buildAgentCommand, isTuiReady, kickoffText, expandHome — all side-effect-free
// exports) but never the CLI runners; the dependency direction stays
// "server may read cli helpers", nothing under src/cli/ knows this file exists.
// buildWireClaudeArgs was considered and NOT reused: it cannot express
// continue=false (its whole contract is "prepend -c unless the user overrode
// it") and the dashboard has no user --claude-args to merge, so the two-flag
// argv is built locally from wire's exported flag constants.
//
// Security invariants (PRD 10.3 / 15, v1.1 addendum) preserved verbatim:
// - the kickoff injection goes through tmux.nudgeSession — pane-command guard,
//   -l/--, separate Enter, TOCTOU re-check; NEVER bypassed;
// - the capability token rides ONLY the session env (argv array through
//   tmux.newSession) and is NEVER logged, listed or returned: the LaunchResult
//   agent is redacted via toPublicAgent, and tmux failures are re-thrown with
//   the token replaced by "<token-redacted>" (same defense as start.ts).

import fs from "node:fs";
import path from "node:path";
import {
  toPublicAgent,
  type Agent,
  type Config,
  type PublicAgent,
} from "../shared/types.js";
import type { Logger } from "./log.js";
import type { Store } from "./store.js";
import type { EventBus } from "./api.js";
import type { NudgeResult } from "./tmux.js";
import {
  deriveAgentName,
  WIRE_BYPASS_FLAG,
  WIRE_CONTINUE_FLAG,
} from "../cli/wire.js";
import {
  buildAgentCommand,
  expandHome,
  isTuiReady,
  kickoffText,
} from "../cli/start.js";

/**
 * Translates the path shapes a Windows-side operator realistically pastes
 * into the dashboard (Windows Explorer shows WSL folders under \\wsl$\... and
 * its "Copy as path" wraps paths in quotes) into the POSIX path the hub can
 * actually use. Pure; exported for unit tests. Rules, in order:
 *
 * - trim, then strip ONE pair of surrounding single/double quotes;
 * - `\\wsl$\<distro>\rest` or `\\wsl.localhost\<distro>\rest` (host
 *   case-insensitive, any distro name) → `/rest` with every `\` → `/`.
 *   The distro segment is DROPPED on purpose: the hub runs inside the only
 *   distro it can launch into, so the segment carries no information here —
 *   a path copied from ANOTHER distro simply won't exist and fails the
 *   directory-exists validation downstream with a clear error;
 * - `X:\rest` (drive letter, either separator after the colon) →
 *   `/mnt/<x lowercase>/rest` with every `\` → `/` (the standard WSL
 *   automount of Windows drives);
 * - any other `\\server\share` UNC and everything else: returned unchanged —
 *   the caller's absolute-path validation rejects what remains invalid.
 */
export function normalizeIncomingPath(raw: string): string {
  let s = raw.trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1);
  }
  // \\wsl$\<distro>\rest  or  \\wsl.localhost\<distro>\rest → /rest
  const wsl = /^\\\\(?:wsl\$|wsl\.localhost)\\[^\\/]+([\\/].*)?$/i.exec(s);
  if (wsl) {
    const rest = (wsl[1] ?? "").replace(/\\/g, "/");
    return rest === "" ? "/" : rest;
  }
  // X:\rest → /mnt/<x>/rest (WSL automount of Windows drives).
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(s);
  if (drive) {
    const mount = `/mnt/${drive[1].toLowerCase()}`;
    const rest = drive[2].replace(/\\/g, "/");
    return rest === "" ? mount : `${mount}/${rest}`;
  }
  return s;
}

/**
 * Launch failure with an actionable English message (written for the operator
 * reading the dashboard toast). `status` maps it to the HTTP layer: 400 for
 * input/validation problems (bad dir, invalid/reserved name), 500 for
 * server-side launch failures (tmux/claude died) — both still answer the
 * clear message as {ok:false, error}, never the generic "Internal Hub error".
 */
export class LaunchError extends Error {
  readonly status: 400 | 500;

  constructor(message: string, status: 400 | 500 = 400) {
    super(message);
    this.name = "LaunchError";
    this.status = status;
  }
}

/** The narrow tmux surface the launcher needs (injectable for tests). */
export interface LauncherTmux {
  hasSession(session: string): Promise<boolean>;
  /** Exact-target kill (tmux.ts uses `-t =NAME`) — used to replace a homonym. */
  killSession(session: string): Promise<void>;
  newSession(session: string, cwd: string, cmd?: string | string[]): Promise<void>;
  capturePane(session: string, lines?: number): Promise<string>;
  /** THE guarded nudge path (pane guard + separate Enter) — never bypassed. */
  nudgeSession(session: string, text: string, enterDelayMs: number): Promise<NudgeResult>;
}

export interface LaunchInput {
  /** Working directory for the agent: "~" expanded, must be absolute + exist. */
  dir: string;
  /** Agent name; omitted → derived from the folder basename (like wire). */
  name?: string;
  /** Role description; omitted → the stored role is PRESERVED on re-attach. */
  role?: string;
  /** true → `claude -c` (resume the folder's conversation), with auto-fallback. */
  continueConversation?: boolean;
}

export interface LaunchResult {
  /** REDACTED view (toPublicAgent) — the token never leaves the hub via HTTP. */
  agent: PublicAgent;
  /** true when a live homonymous tmux session was killed and recreated. */
  replaced: boolean;
  /**
   * true when continueConversation was on but the session died resuming
   * (`claude -c` with nothing resumable) and the launcher retried WITHOUT -c:
   * "no resumable conversation — opened a fresh session".
   */
  fallback: boolean;
}

/**
 * Post-create liveness settle window. Same rationale as WIRE_SETTLE_MS in
 * start.ts: `claude -c` does not fail instantly — it launches, tries to
 * resume, and only then may exit non-zero (~1-2s observed) — so a short settle
 * would report success over a dead session (and never trigger the fallback).
 */
export const LAUNCH_SETTLE_MS = 2500;

/** Kickoff TUI-readiness budget after the initial delay (mirrors start.ts). */
export const KICKOFF_READINESS_TIMEOUT_MS = 60_000;

/** Kickoff readiness poll cadence (mirrors start.ts). */
export const KICKOFF_READINESS_POLL_MS = 2_000;

/** Test-facing tuning knobs; production uses the defaults. */
export interface LauncherTuning {
  /** Settle window override (default LAUNCH_SETTLE_MS). */
  settleMs?: number;
  /** Kickoff readiness poll cadence override (default 2s). */
  readinessPollMs?: number;
  /** Kickoff readiness budget override (default 60s). */
  readinessTimeoutMs?: number;
  /** Injectable sleep (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (epoch ms) for the readiness deadline. */
  now?: () => number;
  /** TEST-ONLY: binary in place of "claude" (never launch a real claude in tests). */
  claudeBin?: string;
}

export interface LauncherOptions extends LauncherTuning {
  store: Store;
  tmux: LauncherTmux;
  config: Config;
  log: Logger;
  bus: EventBus;
}

export interface Launcher {
  launchAgent(input: LaunchInput): Promise<LaunchResult>;
  /** Cancels pending kickoffs; called by hub.close(). Idempotent. */
  stop(): void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createLauncher(options: LauncherOptions): Launcher {
  const { store, tmux, config, log, bus } = options;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const settleMs = options.settleMs ?? LAUNCH_SETTLE_MS;
  const readinessPollMs = options.readinessPollMs ?? KICKOFF_READINESS_POLL_MS;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? KICKOFF_READINESS_TIMEOUT_MS;

  /** Pending kickoff delay timers, cleared on stop() (hub shutdown). */
  const pendingKickoffs = new Set<NodeJS.Timeout>();
  let closed = false;

  async function launchAgent(input: LaunchInput): Promise<LaunchResult> {
    // 1. Directory: required, "~" expanded, ABSOLUTE (the hub cannot resolve
    // a relative path against the operator's shell — its own cwd would be a
    // silent surprise) and an existing directory.
    const rawDir = typeof input.dir === "string" ? input.dir.trim() : "";
    if (rawDir === "") {
      throw new LaunchError(
        `Missing "dir": provide the absolute path of the directory the agent should work in.`,
      );
    }
    // Windows Explorer shapes (\\wsl$\..., C:\..., quoted paths) are
    // translated FIRST, so a path pasted straight from the Windows side just
    // works (real user report: Explorer hands out \\wsl$\<distro>\... for WSL
    // folders).
    const cwd = path.normalize(expandHome(normalizeIncomingPath(rawDir)));
    if (!path.isAbsolute(cwd)) {
      throw new LaunchError(
        `"dir" must be an absolute path (got "${rawDir}"): the hub cannot resolve ` +
          `relative paths against your shell. Use e.g. /home/you/project or ~/project — ` +
          `Windows Explorer WSL paths (\\\\wsl$\\<distro>\\...) and drive paths ` +
          `(C:\\...) are also accepted and translated automatically.`,
      );
    }
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(cwd).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      throw new LaunchError(
        `Directory does not exist: ${cwd}. The hub opens the agent's claude inside ` +
          `that directory — create it first or fix the path.`,
      );
    }

    // 2. Name: explicit, or derived from the folder basename (wire's rule).
    // deriveAgentName throws a CliError with the actionable "pass --name"
    // guidance — surfaced as a 400 (its message already tells the operator to
    // provide an explicit name).
    let name = typeof input.name === "string" ? input.name.trim() : "";
    if (name === "") {
      try {
        name = deriveAgentName(cwd);
      } catch (err) {
        throw new LaunchError((err as Error).message);
      }
    }

    // "sb-hub" is reserved for the Hub itself (same guard as start.ts) — and
    // DOUBLY critical here: the replace step below kills a live homonymous
    // session, so launching an agent named "hub" would kill the very tmux
    // session the operator was told to run `switchboard serve` in.
    const session = config.tmuxSessionPrefix + name;
    if (session === "sb-hub") {
      throw new LaunchError(
        `The name "${name}" would produce the tmux session "sb-hub", reserved for the ` +
          `Hub itself. Choose another agent name.`,
      );
    }

    // 3. Register DIRECTLY on the store (same process — no HTTP round-trip).
    // Store rules (name regex, reserved names, MAX_AGENTS) surface as clear
    // 400s; re-attach semantics included: an existing name is reused and its
    // capability token REGENERATED (v1.1 — the previous incarnation is dead
    // or about to be replaced below).
    let agent: Agent;
    try {
      agent = store.registerAgent({
        name,
        role: input.role, // undefined → preserve the stored role (PRD 8)
        cwd,
        tmuxSession: session,
      });
    } catch (err) {
      throw new LaunchError((err as Error).message);
    }
    bus.emit({ type: "agent_updated", payload: toPublicAgent(agent) });
    // The token itself is NEVER logged (v1.1, PRD 15).
    log.info(
      `[launcher] agent registered from the dashboard: ${name} (tmux: ${session}, dir: ${cwd}).`,
    );

    const token = agent.token;
    if (!token) {
      // registerAgent always generates a token; reaching here is a bug.
      throw new LaunchError(
        `Internal error: the store issued no capability token for "${name}".`,
        500,
      );
    }

    // 4. Replace a homonymous LIVE session automatically (dashboard = operator
    // surface, no confirmation — wire's substitution semantics). Register ran
    // FIRST so a failed validation never destroys a running session.
    let replaced = false;
    if (await tmux.hasSession(session)) {
      try {
        await tmux.killSession(session);
      } catch (err) {
        // Benign race: the session may have vanished between the check and the
        // kill. Only fail if it is somehow STILL there (a real kill failure).
        if (await tmux.hasSession(session)) {
          throw new LaunchError(
            `Could not replace the existing tmux session "${session}": ` +
              `${err instanceof Error ? err.message : String(err)}`,
            500,
          );
        }
      }
      replaced = true;
      log.info(
        `[launcher] replaced the existing tmux session "${session}" — the previous ` +
          `incarnation of agent "${name}" was terminated before relaunching.`,
      );
    }

    // 5 + 6. Create the session (argv as ARRAY — exact argv semantics survive
    // tmux, see tmux.newSession/quoteShellArg) and give it a settle window:
    // the command may die at birth (claude missing) or ~1-2s in (`-c` with
    // nothing resumable) — reporting success there would be a lie.
    const wantContinue = input.continueConversation === true;

    async function createSession(withContinue: boolean): Promise<void> {
      const claudeArgs = withContinue
        ? [WIRE_CONTINUE_FLAG, WIRE_BYPASS_FLAG]
        : [WIRE_BYPASS_FLAG];
      try {
        await tmux.newSession(
          session,
          cwd,
          buildAgentCommand({ name, token: token!, claudeArgs, claudeBin: options.claudeBin }),
        );
      } catch (err) {
        // Token redaction, defense in depth (tmux.ts already sanitizes).
        const detail = (err instanceof Error ? err.message : String(err))
          .split(token!)
          .join("<token-redacted>");
        throw new LaunchError(
          `Failed to create the tmux session "${session}": ${detail}`,
          500,
        );
      }
    }

    async function settled(): Promise<boolean> {
      await sleep(settleMs);
      return tmux.hasSession(session);
    }

    await createSession(wantContinue);

    let fallback = false;
    if (!(await settled())) {
      if (wantContinue) {
        // Auto-fallback: `claude -c` died (typically: no resumable
        // conversation in this folder) → retry ONCE without -c.
        fallback = true;
        log.warn(
          `[launcher] session "${session}" died resuming the previous conversation (-c): ` +
            `no resumable conversation in ${cwd} — retrying with a fresh session.`,
        );
        await createSession(false);
        if (!(await settled())) {
          throw new LaunchError(
            `The tmux session "${session}" died right after opening, even without ` +
              `conversation resume (-c). Is the "claude" binary on the Hub's PATH? ` +
              `The registration stays in the Hub; check ~/.switchboard/logs/hub.log, ` +
              `fix the environment and launch again.`,
            500,
          );
        }
      } else {
        throw new LaunchError(
          `The tmux session "${session}" died right after opening — the claude command ` +
            `failed at birth. Is the "claude" binary on the Hub's PATH? The registration ` +
            `stays in the Hub; fix the environment and launch again.`,
          500,
        );
      }
    }

    // 7. Kickoff, scheduled inside the hub process (the CLI uses a detached
    // re-entry because its terminal is blocked by the attach; the hub is a
    // long-lived daemon, a plain unref'd timer is simpler and debuggable).
    scheduleKickoff(name, session);

    log.info(
      `[launcher] agent "${name}" launched in tmux session "${session}"` +
        `${replaced ? " (replaced the previous session)" : ""}` +
        `${fallback ? " (fresh session — resume fallback)" : ""}; ` +
        `kickoff scheduled in ~${Math.round(config.kickoffDelayMs / 1000)}s.`,
    );

    return { agent: toPublicAgent(agent), replaced, fallback };
  }

  function scheduleKickoff(name: string, session: string): void {
    const timer = setTimeout(() => {
      pendingKickoffs.delete(timer);
      void runKickoff(name, session).catch((err) => {
        log.error(`[launcher] unexpected kickoff error for ${name}:`, err);
      });
    }, config.kickoffDelayMs);
    timer.unref(); // a pending kickoff never holds the hub process open
    pendingKickoffs.add(timer);
  }

  /**
   * Same behavior as the CLI's runKickoffAgent (start.ts): after the initial
   * delay, poll the pane for TUI READINESS and only then inject the kickoff
   * line via the guarded nudge path. A blind injection would type into the
   * trust dialog ("Quick safety check…"), a MENU where digits select options —
   * the pane guard alone cannot catch that (the dialog runs inside claude).
   */
  async function runKickoff(name: string, session: string): Promise<void> {
    const deadline = now() + readinessTimeoutMs;
    for (;;) {
      if (closed) return;
      if (!(await tmux.hasSession(session))) {
        log.warn(
          `[launcher] kickoff for ${name} canceled: session "${session}" no longer exists.`,
        );
        return;
      }
      let pane = "";
      try {
        pane = await tmux.capturePane(session, 200);
      } catch {
        pane = ""; // unreadable this round — treated as not ready
      }
      if (isTuiReady(pane)) break;
      if (now() >= deadline) {
        log.warn(
          `[launcher] kickoff for ${name} NOT sent: the claude TUI did not become ready ` +
            `within ${readinessTimeoutMs}ms (trust dialog pending? attach with ` +
            `"tmux attach -t ${session}") — the agent can call the join tool manually.`,
        );
        return;
      }
      await sleep(readinessPollMs);
    }
    if (closed) return;

    // Guarded nudge path — pane-command guard, -l/--, separate Enter, TOCTOU
    // re-check all enforced inside nudgeSession (PRD 10.3, never bypassed).
    const result = await tmux.nudgeSession(session, kickoffText(name), config.nudgeEnterDelayMs);
    if (result.sent) {
      log.info(`[launcher] kickoff delivered to ${name} (join instruction injected).`);
    } else {
      log.warn(
        `[launcher] kickoff for ${name} NOT sent: ${result.reason ?? "unknown reason"}.`,
      );
    }
  }

  function stop(): void {
    closed = true;
    for (const timer of pendingKickoffs) clearTimeout(timer);
    pendingKickoffs.clear();
  }

  return { launchAgent, stop };
}
