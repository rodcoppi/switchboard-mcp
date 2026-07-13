// Shared helpers of the Phase 4 CLI (PRD section 11): hub address resolution,
// HTTP client with self-explaining errors, and the "hub down" check every
// hub-talking subcommand runs first. User-facing texts in English (D8).
//
// The CLI talks to the hub EXCLUSIVELY over REST (/api/*) — never by touching
// the store files directly (single-writer stays true) — and touches tmux only
// through src/server/tmux.ts (the one sanctioned exception is the interactive
// `tmux attach` in start.ts, documented there).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { BIND_HOST, loadConfig } from "../server/config.js";
import { createTmux } from "../server/tmux.js";

/**
 * CLI-level error: the message is FOR the human running the terminal —
 * printed as-is (no stack trace) and the process exits 1. Anything else that
 * escapes an action is a bug and gets the generic treatment.
 */
export class CliError extends Error {}

/**
 * Hub base URL from config (~/.switchboard/config.json, default port 4577).
 * Host is BIND_HOST by construction (D6: the hub only ever binds 127.0.0.1).
 * `baseDir` is injectable for tests; production uses the default.
 */
export function defaultHubUrl(baseDir?: string): string {
  return `http://${BIND_HOST}:${loadConfig(baseDir).port}`;
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err.cause ?? undefined) as { code?: string } | undefined;
    if (cause?.code) return cause.code; // e.g. ECONNREFUSED
    if (err.name === "TimeoutError") return "timeout";
    return err.message;
  }
  return String(err);
}

/**
 * PRD 11 (`start`, step 1) and the status/send/stop error contract: a dead
 * hub must produce a CLEAR error telling the user to run `switchboard serve`
 * first — never a raw ECONNREFUSED stack.
 */
export async function checkHubHealth(hubUrl: string): Promise<void> {
  let failure: string | undefined;
  try {
    const res = await fetch(`${hubUrl}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      failure = `HTTP ${res.status}`;
    } else {
      const body = (await res.json()) as { ok?: boolean };
      if (body.ok !== true) failure = "health check returned ok=false";
    }
  } catch (err) {
    failure = describeFetchError(err);
  }
  if (failure !== undefined) {
    throw new CliError(
      `The Hub did not respond at ${hubUrl}/api/health (${failure}). ` +
        `Run "switchboard serve" first (recommended: inside a tmux session "sb-hub").`,
    );
  }
}

/** The tmux session that hosts the auto-started Hub (same name the docs recommend). */
export const HUB_SESSION = "sb-hub";

/** Repo-root bin shim, resolved relative to this module (works from any cwd). */
function binShimPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/switchboard.mjs");
}

async function hubIsUp(hubUrl: string): Promise<boolean> {
  try {
    await checkHubHealth(hubUrl);
    return true;
  } catch {
    return false;
  }
}

/**
 * Boots the Hub in the background: a DETACHED tmux session "sb-hub" running
 * `switchboard serve` (via the bin shim, so tsx resolves from this repo). No
 * terminal window stays open — the session is invisible until the user
 * `tmux attach -t sb-hub`s into it. A zombie sb-hub (session alive, health
 * dead — e.g. the serve crashed) is killed first so the recreate is clean.
 *
 * PATH-independence (real user report: the Desktop shortcut boots this from a
 * NON-INTERACTIVE login shell where version managers like `n` never join the
 * PATH): node is invoked by its ABSOLUTE path (process.execPath), and that
 * node's bin dir is PREPENDED to the session PATH so everything the hub later
 * spawns — `claude` for dashboard launches lives in the same bin dir — still
 * resolves no matter how bare the booting environment was.
 */
async function defaultBootHub(): Promise<void> {
  const tmux = createTmux();
  if (await tmux.hasSession(HUB_SESSION)) {
    await tmux.killSession(HUB_SESSION).catch(() => {});
  }
  const nodeDir = path.dirname(process.execPath);
  // A bare booting environment (the Windows shortcut's non-interactive login
  // shell) may lack the /mnt/c/... interop entries — without them the hub
  // cannot spawn wt.exe/cmd.exe to open agent windows. Append the fixed
  // Windows dirs (harmless no-ops on non-WSL: the dirs just don't exist) and
  // keep any WindowsApps entry the current PATH already has (wt.exe home).
  const currentPath = process.env.PATH ?? "";
  const windowsDirs = ["/mnt/c/Windows/System32", "/mnt/c/Windows"].filter(
    (d) => !currentPath.includes(d),
  );
  const bootPath = [nodeDir, currentPath, ...windowsDirs].filter(Boolean).join(":");
  await tmux.newSession(HUB_SESSION, path.dirname(binShimPath()), [
    "env",
    `PATH=${bootPath}`,
    process.execPath,
    binShimPath(),
    "serve",
  ]);
}

export interface EnsureHubOptions {
  out?: OutFn;
  /** Injectable boot for tests (default: detached tmux session sb-hub). */
  bootHub?: () => Promise<void>;
  /** How long to wait for /api/health after booting (default 15s). */
  bootTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Suppress the "Hub is up at …" success line — for callers that print their
   * own summary (e.g. `switchboard up`'s banner). The "starting…" line still
   * shows, so the user knows a boot is happening.
   */
  quietSuccess?: boolean;
}

/**
 * "Everything automatic" (owner decision): commands that activate agents
 * (start/wire) do not fail when the Hub is down — they BOOT it in the
 * background and wait for health. The old fail-with-instructions behavior
 * lives on in checkHubHealth (status/send/stop still use it: reading state
 * should not silently spin up a server).
 */
export async function ensureHubUp(
  hubUrl: string,
  options: EnsureHubOptions = {},
): Promise<void> {
  if (await hubIsUp(hubUrl)) return;
  const out = options.out ?? console.log;
  out(`The Hub is not running — starting it in the background (tmux session "${HUB_SESSION}")...`);
  await (options.bootHub ?? defaultBootHub)();
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (options.bootTimeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    await sleep(500);
    if (await hubIsUp(hubUrl)) {
      if (!options.quietSuccess) {
        out(`Hub is up at ${hubUrl} (dashboard: ${hubUrl}/ — logs: "switchboard logs").`);
      }
      return;
    }
  }
  throw new CliError(
    `Could not auto-start the Hub at ${hubUrl}. Check the logs ("switchboard logs" or ` +
      `~/.switchboard/logs/hub.log) or run "switchboard serve" manually to see the error ` +
      `(a common cause: the port is already taken by another process).`,
  );
}

async function hubFetch<T>(
  hubUrl: string,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${hubUrl}${pathname}`, {
      signal: AbortSignal.timeout(10_000),
      ...init,
    });
  } catch (err) {
    throw new CliError(
      `Failed to talk to the Hub at ${hubUrl}${pathname} (${describeFetchError(err)}). ` +
        `Did the Hub go down? Run "switchboard serve" first.`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    // Hub errors are already {ok:false, error} in English, written for the
    // reader to self-correct — surface them verbatim.
    const error =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `Hub responded HTTP ${res.status} at ${pathname}.`;
    throw new CliError(error);
  }
  return body as T;
}

export function hubGet<T>(hubUrl: string, pathname: string): Promise<T> {
  return hubFetch<T>(hubUrl, pathname);
}

export function hubPost<T>(
  hubUrl: string,
  pathname: string,
  body: unknown,
): Promise<T> {
  return hubFetch<T>(hubUrl, pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Relative "time ago" in English for the status table (PRD 11:
 * LAST SEEN like "2min ago"). Invalid/absent timestamps render as "—".
 */
export function formatRelative(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const seconds = Math.floor(Math.max(0, nowMs - t) / 1000);
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Sink for user-facing output — injectable in tests (default console.log). */
export type OutFn = (line: string) => void;

/**
 * Wraps a subcommand action: CliError → message on stderr + exit 1 (no stack
 * — the message IS the UX); anything else is a bug and keeps its detail.
 */
export async function runCliAction(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof CliError) {
      console.error(err.message);
    } else {
      console.error(`switchboard: unexpected error: ${String(err instanceof Error ? (err.stack ?? err.message) : err)}`);
    }
    process.exit(1);
  }
}
