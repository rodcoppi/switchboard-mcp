// Unit tests for the sliding-window pair rate limiter (PRD sections 14 and
// 18). The clock is injected via options.now so the 60s window is driven
// deterministically — no real timers, no sleeps.

import { describe, expect, it } from "vitest";
import { PairRateLimiter } from "../src/server/ratelimit.js";

/** Limiter wired to a fake clock the test advances explicitly. */
function fakeClockLimiter(limitPerMinute: number, startAt = 0) {
  let nowMs = startAt;
  const limiter = new PairRateLimiter({ limitPerMinute, now: () => nowMs });
  return {
    limiter,
    advance(ms: number): void {
      nowMs += ms;
    },
  };
}

describe("PairRateLimiter", () => {
  it("accepts N sends and rejects the N+1th within the same window", () => {
    const { limiter } = fakeClockLimiter(3);
    for (let i = 0; i < 3; i++) {
      expect(limiter.tryAcquire("alpha", "beta"), `send ${i + 1}`).toBe(true);
    }
    expect(limiter.tryAcquire("alpha", "beta")).toBe(false);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(false);
  });

  it("frees the pair when the 60s window slides (recovery after a block)", () => {
    const { limiter, advance } = fakeClockLimiter(2);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true); // t=0
    advance(30_000);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true); // t=30s
    expect(limiter.tryAcquire("alpha", "beta")).toBe(false); // full

    // t=59s: the t=0 hit is still in the window → still blocked.
    advance(29_000);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(false);

    // t=60.001s: the t=0 hit expired → one slot comes back.
    advance(1_001);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true);
    // But the t=30s hit still counts → full again.
    expect(limiter.tryAcquire("alpha", "beta")).toBe(false);

    // t=120.002s: the t=30s and t=60.001s hits expired → pair freed.
    advance(60_001);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true);
  });

  it("rejected attempts do NOT extend the window (a looping agent does not lock itself out forever)", () => {
    const { limiter, advance } = fakeClockLimiter(1);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true); // t=0, only hit

    // Repeated rejections within the window: nothing can be recorded by them.
    for (const at of [10_000, 20_000, 30_000, 40_000, 50_000]) {
      advance(10_000);
      expect(limiter.tryAcquire("alpha", "beta"), `rejection at t=${at}ms`).toBe(false);
    }

    // t=60.001s: the ONLY real hit (t=0) expired — despite the 5 rejections in
    // between, the send passes again. If rejections extended the window,
    // this acquire would fail forever.
    advance(10_001);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true);
  });

  it("ORDERED pairs are independent budgets (a→b full does not affect b→a or a→c)", () => {
    const { limiter } = fakeClockLimiter(1);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(false); // a→b exhausted
    expect(limiter.tryAcquire("beta", "alpha")).toBe(true); // legitimate reply passes
    expect(limiter.tryAcquire("alpha", "gamma")).toBe(true); // another recipient passes
  });

  it("constructor rejects a non-integer limit or <= 0", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(
        () => new PairRateLimiter({ limitPerMinute: bad }),
        `limitPerMinute: ${bad}`,
      ).toThrow(/positive integer/);
    }
    expect(() => new PairRateLimiter({ limitPerMinute: 1 })).not.toThrow();
  });

  it("exposes limitPerMinute to compose the tool's error message", () => {
    const { limiter } = fakeClockLimiter(12);
    expect(limiter.limitPerMinute).toBe(12);
  });
});
