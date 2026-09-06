// server-only — rate limit in-memory per IP (Step 21). Sliding window su
// N richieste/ora + massimo M ricerche concorrenti per IP. Clock iniettabile
// per i test; bucket scaduti ripuliti a ogni accesso. Per v1 la memoria è
// in-process (accettabile e documentato: si azzera a ogni deploy/restart).

export interface RateLimitConfig {
  /** Richieste massime per IP nella finestra. */
  perHourPerIp: number;
  /** Ricerche concorrenti massime per IP. */
  concurrentPerIp: number;
  /** Finestra temporale in ms (default 1 ora). */
  windowMs?: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  perHourPerIp: 5,
  concurrentPerIp: 2,
  windowMs: 60 * 60 * 1000,
};

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; reason: "hourly" | "concurrent"; retryAfterMs: number };

/**
 * Rate limiter in-memory (sliding window + concorrenza). Non condiviso tra
 * istanze: per v1 va bene — documentato in STEP.md. Metodi:
 * - `acquire(ip)`: valuta la finestra oraria, poi la concorrenza; se ok
 *   registra l'hit e incrementa i concorrenti attivi;
 * - `release(ip)`: decrementa i concorrenti attivi (da chiamare a fine run);
 * - `reset()`: svuota lo stato (utile nei test e in un eventuale admin).
 */
export class InMemoryRateLimiter {
  private readonly config: Required<RateLimitConfig>;
  private readonly now: () => Date;
  private readonly hits = new Map<string, number[]>();
  private readonly active = new Map<string, number>();

  constructor(
    config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
    now: () => Date = () => new Date(),
  ) {
    this.config = {
      perHourPerIp: config.perHourPerIp,
      concurrentPerIp: config.concurrentPerIp,
      windowMs: config.windowMs ?? DEFAULT_RATE_LIMIT_CONFIG.windowMs!,
    };
    this.now = now;
  }

  private prune(ip: string, atMs: number): void {
    const cutoff = atMs - this.config.windowMs;
    const recent = (this.hits.get(ip) ?? []).filter((ts) => ts > cutoff);
    if (recent.length === 0) {
      this.hits.delete(ip);
    } else {
      this.hits.set(ip, recent);
    }
    if ((this.active.get(ip) ?? 0) <= 0) this.active.delete(ip);
  }

  acquire(ip: string): RateLimitVerdict {
    const atMs = this.now().getTime();
    this.prune(ip, atMs);

    const recent = this.hits.get(ip) ?? [];
    if (recent.length >= this.config.perHourPerIp) {
      const oldest = recent[0]!;
      return {
        allowed: false,
        reason: "hourly",
        retryAfterMs: Math.max(1, oldest + this.config.windowMs - atMs),
      };
    }

    const activeCount = this.active.get(ip) ?? 0;
    if (activeCount >= this.config.concurrentPerIp) {
      return {
        allowed: false,
        reason: "concurrent",
        retryAfterMs: 0,
      };
    }

    recent.push(atMs);
    this.hits.set(ip, recent);
    this.active.set(ip, activeCount + 1);
    return { allowed: true };
  }

  release(ip: string): void {
    const current = this.active.get(ip) ?? 0;
    if (current <= 1) {
      this.active.delete(ip);
    } else {
      this.active.set(ip, current - 1);
    }
  }

  reset(): void {
    this.hits.clear();
    this.active.clear();
  }
}
