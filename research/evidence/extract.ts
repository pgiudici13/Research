// Estrazione evidenze da una pagina estratta (funzioni pure, deterministiche).
// REGOLA DI DOMINIO: un'evidenza contiene SOLO testo estratto (passaggio
// esatto della fonte). Nessun riassunto, nessuna aggiunta del modello: le
// annotazioni LLM (verifica/contraddizioni) sono strutture separate e non
// vengono MAI fuse nel testo dell'evidenza.
// Ogni evidenza è ancorata a fonte + passaggio + timestamp + confidenza.

import { getLimits } from "@/lib/config/limits";
import { createLogger, type Logger } from "@/lib/logger";
import type { Evidence, EvidenceConfidence, ExtractedPage, SubQuestion } from "@/lib/types";
import { tokenize } from "@/research/scoring/score";
import { splitIntoPassages } from "@/research/extract/text";

export interface ExtractEvidenceContext {
  /** Sotto-domande del piano (Step 13) usate per la rilevanza. */
  subQuestions: SubQuestion[];
  /** Massimo evidenze per pagina (default: limits.maxEvidencesPerPage = 8). */
  maxPerPage?: number;
  /** Lunghezza massima dei passaggi (default: limits.passageMaxChars = 1200). */
  passageMaxChars?: number;
  /** Overlap tra passaggi (default: limits.passageOverlapChars = 80). */
  passageOverlapChars?: number;
  /**
   * Se nessun passaggio supera la soglia di rilevanza, restituisce comunque i
   * primi passaggi del documento con confidence 'low' (solo se la pagina è
   * stata scelta dal ranking: per non buttare fonti deboli ma potenzialmente
   * utili). Decisione del chiamante, documentata.
   */
  allowLowConfidenceFallback?: boolean;
  /** Timestamp di fetch della fonte (default: page.extractedAt). */
  retrievedAt?: string;
  logger?: Logger;
}

/** Soglia di rilevanza minima per candidare un passaggio (overlap > 0). */
export const MIN_RELEVANCE = 0;

/** Overlap >= 0.5 E almeno due frasi -> confidence 'high'. */
export const HIGH_RELEVANCE = 0.5;

/** Overlap >= 0.25 -> confidence 'medium'; sotto -> 'low'. */
export const MEDIUM_RELEVANCE = 0.25;

const SENTENCE_END = /[.!?…]+(?=\s|$)/g;

/** Stima deterministica del numero di frasi di un passaggio. */
export function sentenceCount(passage: string): number {
  const matches = passage.match(SENTENCE_END);
  const count = matches?.length ?? 0;
  return count === 0 && passage.trim() !== "" ? 1 : Math.max(1, count);
}

/** Overlap normalizzato tra i token di una sotto-domanda e il passaggio. */
export function passageRelevance(passage: string, subQuestion: string): number {
  const subTokens = tokenize(subQuestion);
  if (subTokens.length === 0) return 0;
  const passageTokens = new Set(tokenize(passage));
  let hits = 0;
  for (const token of subTokens) if (passageTokens.has(token)) hits++;
  return Math.min(1, hits / subTokens.length);
}

function bestSubQuestion(
  passage: string,
  subQuestions: readonly SubQuestion[],
): { relevance: number; subQuestionId?: string } {
  let best = { relevance: 0, subQuestionId: undefined as string | undefined };
  for (const sub of subQuestions) {
    const relevance = passageRelevance(passage, sub.text);
    if (relevance > best.relevance) {
      best = { relevance, subQuestionId: sub.id };
    }
  }
  return best;
}

function confidenceFor(relevance: number, sentences: number): EvidenceConfidence {
  if (relevance >= HIGH_RELEVANCE && sentences >= 2) return "high";
  if (relevance >= MEDIUM_RELEVANCE) return "medium";
  return "low";
}

/**
 * Estrae fino a `maxPerPage` evidenze deterministiche dalla pagina: split in
 * passaggi, selezione per rilevanza verso le sotto-domande, confidenza per
 * overlap + numero di frasi. Pagina vuota -> []. Nessun effetto collaterale.
 */
export function extractEvidence(
  page: ExtractedPage,
  ctx: ExtractEvidenceContext,
): Evidence[] {
  const logger = ctx.logger ?? createLogger("evidence");
  const limits = getLimits();
  const maxPerPage = ctx.maxPerPage ?? limits.maxEvidencesPerPage;
  const passageMaxChars = ctx.passageMaxChars ?? limits.passageMaxChars;
  const passageOverlapChars = ctx.passageOverlapChars ?? limits.passageOverlapChars;
  const retrievedAt = ctx.retrievedAt ?? page.extractedAt;
  const subQuestions = ctx.subQuestions;

  const text = page.text.trim();
  if (text === "" || subQuestions.length === 0) return [];

  const passages = splitIntoPassages(text, passageMaxChars, passageOverlapChars);

  const scored = passages.map((passage, index) => {
    const { relevance, subQuestionId } = bestSubQuestion(passage, subQuestions);
    return { passage, index, relevance, subQuestionId };
  });

  const candidates = scored.filter((s) => s.relevance > MIN_RELEVANCE);

  let selected: typeof scored;
  if (candidates.length > 0) {
    selected = [...candidates]
      .sort((a, b) => b.relevance - a.relevance || a.index - b.index)
      .slice(0, maxPerPage);
  } else if (ctx.allowLowConfidenceFallback === true) {
    // fonte debole ma scelta dal ranking: primi passaggi, confidence low
    logger.debug("evidence.low_confidence_fallback", {
      sourceId: page.sourceId,
      passages: passages.length,
    });
    selected = scored.slice(0, Math.min(maxPerPage, passages.length)).map((s) => ({
      ...s,
      relevance: 0,
      subQuestionId: undefined,
    }));
  } else {
    return [];
  }

  const byIndex = new Map(selected.map((s) => [s.index, s]));
  const evidences: Evidence[] = [];
  for (let index = 0; index < passages.length && evidences.length < maxPerPage; index++) {
    const s = byIndex.get(index);
    if (s === undefined) continue;
    const sentences = sentenceCount(s.passage);
    evidences.push({
      id: `${page.sourceId}:p${s.index}`,
      sourceId: page.sourceId,
      url: page.url,
      passage: s.passage,
      passageIndex: s.index,
      retrievedAt,
      confidence: confidenceFor(s.relevance, sentences),
      subQuestionId: s.subQuestionId,
      relevance: s.relevance,
    });
  }
  return evidences;
}
