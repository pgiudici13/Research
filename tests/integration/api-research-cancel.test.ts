// Test del WIRING dell'annullamento della route (Step 21): con il motore
// mockato, verifichiamo che l'abort del segnale client (req.signal) e la
// disconnessione dello stream propaghino l'annullamento al segnale passato a
// runResearch. La SEMANTICA di cancellazione del motore reale (eventi
// cancelled/done) è già coperta dagli unit test dello Step 17.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchReport } from "@/lib/types";
import { POST as researchPost, researchRateLimiter } from "@/app/api/research/route";
import { runResearch } from "@/research/engine/engine";

vi.mock("@/research/engine/engine", () => ({
  runResearch: vi.fn(),
}));

const QUESTION = "In quale anno fu fondata l'Università di Pisa e da chi?";
const IP = "198.51.100.30";

function researchRequest(body: unknown, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/research", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": IP,
    },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });
}

function cancelledReport(input: { question: string; researchId?: string }): ResearchReport {
  const ts = new Date().toISOString();
  return {
    researchId: input.researchId ?? "res-mock",
    question: input.question,
    status: "cancelled",
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
      queriesUsed: 0,
      sourcesAnalyzed: 0,
      depthUsed: 0,
      llmCalls: 0,
      fetchAttempts: 0,
      fetchFailed: 0,
    },
    startedAt: ts,
    completedAt: ts,
    durationMs: 0,
  };
}

beforeEach(() => {
  researchRateLimiter.reset();
  vi.mocked(runResearch).mockReset();
});

describe("POST /api/research — propagazione dell'annullamento", () => {
  it("abort del segnale client → il segnale passato al motore viene abortito", async () => {
    // il mock resta in attesa finché il segnale non è abortito, poi termina
    vi.mocked(runResearch).mockImplementation(async (input, _deps, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return cancelledReport({ question: input.question, researchId: input.researchId });
    });

    const controller = new AbortController();
    const responsePromise = researchPost(researchRequest({ question: QUESTION }, controller.signal));
    const response = await responsePromise;
    expect(response.status).toBe(200);

    controller.abort(); // disconnessione del client
    const text = await response.text();

    expect(runResearch).toHaveBeenCalledTimes(1);
    const signalArg = vi.mocked(runResearch).mock.calls[0]![2];
    expect(signalArg.aborted).toBe(true);
    expect(text).toBe(""); // nessun evento emesso dal mock: chiusura pulita
  });

  it("disconnessione dello stream (cancel) → motore abortito", async () => {
    vi.mocked(runResearch).mockImplementation(async (input, _deps, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return cancelledReport({ question: input.question, researchId: input.researchId });
    });

    const response = await researchPost(researchRequest({ question: QUESTION }));
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    await reader.cancel(); // il client smette di leggere
    // attendiamo che il motore osservi l'abort
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runResearch).toHaveBeenCalledTimes(1);
    const signalArg = vi.mocked(runResearch).mock.calls[0]![2];
    expect(signalArg.aborted).toBe(true);
  });
});
