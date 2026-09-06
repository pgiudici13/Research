import { describe, expect, it } from "vitest";
import {
  type ScoreableSource,
  type ScoringContext,
  WEIGHTS,
  rankCandidates,
  scoreCandidate,
  tokenize,
} from "@/research/scoring/score";

/** Istante fisso: 2026-01-02T00:00:00Z. */
const NOW = Date.UTC(2026, 0, 2);

function ctx(over: Partial<ScoringContext> = {}): ScoringContext {
  return { query: "quando fu fondata l'università di Pisa", now: NOW, ...over };
}

function source(over: Partial<ScoreableSource> = {}): ScoreableSource {
  return {
    domain: "example.org",
    title: "",
    snippet: "",
    engines: ["google"],
    occurrences: 1,
    ...over,
  };
}

describe("tokenize", () => {
  it("rimuove stopword, punteggiatura e token troppo corti", () => {
    expect(tokenize("Quando fu fondata l'Università di Pisa?")).toEqual([
      "fondata",
      "università",
      "pisa",
    ]);
  });

  it("gestisce testo vuoto e solo stopword", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("the and che per con")).toEqual([]);
  });
});

describe("scoreCandidate — componenti normalizzati e pesi", () => {
  it("rilevanza: il titolo pesa più dello snippet (title > snippet)", () => {
    const titleOnly = source({
      title: "Università di Pisa fondata nel 1343",
      snippet: "",
    });
    const snippetOnly = source({
      title: "",
      snippet: "L'ateneo fu fondata a Pisa nel 1343",
    });
    const titleScore = scoreCandidate(titleOnly, ctx());
    const snippetScore = scoreCandidate(snippetOnly, ctx());
    expect(titleScore.components.relevance).toBeGreaterThan(
      snippetScore.components.relevance,
    );
    expect(snippetScore.components.relevance).toBeGreaterThan(0);
  });

  it("overlap pieno su titolo e snippet dà rilevanza 1", () => {
    const s = source({
      title: "Università di Pisa fondata nel 1343",
      snippet: "L'Università di Pisa fu fondata nel 1343.",
    });
    expect(scoreCandidate(s, ctx()).components.relevance).toBe(1);
  });

  it("nessun token di query: rilevanza neutra 0.5 (non inventa nulla)", () => {
    const s = source({
      title: "Catalogo prodotti",
      snippet: "Elenco completo degli articoli in vendita.",
    });
    const score = scoreCandidate(s, ctx({ query: "e per il che" }));
    expect(score.components.relevance).toBe(0.5);
  });

  it("ricchezza: titolo e snippet presenti e lunghi danno 1", () => {
    const rich = source({ title: "Titolo", snippet: "x".repeat(200) });
    const empty = source();
    expect(scoreCandidate(rich, ctx()).components.richness).toBe(1);
    expect(scoreCandidate(empty, ctx()).components.richness).toBe(0);
  });

  it("ogni componente è nel range [0,1] e le chiavi coincidono con WEIGHTS", () => {
    const s = source({
      title: "Università di Pisa",
      snippet: "storia della fondazione dell'ateneo toscano nel medioevo",
      engines: ["google", "bing", "startpage"],
      occurrences: 4,
      publishedDate: "2025-06-01",
    });
    const { components } = scoreCandidate(s, ctx({ requireFreshness: true }));
    expect(Object.keys(components).sort()).toEqual(Object.keys(WEIGHTS).sort());
    for (const value of Object.values(components)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("WEIGHTS: somma 1 e valori positivi espliciti", () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    for (const weight of Object.values(WEIGHTS)) expect(weight).toBeGreaterThan(0);
  });
});

describe("scoreCandidate — freschezza", () => {
  it("data recente e freschezza richiesta: punteggio alto con decay lineare", () => {
    const recent = source({ publishedDate: "2025-12-01" });
    const score = scoreCandidate(recent, ctx({ requireFreshness: true })).components
      .freshness;
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("data molto vecchia: freschezza 0", () => {
    const stale = source({ publishedDate: "2019-01-01" });
    expect(
      scoreCandidate(stale, ctx({ requireFreshness: true })).components.freshness,
    ).toBe(0);
  });

  it("data assente: 0.5 neutro con flag unknownDate", () => {
    const s = scoreCandidate(source(), ctx({ requireFreshness: true }));
    expect(s.components.freshness).toBe(0.5);
    expect(s.flags).toContain("unknownDate");
  });

  it("la data ignota non domina: differenza totale <= peso della freschezza", () => {
    const dated = source({ publishedDate: "2025-12-01" });
    const undated = source();
    const a = scoreCandidate(dated, ctx({ requireFreshness: true })).total;
    const b = scoreCandidate(undated, ctx({ requireFreshness: true })).total;
    expect(Math.abs(a - b)).toBeLessThanOrEqual(WEIGHTS.freshness);
    expect(a).toBeGreaterThan(b);
  });

  it("freschezza NON richiesta: data presente o assente non cambiano il totale", () => {
    const dated = scoreCandidate(source({ publishedDate: "2019-01-01" }), ctx());
    const undated = scoreCandidate(source(), ctx());
    expect(dated.components.freshness).toBe(0.5);
    expect(undated.components.freshness).toBe(0.5);
    expect(dated.total).toBe(undated.total);
  });
});

describe("scoreCandidate — autorevolezza e indipendenza", () => {
  it("TLD .gov/.edu ricevono il bonus, gli altri no", () => {
    expect(
      scoreCandidate(source({ domain: "stats.gov" }), ctx()).components.authority,
    ).toBe(1);
    expect(
      scoreCandidate(source({ domain: "university.edu" }), ctx()).components.authority,
    ).toBe(1);
    expect(
      scoreCandidate(source({ domain: "example.com" }), ctx()).components.authority,
    ).toBe(0);
    expect(
      scoreCandidate(source({ domain: "gov.uk" }), ctx()).components.authority,
    ).toBe(0); // .uk non è nella lista: nessun bonus inventato
  });

  it("la lista authorityDomains è un hook: vuota di default, funziona se configurata", () => {
    expect(scoreCandidate(source({ domain: "unipi.it" }), ctx()).components.authority).toBe(
      0,
    );
    const withHook = ctx({ authorityDomains: new Set(["unipi.it"]) });
    expect(
      scoreCandidate(source({ domain: "www.unipi.it" }), withHook).components.authority,
    ).toBe(1);
    expect(
      scoreCandidate(source({ domain: "unipi.it.evil.example" }), withHook).components
        .authority,
    ).toBe(0); // il suffisso deve essere sul confine di label
  });

  it("independence: satura a 3+ engine/occorrenze, segnale debole", () => {
    const single = source();
    const multi = source({ engines: ["a", "b", "c"], occurrences: 3 });
    expect(
      scoreCandidate(single, ctx()).components.independence,
    ).toBeCloseTo(1 / 3, 5);
    expect(scoreCandidate(multi, ctx()).components.independence).toBe(1);
    const a = scoreCandidate(single, ctx()).total;
    const b = scoreCandidate(multi, ctx()).total;
    expect(b).toBeGreaterThan(a);
  });

  it("lo stesso dominio su risorse diverse non influenza il confronto", () => {
    const a = source({ domain: "example.org", title: "Documento uno" });
    const b = source({ domain: "example.org", title: "Documento due" });
    const sa = scoreCandidate(a, ctx());
    const sb = scoreCandidate(b, ctx());
    expect(sa.components.authority).toBe(sb.components.authority);
    expect(sa.total).toBe(sb.total);
  });
});

describe("scoreCandidate — euristica fonte primaria", () => {
  it("dominio che contiene un token lungo della domanda: bonus marcato heuristic", () => {
    const s = source({ domain: "www.istat.it" });
    const score = scoreCandidate(s, ctx({ query: "statistiche istat sulla popolazione" }));
    expect(score.components.primarySource).toBe(0.15);
    expect(score.flags).toContain("primary-source-heuristic");
  });

  it("nessun match lessicale: nessun bonus e nessun flag", () => {
    const score = scoreCandidate(source({ domain: "example.com" }), ctx());
    expect(score.components.primarySource).toBe(0);
    expect(score.flags).not.toContain("primary-source-heuristic");
  });
});

describe("anti-pattern: il ranking non è verità", () => {
  it("uno snippet che 'contiene la risposta' non marca la fonte come vera", () => {
    const answerInSnippet = source({
      domain: "stats.gov",
      title: "Dati storici della città",
      snippet:
        "La risposta esatta è il millesimo trecentoquarantatré, anno di fondazione documentato nelle cronache cittadine del comune toscano.",
      engines: ["a", "b", "c"],
      occurrences: 5,
    });
    const score = scoreCandidate(answerInSnippet, ctx());
    // nessun segnale di rilevanza (zero overlap coi token della domanda)…
    expect(score.components.relevance).toBe(0);
    // …e l'API non espone alcun concetto di veridicità/accuratezza
    for (const key of Object.keys(score.components)) {
      expect(key).not.toMatch(/verif|verit|truth|accura|proof|correct/i);
    }
    expect(score.flags.join(" ")).not.toMatch(/verif|verit|truth|accura|proof|correct/i);
  });

  it("un punteggio alto non equivale a fonte verificata", () => {
    const boosted = scoreCandidate(
      source({
        domain: "stats.gov",
        title: "Ateneo toscano: la fondazione dell'università di Pisa nel 1343",
        snippet: "L'Università di Pisa fu fondata nel 1343: documenti dell'archivio.",
        engines: ["a", "b", "c", "d"],
        occurrences: 6,
      }),
      ctx({ requireFreshness: true }),
    );
    expect(boosted.total).toBeGreaterThan(0.7);
    expect(boosted.flags).not.toContain("verified");
    expect(boosted.flags).not.toContain("true");
  });
});

describe("rankCandidates", () => {
  it("ordina per totale decrescente, stabile e senza scartare nulla", () => {
    const candidates = [
      source({
        domain: "unipi.it",
        title: "Università di Pisa: la fondazione del 1343",
        snippet: "Storia dell'ateneo pisano fondato nel Trecento.",
        engines: ["a", "b", "c"],
        occurrences: 3,
        publishedDate: "2025-06-01",
      }),
      source({ title: "Ricette di cucina toscana", snippet: "Pasta e dolci della tradizione." }),
      source({ domain: "stats.gov", title: "Dati statistici nazionali", snippet: "CSV e tabelle." }),
      source({ title: "Università di Pisa", snippet: "Sede centrale dell'ateneo." }),
    ];

    const ranked = rankCandidates(candidates, ctx({ requireFreshness: true }));
    expect(ranked).toHaveLength(candidates.length);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score.total).toBeGreaterThanOrEqual(ranked[i].score.total);
    }
    // il candidato rilevante e recente è in cima
    expect(ranked[0].candidate.domain).toBe("unipi.it");
    expect(ranked[0].candidate.title).toContain("fondazione del 1343");
  });

  it("è stabile: a parità di totale mantiene l'ordine di ingresso", () => {
    const a = source({ title: "Università di Pisa: pagina ufficiale" });
    const b = source({ title: "Università di Pisa: pagina ufficiale" });
    const c = source({ title: "Argomento senza relazione con la domanda posta" });
    const ranked = rankCandidates([a, b, c], ctx());
    expect(ranked[0].candidate).toBe(a);
    expect(ranked[1].candidate).toBe(b);
    expect(ranked[0].score.total).toBe(ranked[1].score.total);
    expect(ranked[2].score.total).toBeLessThan(ranked[0].score.total);
  });
});
