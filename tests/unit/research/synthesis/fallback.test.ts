// Unit test della sintesi di fallback deterministica (Step 18): nessuna frase
// inventata (solo testo verbatim delle evidenze), conflitti presentati mai
// risolti, limiti elencati, determinismo e citazioni numeriche coerenti.

import { describe, expect, it } from "vitest";
import type {
  Conflict,
  Evidence,
  ResearchLimitations,
  ResearchPlan,
  SourceRecord,
} from "@/lib/types";
import { buildCitationTable } from "@/research/citations/map";
import { buildFallbackSynthesis } from "@/research/synthesis/fallback";

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

function record(sourceId: string): SourceRecord {
  return {
    sourceId,
    urlFinal: `https://final.${sourceId}.example/page`,
    canonicalUrl: `https://final.${sourceId}.example/page`,
    domain: `final.${sourceId}.example`,
    title: `Titolo ${sourceId}`,
    status: "fetched",
    fetchedAt: "2026-01-02T00:00:00.000Z",
  };
}

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

const EV_A = evidence({
  id: "src-a:p0",
  sourceId: "src-a",
  passage: "La fondazione dell'ateneo pisano risale all'anno 1343.",
  subQuestionId: "sub-1",
});
const EV_B = evidence({
  id: "src-b:p0",
  sourceId: "src-b",
  passage: "Documenti ufficiali: bolla pontificia del 1343.",
  subQuestionId: "sub-1",
});
const REC_A = record("src-a");
const REC_B = record("src-b");

const NO_LIMITS: ResearchLimitations = {
  missingSources: false,
  llmUnavailable: true,
  searchUnavailable: false,
  budgetExceeded: false,
  timeBudgetExceeded: false,
  notes: [],
};

function build(tableRecords: SourceRecord[] = [REC_A, REC_B]) {
  const evidences = [EV_A, EV_B];
  const table = buildCitationTable(evidences, tableRecords);
  return { evidences, table };
}

describe("buildFallbackSynthesis", () => {
  it("una sezione per sotto-domanda con solo testo verbatim delle evidenze", () => {
    const { evidences, table } = build();
    const out = buildFallbackSynthesis({
      question: QUESTION,
      plan: PLAN,
      evidences,
      table,
      conflicts: [],
      limitations: NO_LIMITS,
    });
    expect(out.sections.length).toBeGreaterThanOrEqual(1);
    expect(out.sections[0]!.heading).toBe(PLAN.subQuestions[0]!.text);

    const paragraph = out.sections[0]!.paragraphs[0]!;
    expect(paragraph.kind).toBe("uncertain");
    expect(paragraph.text).toContain("Sintesi meccanica senza LLM");
    // ogni riga di evidenza è verbatim (contiene il passaggio esatto)
    expect(paragraph.text).toContain(EV_A.passage);
    expect(paragraph.text).toContain(EV_B.passage);
    // citazioni numeriche coerenti con la tabella (1..n)
    expect(paragraph.citations).toEqual([1, 2]);
  });

  it("nessuna frase inventata: ogni riga citata è contenuta in un passaggio", () => {
    const { evidences, table } = build();
    const out = buildFallbackSynthesis({
      question: QUESTION,
      plan: PLAN,
      evidences,
      table,
      conflicts: [],
      limitations: NO_LIMITS,
    });
    const body = out.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join("\n");
    const passages = evidences.map((e) => e.passage);
    // ogni riga della sintesi è una nota di sintesi, un passaggio, o un'etichetta
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("[")) continue;
      const isPassage = passages.some((p) => trimmed.includes(p));
      const isMeta =
        trimmed.startsWith("Sintesi meccanica") ||
        trimmed.startsWith("Limiti") ||
        trimmed.startsWith("- ") ||
        trimmed.startsWith("Nota:") ||
        trimmed.startsWith("Posizione") ||
        trimmed.startsWith("Conflitto non risolto") ||
        trimmed.startsWith("Nota temporale");
      expect(isPassage || isMeta, `riga non giustificata: ${trimmed}`).toBe(true);
    }
  });

  it("sotto-domanda senza evidenze: dichiara l'assenza, non inventa", () => {
    const plan: ResearchPlan = {
      ...PLAN,
      subQuestions: [
        { id: "sub-2", text: "Domanda senza evidenze", importance: "critical" },
      ],
    };
    const { table } = build();
    const out = buildFallbackSynthesis({
      question: QUESTION,
      plan,
      evidences: [EV_A], // non collegata a sub-1
      table,
      conflicts: [],
      limitations: NO_LIMITS,
    });
    expect(out.sections[0]!.paragraphs[0]!.text).toContain(
      "nessuna evidenza sufficiente",
    );
    expect(out.sections[0]!.paragraphs[0]!.citations).toEqual([]);
  });

  it("conflitti: sezione dedicata, entrambe le posizioni, mai risolti", () => {
    const conflicts: Conflict[] = [
      {
        id: "conf-sub-1:src-a:p0+src-b:p0",
        topic: "anno di fondazione",
        severity: "confirmed",
        statements: [
          { evidenceId: "src-a:p0", sourceId: "src-a", position: "Fondata nel 1343." },
          { evidenceId: "src-b:p0", sourceId: "src-b", position: "Fondata nel 1344." },
        ],
      },
    ];
    const { evidences, table } = build();
    const out = buildFallbackSynthesis({
      question: QUESTION,
      plan: PLAN,
      evidences,
      table,
      conflicts,
      limitations: NO_LIMITS,
    });
    const conflictSection = out.sections.find((s) => s.heading === "Conflitti");
    expect(conflictSection).toBeDefined();
    const text = conflictSection!.paragraphs[0]!.text;
    expect(text).toContain("Posizione 1: Fondata nel 1343.");
    expect(text).toContain("Posizione 2: Fondata nel 1344.");
    expect(text).toContain("Conflitto non risolto");
    expect(conflictSection!.paragraphs[0]!.kind).toBe("uncertain");
  });

  it("limiti: sezione Limiti con i flag della ricerca", () => {
    const limitations: ResearchLimitations = {
      ...NO_LIMITS,
      timeBudgetExceeded: true,
      notes: ["Tempo scaduto."],
    };
    const { evidences, table } = build();
    const out = buildFallbackSynthesis({
      question: QUESTION,
      plan: PLAN,
      evidences,
      table,
      conflicts: [],
      limitations,
    });
    const limitSection = out.sections.find((s) => s.heading === "Limiti");
    expect(limitSection).toBeDefined();
    const text = limitSection!.paragraphs[0]!.text;
    expect(text).toContain("tempo massimo");
    expect(text).toContain("Nota: Tempo scaduto.");
  });

  it("evidenze non assegnate a sotto-domanda non vengono perse", () => {
    const unassigned = evidence({
      id: "src-c:p0",
      sourceId: "src-c",
      passage: "Un passaggio senza sotto-domanda assegnata.",
    });
    const records = [REC_A, REC_B, record("src-c")];
    const evidences = [EV_A, unassigned];
    const table = buildCitationTable(evidences, records);
    const out = buildFallbackSynthesis({
      question: QUESTION,
      plan: PLAN,
      evidences,
      table,
      conflicts: [],
      limitations: NO_LIMITS,
    });
    const section = out.sections.find((s) => s.heading === "Evidenze non assegnate");
    expect(section).toBeDefined();
    expect(section!.paragraphs[0]!.text).toContain(unassigned.passage);
  });

  it("determinismo: doppia esecuzione produce lo stesso output", () => {
    const { evidences, table } = build();
    const input = {
      question: QUESTION,
      plan: PLAN,
      evidences,
      table,
      conflicts: [
        {
          id: "c1",
          topic: "anno",
          severity: "confirmed" as const,
          statements: [
            { evidenceId: "src-a:p0", sourceId: "src-a", position: "1343" },
            { evidenceId: "src-b:p0", sourceId: "src-b", position: "1344" },
          ],
        },
      ],
      limitations: NO_LIMITS,
    };
    expect(buildFallbackSynthesis(input)).toEqual(buildFallbackSynthesis(input));
  });

  it("deriva claim (kind uncertain) solo dai paragrafi con supporto", () => {
    const { evidences, table } = build();
    const out = buildFallbackSynthesis({
      question: QUESTION,
      plan: PLAN,
      evidences,
      table,
      conflicts: [],
      limitations: NO_LIMITS,
    });
    expect(out.claims.length).toBeGreaterThanOrEqual(1);
    for (const claim of out.claims) {
      expect(claim.kind).toBe("uncertain");
      expect(claim.supportEvidenceIds.length).toBeGreaterThan(0);
    }
  });
});
