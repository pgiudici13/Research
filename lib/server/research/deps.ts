// server-only — assemblaggio delle port REALI del motore (Step 21). L'API
// (app/api/research/route.ts) costruisce qui le EngineDeps con i moduli degli
// Step 7-19: planner (LLM+fallback), SearXNG, ranking, fetcher SSRF-guarded,
// estrazione, evidenze, coverage, contraddizioni, sintesi e citazioni.
// Nessun segreto: la chiave NVIDIA vive solo in lib/server/llm (mai qui).

import type { Logger } from "@/lib/logger";
import type { DepContext, EngineDeps, RankedWithScore } from "@/research/engine/deps";
import type { ProgressSink } from "@/research/progress/sink";
import type { SourceCandidate } from "@/lib/types";
import { planResearch } from "@/research/planning/planner";
import { searchSearxng } from "@/lib/server/search/searxng";
import { searchDuckDuckGo } from "@/lib/server/search/duckduckgo";
import { rankCandidates } from "@/research/scoring/score";
import { fetchPage } from "@/research/fetch/fetcher";
import { extractPage } from "@/research/extract/html";
import { extractEvidence } from "@/research/evidence/extract";
import { EvidenceStore } from "@/research/evidence/store";
import { assessCoverage } from "@/research/verification/coverage";
import { detectConflicts } from "@/research/contradictions/detect";
import { synthesizeReport } from "@/research/synthesis/synthesize";
import { mapCitations as mapCitationsReal } from "@/research/citations/map";

/** Costruisce le EngineDeps reali per una richiesta di ricerca. */
export function buildResearchDeps(
  sink: ProgressSink,
  logger?: Logger,
): EngineDeps {
  return {
    async plan(input, ctx: DepContext) {
      return planResearch({
        question: input.question,
        options: input.options,
        signal: ctx.signal,
        logger: ctx.logger ?? logger,
        now: ctx.now(),
      });
    },
    search: async (query, ctx) => {
      const primary = await searchSearxng(query, {
        signal: ctx.signal,
        logger: ctx.logger ?? logger,
      });
      if (primary.ok && !primary.empty) return primary;
      (ctx.logger ?? logger)?.warn("search.duckduckgo_fallback", { researchId: ctx.researchId });
      const fallback = await searchDuckDuckGo(query, ctx);
      return fallback.ok && !fallback.empty ? fallback : primary;
    },
    async rank(candidates: readonly SourceCandidate[], scoreCtx) {
      const ranked = rankCandidates([...candidates], scoreCtx);
      return ranked.map(
        (r): RankedWithScore<SourceCandidate> => ({
          candidate: r.candidate,
          score: r.score,
          rank: r.rank,
        }),
      );
    },
    fetchPage: (url, ctx) => fetchPage(url, ctx),
    extract: (doc, ctx) => extractPage(doc, ctx),
    makeEvidence: (input) =>
      extractEvidence(input.page, {
        subQuestions: [...input.subQuestions],
        maxPerPage: input.maxPerPage,
        retrievedAt: input.retrievedAt,
        allowLowConfidenceFallback: input.allowLowConfidenceFallback,
      }),
    evidenceStore: (options) => EvidenceStore.empty(options ?? {}),
    assessCoverage: (plan, store, options) => assessCoverage(plan, store, options),
    detectConflicts: (evidences) => detectConflicts(evidences),
    async synthesize(input) {
      return synthesizeReport({
        researchId: input.researchId,
        question: input.question,
        plan: input.plan,
        evidences: input.evidences,
        sourceRecords: input.sourceRecords,
        conflicts: input.conflicts,
        limitations: input.limitations,
        logger: logger,
      });
    },
    async mapCitations(input) {
      return mapCitationsReal({
        sections: input.sections,
        evidences: input.evidences,
        sourceRecords: input.sourceRecords,
      });
    },
    sink,
    logger,
    now: () => new Date(),
  };
}
