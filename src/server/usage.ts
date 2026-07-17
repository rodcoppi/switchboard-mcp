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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
}

export const USAGE_CACHE_MS = 60_000;
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

export interface UsageProbeOptions {
  log: Logger;
  credentialsPath?: string;
  endpoint?: string;
  cacheMs?: number;
  fetchFn?: typeof fetch;
}

export function createUsageProbe(options: UsageProbeOptions): UsageProbe {
  const { log } = options;
  const credentialsPath =
    options.credentialsPath ?? join(homedir(), ".claude", ".credentials.json");
  const endpoint = options.endpoint ?? USAGE_ENDPOINT;
  const cacheMs = options.cacheMs ?? USAGE_CACHE_MS;
  const fetchFn = options.fetchFn ?? fetch;

  let cache: { at: number; limits: UsageLimit[] } | null = null;

  async function fetchLimits(): Promise<UsageLimit[]> {
    const raw = readFileSync(credentialsPath, "utf8");
    const creds = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    const token = creds.claudeAiOauth?.accessToken;
    if (!token) return [];
    const res = await fetchFn(endpoint, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { limits?: unknown };
    if (!Array.isArray(body.limits)) return [];
    return body.limits.flatMap((entry) => normalizeLimit(entry));
  }

  return {
    async getLimits(): Promise<UsageLimit[]> {
      if (cache && Date.now() - cache.at < cacheMs) return cache.limits;
      let limits: UsageLimit[] = [];
      try {
        limits = await fetchLimits();
      } catch (err) {
        log.warn(`[usage] fetch failed: ${err instanceof Error ? err.message : err}`);
      }
      cache = { at: Date.now(), limits };
      return limits;
    },
  };
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
