// Failure-modes integration test (Step 26): esegue ogni riga della matrice in
// `docs/error-matrix.md` con fake deterministici (nessuna rete reale) sul
// motore e sulle route API, e asserisce: stato finale, flag di `limitations`,
// codici errore, continuità della ricerca dove prevista e — in OGNI scenario —
// assenza di stack trace/segreti/messaggi grezzi negli output (eventi NDJSON,
// risposte HTTP, log catturati).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { resetLimitsCache } from "@/lib/config/limits";
import { toErrorInfo } from "@/lib/errors";
import type {
  Conflict,
  Evidence,
  ExtractedPage,
  ResearchPlan,
  SourceCandidate,
  SubQuestion,
} from "@/lib/types";
import type { ProgressEvent } from "@/lib/types";
import type { ErrorInfo } from "@/lib/types";
import type { Logger } from "@/lib/logger";
import type { SearchOutcome } from "@/lib/server/search/searxng";
import { EvidenceStore } from "@/research/evidence/store";
import { createMemorySink } from "@/research/progress/sink";
import { assessCoverage } from "@/research/verification/coverage";
import { detectConflicts } from "@/research/contradictions/detect";
import { runResearch } from "@/research/engine/engine";
import type { EngineDeps, RankedWithScore } from "@/research/engine/deps";
import type { RawDocument } from "@/research/fetch/fetcher";
import { POST as researchPost, researchRateLimiter } from "@/app/api/research/route";

// ---------------------------------------------------------------------------
// Harness con fake deterministici (stesso stile dei test unit del motore)
// ---------------------------------------------------------------------------

interface FakeClock {
  current: Date;
  now(): Date;
}

function makeClock(start = new Date("2026-01-02T00:00:00Z")): FakeClock {
  const clock: FakeClock = { current: start, now: () => new Date(clock.current.getTime()) };
  return clock;
}

function fakeLogger(): { logger: Logger; lines: Array<{ event: string; fields?: unknown }> } {
  const lines: Array<{ event: string; fields?: unknown }> = [];
  const write = (event: string, fields?: unknown): void => {
    lines.push({ event, fields });
  };
  const logger: Logger = {
    scope: "engine-test",
    debug: (event, fields) => write(event, fields),
    info: (event, fields) => write(event, fields),
    warn: (event, fields) => write(event, fields),
    error: (event, fields) => write(event, fields),
    child: () => logger,
  };
  return { logger, lines };
}

type FetchFailureCode = "E_FETCH_FAILED" | "E_FETCH_TOO_LARGE" | "E_FETCH_UNSUPPORTED";

const DEFAULT_TEXT =
  "L'Università di Pisa fu fondata nel 1343 secondo le cronache dell'epoca.";

interface HarnessOptions {
  clock?: FakeClock;
  /** Ogni query risponde ok:false con E_SEARCH_UNAVAILABLE. */
  searchDown?: boolean;
  /** Ogni query risponde ok:false con E_SEARCH_TIMEOUT. */
  searchTimeout?: boolean;
  /** Ogni query risponde vuota. */
  searchEmpty?: boolean;
  /** Errore di fetch per un URL (o null per continuare). */
  failFetch?: (url: string) => FetchFailureCode | null;
  /** Pagina estratta vuota per quell'URL → SourceRecord unsupported. */
  emptyExtractFor?: (url: string) => boolean;
  /** Usa il detectConflicts reale sulle evidenze raccolte. */
  conflictsReal?: boolean;
  /** Il planner torna usatoFallback (LLM non configurato). */
  planFallback?: boolean;
  /** La sintesi torna usatoFallback con il codice indicato. */
  synthFallbackCode?: ErrorInfo["code"];
  /** Il planner lancia un errore imprevisto (non AppError). */
  planThrows?: boolean;
  /** Testo pagina per URL (default DEFAULT_TEXT). */
  pageTextFor?: (url: string) => string;
  /** Hook chiamato a ogni search (numero di chiamata 1-based) — per i clock. */
  onSearch?: (call: number) => void;
}

interface Harness {
  deps: EngineDeps;
  events: ProgressEvent[];
  logs: Array<{ event: string; fields?: unknown }>;
  run(input?: { depth?: number; maxSources?: number }): Promise<import("@/lib/types").ResearchReport>;
}

function buildHarness(options: HarnessOptions = {}): Harness {
  const clock = options.clock ?? makeClock();
  const memory = createMemorySink();
  const { logger, lines } = fakeLogger();
  const subQuestions: SubQuestion[] = [
    {
      id: "sub-1",
      text: "In quale anno fu fondata l'Università di Pisa?",
      importance: "critical",
    },
  ];
  const plan: ResearchPlan = {
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

  let searchCall = 0;
  const deps: EngineDeps = {
    sink: memory.sink,
    logger,
    now: clock.now,
    async plan() {
      if (options.planThrows) throw new Error("marcatore-errore-inatteso boom");
      if (options.planFallback) {
        return {
          plan,
          usedFallback: true,
          llmError: {
            code: "E_LLM_UNAVAILABLE",
            message: "Servizio LLM non disponibile o non configurato.",
            phase: "llm",
            retryable: false,
          },
        };
      }
      return { plan, usedFallback: false };
    },
    async search(): Promise<SearchOutcome> {
      searchCall++;
      options.onSearch?.(searchCall);
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
      if (options.searchTimeout) {
        return {
          ok: false,
          error: {
            code: "E_SEARCH_TIMEOUT",
            message: "Timeout del servizio di ricerca.",
            phase: "search",
            retryable: true,
          },
        };
      }
      if (options.searchEmpty) {
        return { ok: true, empty: true, items: [] };
      }
      return {
        ok: true,
        empty: false,
        items: [
          { url: "https://example.org/a", title: "Fonte A", snippet: "Cronache del 1343.", engine: "google" },
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
      const failure = options.failFetch?.(url) ?? null;
      if (failure !== null) {
        const messages: Record<FetchFailureCode, string> = {
          E_FETCH_FAILED: "Pagina non raggiungibile.",
          E_FETCH_TOO_LARGE: "Pagina troppo grande.",
          E_FETCH_UNSUPPORTED: "Tipo di contenuto non supportato.",
        };
        return {
          ok: false,
          error: {
            code: failure,
            message: messages[failure],
            phase: "fetch",
            retryable: failure === "E_FETCH_FAILED",
          },
        };
      }
      const text = options.pageTextFor?.(url) ?? DEFAULT_TEXT;
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
      const text = options.emptyExtractFor?.(doc.urlFinal)
        ? ""
        : new TextDecoder().decode(doc.body).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return {
        sourceId: ctx.sourceId,
        url: doc.urlFinal,
        domain: "example.org",
        title: "Pagina di prova",
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
    evidenceStore(storeOptions) {
      return EvidenceStore.empty(storeOptions ?? {});
    },
    assessCoverage(planArg, store, opts) {
      return assessCoverage(planArg, store, opts);
    },
    detectConflicts(evidences): Conflict[] {
      if (options.conflictsReal) return detectConflicts(evidences);
      return [];
    },
    async synthesize(input) {
      if (options.synthFallbackCode !== undefined) {
        return {
          sections: [
            {
              heading: "Risposta",
              paragraphs: [{ text: `Sintesi meccanica su ${input.evidences.length} evidenze.`, citations: [] }],
            },
          ],
          claims: [],
          usedFallback: true,
          llmError: {
            code: options.synthFallbackCode,
            message: "Servizio LLM non disponibile.",
            phase: "llm",
            retryable: false,
          },
        };
      }
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

  return {
    deps,
    events: memory.events,
    logs: lines,
    run: async (input: { depth?: 1 | 2 | 3; maxSources?: number } = {}) =>
      runResearch(
        { question: "Quando fu fondata l'Università di Pisa?", options: { depth: input.depth ?? 1, maxSources: input.maxSources } },
        deps,
        new AbortController().signal,
      ),
  };
}

const FORBIDDEN = ["marcatore-errore-inatteso", "sk-test-", "sk-live-", "\n    at ", "at "];

function expectClean(text: string, context: string): void {
  for (const needle of FORBIDDEN) {
    expect(text, `${context}: non deve contenere ${needle}`).not.toContain(needle);
  }
}

function statusesOf(events: ProgressEvent[]): string[] {
  return events
    .filter((e): e is Extract<ProgressEvent, { type: "status" }> => e.type === "status")
    .map((e) => e.status);
}

function errorsOf(events: ProgressEvent[]): ErrorInfo[] {
  const codes: ErrorInfo[] = [];
  for (const e of events) {
    if (e.type === "error") codes.push(e.error as ErrorInfo);
  }
  return codes;
}

beforeEach(() => {
  vi.stubEnv("NVIDIA_API_KEY", "");
  vi.stubEnv("SEARXNG_BASE_URL", "");
  resetEnvCache();
  resetLimitsCache();
  researchRateLimiter.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetLimitsCache();
});

describe("matrice errori — LLM (fallback di fase, mai crash)", () => {
  it("NVIDIA non configurata → llmUnavailable + stato partial + done coerente", async () => {
    const h = buildHarness({ planFallback: true, synthFallbackCode: "E_LLM_UNAVAILABLE" });
    const report = await h.run();
    expect(report.status).toBe("partial");
    expect(report.limitations.llmUnavailable).toBe(true);
    expect(report.sections.length).toBeGreaterThan(0); // fallback deterministico
    expect(
      report.limitations.notes.some((n) => n.toLowerCase().includes("senza llm")),
    ).toBe(true);
    expect(statusesOf(h.events).at(-1)).toBe("partial");
    const done = h.events.find((e): e is Extract<ProgressEvent, { type: "done" }> => e.type === "done");
    expect(done?.status).toBe("partial");
    expectClean(JSON.stringify(h.events), "eventi");
    expectClean(JSON.stringify(h.logs), "log");
  });

  it("NVIDIA timeout → sintesi fallback con codice E_LLM_TIMEOUT", async () => {
    const h = buildHarness({ synthFallbackCode: "E_LLM_TIMEOUT" });
    const report = await h.run();
    expect(report.status).toBe("partial");
    expect(report.limitations.llmUnavailable).toBe(true);
    const limitationCodes = h.events
      .filter((e): e is Extract<ProgressEvent, { type: "limitation" }> => e.type === "limitation")
      .map((e) => e.code);
    expect(limitationCodes).toContain("E_LLM_TIMEOUT");
    expectClean(JSON.stringify(h.events), "eventi");
  });

  it("risposta LLM JSON invalida → fallback deterministico con nota esplicita", async () => {
    const h = buildHarness({ synthFallbackCode: "E_LLM_INVALID_RESPONSE" });
    const report = await h.run();
    expect(report.status).toBe("partial");
    expect(report.limitations.llmUnavailable).toBe(true);
    expect(
      report.limitations.notes.some((n) => n.toLowerCase().includes("output del modello non valido")),
    ).toBe(true);
  });
});

describe("matrice errori — ricerca", () => {
  it("SearXNG giù (tunnel/Pi) → failed con searchUnavailable e error event", async () => {
    const h = buildHarness({ searchDown: true });
    const report = await h.run();
    expect(report.status).toBe("failed");
    expect(report.limitations.searchUnavailable).toBe(true);
    expect(errorsOf(h.events).some((e) => e.code === "E_SEARCH_UNAVAILABLE")).toBe(true);
    const done = h.events.find((e): e is Extract<ProgressEvent, { type: "done" }> => e.type === "done");
    expect(done?.status).toBe("failed");
    expectClean(JSON.stringify(h.events), "eventi");
    expectClean(JSON.stringify(h.logs), "log");
  });

  it("SearXNG timeout → nessuna fonte: failed, code E_SEARCH_TIMEOUT negli eventi", async () => {
    const h = buildHarness({ searchTimeout: true });
    const report = await h.run();
    expect(report.status).toBe("failed");
    expect(report.limitations.searchUnavailable).toBe(true);
    expect(errorsOf(h.events).some((e) => e.code === "E_SEARCH_TIMEOUT")).toBe(true);
    expectClean(JSON.stringify(h.events), "eventi");
  });

  it("ricerca vuota → failed onesto con missingSources e zero citazioni", async () => {
    const h = buildHarness({ searchEmpty: true });
    const report = await h.run();
    expect(report.status).toBe("failed");
    expect(report.limitations.missingSources).toBe(true);
    expect(report.citations).toEqual([]);
    expect(report.sections).toEqual([]);
    expectClean(JSON.stringify(h.events), "eventi");
  });
});

describe("matrice errori — fetch ed estrazione", () => {
  it("pagina 404/irraggiungibile → si continua, SourceRecord failed con E_FETCH_FAILED", async () => {
    const h = buildHarness({
      failFetch: (url) => (url.includes("/b") ? "E_FETCH_FAILED" : null),
    });
    const report = await h.run();
    expect(report.budgetUsed.fetchFailed).toBeGreaterThan(0);
    const failed = report.sourcesConsulted.find((s) => s.status === "failed");
    expect(failed?.failure?.code).toBe("E_FETCH_FAILED");
    expect(report.sourcesConsulted.some((s) => s.status === "fetched")).toBe(true);
    expect(report.budgetUsed.sourcesAnalyzed).toBeGreaterThan(0);
    expect(["completed", "partial"]).toContain(report.status);
    expectClean(JSON.stringify(h.events), "eventi");
  });

  it("pagina troppo grande → E_FETCH_TOO_LARGE e si continua", async () => {
    const h = buildHarness({
      failFetch: (url) => (url.includes("/b") ? "E_FETCH_TOO_LARGE" : null),
    });
    const report = await h.run();
    const failed = report.sourcesConsulted.find((s) => s.status === "failed");
    expect(failed?.failure?.code).toBe("E_FETCH_TOO_LARGE");
    expect(report.sourcesConsulted.some((s) => s.status === "fetched")).toBe(true);
    expect(["completed", "partial"]).toContain(report.status);
  });

  it("contenuto non supportato → E_FETCH_UNSUPPORTED e si continua", async () => {
    const h = buildHarness({
      failFetch: (url) => (url.includes("/b") ? "E_FETCH_UNSUPPORTED" : null),
    });
    const report = await h.run();
    expect(report.sourcesConsulted.some((s) => s.failure?.code === "E_FETCH_UNSUPPORTED")).toBe(true);
    expect(report.sourcesConsulted.some((s) => s.status === "fetched")).toBe(true);
    expect(["completed", "partial"]).toContain(report.status);
  });

  it("pagina vuota/illeggibile → SourceRecord unsupported e si continua", async () => {
    const h = buildHarness({ emptyExtractFor: (url) => url.includes("/c") });
    const report = await h.run();
    expect(report.sourcesConsulted.some((s) => s.status === "unsupported")).toBe(true);
    expect(report.sourcesConsulted.some((s) => s.status === "fetched")).toBe(true);
    expect(["completed", "partial"]).toContain(report.status);
    expectClean(JSON.stringify(h.events), "eventi");
  });
});

describe("matrice errori — contenuto e terminazione", () => {
  it("conflitti tra fonti → conservati nel report con entrambe le posizioni", async () => {
    const h = buildHarness({
      conflictsReal: true,
      pageTextFor: (url) =>
        url.includes("/a")
          ? "Secondo l'archivio ufficiale l'ateneo pisano fu fondato nell'anno 1343."
          : url.includes("/b")
            ? "Secondo l'archivio ufficiale l'ateneo pisano fu fondato nell'anno 1344."
            : DEFAULT_TEXT,
    });
    const report = await h.run();
    expect(report.conflicts.length).toBeGreaterThan(0);
    const conflict = report.conflicts[0]!;
    expect(conflict.statements.length).toBe(2); // entrambe le posizioni, mai risolte
    expect(conflict.statements.map((s) => s.position).join(" ")).toMatch(/1343/);
    expect(conflict.statements.map((s) => s.position).join(" ")).toMatch(/1344/);
    expect(report.sections.length).toBeGreaterThan(0);
    expectClean(JSON.stringify(h.events), "eventi");
  });

  it("timeout globale → stop pulito: partial con timeBudgetExceeded", async () => {
    vi.stubEnv("RESEARCH_TIMEOUT_MS", "6000");
    resetEnvCache();
    resetLimitsCache();
    const clock = makeClock();
    const h = buildHarness({
      clock,
      onSearch: (call) => {
        if (call === 2) clock.current = new Date(clock.current.getTime() + 60_000);
      },
    });
    const report = await h.run({ depth: 2, maxSources: 1 });
    expect(report.status).toBe("partial");
    expect(report.limitations.timeBudgetExceeded).toBe(true);
    expectClean(JSON.stringify(h.events), "eventi");
  });

  it("utente annulla → cancelled con stato e done coerenti", async () => {
    const h = buildHarness();
    const controller = new AbortController();
    controller.abort();
    const report = await runResearch(
      { question: "Quando fu fondata l'Università di Pisa?" },
      h.deps,
      controller.signal,
    );
    expect(report.status).toBe("cancelled");
    expect(statusesOf(h.events).at(-1)).toBe("cancelled");
    const done = h.events.find((e): e is Extract<ProgressEvent, { type: "done" }> => e.type === "done");
    expect(done?.status).toBe("cancelled");
    expectClean(JSON.stringify(h.events), "eventi");
  });

  it("errore imprevisto in una port → report failed, mai crash né leak", async () => {
    const h = buildHarness({ planThrows: true });
    const report = await h.run();
    expect(report.status).toBe("failed");
    expect(report.limitations.llmUnavailable).toBe(true);
    // l'errore non trapela: il motore risponde con esito di catalogo
    expectClean(JSON.stringify(h.events), "eventi");
    expectClean(JSON.stringify(h.logs), "log");
    // e toErrorInfo normalizza qualsiasi errore a E_INTERNAL di catalogo
    const info = toErrorInfo(new Error("marcatore-errore-inatteso boom at file:line"));
    expect(info.code).toBe("E_INTERNAL");
    expect(info.message).toBe("Errore interno.");
    expectClean(JSON.stringify(info), "ErrorInfo");
  });
});

describe("matrice errori — route API", () => {
  function apiRequest(body: unknown, ip: string): Request {
    return new Request("http://localhost/api/research", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });
  }

  const QUESTION = "In quale anno fu fondata l'Università di Pisa?";

  it("input non valido → 400 E_VALIDATION, body pulito (mai stack trace)", async () => {
    const response = await researchPost(apiRequest({ question: "corta" }, "203.0.113.30"));
    expect(response.status).toBe(400);
    const body = await response.text();
    const parsed = JSON.parse(body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("E_VALIDATION");
    expectClean(body, "body 400");
  });

  it("rate limit → 429 E_RATE_LIMIT con Retry-After, body pulito", async () => {
    for (let i = 0; i < 5; i++) {
      const ok = await researchPost(apiRequest({ question: QUESTION }, "203.0.113.40"));
      expect(ok.status).toBe(200);
      await ok.text();
    }
    const denied = await researchPost(apiRequest({ question: QUESTION }, "203.0.113.40"));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBeTruthy();
    const body = await denied.text();
    const parsed = JSON.parse(body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("E_RATE_LIMIT");
    expectClean(body, "body 429");
  });
});
