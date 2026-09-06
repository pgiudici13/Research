// Verifica della copertura e gap detection (funzioni pure, deterministiche).
// REGOLE:
// - Il modulo NON corregge fonti e NON elimina nulla: produce copertura, gap e
//   raccomandazioni; le decisioni di budget restano nel motore (Step 17).
// - Le sotto-domande con importance "critical" sono trattate come claim chiave
//   e richiedono fonti indipendenti multiple.
// - Le query di follow-up sono generate SENZA LLM (template deterministici);
//   niente invenzioni. L'anno corrente arriva dal clock (iniettabile).
// - Le condizioni di stop sono esplicite: mai loop infinito.

import type { Evidence, EvidenceConfidence, ResearchPlan } from "@/lib/types";
import type { EvidenceStore } from "@/research/evidence/store";
import { clampText, extractKeywords } from "@/research/planning/fallback";

/** Soglie documentate (non magiche) per la valutazione della copertura. */
export const VERIFICATION_THRESHOLDS = {
  /** Rilevanza minima di una singola evidenza per coprire una sotto-domanda. */
  strongRelevanceMin: 0.25,
  /** Evidenze low-confidence da fonti distinte richieste per la copertura. */
  lowConfidenceDistinctForCoverage: 2,
  /** Fonti indipendenti (sourceId diversi) minime per un claim chiave. */
  minSourcesForKeyClaim: 2,
} as const;

export interface SubCoverage {
  subQuestionId: string;
  /** True se la sotto-domanda è un claim chiave (richiede fonti multiple). */
  keyClaim: boolean;
  evidenceCount: number;
  distinctSources: number;
  maxRelevance: number;
  /** Confidenza più DEBOLE tra le evidenze (o null se nessuna). */
  minConfidence: EvidenceConfidence | null;
  covered: boolean;
}

export type GapType =
  | "uncovered-subquestion"
  | "single-source"
  | "low-authority"
  | "conflicting"
  | "freshness"
  | "no-evidence";

export interface Gap {
  type: GapType;
  subQuestionId?: string;
  suggestedQueries: string[];
}

export type CoverageVerdict = "sufficient" | "insufficient" | "partial";

export interface CoverageReport {
  perSubQuestion: SubCoverage[];
  gaps: Gap[];
  overall: CoverageVerdict;
  /** True se un LLM ha arricchito la valutazione (mai per aggiungere testo). */
  llmUsed: boolean;
}

export interface CoverageOptions {
  /** sourceId → data dichiarata (es. "2025-06-12") se nota, undefined altrimenti. */
  sourceDates?: ReadonlyMap<string, string | undefined>;
  /** Conflitti già rilevati per sotto-domanda (Step 16): topic per subQuestionId. */
  conflictsBySub?: ReadonlyMap<string, readonly string[]>;
  /** Sotto-domande trattate come claim chiave (default: importance critical). */
  keyClaimSubQuestionIds?: ReadonlySet<string>;
  /** Clock iniettabile per i suggerimenti con anno (default: adesso). */
  now?: Date;
}

const CONFIDENCE_RANK: Record<EvidenceConfidence, number> = { high: 2, medium: 1, low: 0 };
const RANK_CONFIDENCE: readonly EvidenceConfidence[] = ["low", "medium", "high"];

function worstConfidence(evidences: readonly Evidence[]): EvidenceConfidence | null {
  if (evidences.length === 0) return null;
  let worstRank = Infinity;
  for (const e of evidences) worstRank = Math.min(worstRank, CONFIDENCE_RANK[e.confidence]);
  return RANK_CONFIDENCE[worstRank];
}

function distinctSourceCount(evidences: readonly Evidence[]): number {
  return new Set(evidences.map((e) => e.sourceId)).size;
}

/** Query di follow-up deterministiche per una sotto-domanda (mai LLM). */
export function buildSubQuestionQueries(
  subText: string,
  maxQueries = 3,
  now?: Date,
): string[] {
  const base = clampText(subText, 300);
  const keywords = extractKeywords(subText).join(" ");
  const out: string[] = [base];
  if (keywords !== "") {
    if (now !== undefined) out.push(clampText(`${keywords} ${now.getUTCFullYear()}`, 300));
    out.push(clampText(`${keywords} official documentation`, 300));
    out.push(clampText(`${keywords} primary source`, 300));
  }
  const seen = new Set<string>();
  return out
    .filter((q) => {
      const key = q.toLowerCase();
      if (key === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxQueries);
}

/** Euristica di autorità puramente lessicale: TLD gov/edu (nessuna lista inventata). */
function looksAuthoritativeDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const tld = host.split(".").pop();
    return tld === "gov" || tld === "edu";
  } catch {
    return false;
  }
}

function isWithinAYear(dateValue: string | undefined, now: Date): boolean {
  if (dateValue === undefined) return false;
  const parsed = Date.parse(dateValue);
  if (Number.isNaN(parsed)) return false;
  const ageMs = now.getTime() - parsed;
  return ageMs >= 0 && ageMs <= 365 * 86_400_000;
}

/**
 * Valuta la copertura del piano con le evidenze raccolte. Funzione pura
 * (l'ora corrente è iniettabile e usata solo per i gap di freschezza).
 */
export function assessCoverage(
  plan: ResearchPlan,
  store: EvidenceStore,
  options: CoverageOptions = {},
): CoverageReport {
  const evidences = store.all();
  const keyClaims = options.keyClaimSubQuestionIds ?? new Set(
    plan.subQuestions.filter((s) => s.importance === "critical").map((s) => s.id),
  );

  // --- copertura per sotto-domanda -----------------------------------------
  const perSubQuestion: SubCoverage[] = [];
  for (const sub of plan.subQuestions) {
    const subEvidences = store.bySubQuestion(sub.id);
    const strongCount = subEvidences.filter(
      (e) => (e.relevance ?? 0) >= VERIFICATION_THRESHOLDS.strongRelevanceMin,
    ).length;
    const lowDistinct = distinctSourceCount(
      subEvidences.filter((e) => e.confidence === "low"),
    );
    const baseCovered =
      strongCount >= 1 ||
      lowDistinct >= VERIFICATION_THRESHOLDS.lowConfidenceDistinctForCoverage;
    const isKey = keyClaims.has(sub.id);
    const covered =
      baseCovered &&
      (!isKey ||
        distinctSourceCount(subEvidences) >= VERIFICATION_THRESHOLDS.minSourcesForKeyClaim);

    perSubQuestion.push({
      subQuestionId: sub.id,
      keyClaim: isKey,
      evidenceCount: subEvidences.length,
      distinctSources: distinctSourceCount(subEvidences),
      maxRelevance: Math.max(0, ...subEvidences.map((e) => e.relevance ?? 0)),
      minConfidence: worstConfidence(subEvidences),
      covered,
    });
  }

  // --- gap -------------------------------------------------------------------
  const gaps: Gap[] = [];
  const noEvidence = evidences.length === 0;

  if (noEvidence) {
    const suggestedQueries = plan.queries.slice(0, 3).map((q) => q.query);
    gaps.push({ type: "no-evidence", suggestedQueries });
  }

  for (const sub of plan.subQuestions) {
    const coverage = perSubQuestion.find((c) => c.subQuestionId === sub.id)!;
    const subEvidences = store.bySubQuestion(sub.id);
    const isKey = coverage.keyClaim;

    if (!coverage.covered && !noEvidence) {
      if (
        coverage.evidenceCount > 0 &&
        isKey &&
        coverage.distinctSources < VERIFICATION_THRESHOLDS.minSourcesForKeyClaim
      ) {
        gaps.push({
          type: "single-source",
          subQuestionId: sub.id,
          suggestedQueries: buildSubQuestionQueries(sub.text, 2),
        });
      } else {
        gaps.push({
          type: "uncovered-subquestion",
          subQuestionId: sub.id,
          suggestedQueries: buildSubQuestionQueries(sub.text, 3),
        });
      }
      continue;
    }

    if (!coverage.covered) continue;

    // coperta ma da un'unica fonte non autorevole (euristica .gov/.edu)
    if (coverage.distinctSources === 1) {
      const onlySource = subEvidences[0];
      if (onlySource && !looksAuthoritativeDomain(onlySource.url)) {
        gaps.push({
          type: "low-authority",
          subQuestionId: sub.id,
          suggestedQueries: buildSubQuestionQueries(sub.text, 2),
        });
      }
    }

    // freschezza richiesta ma evidenze senza data recente (se i dati sono noti)
    if (
      plan.constraints.freshness !== "any" &&
      subEvidences.length > 0 &&
      !subEvidences.some((e) =>
        isWithinAYear(options.sourceDates?.get(e.sourceId), options.now ?? new Date()),
      )
    ) {
      gaps.push({
        type: "freshness",
        subQuestionId: sub.id,
        suggestedQueries: buildSubQuestionQueries(sub.text, 3, options.now ?? new Date()),
      });
    }

    // conflitti già rilevati (Step 16) su questa sotto-domanda
    const topics = options.conflictsBySub?.get(sub.id);
    if (topics !== undefined && topics.length > 0) {
      gaps.push({
        type: "conflicting",
        subQuestionId: sub.id,
        suggestedQueries: buildSubQuestionQueries(sub.text, 2),
      });
    }
  }

  // --- giudizio complessivo ---------------------------------------------------
  let overall: CoverageVerdict;
  if (noEvidence) {
    overall = "insufficient";
  } else if (perSubQuestion.every((c) => c.covered)) {
    overall = gaps.length === 0 ? "sufficient" : "partial";
  } else if (perSubQuestion.some((c) => c.covered)) {
    overall = "partial";
  } else {
    overall = "insufficient";
  }

  return { perSubQuestion, gaps, overall, llmUsed: false };
}

export type StopReason = "depth-reached" | "budget-exhausted" | "sufficient" | "gaps-remain";

export interface ShouldContinueResult {
  go: boolean;
  reason: StopReason;
}

/**
 * Decide se serve un altro round. `round` è il numero di round GIÀ eseguiti
 * (1 = ricerca iniziale); `maxDepth` è il numero massimo di round ammessi.
 * Stop espliciti: profondità raggiunta, budget esaurito, sufficienza.
 */
export function shouldContinue(input: {
  round: number;
  maxDepth: number;
  budgetLeft: number;
  gaps: readonly Gap[];
}): ShouldContinueResult {
  if (input.round >= input.maxDepth) return { go: false, reason: "depth-reached" };
  if (input.budgetLeft <= 0) return { go: false, reason: "budget-exhausted" };
  if (input.gaps.length === 0) return { go: false, reason: "sufficient" };
  return { go: true, reason: "gaps-remain" };
}
