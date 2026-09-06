import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { resetLimitsCache } from "@/lib/config/limits";
import type { Evidence } from "@/lib/types";
import { chatJson } from "@/lib/server/llm/structured";
import {
  classifyConflicts,
  detectConflicts,
} from "@/research/contradictions/detect";

vi.mock("@/lib/server/llm/structured", () => ({ chatJson: vi.fn() }));

function evidencePair(): Evidence[] {
  return [
    {
      id: "e-a",
      sourceId: "src-A",
      url: "https://example.org/a",
      passage: "La popolazione della città raggiunse i 10.000 abitanti secondo il censimento ufficiale.",
      passageIndex: 0,
      retrievedAt: "2026-01-02T00:00:00.000Z",
      confidence: "high",
      subQuestionId: "sub-1",
      relevance: 0.8,
    },
    {
      id: "e-b",
      sourceId: "src-B",
      url: "https://example.org/b",
      passage: "La popolazione della città raggiunse i 12.000 abitanti secondo il censimento ufficiale.",
      passageIndex: 1,
      retrievedAt: "2026-01-02T00:00:00.000Z",
      confidence: "high",
      subQuestionId: "sub-1",
      relevance: 0.8,
    },
  ];
}

beforeEach(() => {
  vi.stubEnv("NVIDIA_API_KEY", "sk-test-classify-key-123456");
  vi.stubEnv("NVIDIA_MODEL", "test/classify-v1");
  resetEnvCache();
  resetLimitsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetLimitsCache();
  vi.clearAllMocks();
});

describe("classifyConflicts", () => {
  it("nessun conflitto -> nessuna chiamata LLM", async () => {
    const result = await classifyConflicts([]);
    expect(result.conflicts).toEqual([]);
    expect(result.llmUsed).toBe(false);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it("classificazione valida: aggiorna severità e nota", async () => {
    const conflicts = detectConflicts(evidencePair());
    const conflictId = conflicts[0].id;
    vi.mocked(chatJson).mockResolvedValue({
      value: [
        { conflictId, severity: "confirmed", temporalNote: "Entrambe le fonti sono recenti.", keep: true },
      ],
      content: "[]",
    });
    const result = await classifyConflicts(conflicts);
    expect(result.llmUsed).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].severity).toBe("confirmed");
    expect(result.conflicts[0].temporalNote).toBe("Entrambe le fonti sono recenti.");
  });

  it("anti-regola: proposta di eliminazione NON lessicale -> rifiutata", async () => {
    const conflicts = detectConflicts(evidencePair());
    const conflictId = conflicts[0].id;
    vi.mocked(chatJson).mockResolvedValue({
      value: [{ conflictId, severity: "possible", keep: false }], // senza reason lessicale
      content: "[]",
    });
    const result = await classifyConflicts(conflicts);
    // il conflitto resta: mai eliminare una posizione per preferenza
    expect(result.llmUsed).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].id).toBe(conflictId);
  });

  it("scarto consentito SOLO per falso positivo lessicale", async () => {
    const conflicts = detectConflicts(evidencePair());
    const conflictId = conflicts[0].id;
    vi.mocked(chatJson).mockResolvedValue({
      value: [
        { conflictId, severity: "possible", keep: false, reason: "lexical-false-positive" },
      ],
      content: "[]",
    });
    const result = await classifyConflicts(conflicts);
    expect(result.llmUsed).toBe(true);
    expect(result.conflicts).toEqual([]);
  });

  it("risposta con id estranei/mancanti -> verdetto deterministico (resta tutto)", async () => {
    const conflicts = detectConflicts(evidencePair());
    vi.mocked(chatJson).mockResolvedValue({
      value: [
        { conflictId: "conf-sub-1:invented+id", severity: "possible", keep: false },
      ],
      content: "[]",
    });
    const result = await classifyConflicts(conflicts);
    expect(result.llmUsed).toBe(false);
    expect(result.conflicts).toHaveLength(1); // nessuna eliminazione
  });

  it("LLM non configurato -> fallback senza chiamare il client", async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    resetLimitsCache();
    const conflicts = detectConflicts(evidencePair());
    const result = await classifyConflicts(conflicts);
    expect(result.llmUsed).toBe(false);
    expect(result.conflicts).toEqual(conflicts);
    expect(chatJson).not.toHaveBeenCalled();
  });
});
