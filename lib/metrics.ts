// Metriche per-run della ricerca (Step 28). Raccolte dal motore durante
// l'esecuzione e loggate in `research.finished` (aggregato NON sensibile:
// solo conteggi e durate, mai prompt/contenuti/passaggi). Il report finale
// continua a esporre `BudgetUsage`; queste metriche servono per il debug
// operativo (fasi lente, Pi giù, budget mal impostati) senza segreti.

/** Durate aggregate per fase (ms). Chiave = nome fase wire (progress.ts). */
export type PhaseDurations = Record<string, number>;

export interface ResearchMetrics {
  /** Round di ricerca effettivamente eseguiti. */
  rounds: number;
  /** Query consumate dal budget. */
  queries: number;
  /** Risultati trovati (prima della dedup). */
  resultsFound: number;
  /** Fonti registrate come consultate (qualsiasi esito). */
  sourcesConsulted: number;
  /** Fonti analizzate con successo (status fetched). */
  sourcesFetched: number;
  /** Fonti fallite (status failed, con codice). */
  sourcesFailed: number;
  /** Evidenze conservate alla fine. */
  evidences: number;
  /** Conflitti nel report. */
  conflicts: number;
  /** Chiamate LLM consumate dal budget. */
  llmCalls: number;
  /** Fasi LLM che sono degenerate su fallback/errore (plan o sintesi). */
  llmFailures: number;
  /** Query andate in errore. */
  searchErrors: number;
  /** Fetch falliti. */
  fetchErrors: number;
  /** Byte scaricati dalle pagine analizzate. */
  bytesFetched: number;
  /** True se il piano è stato generato senza LLM (fallback). */
  planFallback: boolean;
  /** Durate aggregate per fase (ms). */
  phases: PhaseDurations;
}

/** Metriche a zero: i punti di raccolta fanno override dei campi noti. */
export function emptyMetrics(): ResearchMetrics {
  return {
    rounds: 0,
    queries: 0,
    resultsFound: 0,
    sourcesConsulted: 0,
    sourcesFetched: 0,
    sourcesFailed: 0,
    evidences: 0,
    conflicts: 0,
    llmCalls: 0,
    llmFailures: 0,
    searchErrors: 0,
    fetchErrors: 0,
    bytesFetched: 0,
    planFallback: false,
    phases: {},
  };
}
