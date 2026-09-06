// Deduplicazione di risultati di ricerca e candidati fonte (funzioni pure).
// Regola: risorse diverse dello stesso dominio NON vengono mai fuse.

import type { SearchResultItem, SourceCandidate } from "@/lib/types";
import { canonicalizeUrl, dedupeKey } from "./canonical";

/** Risultato deduplicato: engine fusi e conteggio delle occorrenze. */
export interface DeduplicatedSearchItem extends SearchResultItem {
  /** Quante volte la stessa risorsa è comparsa (engine diversi contano). */
  occurrences: number;
}

function keyOf(item: SearchResultItem): string {
  const canonical = canonicalizeUrl(item.url);
  return canonical ? dedupeKey(canonical) : item.url;
}

function mergeEngines(a: string, b: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const engine of [...a.split(","), ...b.split(",")]) {
    const e = engine.trim();
    if (e === "" || seen.has(e)) continue;
    seen.add(e);
    merged.push(e);
  }
  return merged.join(",");
}

/**
 * Deduplica i risultati di ricerca per risorsa canonica: tiene l'item con lo
 * snippet più lungo (a parità, il primo incontrato), fonde gli engine e conta
 * le occorrenze. Preserva l'ordine di prima comparsa.
 */
export function dedupeSearchResults(items: SearchResultItem[]): DeduplicatedSearchItem[] {
  const byKey = new Map<string, DeduplicatedSearchItem>();

  for (const item of items) {
    const key = keyOf(item);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { ...item, occurrences: 1 });
      continue;
    }
    // Fonde engine e tiene lo snippet migliore.
    const longer = item.snippet.length > existing.snippet.length ? item : existing;
    byKey.set(key, {
      url: existing.url,
      title: longer.title.length > 0 ? longer.title : existing.title,
      snippet: longer.snippet,
      engine: mergeEngines(existing.engine, item.engine),
      publishedDate: existing.publishedDate ?? item.publishedDate,
      occurrences: existing.occurrences + 1,
    });
  }

  return [...byKey.values()];
}

/**
 * Fonde candidati di round diversi (stessa risorsa ricomparsa): aggiorna
 * `occurrences` e gli engine, conservando il primo `sourceId`. I candidati
 * nuovi vengono aggiunti in coda. Mai duplicare la fonte.
 */
export function mergeCandidates(
  existing: SourceCandidate[],
  incoming: SourceCandidate[],
): SourceCandidate[] {
  const out: SourceCandidate[] = existing.map((c) => ({ ...c }));
  const byKey = new Map<string, SourceCandidate>(out.map((c) => [c.dedupeKey, c]));

  for (const candidate of incoming) {
    const current = byKey.get(candidate.dedupeKey);
    if (current === undefined) {
      out.push({ ...candidate });
      byKey.set(candidate.dedupeKey, candidate);
      continue;
    }
    const merged: SourceCandidate = {
      ...current,
      engines: mergeEngines(current.engines.join(","), candidate.engines.join(","))
        .split(",")
        .filter((e) => e !== ""),
      occurrences: current.occurrences + candidate.occurrences,
      title: candidate.title.length > current.title.length ? candidate.title : current.title,
      snippet: candidate.snippet.length > current.snippet.length ? candidate.snippet : current.snippet,
      rankScore: current.rankScore ?? candidate.rankScore,
    };
    const index = out.indexOf(current);
    out[index] = merged;
    byKey.set(candidate.dedupeKey, merged);
  }

  return out;
}
