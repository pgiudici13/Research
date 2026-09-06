// Testi UI in italiano (solo dati, import-safe client/server; nessuna logica
// sensibile, nessun dettaglio infrastrutturale o segreto).

import type { ErrorCode } from "@/lib/errors";
import type { PhaseName, ResearchStatus } from "@/lib/types";

/**
 * Testo utente per OGNI codice della tassonomia C.4 (mai messaggi grezzi o
 * dettagli infrastrutturali). Test di completezza: ogni ErrorCode ha una voce.
 */
export const ERROR_COPY: Record<ErrorCode, string> = {
  E_VALIDATION: "Richiesta non valida: controlla la domanda.",
  E_RATE_LIMIT: "Troppe richieste: attendi un po' e riprova.",
  E_BUDGET_EXCEEDED: "Budget di ricerca esaurito: la ricerca si è fermata prima del previsto.",
  E_CANCELLED: "Ricerca annullata dall'utente.",
  E_LLM_UNAVAILABLE: "Servizio di sintesi non disponibile: risultato in modalità degradata.",
  E_LLM_TIMEOUT: "Il servizio di sintesi ha impiegato troppo tempo.",
  E_LLM_INVALID_RESPONSE: "Risposta del servizio di sintesi non valida: usata la modalità degradata.",
  E_SEARCH_UNAVAILABLE: "Servizio di ricerca non raggiungibile.",
  E_SEARCH_TIMEOUT: "Il servizio di ricerca ha impiegato troppo tempo.",
  E_SEARCH_EMPTY: "Nessun risultato trovato per questa ricerca.",
  E_FETCH_FAILED: "Alcune pagine non sono risultate raggiungibili.",
  E_FETCH_TOO_LARGE: "Alcune pagine erano troppo grandi e sono state saltate.",
  E_FETCH_UNSUPPORTED: "Alcune pagine avevano un formato non supportato.",
  E_SSRF_BLOCKED: "Alcune destinazioni non erano consentite.",
  E_TIMEOUT_RESEARCH: "Tempo massimo di ricerca raggiunto: risultato parziale.",
  E_INTERNAL: "Errore interno del servizio. Riprova più tardi.",
};

export const COPY = {
  appTitle: "Deep Research",
  appSubtitle: "Trasforma una domanda in una risposta verificata e citata.",
  form: {
    questionLabel: "La tua domanda di ricerca",
    questionPlaceholder: "Es. In quale anno fu fondata l'Università di Pisa e da chi?",
    depthLabel: "Profondità",
    depthOption: (n: number, label: string) => `${n} — ${label}`,
    depthLabels: ["veloce", "equilibrata", "approfondita"],
    freshnessLabel: "Freschezza dei dati",
    freshnessAny: "Qualsiasi epoca",
    freshnessRecent: "Dati recenti",
    freshnessYear: "Ultimo anno",
    start: "Avvia ricerca",
    cancel: "Annulla",
    questionTooShort: "La domanda deve avere almeno 10 caratteri.",
    questionTooLong: "La domanda supera i 1000 caratteri.",
    charsLeft: (n: number) => `${n} caratteri rimasti`,
    requiredHint: "Richiesto",
  } as const,
  status: {
    idle: "Pronto. Scrivi una domanda per iniziare.",
    running: "Ricerca in corso…",
    cancelled: "Ricerca annullata.",
    completed: "Ricerca completata.",
    partial: "Ricerca completata con limitazioni.",
    failed: "La ricerca non ha prodotto risultati utilizzabili.",
    error: "Si è verificato un errore.",
    liveRegion: (status: string) => `Stato: ${status}`,
    reportSoon: "Il report dettagliato arriva con lo Step 23.",
  } as const,
  errors: {
    network: "Errore di rete: impossibile raggiungere il servizio. Riprova.",
    generic: "Si è verificato un errore inatteso. Riprova.",
    ...ERROR_COPY,
  },
  report: {
    sections: "Sezioni",
    conflicts: "Conflitti tra fonti",
    limitations: "Limiti",
    sourcesUsed: "Fonti usate nelle citazioni",
    sourcesConsulted: "Fonti consultate",
    backToTop: "Torna all'inizio",
    citations: "Citazioni",
    kindLegend: "Legenda: fatto, inferenza, incerto",
    kindFact: "fatto",
    kindInference: "inferenza",
    kindUncertain: "incerto",
    generatedAt: "Generato il",
    disclaimer:
      "Verifica umana consigliata: questa risposta è generata da fonti web e può contenere errori.",
    researchIdLabel: "ID ricerca",
    durationLabel: "Durata",
    partialBanner: "Risultato parziale: la ricerca ha incontrato limitazioni (vedi sotto).",
    failedBanner: "La ricerca non ha prodotto risultati utilizzabili.",
    cancelledBanner: "Ricerca annullata: nessun report disponibile.",
    noCitations: "Nessuna citazione in questa sezione.",
    citePrefix: "Fonti per",
    events: "Eventi della ricerca",
    queryLabel: "Query",
    found: "Trovato",
    fetched: "Analizzata",
    failedSource: "Non raggiungibile",
    evidenceFound: "Evidenza",
    unsupportedSource: "Contenuto non supportato",
    statusPhaseLabel: "Fasi",
  } as const,
} as const;

/** Etichette testuali delle fasi (ordine canonico per lo stepper). */
export const PHASE_LABELS: ReadonlyArray<{ phase: PhaseName; label: string }> = [
  { phase: "planning", label: "Piano" },
  { phase: "searching", label: "Ricerca" },
  { phase: "fetching", label: "Scaricamento" },
  { phase: "extracting", label: "Estrazione" },
  { phase: "analyzing", label: "Analisi" },
  { phase: "verifying", label: "Verifica" },
  { phase: "synthesizing", label: "Sintesi" },
];

/** Etichette macro-stato (solo per uso UI, mai dati sensibili). */
export const STATUS_LABELS: Record<ResearchStatus, string> = {
  planning: "Pianificazione",
  searching: "Ricerca fonti",
  fetching: "Scaricamento fonti",
  analyzing: "Analisi",
  verifying: "Verifica",
  synthesizing: "Sintesi",
  completed: "Completata",
  partial: "Completata con limiti",
  failed: "Fallita",
  cancelled: "Annullata",
};
