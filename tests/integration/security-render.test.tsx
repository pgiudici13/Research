// @vitest-environment jsdom
// Regressione sanitizzazione (Step 24): qualunque stringa di origine web/LLM
// contenente HTML ostile esce come SOLO-TESTO quando renderizzata da React.
// Nessun <img onerror>/<script> diventa un elemento reale né esegue codice.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ResearchReport } from "@/lib/types";
import { ReportView } from "@/components/report-view";

afterEach(() => {
  cleanup();
  // @ts-expect-error jsdom non implementa scrollIntoView
  delete window.HTMLElement.prototype.scrollIntoView;
});

const HOSTILE_IMG = `<img src=x onerror="window.__pwned='img'">`;
const HOSTILE_SCRIPT = `<script>window.__pwned='script'<\/script>`;
const TS = "2026-01-02T10:00:00.000Z";

function hostileReport(): ResearchReport {
  const payload = `${HOSTILE_IMG} ${HOSTILE_SCRIPT}`;
  return {
    researchId: "res-hostile000001",
    question: payload,
    status: "completed",
    sections: [
      {
        heading: "Risposta",
        paragraphs: [{ text: payload, kind: "fact", citations: [] }],
      },
    ],
    claims: [
      { id: "claim-1", text: payload, kind: "fact", supportEvidenceIds: [] },
    ],
    conflicts: [],
    citations: [
      {
        index: 1,
        evidenceId: "src-a:p0",
        sourceId: "src-a",
        url: "https://archivio.example/pagina",
        title: "Fonte",
        passage: payload,
      },
    ],
    sourcesConsulted: [
      {
        sourceId: "src-a",
        urlFinal: "https://archivio.example/pagina",
        canonicalUrl: "https://archivio.example/pagina",
        domain: "archivio.example",
        title: "Fonte",
        status: "fetched",
        fetchedAt: TS,
      },
    ],
    sourcesUsed: ["src-a"],
    limitations: {
      missingSources: false,
      llmUnavailable: false,
      searchUnavailable: false,
      budgetExceeded: false,
      timeBudgetExceeded: false,
      notes: [],
    },
    budgetUsed: {
      queriesUsed: 1,
      sourcesAnalyzed: 1,
      depthUsed: 1,
      llmCalls: 0,
      fetchAttempts: 1,
      fetchFailed: 0,
    },
    startedAt: TS,
    completedAt: TS,
    durationMs: 500,
  };
}

describe("sanitizzazione output (payload ostile renderizzato come testo)", () => {
  it("il payload <img onerror>/<script> resta testo: nessun elemento reale né esecuzione", () => {
    const before = (window as unknown as { __pwned?: string }).__pwned;
    expect(before).toBeUndefined();

    render(<ReportView report={hostileReport()} />);

    // nessun nodo img/script creato dal testo ostile
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(document.querySelectorAll("script").length).toBe(0);
    // il payload è visibile come testo letterale (mai eseguito)
    expect(screen.getAllByText(/<img src=x onerror=/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/<script>/).length).toBeGreaterThan(0);
    // nessun attributo onerror attivo né esecuzione
    expect(document.querySelector("[onerror]")).toBeNull();
    expect((window as unknown as { __pwned?: string }).__pwned).toBeUndefined();
  });
});
