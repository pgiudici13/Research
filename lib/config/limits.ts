// Budget e limiti della pipeline (tabella C.2 di STEP.md).
// I valori RESEARCH_* arrivano da env (lib/config/env.ts); i restanti sono
// costanti interne documentate. Unica fonte di verita' per il motore di ricerca.

import type { Env } from "./env";
import { getEnv } from "./env";

export interface Limits {
  // Budget principali (override via env RESEARCH_*)
  maxQueries: number;
  maxSources: number;
  maxDepth: number;
  researchTimeoutMs: number;
  maxFetchBytes: number;

  // Concorrenza (il Pi 3B e Vercel hanno risorse limitate)
  searchConcurrency: number;
  fetchConcurrency: number;
  llmConcurrency: number;

  // Timeout di servizio per singola chiamata (ms)
  llmTimeoutMs: number;
  searchTimeoutMs: number;
  fetchTimeoutMs: number;
  researchEndMarginMs: number;

  // Retry: tentativi TOTALI (1 iniziale + retry)
  llmMaxAttempts: number;
  searchMaxAttempts: number;
  fetchMaxAttempts: number;
  maxRedirects: number;

  // Dimensioni contenuti
  pageTextMaxChars: number;
  passageMaxChars: number;
  passageOverlapChars: number;
  maxEvidencesPerPage: number;
  maxEvidencesTotal: number;
  maxSearchResultsPerQuery: number;
  maxFetchPerRound: number;

  // Token LLM
  plannerMaxTokens: number;
  synthesisMaxTokens: number;

  // Input utente
  questionMinChars: number;
  questionMaxChars: number;

  // Rate limit API (helper puro usato dallo Step 21)
  rateLimitPerHourPerIp: number;
  rateLimitConcurrentPerIp: number;
}

/** Costanti interne (non sovrascrivibili via env). */
const INTERNAL_LIMITS = {
  searchConcurrency: 2,
  fetchConcurrency: 4,
  llmConcurrency: 1, // LLM seriale
  llmTimeoutMs: 25_000,
  searchTimeoutMs: 15_000,
  fetchTimeoutMs: 15_000,
  researchEndMarginMs: 2_000,
  llmMaxAttempts: 3, // 1 + 2 retry (C.2)
  searchMaxAttempts: 3, // 1 + 2 retry (C.2)
  fetchMaxAttempts: 2, // 1 + 1 retry (C.2)
  maxRedirects: 5,
  pageTextMaxChars: 60_000,
  passageMaxChars: 1_200,
  passageOverlapChars: 80,
  maxEvidencesPerPage: 8,
  maxEvidencesTotal: 40,
  maxSearchResultsPerQuery: 10,
  maxFetchPerRound: 6,
  plannerMaxTokens: 2_000,
  synthesisMaxTokens: 4_000,
  questionMinChars: 10,
  questionMaxChars: 1_000,
  rateLimitPerHourPerIp: 5,
  rateLimitConcurrentPerIp: 2,
} as const;

/** Calcola i limiti effettivi da un ambiente validato. Funzione pura. */
export function computeLimits(env: Pick<
  Env,
  | "researchMaxQueries"
  | "researchMaxSources"
  | "researchMaxDepth"
  | "researchTimeoutMs"
  | "researchMaxFetchBytes"
>): Limits {
  return {
    maxQueries: env.researchMaxQueries,
    maxSources: env.researchMaxSources,
    maxDepth: env.researchMaxDepth,
    researchTimeoutMs: env.researchTimeoutMs,
    maxFetchBytes: env.researchMaxFetchBytes,
    ...INTERNAL_LIMITS,
  };
}

let cachedLimits: Limits | undefined;

/** Limiti dell'ambiente corrente, calcolati una sola volta. */
export function getLimits(): Limits {
  if (cachedLimits === undefined) {
    cachedLimits = computeLimits(getEnv());
  }
  return cachedLimits;
}

/** Solo per test: azzera la cache. */
export function resetLimitsCache(): void {
  cachedLimits = undefined;
}

/** True se il contatore `used` non ha ancora raggiunto il limite. */
export function checkBudget(used: number, limit: number): boolean {
  return used < limit;
}
