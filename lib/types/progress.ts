// Tipi di progresso e stato (solo dati, import-safe client/server).
// Importabili dal browser: nessun runtime server, nessun process.env.
// La serializzazione NDJSON e gli eventi completi sono definiti nello Step 20;
// qui vive il modello di dati che client e backend condividono.

import type {
  ConflictSeverity,
  ErrorInfo,
  PhaseName,
  ResearchReport,
  ResearchStatus,
  SourceStatus,
} from "./research";

export type { PhaseName, ResearchStatus } from "./research";

export type PhaseEventStatus = "started" | "progress" | "ended";

// --- Eventi ----------------------------------------------------------------

/** Cambio di stato macchina della ricerca. */
export interface StatusEvent {
  type: "status";
  researchId: string;
  ts: string;
  status: ResearchStatus;
}

/** Inizio/fine/avanzamento di una fase della pipeline. */
export interface PhaseEvent {
  type: "phase";
  researchId: string;
  ts: string;
  phase: PhaseName;
  status: PhaseEventStatus;
}

/** Query di ricerca eseguita. */
export interface QueryEvent {
  type: "query";
  researchId: string;
  ts: string;
  query: string;
  purpose: string;
  index: number;
  total: number;
}

/** Nuovo risultato di ricerca trovato (non ancora analizzato). */
export interface ResultFoundEvent {
  type: "result-found";
  researchId: string;
  ts: string;
  url: string;
  title: string;
  domain: string;
  engine: string;
  snippet?: string;
}

/** Una fonte candidata entra in fetch. */
export interface SourceConsultedEvent {
  type: "source-consulted";
  researchId: string;
  ts: string;
  sourceId: string;
  url: string;
  status: "fetching";
}

/** Esito del fetch/analisi di una fonte. */
export interface SourceFetchedEvent {
  type: "source-fetched";
  researchId: string;
  ts: string;
  sourceId: string;
  url: string;
  domain: string;
  title?: string;
  status: Exclude<SourceStatus, "fetched"> | "fetched";
  error?: ErrorInfo;
}

/** Evidenza estratta (solo preview, mai il passaggio integrale). */
export interface EvidenceEvent {
  type: "evidence";
  researchId: string;
  ts: string;
  evidenceId: string;
  sourceId: string;
  url: string;
  passagePreview: string;
}

/** Conflitto rilevato tra fonti. */
export interface ConflictEvent {
  type: "conflict";
  researchId: string;
  ts: string;
  conflictId: string;
  topic: string;
  severity: ConflictSeverity;
}

/** Limitazione della ricerca (es. modalità degradata). */
export interface LimitationEvent {
  type: "limitation";
  researchId: string;
  ts: string;
  note: string;
  code?: string;
}

/** Errore non terminale avvenuto durante la ricerca. */
export interface ErrorEvent {
  type: "error";
  researchId: string;
  ts: string;
  error: ErrorInfo;
  phase: string;
}

/** Report finale completo (unico evento con il report). */
export interface ResultEvent {
  type: "result";
  researchId: string;
  ts: string;
  schemaVersion: 1;
  report: ResearchReport;
}

/** Termine dello stream. */
export interface DoneEvent {
  type: "done";
  researchId: string;
  ts: string;
  status: ResearchStatus;
}

export type ProgressEvent =
  | StatusEvent
  | PhaseEvent
  | QueryEvent
  | ResultFoundEvent
  | SourceConsultedEvent
  | SourceFetchedEvent
  | EvidenceEvent
  | ConflictEvent
  | LimitationEvent
  | ErrorEvent
  | ResultEvent
  | DoneEvent;

export type ProgressEventType = ProgressEvent["type"];

/** Ordine stabile dei tipi evento (utile per test e log). */
export const PROGRESS_EVENT_TYPES: readonly ProgressEventType[] = [
  "status",
  "phase",
  "query",
  "result-found",
  "source-consulted",
  "source-fetched",
  "evidence",
  "conflict",
  "limitation",
  "error",
  "result",
  "done",
];
