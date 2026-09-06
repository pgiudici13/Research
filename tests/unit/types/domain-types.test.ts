import { describe, expect, it } from "vitest";
import {
  IN_PROGRESS_STATUSES,
  PROGRESS_EVENT_TYPES,
  TERMINAL_STATUSES,
  type DoneEvent,
  type PhaseEvent,
  type ProgressEvent,
  type ProgressEventType,
  type QueryEvent,
  type ResearchPlan,
  type ResearchReport,
  type ResearchStatus,
  type ResultEvent,
  type StatusEvent,
  type ConflictEvent,
  type PhaseName,
} from "@/lib/types";

const ts = "2026-09-06T00:00:00.000Z";
const researchId = "research-test";

function statusEvent(status: ResearchStatus): StatusEvent {
  return { type: "status", researchId, ts, status };
}

/** Un'istanza di esempio per OGNI tipo di evento. */
function sampleEvents(): ProgressEvent[] {
  return [
    statusEvent("planning"),
    { type: "phase", researchId, ts, phase: "searching", status: "started" },
    {
      type: "query",
      researchId,
      ts,
      query: "test query",
      purpose: "sub-question",
      index: 0,
      total: 2,
    },
    {
      type: "result-found",
      researchId,
      ts,
      url: "https://example.com/a",
      title: "A",
      domain: "example.com",
      engine: "google",
    },
    {
      type: "source-consulted",
      researchId,
      ts,
      sourceId: "src-1",
      url: "https://example.com/a",
      status: "fetching",
    },
    {
      type: "source-fetched",
      researchId,
      ts,
      sourceId: "src-1",
      url: "https://example.com/a",
      domain: "example.com",
      status: "failed",
      error: { code: "E_FETCH_FAILED", message: "down", phase: "fetching", retryable: false },
    },
    {
      type: "evidence",
      researchId,
      ts,
      evidenceId: "ev-1",
      sourceId: "src-1",
      url: "https://example.com/a",
      passagePreview: "…",
    },
    {
      type: "conflict",
      researchId,
      ts,
      conflictId: "cf-1",
      topic: "topic",
      severity: "possible",
    },
    { type: "limitation", researchId, ts, note: "LLM non disponibile" },
    {
      type: "error",
      researchId,
      ts,
      phase: "searching",
      error: { code: "E_SEARCH_UNAVAILABLE", message: "down", phase: "searching", retryable: true },
    },
    {
      type: "result",
      researchId,
      ts,
      schemaVersion: 1,
      report: sampleReport(),
    },
    { type: "done", researchId, ts, status: "completed" },
  ];
}

function sampleReport(): ResearchReport {
  return {
    researchId,
    question: "Domanda di test",
    status: "completed",
    sections: [
      { heading: "Risposta", paragraphs: [{ text: "Testo.", citations: [1], kind: "fact" }] },
    ],
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
    startedAt: ts,
    completedAt: ts,
    durationMs: 1,
  };
}

describe("tipi di dominio", () => {
  it("definisce esattamente gli eventi della pipeline", () => {
    const expected: ProgressEventType[] = [
      "status",
      "phase",
      "query",
      "result-found",
      "source-consulted",
      "source-fetched",
      "evidence",
      "conflict",
      "limitation",
      "error",
      "result",
      "done",
    ];
    expect([...PROGRESS_EVENT_TYPES].sort()).toEqual(expected.sort());
  });

  it("istanzia un evento di ogni tipo e li serializza senza cicli", () => {
    const events = sampleEvents();
    expect(events).toHaveLength(PROGRESS_EVENT_TYPES.length);
    const types = new Set(events.map((e) => e.type));
    expect(types).toEqual(new Set(PROGRESS_EVENT_TYPES));

    for (const event of events) {
      const roundTrip = JSON.parse(JSON.stringify(event)) as ProgressEvent;
      expect(roundTrip).toEqual(event); // niente cicli, niente campi persi
      expect(typeof event.researchId).toBe("string");
      expect(typeof event.ts).toBe("string");
    }
  });

  it("non ha stati orfani: ogni stato in corso e' anche un nome di fase", () => {
    const phaseNames = new Set<PhaseName>([
      "planning",
      "searching",
      "fetching",
      "extracting",
      "analyzing",
      "verifying",
      "synthesizing",
    ]);
    for (const s of IN_PROGRESS_STATUSES) {
      expect(phaseNames.has(s as PhaseName)).toBe(true);
    }
    // Gli stati terminali non devono comparire tra le fasi transitorie.
    for (const s of TERMINAL_STATUSES) {
      expect(IN_PROGRESS_STATUSES).not.toContain(s);
    }
  });
});

describe("tipi di piano/report", () => {
  it("ResearchPlan e ResearchReport sono serializzabili", () => {
    const plan: ResearchPlan = {
      objective: "obiettivo",
      subQuestions: [{ id: "sq-1", text: "sotto-domanda", importance: "critical" }],
      queries: [{ query: "q", purpose: "sub-question", priority: 1 }],
      constraints: { lang: "it", freshness: "any" },
      ambiguities: [],
    };
    const report = sampleReport();
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("il payload di test copre le varianti degli eventi strutturati", () => {
    const phase: PhaseEvent = sampleEvents()[1] as PhaseEvent;
    const query: QueryEvent = sampleEvents()[2] as QueryEvent;
    const conflict: ConflictEvent = sampleEvents()[7] as ConflictEvent;
    const result: ResultEvent = sampleEvents()[10] as ResultEvent;
    const done: DoneEvent = sampleEvents()[11] as DoneEvent;
    expect(phase.phase).toBe("searching");
    expect(query.index).toBe(0);
    expect(conflict.severity).toMatch(/^(possible|confirmed)$/);
    expect(result.schemaVersion).toBe(1);
    expect(done.status).toBe("completed");
  });
});

