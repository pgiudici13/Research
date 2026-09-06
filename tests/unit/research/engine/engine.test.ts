import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { resetLimitsCache } from "@/lib/config/limits";
import type {
  Conflict,
  Evidence,
  ExtractedPage,
  ResearchPlan,
  SourceCandidate,
  SubQuestion,
} from "@/lib/types";
import type { ProgressEvent } from "@/lib/types";
import type { SearchOutcome } from "@/lib/server/search/searxng";
import { EvidenceStore } from "@/research/evidence/store";
import { createMemorySink } from "@/research/progress/sink";
import { assessCoverage } from "@/research/verification/coverage";
import { runResearch } from "@/research/engine/engine";
import type { EngineDeps, RankedWithScore } from "@/research/engine/deps";
import type { RawDocument } from "@/research/fetch/fetcher";

interface FakeClock {
  current: Date;
  now(): Date;
}

function makeClock(start = new Date("2026-01-02T00:00:00Z")): FakeClock {
  const clock: FakeClock = { current: start, now: () => new Date(clock.current.getTime()) };
  return clock;
}

function makePage(sourceId: string, text: string, url: string): ExtractedPage {
  return {
    sourceId,
    url,
    domain: "example.org",
    title: "Pagina di prova",
    text,
    truncated: false,
    extractedAt: "2026-01-02T00:00:01.000Z",
  };
}

interface FakeDepsOptions {
  clock?: FakeClock;
  search?: (query: string, call: number) => SearchOutcome;
  searchDown?: boolean;
  failFetchFor?: (url: string) => boolean;
  plan?: ResearchPlan;
}

interface FakeDeps {
  deps: EngineDeps;
  events: ProgressEvent[];
  calls: { searches: number; fetches: number; synthesized: number; consultedUrls: string[] };
}

function buildDeps(options: FakeDepsOptions = {}): FakeDeps {
  const clock = options.clock ?? makeClock();
  const memory = createMemorySink();
  const subQuestions: SubQuestion[] = [
    {
      id: "sub-1",
      text: "In quale anno fu fondata l'Università di Pisa?",
      importance: "critical",
    },
  ];
  const defaultPlan: ResearchPlan = {
    objective: "Ricostruire la fondazione dell'Università di Pisa.",
    subQuestions,
    queries: [
      { query: "Università di Pisa anno di fondazione", purpose: "sub-question", subQuestionId: "sub-1", priority: 1 },
      { query: "storia ateneo pisano origini", purpose: "synonym", priority: 0.8 },
      { query: "bolla pontificia 1343", purpose: "primary-source", subQuestionId: "sub-1", priority: 0.6 },
    ],
    constraints: { lang: "it", freshness: "any" },
    ambiguities: [],
    source: "fallback",
  };
  const plan = options.plan ?? defaultPlan;

  let searchCall = 0;
  const calls = {
    searches: 0,
    fetches: 0,
    synthesized: 0,
    consultedUrls: [] as string[],
  };

  const docFor = (url: string): RawDocument => {
    const text = `L'Università di Pisa fu fondata nel 1343 secondo la fonte ${url}.`;
    return {
      urlFinal: url,
      canonicalUrl: url,
      status: 200,
      contentType: "text/html",
      textBytes: text.length,
      truncated: false,
      body: new TextEncoder().encode(`<html><body><p>${text}</p></body></html>`),
    };
  };

  const deps: EngineDeps = {
    sink: memory.sink,
    now: clock.now,
    async plan() {
      return { plan, usedFallback: false };
    },
    async search(query) {
      searchCall++;
      calls.searches++;
      if (options.search) return options.search(query.query, searchCall);
      if (options.searchDown) {
        return {
          ok: false,
          error: {
            code: "E_SEARCH_UNAVAILABLE",
            message: "Motore di ricerca non disponibile.",
            phase: "search",
            retryable: false,
          },
        };
      }
      return {
        ok: true,
        empty: false,
        items: [
          { url: "https://example.org/a", title: "Fonte A", snippet: "Fondata nel 1343.", engine: "google" },
          { url: "https://example.org/b", title: "Fonte B", snippet: "Bolla del 1343.", engine: "bing" },
          { url: "https://stats.gov/c", title: "Fonte C", snippet: "Dati ufficiali.", engine: "google" },
        ],
      };
    },
    async rank(candidates: SourceCandidate[]): Promise<RankedWithScore<SourceCandidate>[]> {
      return candidates.map((candidate, i) => ({
        candidate,
        score: { total: 1 - i * 0.01, components: {}, flags: [] },
        rank: i + 1,
      }));
    },
    async fetchPage(url) {
      calls.fetches++;
      calls.consultedUrls.push(url);
      if (options.failFetchFor?.(url) ?? false) {
        return {
          ok: false,
          error: {
            code: "E_FETCH_FAILED",
            message: "Pagina non raggiungibile.",
            phase: "fetch",
            retryable: false,
          },
        };
      }
      return { ok: true, doc: docFor(url) };
    },
    extract(doc, ctx) {
      const text = new TextDecoder().decode(doc.body).replace(/<[^>]+>/g, " ");
      return makePage(ctx.sourceId, text.replace(/\s+/g, " ").trim(), doc.urlFinal);
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
      calls.synthesized++;
      return {
        sections: [
          {
            heading: "Risposta",
            paragraphs: [
              {
                text: `Sintesi basata su ${input.evidences.length} evidenze.`,
                citations: input.evidences.map((_e, i) => i + 1),
              },
            ],
          },
        ],
        claims: input.evidences.map((e, i) => ({
          id: `claim-${i}`,
          text: e.passage.slice(0, 200),
          kind: "fact" as const,
          supportEvidenceIds: [e.id],
        })),
      };
    },
    async mapCitations({ evidences, sourceRecords }) {
      return evidences.map((e, i) => ({
        index: i + 1,
        evidenceId: e.id,
        sourceId: e.sourceId,
        url: e.url,
        title: sourceRecords.find((r) => r.sourceId === e.sourceId)?.title ?? "",
        passage: e.passage.slice(0, 200),
      }));
    },
  };

  return { deps, events: memory.events, calls };
}

function statusesOf(events: ProgressEvent[]): Array<Extract<ProgressEvent, { type: "status" }>> {
  return events.filter((e): e is Extract<ProgressEvent, { type: "status" }> => e.type === "status");
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

describe("runResearch — percorso felice", () => {
  it("completa con evidenze, citazioni solo da fonti analizzate e contatori coerenti", async () => {
    const { deps, events, calls } = buildDeps();
    const report = await runResearch(
      { question: "Quando fu fondata l'Università di Pisa?", options: { depth: 1, maxSources: 2 } },
      deps,
      new AbortController().signal,
    );

    expect(report.status).toBe("completed");
    expect(report.budgetUsed.depthUsed).toBe(1);
    expect(report.budgetUsed.queriesUsed).toBe(3);
    expect(report.budgetUsed.sourcesAnalyzed).toBe(2);
    expect(calls.fetches).toBe(report.budgetUsed.fetchAttempts);
    expect(calls.fetches).toBe(2);
    expect(report.sourcesConsulted.every((s) => s.status === "fetched")).toBe(true);
    expect(report.claims.length).toBeGreaterThan(0);
    expect(calls.synthesized).toBe(1);

    const analyzed = new Set(
      report.sourcesConsulted.filter((s) => s.status === "fetched").map((s) => s.canonicalUrl),
    );
    expect(report.citations.length).toBeGreaterThan(0);
    for (const c of report.citations) {
      expect(analyzed.has(c.url)).toBe(true); // mai citazioni da URL non analizzati
      expect(c.passage.length).toBeGreaterThan(0); // mai citazioni vuote
    }
    expect(report.sourcesUsed.length).toBeGreaterThan(0);
    expect(
      report.sourcesUsed.every((id) => report.sourcesConsulted.some((s) => s.sourceId === id)),
    ).toBe(true);

    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(statusesOf(events)[0].status).toBe("planning");
    expect(report.status).toBe("completed");
  });

  it("non rifetcha mai lo stesso URL nello stesso run (cache per-run)", async () => {
    const { deps, calls } = buildDeps();
    const report = await runResearch(
      { question: "Quando fu fondata l'Università di Pisa?", options: { depth: 2, maxSources: 2 } },
      deps,
      new AbortController().signal,
    );
    expect(new Set(calls.consultedUrls).size).toBe(calls.consultedUrls.length);
    expect(report.status).toBe("completed");
  });
});

describe("runResearch — loop e stop", () => {
  it("gap → secondo round → stop alla profondità massima (mai loop infinito)", async () => {
    let lastSearchCall = 0;
    const { deps } = buildDeps({
      search(query, call) {
        lastSearchCall = call;
        const isFollowUp = query.includes("official") || query.includes("primary source");
        if (isFollowUp) {
          return {
            ok: true,
            empty: false,
            items: [
              { url: "https://stats.gov/ufficiale", title: "Fonte ufficiale", snippet: "Dati ufficiali.", engine: "google" },
            ],
          };
        }
        return {
          ok: true,
          empty: false,
          items: [{ url: "https://example.org/solo", title: "Sola fonte", snippet: "Testo.", engine: "google" }],
        };
      },
    });
    const report = await runResearch(
      { question: "Quando fu fondata l'Università di Pisa?", options: { depth: 2, maxSources: 2 } },
      deps,
      new AbortController().signal,
    );
    expect(report.budgetUsed.depthUsed).toBe(2);
    expect(report.status).toBe("completed");
    expect(report.budgetUsed.sourcesAnalyzed).toBe(2);
    expect(lastSearchCall).toBeGreaterThan(4); // le query del round 2 sono state eseguite
  });

  it("budget query esaurito → stop pulito e report partial con flag", async () => {
    vi.stubEnv("RESEARCH_MAX_QUERIES", "3");
    resetEnvCache();
    resetLimitsCache();
    const { deps } = buildDeps();
    const report = await runResearch(
      { question: "Quando fu fondata l'Università di Pisa?", options: { depth: 2 } },
      deps,
      new AbortController().signal,
    );
    expect(report.budgetUsed.queriesUsed).toBe(3);
    expect(report.status).toBe("partial");
    expect(report.limitations.budgetExceeded).toBe(true);
  });

  it("timeout simulato → stop prima del round successivo con flag", async () => {
    vi.stubEnv("RESEARCH_TIMEOUT_MS", "6000");
    resetEnvCache();
    resetLimitsCache();
    let lastCall = 0;
    const clock = makeClock();
    const { deps } = buildDeps({
      clock,
      search(_query, call) {
        lastCall = call;
        if (call === 2) clock.current = new Date(clock.current.getTime() + 60_000);
        return {
          ok: true,
          empty: false,
          items: [{ url: "https://example.org/a", title: "A", snippet: "x", engine: "google" }],
        };
      },
    });
    const report = await runResearch(
      { question: "Quando fu fondata l'Università di Pisa?", options: { depth: 2, maxSources: 1 } },
      deps,
      new AbortController().signal,
    );
    expect(report.limitations.timeBudgetExceeded).toBe(true);
    expect(report.status).toBe("partial");
    expect(report.budgetUsed.queriesUsed).toBe(3); // solo il round 1 è partito
    expect(lastCall).toBe(3);
  });

  it("annullamento → report cancelled con stato e done", async () => {
    const { deps, events } = buildDeps();
    const controller = new AbortController();
    controller.abort();
    const report = await runResearch(
      { question: "Quando fu fondata l'Università di Pisa?" },
      deps,
      controller.signal,
    );
    expect(report.status).toBe("cancelled");
    expect(report.sections).toEqual([]);
    expect(report.budgetUsed.queriesUsed).toBe(0);
    const statuses = statusesOf(events);
    expect(statuses[statuses.length - 1].status).toBe("cancelled");
    const done = events.find((e): e is Extract<ProgressEvent, { type: "done" }> => e.type === "done");
    expect(done?.status).toBe("cancelled");
  });
});

describe("runResearch — modalità degradata", () => {
  it("SearXNG giù → nessun crash, report failed con spiegazione", async () => {
    const { deps, events } = buildDeps({ searchDown: true });
    const report = await runResearch(
      { question: "Quando fu fondata l'Università di Pisa?" },
      deps,
      new AbortController().signal,
    );
    expect(report.status).toBe("failed");
    expect(report.limitations.searchUnavailable).toBe(true);
    expect(report.limitations.llmUnavailable).toBe(false);
    expect(report.limitations.notes.some((n) => n.includes("non disponibile"))).toBe(true);
    expect(events.filter((e) => e.type === "error").length).toBeGreaterThan(0);
  });

  it("pagina che fallisce → la ricerca continua con le altre", async () => {
    const { deps } = buildDeps({ failFetchFor: (url) => url.includes("/b") });
    const report = await runResearch(
      { question: "Quando fu fondata l'Università di Pisa?", options: { depth: 1, maxSources: 3 } },
      deps,
      new AbortController().signal,
    );
    expect(report.budgetUsed.fetchFailed).toBeGreaterThan(0);
    expect(report.sourcesConsulted.some((s) => s.status === "failed")).toBe(true);
    expect(report.sourcesConsulted.some((s) => s.status === "fetched")).toBe(true);
    expect(report.budgetUsed.sourcesAnalyzed).toBeGreaterThan(0);
  });

  it("zero risultati → report onesto senza invenzioni", async () => {
    const { deps } = buildDeps({
      search: () => ({ ok: true, empty: true, items: [] }),
    });
    const report = await runResearch(
      { question: "Quando fu fondata l'Università di Pisa?" },
      deps,
      new AbortController().signal,
    );
    expect(report.status).toBe("failed");
    expect(report.limitations.missingSources).toBe(true);
    expect(report.citations).toEqual([]);
  });
});
