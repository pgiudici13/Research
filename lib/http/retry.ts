// Retry controllato con backoff esponenziale + jitter.
// Regole: tentativi TOTALI limitati; nessun retry su errori non retryable;
// rispetto immediato di AbortSignal (anche durante l'attesa).

import { isRetryableError } from "@/lib/errors";

export interface RetryInfo {
  attempt: number;
  error: unknown;
  delayMs: number;
}

export interface RetryOptions<T> {
  fn: (attempt: number) => Promise<T>;
  /** Tentativi TOTALI (1 iniziale + retry). */
  attempts: number;
  /** Ritardo base (ms) per il primo retry. Default: 100. */
  baseDelayMs?: number;
  /** Ritardo massimo (ms). Default: 1000. */
  maxDelayMs?: number;
  /** Jitter ±20% sul ritardo. Default: true. */
  jitter?: boolean;
  /** Decide se un errore è ritentabile. Default: AppError con retryable=true. */
  isRetryable?: (err: unknown) => boolean;
  signal?: AbortSignal;
  onRetry?: (info: RetryInfo) => void;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function retry<T>(options: RetryOptions<T>): Promise<T> {
  const {
    fn,
    attempts,
    baseDelayMs = 100,
    maxDelayMs = 1_000,
    jitter = true,
    isRetryable = isRetryableError,
    signal,
    onRetry,
  } = options;

  if (attempts < 1) throw new Error("retry: attempts deve essere >= 1");

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) signal.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err;
      if (attempt >= attempts) throw err;

      const exponential = baseDelayMs * 2 ** (attempt - 1);
      const base = Math.min(exponential, maxDelayMs);
      const delayMs = jitter ? Math.round(base * (0.8 + Math.random() * 0.4)) : base;
      onRetry?.({ attempt, error: err, delayMs });
      await abortableSleep(delayMs, signal);
    }
  }
  throw lastError; // irraggiungibile, ma appaga il type checker
}
