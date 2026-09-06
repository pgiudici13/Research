// Contenitore della ricerca (Step 22): form + area di stato accessibile
// (role="status", aria-live). La vista completa di progresso/report (fasi,
// log eventi, report citato) arriva con lo Step 23, che estenderà questo
// componente con phase-indicator/event-log/report-view.

"use client";

import { useCallback } from "react";
import { COPY, STATUS_LABELS } from "@/lib/ui-copy";
import { errorTextForKey, useResearch } from "@/hooks/use-research";
import { ResearchForm } from "./research-form";

export function ResearchRun() {
  const { state, start, cancel, reset } = useResearch();

  const handleSubmit = useCallback(
    (input: { question: string; options?: { depth?: 1 | 2 | 3; freshness?: "any" | "recent" | "year" } }) => {
      start(input);
    },
    [start],
  );

  const running = state.macro === "running";
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
        {state.macro === "done" && state.report === null ? (
          <p>{COPY.status.reportSoon}</p>
        ) : null}
      </div>

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
