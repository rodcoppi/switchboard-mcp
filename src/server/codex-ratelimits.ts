// Codex plan windows read LIVE from the account, the way the Codex CLI itself
// reads them — as opposed to codexlog.ts's snapshot, which only knows what the
// newest local rollout happened to record (and goes stale the moment the agent
// stops working: a rollout from yesterday still says "99%" long after the
// window reset).
//
// The source is `codex app-server`: the CLI's own JSON-RPC server, spoken as
// newline-delimited JSON over stdio, authenticated with the CLI's own login
// (no OpenAI credential ever passes through the hub). One short-lived process
// per read, no thread or turn is opened:
//
//   → {id:0, method:"initialize", params:{clientInfo:{name,version}}}
//   ← {id:0, result:{userAgent, codexHome, ...}}
//   → {method:"initialized", params:{}}                     (a notification)
//   → {id:1, method:"account/rateLimits/read"}
//   ← {id:1, result:{rateLimits:{limitId, planType,
//        primary:  {usedPercent, windowDurationMins, resetsAt /*epoch s*/},
//        secondary:{usedPercent, windowDurationMins, resetsAt}, ...},
//      rateLimitsByLimitId:{...}, accountId, rateLimitResetCredits, ...}}
//
// Server-initiated notifications (e.g. `remoteControl/status/changed`) are
// interleaved with the responses, so replies are matched by id and anything
// carrying a `method` is ignored.
//
// Verified live on this machine with codex-cli 0.154.0 (23/09): the sequence
// above answered in well under a second with primary 0% / 300 min and
// secondary 0% / 10080 min, planType "plus". The result also carries the
// account id and redeemable reset credits — deliberately NOT copied out; only
// the windows and the plan type leave this module.
//
// Guard rails: execFile-style spawn (argv array, never a shell string), a hard
// timeout (10s), a stdout cap (2 MB), and a kill that escalates SIGTERM →
// SIGKILL so a wedged app-server can never outlive the request.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexLiveWindow {
  id: "primary" | "secondary";
  usedPercent: number;
  /** Window length; null when the server did not say (the bar still renders). */
  windowMinutes: number | null;
  resetsAt: string;
}

export interface CodexLiveLimits {
  limits: CodexLiveWindow[];
  planType: string | null;
  limitId: string | null;
  limitName: string | null;
}

export interface ReadCodexRateLimitsOptions {
  /** Binary to run (tests point this at a fake app-server script). */
  bin?: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;

/**
 * True when a `codex` executable is on PATH. The hub launches codex agents
 * with this same PATH, so "not found here" means "no codex on this machine"
 * and the usage route reports no Codex section at all.
 */
export function codexInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, "codex"), fs.constants.X_OK);
      return true;
    } catch {
      /* not in this dir */
    }
  }
  return false;
}

/**
 * Normalizes app-server's camelCase rateLimits bucket. A window needs only a
 * finite usedPercent and resetsAt; the duration is optional. A window whose
 * reset is already in the past has rolled over, so it reads 0% — the server
 * normally reports fresh numbers, but this keeps a cached answer honest.
 */
export function normalizeLiveLimits(bucket: unknown, now = Date.now()): CodexLiveLimits | null {
  if (!bucket || typeof bucket !== "object") return null;
  const b = bucket as Record<string, unknown>;
  const limits: CodexLiveWindow[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const w = b[id] as Record<string, unknown> | null | undefined;
    if (!w || typeof w !== "object") continue;
    const pct = w.usedPercent;
    const reset = w.resetsAt;
    if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
    if (typeof reset !== "number" || !Number.isFinite(reset)) continue;
    const epoch = reset * 1000;
    const mins = w.windowDurationMins;
    limits.push({
      id,
      usedPercent: epoch <= now ? 0 : Math.min(100, Math.max(0, pct)),
      windowMinutes: typeof mins === "number" && Number.isFinite(mins) && mins > 0 ? mins : null,
      resetsAt: new Date(epoch).toISOString(),
    });
  }
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return { limits, planType: str(b.planType), limitId: str(b.limitId), limitName: str(b.limitName) };
}

/**
 * One live read. Resolves null on ANY failure (binary missing, not logged in,
 * protocol error, timeout, oversized output) — the caller falls back to the
 * rollout snapshot. Never rejects.
 */
export function readCodexRateLimits(opts: ReadCodexRateLimitsOptions = {}): Promise<CodexLiveLimits | null> {
  const now = opts.now ?? Date.now;
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(opts.bin ?? "codex", opts.args ?? ["app-server"], {
        cwd: os.homedir(),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    let buffer = "";
    let bytes = 0;
    let result: CodexLiveLimits | null = null;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc.stdin?.end();
      } catch {
        /* already closed */
      }
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
        // A process that ignores SIGTERM still dies: the kill is guaranteed.
        killTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        }, 1_000);
        killTimer.unref();
      }
      resolve(result);
    };
    const timer = setTimeout(finish, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const send = (msg: object): void => {
      if (!done) proc.stdin?.write(`${JSON.stringify(msg)}\n`);
    };

    proc.on("error", finish);
    proc.stdin?.on("error", finish);
    proc.on("close", () => {
      finish();
      if (killTimer && proc.exitCode !== null) clearTimeout(killTimer);
    });
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > (opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT)) {
        finish();
        return;
      }
      buffer += chunk;
      let nl: number;
      while (!done && (nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg: { id?: unknown; method?: unknown; result?: unknown; error?: unknown } | null;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // noise on stdout is not a reply
        }
        if (!msg || typeof msg !== "object" || msg.method !== undefined) continue; // notification
        if (msg.id === 0) {
          if (msg.error || !msg.result) {
            finish();
            return;
          }
          send({ method: "initialized", params: {} });
          send({ id: 1, method: "account/rateLimits/read" });
        } else if (msg.id === 1) {
          if (!msg.error && msg.result && typeof msg.result === "object") {
            const r = msg.result as { rateLimits?: unknown };
            result = normalizeLiveLimits(r.rateLimits, now());
          }
          finish();
          return;
        }
      }
    });
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "switchboard", version: "1.0.0" } } });
  });
}

/**
 * 60s cache in front of readCodexRateLimits, with single-flight: concurrent
 * dashboard polls share one app-server process. A failed read is cached too
 * (as null) so a logged-out CLI is not respawned on every poll.
 */
export function createCodexRateLimitsCache(opts: {
  read?: () => Promise<CodexLiveLimits | null>;
  ttlMs?: number;
  now?: () => number;
} = {}): () => Promise<CodexLiveLimits | null> {
  const read = opts.read ?? (() => readCodexRateLimits());
  const ttl = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let cached: { at: number; value: CodexLiveLimits | null } | null = null;
  let pending: Promise<CodexLiveLimits | null> | null = null;
  return () => {
    if (cached && now() - cached.at < ttl) return Promise.resolve(cached.value);
    if (pending) return pending;
    pending = read()
      .catch(() => null)
      .then((value) => {
        cached = { at: now(), value };
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

/**
 * The /api/usage Codex section: today's tokens always come from the rollouts
 * (the app-server has no per-day token count), and the plan windows come from
 * the live read when it succeeded, else from the rollout snapshot. The shape is
 * CodexUsageSnapshot either way, so the dashboard renders one code path.
 */
export function mergeCodexUsage<T extends {
  limits: unknown[];
  planType: string | null;
  limitId: string | null;
  limitName: string | null;
  updatedAt: string | null;
}>(snapshot: T, live: CodexLiveLimits | null, now = Date.now()): T {
  if (!live || live.limits.length === 0) return snapshot;
  return {
    ...snapshot,
    // Re-applied at serve time: a cached reading may have outlived its reset.
    limits: live.limits.map((l) => (Date.parse(l.resetsAt) <= now ? { ...l, usedPercent: 0 } : l)),
    planType: live.planType ?? snapshot.planType,
    limitId: live.limitId ?? snapshot.limitId,
    limitName: live.limitName ?? snapshot.limitName,
    updatedAt: new Date(now).toISOString(),
  };
}
