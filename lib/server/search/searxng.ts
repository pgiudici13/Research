// server-only — client SearXNG (formato JSON), raggiunto SOLO dal backend
// attraverso il Cloudflare Tunnel (SEARXNG_BASE_URL). MAI importare da
// codice client. Il token di autenticazione Vercel->Pi non viene mai loggato.

import { getEnv } from "@/lib/config/env";
import { getLimits } from "@/lib/config/limits";
import { appError, isAppError, toErrorInfo } from "@/lib/errors";
import { assertAllowedFixedHost } from "@/lib/http/ssrf";
import { createLogger, type Logger } from "@/lib/logger";
import { safe, obj, opt, str } from "@/lib/validate/schema";
import type { ErrorInfo, SearchResultItem } from "@/lib/types";

export type SearxngTimeRange = "day" | "week" | "month" | "year";

export interface SearchQuery {
  query: string;
  language?: string;
  timeRange?: SearxngTimeRange;
  pageno?: number;
}

export type SearchOutcome =
  | { ok: true; empty: true; items: [] }
  | { ok: false; error: ErrorInfo }
  | { ok: true; empty: false; items: SearchResultItem[] };

export interface SearchRunContext {
  researchId?: string;
  signal?: AbortSignal;
  logger?: Logger;
}

/** Port usata dal motore (Step 17): non lancia mai, restituisce un outcome. */
export interface SearchPort {
  (query: SearchQuery, ctx: SearchRunContext): Promise<SearchOutcome>;
}

export interface SearxngOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  logger?: Logger;
  /** Timeout per singola chiamata (default: limits.searchTimeoutMs). */
  timeoutMs?: number;
  /** Tentativi HTTP totali (default: limits.searchMaxAttempts). */
  maxAttempts?: number;
  baseDelayMs?: number;
}

const USER_AGENT = "DeepResearch/0.1 (server)";

// --- Parsing e normalizzazione (pure, esportate per i test) --------------------

interface RawSearchItem {
  url?: string;
  title?: string;
  content?: string;
  engine?: string;
  publishedDate?: string;
}

const RAW_ITEM = obj<RawSearchItem>({
  url: str(1),
  title: opt(str()),
  content: opt(str()),
  engine: opt(str()),
  publishedDate: opt(str()),
});

const TITLE_MAX = 300;
const SNIPPET_MAX = 1_000;

/** Data solo se sembra ISO-8601 valida; altrimenti undefined (mai inventata). */
export function isIsoLikeDate(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function normalizeItem(raw: unknown, baseUrl: string): SearchResultItem | null {
  const parsed = safe(RAW_ITEM, raw);
  if (!parsed.ok) return null;
  const item = parsed.value;

  let url: URL;
  try {
    url = new URL(item.url as string, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const publishedDate = isIsoLikeDate(item.publishedDate) ? item.publishedDate : undefined;
  return {
    url: url.href,
    title: (item.title ?? "").slice(0, TITLE_MAX),
    snippet: (item.content ?? "").slice(0, SNIPPET_MAX),
    engine: item.engine ?? "",
    publishedDate,
  };
}

export interface ParsedSearchResults {
  malformed: boolean;
  items: SearchResultItem[];
}

/**
 * Valida/normalizza il body JSON di SearXNG. Gli item malformati vengono
 * scartati singolarmente (mai fallire l'intera risposta per un item rotto).
 */
export function parseSearxngResults(raw: unknown, baseUrl: string): ParsedSearchResults {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { malformed: true, items: [] };
  }
  const results = (raw as Record<string, unknown>).results;
  if (!Array.isArray(results)) {
    return { malformed: true, items: [] };
  }
  const items: SearchResultItem[] = [];
  for (const item of results) {
    const normalized = normalizeItem(item, baseUrl);
    if (normalized !== null) items.push(normalized);
  }
  return { malformed: false, items };
}

// --- Client ---------------------------------------------------------------------

function toOutcomeError(err: unknown): ErrorInfo {
  // Gli errori interni non-AppError diventano E_INTERNAL via toErrorInfo;
  // qui gestiamo i codici applicativi.
  return toErrorInfo(err);
}

function allowHttpForDev(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
  );
}

/**
 * Interroga SearXNG e restituisce un outcome (non lancia mai).
 * - base URL assente -> E_SEARCH_UNAVAILABLE (unconfigured, non ritentabile);
 * - 401/403 -> non ritentabile, body mai riflesso;
 * - 429/5xx/timeout/rete -> ritentabile;
 * - risultati assenti/vuoti -> `{ ok: true, empty: true }` (non è un errore).
 */
export async function searchSearxng(
  query: SearchQuery,
  options: SearxngOptions = {},
): Promise<SearchOutcome> {
  const {
    fetchImpl = globalThis.fetch,
    signal,
    logger = createLogger("search"),
    timeoutMs,
    maxAttempts,
    baseDelayMs,
  } = options;

  const env = getEnv();
  const baseUrl = env.searxngBaseUrl;
  if (!baseUrl) {
    logger.warn("search.unconfigured", { query: query.query });
    return fail(appError("E_SEARCH_UNAVAILABLE", { retryable: false, details: { unconfigured: true } }));
  }

  let base: URL;
  try {
    base = assertAllowedFixedHost({ baseUrl, allowHttp: allowHttpForDev(new URL(baseUrl)) });
  } catch (err) {
    return fail(err);
  }

  const endpoint = new URL(base.origin);
  endpoint.pathname = "/search";
  const params = new URLSearchParams({
    q: query.query,
    format: "json",
    language: query.language ?? "auto",
    safesearch: "1",
    pageno: String(query.pageno ?? 1),
  });
  if (query.timeRange) params.set("time_range", query.timeRange);
  endpoint.search = params.toString();

  const limits = getLimits();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (env.researchInternalAuthToken) {
    headers.Authorization = `Bearer ${env.researchInternalAuthToken}`;
  }

  const startedAt = Date.now();
  const attempts = maxAttempts ?? limits.searchMaxAttempts;

  return searchAttempt(query, endpoint, headers, startedAt, {
    fetchImpl,
    signal,
    logger,
    timeoutMs: timeoutMs ?? limits.searchTimeoutMs,
    attempts,
    baseDelayMs: baseDelayMs ?? 100,
  });
}

function fail(err: unknown): SearchOutcome {
  return { ok: false, error: isAppError(err) ? toOutcomeError(err) : toOutcomeError(new Error()) };
}

async function searchAttempt(
  query: SearchQuery,
  endpoint: URL,
  headers: Record<string, string>,
  startedAt: number,
  opts: {
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
    logger: Logger;
    timeoutMs: number;
    attempts: number;
    baseDelayMs: number;
  },
): Promise<SearchOutcome> {
  const { fetchImpl, signal, logger, timeoutMs, attempts, baseDelayMs } = opts;
  const { retry } = await import("@/lib/http/retry");

  try {
    const parsed = await retry({
      attempts,
      baseDelayMs,
      maxDelayMs: 1_000,
      signal,
      isRetryable: (err) => (err as { retryable?: boolean }).retryable === true,
      fn: async () => {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

        let response: Response;
        try {
          response = await fetchImpl(endpoint.href, {
            method: "GET",
            headers,
            signal: combined,
            cache: "no-store",
          });
        } catch (err) {
          if (timeoutSignal.aborted) throw appError("E_SEARCH_TIMEOUT", { phase: "search" });
          if (signal?.aborted) throw err;
          throw appError("E_SEARCH_UNAVAILABLE", { phase: "search" });
        }

        const text = await response.text();
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          logger.warn("search.http_error", {
            status: response.status,
            query: query.query,
            retryable,
          });
          throw appError("E_SEARCH_UNAVAILABLE", {
            phase: "search",
            retryable,
            details: { httpStatus: response.status },
          });
        }

        let raw: unknown;
        try {
          raw = JSON.parse(text) as unknown;
        } catch {
          throw appError("E_SEARCH_UNAVAILABLE", { phase: "search", retryable: false });
        }
        return { raw };
      },
    });

    const result = parseSearxngResults(parsed.raw, endpoint.origin);
    if (result.malformed) {
      logger.warn("search.malformed", { query: query.query });
      return fail(appError("E_SEARCH_UNAVAILABLE", { phase: "search", retryable: false }));
    }

    logger.info("search.completed", {
      query: query.query,
      results: result.items.length,
      durationMs: Date.now() - startedAt,
    });

    if (result.items.length === 0) {
      return { ok: true, empty: true, items: [] };
    }
    const capped = result.items.slice(0, getLimits().maxSearchResultsPerQuery);
    return { ok: true, empty: false, items: capped };
  } catch (err) {
    if (signal?.aborted) throw err; // annullamento: propaga (mai outcome "errore")
    return fail(err);
  }
}
