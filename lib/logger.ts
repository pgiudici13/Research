// Log strutturato: una riga JSON per record con correlazione opzionale.
// Server-only. Redazione automatica: chiavi sensibili (case-insensitive) e
// valori che sembrano segreti vengono sostituiti con "[REDACTED]".
// Policy: MAI loggare prompt completi o contenuti di pagina integrali
// (solo lunghezze/hash); mai header Authorization.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(key|token|secret|password|authorization|cookie|credential)/i;

// Valori che sembrano credenziali note (best-effort, in aggiunta alle chiavi).
const SENSITIVE_VALUE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

export type LogFields = Record<string, unknown>;

export interface LoggerCtx {
  researchId?: string;
  clientRequestId?: string;
  phase?: string;
}

export interface LoggerOptions {
  level?: LogLevel;
  baseCtx?: LoggerCtx;
  /** Destinazione di default: stdout. Iniettabile nei test. */
  sink?: (line: string) => void;
}

export interface Logger {
  readonly scope: string;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Restituisce un logger con contesto di correlazione aggiuntivo. */
  child(ctx: LoggerCtx): Logger;
}

export function isLevelEnabled(configured: LogLevel, level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[configured];
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

function looksSensitive(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function looksLikeSecret(value: string): boolean {
  return SENSITIVE_VALUE.test(value);
}

/**
 * Serializza un valore applicando la redazione in modo ricorsivo.
 * - chiave sensibile -> "[REDACTED]";
 * - Headers/Request/Response -> "[REDACTED]";
 * - stringhe con pattern di credenziale -> "[REDACTED]";
 * - Error -> { name, message } (message soggetto a redazione per valore);
 * - altrimenti struttura normale.
 */
export function redactValue(value: unknown, key = ""): unknown {
  if (looksSensitive(key)) return REDACTED;

  if (typeof value === "string") {
    return looksLikeSecret(value) ? REDACTED : value;
  }

  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof Headers !== "undefined" && value instanceof Headers) return REDACTED;
  if (typeof value === "function") return "[function]";

  if (value instanceof Error) {
    const safe: Record<string, unknown> = { name: value.name };
    const message = redactValue(value.message, "message");
    if (message !== undefined) safe.message = message;
    return safe;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, key));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }

  return String(value);
}

/** Costruisce campi di correlazione (omette gli undefined). */
export function ctx(
  researchId?: string,
  clientRequestId?: string,
  phase?: string,
): LoggerCtx {
  const out: LoggerCtx = {};
  if (researchId) out.researchId = researchId;
  if (clientRequestId) out.clientRequestId = clientRequestId;
  if (phase) out.phase = phase;
  return out;
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  const configuredLevel = options.level ?? ((process.env.LOG_LEVEL ?? "info") as LogLevel);
  const baseCtx = options.baseCtx ?? {};
  const sink = options.sink ?? defaultSink;

  function log(level: LogLevel, event: string, fields?: LogFields): void {
    if (!isLevelEnabled(configuredLevel, level)) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      scope,
      event,
      ...baseCtx,
    };
    if (fields !== undefined) {
      for (const [k, v] of Object.entries(fields)) {
        record[k] = redactValue(v, k);
      }
    }
    sink(JSON.stringify(record));
  }

  return {
    scope,
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
    child(extra: LoggerCtx): Logger {
      return createLogger(scope, {
        level: configuredLevel,
        baseCtx: { ...baseCtx, ...extra },
        sink,
      });
    },
  };
}
