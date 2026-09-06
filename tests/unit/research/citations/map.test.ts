// Unit test del citation mapping (Step 19): determinismo, fonti non analizzate
// mai citabili, chiavi invalide rilevate e rimozione, claims derivati.

import { describe, expect, it } from "vitest";
import type { Evidence, ReportSection, SourceRecord } from "@/lib/types";
import {
  buildCitationTable,
  deriveClaims,
  mapCitations,
  resolveReportCitations,
} from "@/research/citations/map";

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

function record(
  over: Partial<SourceRecord> & Pick<SourceRecord, "sourceId">,
): SourceRecord {
  return {
    urlFinal: `https://final.${over.sourceId}.example/page`,
    canonicalUrl: `https://final.${over.sourceId}.example/page`,
    domain: `final.${over.sourceId}.example`,
    title: `Titolo ${over.sourceId}`,
    status: "fetched",
    fetchedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  } as SourceRecord;
}

const EV_A = evidence({
  id: "src-a:p0",
  sourceId: "src-a",
  passage: "La fondazione dell'ateneo risale al 1343.",
  passageIndex: 0,
});
const EV_B = evidence({
  id: "src-b:p1",
  sourceId: "src-b",
  passage: "Documenti ufficiali: anno 1343, bolla pontificia.",
  passageIndex: 1,
});
const EV_C = evidence({
  id: "src-c:p0",
  sourceId: "src-c",
  passage: "Una cronaca successiva indica invece il 1344.",
  passageIndex: 0,
});
const REC_A = record({ sourceId: "src-a" });
const REC_B = record({ sourceId: "src-b" });
const REC_C = record({ sourceId: "src-c" });

describe("buildCitationTable", () => {
  it("ordina in modo stabile per sourceId e passageIndex, indici 1..n", () => {
    const table = buildCitationTable(
      [EV_C, EV_A, EV_B],
      [REC_A, REC_B, REC_C],
    );
    expect(table.map((c) => c.evidenceId)).toEqual(["src-a:p0", "src-b:p1", "src-c:p0"]);
    expect(table.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(table[0]!.sourceId).toBe("src-a");
    expect(table[0]!.url).toBe(REC_A.urlFinal);
    expect(table[0]!.title).toBe(REC_A.title);
    expect(table[0]!.passage).toBe(EV_A.passage);
  });

  it("esclude evidenze di fonti non analizzate (status !== fetched)", () => {
    const failedRecord = record({ sourceId: "src-a", status: "failed" });
    const table = buildCitationTable([EV_A, EV_B], [failedRecord, REC_B]);
    expect(table.map((c) => c.evidenceId)).toEqual(["src-b:p1"]);
  });

  it("deduplica per evidenceId e tronca il passaggio a 400 caratteri", () => {
    const long = evidence({
      id: "src-a:p0",
      sourceId: "src-a",
      passage: "x".repeat(600),
    });
    const table = buildCitationTable([long, EV_B], [REC_A, REC_B]);
    expect(table).toHaveLength(2);
    expect(table[0]!.passage).toHaveLength(400);
  });

  it("senza SourceRecord usa l'url dell'evidenza e titolo vuoto", () => {
    const table = buildCitationTable([EV_A]);
    expect(table[0]!.url).toBe(EV_A.url);
    expect(table[0]!.title).toBe("");
  });

  it("determinismo: due esecuzioni producono lo stesso mapping", () => {
    const shuffled = [EV_C, EV_B, EV_A, EV_C]; // duplicato incluso
    const a = buildCitationTable(shuffled, [REC_A, REC_B, REC_C]);
    const b = buildCitationTable([...shuffled].reverse(), [REC_B, REC_C, REC_A]);
    expect(a).toEqual(b);
  });
});

describe("resolveReportCitations", () => {
  const table = buildCitationTable([EV_A, EV_B], [REC_A, REC_B]);
  const sections: ReportSection[] = [
    {
      heading: "Risposta",
      paragraphs: [
        { text: "L'ateneo fu fondato nel 1343.", citations: [2, 1], kind: "fact" },
        { text: "Un'altra cronaca parla del 1344.", citations: [999], kind: "uncertain" },
        { text: "Nota senza citazioni.", citations: [] },
      ],
    },
  ];

  it("rileva le chiavi invalide e le rimuove dalle sezioni", () => {
    const resolution = resolveReportCitations(sections, table);
    expect(resolution.invalidKeys).toEqual([999]);
    const paragraph = resolution.sections[0]!.paragraphs;
    expect(paragraph[0]!.citations).toEqual([2, 1]);
    expect(paragraph[1]!.citations).toEqual([]);
  });

  it("traccia usedIndexes in ordine di primo utilizzo e usedEvidenceIds", () => {
    const resolution = resolveReportCitations(sections, table);
    expect(resolution.usedIndexes).toEqual([2, 1]);
    expect([...resolution.usedEvidenceIds]).toEqual(["src-b:p1", "src-a:p0"]);
  });

  it("rifiuta numeri non interi", () => {
    const bad: ReportSection[] = [
      {
        heading: "R",
        paragraphs: [{ text: "metà citazione", citations: [1.5] }],
      },
    ];
    const resolution = resolveReportCitations(bad, table);
    expect(resolution.invalidKeys).toEqual([1.5]);
    expect(resolution.usedIndexes).toEqual([]);
  });
});

describe("deriveClaims", () => {
  it("genera un claim deterministico per paragrafo classificato con supporto", () => {
    const table = buildCitationTable([EV_A, EV_B], [REC_A, REC_B]);
    const sections: ReportSection[] = [
      {
        heading: "Risposta",
        paragraphs: [
          { text: "Fondata nel 1343.", citations: [1, 2], kind: "fact" },
          { text: "Forse anche prima.", citations: [1], kind: "inference" },
          { text: "Senza kind non genera claim.", citations: [1] },
          { text: "Senza supporto non genera claim.", citations: [], kind: "uncertain" },
        ],
      },
    ];
    const claims = deriveClaims(sections, table);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      id: "claim-1",
      kind: "fact",
      supportEvidenceIds: ["src-a:p0", "src-b:p1"],
    });
    expect(claims[1]!.id).toBe("claim-2");
  });
});

describe("mapCitations (porta del motore)", () => {
  it("restituisce solo le citazioni usate, in ordine di primo utilizzo", () => {
    const table = buildCitationTable([EV_A, EV_B, EV_C], [REC_A, REC_B, REC_C]);
    const sections: ReportSection[] = [
      {
        heading: "Risposta",
        paragraphs: [{ text: "Fondata nel 1343.", citations: [3, 1], kind: "fact" }],
      },
    ];
    const citations = mapCitations({
      sections,
      evidences: [EV_A, EV_B, EV_C],
      sourceRecords: [REC_A, REC_B, REC_C],
    });
    // fonte B (indice 2) analizzata ma MAI citata: resta fuori dalle citations
    expect(citations.map((c) => c.index)).toEqual([3, 1]);
    expect(citations.map((c) => c.evidenceId)).toEqual(["src-c:p0", "src-a:p0"]);
    const sourcesUsed = [...new Set(citations.map((c) => c.sourceId))].sort();
    expect(sourcesUsed).toEqual(["src-a", "src-c"]);
  });

  it("rimuove silenziosamente le chiavi invalide (backstop)", () => {
    const sections: ReportSection[] = [
      {
        heading: "Risposta",
        paragraphs: [
          { text: "Fondata nel 1343.", citations: [1, 42], kind: "fact" },
        ],
      },
    ];
    const citations = mapCitations({
      sections,
      evidences: [EV_A],
      sourceRecords: [REC_A],
    });
    expect(citations.map((c) => c.index)).toEqual([1]);
  });
});
