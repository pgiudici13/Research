// Tipi di dominio condivisi (puri: nessun import runtime, nessun process.env).
// Importabili sia dal server sia dal client. Nomi stabili: gli step successivi
// di STEP.md referenziano ESATTAMENTE questi tipi.

// --- Stati di ricerca e fasi ---------------------------------------------
// Nota: definiti qui (dominio) e ri-esportati da progress.ts per evitare
// import circolari con ResearchReport.

export type ResearchStatus =
  | "planning"
  | "searching"
  | "fetching"
  | "analyzing"
  | "verifying"
  | "synthesizing"
  | "completed"
  | "failed"
  | "cancelled"
  | "partial";

export type PhaseName =
  | "planning"
  | "searching"
  | "fetching"
  | "extracting"
  | "analyzing"
  | "verifying"
  | "synthesizing";

/** Stati di ricerca "in corso" (transitori). */
export const IN_PROGRESS_STATUSES: readonly ResearchStatus[] = [
  "planning",
  "searching",
  "fetching",
  "analyzing",
  "verifying",
  "synthesizing",
];

/** Stati di ricerca terminali. */
export const TERMINAL_STATUSES: readonly ResearchStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "partial",
];

// --- Richiesta utente ------------------------------------------------------

export type Freshness = "any" | "recent" | "year";

export interface ResearchOptions {
  depth?: 1 | 2 | 3;
  maxSources?: number;
  freshness?: Freshness;
  lang?: string;
}

export interface ResearchRequest {
  question: string;
  options?: ResearchOptions;
  clientRequestId?: string;
}

// --- Piano di ricerca ------------------------------------------------------

export type QueryPurpose =
  | "sub-question"
  | "synonym"
  | "primary-source"
  | "recent"
  | "counter-argument"
  | "follow-up";

export type SubQuestionImportance = "critical" | "supporting";

export interface SubQuestion {
  id: string;
  text: string;
  importance: SubQuestionImportance;
}

export interface PlannedQuery {
  query: string;
  purpose: QueryPurpose;
  subQuestionId?: string;
  priority: number;
}

export interface ResearchConstraints {
  lang: string;
  freshness: string;
}

export interface ResearchPlan {
  objective: string;
  subQuestions: SubQuestion[];
  queries: PlannedQuery[];
  constraints: ResearchConstraints;
  ambiguities: string[];
  /** Origine del piano: LLM o fallback deterministico (Step 13). */
  source?: "llm" | "fallback";
}

// --- Risultati di ricerca e fonti ------------------------------------------

/** Risultato normalizzato di una query SearXNG (Step 8/9). */
export interface SearchResultItem {
  url: string;
  title: string;
  snippet: string;
  engine: string;
  publishedDate?: string;
}

/** Candidato fonte dopo deduplicazione e prima del fetch (Step 9/12). */
export interface SourceCandidate {
  sourceId: string;
  url: string;
  canonicalUrl: string;
  dedupeKey: string;
  domain: string;
  title: string;
  snippet: string;
  engines: string[];
  occurrences: number;
  /** Data pubblicazione dichiarata dal motore (Step 12: segnale di freschezza). */
  publishedDate?: string;
  rankScore?: number;
}

export type SourceStatus =
  | "fetched"
  | "failed"
  | "skipped"
  | "unsupported"
  | "too-large";

/** Fonte effettivamente analizzata (distinta dal risultato di ricerca). */
export interface SourceRecord {
  sourceId: string;
  urlFinal: string;
  canonicalUrl: string;
  domain: string;
  title: string;
  author?: string;
  publishedDate?: string;
  lang?: string;
  status: SourceStatus;
  failure?: ErrorInfo;
  fetchedAt: string;
}

/** Pagina scaricata ed estratta in testo leggibile (Step 11). */
export interface ExtractedPage {
  sourceId: string;
  url: string;
  domain: string;
  title: string;
  author?: string;
  publishedDate?: string;
  lang?: string;
  text: string;
  truncated: boolean;
  extractedAt: string;
}

// --- Evidenze, claim, conflitti ---------------------------------------------

export type EvidenceConfidence = "high" | "medium" | "low";

export interface Evidence {
  id: string;
  sourceId: string;
  url: string;
  passage: string;
  passageIndex: number;
  retrievedAt: string;
  confidence: EvidenceConfidence;
  /** Sotto-domanda a cui il passaggio risponde meglio (Step 14, se nota). */
  subQuestionId?: string;
  queryIds?: string[];
  relevance?: number;
}

export type ClaimKind = "fact" | "inference" | "uncertain";

export interface Claim {
  id: string;
  text: string;
  kind: ClaimKind;
  supportEvidenceIds: string[];
  conflictOfEvidenceIds?: string[];
}

export type ConflictSeverity = "possible" | "confirmed";

export interface ConflictStatement {
  evidenceId: string;
  position: string;
  sourceId: string;
}

export interface Conflict {
  id: string;
  topic: string;
  statements: ConflictStatement[];
  temporalNote?: string;
  severity: ConflictSeverity;
}

// --- Report finale e citazioni ----------------------------------------------

export interface Citation {
  index: number;
  evidenceId: string;
  sourceId: string;
  url: string;
  title: string;
  passage: string;
}

export interface ReportParagraph {
  text: string;
  citations: number[];
  kind?: ClaimKind;
}

export interface ReportSection {
  heading: string;
  paragraphs: ReportParagraph[];
}

export interface ResearchLimitations {
  missingSources: boolean;
  llmUnavailable: boolean;
  searchUnavailable: boolean;
  budgetExceeded: boolean;
  timeBudgetExceeded: boolean;
  notes: string[];
}

export interface BudgetUsage {
  queriesUsed: number;
  sourcesAnalyzed: number;
  depthUsed: number;
  llmCalls: number;
  fetchAttempts: number;
  fetchFailed: number;
}

export interface ResearchReport {
  researchId: string;
  question: string;
  status: ResearchStatus;
  sections: ReportSection[];
  claims: Claim[];
  conflicts: Conflict[];
  citations: Citation[];
  sourcesConsulted: SourceRecord[];
  sourcesUsed: string[];
  limitations: ResearchLimitations;
  budgetUsed: BudgetUsage;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

// --- Errori (envelope safe per il client) ------------------------------------

/** Errore normalizzato: mai stack trace, mai messaggi grezzi non in catalogo. */
export interface ErrorInfo {
  code: string;
  message: string;
  phase: string;
  retryable: boolean;
}
