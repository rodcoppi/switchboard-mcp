// Anti-loop rate limiting (PRD section 14, layer 2 — "mecânica").
//
// Sliding-window limiter keyed by the ORDERED pair from→to: alpha→beta and
// beta→alpha are independent budgets, so a legitimate reply never competes
// with the traffic that prompted it. The window is a fixed 60s (the limit is
// expressed "per minute" in config: pairRateLimitPerMinute, default 12).
//
// The clock is injectable so tests can drive the window deterministically
// (PRD section 18: unit tests with fake clock).

export interface PairRateLimiterOptions {
  /** Maximum messages per ordered pair per minute. */
  limitPerMinute: number;
  /** Injectable clock returning epoch millis (default Date.now). */
  now?: () => number;
}

const WINDOW_MS = 60_000;

export class PairRateLimiter {
  private readonly limit: number;
  private readonly now: () => number;
  /** "from→to" → timestamps (epoch ms) of accepted sends inside the window. */
  private readonly hits = new Map<string, number[]>();

  constructor(options: PairRateLimiterOptions) {
    if (!Number.isInteger(options.limitPerMinute) || options.limitPerMinute <= 0) {
      throw new Error(
        `PairRateLimiter: limitPerMinute deve ser um inteiro positivo (recebido ${options.limitPerMinute}).`,
      );
    }
    this.limit = options.limitPerMinute;
    this.now = options.now ?? Date.now;
  }

  /** The configured per-minute limit (used to compose the tool error message). */
  get limitPerMinute(): number {
    return this.limit;
  }

  /**
   * Tries to consume one slot for the ordered pair from→to. Returns true and
   * records the hit when under the limit; returns false (nothing recorded)
   * when the pair already sent `limitPerMinute` messages in the last 60s —
   * a rejected attempt must not extend the window, or a looping agent would
   * lock itself out forever.
   */
  tryAcquire(from: string, to: string): boolean {
    const key = `${from}→${to}`; // "→" cannot appear in agent names (^[a-z0-9-]+$)
    const cutoff = this.now() - WINDOW_MS;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.limit) {
      // Keep only the pruned window (frees memory for stale pairs).
      this.hits.set(key, recent);
      return false;
    }

    recent.push(this.now());
    this.hits.set(key, recent);
    return true;
  }
}
