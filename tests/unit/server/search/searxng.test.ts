import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import { resetLimitsCache } from "@/lib/config/limits";
import { createLogger } from "@/lib/logger";
import {
  isIsoLikeDate,
  parseSearxngResults,
  searchSearxng,
  type SearchOutcome,
  type SearchQuery,
} from "@/lib/server/search/searxng";

const BASE_URL = "https://searxng.example.com";
const TOKEN = "shared-token-super-secret-42";

function fixture(name: string): string {
  return readFileSync(`tests/fixtures/searxng/${name}.json`, "utf8");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  authHeader?: string;
}

function fetchMock(...responses: Response[]): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ url: String(input), authHeader: headers?.Authorization });
    const next = responses[i];
    if (next === undefined) throw new Error("fetch chiamato più del previsto");
    i++;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

beforeEach(() => {
  vi.stubEnv("SEARXNG_BASE_URL", BASE_URL);
  vi.stubEnv("RESEARCH_INTERNAL_AUTH_TOKEN", TOKEN);
  resetEnvCache();
  resetLimitsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetLimitsCache();
});

const QUERY: SearchQuery = { query: "test query" };

describe("parseSearxngResults", () => {
  it("normalizza e scarta item malformati senza fallire", () => {
    const parsed = parseSearxngResults(JSON.parse(fixture("results-ok")), BASE_URL);
    expect(parsed.malformed).toBe(false);
    expect(parsed.items).toHaveLength(3);
    const [a, relative, badDate] = parsed.items;
    expect(a.url).toBe("https://example.com/a?utm_source=x&x=1");
    expect(a.engine).toBe("google");
    expect(a.publishedDate).toBe("2024-05-01T00:00:00+00:00");
    expect(relative.url).toBe("https://searxng.example.com/relative/path");
    expect(relative.engine).toBe("duckduckgo");
    expect(badDate.publishedDate).toBeUndefined(); // data non-ISO mai inventata
  });

  it("segnala malformed per body non-oggetto o senza results", () => {
    expect(parseSearxngResults("stringa", BASE_URL).malformed).toBe(true);
    expect(parseSearxngResults({}, BASE_URL).malformed).toBe(true);
    expect(parseSearxngResults({ results: "no" }, BASE_URL).malformed).toBe(true);
  });
});

describe("isIsoLikeDate", () => {
  it("accetta date ISO (anche solo data) e rifiuta il resto", () => {
    expect(isIsoLikeDate("2024-05-01T00:00:00Z")).toBe(true);
    expect(isIsoLikeDate("2024-05-01")).toBe(true);
    expect(isIsoLikeDate("non-iso-date")).toBe(false);
    expect(isIsoLikeDate("1/2/2024")).toBe(false);
    expect(isIsoLikeDate(undefined)).toBe(false);
  });
});

describe("searchSearxng", () => {
  it("chiama l'endpoint con parametri corretti e auth header", async () => {
    const { impl, calls } = fetchMock(jsonResponse(200, JSON.parse(fixture("results-ok"))));
    const outcome = (await searchSearxng(
      { query: "domanda", language: "it", timeRange: "week" },
      { fetchImpl: impl, maxAttempts: 1 },
    )) as Extract<SearchOutcome, { ok: true; empty: false }>;
    expect(outcome.ok).toBe(true);
    expect(outcome.empty).toBe(false);
    expect(outcome.items).toHaveLength(3);

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("domanda");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("language")).toBe("it");
    expect(url.searchParams.get("time_range")).toBe("week");
    expect(url.searchParams.get("safesearch")).toBe("1");
  });

  it("usa il token di autenticazione ma non lo logga", async () => {
    const lines: string[] = [];
    const logger = createLogger("search-test", { level: "debug", sink: (l) => lines.push(l) });
    const { impl, calls } = fetchMock(jsonResponse(200, JSON.parse(fixture("empty"))));
    await searchSearxng(QUERY, { fetchImpl: impl, maxAttempts: 1, logger });
    expect(calls[0].authHeader).toBe(`Bearer ${TOKEN}`);
    const all = JSON.stringify(lines);
    expect(all).not.toContain(TOKEN);
  });

  it("risultati vuoti -> empty (non errore)", async () => {
    const { impl } = fetchMock(jsonResponse(200, JSON.parse(fixture("empty"))));
    const outcome = await searchSearxng(QUERY, { fetchImpl: impl, maxAttempts: 1 });
    expect(outcome).toEqual({ ok: true, empty: true, items: [] });
  });

  it("non configurato: E_SEARCH_UNAVAILABLE senza chiamare fetch", async () => {
    vi.stubEnv("SEARXNG_BASE_URL", "");
    resetEnvCache();
    const { impl, calls } = fetchMock();
    const outcome = await searchSearxng(QUERY, { fetchImpl: impl, maxAttempts: 3 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("E_SEARCH_UNAVAILABLE");
      expect(outcome.error.retryable).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("401: nessun retry e body del provider mai riflesso", async () => {
    const { impl, calls } = fetchMock(jsonResponse(401, JSON.parse(fixture("error-500"))));
    const outcome = await searchSearxng(QUERY, { fetchImpl: impl, maxAttempts: 3 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.retryable).toBe(false);
      expect(outcome.error.message).not.toContain("Internal Server Error");
      expect(outcome.error.message).not.toContain(TOKEN);
    }
    expect(calls).toHaveLength(1);
  });

  it("500: retry controllato poi E_SEARCH_UNAVAILABLE ritentabile", async () => {
    const { impl, calls } = fetchMock(
      jsonResponse(500, JSON.parse(fixture("error-500"))),
      jsonResponse(500, JSON.parse(fixture("error-500"))),
    );
    const outcome = await searchSearxng(QUERY, { fetchImpl: impl, maxAttempts: 2, baseDelayMs: 1 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.retryable).toBe(true);
    }
    expect(calls).toHaveLength(2);
  });

  it("timeout: E_SEARCH_TIMEOUT", async () => {
    const hanging = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      })) as typeof fetch;
    const outcome = await searchSearxng(QUERY, {
      fetchImpl: hanging,
      timeoutMs: 10,
      maxAttempts: 1,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("E_SEARCH_TIMEOUT");
  });

  it("body malformato (200): errore non ritentabile", async () => {
    const { impl } = fetchMock(jsonResponse(200, fixture("malformed")));
    const outcome = await searchSearxng(QUERY, { fetchImpl: impl, maxAttempts: 1 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.retryable).toBe(false);
  });
});
