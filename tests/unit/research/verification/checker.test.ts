import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { resetLimitsCache } from "@/lib/config/limits";
import type { Evidence } from "@/lib/types";
import { chatJson } from "@/lib/server/llm/structured";
import {
  checkClaim,
  deterministicVerdict,
} from "@/research/verification/checker";

vi.mock("@/lib/server/llm/structured", () => ({ chatJson: vi.fn() }));

function makeEvidence(index: number, over: Partial<Evidence> = {}): Evidence {
  return {
    id: `e-${index}`,
    sourceId: `src-${index}`,
    url: "https://example.org/doc",
    passage: `Passaggio ${index}: l'Università di Pisa fu fondata nel Trecento secondo le fonti consultate.`,
    passageIndex: index,
    retrievedAt: "2026-01-02T00:00:00.000Z",
    confidence: "high",
    relevance: 0.9,
    ...over,
  };
}

const CLAIM = "L'Università di Pisa fu fondata nel 1343.";

beforeEach(() => {
  vi.stubEnv("NVIDIA_API_KEY", "sk-test-checker-key-123456");
  vi.stubEnv("NVIDIA_MODEL", "test/checker-v1");
  resetEnvCache();
  resetLimitsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetLimitsCache();
  vi.clearAllMocks();
});

describe("deterministicVerdict", () => {
  it("nessuna evidenza -> unsupported", () => {
    const result = deterministicVerdict([]);
    expect(result.verdict).toBe("unsupported");
    expect(result.evidenceIds).toEqual([]);
    expect(result.llmUsed).toBe(false);
  });

  it("evidenza forte da fonti indipendenti -> supported", () => {
    const result = deterministicVerdict([
      makeEvidence(0),
      makeEvidence(1, { sourceId: "src-2", confidence: "high", relevance: 0.8 }),
    ]);
    expect(result.verdict).toBe("supported");
    expect(result.evidenceIds.sort()).toEqual(["e-0", "e-1"]);
  });

  it("una sola fonte forte con requireIndependentSources -> solo parziale", () => {
    const result = deterministicVerdict([makeEvidence(0)], true);
    expect(result.verdict).toBe("partially-supported");
    expect(result.evidenceIds).toEqual(["e-0"]);
  });

  it("evidenze deboli -> partially-supported o unsupported, mai contradicted", () => {
    const weak = deterministicVerdict([
      makeEvidence(0, { confidence: "medium", relevance: 0.3 }),
    ]);
    expect(weak.verdict).toBe("partially-supported");
    const irrelevant = deterministicVerdict([
      makeEvidence(0, { confidence: "low", relevance: 0 }),
    ]);
    expect(irrelevant.verdict).toBe("unsupported");
    // il verdetto deterministico non emette MAI contraddizioni
    const any = deterministicVerdict([makeEvidence(0), makeEvidence(1)]);
    expect(any.verdict).not.toBe("contradicted");
  });
});

describe("checkClaim", () => {
  it("verdetto LLM valido: evidenceIds sottoinsieme -> accettato", async () => {
    const evidences = [makeEvidence(0), makeEvidence(1)];
    vi.mocked(chatJson).mockResolvedValue({
      value: {
        verdict: "supported",
        evidenceIds: ["e-0", "e-1"],
        rationale: "Due fonti confermano la data.",
      },
      content: "{}",
    });
    const result = await checkClaim({ claim: CLAIM, evidences });
    expect(result.llmUsed).toBe(true);
    expect(result.verdict).toBe("supported");
    expect(result.evidenceIds).toEqual(["e-0", "e-1"]);
  });

  it("vincolo violato (id fuori dall'insieme) -> scarta e marca unsupported", async () => {
    vi.mocked(chatJson).mockResolvedValue({
      value: {
        verdict: "supported",
        evidenceIds: ["e-0", "e-999"], // e-999 non esiste tra le evidenze passate
        rationale: "Inventato.",
      },
      content: "{}",
    });
    const result = await checkClaim({ claim: CLAIM, evidences: [makeEvidence(0)] });
    expect(result.llmUsed).toBe(true);
    expect(result.verdict).toBe("unsupported");
    expect(result.evidenceIds).toEqual([]);
  });

  it("errore infrastruttura LLM -> verdetto deterministico, llmUsed false", async () => {
    const evidences = [makeEvidence(0), makeEvidence(1, { sourceId: "src-2" })];
    vi.mocked(chatJson).mockRejectedValue(
      Object.assign(new Error("boom"), { code: "E_LLM_UNAVAILABLE", phase: "llm" }),
    );
    const result = await checkClaim({ claim: CLAIM, evidences });
    expect(result.llmUsed).toBe(false);
    expect(result.verdict).toBe("supported"); // fallback deterministico su 2 fonti
  });

  it("JSON invalido post-retry (E_LLM_INVALID_RESPONSE) -> verdetto deterministico", async () => {
    const evidences = [makeEvidence(0, { confidence: "medium", relevance: 0.3 })];
    vi.mocked(chatJson).mockRejectedValue(
      Object.assign(new Error("invalid"), { code: "E_LLM_INVALID_RESPONSE", phase: "llm" }),
    );
    const result = await checkClaim({ claim: CLAIM, evidences });
    expect(result.llmUsed).toBe(false);
    expect(result.verdict).toBe("partially-supported");
  });

  it("LLM non configurato -> fallback senza chiamare il client", async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    resetLimitsCache();
    const result = await checkClaim({
      claim: CLAIM,
      evidences: [makeEvidence(0), makeEvidence(1, { sourceId: "src-2" })],
    });
    expect(result.llmUsed).toBe(false);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it("nessuna evidenza -> unsupported senza chiamare l'LLM", async () => {
    const result = await checkClaim({ claim: CLAIM, evidences: [] });
    expect(result.verdict).toBe("unsupported");
    expect(chatJson).not.toHaveBeenCalled();
  });
});
