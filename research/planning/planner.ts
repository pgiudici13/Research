// Research planner (server-only): trasforma la domanda in un piano di ricerca
// strutturato (ResearchPlan) via LLM con output JSON validato, oppure — se
// l'LLM non è configurato, fallisce o produce un piano invalido — via planner
// di fallback DETERMINISTICO. Il planner NON produce mai la risposta finale.
//
// Regole:
// - Lo schema rifiuta i campi inventati (unknownKeys: "reject").
// - Il piano LLM viene sanificato: riferimenti a sotto-domande inesistenti
//   rimossi, query duplicate unite, mai oltre il budget (taglio per priorità).
// - Si loggano solo esiti/codici, mai prompt o risposte LLM.

import { getLimits } from "@/lib/config/limits";
import { appError, isAppError, toErrorInfo } from "@/lib/errors";
import { createLogger, type Logger } from "@/lib/logger";
import { llmConfigured } from "@/lib/server/llm/nvidia";
import { chatJson } from "@/lib/server/llm/structured";
import type { ErrorInfo, ResearchOptions, ResearchPlan } from "@/lib/types";
import { arr, enumOf, num, obj, opt, str, type Guard } from "@/lib/validate/schema";
import { buildFallbackPlan, normalizeQuestion } from "./fallback";
import { buildPlannerMessages } from "./prompt";

const QUERY_PURPOSES = [
  "sub-question",
  "synonym",
  "primary-source",
  "recent",
  "counter-argument",
  "follow-up",
] as const;

const IMPORTANCE = ["critical", "supporting"] as const;

const FRESHNESS_VALUES = ["any", "recent", "year"] as const;

// --- Tipi grezzi (output LLM prima della sanificazione) ----------------------

interface RawPlannedQuery {
  query: string;
  purpose: (typeof QUERY_PURPOSES)[number];
  subQuestionId?: string;
  priority: number;
}

interface RawSubQuestion {
  id: string;
  text: string;
  importance: (typeof IMPORTANCE)[number];
}

interface RawPlan {
  objective: string;
  subQuestions: RawSubQuestion[];
  queries: RawPlannedQuery[];
  constraints: { lang?: string; freshness?: string };
  ambiguities: string[];
}

/** Guard dello schema del piano LLM (export per i test dello Step 13). */
export function buildRawPlanSchema(maxQueries: number): Guard<RawPlan> {
  const subQuestionGuard = obj<RawSubQuestion>({
    id: str(1, 50),
    text: str(1, 500),
    importance: enumOf(IMPORTANCE),
  });

  const queryGuard = obj<RawPlannedQuery>({
    query: str(1, 300),
    purpose: enumOf(QUERY_PURPOSES),
    subQuestionId: opt(str(1, 50)),
    priority: num(0, 1),
  });

  return obj<RawPlan>(
    {
      objective: str(1, 2_000),
      subQuestions: arr(subQuestionGuard, 1, 5),
      queries: arr(queryGuard, 3, Math.min(100, maxQueries + 10)),
      constraints: obj<{ lang?: string; freshness?: string }>({
        lang: opt(str(1, 20)),
        freshness: opt(str(1, 20)),
      }),
      ambiguities: arr(str(1, 300), 0, 10),
    },
    { unknownKeys: "reject" },
  );
}

/**
 * Sanifica il piano LLM: filtra/aggiusta riferimenti, unisce query duplicate,
 * impone i vincoli di budget (mai oltre maxQueries). Ritorna null se il piano
 * non è recuperabile (es. restano meno di 3 query valide).
 */
function sanitizePlan(
  raw: RawPlan,
  ctx: { options?: ResearchOptions; maxQueries: number },
): ResearchPlan | null {
  // sotto-domande: id unici (primo vince)
  const seenIds = new Set<string>();
  const subQuestions = raw.subQuestions.filter((s) => {
    const id = s.id.trim();
    if (id === "" || seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
  if (subQuestions.length === 0) return null;

  const subIds = new Set(subQuestions.map((s) => s.id.trim()));

  // query: uniche (case-insensitive), riferimenti validi, taglio per priorità
  const seenQueries = new Set<string>();
  const uniqueQueries: RawPlannedQuery[] = [];
  for (const q of raw.queries) {
    const query = q.query.trim();
    const key = query.toLowerCase();
    if (key === "" || seenQueries.has(key)) continue;
    seenQueries.add(key);
    uniqueQueries.push({
      query,
      purpose: q.purpose,
      subQuestionId: q.subQuestionId !== undefined && subIds.has(q.subQuestionId) ? q.subQuestionId : undefined,
      priority: Math.min(1, Math.max(0, q.priority)),
    });
  }
  uniqueQueries.sort((a, b) => b.priority - a.priority);
  const queries = uniqueQueries.slice(0, ctx.maxQueries);
  if (queries.length < 3) return null;

  // vincoli: lang default "auto"; freschezza coerente con le opzioni
  const rawFreshness = raw.constraints.freshness?.trim();
  const allowedFreshness = new Set<string>(FRESHNESS_VALUES);
  const modelFreshness =
    rawFreshness !== undefined && allowedFreshness.has(rawFreshness) ? rawFreshness : "any";
  const freshness: string = ctx.options?.freshness ?? modelFreshness;
  const lang = raw.constraints.lang?.trim() || "auto";

  return {
    objective: raw.objective.trim(),
    subQuestions: subQuestions.map((s) => ({ ...s, id: s.id.trim() })),
    queries: queries.map((q) => ({
      query: q.query,
      purpose: q.purpose,
      subQuestionId: q.subQuestionId,
      priority: q.priority,
    })),
    constraints: { lang, freshness },
    ambiguities: raw.ambiguities.map((a) => a.trim()).filter((a) => a !== ""),
    source: "llm",
  };
}

export interface PlanRequest {
  question: string;
  options?: ResearchOptions;
  signal?: AbortSignal;
  logger?: Logger;
  /** fetch iniettabile per i test (arriva a chatCompletion). */
  fetchImpl?: typeof fetch;
  /** Clock iniettabile per il fallback (default: adesso). */
  now?: Date;
}

export interface PlanResult {
  plan: ResearchPlan;
  usedFallback: boolean;
  /** Errore LLM normalizzato (safe), presente solo se si è usato il fallback. */
  llmError?: ErrorInfo;
}

/**
 * Pianifica la ricerca. Non lancia mai per indisponibilità LLM o output
 * invalido: in quei casi ritorna il piano di fallback con `usedFallback`.
 * Unica eccezione propagata: annullamento utente (AbortError) e domanda
 * fuori dai limiti (E_VALIDATION).
 */
export async function planResearch(request: PlanRequest): Promise<PlanResult> {
  const logger = request.logger ?? createLogger("planning");
  const limits = getLimits();

  const question = normalizeQuestion(request.question);
  if (question.length < limits.questionMinChars || question.length > limits.questionMaxChars) {
    throw appError("E_VALIDATION", {
      phase: "planning",
      details: {
        reason: "question length out of bounds",
        minChars: limits.questionMinChars,
        maxChars: limits.questionMaxChars,
      },
    });
  }

  const maxQueries = Math.max(3, limits.maxQueries);

  const makeFallback = (): PlanResult => ({
    plan: buildFallbackPlan({
      question,
      options: request.options,
      maxQueries,
      now: request.now,
    }),
    usedFallback: true,
  });

  if (!llmConfigured()) {
    logger.warn("planning.llm_unconfigured", { usedFallback: true });
    return {
      ...makeFallback(),
      llmError: toErrorInfo(
        appError("E_LLM_UNAVAILABLE", {
          phase: "llm",
          retryable: false,
          details: { unconfigured: true },
        }),
      ),
    };
  }

  try {
    const result = await chatJson<RawPlan>({
      messages: buildPlannerMessages(question, request.options),
      schema: buildRawPlanSchema(maxQueries),
      maxTokens: limits.plannerMaxTokens,
      temperature: 0.2,
      jsonMode: true,
      signal: request.signal,
      fetchImpl: request.fetchImpl,
      logger,
    });

    const plan = sanitizePlan(result.value, { options: request.options, maxQueries });
    if (plan === null) {
      logger.warn("planning.llm_plan_invalid", { usedFallback: true });
      return {
        ...makeFallback(),
        llmError: toErrorInfo(
          appError("E_LLM_INVALID_RESPONSE", {
            phase: "llm",
            details: { reason: "plan not usable after sanitization" },
          }),
        ),
      };
    }

    logger.info("planning.completed", {
      subQuestions: plan.subQuestions.length,
      queries: plan.queries.length,
      usedFallback: false,
    });
    return { plan, usedFallback: false };
  } catch (err) {
    if (request.signal?.aborted) throw err; // annullamento utente: mai fallback
    logger.warn("planning.llm_fallback", {
      code: isAppError(err) ? err.code : "E_INTERNAL",
    });
    return { ...makeFallback(), llmError: toErrorInfo(err) };
  }
}
