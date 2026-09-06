// @vitest-environment jsdom
// Test degli indicatori live (Step 23): phase-indicator (stati, aria-current)
// ed event-log (righe testuali, url http validati vs javascript).

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ProgressEvent } from "@/lib/types";
import { PhaseIndicator } from "@/components/phase-indicator";
import { EventLog, safeHttpHref } from "@/components/event-log";
import { PHASE_LABELS } from "@/lib/ui-copy";
import type { PhaseUiState } from "@/hooks/use-research";

afterEach(() => {
  cleanup();
});

const TS = "2026-01-02T00:00:00.000Z";

describe("PhaseIndicator", () => {
  const phases: PhaseUiState[] = [
    { phase: "planning", status: "done" },
    { phase: "searching", status: "active" },
    { phase: "fetching", status: "pending" },
    { phase: "extracting", status: "pending" },
    { phase: "analyzing", status: "pending" },
    { phase: "verifying", status: "pending" },
    { phase: "synthesizing", status: "pending" },
  ];

  it("mostra tutte le fasi con lo stato attivo marcato via aria-current", () => {
    render(<PhaseIndicator phases={phases} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(PHASE_LABELS.length);
    expect(items[0]!.className).toContain("phase-done");
    expect(items[1]!.getAttribute("aria-current")).toBe("step");
    expect(items[1]!.className).toContain("phase-active");
    expect(screen.getByText("Ricerca")).toBeDefined();
    expect(screen.getByText("Sintesi")).toBeDefined();
  });
});

describe("EventLog", () => {
  const events: ProgressEvent[] = [
    { type: "query", researchId: "r", ts: TS, query: "università di pisa 1343", purpose: "sub-question", index: 1, total: 2 },
    {
      type: "result-found",
      researchId: "r",
      ts: TS,
      url: "javascript:alert(1)",
      title: "Risultato malevolo",
      domain: "x.example",
      engine: "google",
    },
    {
      type: "result-found",
      researchId: "r",
      ts: TS,
      url: "https://archivio.example/1343",
      title: "Archivio della fondazione",
      domain: "archivio.example",
      engine: "google",
    },
    {
      type: "source-fetched",
      researchId: "r",
      ts: TS,
      sourceId: "src-a",
      url: "https://archivio.example/1343",
      domain: "archivio.example",
      title: "Archivio della fondazione",
      status: "fetched",
    },
    {
      type: "source-fetched",
      researchId: "r",
      ts: TS,
      sourceId: "src-b",
      url: "https://b.example/",
      domain: "b.example",
      status: "failed",
      error: { code: "E_FETCH_FAILED", message: "x", phase: "fetch", retryable: true },
    },
  ];

  it("descrive gli eventi salienti come testo", () => {
    render(<EventLog events={events} />);
    expect(screen.getByText(/Query: università di pisa 1343/)).toBeDefined();
    expect(screen.getAllByText(/Trovato:/)).toHaveLength(2);
    expect(screen.getAllByText(/Analizzata:/)).toHaveLength(1);
    expect(screen.getAllByText(/Non raggiungibile:/)).toHaveLength(1);
  });

  it("gli url http diventano link; quelli javascript restano testo", () => {
    render(<EventLog events={events} />);
    const anchors = Array.from(document.querySelectorAll("a"));
    expect(anchors.some((a) => a.getAttribute("href")?.startsWith("javascript:"))).toBe(false);
    expect(anchors.some((a) => a.getAttribute("href") === "https://archivio.example/1343")).toBe(true);
    expect(anchors.every((a) => a.getAttribute("rel") === "noopener noreferrer")).toBe(true);
  });

  it("safeHttpHref filtra schemi non http(s)", () => {
    expect(safeHttpHref("https://ok.example/")).toBe("https://ok.example/");
    expect(safeHttpHref("http://ok.example/")).toBe("http://ok.example/");
    expect(safeHttpHref("javascript:alert(1)")).toBeNull();
    expect(safeHttpHref("ftp://x.example/")).toBeNull();
    expect(safeHttpHref("non-un-url")).toBeNull();
  });
});
