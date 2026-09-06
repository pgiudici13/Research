// Log live degli eventi salienti (Step 23): query, fonti trovate/analizzate,
// evidenze, conflitti e limitazioni. Contenuto renderizzato SOLO come testo
// React (mai HTML); gli url diventano link solo se http(s) validati.

"use client";

import type { ProgressEvent } from "@/lib/types";
import { COPY } from "@/lib/ui-copy";

export interface EventLogProps {
  events: ProgressEvent[];
  /** Numero massimo di righe mostrate (le più recenti). */
  max?: number;
}

/** Ritorna un href sicuro (http/https) o null. */
export function safeHttpHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function SourceLink({ url }: { url: string }) {
  const href = safeHttpHref(url);
  if (href === null) return <span>{url}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {href}
    </a>
  );
}

/** Traduce un evento in una riga testuale del log (senza contenuti integrali). */
function describeEvent(event: ProgressEvent): string | null {
  switch (event.type) {
    case "query":
      return `${COPY.report.queryLabel}: ${event.query}`;
    case "result-found":
      return `${COPY.report.found}: ${event.title || event.domain} — ${event.domain}`;
    case "source-fetched":
      if (event.status === "failed") {
        return `${COPY.report.failedSource}: ${event.domain}`;
      }
      if (event.status === "unsupported" || event.status === "too-large") {
        return `${COPY.report.unsupportedSource}: ${event.domain}`;
      }
      return `${COPY.report.fetched}: ${event.title || event.domain}`;
    case "evidence":
      return `${COPY.report.evidenceFound} in ${event.url}`;
    case "conflict":
      return `${COPY.report.conflicts}: ${event.topic} (${event.severity})`;
    case "limitation":
      return `${COPY.report.limitations}: ${event.note}`;
    default:
      return null; // status/phase/result/done non appaiono nel log
  }
}

export function EventLog({ events, max = 40 }: EventLogProps) {
  const visible = events.slice(-max);
  return (
    <ul className="event-log" role="log" aria-live="polite" aria-label={COPY.report.events}>
      {visible.map((event, i) => {
        const text = describeEvent(event);
        if (text === null) return null;
        const key = `${event.type}-${i}`;
        if (event.type === "result-found" || event.type === "evidence") {
          return (
            <li key={key} className="event-line">
              <span>{text}</span> <SourceLink url={event.url} />
            </li>
          );
        }
        return (
          <li key={key} className="event-line">
            {text}
          </li>
        );
      })}
    </ul>
  );
}
