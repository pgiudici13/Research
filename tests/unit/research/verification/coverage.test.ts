import { describe, expect, it } from "vitest";
import type { Evidence, EvidenceConfidence, ResearchPlan, SubQuestion } from "@/lib/types";
import { EvidenceStore } from "@/research/evidence/store";
import {
  VERIFICATION_THRESHOLDS,
  assessCoverage,
  shouldContinue,
} from "@/research/verification/coverage";

function sub(id: string, importance: "critical" | "supporting"): SubQuestion {
  return { id, text: `Sotto-domanda ${id}: quando fu fondata l'università?`, importance };
}

function plan(subQuestions: SubQuestion[], freshness: string = "any"): ResearchPlan {
  return {
    objective: "Obiettivo di prova",
    subQuestions,
    queries: [
      { query: "università di pisa fondazione", purpose: "sub-question", subQuestionId: subQuestions[0]?.id, priority: 1 },
      { query: "storia ateneo pisano", purpose: "synonym", priority: 0.8 },
      { query: "cronache medievali toscane", purpose: "follow-up", priority: 0.6 },
    ],
    constraints: { lang: "it", freshness },
    ambiguities: [],
    source: "fallback",
  };
}

function makeEvidence(
  index: number,
  over: Partial<Evidence> = {},
): Evidence {
  return {
    id: `e-${index}`,
    sourceId: "src-A",
    url: "https://example.org/doc",
    passage: "Passaggio di prova numero " + index + " con testo sufficientemente lungo da essere un'evidenza.",
    passageIndex: index,
    retrievedAt: "2026-01-02T00:00:00.000Z",
    confidence: "medium",
    subQuestionId: "sub-1",
    relevance: 0.6,
    ...over,
  };
}

function storeOf(evidences: Evidence[]): EvidenceStore {
  let store = EvidenceStore.empty({ maxTotal: 100 });
  for (const e of evidences) store = store.addEvidence(e);
  return store;
}

const NOW = new Date("2026-07-01T00:00:00Z");

describe("assessCoverage — regole di copertura", () => {
  it("una evidenza forte copre una sotto-domanda NON chiave", () => {
    const report = assessCoverage(
      plan([sub("sub-1", "supporting")]),
      storeOf([makeEvidence(0, { confidence: "high", relevance: 0.8 })]),
    );
    expect(report.perSubQuestion[0].covered).toBe(true);
    expect(report.perSubQuestion[0].evidenceCount).toBe(1);
    expect(report.perSubQuestion[0].distinctSources).toBe(1);
    expect(report.perSubQuestion[0].maxRelevance).toBe(0.8);
    expect(report.perSubQuestion[0].minConfidence).toBe("high");
    // unica fonte non autorevole -> gap advisory low-authority, overall partial
    expect(report.overall).toBe("partial");
    expect(report.gaps.map((g) => g.type)).toEqual(["low-authority"]);
  });

  it("due evidenze forti da fonti autorevoli distinte -> sufficiente senza gap", () => {
    const report = assessCoverage(
      plan([sub("sub-1", "supporting")]),
      storeOf([
        makeEvidence(0, { sourceId: "src-A", url: "https://www.stats.gov/a", confidence: "high", relevance: 0.8 }),
        makeEvidence(1, { sourceId: "src-B", url: "https://uni.edu/b", confidence: "high", relevance: 0.7 }),
      ]),
    );
    expect(report.perSubQuestion[0].covered).toBe(true);
    expect(report.gaps).toEqual([]);
    expect(report.overall).toBe("sufficient");
    expect(report.llmUsed).toBe(false);
  });

  it("due evidenze low-confidence da fonti distinte coprono la sotto-domanda", () => {
    const report = assessCoverage(
      plan([sub("sub-1", "supporting")]),
      storeOf([
        makeEvidence(0, { sourceId: "src-A", confidence: "low", relevance: 0 }),
        makeEvidence(1, { sourceId: "src-B", confidence: "low", relevance: 0 }),
      ]),
    );
    expect(report.perSubQuestion[0].covered).toBe(true);
    expect(report.overall).toBe("sufficient");
  });

  it("una sola evidenza low non copre", () => {
    const report = assessCoverage(
      plan([sub("sub-1", "supporting")]),
      storeOf([makeEvidence(0, { confidence: "low", relevance: 0 })]),
    );
    expect(report.perSubQuestion[0].covered).toBe(false);
    expect(report.gaps.map((g) => g.type)).toEqual(["uncovered-subquestion"]);
  });

  it("claim chiave: una sola fonte (anche forte) non basta -> gap single-source", () => {
    const report = assessCoverage(
      plan([sub("sub-1", "critical")]),
      storeOf([makeEvidence(0, { confidence: "high", relevance: 0.9 })]),
    );
    expect(report.perSubQuestion[0].covered).toBe(false);
    expect(report.gaps.map((g) => g.type)).toEqual(["single-source"]);
    expect(report.overall).toBe("insufficient");
  });

  it("claim chiave con due fonti indipendenti -> coperto", () => {
    const report = assessCoverage(
      plan([sub("sub-1", "critical")]),
      storeOf([
        makeEvidence(0, { sourceId: "src-A", url: "https://www.stats.gov/a", confidence: "high", relevance: 0.8 }),
        makeEvidence(1, { sourceId: "src-B", url: "https://uni.edu/b", confidence: "high", relevance: 0.7 }),
      ]),
    );
    expect(report.perSubQuestion[0].covered).toBe(true);
    expect(report.gaps).toEqual([]);
    expect(report.overall).toBe("sufficient");
  });

  it("nessuna evidenza -> gap no-evidence e overall insufficient", () => {
    const report = assessCoverage(plan([sub("sub-1", "supporting")]), storeOf([]));
    expect(report.perSubQuestion[0].covered).toBe(false);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].type).toBe("no-evidence");
    expect(report.gaps[0].suggestedQueries.length).toBeGreaterThan(0);
    expect(report.overall).toBe("insufficient");
  });

  it("soglia documentata: relevance 0.25 copre, 0.24 no", () => {
    expect(VERIFICATION_THRESHOLDS.strongRelevanceMin).toBe(0.25);
    const atThreshold = assessCoverage(
      plan([sub("sub-1", "supporting")]),
      storeOf([makeEvidence(0, { relevance: 0.25 })]),
    );
    expect(atThreshold.perSubQuestion[0].covered).toBe(true);

    const below = assessCoverage(
      plan([sub("sub-1", "supporting")]),
      storeOf([makeEvidence(0, { relevance: 0.24 })]),
    );
    expect(below.perSubQuestion[0].covered).toBe(false);
    expect(below.gaps[0].type).toBe("uncovered-subquestion");
  });

  it("è deterministico: stesso input -> stesso report", () => {
    const single = { p: plan([sub("sub-1", "critical")]), store: storeOf([makeEvidence(0, { confidence: "high", relevance: 0.9 })]) };
    expect(assessCoverage(single.p, single.store)).toEqual(
      assessCoverage(plan([sub("sub-1", "critical")]), storeOf([makeEvidence(0, { confidence: "high", relevance: 0.9 })])),
    );
  });
});

describe("assessCoverage — freschezza e conflitti", () => {
  it("freschezza richiesta e fonti senza data recente -> gap freshness", () => {
    const report = assessCoverage(
      plan([sub("sub-1", "supporting")], "year"),
      storeOf([
        makeEvidence(0, { sourceId: "src-A", confidence: "high", relevance: 0.8 }),
        makeEvidence(1, { sourceId: "src-B", confidence: "high", relevance: 0.7 }),
      ]),
      {
        sourceDates: new Map([
          ["src-A", "2020-01-01"],
          ["src-B", undefined],
        ]),
        now: NOW,
      },
    );
    const freshness = report.gaps.find((g) => g.type === "freshness");
    expect(freshness).toBeDefined();
    expect(freshness?.subQuestionId).toBe("sub-1");
    expect(freshness?.suggestedQueries.join(" ")).toContain("2026"); // anno da clock
    expect(report.overall).toBe("partial");
  });

  it("freschezza richiesta e fonti recenti -> nessun gap freshness", () => {
    const report = assessCoverage(
      plan([sub("sub-1", "supporting")], "year"),
      storeOf([makeEvidence(0, { confidence: "high", relevance: 0.8 })]),
      { sourceDates: new Map([["src-A", "2026-06-01"]]), now: NOW },
    );
    expect(report.gaps.some((g) => g.type === "freshness")).toBe(false);
  });

  it("conflitti noti per sotto-domanda -> gap conflicting", () => {
    const report = assessCoverage(
      plan([sub("sub-1", "supporting")]),
      storeOf([makeEvidence(0, { confidence: "high", relevance: 0.8 })]),
      { conflictsBySub: new Map([["sub-1", ["anno di fondazione discorde"]]]) },
    );
    expect(report.gaps.some((g) => g.type === "conflicting")).toBe(true);
    expect(report.overall).toBe("partial");
  });
});

describe("shouldContinue — condizioni di stop esplicite", () => {
  const gaps = [{ type: "uncovered-subquestion" as const, subQuestionId: "sub-1", suggestedQueries: ["x"] }];

  it("profondità raggiunta -> stop depth-reached (anche con gap)", () => {
    expect(shouldContinue({ round: 2, maxDepth: 2, budgetLeft: 5, gaps })).toEqual({
      go: false,
      reason: "depth-reached",
    });
  });

  it("budget esaurito -> stop budget-exhausted", () => {
    expect(shouldContinue({ round: 1, maxDepth: 3, budgetLeft: 0, gaps })).toEqual({
      go: false,
      reason: "budget-exhausted",
    });
  });

  it("profondità e budget insieme -> vince la profondità", () => {
    expect(shouldContinue({ round: 3, maxDepth: 3, budgetLeft: 0, gaps })).toEqual({
      go: false,
      reason: "depth-reached",
    });
  });

  it("nessun gap -> stop sufficient (mai loop)", () => {
    expect(shouldContinue({ round: 1, maxDepth: 3, budgetLeft: 5, gaps: [] })).toEqual({
      go: false,
      reason: "sufficient",
    });
  });

  it("gap residui con budget e profondità -> prosegue", () => {
    expect(shouldContinue({ round: 1, maxDepth: 3, budgetLeft: 5, gaps })).toEqual({
      go: true,
      reason: "gaps-remain",
    });
  });
});

describe("Evidence confidence type sanity", () => {
  it("minConfidence è la confidenza più debole tra le evidenze", () => {
    const report = assessCoverage(
      plan([sub("sub-1", "supporting")]),
      storeOf([
        makeEvidence(0, { confidence: "high", relevance: 0.9 }),
        makeEvidence(1, { sourceId: "src-B", confidence: "low", relevance: 0 }),
      ]),
    );
    expect(report.perSubQuestion[0].minConfidence).toBe("low" satisfies EvidenceConfidence);
  });
});
