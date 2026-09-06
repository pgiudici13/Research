import { describe, expect, it } from "vitest";
import type { SearchResultItem, SourceCandidate } from "@/lib/types";
import { dedupeSearchResults, mergeCandidates } from "@/research/urls/dedupe";

function item(url: string, engine: string, snippet = "snippet", title = "T"): SearchResultItem {
  return { url, title, snippet, engine };
}

describe("dedupeSearchResults", () => {
  it("fonde item con URL identico da engine diversi", () => {
    const result = dedupeSearchResults([
      item("https://x.com/a", "google", "breve", "Prima"),
      item("https://x.com/a", "duckduckgo", "snippet molto più lungo", "Seconda"),
      item("https://x.com/b", "bing", "altra"),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe("https://x.com/a");
    expect(result[0].engine).toBe("google,duckduckgo");
    expect(result[0].occurrences).toBe(2);
    // prevale lo snippet più lungo, ma resta il primo title non vuoto
    expect(result[0].snippet).toBe("snippet molto più lungo");
    expect(result[1].engine).toBe("bing");
    expect(result[1].occurrences).toBe(1);
  });

  it("fonde risorse uguali dopo canonicalizzazione (tracking rimosso)", () => {
    const result = dedupeSearchResults([
      item("https://x.com/p?utm_source=s&id=1", "google"),
      item("https://x.com/p?id=1", "brave"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].occurrences).toBe(2);
    expect(result[0].engine).toBe("google,brave");
  });

  it("non fonde http vs https né path diversi dello stesso dominio", () => {
    const result = dedupeSearchResults([
      item("http://x.com/a", "google"),
      item("https://x.com/a", "google"),
      item("https://x.com/b", "google"),
    ]);
    expect(result).toHaveLength(3);
  });

  it("conta tre engine come occorrenze 3", () => {
    const result = dedupeSearchResults([
      item("https://x.com/a", "google"),
      item("https://x.com/a", "duckduckgo"),
      item("https://x.com/a", "bing"),
    ]);
    expect(result[0].occurrences).toBe(3);
    expect(result[0].engine).toBe("google,duckduckgo,bing");
  });
});

describe("mergeCandidates", () => {
  function candidate(url: string, sourceId: string, engines: string[], occurrences = 1): SourceCandidate {
    return {
      sourceId,
      url,
      canonicalUrl: url,
      dedupeKey: url, // chiave già canonica nei test
      domain: "x.com",
      title: "T",
      snippet: "S",
      engines,
      occurrences,
    };
  }

  it("aggiorna occurrences/engine conservando il primo sourceId", () => {
    const existing = [candidate("https://x.com/a", "src-1", ["google"])];
    const incoming = [candidate("https://x.com/a", "src-2", ["duckduckgo"])];
    const merged = mergeCandidates(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].sourceId).toBe("src-1"); // mai duplicare la fonte
    expect(merged[0].occurrences).toBe(2);
    expect(merged[0].engines).toEqual(["google", "duckduckgo"]);
  });

  it("aggiunge in coda i candidati nuovi e non muta l'input", () => {
    const existing = [candidate("https://x.com/a", "src-1", ["google"])];
    const snapshot = JSON.stringify(existing);
    const merged = mergeCandidates(existing, [
      candidate("https://x.com/a", "src-2", ["bing"]),
      candidate("https://x.com/b", "src-3", ["google"]),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[1].sourceId).toBe("src-3");
    expect(JSON.stringify(existing)).toBe(snapshot); // immutabilità
  });

  it("non fonde mai risorse diverse dello stesso dominio", () => {
    const merged = mergeCandidates([], [
      candidate("https://x.com/a", "src-1", ["google"]),
      candidate("https://x.com/b", "src-2", ["google"]),
    ]);
    expect(merged).toHaveLength(2);
  });
});
