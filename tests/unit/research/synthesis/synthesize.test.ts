// Unit test del synthesizer (Step 18) con chatJson mockato: percorso LLM
// valido, validazione logica con retry mirato, fallback su errore/invalido,
// propagazione dell'abort e schema JSON strict.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { resetLimitsCache } from "@/lib/config/limits";
import { appError } from "@/lib/errors";
import { chatJson } from "@/lib/server/llm/structured";
import type { Evidence, ResearchLimitations, ResearchPlan, SourceRecord } from "@/lib/types";
import {
  buildRawSynthesisSchema,
  synthesizeReport,
  validateSynthesisSections,
} from "@/research/synthesis/synthesize";
import { buildCitationTable } from "@/research/citations/map";

vi.mock("@/lib/server/llm/structured", () => ({ chatJson: vi.fn() }));

const QUESTION = "In quale anno fu fondata l'Università di Pisa?";

const PLAN: ResearchPlan = {
  objective: QUESTION,
  subQuestions: [
    { id: "sub-1", text: "In quale anno fu fondata l'Università di Pisa?", importance: "critical" },
  ],
  queries: [],
  constraints: { lang: "it", freshness: "any" },
  ambiguities: [],
  source: "fallback",
};

function evidence(
  over: Partial<Evidence> & Pick<Evidence, "id" | "sourceId" | "passage">,
): Evidence {
  return {
    url: `https://${over.sourceId}.example/`,
    passageIndex: 0,
    retrievedAt: "2026-01-02T00:00:00.000Z",
    confidence: "high",
    ...over,
  } as Evidence;
}

const EV_A = evidence({
  id: "src-a:p0",
  sourceId: "src-a",
  passage: "L'ateneo pisano fu fondato nell'anno 1343.",
  subQuestionId: "sub-1",
});
const EV_B = evidence({
  id: "src-b:p0",
  sourceId: "src-b",
  passage: "Una cronaca successiva riporta invece il 1344.",
  subQuestionId: "sub-1",
});
const REC_A: SourceRecord = {
  sourceId: "src-a",
  urlFinal: "https://final.src-a.example/p",
  canonicalUrl: "https://final.src-a.example/p",
  domain: "final.src-a.example",
  title: "Archivio A",
  status: "fetched",
  fetchedAt: "2026-01-02T00:00:00.000Z",
};
const REC_B: SourceRecord = { ...REC_A, sourceId: "src-b", title: "Archivio B" };

const NO_LIMITS: ResearchLimitations = {
  missingSources: false,
  llmUnavailable: false,
  searchUnavailable: false,
  budgetExceeded: false,
  timeBudgetExceeded: false,
  notes: [],
};

function baseRequest(over: Record<string, unknown> = {}) {
  return {
    researchId: "res-test-1",
    question: QUESTION,
    plan: PLAN,
    evidences: [EV_A, EV_B],
    sourceRecords: [REC_A, REC_B],
    conflicts: [],
    limitations: NO_LIMITS,
    ...over,
  };
}

function rawSynthesis(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sections: [
      {
        heading: "Risposta",
        paragraphs: [
          {
            text: "Secondo le fonti consultate l'ateneo fu fondato nel 1343.",
            kind: "fact",
            citations: [1],
          },
        ],
      },
    ],
    ...over,
  };
}

function mockResolved(raw: Record<string, unknown>): void {
  vi.mocked(chatJson).mockResolvedValue({
    value: raw as never,
    content: JSON.stringify(raw),
  });
}

beforeEach(() => {
  vi.stubEnv("NVIDIA_API_KEY", "sk-test-synthesis-key-123456");
  vi.stubEnv("NVIDIA_MODEL", "test/synthesis-v1");
  resetEnvCache();
  resetLimitsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetLimitsCache();
  vi.clearAllMocks();
});

describe("synthesizeReport — percorso LLM", () => {
  it("report valido: pass-through validato, claim derivati, nessun fallback", async () => {
    mockResolved(rawSynthesis());
    const result = await synthesizeReport(baseRequest());
    expect(result.usedFallback).toBe(false);
    expect(result.llmError).toBeUndefined();
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.paragraphs[0]).toMatchObject({
      text: "Secondo le fonti consultate l'ateneo fu fondato nel 1343.",
      kind: "fact",
      citations: [1],
    });
    // claim derivato in modo deterministico dal paragrafo classificato
    expect(result.claims).toEqual([
      {
        id: "claim-1",
        text: "Secondo le fonti consultate l'ateneo fu fondato nel 1343.",
        kind: "fact",
        supportEvidenceIds: ["src-a:p0"],
      },
    ]);
    expect(chatJson).toHaveBeenCalledTimes(1);
  });

  it("invoca il modello con le evidenze numerate come dati (indici di tabella)", async () => {
    mockResolved(rawSynthesis());
    await synthesizeReport(baseRequest());
    const { messages } = vi.mocked(chatJson).mock.calls[0]![0];
    expect(messages[0]!.role).toBe("system");
    const user = String(messages[1]!.content);
    // policy Step 25: dati nella recinzione versionata del builder centralizzato
    expect(user).toContain('<research_evidence version="1">');
    // le evidenze arrivano numerate con gli stessi indici della tabella
    expect(user).toContain('"index":1');
    expect(user).toContain('"passage":"L\'ateneo pisano fu fondato nell\'anno 1343."');
  });

  it("citazione inesistente → retry mirato → secondo output invalido → fallback", async () => {
    const invalid = rawSynthesis({
      sections: [
        {
          heading: "Risposta",
          paragraphs: [
            { text: "Fondata nel 1343.", kind: "fact", citations: [99] },
          ],
        },
      ],
    });
    vi.mocked(chatJson)
      .mockResolvedValueOnce({ value: invalid as never, content: "x" })
      .mockResolvedValueOnce({ value: invalid as never, content: "y" });
    const result = await synthesizeReport(baseRequest());
    expect(result.usedFallback).toBe(true);
    expect(result.llmError?.code).toBe("E_LLM_INVALID_RESPONSE");
    expect(chatJson).toHaveBeenCalledTimes(2);
    // la seconda chiamata riceve la correzione
    const secondMessages = vi.mocked(chatJson).mock.calls[1]![0].messages;
    expect(secondMessages).toHaveLength(3);
    expect(String(secondMessages[2]!.content)).toContain("non era valida");
    // il fallback è deterministico e marcato
    expect(result.sections[0]!.paragraphs[0]!.text).toContain("Sintesi meccanica senza LLM");
  });

  it("citazione inesistente al primo tentativo, corretta al secondo → successo", async () => {
    const invalid = rawSynthesis({
      sections: [
        {
          heading: "Risposta",
          paragraphs: [{ text: "Fondata nel 1343.", kind: "fact", citations: [99] }],
        },
      ],
    });
    vi.mocked(chatJson)
      .mockResolvedValueOnce({ value: invalid as never, content: "x" })
      .mockResolvedValueOnce({ value: rawSynthesis() as never, content: "y" });
    const result = await synthesizeReport(baseRequest());
    expect(result.usedFallback).toBe(false);
    expect(chatJson).toHaveBeenCalledTimes(2);
    expect(result.sections[0]!.paragraphs[0]!.citations).toEqual([1]);
  });
});

describe("synthesizeReport — fallback e annullamento", () => {
  it("errore di infrastruttura LLM → fallback con llmError safe", async () => {
    vi.mocked(chatJson).mockRejectedValue(
      appError("E_LLM_UNAVAILABLE", { phase: "llm", retryable: false }),
    );
    const result = await synthesizeReport(baseRequest());
    expect(result.usedFallback).toBe(true);
    expect(result.llmError?.code).toBe("E_LLM_UNAVAILABLE");
    expect(result.sections[0]!.paragraphs[0]!.text).toContain(EV_A.passage);
  });

  it("LLM non configurato → fallback senza chiamare il client", async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    resetLimitsCache();
    const result = await synthesizeReport(baseRequest());
    expect(result.usedFallback).toBe(true);
    expect(result.llmError?.code).toBe("E_LLM_UNAVAILABLE");
    expect(chatJson).not.toHaveBeenCalled();
    expect(result.sections.length).toBeGreaterThanOrEqual(1);
  });

  it("propaga l'annullamento utente (mai fallback)", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.mocked(chatJson).mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    );
    await expect(
      synthesizeReport(baseRequest({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("senza evidenze: report vuoto onesto, nessuna chiamata LLM", async () => {
    const result = await synthesizeReport(baseRequest({ evidences: [] }));
    expect(result.usedFallback).toBe(false);
    expect(result.sections).toEqual([]);
    expect(result.claims).toEqual([]);
    expect(chatJson).not.toHaveBeenCalled();
  });
});

describe("buildRawSynthesisSchema", () => {
  it("accetta un report conforme", () => {
    const guard = buildRawSynthesisSchema();
    expect(() => guard(rawSynthesis())).not.toThrow();
  });

  it("rifiuta i campi inventati (unknownKeys reject) e i kind non ammessi", () => {
    const guard = buildRawSynthesisSchema();
    const invented = rawSynthesis({ inventedField: "x" });
    expect(() => guard(invented)).toThrow(/inventedField/);
    const badKind = rawSynthesis({
      sections: [
        {
          heading: "R",
          paragraphs: [{ text: "ciao", kind: "surely-fact", citations: [] }],
        },
      ],
    });
    expect(() => guard(badKind)).toThrow(/one of/);
  });
});

describe("validateSynthesisSections", () => {
  it("valida la logica: citazioni intere esistenti, testo non vuoto", () => {
    const table = buildCitationTable([EV_A, EV_B], [REC_A, REC_B]);
    const ok = validateSynthesisSections(rawSynthesis() as never, table);
    expect(ok.ok).toBe(true);

    const badCitation = rawSynthesis({
      sections: [
        {
          heading: "Risposta",
          paragraphs: [{ text: "x", kind: "fact", citations: [7] }],
        },
      ],
    });
    const bad = validateSynthesisSections(badCitation as never, table);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problem).toContain("7");

    const emptyText = rawSynthesis({
      sections: [
        {
          heading: "Risposta",
          paragraphs: [{ text: "   ", kind: "fact", citations: [] }],
        },
      ],
    });
    const empty = validateSynthesisSections(emptyText as never, table);
    expect(empty.ok).toBe(false);
  });
});
