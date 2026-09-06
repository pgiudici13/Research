// Vista del report finale (Step 23): header con stato macro, sezioni con
// paragrafi e citazioni [n] cliccabili, pannelli conflitti/limiti/fonti/
// citazioni. Rendering SOLO-testo (mai HTML non attendibile).

"use client";

import { useEffect, useState } from "react";
import { COPY, STATUS_LABELS } from "@/lib/ui-copy";
import type { ClaimKind, ResearchReport } from "@/lib/types";
import { CitationsPanel } from "./citations-panel";
import { ConflictsPanel } from "./conflicts-panel";
import { SourcesPanel } from "./sources-panel";

export interface ReportViewProps {
  report: ResearchReport;
}

const KIND_LABELS: Record<ClaimKind, string> = {
  fact: COPY.report.kindFact,
  inference: COPY.report.kindInference,
  uncertain: COPY.report.kindUncertain,
};

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} min ${seconds} s`;
}

function formatIso(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("it-IT", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function limitationLines(report: ResearchReport): string[] {
  const lines: string[] = [];
  const limits = report.limitations;
  if (limits.llmUnavailable) lines.push("Sintesi generata senza LLM (modalità degradata).");
  if (limits.searchUnavailable) lines.push("Servizio di ricerca non raggiungibile per parte della ricerca.");
  if (limits.missingSources) lines.push("Evidenze insufficienti per alcune sotto-domande.");
  if (limits.budgetExceeded) lines.push("Budget di ricerca esaurito prima della copertura completa.");
  if (limits.timeBudgetExceeded) lines.push("Tempo massimo di ricerca raggiunto: risultato parziale.");
  lines.push(...limits.notes);
  return lines;
}

function KindBadge({ kind }: { kind: ClaimKind }) {
  return (
    <span className={`kind-badge kind-${kind}`} title={KIND_LABELS[kind]}>
      {KIND_LABELS[kind]}
    </span>
  );
}

export function ReportView({ report }: ReportViewProps) {
  const [activeCitation, setActiveCitation] = useState<number | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);

  // dopo un clic su [n]: scroll al target (citazione e fonte) — solo client
  useEffect(() => {
    if (activeCitation === null) return;
    const row = document.getElementById(`cite-row-${activeCitation}`);
    row?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (activeSource !== null) {
      const source = document.getElementById(`src-row-${activeSource}`);
      source?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeCitation, activeSource]);

  const openCitation = (index: number, sourceId: string): void => {
    setActiveCitation(index);
    setActiveSource(sourceId);
  };

  const usedSourceIds = report.sourcesUsed;
  const statusLabel = STATUS_LABELS[report.status] ?? report.status;
  const limitations = limitationLines(report);
  const paragraphCount = report.sections.reduce(
    (n, s) => n + s.paragraphs.length,
    0,
  );

  return (
    <article className="report-view">
      <header className="report-header">
        <div className="report-title-row">
          <h2>{report.question}</h2>
          <span className={`status-badge status-${report.status}`}>{statusLabel}</span>
        </div>
        <dl className="report-meta">
          <div>
            <dt>{COPY.report.durationLabel}</dt>
            <dd>{formatDuration(report.durationMs)}</dd>
          </div>
          <div>
            <dt>{COPY.report.generatedAt}</dt>
            <dd>{formatIso(report.completedAt)}</dd>
          </div>
          <div title={report.researchId}>
            <dt>{COPY.report.researchIdLabel}</dt>
            <dd className="research-id">{report.researchId.slice(0, 12)}…</dd>
          </div>
        </dl>

        {report.status === "partial" ? (
          <p className="banner banner-partial" role="status">
            {COPY.report.partialBanner}
          </p>
        ) : null}
        {report.status === "failed" ? (
          <p className="banner banner-failed" role="alert">
            {COPY.report.failedBanner}
          </p>
        ) : null}
        {report.status === "cancelled" ? (
          <p className="banner banner-cancelled" role="status">
            {COPY.report.cancelledBanner}
          </p>
        ) : null}
      </header>

      <p className="kind-legend muted" aria-label={COPY.report.kindLegend}>
        {COPY.report.kindLegend}
      </p>

      {report.sections.length === 0 ? (
        <p className="muted">{COPY.status.reportSoon}</p>
      ) : (
        report.sections.map((section, sectionIndex) => (
          <section key={`${section.heading}-${sectionIndex}`} className="report-section">
            <h3>{section.heading}</h3>
            {section.paragraphs.length === 0 ? (
              <p className="muted">—</p>
            ) : (
              section.paragraphs.map((paragraph, paragraphIndex) => (
                <p key={paragraphIndex} className="report-paragraph">
                  {paragraph.kind !== undefined ? (
                    <KindBadge kind={paragraph.kind} />
                  ) : null}
                  <span className="paragraph-text">{paragraph.text}</span>
                  {paragraph.citations.length > 0 ? (
                    <span className="citations-inline">
                      {paragraph.citations.map((index) => (
                        <button
                          key={index}
                          type="button"
                          className="citation-link"
                          aria-label={`Apri la citazione ${index}`}
                          onClick={() => openCitation(index, report.citations.find((c) => c.index === index)?.sourceId ?? "")}
                        >
                          [{index}]
                        </button>
                      ))}
                    </span>
                  ) : null}
                </p>
              ))
            )}
          </section>
        ))
      )}

      <ConflictsPanel conflicts={report.conflicts} />

      {limitations.length > 0 ? (
        <section aria-label={COPY.report.limitations}>
          <h3>{COPY.report.limitations}</h3>
          <ul className="limitations-list">
            {limitations.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <SourcesPanel
        sourceRecords={report.sourcesConsulted}
        usedSourceIds={usedSourceIds}
        activeSourceId={activeSource}
      />

      <CitationsPanel citations={report.citations} activeCitationIndex={activeCitation} />

      <footer className="report-footer muted">
        {COPY.report.generatedAt} {formatIso(report.completedAt)} · {paragraphCount} paragrafi · {report.citations.length} citazioni.
        <br />
        {COPY.report.disclaimer}
      </footer>
    </article>
  );
}
