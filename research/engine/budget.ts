// Budget di una singola ricerca (Step 17). Calcolato all'avvio da limits +
// opzioni utente, SEMPRE clampato ai massimi di ambiente. Contatori usati dal
// motore e riportati in BudgetUsage. Include la cache per-run degli URL già
// tentati (mai rifetch dello stesso canonicalUrl nella stessa ricerca).

import { getLimits, type Limits } from "@/lib/config/limits";
import type { BudgetUsage, ResearchOptions } from "@/lib/types";

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface RunBudgetOptions {
  limits?: Limits;
  options?: ResearchOptions;
  /** Timestamp di inizio (ms) per il calcolo del tempo trascorso. */
  startedAt: number;
}

/** LLM call ammesse per ricerca (plan + verifiche + sintesi + margine). */
export function maxLlmCallsFor(maxDepth: number): number {
  return maxDepth * 2 + 2;
}

export class RunBudget {
  private readonly startedAt: number;
  private readonly attemptedUrls = new Set<string>();

  readonly maxQueries: number;
  readonly maxSources: number;
  readonly maxDepth: number;
  readonly researchTimeoutMs: number;
  readonly endMarginMs: number;
  readonly maxFetchPerRound: number;

  /** Deep dei round effettivamente eseguiti (aggiornato dal motore). */
  depthUsed = 0;

  queriesUsed = 0;
  sourcesAnalyzed = 0;
  llmCalls = 0;
  fetchAttempts = 0;
  fetchFailed = 0;
  searchErrors = 0;

  constructor(options: RunBudgetOptions) {
    const limits = options.limits ?? getLimits();
    this.startedAt = options.startedAt;
    this.maxQueries = limits.maxQueries;
    this.researchTimeoutMs = limits.researchTimeoutMs;
    this.endMarginMs = limits.researchEndMarginMs;
    this.maxFetchPerRound = limits.maxFetchPerRound;

    const requestedDepth = options.options?.depth ?? limits.maxDepth;
    this.maxDepth = clampInt(requestedDepth, 1, limits.maxDepth);

    const requestedSources = options.options?.maxSources ?? limits.maxSources;
    this.maxSources = clampInt(requestedSources, 1, limits.maxSources);
  }

  remainingQueries(): number {
    return Math.max(0, this.maxQueries - this.queriesUsed);
  }

  remainingSources(): number {
    return Math.max(0, this.maxSources - this.sourcesAnalyzed);
  }

  remainingLlmCalls(): number {
    return Math.max(0, maxLlmCallsFor(this.maxDepth) - this.llmCalls);
  }

  /** Consuma una query se c'è budget; true se consumata. */
  consumeQuery(): boolean {
    if (this.queriesUsed >= this.maxQueries) return false;
    this.queriesUsed++;
    return true;
  }

  /** Consuma una fonte (pagina analizzata) se c'è budget. */
  consumeSource(): boolean {
    if (this.sourcesAnalyzed >= this.maxSources) return false;
    this.sourcesAnalyzed++;
    return true;
  }

  /** Consuma una chiamata LLM se c'è budget. */
  consumeLlm(): boolean {
    if (this.llmCalls >= maxLlmCallsFor(this.maxDepth)) return false;
    this.llmCalls++;
    return true;
  }

  markFetchAttempt(): void {
    this.fetchAttempts++;
  }

  markFetchFailed(): void {
    this.fetchFailed++;
  }

  markSearchError(): void {
    this.searchErrors++;
  }

  /** Registra un canonicalUrl come già tentato nella ricerca corrente. */
  markAttempted(canonicalUrl: string): void {
    this.attemptedUrls.add(canonicalUrl);
  }

  hasAttempted(canonicalUrl: string): boolean {
    return this.attemptedUrls.has(canonicalUrl);
  }

  /** Millisecondi trascorsi dall'inizio. */
  elapsed(now: Date): number {
    return Math.max(0, now.getTime() - this.startedAt);
  }

  /** True se c'è ancora tempo utile prima del margine di sicurezza. */
  canContinue(now: Date): boolean {
    return this.elapsed(now) < this.researchTimeoutMs - this.endMarginMs;
  }

  toBudgetUsage(): BudgetUsage {
    return {
      queriesUsed: this.queriesUsed,
      sourcesAnalyzed: this.sourcesAnalyzed,
      depthUsed: this.depthUsed,
      llmCalls: this.llmCalls,
      fetchAttempts: this.fetchAttempts,
      fetchFailed: this.fetchFailed,
    };
  }
}
