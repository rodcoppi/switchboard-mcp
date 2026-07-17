// The usage probe: normalise Claude's OAuth /usage bars and cache them, failing
// closed to [] so a missing token / offline hub just hides the card.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUsageProbe, normalizeLimit, parseUsageBody } from "../src/server/usage.js";

const silentLog = { debug() {}, info() {}, warn() {}, error() {} } as never;

const tmpFiles: string[] = [];
function credsFile(token: string | undefined): string {
  const p = path.join(os.tmpdir(), `sb-usage-${process.pid}-${tmpFiles.length}.json`);
  fs.writeFileSync(p, JSON.stringify({ claudeAiOauth: token ? { accessToken: token } : {} }));
  tmpFiles.push(p);
  return p;
}
afterEach(() => {
  for (const p of tmpFiles.splice(0)) fs.rmSync(p, { force: true });
});

const okResponse = (limits: unknown) => ({ ok: true, json: async () => ({ limits }) }) as Response;
const fakeFetch = (limits: unknown, onAuth?: (a: string) => void) =>
  (async (_url: string, init: RequestInit) => {
    onAuth?.((init.headers as Record<string, string>).Authorization);
    return okResponse(limits);
  }) as unknown as typeof fetch;

describe("normalizeLimit", () => {
  it("maps a valid bar and pulls the model label", () => {
    const [l] = normalizeLimit({
      kind: "weekly_scoped",
      group: "weekly",
      percent: 41,
      severity: "normal",
      resets_at: "2026-07-19T16:00:00Z",
      scope: { model: { display_name: "Fable" } },
    });
    expect(l).toEqual({
      kind: "weekly_scoped",
      group: "weekly",
      label: "Fable",
      percent: 41,
      severity: "normal",
      resetsAt: "2026-07-19T16:00:00Z",
    });
  });

  it("drops a malformed bar", () => {
    expect(normalizeLimit({ kind: "session" })).toEqual([]);
    expect(normalizeLimit({ percent: 5, resets_at: "x" })).toEqual([]);
    expect(normalizeLimit(null)).toEqual([]);
  });

  it("defaults label to null and group to unknown", () => {
    const [l] = normalizeLimit({ kind: "session", group: 3, percent: 10, resets_at: "z" });
    expect(l.label).toBeNull();
    expect(l.group).toBe("unknown");
  });
});

describe("parseUsageBody", () => {
  it("parses the NEW object format (five_hour / seven_day → utilization)", () => {
    const bars = parseUsageBody({
      five_hour: { utilization: 63, resets_at: "2026-07-17T07:59:59Z", limit_dollars: null },
      seven_day: { utilization: 36, resets_at: "2026-07-19T15:59:59Z" },
    });
    expect(bars).toEqual([
      { kind: "session", group: "session", label: "session · 5h", percent: 63, severity: "normal", resetsAt: "2026-07-17T07:59:59Z" },
      { kind: "weekly", group: "weekly", label: "weekly", percent: 36, severity: "normal", resetsAt: "2026-07-19T15:59:59Z" },
    ]);
  });

  it("still parses the OLD array format", () => {
    const bars = parseUsageBody({ limits: [{ kind: "session", group: "session", percent: 12, resets_at: "t" }] });
    expect(bars).toHaveLength(1);
    expect(bars[0].percent).toBe(12);
  });

  it("returns [] for the rate-limit error shape", () => {
    expect(parseUsageBody({ error: { type: "rate_limit_error", message: "Rate limited." } })).toEqual([]);
    expect(parseUsageBody(null)).toEqual([]);
  });
});

describe("createUsageProbe", () => {
  it("reads the token, fetches, and normalises", async () => {
    let sentAuth = "";
    const probe = createUsageProbe({
      log: silentLog,
      credentialsPath: credsFile("tok-123"),
      fetchFn: fakeFetch([{ kind: "session", group: "session", percent: 12, resets_at: "t" }], (a) => (sentAuth = a)),
    });
    const limits = await probe.getLimits();
    expect(sentAuth).toBe("Bearer tok-123");
    expect(limits).toEqual([
      { kind: "session", group: "session", label: null, percent: 12, severity: "normal", resetsAt: "t" },
    ]);
  });

  it("returns [] when the token is absent (no throw)", async () => {
    const probe = createUsageProbe({
      log: silentLog,
      credentialsPath: credsFile(undefined),
      fetchFn: fakeFetch([{ kind: "session", group: "session", percent: 1, resets_at: "t" }]),
    });
    await expect(probe.getLimits()).resolves.toEqual([]);
  });

  it("returns [] when the credentials file is missing (no throw)", async () => {
    const probe = createUsageProbe({
      log: silentLog,
      credentialsPath: "/does/not/exist.json",
      fetchFn: fakeFetch([]),
    });
    await expect(probe.getLimits()).resolves.toEqual([]);
  });

  it("caches within the TTL", async () => {
    let calls = 0;
    const probe = createUsageProbe({
      log: silentLog,
      credentialsPath: credsFile("t"),
      cacheMs: 10_000,
      fetchFn: (async () => {
        calls++;
        return okResponse([{ kind: "session", group: "session", percent: 1, resets_at: "t" }]);
      }) as unknown as typeof fetch,
    });
    await probe.getLimits();
    await probe.getLimits();
    expect(calls).toBe(1);
  });
});
