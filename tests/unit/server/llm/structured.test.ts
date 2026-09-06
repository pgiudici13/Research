import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { resetLimitsCache } from "@/lib/config/limits";
import {
  buildValidationErrorPath,
  chatJson,
} from "@/lib/server/llm/structured";
import { num, obj, str } from "@/lib/validate/schema";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchMock(...contents: string[]): { impl: typeof fetch } {
  let calls = 0;
  const impl = (async () => {
    const content = contents[Math.min(calls, contents.length - 1)];
    calls++;
    const body = JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    });
    return jsonResponse(200, body);
  }) as typeof fetch;
  return { impl };
}

const schema = obj({ answer: num() });
const MESSAGES = [{ role: "system" as const, content: "Sei un assistente." }];

beforeEach(() => {
  vi.stubEnv("NVIDIA_API_KEY", "sk-test-nvidia-key-123456");
  vi.stubEnv("NVIDIA_MODEL", "test/model-v1");
  resetEnvCache();
  resetLimitsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetLimitsCache();
});

describe("chatJson", () => {
  it("ritorna il valore validato quando l'output è conforme", async () => {
    const { impl } = fetchMock('{"answer":42}');
    const result = await chatJson({ messages: MESSAGES, schema, fetchImpl: impl, maxAttempts: 2 });
    expect(result.value).toEqual({ answer: 42 });
  });

  it("ritenta con correzione se il primo output non è JSON", async () => {
    const { impl } = fetchMock("testo libero senza json", '{"answer":7}');
    const result = await chatJson({ messages: MESSAGES, schema, fetchImpl: impl, maxAttempts: 2 });
    expect(result.value).toEqual({ answer: 7 });
  });

  it("corregge output JSON ma fuori schema (riporta il percorso)", async () => {
    const { impl } = fetchMock('{"answer":"non-un-numero"}', '{"answer":3}');
    const result = await chatJson({ messages: MESSAGES, schema, fetchImpl: impl, maxAttempts: 2 });
    expect(result.value).toEqual({ answer: 3 });
  });

  it("dopo gli tentativi esauriti lancia E_LLM_INVALID_RESPONSE con dettaglio", async () => {
    const { impl } = fetchMock("non json", "non json");
    await expect(
      chatJson({ messages: MESSAGES, schema, fetchImpl: impl, maxAttempts: 2 }),
    ).rejects.toMatchObject({
      code: "E_LLM_INVALID_RESPONSE",
      details: { schemaPath: "JSON non parsabile" },
    });
  });

  it("propaga gli errori di infrastruttura senza mascherarli", async () => {
    const failing = (async () =>
      jsonResponse(401, { error: { message: "bad key" } })) as typeof fetch;
    await expect(
      chatJson({ messages: MESSAGES, schema, fetchImpl: failing, maxAttempts: 2 }),
    ).rejects.toMatchObject({ code: "E_LLM_UNAVAILABLE", retryable: false });
  });
});

describe("buildValidationErrorPath", () => {
  it("estrae il percorso non sensibile da un ValidationError", () => {
    const guard = obj({ a: obj({ b: str() }) });
    try {
      guard({ a: { b: 5 } });
      expect.unreachable();
    } catch (err) {
      expect(buildValidationErrorPath(err as Parameters<typeof buildValidationErrorPath>[0])).toBe(
        "a.b",
      );
    }
  });
});
