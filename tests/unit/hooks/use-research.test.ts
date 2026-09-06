// Unit test puri del ciclo ricerca lato client (Step 22): reducer, lettura
// dello stream NDJSON (con chunk spezzati a metà riga) e derivazioni.

import { describe, expect, it } from "vitest";
import type { ProgressEvent, ResearchReport } from "@/lib/types";
import { serializeEvent } from "@/research/progress/events";
import {
  deriveCounters,
  derivePhaseStates,
  errorKeyForCode,
  initialState,
  readResearchStream,
  researchReducer,
} from "@/hooks/use-research";

const TS = "2026-01-02T00:00:00.000Z";

function minimalReport(status: ResearchReport["status"]): ResearchReport {
  return {
    researchId: "res-x",
    question: "Domanda?",
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

describe("researchReducer", () => {
  it("start azzera e passa a running; gli eventi aggiornano status/events", () => {
    let state = initialState();
    expect(state.macro).toBe("idle");

    state = researchReducer(state, { type: "start" });
    expect(state.macro).toBe("running");
    expect(state.status).toBe("planning");
    expect(state.events).toEqual([]);

    const query: ProgressEvent = {
      type: "query",
      researchId: "r",
      ts: TS,
      query: "q",
      purpose: "sub-question",
      index: 1,
      total: 1,
    };
    state = researchReducer(state, { type: "event", event: query });
    expect(state.events).toHaveLength(1);
  });

  it("evento result memorizza il report; done rende terminale lo stato", () => {
    let state = researchReducer(initialState(), { type: "start" });
    const report = minimalReport("partial");
    state = researchReducer(state, {
      type: "event",
      event: { type: "result", researchId: "r", ts: TS, schemaVersion: 1, report },
    });
    expect(state.report).toBe(report);
    expect(state.status).toBe("partial");
    expect(state.macro).toBe("running");

    state = researchReducer(state, {
      type: "event",
      event: { type: "done", researchId: "r", ts: TS, status: "partial" },
    });
    expect(state.macro).toBe("done");
    expect(state.status).toBe("partial");
  });

  it("errore e reset", () => {
    let state = researchReducer(initialState(), { type: "start" });
    state = researchReducer(state, { type: "error", key: "E_RATE_LIMIT" });
    expect(state.macro).toBe("error");
    expect(state.errorKey).toBe("E_RATE_LIMIT");

    state = researchReducer(state, { type: "reset" });
    expect(state).toEqual(initialState());
  });

  it("cappa gli eventi recenti (EVENTS_CAP)", () => {
    let state = researchReducer(initialState(), { type: "start" });
    for (let i = 0; i < 320; i++) {
      state = researchReducer(state, {
        type: "event",
        event: {
          type: "query",
          researchId: "r",
          ts: TS,
          query: `q${i}`,
          purpose: "follow-up",
          index: i,
          total: 1,
        },
      });
    }
    expect(state.events).toHaveLength(300);
  });
});

describe("errorKeyForCode", () => {
  it("mappa ogni codice del catalogo alla propria chiave UI, altrimenti generic", () => {
    expect(errorKeyForCode("E_RATE_LIMIT")).toBe("E_RATE_LIMIT");
    expect(errorKeyForCode("E_VALIDATION")).toBe("E_VALIDATION");
    expect(errorKeyForCode("E_LLM_UNAVAILABLE")).toBe("E_LLM_UNAVAILABLE");
    expect(errorKeyForCode("E_SEARCH_TIMEOUT")).toBe("E_SEARCH_TIMEOUT");
    expect(errorKeyForCode("E_TIMEOUT_RESEARCH")).toBe("E_TIMEOUT_RESEARCH");
    expect(errorKeyForCode("CODICE_SCONOSCIUTO")).toBe("generic");
    expect(errorKeyForCode(undefined)).toBe("generic");
  });
});

describe("readResearchStream", () => {
  function streamResponse(lines: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // spezza volutamente una riga a metà per testare il buffering
        for (const line of lines) {
          if (line.length > 10) {
            controller.enqueue(encoder.encode(line.slice(0, 10)));
            controller.enqueue(encoder.encode(line.slice(10) + "\n"));
          } else {
            controller.enqueue(encoder.encode(line + "\n"));
          }
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }

  it("ricostruisce gli eventi anche con righe spezzate e righe vuote", async () => {
    const events: ProgressEvent[] = [];
    const status: ProgressEvent = { type: "status", researchId: "r", ts: TS, status: "searching" };
    const done: ProgressEvent = { type: "done", researchId: "r", ts: TS, status: "completed" };
    const lines = [serializeEvent(status), "", serializeEvent(done), "\n"];

    await readResearchStream(streamResponse(lines), (e) => events.push(e));
    expect(events).toEqual([status, done]);
  });

  it("ignora le righe malformate senza interrompere lo stream", async () => {
    const received: string[] = [];
    const events: ProgressEvent[] = [];
    const good: ProgressEvent = { type: "status", researchId: "r", ts: TS, status: "fetching" };
    const lines = ["non-json", serializeEvent(good), "{\"type\":\"status\"}"];
    await readResearchStream(streamResponse(lines), (e) => {
      events.push(e);
      received.push(e.type);
    });
    expect(events).toEqual([good]);
  });
});

describe("derive*", () => {
  const events: ProgressEvent[] = [
    { type: "phase", researchId: "r", ts: TS, phase: "planning", status: "started" },
    { type: "phase", researchId: "r", ts: TS, phase: "planning", status: "ended" },
    { type: "phase", researchId: "r", ts: TS, phase: "searching", status: "started" },
    { type: "query", researchId: "r", ts: TS, query: "q", purpose: "sub-question", index: 1, total: 1 },
    {
      type: "result-found",
      researchId: "r",
      ts: TS,
      url: "https://a.example/",
      title: "A",
      domain: "a.example",
      engine: "google",
    },
    {
      type: "source-fetched",
      researchId: "r",
      ts: TS,
      sourceId: "s1",
      url: "https://a.example/",
      domain: "a.example",
      status: "fetched",
    },
    {
      type: "evidence",
      researchId: "r",
      ts: TS,
      evidenceId: "s1:p0",
      sourceId: "s1",
      url: "https://a.example/",
      passagePreview: "preview",
    },
    { type: "conflict", researchId: "r", ts: TS, conflictId: "c1", topic: "anno", severity: "confirmed" },
    { type: "limitation", researchId: "r", ts: TS, note: "nota" },
  ];

  it("deriva lo stato delle fasi (pending/active/done)", () => {
    const phases = derivePhaseStates(events);
    expect(phases[0]).toEqual({ phase: "planning", status: "done" });
    expect(phases[1]).toEqual({ phase: "searching", status: "active" });
    expect(phases[2]).toEqual({ phase: "fetching", status: "pending" });
  });

  it("deriva i contatori essenziali", () => {
    const counters = deriveCounters(events);
    expect(counters).toMatchObject({
      queries: 1,
      resultsFound: 1,
      sourcesFetched: 1,
      sourcesFailed: 0,
      evidences: 1,
      conflicts: 1,
      limitations: 1,
    });
  });
});
