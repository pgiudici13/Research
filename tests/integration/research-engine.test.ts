// Integration test del motore (Step 17): porte di rete e LLM finte, ma
// estrazione HTML, evidenze, ranking, copertura e contraddizioni REALI
// (fixture HTML locali). Verifica budget, dedup intra-run, citazioni solo da
// fonti analizzate e coerenza dei contatori.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Conflict, ResearchPlan, SourceCandidate, SubQuestion } from "@/lib/types";
import { EvidenceStore } from "@/research/evidence/store";
import { createMemorySink } from "@/research/progress/sink";
import { extractPage } from "@/research/extract/html";
import { extractEvidence } from "@/research/evidence/extract";
import { rankCandidates } from "@/research/scoring/score";
import { assessCoverage } from "@/research/verification/coverage";
import { detectConflicts } from "@/research/contradictions/detect";
import { runResearch } from "@/research/engine/engine";
import type { EngineDeps, RankedWithScore } from "@/research/engine/deps";
import type { RawDocument } from "@/research/fetch/fetcher";
import type { SearchOutcome } from "@/lib/server/search/searxng";

const URL_A = "https://www.example-a.org/pisa-a.html";
const URL_B = "https://www.example-b.org/pisa-b.html";

function fixtureDoc(url: string): RawDocument {
  const name = url.includes("pisa-a") ? "pisa-a.html" : "pisa-b.html";
  const fixture = new URL(`../fixtures/html/${name}`, import.meta.url);
  const body = readFileSync(fixture);
  return {
    urlFinal: url,
    canonicalUrl: url,
    status: 200,
    contentType: "text/html",
    textBytes: body.length,
    truncated: false,
    body: new Uint8Array(body),
  };
}

function searchFor(query: string): SearchOutcome {
  const items = query.includes("bolla")
    ? [
        { url: URL_B, title: "Fonte B", snippet: "Documenti ufficiali sull'anno di fondazione.", engine: "google" },
      ]
    : [
        { url: URL_A, title: "Fonte A", snippet: "La fondazione dell'Università di Pisa.", engine: "google" },
        { url: URL_B, title: "Fonte B", snippet: "Registri sull'anno di fondazione.", engine: "bing" },
      ];
  return { ok: true, empty: false, items };
}

function buildRealDeps(): EngineDeps {
  const memory = createMemorySink();
  const subQuestions: SubQuestion[] = [
    {
      id: "sub-1",
      text: "In quale anno fu fondata l'Università di Pisa?",
      importance: "critical",
    },
  ];
  const plan: ResearchPlan = {
    objective: "Ricostruire l'anno di fondazione dell'Università di Pisa.",
    subQuestions,
    queries: [
      { query: "Università di Pisa anno di fondazione", purpose: "sub-question", subQuestionId: "sub-1", priority: 1 },
      { query: "storia ateneo pisano origini", purpose: "synonym", priority: 0.8 },
      { query: "bolla pontificia università pisa", purpose: "primary-source", subQuestionId: "sub-1", priority: 0.6 },
    ],
    constraints: { lang: "it", freshness: "any" },
    ambiguities: [],
    source: "fallback",
  };
  const clock = { value: new Date("2026-01-02T00:00:00Z"), now: () => new Date() };

  return {
    sink: memory.sink,
    now: () => new Date(),
    async plan() {
      return { plan, usedFallback: false };
    },
    async search(query) {
      clock.value = new Date();
      return searchFor(query.query);
    },
    async rank(candidates: SourceCandidate[]): Promise<RankedWithScore<SourceCandidate>[]> {
      return rankCandidates(candidates, { query: plan.objective, subQuestion: plan.subQuestions.map((s) => s.text).join(" ") }).map(
        (r) => ({ candidate: r.candidate, score: r.score, rank: r.rank }),
      );
    },
    async fetchPage(url) {
      if (url !== URL_A && url !== URL_B) {
        return {
          ok: false,
          error: { code: "E_FETCH_FAILED", message: "Risorsa sconosciuta.", phase: "fetch", retryable: false },
        };
      }
      return { ok: true, doc: fixtureDoc(url) };
    },
    extract(doc, ctx) {
      return extractPage(doc, { sourceId: ctx.sourceId, maxChars: 60_000 });
    },
    makeEvidence({ page, subQuestions: subs, maxPerPage }) {
      return extractEvidence(page, {
        subQuestions: [...subs],
        maxPerPage,
        retrievedAt: page.extractedAt,
        allowLowConfidenceFallback: true,
      });
    },
    evidenceStore(options) {
      return EvidenceStore.empty(options ?? {});
    },
    assessCoverage(planArg, store, opts) {
      return assessCoverage(planArg, store, opts);
    },
    detectConflicts(evidences): Conflict[] {
      return detectConflicts(evidences);
    },
    async synthesize(input) {
      return {
        sections: [
          {
            heading: "Risposta",
            paragraphs: [
              {
                text: `Sintesi su ${input.evidences.length} evidenze da fonti analizzate.`,
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
        passage: e.passage.slice(0, 400),
      }));
    },
  };
}

describe("integrazione: motore con moduli reali", () => {
  it("3 query pianificate → fetch entro il budget, citazioni solo da fonti analizzate", async () => {
    const deps = buildRealDeps();
    const report = await runResearch(
      { question: "In quale anno fu fondata l'Università di Pisa?", options: { depth: 1, maxSources: 2 } },
      deps,
      new AbortController().signal,
    );

    // budget e contatori coerenti
    expect(report.budgetUsed.queriesUsed).toBe(3);
    expect(report.budgetUsed.fetchAttempts).toBe(report.budgetUsed.sourcesAnalyzed);
    expect(report.budgetUsed.fetchAttempts).toBeLessThanOrEqual(2);
    expect(report.budgetUsed.fetchFailed).toBe(0);
    expect(report.budgetUsed.depthUsed).toBe(1);

    // nessun fetch duplicato: fonti consultate uniche
    const consulted = report.sourcesConsulted;
    const canonical = consulted.map((s) => s.canonicalUrl);
    expect(new Set(canonical).size).toBe(canonical.length);
    expect(report.sourcesConsulted.every((s) => s.status === "fetched")).toBe(true);

    // evidenze presenti e da fonti realmente analizzate
    expect(report.claims.length).toBeGreaterThan(0);
    const analyzedIds = new Set(report.sourcesConsulted.map((s) => s.sourceId));
    for (const claim of report.claims) {
      for (const evidenceId of claim.supportEvidenceIds) {
        const evidence = report.citations.find((c) => c.evidenceId === evidenceId);
        expect(evidence).toBeDefined();
      }
    }

    // citazioni: mai vuote, mai URL non analizzati, fonti tra quelle consultate
    expect(report.citations.length).toBeGreaterThan(0);
    const analyzedUrls = new Set(report.sourcesConsulted.filter((s) => s.status === "fetched").map((s) => s.urlFinal));
    for (const c of report.citations) {
      expect(c.passage.length).toBeGreaterThan(0);
      expect(analyzedUrls.has(c.url)).toBe(true);
      expect(analyzedIds.has(c.sourceId)).toBe(true);
    }
    expect(report.sourcesUsed.every((id) => analyzedIds.has(id))).toBe(true);

    // copertura sufficiente con 2 fonti indipendenti -> completed senza limiti
    expect(report.status).toBe("completed");
    expect(report.limitations.missingSources).toBe(false);
  });

  it("pagina irraggiungibile tra i risultati → contatore fetchFailed, il resto continua", async () => {
    const deps = buildRealDeps();
    const original = deps.fetchPage;
    deps.fetchPage = async (url) => {
      if (url === URL_B) {
        return {
          ok: false,
          error: { code: "E_FETCH_FAILED", message: "Timeout.", phase: "fetch", retryable: true },
        };
      }
      return original(url, {});
    };
    const report = await runResearch(
      { question: "In quale anno fu fondata l'Università di Pisa?", options: { depth: 1, maxSources: 2 } },
      deps,
      new AbortController().signal,
    );
    expect(report.budgetUsed.fetchFailed).toBeGreaterThan(0);
    expect(report.budgetUsed.fetchAttempts).toBeGreaterThanOrEqual(2);
    expect(report.budgetUsed.fetchAttempts).toBeLessThanOrEqual(2);
    expect(report.sourcesConsulted.some((s) => s.status === "failed")).toBe(true);
  });
});
