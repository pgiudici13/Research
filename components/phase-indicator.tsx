// Indicatore a fasi (Step 23): stepper dei 7 passi della pipeline con stato
// pending/active/done derivato SOLO dagli eventi `phase` (derivePhaseStates).

"use client";

import { PHASE_LABELS } from "@/lib/ui-copy";
import type { PhaseUiState } from "@/hooks/use-research";
import { COPY } from "@/lib/ui-copy";

export interface PhaseIndicatorProps {
  phases: PhaseUiState[];
}

export function PhaseIndicator({ phases }: PhaseIndicatorProps) {
  return (
    <ol className="phase-indicator" aria-label={COPY.report.statusPhaseLabel}>
      {PHASE_LABELS.map(({ phase, label }) => {
        const state = phases.find((p) => p.phase === phase);
        const status = state?.status ?? "pending";
        return (
          <li
            key={phase}
            className={`phase-step phase-${status}`}
            aria-current={status === "active" ? "step" : undefined}
          >
            <span className="phase-dot" aria-hidden="true" />
            <span className="phase-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
