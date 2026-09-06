import { describe, expect, it } from "vitest";
import type { Evidence } from "@/lib/types";
import { detectConflicts } from "@/research/contradictions/detect";

function makeEvidence(
  id: string,
  sourceId: string,
  passage: string,
  subQuestionId = "sub-1",
): Evidence {
  return {
    id,
    sourceId,
    url: `https://example.org/${sourceId}`,
    passage,
    passageIndex: 0,
    retrievedAt: "2026-01-02T00:00:00.000Z",
    confidence: "medium",
    subQuestionId,
    relevance: 0.6,
  };
}

describe("detectConflicts — divergenze", () => {
  it("numeri diversi nello stesso contesto -> confirmed", () => {
    const conflicts = detectConflicts([
      makeEvidence("e-a", "src-A", "La popolazione della città raggiunse i 10.000 abitanti secondo il censimento ufficiale del comune."),
      makeEvidence("e-b", "src-B", "La popolazione della città raggiunse i 12.000 abitanti secondo il censimento ufficiale del comune."),
    ]);
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0];
    expect(conflict.severity).toBe("confirmed");
    expect(conflict.temporalNote).toBeUndefined();
    expect(conflict.statements).toHaveLength(2); // entrambe le posizioni conservate
    expect(conflict.statements.map((s) => s.sourceId).sort()).toEqual(["src-A", "src-B"]);
    expect(conflict.statements.map((s) => s.evidenceId).sort()).toEqual(["e-a", "e-b"]);
    expect(conflict.topic.split(" ").length).toBeGreaterThanOrEqual(2);
    for (const s of conflict.statements) {
      expect(s.position.length).toBeLessThanOrEqual(400);
    }
  });

  it("negazione esplicita vs affermazione -> confirmed", () => {
    const conflicts = detectConflicts([
      makeEvidence("e-a", "src-A", "Il trattato non fu firmato nel 1343 secondo i documenti dell'archivio comunale."),
      makeEvidence("e-b", "src-B", "Il trattato fu firmato nel 1343 secondo i documenti dell'archivio comunale."),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe("confirmed");
  });

  it("anni diversi -> temporalNote e severity possible (mai confirmed)", () => {
    const conflicts = detectConflicts([
      makeEvidence("e-a", "src-A", "Secondo il rapporto del 2020 la spesa sanitaria è cresciuta del 3 per cento."),
      makeEvidence("e-b", "src-B", "Secondo il rapporto del 2024 la spesa sanitaria è cresciuta del 5 per cento."),
    ]);
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0];
    expect(conflict.severity).toBe("possible");
    expect(conflict.temporalNote).toBeDefined();
    expect(conflict.temporalNote).toContain("2020");
    expect(conflict.temporalNote).toContain("2024");
  });

  it("stesso contenuto con toni diversi -> nessun conflitto", () => {
    const conflicts = detectConflicts([
      makeEvidence("e-a", "src-A", "La città fu fondata nel 1343 secondo i documenti ufficiali conservati in archivio."),
      makeEvidence("e-b", "src-B", "La città venne fondata nel 1343 come attestano i documenti ufficiali dell'archivio."),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("coppie intra-fonte escluse", () => {
    const conflicts = detectConflicts([
      makeEvidence("e-a1", "src-A", "La popolazione della città raggiunse i 10.000 abitanti secondo il censimento."),
      makeEvidence("e-a2", "src-A", "La popolazione della città raggiunse i 12.000 abitanti secondo il censimento."),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("sotto-domande diverse -> nessuna coppia", () => {
    const conflicts = detectConflicts([
      makeEvidence("e-a", "src-A", "La popolazione della città raggiunse i 10.000 abitanti secondo il censimento.", "sub-1"),
      makeEvidence("e-b", "src-B", "La popolazione della città raggiunse i 12.000 abitanti secondo il censimento.", "sub-2"),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("overlap lessicale insufficiente -> nessun conflitto anche con numeri", () => {
    const conflicts = detectConflicts([
      makeEvidence("e-a", "src-A", "La galleria ospita 300 visitatori al giorno secondo le stime locali."),
      makeEvidence("e-b", "src-B", "Il museo comunale conta 500 opere esposte nelle sale principali."),
    ]);
    expect(conflicts).toEqual([]);
  });
});

describe("detectConflicts — determinismo", () => {
  const inputs = [
    makeEvidence("e-a", "src-A", "La popolazione della città raggiunse i 10.000 abitanti secondo il censimento ufficiale."),
    makeEvidence("e-b", "src-B", "La popolazione della città raggiunse i 12.000 abitanti secondo il censimento ufficiale."),
  ];

  it("id deterministici: stesso input -> stessi conflitti", () => {
    const first = detectConflicts(inputs);
    const second = detectConflicts(inputs);
    expect(first).toEqual(second);
    expect(first[0].id).toBe("conf-sub-1:e-a+e-b");
  });
});
