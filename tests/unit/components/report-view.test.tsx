// @vitest-environment jsdom
// Test della vista report (Step 23): sezioni/paragrafi/kind, banner partial,
// limiti, fonti usate vs consultate, citazioni cliccabili che evidenziano la
// riga fonte, e nessun href non-http.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ResearchReport } from "@/lib/types";
import { ReportView } from "@/components/report-view";

afterEach(() => {
  cleanup();
  // @ts-expect-error jsdom non implementa scrollIntoView
  delete window.HTMLElement.prototype.scrollIntoView;
});

const TS = "2026-01-02T10:00:00.000Z";

function fixtureReport(): ResearchReport {
  return {
    researchId: "res-abc123def456",
    question: "In quale anno fu fondata l'Università di Pisa?",
    status: "partial",
    sections: [
      {
        heading: "Risposta",
        paragraphs: [
          {
            text: "L'ateneo fu fondato nel 1343 per iniziativa pontificia.",
            kind: "fact",
            citations: [1, 2],
          },
          {
            text: "Forse l'istituzione risale ad anni ancora precedenti.",
            kind: "inference",
            citations: [],
          },
        ],
      },
    ],
    claims: [
      {
        id: "claim-1",
        text: "L'ateneo fu fondato nel 1343.",
        kind: "fact",
        supportEvidenceIds: ["src-a:p0", "src-b:p0"],
      },
    ],
    conflicts: [],
    citations: [
      {
        index: 1,
        evidenceId: "src-a:p0",
        sourceId: "src-a",
        url: "https://archivio.example/1343",
        title: "Archivio A",
        passage: "Documento della fondazione del 1343.",
      },
      {
        index: 2,
        evidenceId: "src-b:p0",
        sourceId: "src-b",
        url: "javascript:alert(1)",
        title: "Fonte maliziosa",
        passage: "Nessun contenuto.",
      },
    ],
    sourcesConsulted: [
      {
        sourceId: "src-a",
        urlFinal: "https://archivio.example/1343",
        canonicalUrl: "https://archivio.example/1343",
        domain: "archivio.example",
        title: "Archivio A",
        status: "fetched",
        publishedDate: "2025-01-01",
        fetchedAt: TS,
      },
      {
        sourceId: "src-b",
        urlFinal: "javascript:alert(1)",
        canonicalUrl: "javascript:alert(1)",
        domain: "fonte.example",
        title: "Fonte maliziosa",
        status: "failed",
        failure: { code: "E_FETCH_FAILED", message: "Pagina non raggiungibile.", phase: "fetch", retryable: true },
        fetchedAt: TS,
      },
    ],
    sourcesUsed: ["src-a"],
    limitations: {
      missingSources: true,
      llmUnavailable: true,
      searchUnavailable: false,
      budgetExceeded: false,
      timeBudgetExceeded: false,
      notes: ["Sintesi generata senza LLM: output del modello non valido."],
    },
    budgetUsed: {
      queriesUsed: 3,
      sourcesAnalyzed: 1,
      depthUsed: 1,
      llmCalls: 1,
      fetchAttempts: 2,
      fetchFailed: 1,
    },
    startedAt: TS,
    completedAt: TS,
    durationMs: 90_500,
  };
}

describe("ReportView", () => {
  it("mostra domanda, badge partial, sezioni con kind e banner", () => {
    render(<ReportView report={fixtureReport()} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain(
      "Università di Pisa",
    );
    expect(screen.getByText("Completata con limiti")).toBeDefined();
    expect(screen.getByText("Risposta")).toBeDefined();
    expect(screen.getByText("fatto")).toBeDefined();
    expect(screen.getByText("inferenza")).toBeDefined();
    expect(screen.getByText(/risultato parziale/i)).toBeDefined();
    expect(screen.getByText("1 min 31 s")).toBeDefined();
  });

  it("limiti e fonti: usate vs consultate (fallite con codice)", () => {
    render(<ReportView report={fixtureReport()} />);
    expect(screen.getAllByText(/senza LLM/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("E_FETCH_FAILED").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Archivio A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Fonte maliziosa").length).toBeGreaterThan(0);
  });

  it("nessun href non-http: gli url javascript restano testo", () => {
    render(<ReportView report={fixtureReport()} />);
    const anchors = Array.from(document.querySelectorAll("a"));
    expect(anchors.some((a) => a.getAttribute("href")?.startsWith("javascript:"))).toBe(false);
  });

  it("click su [n] evidenzia la riga citazione e scorre alla fonte", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;

    render(<ReportView report={fixtureReport()} />);
    const citationButton = screen.getByRole("button", { name: "Apri la citazione 1" });
    await user.click(citationButton);

    const row = document.getElementById("cite-row-1");
    expect(row?.className).toContain("citation-active");
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
