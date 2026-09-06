// Pannello conflitti (Step 23): ogni conflitto mostra ENTRAMBE le posizioni
// (mai risolte né nascoste) con la nota temporale se presente.

"use client";

import { COPY } from "@/lib/ui-copy";
import type { Conflict } from "@/lib/types";

export interface ConflictsPanelProps {
  conflicts: readonly Conflict[];
}

export function ConflictsPanel({ conflicts }: ConflictsPanelProps) {
  if (conflicts.length === 0) return null;
  return (
    <section aria-label={COPY.report.conflicts}>
      <h3>{COPY.report.conflicts}</h3>
      <ul className="conflicts-list">
        {conflicts.map((conflict) => (
          <li key={conflict.id} className="conflict-item">
            <h4>
              {conflict.topic} <span className="muted">({conflict.severity})</span>
            </h4>
            {conflict.temporalNote !== undefined ? (
              <p className="muted">{conflict.temporalNote}</p>
            ) : null}
            <ul className="positions">
              {conflict.statements.map((statement) => (
                <li key={statement.evidenceId}>
                  <span className="muted">Fonte {statement.sourceId}:</span>{" "}
                  {statement.position}
                </li>
              ))}
            </ul>
            <p className="muted">Conflitto non risolto: entrambe le posizioni restano aperte.</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
