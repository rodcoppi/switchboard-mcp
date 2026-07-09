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
  it("aceita N envios e rejeita o N+1º dentro da mesma janela", () => {
    const { limiter } = fakeClockLimiter(3);
    for (let i = 0; i < 3; i++) {
      expect(limiter.tryAcquire("alpha", "beta"), `envio ${i + 1}`).toBe(true);
    }
    expect(limiter.tryAcquire("alpha", "beta")).toBe(false);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(false);
  });

  it("libera o par quando a janela de 60s desliza (recuperação após bloqueio)", () => {
    const { limiter, advance } = fakeClockLimiter(2);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true); // t=0
    advance(30_000);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true); // t=30s
    expect(limiter.tryAcquire("alpha", "beta")).toBe(false); // cheio

    // t=59s: o hit de t=0 ainda está na janela → continua bloqueado.
    advance(29_000);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(false);

    // t=60.001s: o hit de t=0 expirou → um slot volta.
    advance(1_001);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true);
    // Mas o hit de t=30s ainda conta → cheio de novo.
    expect(limiter.tryAcquire("alpha", "beta")).toBe(false);

    // t=120.002s: os hits de t=30s e t=60.001s expiraram → par liberado.
    advance(60_001);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true);
  });

  it("tentativas rejeitadas NÃO estendem a janela (agente em loop não se tranca para sempre)", () => {
    const { limiter, advance } = fakeClockLimiter(1);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true); // t=0, único hit

    // Rejeições repetidas dentro da janela: nada pode ser gravado por elas.
    for (const at of [10_000, 20_000, 30_000, 40_000, 50_000]) {
      advance(10_000);
      expect(limiter.tryAcquire("alpha", "beta"), `rejeição em t=${at}ms`).toBe(false);
    }

    // t=60.001s: o ÚNICO hit real (t=0) expirou — apesar das 5 rejeições no
    // meio, o envio volta a passar. Se as rejeições estendessem a janela,
    // este acquire falharia para sempre.
    advance(10_001);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true);
  });

  it("pares ORDENADOS são budgets independentes (a→b cheio não afeta b→a nem a→c)", () => {
    const { limiter } = fakeClockLimiter(1);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(true);
    expect(limiter.tryAcquire("alpha", "beta")).toBe(false); // a→b esgotado
    expect(limiter.tryAcquire("beta", "alpha")).toBe(true); // resposta legítima passa
    expect(limiter.tryAcquire("alpha", "gamma")).toBe(true); // outro destinatário passa
  });

  it("construtor rejeita limite não-inteiro ou <= 0", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(
        () => new PairRateLimiter({ limitPerMinute: bad }),
        `limitPerMinute: ${bad}`,
      ).toThrow(/inteiro positivo/);
    }
    expect(() => new PairRateLimiter({ limitPerMinute: 1 })).not.toThrow();
  });

  it("expõe limitPerMinute para compor a mensagem de erro da tool", () => {
    const { limiter } = fakeClockLimiter(12);
    expect(limiter.limitPerMinute).toBe(12);
  });
});
