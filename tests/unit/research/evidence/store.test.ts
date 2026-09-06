import { describe, expect, it } from "vitest";
import type { Evidence } from "@/lib/types";
import { EvidenceStore } from "@/research/evidence/store";

function makeEvidence(index: number, over: Partial<Evidence> = {}): Evidence {
  return {
    id: `e-${index}`,
    sourceId: "src-A",
    url: "https://example.org/doc",
    passage: `Passaggio numero ${index} della fonte.`,
    passageIndex: index,
    retrievedAt: "2026-01-02T00:00:00.000Z",
    confidence: "medium",
    subQuestionId: "sub-1",
    relevance: 0.5,
    ...over,
  };
}

describe("EvidenceStore", () => {
  it("è immutabile: addEvidence non muta le istanze precedenti", () => {
    const store = EvidenceStore.empty();
    const first = store.addEvidence(makeEvidence(0));
    const second = first.addEvidence(makeEvidence(1));
    expect(store.count()).toBe(0);
    expect(first.count()).toBe(1);
    expect(second.count()).toBe(2);
    expect(store.all()).toEqual([]); // l'array precedente resta intatto
    expect(first.all()).toHaveLength(1);
    expect(second.all()).toHaveLength(2);
  });

  it("preserva l'ordine di inserimento in all()", () => {
    const store = EvidenceStore.empty()
      .addEvidence(makeEvidence(0, { sourceId: "src-B" }))
      .addEvidence(makeEvidence(1, { subQuestionId: "sub-2" }))
      .addEvidence(makeEvidence(2, { sourceId: "src-B" }));
    expect(store.all().map((e) => e.id)).toEqual(["e-0", "e-1", "e-2"]);
  });

  it("bySource e bySubQuestion filtrano correttamente", () => {
    const store = EvidenceStore.empty()
      .addEvidence(makeEvidence(0, { sourceId: "src-A", subQuestionId: "sub-1" }))
      .addEvidence(makeEvidence(1, { sourceId: "src-B", subQuestionId: "sub-1" }))
      .addEvidence(makeEvidence(2, { sourceId: "src-B", subQuestionId: "sub-2" }));
    expect(store.bySource("src-B").map((e) => e.id)).toEqual(["e-1", "e-2"]);
    expect(store.bySource("src-A").map((e) => e.id)).toEqual(["e-0"]);
    expect(store.bySubQuestion("sub-1").map((e) => e.id)).toEqual(["e-0", "e-1"]);
    expect(store.bySubQuestion("sub-9")).toEqual([]);
  });

  it("rispetta il budget totale contando gli scarti", () => {
    const store = EvidenceStore.empty({ maxTotal: 2 })
      .addEvidence(makeEvidence(0))
      .addEvidence(makeEvidence(1))
      .addEvidence(makeEvidence(2))
      .addEvidence(makeEvidence(3));
    expect(store.count()).toBe(2);
    expect(store.droppedCount).toBe(2);
    expect(store.all().map((e) => e.id)).toEqual(["e-0", "e-1"]);
  });

  it("removeBeyondBudget tiene le migliori per rilevanza (ordine di inserimento)", () => {
    const store = EvidenceStore.empty({ maxTotal: 10 })
      .addEvidence(makeEvidence(0, { relevance: 0.3 }))
      .addEvidence(makeEvidence(1, { relevance: 0.9 }))
      .addEvidence(makeEvidence(2, { relevance: 0.6 }))
      .addEvidence(makeEvidence(3, { relevance: 0.1 }));
    const trimmed = store.removeBeyondBudget(2);
    expect(trimmed.count()).toBe(2);
    expect(trimmed.droppedCount).toBe(2);
    // i tenuti sono e-1 (0.9) ed e-2 (0.6), nell'ordine originale
    expect(trimmed.all().map((e) => e.id)).toEqual(["e-1", "e-2"]);
    // la store originale non è stata toccata
    expect(store.count()).toBe(4);
    expect(store.droppedCount).toBe(0);
  });

  it("removeBeyondBudget non fa nulla sotto il limite", () => {
    const store = EvidenceStore.empty({ maxTotal: 10 }).addEvidence(makeEvidence(0));
    const trimmed = store.removeBeyondBudget(5);
    expect(trimmed.count()).toBe(1);
    expect(trimmed.droppedCount).toBe(0);
  });
});
