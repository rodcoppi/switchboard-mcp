// Live Codex plan windows via `codex app-server` — exercised against a fake
// app-server script, never the real binary (no network, no login needed).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  codexInstalled,
  createCodexRateLimitsCache,
  mergeCodexUsage,
  normalizeLiveLimits,
  readCodexRateLimits,
  type CodexLiveLimits,
} from "../src/server/codex-ratelimits.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-app-server.mjs");
const fake = (mode: string, ...rest: string[]) => ({ bin: process.execPath, args: [FAKE, mode, ...rest] });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("readCodexRateLimits", () => {
  it("speaks initialize → initialized → account/rateLimits/read and keeps only the windows", async () => {
    const r = await readCodexRateLimits(fake("ok"));
    expect(r?.planType).toBe("plus");
    expect(r?.limitId).toBe("codex");
    expect(r?.limits.map((l) => [l.id, l.usedPercent, l.windowMinutes])).toEqual([
      ["primary", 42, 300],
      ["secondary", 7, 10_080],
    ]);
    // Account identifiers and reset credits never leave the module.
    expect(JSON.stringify(r)).not.toContain("private");
  });

  it("keeps a window without a duration (percent + reset are enough)", async () => {
    const r = await readCodexRateLimits(fake("no-duration"));
    expect(r?.limits[1]).toMatchObject({ id: "secondary", usedPercent: 7, windowMinutes: null });
  });

  it("resolves null on a failed initialize or a logged-out account", async () => {
    expect(await readCodexRateLimits(fake("init-error"))).toBeNull();
    expect(await readCodexRateLimits(fake("no-login"))).toBeNull();
  });

  it("resolves null when the binary does not exist", async () => {
    expect(await readCodexRateLimits({ bin: "/nonexistent/codex-sb-test" })).toBeNull();
  });

  it("times out and KILLS a server that ignores SIGTERM", async () => {
    // A fresh pid file per run, so a leftover from an aborted run can never be
    // read as this one's.
    const pidFile = path.join(os.tmpdir(), `sb-fake-codex-${process.pid}-${Date.now()}.pid`);
    const started = Date.now();
    expect(await readCodexRateLimits({ ...fake("hang", pidFile), timeoutMs: 1_500 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(4_000);
    // Under a loaded full-suite run the fake may still be booting when the
    // timeout fires, and write its pid a moment later (or never, if it was
    // killed first — then there is nothing left alive to check). Both made
    // this test fail intermittently while the code under test was right.
    let pid = 0;
    const pidDeadline = Date.now() + 3_000;
    while (!pid && Date.now() < pidDeadline) {
      try {
        pid = Number(fs.readFileSync(pidFile, "utf8")) || 0;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    fs.rmSync(pidFile, { force: true });
    if (!pid) return;
    // SIGTERM is ignored; the SIGKILL escalation lands ~1s later — given room
    // for a busy machine.
    const deadline = Date.now() + 6_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it("gives up once stdout passes the output cap", async () => {
    const started = Date.now();
    expect(await readCodexRateLimits({ ...fake("flood"), maxOutputBytes: 256 * 1024 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("normalizeLiveLimits", () => {
  it("drops malformed windows and zeroes one whose reset has passed", () => {
    const now = 1_790_000_000_000;
    const r = normalizeLiveLimits({
      planType: "pro",
      primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: now / 1000 - 60 },
      secondary: { usedPercent: "7", resetsAt: now / 1000 + 60 },
    }, now);
    expect(r).toEqual({
      planType: "pro", limitId: null, limitName: null,
      limits: [{ id: "primary", usedPercent: 0, windowMinutes: 300, resetsAt: new Date(now - 60_000).toISOString() }],
    });
    expect(normalizeLiveLimits(null)).toBeNull();
  });
});

describe("createCodexRateLimitsCache", () => {
  it("caches for the TTL, shares one in-flight read, and caches failures too", async () => {
    let calls = 0;
    let clock = 0;
    const value: CodexLiveLimits = { limits: [], planType: "plus", limitId: null, limitName: null };
    const get = createCodexRateLimitsCache({
      read: async () => { calls++; return calls === 2 ? Promise.reject(new Error("boom")) : value; },
      ttlMs: 60_000,
      now: () => clock,
    });
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(value);
    expect(b).toBe(value);
    expect(calls).toBe(1);
    clock = 59_000;
    await get();
    expect(calls).toBe(1);
    clock = 61_000;
    expect(await get()).toBeNull(); // the failed read
    clock = 62_000;
    expect(await get()).toBeNull(); // …is cached, not retried every poll
    expect(calls).toBe(2);
  });
});

describe("mergeCodexUsage", () => {
  const snapshot = {
    total: 600, input: 500, output: 100, reasoning: 0,
    limits: [{ id: "primary" as const, usedPercent: 99, windowMinutes: 300, resetsAt: "2026-09-20T00:00:00.000Z" }],
    planType: "plus", limitId: "codex", limitName: null, updatedAt: "2026-09-20T00:00:00.000Z",
  };

  it("live windows replace the rollout's; today's tokens stay", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    const merged = mergeCodexUsage(snapshot, {
      limits: [
        { id: "primary", usedPercent: 3, windowMinutes: 300, resetsAt: "2026-09-23T15:00:00.000Z" },
        { id: "secondary", usedPercent: 20, windowMinutes: 10_080, resetsAt: "2026-09-23T11:00:00.000Z" },
      ],
      planType: "pro", limitId: null, limitName: null,
    }, now);
    expect(merged.total).toBe(600);
    expect(merged.planType).toBe("pro");
    expect(merged.limitId).toBe("codex");
    expect(merged.limits.map((l) => l.usedPercent)).toEqual([3, 0]); // secondary already reset
    expect(merged.updatedAt).toBe(new Date(now).toISOString());
  });

  it("a failed or empty live read falls back to the rollout snapshot", () => {
    expect(mergeCodexUsage(snapshot, null)).toBe(snapshot);
    expect(mergeCodexUsage(snapshot, { limits: [], planType: null, limitId: null, limitName: null })).toBe(snapshot);
  });
});

describe("codexInstalled", () => {
  it("looks for an executable `codex` on PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-codexbin-"));
    try {
      expect(codexInstalled({ PATH: dir })).toBe(false);
      fs.writeFileSync(path.join(dir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
      expect(codexInstalled({ PATH: `/nonexistent${path.delimiter}${dir}` })).toBe(true);
      expect(codexInstalled({})).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
