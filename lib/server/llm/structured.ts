// server-only — chat con output JSON validato e retry mirato.
// Se il modello produce JSON non parsabile o fuori schema, si ritenta con un
// messaggio di correzione conciso (mai contenuti sensibili). Dopo gli
// tentativi -> E_LLM_INVALID_RESPONSE con dettaglio non sensibile.
// Gli errori di infrastruttura (unconfigured/timeout/5xx) NON vengono mascherati:
// si propagano perché i chiamanti (planner/synthesizer) attivino i fallback.

import { appError } from "@/lib/errors";
import { createLogger, type Logger } from "@/lib/logger";
import { safe, type Guard, type ValidationError } from "@/lib/validate/schema";
import { extractJsonValue } from "@/lib/validate/json";
import { chatCompletion, type ChatMessage, type ChatUsage } from "./nvidia";

export interface ChatJsonOptions<T> {
  messages: ChatMessage[];
  /** Guard dello schema JSON atteso per l'output. */
  schema: Guard<T>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Tentativi di rigenerazione su output non valido. Default: 2. */
  maxAttempts?: number;
  timeoutMs?: number;
  /** Tentativi HTTP totali per singola chiamata (default: limits). */
  httpMaxAttempts?: number;
  logger?: Logger;
}

export interface ChatJsonResult<T> {
  value: T;
  /** Contenuto grezzo dell'ultima risposta accettata (per log/diagnostica). */
  content: string;
  usage?: ChatUsage;
}

/** Percorso dello schema del ValidationError (non sensibile). */
export function buildValidationErrorPath(err: ValidationError): string {
  return err.path === "" ? "<root>" : err.path;
}

function correctionMessage(problem: string): ChatMessage {
  return {
    role: "user",
    content:
      `La risposta precedente non era valida (${problem}). ` +
      "Rispondi SOLO con un JSON valido che rispetta esattamente lo schema richiesto, senza testo aggiuntivo.",
  };
}

export async function chatJson<T>(options: ChatJsonOptions<T>): Promise<ChatJsonResult<T>> {
  const {
    messages,
    schema,
    maxAttempts = 2,
    logger = createLogger("llm"),
    ...httpOptions
  } = options;

  let lastProblem = "JSON non parsabile";
  let lastContent = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const currentMessages: ChatMessage[] =
      attempt === 1 ? [...messages] : [...messages, correctionMessage(lastProblem)];

    const result = await chatCompletion({
      ...httpOptions,
      messages: currentMessages,
      logger,
    });
    lastContent = result.content;

    const parsed = extractJsonValue(result.content);
    if (parsed === null) {
      lastProblem = "JSON non parsabile";
      logger.warn("llm.json_invalid", { attempt, maxAttempts, reason: lastProblem });
      continue;
    }

    const validation = safe(schema, parsed);
    if (validation.ok) {
      return { value: validation.value, content: result.content, usage: result.usage };
    }
    lastProblem = `schema: ${buildValidationErrorPath(validation.error)}`;
    logger.warn("llm.json_schema_invalid", { attempt, maxAttempts, path: validation.error.path });
  }

  logger.warn("llm.json_exhausted", { maxAttempts, problem: lastProblem });
  throw appError("E_LLM_INVALID_RESPONSE", {
    phase: "llm",
    details: { schemaPath: lastProblem, contentLength: lastContent.length },
  });
}

// Nota: i tentativi HTTP della singola chiamata sono gestiti dentro
// chatCompletion (retry su E_LLM_UNAVAILABLE/E_LLM_TIMEOUT); questo modulo
// aggiunge solo il loop di rigenerazione su output JSON/schema non validi.
