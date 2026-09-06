import { describe, expect, it } from "vitest";
import {
  buildFallbackPlan,
  clampText,
  extractKeywords,
  normalizeQuestion,
} from "@/research/planning/fallback";

const GENERIC_QUESTION =
  "Qual è lo stato della ricerca sulla fusione nucleare a confinamento magnetico?";

describe("buildFallbackPlan — struttura e conformità", () => {
  it("produce un piano conforme: una sotto-domanda, ambiguità vuote, source fallback", () => {
    const plan = buildFallbackPlan({ question: GENERIC_QUESTION, maxQueries: 20 });
    expect(plan.source).toBe("fallback");
    expect(plan.subQuestions).toHaveLength(1);
    expect(plan.subQuestions[0].importance).toBe("critical");
    expect(plan.subQuestions[0].text).toContain(GENERIC_QUESTION);
    expect(plan.ambiguities).toEqual([]);
    expect(plan.constraints.lang).toBe("auto");
    expect(plan.constraints.freshness).toBe("any");
    expect(plan.objective).toBe(GENERIC_QUESTION);
  });

  it("produce query valide, uniche e ordinate per priorità decrescente", () => {
    const plan = buildFallbackPlan({ question: GENERIC_QUESTION, maxQueries: 20 });
    expect(plan.queries.length).toBeGreaterThanOrEqual(3);
    expect(plan.queries.length).toBeLessThanOrEqual(6);
    const queries = plan.queries.map((q) => q.query);
    expect(new Set(queries).size).toBe(queries.length);
    for (const q of plan.queries) {
      expect(q.query.length).toBeGreaterThan(0);
      expect(q.query.length).toBeLessThanOrEqual(300);
      expect(q.subQuestionId).toBe("sub-1");
    }
    for (let i = 1; i < plan.queries.length; i++) {
      expect(plan.queries[i - 1].priority).toBeGreaterThanOrEqual(plan.queries[i].priority);
    }
  });

  it("include la domanda testuale come prima query e una variante contraria", () => {
    const plan = buildFallbackPlan({ question: GENERIC_QUESTION, maxQueries: 20 });
    expect(plan.queries[0].query).toBe(GENERIC_QUESTION);
    expect(plan.queries[0].purpose).toBe("sub-question");
    expect(plan.queries.some((q) => q.purpose === "counter-argument")).toBe(true);
  });

  it("rispetta il budget massimo", () => {
    const plan = buildFallbackPlan({ question: GENERIC_QUESTION, maxQueries: 3 });
    expect(plan.queries.length).toBe(3);
  });
});

describe("buildFallbackPlan — freschezza e dominio pubblico", () => {
  it("aggiunge la variante con l'anno corrente del clock (mai hardcoded)", () => {
    const plan = buildFallbackPlan({
      question: GENERIC_QUESTION,
      options: { freshness: "year", lang: "it" },
      maxQueries: 20,
      now: new Date("2031-03-01T00:00:00Z"),
    });
    expect(plan.constraints.freshness).toBe("year");
    expect(plan.constraints.lang).toBe("it");
    const recent = plan.queries.filter((q) => q.purpose === "recent");
    expect(recent).toHaveLength(1);
    expect(recent[0].query.endsWith("2031")).toBe(true);
    for (const q of plan.queries) {
      expect(q.query).not.toContain("2026");
      expect(q.query).not.toContain("2025");
    }
  });

  it("aggiunge site:.gov/.edu solo per domande su istituzioni/dati pubblici", () => {
    const publicQuestion = "Quali sono gli ultimi dati istat sulla popolazione italiana?";
    const withHint = buildFallbackPlan({ question: publicQuestion, maxQueries: 20 });
    const siteQuery = withHint.queries.find((q) => q.purpose === "primary-source");
    expect(siteQuery).toBeDefined();
    expect(siteQuery?.query).toContain("site:.gov OR site:.edu");

    const generic = buildFallbackPlan({ question: GENERIC_QUESTION, maxQueries: 20 });
    expect(generic.queries.some((q) => q.purpose === "primary-source")).toBe(false);
  });
});

describe("buildFallbackPlan — casi limite", () => {
  it("domanda senza parole chiave utili produce comunque un piano", () => {
    const plan = buildFallbackPlan({ question: "che e per con del quale", maxQueries: 20 });
    expect(plan.queries.length).toBeGreaterThanOrEqual(3);
    for (const q of plan.queries) expect(q.query.length).toBeGreaterThan(0);
  });

  it("è deterministico a parità di input", () => {
    const a = buildFallbackPlan({
      question: GENERIC_QUESTION,
      maxQueries: 20,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const b = buildFallbackPlan({
      question: GENERIC_QUESTION,
      maxQueries: 20,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(a).toEqual(b);
  });

  it("domanda lunghissima: query sempre sotto i 300 caratteri", () => {
    const longQuestion = "parola ".repeat(200).trim();
    const plan = buildFallbackPlan({ question: longQuestion, maxQueries: 20 });
    for (const q of plan.queries) expect(q.query.length).toBeLessThanOrEqual(300);
  });
});

describe("helper", () => {
  it("normalizeQuestion collassa spazi e rifila", () => {
    expect(normalizeQuestion("  a  \n b   c ")).toBe("a b c");
  });

  it("clampText tronca su confine di parola", () => {
    const t = "una frase molto lunga da troncare qui";
    const clamped = clampText(t, 18);
    expect(clamped.length).toBeLessThanOrEqual(18);
    expect(t.startsWith(clamped)).toBe(true);
    expect(clampText("breve", 300)).toBe("breve");
  });

  it("extractKeywords rimuove stopword e numeri puri", () => {
    expect(extractKeywords("Quando il 2020 fu fondata l'università di Pisa?")).toEqual([
      "fondata",
      "università",
      "pisa",
    ]);
  });
});
