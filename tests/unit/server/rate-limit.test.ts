// Unit test del rate limiter (Step 21): sliding window oraria, concorrenza,
// cleanup dei bucket scaduti e clock iniettabile.

import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "@/lib/server/rate-limit";

const CONFIG = { perHourPerIp: 3, concurrentPerIp: 2, windowMs: 60_000 };

// Per isolare la finestra oraria dalla concorrenza: nessun tetto attivo.
const HOURLY_ONLY = { perHourPerIp: 3, concurrentPerIp: 100, windowMs: 60_000 };

function clockAt(startMs: number) {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("InMemoryRateLimiter — finestra oraria", () => {
  it("consente fino al limite per IP nella finestra, poi 429", () => {
    const clock = clockAt(1_000_000);
    const limiter = new InMemoryRateLimiter(HOURLY_ONLY, clock.now);

    expect(limiter.acquire("ip-a")).toEqual({ allowed: true });
    expect(limiter.acquire("ip-a")).toEqual({ allowed: true });
    expect(limiter.acquire("ip-a")).toEqual({ allowed: true });

    const verdict = limiter.acquire("ip-a");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe("hourly");
      expect(verdict.retryAfterMs).toBeGreaterThan(0);
    }
    // IP diverso non limitato
    expect(limiter.acquire("ip-b")).toEqual({ allowed: true });
  });

  it("hit scaduti escono dalla finestra (sliding)", () => {
    const clock = clockAt(1_000_000);
    const limiter = new InMemoryRateLimiter(HOURLY_ONLY, clock.now);
    limiter.acquire("ip-a"); // hit a t=0
    clock.advance(10_000);
    limiter.acquire("ip-a"); // hit a t=10.000
    clock.advance(10_000);
    limiter.acquire("ip-a"); // hit a t=20.000 → 3/3 nella finestra
    clock.advance(10_000);
    expect(limiter.acquire("ip-a").allowed).toBe(false); // ancora 3 hit attivi

    clock.advance(30_001); // t=60.001: l'hit di t=0 scade (finestra 60s)
    expect(limiter.acquire("ip-a").allowed).toBe(true);

    clock.advance(10_001); // t=70.002: scade anche l'hit di t=10.000
    expect(limiter.acquire("ip-a").allowed).toBe(true);
  });
});

describe("InMemoryRateLimiter — concorrenza", () => {
  it("massimo N ricerche concorrenti per IP; release libera", () => {
    const limiter = new InMemoryRateLimiter({ ...CONFIG, perHourPerIp: 100 });
    expect(limiter.acquire("ip-a").allowed).toBe(true);
    expect(limiter.acquire("ip-a").allowed).toBe(true);
    const third = limiter.acquire("ip-a");
    expect(third.allowed).toBe(false);
    if (!third.allowed) expect(third.reason).toBe("concurrent");

    limiter.release("ip-a");
    expect(limiter.acquire("ip-a").allowed).toBe(true);
    limiter.release("ip-a");
    limiter.release("ip-a");
    expect(limiter.acquire("ip-a").allowed).toBe(true);
  });
});

describe("InMemoryRateLimiter — manutenzione", () => {
  it("reset svuota lo stato", () => {
    const limiter = new InMemoryRateLimiter(CONFIG);
    limiter.acquire("ip-a");
    limiter.acquire("ip-a");
    limiter.acquire("ip-a");
    expect(limiter.acquire("ip-a").allowed).toBe(false);
    limiter.reset();
    expect(limiter.acquire("ip-a").allowed).toBe(true);
  });

  it("release oltre il dovuto non porta la concorrenza sotto zero", () => {
    const limiter = new InMemoryRateLimiter({ ...CONFIG, perHourPerIp: 10 });
    limiter.acquire("ip-a");
    limiter.release("ip-a");
    limiter.release("ip-a");
    limiter.release("ip-a");
    expect(limiter.acquire("ip-a").allowed).toBe(true);
  });
});
