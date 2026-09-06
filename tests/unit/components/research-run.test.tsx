// @vitest-environment jsdom
// Test end-to-end del contenitore ResearchRun (Step 22) con fetch mockato che
// restituisce uno stream NDJSON: flusso completo, errore rate-limit, errore di
// rete e reset.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProgressEvent, ResearchReport } from "@/lib/types";
import { serializeEvent } from "@/research/progress/events";
import { ResearchRun } from "@/components/research-run";
import { COPY } from "@/lib/ui-copy";

const TS = "2026-01-02T00:00:00.000Z";
const QUESTION = "In quale anno fu fondata l'Università di Pisa e da chi?";

function minimalReport(status: ResearchReport["status"]): ResearchReport {
  return {
    researchId: "res-ui-1",
    question: QUESTION,
    status,
    sections: [],
    claims: [],
    conflicts: [],
    citations: [],
    sourcesConsulted: [],
    sourcesUsed: [],
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
      sourcesAnalyzed: 0,
      depthUsed: 1,
      llmCalls: 0,
      fetchAttempts: 0,
      fetchFailed: 0,
    },
    startedAt: TS,
    completedAt: TS,
    durationMs: 1,
  };
}

function ndjsonBody(events: ProgressEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(serializeEvent(event) + "\n"));
      }
      controller.close();
    },
  });
}

function okResponse(events: ProgressEvent[]): Response {
  return new Response(ndjsonBody(events), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

const COMPLETED_EVENTS: ProgressEvent[] = [
  { type: "status", researchId: "res-ui-1", ts: TS, status: "planning" },
  { type: "phase", researchId: "res-ui-1", ts: TS, phase: "planning", status: "started" },
  { type: "phase", researchId: "res-ui-1", ts: TS, phase: "planning", status: "ended" },
  { type: "query", researchId: "res-ui-1", ts: TS, query: "università di pisa", purpose: "sub-question", index: 1, total: 1 },
  {
    type: "source-fetched",
    researchId: "res-ui-1",
    ts: TS,
    sourceId: "src-1",
    url: "https://a.example/",
    domain: "a.example",
    status: "fetched",
    title: "Fonte A",
  },
  { type: "result", researchId: "res-ui-1", ts: TS, schemaVersion: 1, report: minimalReport("completed") },
  { type: "done", researchId: "res-ui-1", ts: TS, status: "completed" },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ResearchRun", () => {
  it("flusso completo: lo stato UI riflette il done del server", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(COMPLETED_EVENTS));
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<ResearchRun />);
    await user.type(screen.getByLabelText(COPY.form.questionLabel), QUESTION);
    await user.click(screen.getByRole("button", { name: COPY.form.start }));

    await waitFor(() => {
      expect(screen.getByText("Completata")).toBeDefined();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/research");
    const body = JSON.parse(String((init as RequestInit).body)) as { question: string };
    expect(body.question).toBe(QUESTION);
  });

  it("429 → messaggio rate-limit non sensibile", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "E_RATE_LIMIT" }, requestId: "req-1" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<ResearchRun />);
    await user.type(screen.getByLabelText(COPY.form.questionLabel), QUESTION);
    await user.click(screen.getByRole("button", { name: COPY.form.start }));

    await waitFor(() => {
      expect(screen.getAllByText(COPY.errors.E_RATE_LIMIT).length).toBeGreaterThan(0);
    });
  });

  it("errore di rete → messaggio generico e reset con Riprova", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network down")),
    );

    const user = userEvent.setup();
    render(<ResearchRun />);
    await user.type(screen.getByLabelText(COPY.form.questionLabel), QUESTION);
    await user.click(screen.getByRole("button", { name: COPY.form.start }));

    await waitFor(() => {
      expect(screen.getAllByText(COPY.errors.network).length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole("button", { name: "Riprova" }));
    expect(screen.getByText(COPY.status.idle)).toBeDefined();
  });
});
