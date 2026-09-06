import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { resetLimitsCache } from "@/lib/config/limits";
import { AppError, toErrorInfo } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import {
  chatCompletion,
  llmConfigured,
  normalizeChatResponse,
} from "@/lib/server/llm/nvidia";

function fixture(name: string): string {
  return readFileSync(`tests/fixtures/nvidia/${name}.json`, "utf8");
}

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchSpy {
  impl: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
}

function fetchMock(...responses: Response[]): FetchSpy {
  const calls: FetchSpy["calls"] = [];
  let i = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses[i];
    if (next === undefined) throw new Error(`fetch chiamato più del previsto (${i + 1} volte)`);
    i++;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

function stubConfiguredEnv(): void {
  vi.stubEnv("NVIDIA_API_KEY", "sk-test-nvidia-key-123456");
  vi.stubEnv("NVIDIA_MODEL", "test/model-v1");
  vi.stubEnv("NVIDIA_BASE_URL", "https://llm.test.example/v1");
}

beforeEach(() => {
  resetEnvCache();
  resetLimitsCache();
  stubConfiguredEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetLimitsCache();
});

const MESSAGES = [{ role: "system" as const, content: "segreto di sistema da non loggare" }];

describe("chatCompletion", () => {
  it("chiama /chat/completions con auth header e normalizza la risposta", async () => {
    const { impl, calls } = fetchMock(jsonResponse(200, JSON.parse(fixture("success"))));
    const result = await chatCompletion({ messages: MESSAGES, fetchImpl: impl, maxAttempts: 1 });

    expect(result.content).toBe('{"answer":42}');
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 8, totalTokens: 20 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://llm.test.example/v1/chat/completions");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-nvidia-key-123456");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(calls[0].init?.body)) as { model: string; messages: unknown[] };
    expect(body.model).toBe("test/model-v1");
    expect(body.messages).toHaveLength(1);
  });

  it("non configurato: E_LLM_UNAVAILABLE non ritentabile senza chiamare fetch", async () => {
    vi.stubEnv("NVIDIA_API_KEY", "");
    vi.stubEnv("NVIDIA_MODEL", "");
    resetEnvCache();
    const { impl } = fetchMock();
    await expect(
      chatCompletion({ messages: MESSAGES, fetchImpl: impl, maxAttempts: 3 }),
    ).rejects.toMatchObject({
      code: "E_LLM_UNAVAILABLE",
      retryable: false,
      details: { unconfigured: true },
    });
    expect(llmConfigured()).toBe(false);
    expect(impl).toBeDefined();
  });

  it("401: nessun retry e nessun body del provider riflesso", async () => {
    const first = fetchMock(jsonResponse(401, JSON.parse(fixture("error-401"))));
    await expect(
      chatCompletion({ messages: MESSAGES, fetchImpl: first.impl, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "E_LLM_UNAVAILABLE", retryable: false });
    expect(first.calls).toHaveLength(1); // 4xx mai ritentato

    // Il messaggio pubblico non contiene il body del provider.
    const second = fetchMock(jsonResponse(401, JSON.parse(fixture("error-401"))));
    try {
      await chatCompletion({ messages: MESSAGES, fetchImpl: second.impl, maxAttempts: 1 });
      expect.unreachable("doveva rifiutare");
    } catch (err) {
      const info = toErrorInfo(err);
      expect(info.message).not.toContain("Invalid authentication");
      expect(info.message).not.toContain("sk-test");
    }
  });

  it("500: retry controllato poi E_LLM_UNAVAILABLE", async () => {
    const { impl, calls } = fetchMock(
      jsonResponse(500, JSON.parse(fixture("error-500"))),
      jsonResponse(500, JSON.parse(fixture("error-500"))),
    );
    await expect(
      chatCompletion({ messages: MESSAGES, fetchImpl: impl, maxAttempts: 2, baseDelayMs: 1 }),
    ).rejects.toMatchObject({ code: "E_LLM_UNAVAILABLE", retryable: true });
    expect(calls).toHaveLength(2);
  });

  it("429: ritentato (retryable)", async () => {
    const { impl, calls } = fetchMock(
      jsonResponse(429, { error: { message: "rate limited" } }),
      jsonResponse(200, JSON.parse(fixture("success"))),
    );
    const result = await chatCompletion({
      messages: MESSAGES,
      fetchImpl: impl,
      maxAttempts: 2,
      baseDelayMs: 1,
    });
    expect(result.content).toBe('{"answer":42}');
    expect(calls).toHaveLength(2);
  });

  it("body non-JSON e content non-stringa: E_LLM_INVALID_RESPONSE", async () => {
    const { impl } = fetchMock(jsonResponse(200, fixture("malformed")));
    await expect(
      chatCompletion({ messages: MESSAGES, fetchImpl: impl, maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: "E_LLM_INVALID_RESPONSE", retryable: false });

    const { impl: impl2 } = fetchMock(
      jsonResponse(200, JSON.parse(fixture("content-not-string"))),
    );
    await expect(
      chatCompletion({ messages: MESSAGES, fetchImpl: impl2, maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: "E_LLM_INVALID_RESPONSE" });
  });

  it("timeout: E_LLM_TIMEOUT (fetch cancellato via AbortSignal)", async () => {
    const hanging = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      })) as typeof fetch;

    const started = Date.now();
    await expect(
      chatCompletion({ messages: MESSAGES, fetchImpl: hanging, timeoutMs: 20, maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: "E_LLM_TIMEOUT", retryable: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("annullamento utente: propaga AbortError senza retry", async () => {
    const controller = new AbortController();
    const hanging = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      })) as typeof fetch;
    setTimeout(() => controller.abort(), 5);
    await expect(
      chatCompletion({
        messages: MESSAGES,
        fetchImpl: hanging,
        signal: controller.signal,
        timeoutMs: 5_000,
        maxAttempts: 3,
      }),
    ).rejects.toThrow("aborted");
  });

  it("la chiave non compare mai nei log", async () => {
    const lines: string[] = [];
    const logger = createLogger("llm-test", { level: "debug", sink: (l) => lines.push(l) });
    const { impl } = fetchMock(jsonResponse(200, JSON.parse(fixture("success"))));
    await chatCompletion({ messages: MESSAGES, fetchImpl: impl, maxAttempts: 1, logger });
    const all = JSON.stringify(lines);
    expect(all).not.toContain("sk-test-nvidia-key");
    expect(all).not.toContain("segreto di sistema");
  });
});

describe("normalizeChatResponse", () => {
  it("rifiuta risposte fuori schema", () => {
    expect(() => normalizeChatResponse(null)).toThrowError(AppError);
    expect(() => normalizeChatResponse({})).toThrowError(AppError);
    expect(() => normalizeChatResponse({ choices: [] })).toThrowError(AppError);
    expect(() => normalizeChatResponse(JSON.parse(fixture("content-not-string")))).toThrowError(
      AppError,
    );
  });

  it("usa finish_reason 'stop' se assente", () => {
    const res = normalizeChatResponse({
      choices: [{ message: { content: "ciao" } }],
    });
    expect(res.content).toBe("ciao");
    expect(res.finishReason).toBe("stop");
    expect(res.usage).toBeUndefined();
  });
});
