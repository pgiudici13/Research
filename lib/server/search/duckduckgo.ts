// server-only — fallback gratuito per la ricerca quando SearXNG/Pi non è
// raggiungibile. Usa l'HTML pubblico di DuckDuckGo e restituisce solo risultati
// normalizzati; non espone mai la query dal browser né accetta host arbitrari.

import { getLimits } from "@/lib/config/limits";
import { appError, toErrorInfo } from "@/lib/errors";
import type { SearchResultItem } from "@/lib/types";
import type { SearchOutcome, SearchQuery, SearchRunContext } from "./searxng";

const ENDPOINTS = [
  "https://html.duckduckgo.com/html/",
  "https://lite.duckduckgo.com/lite/",
  "https://duckduckgo.com/html/",
] as const;
const USER_AGENT = "DeepResearch/0.1 (server; fallback search)";
const STOP_WORDS = new Set([
  "chi", "che", "cosa", "come", "quale", "quali", "sono", "ha", "il", "la", "le", "lo",
  "gli", "di", "del", "della", "dei", "degli", "in", "per", "con", "una", "un", "e", "o",
  "the", "who", "what", "which", "is", "are", "of", "the", "and", "for",
]);

export function compactSearchQuery(query: string): string | undefined {
  const compact = query
    .replace(/[^\p{L}\p{N}._-]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.toLocaleLowerCase())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
    .slice(0, 8)
    .join(" ");
  return compact && compact !== query.trim() ? compact : undefined;
}

function queryVariants(query: string): string[] {
  const compact = compactSearchQuery(query);
  return compact ? [query, compact] : [query];
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function parseDuckDuckGoResults(html: string): SearchResultItem[] {
  const items: SearchResultItem[] = [];
  // DDG non garantisce l'ordine degli attributi nell'HTML. Catturiamo prima
  // il tag completo e poi estraiamo class/href senza assumere una sequenza.
  const pattern = /<a\b([^>]*class="[^"]*(?:\bresult__a\b|\bresult-link\b)[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    let url: URL;
    try {
      const href = match[1].match(/\bhref="([^"]+)"/i)?.[1];
      if (!href) continue;
      const raw = decodeHtml(href);
      const parsed = new URL(raw, ENDPOINTS[0]);
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
    for (const variant of queryVariants(query.query)) {
      for (const endpoint of ENDPOINTS) {
        const url = new URL(endpoint);
        url.searchParams.set("q", variant);
        const response = await fetchImpl(url, {
          headers: { Accept: "text/html", "User-Agent": USER_AGENT },
          signal,
        });
        if (!response.ok) continue;
        const items = parseDuckDuckGoResults(await response.text());
        if (items.length > 0) return { ok: true, empty: false, items };
      }
    }

    return { ok: true, empty: true, items: [] };
  } catch {
    return { ok: false, error: toErrorInfo(appError("E_SEARCH_UNAVAILABLE", { phase: "search", retryable: false })) };
  } finally {
    clearTimeout(timeout);
  }
}
