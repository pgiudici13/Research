// Contratti dell'API pubblica (solo dati, import-safe client/server).

import type { ErrorInfo } from "./research";

export type { ResearchRequest } from "./research";

/** Versione dello schema del body di risposta `result`. */
export const API_SCHEMA_VERSION = 1 as const;

export interface ApiErrorBody {
  error: ErrorInfo;
  requestId: string;
}

/** Evento `result` versionato (vedi ResultEvent in progress.ts). */
export interface VersionedResult {
  schemaVersion: typeof API_SCHEMA_VERSION;
}
