// server-only — client NVIDIA /chat/completions (OpenAI-compatible).
// MAI importare da codice client. La chiave vive solo qui (da env) e
// nell'header Authorization della richiesta: mai nei log, mai nei prompt.
//
// Nota di implementazione sul timeout: usiamo AbortSignal.timeout combinato
// con il segnale del chiamante (AbortSignal.any) invece di un semplice race,
// così il fetch sottostante viene davvero cancellato al timeout.

import { getEnv } from "@/lib/config/env";
import { getLimits } from "@/lib/config/limits";
import { appError } from "@/lib/errors";
import { retry } from "@/lib/http/retry";
import { createLogger, type Logger, type LogFields } from "@/lib/logger";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatCompletionResult {
  content: string;
  finishReason: string;
  usage?: ChatUsage;
}

export interface ChatCompletionParams {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Invia `response_format: { type: "json_object" }` se il modello lo supporta. */
  jsonMode?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Timeout per singola chiamata (default: limits.llmTimeoutMs). */
  timeoutMs?: number;
  /** Tentativi HTTP totali (default: limits.llmMaxAttempts). */
  maxAttempts?: number;
  baseDelayMs?: number;
  logger?: Logger;
}

/** True se NVIDIA_API_KEY e NVIDIA_MODEL sono configurati. */
export function llmConfigured(): boolean {
  const env = getEnv();
  return env.nvidiaApiKey !== undefined && env.nvidiaModel !== undefined;
}

function chatEndpoint(): string {
  return `${getEnv().nvidiaBaseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * Chiamata a /chat/completions con normalizzazione della risposta.
 * Errori: 401/403/altri 4xx -> E_LLM_UNAVAILABLE NON ritentabile (senza body);
 * 429/5xx/timeout/errore di rete -> E_LLM_UNAVAILABLE/E_LLM_TIMEOUT ritentabili;
 * body/JSON fuori schema -> E_LLM_INVALID_RESPONSE.
 * Se il servizio non è configurato -> E_LLM_UNAVAILABLE non ritentabile con
 * `details.unconfigured = true` (la UI lo mostra come modalità degradata).
 */
export async function chatCompletion(
  params: ChatCompletionParams,
): Promise<ChatCompletionResult> {
  const {
    model,
    messages,
    temperature = 0.2,
    maxTokens = 1_024,
    jsonMode = false,
    signal,
    fetchImpl = globalThis.fetch,
    logger = createLogger("llm"),
  } = params;

  const env = getEnv();
  if (!env.nvidiaApiKey || !env.nvidiaModel) {
    throw appError("E_LLM_UNAVAILABLE", {
      phase: "llm",
      retryable: false,
      details: { unconfigured: true },
    });
  }

  const limits = getLimits();
  const timeoutMs = params.timeoutMs ?? limits.llmTimeoutMs;
  const attempts = params.maxAttempts ?? limits.llmMaxAttempts;
  const baseDelayMs = params.baseDelayMs ?? 100;
  const endpoint = chatEndpoint();
  const body: Record<string, unknown> = {
    model: model ?? env.nvidiaModel,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const startedAt = Date.now();

  return retry({
    attempts,
    baseDelayMs,
    maxDelayMs: 1_000,
    isRetryable: (err) => (err as { retryable?: boolean }).retryable === true,
    signal,
    fn: async () => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.nvidiaApiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: combined,
          cache: "no-store",
        });
      } catch (err) {
        if (timeoutSignal.aborted) {
          throw appError("E_LLM_TIMEOUT", { phase: "llm" });
        }
        if (signal?.aborted) throw err; // annullamento utente: propaga AbortError
        throw appError("E_LLM_UNAVAILABLE", { phase: "llm" });
      }

      const text = await response.text();

      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          logger.warn("llm.http_error", { status: response.status, retryable: true });
          throw appError("E_LLM_UNAVAILABLE", { phase: "llm" });
        }
        // 4xx (es. 401): mai ritentare, mai riflettere il body (potrebbe
        // contenere dettagli/segreti del provider).
        logger.warn("llm.http_error", { status: response.status, retryable: false });
        throw appError("E_LLM_UNAVAILABLE", { phase: "llm", retryable: false });
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        throw appError("E_LLM_INVALID_RESPONSE", { phase: "llm" });
      }

      const result = normalizeChatResponse(raw);
      const fields: LogFields = {
        event: "llm.completed",
        model: model ?? env.nvidiaModel,
        finishReason: result.finishReason,
        durationMs: Date.now() - startedAt,
      };
      if (result.usage) {
        fields.promptTokens = result.usage.promptTokens;
        fields.completionTokens = result.usage.completionTokens;
      }
      logger.info("llm.completed", fields);
      return result;
    },
  });
}

/** Valida e normalizza il body di /chat/completions. Mai contenuti nei log. */
export function normalizeChatResponse(raw: unknown): ChatCompletionResult {
  if (typeof raw !== "object" || raw === null) {
    throw appError("E_LLM_INVALID_RESPONSE", { phase: "llm" });
  }
  const obj = raw as Record<string, unknown>;
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw appError("E_LLM_INVALID_RESPONSE", { phase: "llm" });
  }
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  if (typeof message?.content !== "string") {
    throw appError("E_LLM_INVALID_RESPONSE", { phase: "llm" });
  }

  const usageRaw = obj.usage as Record<string, unknown> | undefined;
  const usage: ChatUsage | undefined =
    typeof usageRaw === "object" && usageRaw !== null
      ? {
          promptTokens: asFiniteNumber(usageRaw.prompt_tokens),
          completionTokens: asFiniteNumber(usageRaw.completion_tokens),
          totalTokens: asFiniteNumber(usageRaw.total_tokens),
        }
      : undefined;

  return {
    content: message.content,
    finishReason:
      typeof first?.finish_reason === "string" ? first.finish_reason : "stop",
    usage,
  };
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
