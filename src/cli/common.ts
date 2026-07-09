// Shared helpers of the Phase 4 CLI (PRD section 11): hub address resolution,
// HTTP client with self-explaining errors, and the "hub down" check every
// hub-talking subcommand runs first. User-facing texts in English (D8).
//
// The CLI talks to the hub EXCLUSIVELY over REST (/api/*) — never by touching
// the store files directly (single-writer stays true) — and touches tmux only
// through src/server/tmux.ts (the one sanctioned exception is the interactive
// `tmux attach` in start.ts, documented there).

import { BIND_HOST, loadConfig } from "../server/config.js";

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
