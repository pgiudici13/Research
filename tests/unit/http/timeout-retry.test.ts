import { describe, expect, it } from "vitest";
import { appError } from "@/lib/errors";
import { retry } from "@/lib/http/retry";
import { withTimeout } from "@/lib/http/timeout";

describe("withTimeout", () => {
  it("risolve se la promise finisce prima del timeout", async () => {
    await expect(
      withTimeout(Promise.resolve("ok"), 5_000, () => new Error("timeout")),
    ).resolves.toBe("ok");
  });

  it("rigetta con l'errore del factory al timeout e pulisce il timer", async () => {
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => resolve("troppo tardi"), 50);
    });
    const err = appError("E_LLM_TIMEOUT", { phase: "llm" });
    await expect(withTimeout(slow, 5, () => err)).rejects.toMatchObject({ code: "E_LLM_TIMEOUT" });
  });

  it("propaga il rifiuto della promise originale", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("originale")), 5_000, () => new Error("timeout")),
    ).rejects.toThrow(/originale/);
  });
});

describe("retry", () => {
  it("riesce al secondo tentativo dopo un errore retryable", async () => {
    let calls = 0;
    const result = await retry({
      attempts: 3,
      baseDelayMs: 1,
      fn: async () => {
        calls++;
        if (calls === 1) throw appError("E_LLM_TIMEOUT", { phase: "llm" });
        return "ok";
      },
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("non ritenta errori non retryable", async () => {
    let calls = 0;
    await expect(
      retry({
        attempts: 3,
        baseDelayMs: 1,
        fn: async () => {
          calls++;
          throw new Error("non retryable");
        },
      }),
    ).rejects.toThrow(/non retryable/);
    expect(calls).toBe(1);
  });

  it("rispetta il numero massimo di tentativi e rilancia l'ultimo errore", async () => {
    let calls = 0;
    await expect(
      retry({
        attempts: 3,
        baseDelayMs: 1,
        fn: async () => {
          calls++;
          throw appError("E_SEARCH_UNAVAILABLE", { phase: "search" });
        },
        onRetry: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "E_SEARCH_UNAVAILABLE" });
    expect(calls).toBe(3);
  });

  it("si ferma immediatamente se il segnale è già abortito", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      retry({
        attempts: 3,
        baseDelayMs: 1_000,
        signal: controller.signal,
        fn: async () => {
          calls++;
          throw appError("E_LLM_UNAVAILABLE", { phase: "llm" });
        },
      }),
    ).rejects.toThrow("aborted");
    expect(calls).toBe(0);
  });

  it("interrompe l'attesa tra i retry quando il segnale viene abortito", async () => {
    const controller = new AbortController();
    let calls = 0;
    const started = Date.now();
    const promise = retry({
      attempts: 5,
      baseDelayMs: 10_000,
      signal: controller.signal,
      fn: async () => {
        calls++;
        throw appError("E_LLM_TIMEOUT", { phase: "llm" });
      },
    });
    setTimeout(() => controller.abort(), 5);
    await expect(promise).rejects.toThrow("aborted");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toBe(1);
  });

  it("usa un isRetryable custom", async () => {
    let calls = 0;
    const result = await retry({
      attempts: 3,
      baseDelayMs: 1,
      isRetryable: () => true,
      fn: async () => {
        calls++;
        if (calls < 2) throw new Error("sempre retryable per policy");
        return "fatto";
      },
    });
    expect(result).toBe("fatto");
    expect(calls).toBe(2);
  });
});
