import { describe, expect, it } from "vitest";
import type { Evidence, ExtractedPage, SubQuestion } from "@/lib/types";
import { extractEvidence, sentenceCount } from "@/research/evidence/extract";

const SUB_QUESTIONS: SubQuestion[] = [
  { id: "sub-1", text: "In quale anno fu fondata l'Università di Pisa?", importance: "critical" },
  { id: "sub-2", text: "Chi volle la fondazione dell'ateneo pisano?", importance: "supporting" },
];

function makePage(paragraphs: string[], over: Partial<ExtractedPage> = {}): ExtractedPage {
  return {
    sourceId: "src-1",
    url: "https://example.org/articolo-pisa",
    domain: "example.org",
    title: "La fondazione dell'ateneo",
    text: paragraphs.join("\n"),
    truncated: false,
    extractedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

const GENERIC =
  "Il clima autunnale in Toscana è generalmente mite e soleggiato nelle ore centrali della giornata.";
const RELEVANT =
  "Nel 1343 l'Università di Pisa fu fondata per volere di papa Clemente VI. La bolla pontificia che istituì lo studio generale fu emessa nel settembre dello stesso anno. L'ateneo ricevette così il riconoscimento ufficiale.";

function flatText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function assertOnlyExtractedText(page: ExtractedPage, evidences: Evidence[]): void {
  const flat = flatText(page.text);
  for (const e of evidences) {
    expect(flatText(e.passage).length).toBeGreaterThan(0);
    expect(flat).toContain(flatText(e.passage)); // solo testo esatto della fonte
  }
}

describe("extractEvidence — base", () => {
  it("pagina vuota o senza sotto-domande → nessuna evidenza, nessun crash", () => {
    expect(extractEvidence(makePage([""]), { subQuestions: SUB_QUESTIONS })).toEqual([]);
    const withText = makePage([GENERIC]);
    expect(extractEvidence(withText, { subQuestions: [] })).toEqual([]);
  });

  it("seleziona il passaggio rilevante con confidence high e id deterministici", () => {
    const page = makePage([GENERIC, RELEVANT, GENERIC]);
    const first = extractEvidence(page, { subQuestions: SUB_QUESTIONS });
    const second = extractEvidence(page, { subQuestions: SUB_QUESTIONS });
    expect(first.map((e) => e.id)).toEqual(second.map((e) => e.id)); // stesso input → stessi id
    expect(first.length).toBeGreaterThan(0);
    const evidence = first.find((e) => e.passage.includes("Clemente VI"));
    expect(evidence).toBeDefined();
    expect(evidence?.id).toBe("src-1:p0"); // un solo passaggio (testo breve, unito)
    expect(evidence?.passageIndex).toBe(0);
    expect(evidence?.sourceId).toBe("src-1");
    expect(evidence?.url).toBe("https://example.org/articolo-pisa");
    expect(evidence?.confidence).toBe("high");
    expect(evidence?.subQuestionId).toBe("sub-1");
    expect(evidence?.relevance).toBe(1);
    expect(evidence?.retrievedAt).toBe(page.extractedAt);
  });

  it("le evidenze contengono solo testo estratto (nessuna aggiunta del modello)", () => {
    const page = makePage([GENERIC, RELEVANT, GENERIC]);
    assertOnlyExtractedText(page, extractEvidence(page, { subQuestions: SUB_QUESTIONS }));
  });

  it("rispetta il budget per pagina (le migliori per rilevanza)", () => {
    const long = (RELEVANT + " ").repeat(40); // singola riga enorme -> molti passaggi
    const page = makePage([long]);
    const all = extractEvidence(page, { subQuestions: SUB_QUESTIONS });
    expect(all.length).toBeLessThanOrEqual(8);
    const capped = extractEvidence(page, {
      subQuestions: SUB_QUESTIONS,
      maxPerPage: 2,
      passageMaxChars: 150,
      allowLowConfidenceFallback: true,
    });
    expect(capped).toHaveLength(2); // mai oltre il budget di pagina
    assertOnlyExtractedText(page, capped);
  });

  it("i passaggi rispettano il limite di caratteri", () => {
    const long = (RELEVANT + " " + RELEVANT).repeat(20);
    const page = makePage([long]);
    const evidences = extractEvidence(page, { subQuestions: SUB_QUESTIONS });
    expect(evidences.length).toBeGreaterThan(1);
    for (const e of evidences) expect(e.passage.length).toBeLessThanOrEqual(1200);
  });
});

describe("extractEvidence — confidence", () => {
  it("overlap medio con una sola frase → medium", () => {
    const page = makePage(["Nel 1343 venne fondato a Pisa il nuovo studio cittadino."]);
    const evidences = extractEvidence(page, { subQuestions: SUB_QUESTIONS });
    expect(evidences).toHaveLength(1);
    expect(evidences[0].confidence).toBe("medium");
    expect(evidences[0].relevance).toBeGreaterThanOrEqual(0.25);
    expect(evidences[0].relevance).toBeLessThan(0.5);
  });

  it("overlap debole → low", () => {
    const manyTokensSub: SubQuestion[] = [
      {
        id: "sub-x",
        text: "Quali documenti attestano la fondazione dell'ateneo pisano nel Trecento?",
        importance: "supporting",
      },
    ];
    const page = makePage([
      "I documenti conservati nell'archivio sono stati digitalizzati di recente dagli studiosi locali.",
    ]);
    const evidences = extractEvidence(page, { subQuestions: manyTokensSub });
    expect(evidences).toHaveLength(1);
    expect(evidences[0].confidence).toBe("low");
    expect(evidences[0].relevance).toBeGreaterThan(0);
    expect(evidences[0].relevance).toBeLessThan(0.25);
  });
});

describe("extractEvidence — fallback su fonti deboli ma scelte dal ranking", () => {
  it("senza flag e senza overlap → nessuna evidenza", () => {
    const page = makePage([GENERIC, GENERIC, GENERIC]);
    expect(extractEvidence(page, { subQuestions: SUB_QUESTIONS })).toEqual([]);
  });

  it("con flag → primi passaggi con confidence low e rilevanza 0", () => {
    const page = makePage([GENERIC, GENERIC, GENERIC]);
    const evidences = extractEvidence(page, {
      subQuestions: SUB_QUESTIONS,
      allowLowConfidenceFallback: true,
    });
    expect(evidences.length).toBeGreaterThan(0);
    expect(evidences.length).toBeLessThanOrEqual(8);
    for (const e of evidences) {
      expect(e.confidence).toBe("low");
      expect(e.relevance).toBe(0);
      expect(e.subQuestionId).toBeUndefined();
    }
    assertOnlyExtractedText(page, evidences);
  });
});

describe("sentenceCount", () => {
  it("conta le frasi in modo deterministico", () => {
    expect(sentenceCount("Una frase sola.")).toBe(1);
    expect(sentenceCount("Prima frase. Seconda frase! Terza frase?")).toBe(3);
    expect(sentenceCount("testo senza punteggiatura")).toBe(1);
    expect(sentenceCount("")).toBe(1); // mai zero: euristico e stabile
  });
});
