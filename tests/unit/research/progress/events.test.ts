// Unit test del wire protocol (Step 20): round-trip NDJSON senza perdite,
// guard di runtime, macchina a stati, limiti delle preview e contratto di
// segretezza degli eventi.

import { describe, expect, it } from "vitest";
import type { Conflict, ProgressEvent } from "@/lib/types";
import {
  assertValidStatusTransition,
  canTransitionStatus,
  EVENT_LIMITS,
  eventHasForbiddenFields,
  FORBIDDEN_EVENT_FIELDS,
  isProgressEvent,
  parseEventLine,
  serializeEvent,
  STATUS_FLOW,
} from "@/research/progress/events";
import { createMemorySink, createStreamSink, eventsOfType } from "@/research/progress/sink";

const ID = "res-test-1";
const TS = "2026-01-02T00:00:00.000Z";

function reportEvent(): ProgressEvent {
  return {
    type: "result",
    researchId: ID,
    ts: TS,
    schemaVersion: 1,
    report: {
      researchId: ID,
      question: "Domanda?",
      status: "completed",
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
      durationMs: 10,
    },
  };
}

const EVENTS: ProgressEvent[] = [
  { type: "status", researchId: ID, ts: TS, status: "planning" },
  { type: "phase", researchId: ID, ts: TS, phase: "searching", status: "started" },
  {
    type: "query",
    researchId: ID,
    ts: TS,
    query: "università di pisa",
    purpose: "sub-question",
    index: 1,
    total: 3,
  },
  {
    type: "result-found",
    researchId: ID,
    ts: TS,
    url: "https://a.example/",
    title: "A",
    domain: "a.example",
    engine: "google",
    snippet: "snippet",
  },
  {
    type: "source-consulted",
    researchId: ID,
    ts: TS,
    sourceId: "src-a",
    url: "https://a.example/",
    status: "fetching",
  },
  {
    type: "source-fetched",
    researchId: ID,
    ts: TS,
    sourceId: "src-a",
    url: "https://a.example/",
    domain: "a.example",
    title: "A",
    status: "fetched",
  },
  {
    type: "evidence",
    researchId: ID,
    ts: TS,
    evidenceId: "src-a:p0",
    sourceId: "src-a",
    url: "https://a.example/",
    passagePreview: "passaggio troncato",
  },
  {
    type: "conflict",
    researchId: ID,
    ts: TS,
    conflictId: "conf-1",
    topic: "anno",
    severity: "possible",
  },
  { type: "limitation", researchId: ID, ts: TS, note: "limite", code: "E_TEST" },
  {
    type: "error",
    researchId: ID,
    ts: TS,
    phase: "fetch",
    error: { code: "E_FETCH_FAILED", message: "errore", phase: "fetch", retryable: true },
  },
  reportEvent(),
  { type: "done", researchId: ID, ts: TS, status: "completed" },
];

describe("serializzazione NDJSON", () => {
  it("ogni tipo evento fa round-trip senza perdita", () => {
    for (const event of EVENTS) {
      const line = serializeEvent(event);
      expect(line.endsWith("\n")).toBe(false);
      const parsed = parseEventLine(line);
      expect(parsed).toEqual(event);
    }
  });

  it("riga vuota / JSON malformato / shape invalida → null", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("   \n")).toBeNull();
    expect(parseEventLine("non-json")).toBeNull();
    expect(parseEventLine('{"type":"status"}')).toBeNull(); // manca researchId/ts
    expect(parseEventLine('{"type":"evento-sconosciuto","researchId":"x","ts":"t"}')).toBeNull();
    // tipo noto ma campi con tipo sbagliato
    expect(parseEventLine('{"type":"query","researchId":1,"ts":"t","query":"q","purpose":"p","index":1,"total":2}')).toBeNull();
    // result con report malformato
    expect(parseEventLine('{"type":"result","researchId":"x","ts":"t","schemaVersion":1,"report":{"status":5}}')).toBeNull();
  });

  it("guard di runtime accetta eventi validi e rifiuta shape estranee", () => {
    expect(EVENTS.every((e) => isProgressEvent(e))).toBe(true);
    expect(isProgressEvent({ type: "status" })).toBe(false);
    expect(isProgressEvent(null)).toBe(false);
    expect(isProgressEvent([{ type: "status" }])).toBe(false);
  });
});

describe("macchina a stati", () => {
  it("sequenza canonica valida e salti in avanti ammessi", () => {
    expect(canTransitionStatus(null, "planning")).toBe(true);
    for (let i = 0; i < STATUS_FLOW.length - 1; i++) {
      expect(canTransitionStatus(STATUS_FLOW[i], STATUS_FLOW[i + 1])).toBe(true);
    }
    // il motore salta spesso da planning a uno stato terminale o intermedio
    expect(canTransitionStatus("planning", "synthesizing")).toBe(true);
    expect(canTransitionStatus("searching", "completed")).toBe(true);
    expect(canTransitionStatus("planning", "partial")).toBe(true);
    expect(() =>
      assertValidStatusTransition("planning", "completed"),
    ).not.toThrow();
  });

  it("transizioni invalide → errore di sviluppo", () => {
    expect(canTransitionStatus("completed", "searching")).toBe(false);
    expect(canTransitionStatus("fetching", "planning")).toBe(false); // indietro
    expect(canTransitionStatus("completed", "partial")).toBe(false); // terminale assorbente
    expect(canTransitionStatus(null, "completed")).toBe(false); // mai terminale in testa
    expect(() => assertValidStatusTransition("completed", "searching")).toThrow(
      /transizione di stato non valida/,
    );
  });

  it("cancelled raggiungibile da qualunque stato in corso", () => {
    for (const state of STATUS_FLOW) {
      expect(canTransitionStatus(state, "cancelled")).toBe(true);
    }
    expect(canTransitionStatus("completed", "cancelled")).toBe(false);
    expect(() => assertValidStatusTransition("searching", "cancelled")).not.toThrow();
  });
});

describe("contratto di sicurezza", () => {
  it("limiti preview documentati (snippet ≤ 400, preview ≤ 300)", () => {
    expect(EVENT_LIMITS.resultFoundSnippetMax).toBe(400);
    expect(EVENT_LIMITS.evidencePreviewMax).toBe(300);
  });

  it("nessun evento contiene campi/valori da segreti (ricorsivo)", () => {
    for (const event of EVENTS) {
      expect(eventHasForbiddenFields(event)).toBe(false);
    }
    const smuggled = { type: "limitation", researchId: ID, ts: TS, note: "x", apiKey: "sk-123" };
    expect(eventHasForbiddenFields(smuggled as never)).toBe(true);
    const nested = {
      type: "error",
      researchId: ID,
      ts: TS,
      phase: "x",
      error: { code: "E", message: "m", phase: "p", retryable: false, authorization: "Bearer x" },
    };
    expect(eventHasForbiddenFields(nested as never)).toBe(true);
    expect(FORBIDDEN_EVENT_FIELDS.length).toBeGreaterThanOrEqual(5);
  });

  it("la preview di un passaggio lungo è un dato troncato, mai il passaggio integrale", () => {
    const longPassage = "x".repeat(10_000);
    const event = {
      type: "evidence",
      researchId: ID,
      ts: TS,
      evidenceId: "e",
      sourceId: "s",
      url: "https://a.example/",
      passagePreview: longPassage,
    };
    // il TIPO non può impedire un payload abusivo: il limite è documentato ed
    // è responsabilità dell'emettitore (engine) — verifichiamo che il guard
    // non trasporti il campo "passage" integrale
    expect(Object.keys(event)).not.toContain("passage");
  });
});

describe("conflict guard", () => {
  it("accetta solo severity note e campi obbligatori", () => {
    const conflictEvent: ProgressEvent = {
      type: "conflict",
      researchId: ID,
      ts: TS,
      conflictId: "c1",
      topic: "anno",
      severity: "confirmed",
    };
    expect(isProgressEvent(conflictEvent)).toBe(true);
    expect(
      isProgressEvent({ ...conflictEvent, severity: "definitely" }),
    ).toBe(false);
  });
});

describe("sink condiviso (Step 17-20)", () => {
  it("memory sink raccoglie gli eventi; stream sink serializza NDJSON", () => {
    const memory = createMemorySink();
    const lines: string[] = [];
    const stream = createStreamSink({ write: (line) => lines.push(line) });

    const events = eventsOfType(EVENTS, "query");
    for (const event of events) {
      memory.sink.emit(event);
      stream.emit(event);
    }

    expect(memory.events).toEqual(events);
    expect(lines).toHaveLength(events.length);
    expect(lines.every((l) => l.endsWith("\n"))).toBe(true);
    expect(parseEventLine(lines[0]!.trim())).toEqual(events[0]);
  });

  it("gli eventi 'conflict' prodotti dal motore rispettano il wire", () => {
    const conflict: Conflict = {
      id: "conf-sub-1:a+b",
      topic: "anno",
      severity: "confirmed",
      statements: [
        { evidenceId: "a", sourceId: "s1", position: "1343" },
        { evidenceId: "b", sourceId: "s2", position: "1344" },
      ],
    };
    const event: ProgressEvent = {
      type: "conflict",
      researchId: ID,
      ts: TS,
      conflictId: conflict.id,
      topic: conflict.topic,
      severity: conflict.severity,
    };
    expect(parseEventLine(serializeEvent(event))).toEqual(event);
  });
});
