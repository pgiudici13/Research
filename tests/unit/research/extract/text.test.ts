import { describe, expect, it } from "vitest";
import {
  isProbablyReadable,
  normalizeWhitespace,
  splitIntoPassages,
  truncateToChars,
} from "@/research/extract/text";

describe("normalizeWhitespace", () => {
  it("collassa spazi, tab e newline e rifila i bordi", () => {
    expect(normalizeWhitespace("  a\t\tb \n c  ")).toBe("a b c");
  });

  it("gestisce stringhe vuote e solo spazi", () => {
    expect(normalizeWhitespace("")).toBe("");
    expect(normalizeWhitespace("   \n  ")).toBe("");
  });

  it("preserva spazi singoli tra le parole", () => {
    expect(normalizeWhitespace("parola  seconda  terza")).toBe("parola seconda terza");
  });
});

describe("truncateToChars", () => {
  it("non tocca testi sotto il limite", () => {
    const r = truncateToChars("breve testo", 50);
    expect(r.text).toBe("breve testo");
    expect(r.truncated).toBe(false);
  });

  it("tronca a un confine di frase e marca truncated", () => {
    const r = truncateToChars("Prima frase completa. Seconda frase che va tagliata via.", 20);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("…")).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(22);
  });

  it("preferisce il confine di riga quando è nella finestra del limite", () => {
    const text = "AAAAA BBBBB CCCCC DDDDD EEEEE\nresto della pagina che deve sparire";
    const r = truncateToChars(text, 36);
    expect(r.truncated).toBe(true);
    // taglia alla newline (indice 29, dentro la finestra 29..36), non a metà parola
    expect(r.text.startsWith("AAAAA BBBBB CCCCC DDDDD EEEEE")).toBe(true);
    expect(r.text.endsWith("…")).toBe(true);
    expect(r.text).not.toContain("resto della pagina");
  });

  it("taglia netto al limite quando non esistono confini naturali", () => {
    const long = "x".repeat(100);
    const r = truncateToChars(long, 50);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe(`${"x".repeat(50)}…`);
  });

  it("un testo esattamente al limite non viene toccato", () => {
    const text = "abcdefghij";
    expect(truncateToChars(text, 10).truncated).toBe(false);
  });
});

describe("splitIntoPassages", () => {
  const paragraph =
    "Questo è un paragrafo con abbastanza parole da superare comodamente qualunque soglia minima di leggibilità usata nei test del progetto di ricerca. ";

  it("tiene i passaggi sotto il limite massimo", () => {
    const text = [paragraph, paragraph, paragraph].join("\n");
    const passages = splitIntoPassages(text, 200, 40);
    expect(passages.length).toBeGreaterThan(1);
    for (const p of passages) {
      expect(p.length).toBeLessThanOrEqual(200);
      expect(p.trim().length).toBeGreaterThan(0);
    }
  });

  it("è deterministico", () => {
    const text = [paragraph, paragraph].join("\n\n");
    expect(splitIntoPassages(text, 150, 30)).toEqual(splitIntoPassages(text, 150, 30));
  });

  it("il primo passaggio inizia dall'inizio e l'ultimo arriva alla fine", () => {
    const head = "INIZIO_MARCA_12345 ";
    const tail = " FINE_MARCA_67890";
    const text = head + paragraph.repeat(3) + tail;
    const passages = splitIntoPassages(text, 180, 40);
    expect(passages[0].startsWith("INIZIO_MARCA_12345")).toBe(true);
    expect(passages[passages.length - 1].includes("FINE_MARCA_67890")).toBe(true);
  });

  it("spezza una singola riga molto lunga senza buchi", () => {
    const line = "parola ".repeat(400); // ~2800 caratteri su una sola riga
    const passages = splitIntoPassages(line, 500, 60);
    expect(passages.length).toBeGreaterThan(4);
    const joined = passages.join(" ");
    expect(joined.length).toBeGreaterThan(2000);
    for (const p of passages) expect(p.length).toBeLessThanOrEqual(500);
  });

  it("gestisce testo vuoto e righe bianche", () => {
    expect(splitIntoPassages("")).toEqual([]);
    expect(splitIntoPassages("\n\n   \n")).toEqual([]);
  });
});

describe("isProbablyReadable", () => {
  it("riconosce prosa leggibile", () => {
    const prose = "Questa è una frase di senso compiuto con molte lettere alfabetiche e contenuto informativo sufficiente.";
    expect(isProbablyReadable(prose)).toBe(true);
  });

  it("rifiuta testi troppo corti o vuoti", () => {
    expect(isProbablyReadable("")).toBe(false);
    expect(isProbablyReadable("corto")).toBe(false);
  });

  it("rifiuta scariche di caratteri non alfabetici", () => {
    const noise = "12345 !!! ??? ### $$$ 55555 !!!! ???? #### 33333 @@@ 1111 %%";
    expect(isProbablyReadable(noise)).toBe(false);
  });
});
