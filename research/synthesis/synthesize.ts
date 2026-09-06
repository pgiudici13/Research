// Synthesizer del report finale (server-only, Step 18): genera il report JSON
// da SOLO evidenze strutturate (mai dai risultati grezzi di ricerca, mai da
// conoscenza del modello), citando SOLO le chiavi della tabella di citazione
// pre-assegnata (stesso ordinamento deterministico del modulo Step 19).
//
// Flusso:
//   1. costruisce la tabella citazioni da evidenze+sourceRecords;
//   2. chiama l'LLM con chatJson (schema JSON strict, campi extra rifiutati);
//   3. valida la logica post-LLM (paragrafi non vuoti, sezioni ≤ 8, totale
//      sotto cap, citazioni intere ed ESISTENTI in tabella) — su fallimento
//      un retry mirato con messaggio di correzione; al secondo fallimento o
//      su errore di infrastruttura/LLM non configurato → sintesi di fallback
//      deterministica chiaramente marcata (usedFallback: true + llmError);
//   4. i Claim sono derivati in modo deterministico (deriveClaims) SOLO dai
//      paragrafi validati: mai dal modello.
//
// Annullamento utente (AbortError): propagato, MAI fallback.

import { getLimits } from "@/lib/config/limits";
import { appError, isAppError, toErrorInfo, type ErrorCode } from "@/lib/errors";
import { createLogger, type Logger } from "@/lib/logger";
import { ChatMessage, llmConfigured } from "@/lib/server/llm/nvidia";
import { buildSynthesisMessages, type PromptEvidenceEntry } from "@/lib/server/llm/prompts";
import { chatJson } from "@/lib/server/llm/structured";
import type { Citation, ClaimKind, ErrorInfo, ReportSection } from "@/lib/types";
import { arr, enumOf, num, obj, str, type Guard } from "@/lib/validate/schema";
import { buildCitationTable, deriveClaims } from "@/research/citations/map";
import type { SynthesisInput, SynthesisOutput } from "@/research/engine/deps";
import { buildFallbackSynthesis } from "./fallback";

/** Limiti interni del report sintetizzato (documentati, esportati per i test). */
export const SYNTHESIS_LIMITS = {
  maxSections: 8,
  maxParagraphsPerSection: 8,
  maxParagraphChars: 4_000,
  maxTotalChars: 24_000,
  maxCitationsPerParagraph: 20,
} as const;

const CLAIM_KINDS: readonly ClaimKind[] = ["fact", "inference", "uncertain"];

// --- Tipi grezzi (output LLM prima della validazione logica) -------------------

interface RawParagraph {
  text: string;
  kind: ClaimKind;
  citations: number[];
}

interface RawSection {
  heading: string;
  paragraphs: RawParagraph[];
}

interface RawSynthesis {
  sections: RawSection[];
}

/** Guard dello schema JSON del report LLM (export per i test dello Step 18). */
export function buildRawSynthesisSchema(): Guard<RawSynthesis> {
  const paragraphGuard = obj<RawParagraph>(
    {
      text: str(1, SYNTHESIS_LIMITS.maxParagraphChars),
      kind: enumOf(CLAIM_KINDS),
      citations: arr(num(1, 10_000), 0, SYNTHESIS_LIMITS.maxCitationsPerParagraph),
    },
    { unknownKeys: "reject" },
  );

  const sectionGuard = obj<RawSection>(
    {
      heading: str(1, 200),
      paragraphs: arr(paragraphGuard, 1, SYNTHESIS_LIMITS.maxParagraphsPerSection),
    },
    { unknownKeys: "reject" },
  );

  return obj<RawSynthesis>(
    { sections: arr(sectionGuard, 1, SYNTHESIS_LIMITS.maxSections) },
    { unknownKeys: "reject" },
  );
}

type LogicalResult =
  | { ok: true; sections: ReportSection[] }
  | { ok: false; problem: string };

/**
 * Validazione logica post-schema (mai solo schema): paragrafi non vuoti dopo
 * trim, citazioni intere ESISTENTI nella tabella, lunghezza totale sotto cap.
 * Ritorna le sezioni normalizzate (trim) oppure il problema (per il retry).
 */
export function validateSynthesisSections(
  raw: RawSynthesis,
  table: readonly Citation[],
): LogicalResult {
  const valid = new Set(table.map((entry) => entry.index));
  const sections: ReportSection[] = [];
  let totalChars = 0;

  for (const section of raw.sections) {
    const heading = section.heading.replace(/\s+/g, " ").trim();
    if (heading === "") {
      return { ok: false, problem: "una sezione ha un'intestazione vuota" };
    }
    const paragraphs: ReportSection["paragraphs"] = [];
    for (const paragraph of section.paragraphs) {
      const text = paragraph.text.replace(/\s+/g, " ").trim();
      if (text === "") {
        return { ok: false, problem: "un paragrafo è vuoto" };
      }
      for (const citation of paragraph.citations) {
        if (!Number.isInteger(citation) || !valid.has(citation)) {
          return {
            ok: false,
            problem: `citazione ${String(citation)} non presente nella tabella citazioni`,
          };
        }
      }
      totalChars += text.length;
      paragraphs.push({ text, kind: paragraph.kind, citations: paragraph.citations });
    }
    sections.push({ heading, paragraphs });
  }

  if (totalChars > SYNTHESIS_LIMITS.maxTotalChars) {
    return { ok: false, problem: "report troppo lungo" };
  }
  return { ok: true, sections };
}

export interface SynthesisRequest {
  researchId: string;
  question: string;
  plan: SynthesisInput["plan"];
  evidences: SynthesisInput["evidences"];
  sourceRecords?: SynthesisInput["sourceRecords"];
  conflicts: SynthesisInput["conflicts"];
  limitations: SynthesisInput["limitations"];
  signal?: AbortSignal;
  logger?: Logger;
  /** fetch iniettabile per i test (arriva a chatCompletion). */
  fetchImpl?: typeof fetch;
}

export interface SynthesisResult extends SynthesisOutput {
  usedFallback: boolean;
  llmError?: ErrorInfo;
}

function fallbackError(
  code: ErrorCode,
  retryable: boolean,
  details?: Record<string, unknown>,
): ErrorInfo {
  return toErrorInfo(appError(code, { phase: "llm", retryable, details }));
}

/**
 * Sintetizza il report finale. Non lancia mai per indisponibilità LLM o output
 * non valido: in quei casi ritorna la sintesi di fallback con `usedFallback`.
 * Unica eccezione propagata: annullamento utente (AbortError).
 */
export async function synthesizeReport(
  request: SynthesisRequest,
): Promise<SynthesisResult> {
  const logger = request.logger ?? createLogger("synthesis");
  const limits = getLimits();

  const { question, plan, evidences, sourceRecords = [], conflicts, limitations } = request;

  // tabella di citazione pre-assegnata: STESSO ordinamento del motore (Step 19)
  const table = buildCitationTable(evidences, sourceRecords);
  const byEvidence = new Map(table.map((entry) => [entry.evidenceId, entry] as const));
  const subQuestionOf = new Map(evidences.map((e) => [e.id, e.subQuestionId] as const));

  // Nessuna evidenza: report vuoto onesto (il motore non chiama in questo caso).
  if (evidences.length === 0) {
    logger.warn("synthesis.no_evidence", {});
    return { sections: [], claims: [], usedFallback: false };
  }

  const evidenceEntries: PromptEvidenceEntry[] = evidences.map((evidence) => {
    const entry = byEvidence.get(evidence.id);
    return {
      index: entry?.index ?? 0, // 0 = non in tabella: il modello non può citarlo
      subQuestionId: subQuestionOf.get(evidence.id),
      url: evidence.url,
      passage: evidence.passage,
    };
  });

  const makeMessages = (correction?: string): ChatMessage[] => {
    const base = buildSynthesisMessages({
      question,
      subQuestions: plan.subQuestions.map((s) => ({ id: s.id, text: s.text })),
      evidenceEntries,
      conflicts: conflicts.map((c) => ({
        topic: c.topic,
        severity: c.severity,
        positions: c.statements.map((s) => s.position),
      })),
      limitations: {
        missingSources: limitations.missingSources,
        llmUnavailable: limitations.llmUnavailable,
        searchUnavailable: limitations.searchUnavailable,
        budgetExceeded: limitations.budgetExceeded,
        timeBudgetExceeded: limitations.timeBudgetExceeded,
        notes: limitations.notes,
      },
    });
    if (correction === undefined) return base;
    return [
      ...base,
      {
        role: "user",
        content:
          `La risposta precedente non era valida (${correction}). ` +
          "Rigenera SOLO il JSON del report rispettando lo schema e citando SOLO chiavi esistenti.",
      },
    ];
  };

  const makeFallback = (error: ErrorInfo): SynthesisResult => {
    logger.warn("synthesis.fallback", { code: error.code });
    const { sections, claims } = buildFallbackSynthesis({
      question,
      plan,
      evidences,
      table,
      conflicts,
      limitations,
    });
    return { sections, claims, usedFallback: true, llmError: error };
  };

  if (!llmConfigured()) {
    logger.warn("synthesis.llm_unconfigured", { usedFallback: true });
    return makeFallback(fallbackError("E_LLM_UNAVAILABLE", false, { unconfigured: true }));
  }

  try {
    const schema = buildRawSynthesisSchema();
    let lastProblem = "report non valido";
    let infraCode: ErrorCode | null = null;

    // fino a 2 chiamate LLM: il secondo tentativo riceve la correzione mirata.
    // Gli errori JSON/schema (E_LLM_INVALID_RESPONSE) contano come tentativo
    // fallito e rientrano nel retry; gli errori di infrastruttura no.
    for (let attempt = 1; attempt <= 2; attempt++) {
      let raw: RawSynthesis;
      try {
        const result = await chatJson<RawSynthesis>({
          messages: makeMessages(attempt === 1 ? undefined : lastProblem),
          schema,
          maxTokens: limits.synthesisMaxTokens,
          temperature: 0.2,
          jsonMode: true,
          maxAttempts: 1, // rigenerazioni: gestite dal loop logico qui sotto
          signal: request.signal,
          fetchImpl: request.fetchImpl,
          logger,
        });
        raw = result.value;
      } catch (err) {
        if (request.signal?.aborted) throw err; // annullamento utente: mai fallback
        if (isAppError(err) && err.code === "E_LLM_INVALID_RESPONSE") {
          lastProblem = "formato o schema JSON non valido";
          logger.warn("synthesis.schema_invalid", { attempt });
          continue; // retry mirato con messaggio di correzione
        }
        infraCode = (isAppError(err) ? err.code : "E_LLM_UNAVAILABLE") as ErrorCode;
        break;
      }

      const validation = validateSynthesisSections(raw, table);
      if (validation.ok) {
        const sections = validation.sections;
        const claims = deriveClaims(sections, table);
        logger.info("synthesis.completed", {
          sections: sections.length,
          paragraphs: sections.reduce((n, s) => n + s.paragraphs.length, 0),
          citationsTotal: sections.reduce(
            (n, s) => n + s.paragraphs.reduce((m, p) => m + p.citations.length, 0),
            0,
          ),
          usedFallback: false,
        });
        return { sections, claims, usedFallback: false };
      }
      lastProblem = validation.problem;
      logger.warn("synthesis.logic_invalid", { attempt, problem: lastProblem });
    }

    if (infraCode !== null) {
      return makeFallback(fallbackError(infraCode, false));
    }
    return makeFallback(
      fallbackError("E_LLM_INVALID_RESPONSE", false, {
        reason: "report not usable after validation",
      }),
    );
  } catch (err) {
    if (request.signal?.aborted) throw err; // annullamento utente: mai fallback
    const code = (isAppError(err) ? err.code : "E_LLM_UNAVAILABLE") as ErrorCode;
    logger.warn("synthesis.llm_error", { code });
    return makeFallback(fallbackError(code, false));
  }
}

