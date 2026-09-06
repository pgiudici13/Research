// Pannello citazioni (Step 23): elenco numerato delle voci citate nel report,
// ciascuna riconducibile a fonte + passaggio. Nessun contenuto HTML: solo
// testo. Serve come target dello scroll quando si clicca una citazione [n].

"use client";

import { COPY } from "@/lib/ui-copy";
import type { Citation } from "@/lib/types";
import { safeHttpHref } from "./event-log";

export interface CitationsPanelProps {
  citations: readonly Citation[];
  activeCitationIndex?: number | null;
}

export function CitationsPanel({ citations, activeCitationIndex }: CitationsPanelProps) {
  if (citations.length === 0) return null;
  return (
    <section aria-label={COPY.report.citations}>
      <h3>{COPY.report.citations}</h3>
      <ol className="citations-list">
        {citations.map((citation) => {
          const active = citation.index === activeCitationIndex;
          const href = safeHttpHref(citation.url);
          return (
            <li
              key={citation.index}
              id={`cite-row-${citation.index}`}
              className={active ? "citation-active" : undefined}
            >
              <span className="citation-index">[{citation.index}]</span>
              <span className="citation-body">
                <span className="citation-passage">{citation.passage}</span>
                <span className="citation-meta muted">
                  {href !== null ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {citation.title || citation.url}
                    </a>
                  ) : (
                    citation.title || citation.url
                  )}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
