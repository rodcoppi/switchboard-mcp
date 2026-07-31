// Claude usage limits — the /usage bars (5-hour session + weekly), shown in the
// dashboard. This is a thin PROXY of Claude's OAuth usage endpoint, the exact
// source the CLI's own /usage reads. Copied from the reference app's approach:
//
//   - read the OAuth access token from ~/.claude/.credentials.json
//   - GET https://api.anthropic.com/api/oauth/usage with that Bearer token
//   - normalise the returned bars to { kind, group, label, percent, resetsAt }
//
// It is a single tiny HTTP GET, cached ~60s — NO parsing of the (potentially
// gigabytes of) local JSONL logs. An earlier attempt shelled out to ccusage,
// which loads all history into memory and OOM-killed the whole WSL box; this
// endpoint sidesteps that entirely. Any failure (no token, network, non-200)
// yields [] and the dashboard simply hides the card. The token NEVER leaves
// this process.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "./log.js";

/** One normalised /usage bar. */
export interface UsageLimit {
  kind: string; // e.g. "session", "weekly_all", "weekly_scoped"
  group: string; // "session" | "weekly" | ...
  /** Model name from the API (e.g. "Fable" on weekly_scoped), else null. */
  label: string | null;
  percent: number;
  severity: string; // "normal" | ...
  resetsAt: string; // ISO
}

export interface UsageProbe {
  /** The cached bars (fetches on first call / after the cache expires). */
  getLimits(): Promise<UsageLimit[]>;
  /** Bars plus freshness/backoff metadata for an honest unavailable state. */
  getSnapshot(): Promise<UsageSnapshot>;
}

export type UsageStatus = "ok" | "rate_limited" | "unauthorized" | "unavailable";

export interface UsageSnapshot {
  limits: UsageLimit[];
  /** Time of the last non-empty response, persisted across hub restarts. */
  updatedAt: string | null;
  stale: boolean;
  status: UsageStatus;
  /** When the upstream asked us to try again (429 Retry-After). */
  retryAt: string | null;
}

export const USAGE_CACHE_MS = 60_000;
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

export interface UsageProbeOptions {
  log: Logger;
  credentialsPath?: string;
  endpoint?: string;
  cacheMs?: number;
  fetchFn?: typeof fetch;
  /** Optional durable last-good cache. Production places it in ~/.switchboard. */
  cachePath?: string;
}

export function createUsageProbe(options: UsageProbeOptions): UsageProbe {
  const { log } = options;
  const credentialsPath =
    options.credentialsPath ?? join(homedir(), ".claude", ".credentials.json");
  const endpoint = options.endpoint ?? USAGE_ENDPOINT;
  const cacheMs = options.cacheMs ?? USAGE_CACHE_MS;
  const fetchFn = options.fetchFn ?? fetch;
  const cachePath = options.cachePath;

  interface CacheState {
    checkedAt: number;
    fetchedAt: number | null;
    retryAt: number | null;
    status: UsageStatus;
    limits: UsageLimit[];
  }

  const readStored = (): CacheState | null => {
    if (!cachePath) return null;
    try {
      const raw = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<CacheState>;
      if (!Array.isArray(raw.limits)) return null;
      const limits = raw.limits.flatMap((item) => normalizeStoredLimit(item));
      if (!limits.length) return null;
      return {
        // Always revalidate after a restart, while keeping the old bars visible.
        checkedAt: 0,
        fetchedAt: typeof raw.fetchedAt === "number" ? raw.fetchedAt : null,
        retryAt: typeof raw.retryAt === "number" ? raw.retryAt : null,
        status: raw.status === "rate_limited" ? "rate_limited" : "unavailable",
        limits,
      };
    } catch {
      return null;
    }
  };

  const persist = (state: CacheState): void => {
    if (!cachePath || !state.limits.length) return;
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      const temp = `${cachePath}.tmp`;
      writeFileSync(temp, JSON.stringify({ ...state, version: 1 }, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, cachePath);
    } catch (err) {
      log.warn(`[usage] could not persist the last-good cache: ${err instanceof Error ? err.message : err}`);
    }
  };

  let cache: CacheState | null = readStored();

  async function fetchLimits(): Promise<{ limits: UsageLimit[]; status: UsageStatus; retryAt: number | null }> {
    const raw = readFileSync(credentialsPath, "utf8");
    const creds = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    const token = creds.claudeAiOauth?.accessToken;
    if (!token) return { limits: [], status: "unauthorized", retryAt: null };
    const res = await fetchFn(endpoint, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (res.status === 429) {
      const retryAt = retryAtFromHeader(res.headers?.get?.("retry-after") ?? null);
      return { limits: [], status: "rate_limited", retryAt };
    }
    if (res.status === 401 || res.status === 403) {
      return { limits: [], status: "unauthorized", retryAt: null };
    }
    if (!res.ok) return { limits: [], status: "unavailable", retryAt: null };
    const limits = parseUsageBody(await res.json());
    return { limits, status: limits.length ? "ok" : "unavailable", retryAt: null };
  }

  const snapshot = (state: CacheState): UsageSnapshot => ({
    limits: state.limits,
    updatedAt: state.fetchedAt ? new Date(state.fetchedAt).toISOString() : null,
    stale: state.status !== "ok",
    status: state.status,
    retryAt: state.retryAt ? new Date(state.retryAt).toISOString() : null,
  });

  async function refresh(): Promise<UsageSnapshot> {
    const now = Date.now();
    if (cache && now - cache.checkedAt < cacheMs) return snapshot(cache);
    // Respect Anthropic's Retry-After instead of hammering the endpoint every
    // minute and extending a cooldown shared by every local wrapper.
    if (cache?.retryAt && cache.retryAt > now) {
      cache.checkedAt = now;
      return snapshot(cache);
    }

    try {
      const result = await fetchLimits();
      if (result.status === "ok") {
        cache = {
          checkedAt: now,
          fetchedAt: now,
          retryAt: null,
          status: "ok",
          limits: result.limits,
        };
      } else {
        cache = {
          checkedAt: now,
          fetchedAt: cache?.fetchedAt ?? null,
          retryAt: result.retryAt,
          status: result.status,
          limits: cache?.limits ?? [],
        };
      }
    } catch (err) {
      log.warn(`[usage] fetch failed: ${err instanceof Error ? err.message : err}`);
      cache = {
        checkedAt: now,
        fetchedAt: cache?.fetchedAt ?? null,
        retryAt: cache?.retryAt ?? null,
        status: "unavailable",
        limits: cache?.limits ?? [],
      };
    }
    persist(cache);
    return snapshot(cache);
  }

  return {
    async getLimits(): Promise<UsageLimit[]> {
      return (await refresh()).limits;
    },
    getSnapshot: refresh,
  };
}

function retryAtFromHeader(value: string | null, now = Date.now()): number {
  if (!value) return now + 5 * 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : now + 5 * 60_000;
}

/** Stored limits already use our public camelCase shape, unlike API limits. */
function normalizeStoredLimit(raw: unknown): UsageLimit[] {
  if (typeof raw !== "object" || raw === null) return [];
  const l = raw as Partial<UsageLimit>;
  if (
    typeof l.kind !== "string" ||
    typeof l.group !== "string" ||
    typeof l.percent !== "number" ||
    typeof l.resetsAt !== "string"
  ) return [];
  return [{
    kind: l.kind,
    group: l.group,
    label: typeof l.label === "string" ? l.label : null,
    percent: l.percent,
    severity: typeof l.severity === "string" ? l.severity : "normal",
    resetsAt: l.resetsAt,
  }];
}

/**
 * Turns the /usage response into bars, tolerating BOTH shapes Anthropic has
 * served:
 *   OLD: { limits: [ { kind, group, percent, resets_at, scope } ] }
 *   NEW: { five_hour: { utilization, resets_at }, seven_day: {…}, … }
 * plus the rate-limit shape { error: {…} } → [].
 */
export function parseUsageBody(body: unknown): UsageLimit[] {
  if (typeof body !== "object" || body === null) return [];
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.limits)) return b.limits.flatMap((e) => normalizeLimit(e));
  // New object format: each top-level entry that has a numeric utilisation and
  // a reset time is a window. The key names it (five_hour → the 5h session bar,
  // seven_day → the weekly bar); anything else is grouped by a "day/week" hint.
  const out: UsageLimit[] = [];
  for (const [key, val] of Object.entries(b)) {
    if (typeof val !== "object" || val === null) continue;
    const w = val as { utilization?: unknown; resets_at?: unknown };
    if (typeof w.utilization !== "number" || typeof w.resets_at !== "string") continue;
    const weekly = /day|week|7/i.test(key);
    out.push({
      kind: key === "five_hour" ? "session" : key === "seven_day" ? "weekly" : key,
      group: weekly ? "weekly" : "session",
      label: key === "five_hour" ? "session · 5h" : key === "seven_day" ? "weekly" : key.replace(/_/g, " "),
      percent: Math.round(w.utilization),
      severity: "normal",
      resetsAt: w.resets_at,
    });
  }
  return out;
}

/** Validates and normalises one raw API bar; [] when it is malformed. */
export function normalizeLimit(raw: unknown): UsageLimit[] {
  if (typeof raw !== "object" || raw === null) return [];
  const l = raw as {
    kind?: unknown;
    group?: unknown;
    percent?: unknown;
    severity?: unknown;
    resets_at?: unknown;
    scope?: { model?: { display_name?: unknown } } | null;
  };
  if (typeof l.kind !== "string" || typeof l.percent !== "number" || typeof l.resets_at !== "string") {
    return [];
  }
  const modelName = l.scope?.model?.display_name;
  return [
    {
      kind: l.kind,
      group: typeof l.group === "string" ? l.group : "unknown",
      label: typeof modelName === "string" ? modelName : null,
      percent: l.percent,
      severity: typeof l.severity === "string" ? l.severity : "normal",
      resetsAt: l.resets_at,
    },
  ];
}
