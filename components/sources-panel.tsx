// Pannello fonti (Step 23): distinzione chiara tra fonti USATE nelle
// citazioni e fonti CONSULTATE (incluse quelle fallite con motivo). Url come
// link solo dopo validazione http(s); ogni contenuto è testo React.

"use client";

import { COPY } from "@/lib/ui-copy";
import type { SourceRecord } from "@/lib/types";
import { safeHttpHref } from "./event-log";

export interface SourcesPanelProps {
  sourceRecords: readonly SourceRecord[];
  /** sourceId usati in almeno una citazione (report.sourcesUsed). */
  usedSourceIds: readonly string[];
  activeSourceId?: string | null;
}

function SourceUrl({ url }: { url: string }) {
  const href = safeHttpHref(url);
  if (href === null) return <span className="muted">{url}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="source-url">
      {href}
    </a>
  );
}

function SourceItem({ record, active }: { record: SourceRecord; active: boolean }) {
  return (
    <li
      id={`src-row-${record.sourceId}`}
      className={`source-item ${active ? "source-active" : ""}`}
    >
      <strong>{record.title}</strong>
      <span className="source-domain muted">{record.domain}</span>
      <SourceUrl url={record.urlFinal} />
      {record.publishedDate !== undefined ? (
        <span className="muted">Pubblicato: {record.publishedDate}</span>
      ) : null}
      {record.status === "failed" && record.failure !== undefined ? (
        <span className="source-failure">{record.failure.code}</span>
      ) : null}
      {record.status !== "fetched" && record.status !== "failed" ? (
        <span className="muted">Stato: {record.status}</span>
      ) : null}
    </li>
  );
}

export function SourcesPanel({ sourceRecords, usedSourceIds, activeSourceId }: SourcesPanelProps) {
  const usedSet = new Set(usedSourceIds);
  const used = sourceRecords.filter((r) => usedSet.has(r.sourceId));
  const consulted = sourceRecords;

  return (
    <div className="sources-panel">
      <section aria-label={COPY.report.sourcesUsed}>
        <h3>{COPY.report.sourcesUsed}</h3>
        {used.length === 0 ? (
          <p className="muted">—</p>
        ) : (
          <ul>
            {used.map((record) => (
              <SourceItem
                key={record.sourceId}
                record={record}
                active={record.sourceId === activeSourceId}
              />
            ))}
          </ul>
        )}
      </section>
      <section aria-label={COPY.report.sourcesConsulted}>
        <h3>{COPY.report.sourcesConsulted}</h3>
        {consulted.length === 0 ? (
          <p className="muted">—</p>
        ) : (
          <ul>
            {consulted.map((record) => (
              <SourceItem
                key={record.sourceId}
                record={record}
                active={record.sourceId === activeSourceId}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
