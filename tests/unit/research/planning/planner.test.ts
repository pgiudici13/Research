import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { resetLimitsCache } from "@/lib/config/limits";
import { appError } from "@/lib/errors";
import { chatJson } from "@/lib/server/llm/structured";
import {
  buildRawPlanSchema,
  planResearch,
  type PlanResult,
} from "@/research/planning/planner";

vi.mock("@/lib/server/llm/structured", () => ({ chatJson: vi.fn() }));

const QUESTION = "Quando fu fondata l'Università di Pisa e da chi?";

interface RawQuery {
  query: string;
  purpose: string;
  subQuestionId?: string;
  priority: number;
}

function rawPlan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objective: "Ricostruire la fondazione dell'Università di Pisa.",
    subQuestions: [
      { id: "sub-1", text: "In quale anno fu fondata?", importance: "critical" },
      { id: "sub-2", text: "Da chi fu voluta?", importance: "supporting" },
    ],
    queries: [
      { query: "Università di Pisa anno di fondazione", purpose: "sub-question", subQuestionId: "sub-1", priority: 0.9 },
      { query: "storia ateneo pisano origini", purpose: "synonym", priority: 0.7 },
      { query: "papa Clemente VI bolla pontificia", purpose: "primary-source", subQuestionId: "sub-2", priority: 0.6 },
    ],
    constraints: { lang: "it", freshness: "recent" },
    ambiguities: [],
    ...over,
  };
}

beforeEach(() => {
  vi.stubEnv("NVIDIA_API_KEY", "sk-test-planner-key-123456");
  vi.stubEnv("NVIDIA_MODEL", "test/planner-v1");
  vi.stubEnv("RESEARCH_MAX_QUERIES", "6");
  resetEnvCache();
  resetLimitsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetLimitsCache();
  vi.clearAllMocks();
});

function mockResolved(raw: Record<string, unknown>): void {
  vi.mocked(chatJson).mockResolvedValue({
    value: raw as never,
    content: JSON.stringify(raw),
  });
}

async function resultOf(over: Record<string, unknown> = {}): Promise<PlanResult> {
  mockResolved(rawPlan(over));
  return planResearch({ question: QUESTION });
}

describe("planResearch — percorso LLM", () => {
  it("ritorna il piano LLM validato e sanificato", async () => {
    const result = await resultOf();
    expect(result.usedFallback).toBe(false);
    expect(result.llmError).toBeUndefined();
    expect(result.plan.source).toBe("llm");
    expect(result.plan.queries).toHaveLength(3);
    expect(result.plan.subQuestions).toHaveLength(2);
    expect(result.plan.constraints.lang).toBe("it");
    expect(result.plan.constraints.freshness).toBe("recent");
  });

  it("default lang 'auto' se manca; freschezza sconosciuta → 'any', opzioni vincono", async () => {
    mockResolved(rawPlan({ constraints: { freshness: "ultimo-anno" } }));
    const noOptions = await planResearch({ question: QUESTION });
    expect(noOptions.plan.constraints.lang).toBe("auto");
    expect(noOptions.plan.constraints.freshness).toBe("any");

    mockResolved(rawPlan({ constraints: {} }));
    const withOptions = await planResearch({
      question: QUESTION,
      options: { freshness: "year" },
    });
    expect(withOptions.plan.constraints.lang).toBe("auto");
    expect(withOptions.plan.constraints.freshness).toBe("year");
  });

  it("rimuove riferimenti a sotto-domande inesistenti e unisce i duplicati", async () => {
    mockResolved(
      rawPlan({
        queries: [
          { query: "Università di Pisa anno di fondazione", purpose: "sub-question", subQuestionId: "sub-1", priority: 0.9 },
          { query: "Università di Pisa anno di fondazione", purpose: "synonym", priority: 0.1 }, // duplicato
          { query: "storia ateneo pisano origini", purpose: "synonym", subQuestionId: "sub-999", priority: 0.7 }, // ref inesistente
          { query: "bolla pontificia 1343", purpose: "primary-source", priority: 0.6 },
        ],
      }),
    );
    const result = await planResearch({ question: QUESTION });
    const queries = result.plan.queries;
    expect(queries).toHaveLength(3); // unione del duplicato
    expect(new Set(queries.map((q) => q.query.toLowerCase())).size).toBe(3);
    const withDanglingRef = queries.find((q) => q.query.includes("storia ateneo"));
    expect(withDanglingRef?.subQuestionId).toBeUndefined();
  });

  it("non supera mai il budget: taglia per priorità", async () => {
    const queries: RawQuery[] = [];
    for (let i = 0; i < 10; i++) {
      queries.push({
        query: `query deterministica numero ${i}`,
        purpose: "synonym",
        priority: 1 - i / 10,
      });
    }
    mockResolved(rawPlan({ queries }));
    const result = await planResearch({ question: QUESTION });
    expect(result.plan.queries.length).toBeLessThanOrEqual(6); // RESEARCH_MAX_QUERIES
    expect(result.plan.queries).toHaveLength(6);
  });
});

describe("planResearch — fallback", () => {
  it("errore di infrastruttura LLM → fallback con llmError safe", async () => {
    vi.mocked(chatJson).mockRejectedValue(
      appError("E_LLM_UNAVAILABLE", { phase: "llm", retryable: false }),
    );
    const result = await planResearch({ question: QUESTION });
    expect(result.usedFallback).toBe(true);
    expect(result.llmError?.code).toBe("E_LLM_UNAVAILABLE");
    expect(result.plan.source).toBe("fallback");
    expect(result.plan.subQuestions).toHaveLength(1);
    expect(result.plan.queries.length).toBeGreaterThanOrEqual(3);
  });

  it("output LLM inutilizzabile dopo la sanificazione → fallback", async () => {
    mockResolved(
      rawPlan({
        queries: [
          { query: "stessa identica query", purpose: "synonym", priority: 0.9 },
          { query: "stessa identica query", purpose: "synonym", priority: 0.8 },
          { query: "stessa identica query", purpose: "synonym", priority: 0.7 },
        ],
      }),
    );
    const result = await planResearch({ question: QUESTION });
    expect(result.usedFallback).toBe(true);
    expect(result.llmError?.code).toBe("E_LLM_INVALID_RESPONSE");
  });

  it("errore LLM invalido (post-retry) → fallback", async () => {
    vi.mocked(chatJson).mockRejectedValue(
      appError("E_LLM_INVALID_RESPONSE", { phase: "llm" }),
    );
    const result = await planResearch({ question: QUESTION });
    expect(result.usedFallback).toBe(true);
    expect(result.llmError?.code).toBe("E_LLM_INVALID_RESPONSE");
  });

  it("LLM non configurato → fallback senza chiamare il client", async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    resetLimitsCache();
    const result = await planResearch({ question: QUESTION });
    expect(result.usedFallback).toBe(true);
    expect(result.llmError?.code).toBe("E_LLM_UNAVAILABLE");
    expect(result.plan.source).toBe("fallback");
    expect(chatJson).not.toHaveBeenCalled();
  });
});

describe("planResearch — annullamento e validazione input", () => {
  it("propaga l'annullamento utente (mai fallback)", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.mocked(chatJson).mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    );
    await expect(
      planResearch({ question: QUESTION, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("domanda fuori dai limiti → E_VALIDATION", async () => {
    await expect(planResearch({ question: "corta" })).rejects.toMatchObject({
      code: "E_VALIDATION",
    });
  });
});

describe("buildRawPlanSchema", () => {
  it("rifiuta i campi inventati (unknownKeys reject)", () => {
    const guard = buildRawPlanSchema(20);
    const bad = rawPlan({ inventedField: "presente" });
    expect(() => guard(bad)).toThrow(/inventedField/);
  });

  it("rifiuta piani senza query sufficienti", () => {
    const guard = buildRawPlanSchema(20);
    const emptyQueries = rawPlan({ queries: [] });
    expect(() => guard(emptyQueries)).toThrow(/at least 3/);
  });

  it("accetta un piano conforme", () => {
    const guard = buildRawPlanSchema(20);
    expect(() => guard(rawPlan())).not.toThrow();
  });
});
