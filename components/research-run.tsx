// Contenitore della ricerca (Step 22-23): form, area di stato accessibile,
// progresso LIVE (phase-indicator + event-log + contatori) e, a fine stream,
// la vista completa del report con citazioni cliccabili.

"use client";

import { useCallback, useMemo } from "react";
import { COPY, STATUS_LABELS } from "@/lib/ui-copy";
import {
  deriveCounters,
  derivePhaseStates,
  errorTextForKey,
  useResearch,
  type ResearchStartInput,
} from "@/hooks/use-research";
import { ResearchForm } from "./research-form";
import { PhaseIndicator } from "./phase-indicator";
import { EventLog } from "./event-log";
import { ReportView } from "./report-view";

export function ResearchRun() {
  const { state, start, cancel, reset } = useResearch();

  const handleSubmit = useCallback(
    (input: ResearchStartInput) => {
      start(input);
    },
    [start],
  );

  const running = state.macro === "running";
  const phases = useMemo(() => derivePhaseStates(state.events), [state.events]);
  const counters = useMemo(() => deriveCounters(state.events), [state.events]);

  const statusText =
    state.macro === "error"
      ? errorTextForKey(state.errorKey)
      : state.status !== null
        ? STATUS_LABELS[state.status] ?? COPY.status.running
        : COPY.status.idle;

  return (
    <section className="research-run" aria-label="Ricerca Deep Research">
      <ResearchForm
        disabled={running}
        onSubmit={handleSubmit}
        onCancel={cancel}
      />

      {/* Area di stato (accessibile) */}
      <div
        className={`status-area status-${state.macro}`}
        role="status"
        aria-live="polite"
      >
        {running ? <span className="spinner" aria-hidden="true" /> : null}
        <p className="status-text">{statusText}</p>
        {state.macro === "done" && state.status === "cancelled" ? (
          <p>{COPY.status.cancelled}</p>
        ) : null}
      </div>

      {running ? (
        <div className="live-progress" aria-label="Progresso della ricerca">
          <PhaseIndicator phases={phases} />
          <p className="counters muted">
            Query {counters.queries} · Fonti trovate {counters.resultsFound} · Analizzate{" "}
            {counters.sourcesFetched} · Fallite {counters.sourcesFailed} · Evidenze{" "}
            {counters.evidences} · Conflitti {counters.conflicts}
          </p>
          <EventLog events={state.events} />
        </div>
      ) : null}

      {state.macro === "done" && state.report !== null ? (
        <ReportView report={state.report} />
      ) : null}
      {state.macro === "done" && state.report === null ? (
        <p className="muted">{COPY.status.reportSoon}</p>
      ) : null}

      {state.macro === "error" ? (
        <div className="error-box" role="alert">
          <p>{errorTextForKey(state.errorKey)}</p>
          <button type="button" className="btn" onClick={reset}>
            Riprova
          </button>
        </div>
      ) : null}
    </section>
  );
}
