// Test di performance DETERMINISTICI (Step 27): misurano CONTEGGI, non
// secondi. Con fake senza rete si verifica che il motore non faccia richieste
// inutili: fetch solo dei top-N (mai oltre il budget fonti), una sola fetch per
// canonicalUrl anche se lo stesso URL arriva da più query/round, LLM call
// ridotte al minimo (0 senza evidenze, 1 in una ricerca tipica, mai oltre il
// tetto per ricerca), e `BudgetUsage` coerente con i conteggi osservati.
// Numeri attesi documentati in docs/performance.md.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { resetLimitsCache } from "@/lib/config/limits";
import type {
  Conflict,
  Evidence,
  ExtractedPage,
  ResearchPlan,
  SearchResultItem,
  SourceCandidate,
  SubQuestion,
} from "@/lib/types";
import type { SearchOutcome } from "@/lib/server/search/searxng";
import { EvidenceStore } from "@/research/evidence/store";
import { createMemorySink } from "@/research/progress/sink";
import { assessCoverage } from "@/research/verification/coverage";
import { maxLlmCallsFor, RunBudget } from "@/research/engine/budget";
import { runResearch } from "@/research/engine/engine";
import type { EngineDeps, RankedWithScore } from "@/research/engine/deps";
import type { RawDocument } from "@/research/fetch/fetcher";

const NOW = () => new Date("2026-01-02T00:00:00Z");

function makePlan(subQuestions: SubQuestion[], queryCount: number): ResearchPlan {
  return {
    objective: "Ricostruire la fondazione dell'Università di Pisa.",
    subQuestions,
    queries: Array.from({ length: queryCount }, (_, i) => ({
      query: `query-${i + 1}`,
      purpose: "sub-question" as const,
      ...(subQuestions[0] !== undefined ? { subQuestionId: subQuestions[0].id } : {}),
      priority: 1 - i * 0.05,
    })),
    constraints: { lang: "it", freshness: "any" },
    ambiguities: [],
    source: "fallback",
  };
}

const SUB_1: SubQuestion = { id: "sub-1", text: "In quale anno fu fondata?", importance: "critical" };

interface PerfHarness {
  deps: EngineDeps;
  fetches: string[];
  syntheses: number;
  run(input?: { depth?: 1 | 2 | 3; maxSources?: number }): Promise<import("@/lib/types").ResearchReport>;
}

function buildPerfHarness(options: {
  subQuestions?: SubQuestion[];
  queryCount?: number;
  itemsFor?: (query: string, call: number) => SearchResultItem[];
} = {}): PerfHarness {
  const subQuestions = options.subQuestions ?? [SUB_1];
  const plan = makePlan(subQuestions, options.queryCount ?? 3);
  const fetches: string[] = [];
  let syntheses = 0;
  const clock = { current: NOW(), now: () => clock.current };

  const defaultItems: SearchResultItem[] = [
    { url: "https://example.org/a", title: "Fonte A", snippet: "Cronache del 1343.", engine: "google" },
    { url: "https://example.org/b", title: "Fonte B", snippet: "Bolla del 1343.", engine: "bing" },
  ];

  let searchCall = 0;
  const deps: EngineDeps = {
    sink: createMemorySink().sink,
    now: clock.now,
    async plan() {
      return { plan, usedFallback: false };
    },
    async search() {
      searchCall++;
      const items =
        options.itemsFor !== undefined
          ? options.itemsFor(plan.queries[Math.min(searchCall, plan.queries.length) - 1]?.query ?? "", searchCall)
          : defaultItems;
      return { ok: true, empty: false, items } satisfies SearchOutcome;
    },
    async rank(candidates: SourceCandidate[]): Promise<RankedWithScore<SourceCandidate>[]> {
      return candidates.map((candidate, i) => ({
        candidate,
        score: { total: 1 - i * 0.01, components: {}, flags: [] },
        rank: i + 1,
      }));
    },
    async fetchPage(url) {
      fetches.push(url);
      const text = `Contenuto della fonte ${url}: l'ateneo pisano fu fondato nell'anno 1343.`;
      return {
        ok: true,
        doc: {
          urlFinal: url,
          canonicalUrl: url,
          status: 200,
          contentType: "text/html",
          textBytes: text.length,
          truncated: false,
          body: new TextEncoder().encode(`<html><body><p>${text}</p></body></html>`),
        } satisfies RawDocument,
      };
    },
    extract(doc, ctx) {
      const text = new TextDecoder().decode(doc.body).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return {
        sourceId: ctx.sourceId,
        url: doc.urlFinal,
        domain: "example.org",
        title: "Pagina",
        text,
        truncated: false,
        extractedAt: "2026-01-02T00:00:01.000Z",
      } satisfies ExtractedPage;
    },
    makeEvidence({ page, subQuestions: subs, maxPerPage = 8 }) {
      if (page.text === "" || subs.length === 0) return [];
      const sub = subs[0];
      const evidence: Evidence = {
        id: `ev-${page.sourceId}:p0`,
        sourceId: page.sourceId,
        url: page.url,
        passage: page.text.slice(0, 500),
        passageIndex: 0,
        retrievedAt: page.extractedAt,
        confidence: "high",
        subQuestionId: sub.id,
        relevance: 0.9,
      };
      return [evidence].slice(0, maxPerPage);
    },
    evidenceStore(options) {
      return EvidenceStore.empty(options ?? {});
    },
    assessCoverage(planArg, store, opts) {
      return assessCoverage(planArg, store, opts);
    },
    detectConflicts(): Conflict[] {
      return [];
    },
    async synthesize(input) {
      syntheses++;
      return {
        sections: [
          {
            heading: "Risposta",
            paragraphs: [{ text: `Sintesi su ${input.evidences.length} evidenze.`, citations: [] }],
          },
        ],
        claims: [],
      };
    },
    async mapCitations() {
      return [];
    },
  };

  return {
    deps,
    fetches,
    get syntheses() {
      return syntheses;
    },
    run: async (input: { depth?: 1 | 2 | 3; maxSources?: number } = {}) =>
      runResearch(
        { question: "Quando fu fondata l'Università di Pisa?", options: { depth: input.depth ?? 1, maxSources: input.maxSources } },
        deps,
        new AbortController().signal,
      ),
  };
}

beforeEach(() => {
  vi.stubEnv("NVIDIA_API_KEY", "");
  resetEnvCache();
  resetLimitsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetLimitsCache();
});

describe("performance — niente richieste inutili (conteggi deterministici)", () => {
  it("fetch solo dei top-N: mai oltre il budget fonti richiesto", async () => {
    const h = buildPerfHarness({ queryCount: 3 });
    const report = await h.run({ maxSources: 2 });
    expect(report.status).toBe("completed");
    expect(report.budgetUsed.fetchAttempts).toBe(2);
    expect(h.fetches.length).toBe(2); // niente fetch oltre maxSources
    expect(report.budgetUsed.sourcesAnalyzed).toBe(2);
    expect(report.budgetUsed.queriesUsed).toBe(3);
    expect(h.fetches.every((url) => url.startsWith("https://"))).toBe(true);
  });

  it("lo stesso URL da query diverse → una sola fetch (cache per-run sul canonical)", async () => {
    const h = buildPerfHarness({
      queryCount: 2,
      itemsFor: () => [
        { url: "https://example.org/a?utm=1", title: "A", snippet: "x", engine: "google" },
        { url: "https://example.org/b", title: "B", snippet: "y", engine: "bing" },
      ],
    });
    const report = await h.run({ maxSources: 4 });
    // /a?utm=1 e un eventuale /a senza tracking si deduplicano sul canonical
    expect(new Set(h.fetches).size).toBe(h.fetches.length);
    expect(h.fetches.length).toBe(2);
    expect(report.budgetUsed.fetchAttempts).toBe(2);
  });

  it("nessuna LLM call senza evidenze (sintesi saltata, non chiamata)", async () => {
    const h = buildPerfHarness({ itemsFor: () => [] });
    const report = await h.run();
    expect(report.status).toBe("failed");
    expect(report.budgetUsed.llmCalls).toBe(0);
    expect(h.syntheses).toBe(0);
  });

  it("ricerca tipica: una sola sintesi, llmCalls=1, mai oltre il tetto di ricerca", async () => {
    const h = buildPerfHarness({ queryCount: 4 });
    const report = await h.run({ maxSources: 4 });
    expect(report.status).toBe("completed");
    expect(h.syntheses).toBe(1); // LLM seriale: mai chiamate extra
    expect(report.budgetUsed.llmCalls).toBe(1);
    expect(report.budgetUsed.llmCalls).toBeLessThanOrEqual(maxLlmCallsFor(1));
    // BudgetUsage coerente con i conteggi osservati
    expect(report.budgetUsed.sourcesAnalyzed).toBe(h.fetches.length);
    expect(report.budgetUsed.fetchAttempts).toBe(h.fetches.length);
  });

  it("nessun URL rifetchato tra i round (cache per-run persiste sul canonical)", async () => {
    const second = SUB_1;
    const h = buildPerfHarness({
      subQuestions: [SUB_1, { ...second, id: "sub-2", text: "Da chi fu fondata?" }],
      queryCount: 2,
      // round 2 (follow-up per il gap sub-2) ripropone lo stesso /a già visto
      itemsFor: () => [
        { url: "https://example.org/a", title: "A", snippet: "x", engine: "google" },
        { url: "https://example.org/d", title: "D", snippet: "y", engine: "bing" },
      ],
    });
    const report = await h.run({ depth: 2, maxSources: 4 });
    // /a tentato nel round 1 NON viene rifetchato nel round 2: solo /d è nuovo
    expect(h.fetches.filter((url) => url === "https://example.org/a").length).toBe(1);
    expect(new Set(h.fetches).size).toBe(h.fetches.length);
    expect(report.budgetUsed.fetchAttempts).toBe(h.fetches.length);
  });
});

describe("performance — budget interno coerente", () => {
  it("il tetto LLM per ricerca dipende dalla profondità (C.2)", () => {
    expect(maxLlmCallsFor(1)).toBe(4);
    expect(maxLlmCallsFor(2)).toBe(6);
    expect(maxLlmCallsFor(5)).toBe(12);
  });

  it("RunBudget: clamp delle opzioni ai massimi di ambiente", () => {
    const budget = new RunBudget({ options: { maxSources: 999 }, startedAt: 0 });
    expect(budget.maxSources).toBeLessThanOrEqual(8);
    expect(budget.maxSources).toBeGreaterThanOrEqual(1);
  });
});
