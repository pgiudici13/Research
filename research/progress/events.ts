// Wire protocol NDJSON (Step 20): il backend e il frontend parlano ESATTAMENTE
// lo stesso linguaggio di eventi (tipi in lib/types/progress.ts, Step 3).
// Questo modulo (import-safe client/server, nessun runtime server) fornisce:
//   - serializeEvent / parseEventLine: round-trip NDJSON una riga = un evento;
//   - isProgressEvent: guard di runtime per il client (mai fidarsi del wire);
//   - macchina a stati delle ResearchStatus con transizioni validate;
//   - limiti di sicurezza documentati (snippet/preview mai integrali, mai
//     campi che possano contenere segreti nel payload degli eventi).
//
// Contratto di sicurezza: gli eventi NON contengono mai segreti né testo
// integrale di pagine — solo preview troncate (limiti sotto). La presenza di
// campi a rischio nel tipo ProgressEvent è vietata e verificata dai test.

import type {
  ErrorInfo,
  PhaseName,
  ProgressEvent,
  ProgressEventType,
  ResearchReport,
  ResearchStatus,
} from "@/lib/types";

/** Limiti di sicurezza per le preview negli eventi (Step 20). */
export const EVENT_LIMITS = {
  /** Snippet di un risultato di ricerca, mai integrale. */
  resultFoundSnippetMax: 400,
  /** Preview di un passaggio di evidenza, mai integrale. */
  evidencePreviewMax: 300,
} as const;

/** Ordine canonico delle fasi/stati in corso della macchina a stati. */
export const STATUS_FLOW: readonly ResearchStatus[] = [
  "planning",
  "searching",
  "fetching",
  "analyzing",
  "verifying",
  "synthesizing",
];

const TERMINAL: ReadonlySet<ResearchStatus> = new Set<ResearchStatus>([
  "completed",
  "partial",
  "failed",
  "cancelled",
]);

const IN_FLOW: ReadonlySet<ResearchStatus> = new Set(STATUS_FLOW);

/**
 * Transizione valida? Regole:
 * - si parte da "planning" e si procede in avanti tra gli stati in corso
 *   (salti in avanti ammessi: il motore non emette ogni stato intermedio);
 * - da qualunque stato in corso si può terminare (completed/partial/failed);
 * - "cancelled" è raggiungibile da qualunque stato in corso (mai da terminale);
 * - uno stato terminale è assorbente (nessuna transizione in uscita).
 */
export function canTransitionStatus(
  from: ResearchStatus | null,
  to: ResearchStatus,
): boolean {
  if (TERMINAL.has(to)) {
    // stato terminale (completed/partial/failed/cancelled): raggiungibile
    // SOLO da uno stato in corso, mai da "nessuno stato" o da un terminale
    return from !== null && IN_FLOW.has(from);
  }
  // destinazione = stato in corso
  if (from === null) return to === "planning";
  if (TERMINAL.has(from)) return false; // i terminali sono assorbenti
  return STATUS_FLOW.indexOf(from) <= STATUS_FLOW.indexOf(to);
}

/** Come `canTransitionStatus` ma lancia un errore di sviluppo (per i test). */
export function assertValidStatusTransition(
  from: ResearchStatus | null,
  to: ResearchStatus,
): void {
  if (!canTransitionStatus(from, to)) {
    throw new Error(
      `transizione di stato non valida: ${from ?? "<inizio>"} -> ${to}`,
    );
  }
}

// --- Guard di runtime ---------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): value is string {
  return typeof value === "string";
}

function isStatus(value: unknown): value is ResearchStatus {
  return (
    str(value) &&
    (IN_FLOW.has(value as ResearchStatus) ||
      (TERMINAL as ReadonlySet<string>).has(value))
  );
}

function isPhaseName(value: unknown): value is PhaseName {
  const phases: readonly string[] = [
    "planning",
    "searching",
    "fetching",
    "extracting",
    "analyzing",
    "verifying",
    "synthesizing",
  ];
  return str(value) && phases.includes(value);
}

function isErrorInfo(value: unknown): value is ErrorInfo {
  return (
    isRecord(value) &&
    str(value.code) &&
    str(value.message) &&
    str(value.phase) &&
    typeof value.retryable === "boolean"
  );
}

function isReport(value: unknown): value is ResearchReport {
  return (
    isRecord(value) &&
    str(value.researchId) &&
    str(value.question) &&
    str(value.status) &&
    Array.isArray(value.sections) &&
    Array.isArray(value.claims) &&
    Array.isArray(value.citations)
  );
}

/** Guard di runtime per ogni tipo evento (verifica i campi richiesti). */
const EVENT_CHECKS: Record<
  ProgressEventType,
  (value: JsonRecord) => boolean
> = {
  status: (v) => str(v.researchId) && str(v.ts) && isStatus(v.status),
  phase: (v) =>
    str(v.researchId) &&
    str(v.ts) &&
    isPhaseName(v.phase) &&
    (v.status === "started" || v.status === "ended" || v.status === "progress"),
  query: (v) =>
    str(v.researchId) &&
    str(v.ts) &&
    str(v.query) &&
    str(v.purpose) &&
    typeof v.index === "number" &&
    typeof v.total === "number",
  "result-found": (v) =>
    str(v.researchId) &&
    str(v.ts) &&
    str(v.url) &&
    str(v.title) &&
    str(v.domain) &&
    str(v.engine) &&
    (v.snippet === undefined || str(v.snippet)),
  "source-consulted": (v) =>
    str(v.researchId) &&
    str(v.ts) &&
    str(v.sourceId) &&
    str(v.url) &&
    v.status === "fetching",
  "source-fetched": (v) =>
    str(v.researchId) &&
    str(v.ts) &&
    str(v.sourceId) &&
    str(v.url) &&
    str(v.domain) &&
    (v.title === undefined || str(v.title)) &&
    str(v.status) &&
    (v.error === undefined || isErrorInfo(v.error)),
  evidence: (v) =>
    str(v.researchId) &&
    str(v.ts) &&
    str(v.evidenceId) &&
    str(v.sourceId) &&
    str(v.url) &&
    str(v.passagePreview),
  conflict: (v) =>
    str(v.researchId) &&
    str(v.ts) &&
    str(v.conflictId) &&
    str(v.topic) &&
    (v.severity === "possible" || v.severity === "confirmed"),
  limitation: (v) =>
    str(v.researchId) && str(v.ts) && str(v.note) && (v.code === undefined || str(v.code)),
  error: (v) =>
    str(v.researchId) && str(v.ts) && isErrorInfo(v.error) && str(v.phase),
  result: (v) =>
    str(v.researchId) &&
    str(v.ts) &&
    v.schemaVersion === 1 &&
    isReport(v.report),
  done: (v) => str(v.researchId) && str(v.ts) && isStatus(v.status),
};

const EVENT_TYPE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(EVENT_CHECKS),
);

/** Guard di runtime: true se `value` è un ProgressEvent ben formato. */
export function isProgressEvent(value: unknown): value is ProgressEvent {
  if (!isRecord(value) || !str(value.type)) return false;
  if (!EVENT_TYPE_NAMES.has(value.type)) return false;
  const check = EVENT_CHECKS[value.type as ProgressEventType];
  return check(value);
}

// --- Serializzazione NDJSON ---------------------------------------------------

/** Serializza un evento in una singola riga NDJSON (senza newline). */
export function serializeEvent(event: ProgressEvent): string {
  return JSON.stringify(event);
}

/**
 * Parsa una riga NDJSON in un ProgressEvent. Ritorna `null` su riga vuota,
 * JSON malformato o shape non valida (il chiamante logga il warn).
 */
export function parseEventLine(line: string): ProgressEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isProgressEvent(parsed) ? parsed : null;
}

/**
 * Nomi dei campi che non devono MAI comparire negli eventi (segretezza).
 * Utile per test e audit: nessun ProgressEvent può trasportare chiavi/token.
 */
export const FORBIDDEN_EVENT_FIELDS = [
  "authorization",
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "cookie",
] as const;

/** True se nessun campo dell'evento (ricorsivo) viola i limiti di segretezza. */
export function eventHasForbiddenFields(
  event: ProgressEvent,
  fields: readonly string[] = FORBIDDEN_EVENT_FIELDS,
): boolean {
  const forbidden = new Set<string>(fields.map((f) => f.toLowerCase()));
  const stack: unknown[] = [event];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    for (const key of Object.keys(current)) {
      const lowered = key.toLowerCase();
      if (forbidden.has(lowered)) return true;
      if (
        typeof current[key] === "object" &&
        current[key] !== null
      ) {
        stack.push(current[key]);
      }
    }
  }
  return false;
}

