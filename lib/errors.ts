// Tassonomia errori (tabella C.4 di STEP.md).
// Ogni errore ha: code stabile, message NON sensibile, phase, retryable,
// httpStatus (solo per gli errori che diventano risposte HTTP pre-stream).

import type { ErrorInfo } from "@/lib/types";

export type ErrorCode =
  | "E_VALIDATION"
  | "E_RATE_LIMIT"
  | "E_BUDGET_EXCEEDED"
  | "E_CANCELLED"
  | "E_LLM_UNAVAILABLE"
  | "E_LLM_TIMEOUT"
  | "E_LLM_INVALID_RESPONSE"
  | "E_SEARCH_UNAVAILABLE"
  | "E_SEARCH_TIMEOUT"
  | "E_SEARCH_EMPTY"
  | "E_FETCH_FAILED"
  | "E_FETCH_TOO_LARGE"
  | "E_FETCH_UNSUPPORTED"
  | "E_SSRF_BLOCKED"
  | "E_TIMEOUT_RESEARCH"
  | "E_INTERNAL";

interface ErrorCatalogEntry {
  /** Messaggio pubblico, non sensibile, stabile. */
  message: string;
  /** Fase della pipeline in cui l'errore avviene per default. */
  phase: string;
  retryable: boolean;
  /** Presente solo per gli errori che diventano risposte HTTP pre-stream. */
  httpStatus?: number;
}

export const ERROR_CODES: readonly ErrorCode[] = [
  "E_VALIDATION",
  "E_RATE_LIMIT",
  "E_BUDGET_EXCEEDED",
  "E_CANCELLED",
  "E_LLM_UNAVAILABLE",
  "E_LLM_TIMEOUT",
  "E_LLM_INVALID_RESPONSE",
  "E_SEARCH_UNAVAILABLE",
  "E_SEARCH_TIMEOUT",
  "E_SEARCH_EMPTY",
  "E_FETCH_FAILED",
  "E_FETCH_TOO_LARGE",
  "E_FETCH_UNSUPPORTED",
  "E_SSRF_BLOCKED",
  "E_TIMEOUT_RESEARCH",
  "E_INTERNAL",
];

export const ERROR_CATALOG: Record<ErrorCode, ErrorCatalogEntry> = {
  E_VALIDATION: { message: "Richiesta non valida.", phase: "api", retryable: false, httpStatus: 400 },
  E_RATE_LIMIT: { message: "Troppe richieste: riprova più tardi.", phase: "api", retryable: false, httpStatus: 429 },
  E_BUDGET_EXCEEDED: { message: "Budget di ricerca esaurito.", phase: "engine", retryable: false },
  E_CANCELLED: { message: "Ricerca annullata dall'utente.", phase: "engine", retryable: false },
  E_LLM_UNAVAILABLE: {
    message: "Servizio LLM non disponibile o non configurato.",
    phase: "llm",
    retryable: true,
  },
  E_LLM_TIMEOUT: { message: "Timeout del servizio LLM.", phase: "llm", retryable: true },
  E_LLM_INVALID_RESPONSE: { message: "Risposta LLM non valida.", phase: "llm", retryable: false },
  E_SEARCH_UNAVAILABLE: {
    message: "Servizio di ricerca non disponibile o non configurato.",
    phase: "search",
    retryable: true,
  },
  E_SEARCH_TIMEOUT: { message: "Timeout del servizio di ricerca.", phase: "search", retryable: true },
  E_SEARCH_EMPTY: { message: "Nessun risultato di ricerca.", phase: "search", retryable: false },
  E_FETCH_FAILED: { message: "Pagina non raggiungibile.", phase: "fetch", retryable: true },
  E_FETCH_TOO_LARGE: { message: "Pagina troppo grande.", phase: "fetch", retryable: false },
  E_FETCH_UNSUPPORTED: { message: "Tipo di contenuto non supportato.", phase: "fetch", retryable: false },
  E_SSRF_BLOCKED: { message: "Destinazione non consentita.", phase: "fetch", retryable: false },
  E_TIMEOUT_RESEARCH: { message: "Tempo di ricerca esaurito.", phase: "engine", retryable: false },
  E_INTERNAL: { message: "Errore interno.", phase: "api", retryable: false, httpStatus: 500 },
};

export interface AppErrorOptions {
  /** Messaggio pubblico alternativo (deve restare NON sensibile). */
  message?: string;
  phase?: string;
  details?: unknown;
  cause?: unknown;
}

/** Errore applicativo con codice stabile della tassonomia C.4. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly phase: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const entry = ERROR_CATALOG[code];
    super(options.message ?? entry.message);
    this.name = "AppError";
    this.code = code;
    this.phase = options.phase ?? entry.phase;
    this.retryable = entry.retryable;
    this.httpStatus = entry.httpStatus;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function isRetryable(code: ErrorCode): boolean {
  return ERROR_CATALOG[code].retryable;
}

export function isRetryableError(err: unknown): boolean {
  return isAppError(err) && err.retryable;
}

/**
 * Converte un errore in ErrorInfo SAFE per il client: nessuno stack trace,
 * nessuna causa, nessun messaggio grezzo fuori catalogo. Un errore che non è
 * un AppError diventa sempre E_INTERNAL con messaggio di catalogo.
 */
export function toErrorInfo(err: unknown): ErrorInfo {
  if (isAppError(err)) {
    return {
      code: err.code,
      message: err.message,
      phase: err.phase,
      retryable: err.retryable,
    };
  }
  const entry = ERROR_CATALOG.E_INTERNAL;
  return {
    code: "E_INTERNAL",
    message: entry.message,
    phase: entry.phase,
    retryable: entry.retryable,
  };
}

/** Costruttore compatto per i moduli. */
export function appError(code: ErrorCode, options?: AppErrorOptions): AppError {
  return new AppError(code, options);
}
