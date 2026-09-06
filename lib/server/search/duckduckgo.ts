// server-only — fallback gratuito per la ricerca quando SearXNG/Pi non è
// raggiungibile. Usa l'HTML pubblico di DuckDuckGo e restituisce solo risultati
// normalizzati; non espone mai la query dal browser né accetta host arbitrari.

import { getLimits } from "@/lib/config/limits";
import { appError, toErrorInfo } from "@/lib/errors";
import type { SearchResultItem } from "@/lib/types";
import type { SearchOutcome, SearchQuery, SearchRunContext } from "./searxng";

const ENDPOINT = "https://html.duckduckgo.com/html/";
const USER_AGENT = "DeepResearch/0.1 (server; fallback search)";

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseResults(html: string): SearchResultItem[] {
  const items: SearchResultItem[] = [];
  const pattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    let url: URL;
    try {
      const raw = decodeHtml(match[1]);
      const parsed = new URL(raw, ENDPOINT);
      const redirected = parsed.searchParams.get("uddg");
      url = new URL(redirected ? decodeURIComponent(redirected) : parsed.href);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const title = decodeHtml(match[2].replace(/<[^>]+>/g, "").trim()).slice(0, 300);
    if (!title) continue;
    items.push({ url: url.href, title, snippet: "", engine: "duckduckgo" });
    if (items.length >= getLimits().maxSearchResultsPerQuery) break;
  }
  return items;
}

export async function searchDuckDuckGo(
  query: SearchQuery,
  ctx: SearchRunContext = {},
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SearchOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getLimits().searchTimeoutMs);
  try {
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
    const url = new URL(ENDPOINT);
    url.searchParams.set("q", query.query);
    const response = await fetchImpl(url, {
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
      signal,
    });
    if (!response.ok) {
      return { ok: false, error: toErrorInfo(appError("E_SEARCH_UNAVAILABLE", { phase: "search", retryable: false })) };
    }
    const items = parseResults(await response.text());
    return items.length === 0 ? { ok: true, empty: true, items: [] } : { ok: true, empty: false, items };
  } catch {
    return { ok: false, error: toErrorInfo(appError("E_SEARCH_UNAVAILABLE", { phase: "search", retryable: false })) };
  } finally {
    clearTimeout(timeout);
  }
}
