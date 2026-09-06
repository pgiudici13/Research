// Port (interfacce) del motore di ricerca (Step 17). Il motore dipende SOLO da
// queste porte: in produzione vengono assemblate dai moduli reali degli
// Step 7-19, nei test da fake deterministici. Nessuna rete, nessuno stato
// globale: ogni porta riceve il contesto della ricerca.
//
// Nota: la sintesi (Step 18) e le citazioni (Step 19) sono porte iniettate:
// il motore può essere verificato con fake; il completamento formale richiede
// gli Step 18-19 reali (vedi DoD dello Step 17 in STEP.md).

import type { Logger } from "@/lib/logger";
import type {
  BudgetUsage,
  Citation,
  Claim,
  Conflict,
  ErrorInfo,
  Evidence,
  ExtractedPage,
  ResearchLimitations,
  ResearchOptions,
  ResearchPlan,
  ReportSection,
  SourceCandidate,
  SourceRecord,
  SubQuestion,
} from "@/lib/types";
import type { RawDocument, FetchOutcome } from "@/research/fetch/fetcher";
import type { ExtractContext } from "@/research/extract/html";
import type { ScoreableSource, ScoringContext } from "@/research/scoring/score";
import type { SearchPort } from "@/lib/server/search/searxng";
import type { CoverageOptions, CoverageReport } from "@/research/verification/coverage";
import type { EvidenceStore, EvidenceStoreOptions } from "@/research/evidence/store";

export interface DepContext {
  researchId: string;
  signal?: AbortSignal;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  now(): Date;
}

export interface PlanOutcome {
  plan: ResearchPlan;
  usedFallback: boolean;
  llmError?: ErrorInfo;
}

export interface RankedWithScore<T extends ScoreableSource> {
  candidate: T;
  score: { total: number; components: Record<string, number>; flags: string[] };
  rank: number;
}

export interface EvidenceExtractionInput {
  page: ExtractedPage;
  subQuestions: readonly SubQuestion[];
  maxPerPage?: number;
  retrievedAt?: string;
  allowLowConfidenceFallback?: boolean;
}

/** Input strutturato per la sintesi (Step 18); solo evidenze già raccolte. */
export interface SynthesisInput {
  researchId: string;
  question: string;
  plan: ResearchPlan;
  evidences: readonly Evidence[];
  sourceRecords: readonly SourceRecord[];
  conflicts: readonly Conflict[];
  limitations: ResearchLimitations;
  budgetUsed: BudgetUsage;
  startedAt: string;
  now(): Date;
}

export interface SynthesisOutput {
  sections: ReportSection[];
  claims: Claim[];
}

/** Input per il mapping delle citazioni (Step 19): solo fonti analizzate. */
export interface CitationsInput {
  sections: readonly ReportSection[];
  claims: readonly Claim[];
  evidences: readonly Evidence[];
  sourceRecords: readonly SourceRecord[];
}

/** Insieme di porte consumato dal motore. */
export interface EngineDeps {
  plan(
    input: { question: string; options?: ResearchOptions },
    ctx: DepContext,
  ): Promise<PlanOutcome>;
  search: SearchPort;
  rank(
    candidates: readonly SourceCandidate[],
    scoreCtx: ScoringContext,
  ): Promise<RankedWithScore<SourceCandidate>[]>;
  fetchPage(url: string, ctx: { signal?: AbortSignal; logger?: Logger }): Promise<FetchOutcome>;
  extract(doc: RawDocument, ctx: ExtractContext): ExtractedPage;
  makeEvidence(input: EvidenceExtractionInput): Evidence[];
  evidenceStore(options?: EvidenceStoreOptions): EvidenceStore;
  assessCoverage(
    plan: ResearchPlan,
    store: EvidenceStore,
    options?: CoverageOptions,
  ): CoverageReport;
  detectConflicts(evidences: readonly Evidence[]): Conflict[];
  synthesize(input: SynthesisInput): Promise<SynthesisOutput>;
  mapCitations(input: CitationsInput): Promise<Citation[]>;
  sink: import("@/research/progress/sink").ProgressSink;
  logger?: Logger;
  now(): Date;
}
