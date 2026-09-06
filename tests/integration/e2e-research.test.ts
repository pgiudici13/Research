// E2E route-level (Step 29): POST /api/research con deps FAKE complete iniettate
// nel modulo di assemblaggio (vi.mock) e motore reale. In un unico flusso NDJSON
// si verifica: avvio (primo evento `status`, `X-Research-Id`), avanzamento
// (eventi `phase`/`query`/`source-fetched` in ordine), risultato (`result` con
// citazioni che puntano solo a fonti analizzate) e fallimento Pi (SearXNG giù →
// ricerca che termina `failed` con evento `error` non sensibile, nessun crash).
// Nessuna rete reale: i doc arrivano da stringhe in-memory (guardia di rete
// attiva in tests/setup/no-network.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressEvent } from "@/lib/types";
import { parseEventLine } from "@/research/progress/events";
import { POST as researchPost, researchRateLimiter } from "@/app/api/research/route";

// stato condiviso tra i test per il mock del modulo di assemblaggio deps
const state = vi.hoisted(() => ({ searchDown: false }));

vi.mock("@/lib/server/research/deps", () => ({
  buildResearchDeps: (sink: { emit: (event: ProgressEvent) => void }) => {
    const now = (): Date => new Date("2026-01-02T00:00:00Z");
    const plan = {
      objective: "Ricostruire la fondazione dell'Università di Pisa.",
      subQuestions: [
        { id: "sub-1", text: "In quale anno fu fondata?", importance: "critical" as const },
      ],
      queries: [
        { query: "Università di Pisa anno di fondazione", purpose: "sub-question" as const, subQuestionId: "sub-1", priority: 1 },
        { query: "storia ateneo pisano origini", purpose: "synonym" as const, priority: 0.8 },
      ],
      constraints: { lang: "it", freshness: "any" as const },
      ambiguities: [] as string[],
      source: "fallback" as const,
    };

    // store immutabile a catena: ogni addEvidence restituisce una copia con
    // gli item accumulati (mai overflow nelle fixture: droppedCount resta 0)
    const makeStore = (itemsRef: unknown[]) => ({
      get droppedCount() {
        return 0;
      },
      addEvidence(evidence: unknown) {
        return makeStore([...itemsRef, evidence]);
      },
      all() {
        return itemsRef;
      },
    });
    let nextEvidenceId = 0;

    return {
      sink,
      logger: undefined,
      now,
      async plan() {
        return { plan, usedFallback: false };
      },
      async search() {
        if (state.searchDown) {
          return {
            ok: false,
            error: {
              code: "E_SEARCH_UNAVAILABLE",
              message: "Motore di ricerca non disponibile.",
              phase: "search",
              retryable: false,
            },
          };
        }
        return {
          ok: true,
          empty: false,
          items: [
            { url: "https://example.org/pisa-a", title: "Archivio A", snippet: "Fondata nel 1343.", engine: "google" },
            { url: "https://example.org/pisa-b", title: "Archivio B", snippet: "Bolla del 1343.", engine: "bing" },
          ],
        };
      },
      async rank(candidates: { url: string }[]) {
        return candidates.map((candidate, i) => ({
          candidate,
          score: { total: 1 - i * 0.01, components: {}, flags: [] },
          rank: i + 1,
        }));
      },
      async fetchPage(url: string) {
        const text = `Secondo l'archivio ufficiale l'ateneo pisano fu fondato nell'anno 1343 (fonte ${url}).`;
        return {
          ok: true,
          doc: {
            urlFinal: url,
            canonicalUrl: url,
            status: 200,
            contentType: "text/html",
            textBytes: text.length,
            truncated: false,
            body: new TextEncoder().encode(`<html><body><p>${text}</p></body></html>`),
          },
        };
      },
      extract(doc: { urlFinal: string; body: Uint8Array }, ctx: { sourceId: string }) {
        const text = new TextDecoder().decode(doc.body).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        return {
          sourceId: ctx.sourceId,
          url: doc.urlFinal,
          domain: "example.org",
          title: "Pagina",
          text,
          truncated: false,
          extractedAt: "2026-01-02T00:00:01.000Z",
        };
      },
      makeEvidence({ page }: { page: { sourceId: string; url: string; text: string } }) {
        const evidence = {
          id: `ev-${page.sourceId}-${nextEvidenceId++}`,
          sourceId: page.sourceId,
          url: page.url,
          passage: page.text.slice(0, 500),
          passageIndex: 0,
          retrievedAt: "2026-01-02T00:00:01.000Z",
          confidence: "high",
          subQuestionId: "sub-1",
          relevance: 0.9,
        };
        return [evidence];
      },
      evidenceStore() {
        return makeStore([]);
      },
      assessCoverage() {
        return { gaps: [], overall: "sufficient", perSubQuestion: {} };
      },
      detectConflicts() {
        return [];
      },
      async synthesize(input: { evidences: Array<{ id: string; passage: string }> }) {
        return {
          sections: [
            {
              heading: "Risposta",
              paragraphs: [
                { text: `Sintesi basata su ${input.evidences.length} fonti analizzate.`, citations: [1, 2] },
              ],
            },
          ],
          claims: input.evidences.map((e, i) => ({
            id: `claim-${i}`,
            text: e.passage.slice(0, 200),
            kind: "fact",
            supportEvidenceIds: [e.id],
          })),
        };
      },
      async mapCitations(input: {
        evidences: Array<{ id: string; sourceId: string; url: string; passage: string }>;
        sourceRecords: Array<{ sourceId: string; title: string; urlFinal: string }>;
      }) {
        const bySource = new Map(input.sourceRecords.map((r) => [r.sourceId, r]));
        return input.evidences.map((e, i) => ({
          index: i + 1,
          evidenceId: e.id,
          sourceId: e.sourceId,
          url: bySource.get(e.sourceId)?.urlFinal ?? e.url,
          title: bySource.get(e.sourceId)?.title ?? "",
          passage: e.passage.slice(0, 200),
        }));
      },
    };
  },
}));

function apiRequest(body: unknown, ip: string): Request {
  return new Request("http://localhost/api/research", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function parseLines(text: string): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const event = parseEventLine(line);
    expect(event, `riga non parsabile: ${line.slice(0, 80)}`).not.toBeNull();
    if (event !== null) events.push(event);
  }
  return events;
}

function firstIndexOf(events: ProgressEvent[], type: string): number {
  return events.findIndex((e) => e.type === type);
}

const QUESTION = "In quale anno fu fondata l'Università di Pisa?";

beforeEach(() => {
  researchRateLimiter.reset();
  state.searchDown = false;
});

describe("POST /api/research — e2e route-level (deps fake, motore reale)", () => {
  it("avvio → progresso → risultato citato in un unico stream NDJSON", async () => {
    const response = await researchPost(apiRequest({ question: QUESTION }, "198.51.100.90"));
    expect(response.status).toBe(200);
    const researchId = response.headers.get("x-research-id");
    expect(researchId).toBeTruthy();

    const events = parseLines(await response.text());
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.type).toBe("status");
    expect(new Set(events.map((e) => e.researchId)).size).toBe(1);
    expect(events[0]!.researchId).toBe(researchId);

    // ordine di avanzamento: le fasi e le query compaiono prima del risultato
    const order = {
      planningStarted: events.findIndex((e) => e.type === "phase" && (e as { phase?: string }).phase === "planning"),
      query: firstIndexOf(events, "query"),
      fetched: firstIndexOf(events, "source-fetched"),
      evidence: firstIndexOf(events, "evidence"),
      result: firstIndexOf(events, "result"),
      done: firstIndexOf(events, "done"),
    };
    expect(order.planningStarted).toBeGreaterThanOrEqual(0);
    expect(order.query).toBeGreaterThan(order.planningStarted);
    expect(order.fetched).toBeGreaterThan(order.query);
    expect(order.evidence).toBeGreaterThan(order.fetched);
    expect(order.result).toBeGreaterThan(order.evidence);
    expect(order.done).toBeGreaterThan(order.result);
    expect(events[order.done]!.type).toBe("done");

    const result = events.find((e): e is Extract<ProgressEvent, { type: "result" }> => e.type === "result");
    expect(result).toBeDefined();
    if (result === undefined) throw new Error("manca l'evento result");
    const report = result.report;
    expect(report.status).toBe("completed");
    expect(report.researchId).toBe(researchId);
    expect(report.sections.length).toBeGreaterThan(0);

    // citazioni → solo fonti analizzate (status fetched), mai URL non consultati
    const fetched = new Set(
      report.sourcesConsulted.filter((s) => s.status === "fetched").map((s) => s.canonicalUrl),
    );
    expect(report.citations.length).toBeGreaterThan(0);
    for (const citation of report.citations) {
      expect(fetched.has(citation.url)).toBe(true);
    }
    expect(report.sourcesUsed.length).toBeGreaterThan(0);
  });

  it("Pi/SearXNG giù → ricerca failed onesta con evento error non sensibile", async () => {
    state.searchDown = true;
    const response = await researchPost(apiRequest({ question: QUESTION }, "198.51.100.91"));
    expect(response.status).toBe(200);
    const events = parseLines(await response.text());

    const errors = events.filter((e): e is Extract<ProgressEvent, { type: "error" }> => e.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error.error.code).toBe("E_SEARCH_UNAVAILABLE");
      expect(error.error.message).not.toMatch(/stack|token|secret|key/i);
    }
    const result = events.find((e): e is Extract<ProgressEvent, { type: "result" }> => e.type === "result");
    expect(result).toBeDefined();
    if (result === undefined) throw new Error("manca l'evento result");
    expect(result.report.status).toBe("failed");
    expect(result.report.limitations.searchUnavailable).toBe(true);
    const done = events[events.length - 1];
    expect(done?.type).toBe("done");
    if (done !== undefined && done.type === "done") expect(done.status).toBe("failed");
  });
});
