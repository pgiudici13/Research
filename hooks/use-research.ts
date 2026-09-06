// Client hook per avviare una ricerca e consumare lo stream NDJSON dell'API
// (Step 21). Import-safe client: nessun modulo server. Stato locale guidato da
// un reducer puro (testabile senza DOM). Il contenuto dello stream viene
// interpretato con parseEventLine (Step 20): mai testo grezzo verso la UI.

"use client";

import { useCallback, useReducer, useRef } from "react";
import { parseEventLine } from "@/research/progress/events";
import { COPY } from "@/lib/ui-copy";
import type { PhaseName, ProgressEvent, ResearchReport, ResearchStatus } from "@/lib/types";

export type UiMacro = "idle" | "running" | "done" | "error";

/** Stato UI di una ricerca. */
export interface ResearchUiState {
  macro: UiMacro;
  /** Ultimo status noto (fase corrente o terminale). */
  status: ResearchStatus | null;
  /** Eventi recenti (cap ESPRESSO, per log e indicatori). */
  events: ProgressEvent[];
  /** Report finale, quando l'evento `result` è arrivato. */
  report: ResearchReport | null;
  /** Chiave di testo per l'errore (COPY.errors[key]). */
  errorKey: string | null;
}

export type ResearchUiAction =
  | { type: "start" }
  | { type: "event"; event: ProgressEvent }
  | { type: "error"; key: string }
  | { type: "reset" };

export const EVENTS_CAP = 300;

/** Stato iniziale (funzione: mai condividere l'array tra istanze). */
export function initialState(): ResearchUiState {
  return { macro: "idle", status: null, events: [], report: null, errorKey: null };
}

/** Riduttore PURO dello stato UI (testabile senza DOM). */
export function researchReducer(
  state: ResearchUiState,
  action: ResearchUiAction,
): ResearchUiState {
  switch (action.type) {
    case "start":
      return { macro: "running", status: "planning", events: [], report: null, errorKey: null };
    case "error":
      return { ...state, macro: "error", errorKey: action.key };
    case "reset":
      return initialState();
    case "event": {
      const event = action.event;
      const events = [...state.events, event];
      if (events.length > EVENTS_CAP) events.splice(0, events.length - EVENTS_CAP);

      let { macro, status, report } = state;
      if (event.type === "status") status = event.status;
      if (event.type === "result") {
        report = event.report;
        status = event.report.status;
      }
      if (event.type === "done") {
        macro = "done";
        status = event.status;
      }
      return { macro, status, events, report, errorKey: state.errorKey };
    }
  }
}

/** Mappa il codice ErrorInfo a una chiave COPY.errors (mai body grezzo). */
export function errorKeyForCode(code: string | undefined): string {
  switch (code) {
    case "E_RATE_LIMIT":
    case "E_VALIDATION":
    case "E_INTERNAL":
      return code;
    default:
      return "generic";
  }
}

export function errorTextForKey(key: string | null): string {
  if (key === null) return COPY.errors.generic;
  const text = (COPY.errors as Record<string, string>)[key];
  return text ?? COPY.errors.generic;
}

/** Legge uno stream NDJSON e chiama `onEvent` per ogni riga valida. */
export async function readResearchStream(
  response: { body: ReadableStream<Uint8Array> | null },
  onEvent: (event: ProgressEvent) => void,
): Promise<void> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        const event = parseEventLine(line);
        if (event !== null) onEvent(event);
      }
    }
    const tail = decoder.decode();
    if (tail !== "") buffer += tail;
    for (const line of buffer.split("\n")) {
      if (line.trim() === "") continue;
      const event = parseEventLine(line);
      if (event !== null) onEvent(event);
    }
  } finally {
    reader.releaseLock();
  }
}

export interface ResearchStartInput {
  question: string;
  options?: { depth?: 1 | 2 | 3; freshness?: "any" | "recent" | "year" };
}

export interface UseResearch {
  state: ResearchUiState;
  /** Avvia una ricerca; ritorna un controller per l'annullamento. */
  start: (input: ResearchStartInput) => AbortController;
  cancel: () => void;
  reset: () => void;
}

/** Hook React che gestisce l'intero ciclo di una ricerca. */
export function useResearch(): UseResearch {
  const [state, dispatch] = useReducer(researchReducer, undefined, initialState);
  const controllerRef = useRef<AbortController | null>(null);

  const runStream = useCallback(
    async (input: ResearchStartInput, controller: AbortController): Promise<void> => {
      try {
        const response = await fetch("/api/research", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: input.question, options: input.options }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let code: string | undefined;
          try {
            const body = (await response.json()) as { error?: { code?: string } };
            code = body.error?.code;
          } catch {
            // body non JSON: errore generico
          }
          dispatch({ type: "error", key: errorKeyForCode(code) });
          return;
        }

        await readResearchStream(response, (event) =>
          dispatch({ type: "event", event }),
        );
      } catch {
        if (controller.signal.aborted) return; // annullamento: nessun errore
        dispatch({ type: "error", key: "network" });
      }
    },
    [],
  );

  const start = useCallback(
    (input: ResearchStartInput): AbortController => {
      const controller = new AbortController();
      controllerRef.current = controller;
      dispatch({ type: "start" });
      void runStream(input, controller);
      return controller;
    },
    [runStream],
  );

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    dispatch({ type: "reset" });
  }, []);

  return { state, start, cancel, reset };
}

// --- Derivazioni pure per gli indicatori (Step 22/23) -------------------------

export type PhaseUiStatus = "pending" | "active" | "done";

export interface PhaseUiState {
  phase: PhaseName;
  status: PhaseUiStatus;
}

/** Stato delle fasi derivato SOLO dagli eventi `phase` (in ordine canonico). */
export function derivePhaseStates(events: readonly ProgressEvent[]): PhaseUiState[] {
  const activePhase = new Map<PhaseName, boolean>();
  const donePhase = new Set<PhaseName>();
  for (const event of events) {
    if (event.type !== "phase") continue;
    if (event.status === "started") activePhase.set(event.phase, true);
    else if (event.status === "ended") {
      activePhase.set(event.phase, false);
      donePhase.add(event.phase);
    }
  }

  const phases: PhaseUiState[] = [];
  for (const { phase } of PHASE_ORDER) {
    let status: PhaseUiStatus = "pending";
    if (donePhase.has(phase)) status = "done";
    else if (activePhase.get(phase) === true) status = "active";
    phases.push({ phase, status });
  }
  return phases;
}

const PHASE_ORDER: ReadonlyArray<{ phase: PhaseName }> = [
  { phase: "planning" },
  { phase: "searching" },
  { phase: "fetching" },
  { phase: "extracting" },
  { phase: "analyzing" },
  { phase: "verifying" },
  { phase: "synthesizing" },
];

export interface ResearchCounters {
  queries: number;
  resultsFound: number;
  sourcesFetched: number;
  sourcesFailed: number;
  evidences: number;
  conflicts: number;
  limitations: number;
}

/** Contatori essenziali derivati dagli eventi (puri). */
export function deriveCounters(events: readonly ProgressEvent[]): ResearchCounters {
  const counters: ResearchCounters = {
    queries: 0,
    resultsFound: 0,
    sourcesFetched: 0,
    sourcesFailed: 0,
    evidences: 0,
    conflicts: 0,
    limitations: 0,
  };
  for (const event of events) {
    switch (event.type) {
      case "query":
        counters.queries += 1;
        break;
      case "result-found":
        counters.resultsFound += 1;
        break;
      case "source-fetched":
        if (event.status === "failed") counters.sourcesFailed += 1;
        else counters.sourcesFetched += 1;
        break;
      case "evidence":
        counters.evidences += 1;
        break;
      case "conflict":
        counters.conflicts += 1;
        break;
      case "limitation":
        counters.limitations += 1;
        break;
      default:
        break;
    }
  }
  return counters;
}
