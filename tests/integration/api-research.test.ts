// Integration test delle route API (Step 21). Chiama direttamente gli handler
// Next (web Request/Response, nessun server): validazione, rate limit,
// streaming NDJSON reale con il motore (nessun LLM/SearXNG configurato →
// report failed onesto, senza rete) e wiring dell'annullamento.

import { beforeEach, describe, expect, it } from "vitest";
import type { ProgressEvent } from "@/lib/types";
import { parseEventLine } from "@/research/progress/events";
import { POST as researchPost, researchRateLimiter } from "@/app/api/research/route";
import { GET as healthGet } from "@/app/api/health/route";

function researchRequest(body: unknown, ip: string, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/research", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
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

async function readNdjson(response: Response): Promise<ProgressEvent[]> {
  const text = await response.text();
  return parseLines(text);
}

const IP_A = "198.51.100.10";
const IP_B = "198.51.100.20";
const QUESTION = "In quale anno fu fondata l'Università di Pisa e da chi?";

beforeEach(() => {
  researchRateLimiter.reset();
});

describe("GET /api/health", () => {
  it("200 con ok/service/time, nessun dettaglio infrastrutturale", async () => {
    const response = await healthGet();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("deep-research");
    expect(typeof body.time).toBe("string");
    expect(Object.keys(body).sort()).toEqual(["ok", "service", "time"]);
  });
});

describe("POST /api/research — streaming reale", () => {
  it("richiesta valida → stream NDJSON con result e done (nessuna rete)", async () => {
    const response = await researchPost(researchRequest({ question: QUESTION }, IP_A));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const researchId = response.headers.get("x-research-id");
    expect(researchId).toBeTruthy();
    expect(response.headers.get("x-request-id")).toBeTruthy();

    const raw = await response.text();
    const events = parseLines(raw);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.type).toBe("status");
    expect(events[events.length - 1]!.type).toBe("done");

    const result = events.find((e) => e.type === "result");
    expect(result).toBeDefined();
    if (result === undefined || result.type !== "result") throw new Error("manca result");
    expect(result.report.researchId).toBe(researchId);
    expect(result.report.question).toBe(QUESTION);
    // nessun motore/LLM nei test: report fallito MA onesto, con limiti spiegati
    expect(result.report.status).toBe("failed");
    expect(result.report.limitations.searchUnavailable).toBe(true);
    expect(result.report.sections).toEqual([]);

    const done = events[events.length - 1];
    if (done === undefined || done.type !== "done") throw new Error("manca done");
    expect(done.status).toBe("failed");

    // contratto di sicurezza: nessun campo segreto e nessun valore sensibile
    expect(raw).not.toMatch(/bearer /i);
    expect(raw).not.toContain("nvidia_api_key");
    expect(raw).not.toContain("NVIDIA_API_KEY");
  });

  it("X-Research-Id coerente tra header ed eventi", async () => {
    const response = await researchPost(researchRequest({ question: QUESTION }, IP_B));
    const researchId = response.headers.get("x-research-id")!;
    const events = await readNdjson(response);
    const ids = new Set(events.map((e) => e.researchId));
    expect(ids.size).toBe(1);
    expect(ids.has(researchId)).toBe(true);
  });
});

describe("POST /api/research — validazione pre-stream", () => {
  async function bodyOf(response: Response): Promise<Record<string, unknown>> {
    return (await response.json()) as Record<string, unknown>;
  }

  it("domanda corta → 400 E_VALIDATION con ApiErrorBody", async () => {
    const response = await researchPost(researchRequest({ question: "corta" }, IP_A));
    expect(response.status).toBe(400);
    const body = await bodyOf(response);
    const error = body.error as Record<string, unknown>;
    expect(error.code).toBe("E_VALIDATION");
    expect(typeof body.requestId).toBe("string");
  });

  it("campo sconosciuto / opzione non valida / JSON malformato → 400", async () => {
    const badField = await researchPost(
      researchRequest({ question: QUESTION, inventato: true }, IP_A),
    );
    expect(badField.status).toBe(400);

    const badOption = await researchPost(
      researchRequest({ question: QUESTION, options: { freshness: "ultimo-anno" } }, IP_A),
    );
    expect(badOption.status).toBe(400);

    const malformed = await researchPost(researchRequest("non-json-{", IP_A));
    expect(malformed.status).toBe(400);
  });

  it("body oltre 16 KB → 400", async () => {
    const huge = { question: "x".repeat(20_000) };
    const response = await researchPost(researchRequest(huge, IP_A));
    expect(response.status).toBe(400);
  });

  it("option depth oltre i limiti → clampato (non errore)", async () => {
    const response = await researchPost(
      researchRequest(
        { question: QUESTION, options: { depth: 99, maxSources: 999 } },
        IP_A,
      ),
    );
    expect(response.status).toBe(200);
    await response.text(); // consuma lo stream
  });
});

describe("POST /api/research — rate limit", () => {
  it("6ª richiesta dalla stessa IP nella finestra → 429 E_RATE_LIMIT", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await researchPost(researchRequest({ question: QUESTION }, IP_A));
      expect(response.status).toBe(200);
      await response.text();
    }
    const denied = await researchPost(researchRequest({ question: QUESTION }, IP_A));
    expect(denied.status).toBe(429);
    const body = (await denied.json()) as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).code).toBe("E_RATE_LIMIT");
    expect(denied.headers.get("retry-after")).toBeTruthy();
    // un'altra IP NON è limitata
    const other = await researchPost(researchRequest({ question: QUESTION }, IP_B));
    expect(other.status).toBe(200);
    await other.text();
  });
});
