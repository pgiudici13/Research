// Citation mapping deterministico (Step 19): catena tracciabile
// `paragrafo → claim → evidence → source → URL`. La tabella delle citazioni è
// costruita SOLO dalle evidenze effettivamente raccolte (mai da snippet di
// ricerca, mai da URL non analizzati) con un ordinamento stabile; la sintesi
// (Step 18) usa la STESSA tabella per numerare, così il modello può citare
// solo chiavi esistenti e il report non può mai riferirsi a fonti mai viste.
//
// Anti-regole (testate):
// - mai generare URL o titoli dal modello: url/title arrivano dal SourceRecord;
// - mai citare un'evidenza di una fonte non analizzata (status !== "fetched");
// - due esecuzioni con gli stessi input producono lo stesso mapping.
//
// Nota architetturale (deviazione documentata): l'assemblaggio finale del
// `ResearchReport` (con sourcesConsulted vs sourcesUsed, budget, timestamp)
// vive in `research/engine/engine.ts` (assembleReport, Step 17): questo modulo
// produce la tabella deterministica, valida/ripulisce le citazioni dei
// paragrafi e deriva i `Claim`. Non serve un buildReport separato.

import type {
  Claim,
  Citation,
  Evidence,
  ReportParagraph,
  ReportSection,
  SourceRecord,
} from "@/lib/types";

/** Lunghezza massima del passaggio riportato in una Citation (per il report). */
export const CITATION_PASSAGE_MAX_CHARS = 400;

/** Lunghezza massima del testo di un Claim derivato (per il report). */
export const CLAIM_TEXT_MAX_CHARS = 300;

/** Confronto stabile per evidenze: fonte, poi indice di passaggio, poi id. */
function compareEvidence(a: Evidence, b: Evidence): number {
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
  if (a.passageIndex !== b.passageIndex) return a.passageIndex - b.passageIndex;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Trova il SourceRecord della fonte (title/url autorevoli, MAI dal modello). */
function recordOf(
  sourceId: string,
  records: readonly SourceRecord[],
): SourceRecord | undefined {
  return records.find((r) => r.sourceId === sourceId);
}

/**
 * Costruisce la tabella di citazione deterministica (indici 1..n) dalle sole
 * evidenze di fonti analizzate. Evidenze la cui fonte non risulta "fetched"
 * vengono ESCLUSE: nessuna citazione può nascere da una fonte fallita o
 * saltata. Se il SourceRecord manca (non dovrebbe mai accadere nel motore) si
 * usa l'url dell'evidenza e titolo vuoto, senza perdere l'evidenza.
 */
export function buildCitationTable(
  evidences: readonly Evidence[],
  records: readonly SourceRecord[] = [],
): Citation[] {
  const seen = new Set<string>();
  const usable: Evidence[] = [];
  for (const evidence of evidences) {
    if (seen.has(evidence.id)) continue; // mai duplicare un'evidenza
    seen.add(evidence.id);
    const record = recordOf(evidence.sourceId, records);
    if (record !== undefined && record.status !== "fetched") continue;
    usable.push(evidence);
  }

  const sorted = [...usable].sort(compareEvidence);
  return sorted.map((evidence, i) => {
    const record = recordOf(evidence.sourceId, records);
    return {
      index: i + 1,
      evidenceId: evidence.id,
      sourceId: evidence.sourceId,
      url: record?.urlFinal ?? evidence.url,
      title: record?.title ?? "",
      passage: evidence.passage.slice(0, CITATION_PASSAGE_MAX_CHARS),
    };
  });
}

export interface CitationResolution {
  /** Sezioni copia-pulite: le citazioni non valide vengono RIMOSSE. */
  sections: ReportSection[];
  /** Numeri citati che non esistono nella tabella (unici, in ordine di arrivo). */
  invalidKeys: number[];
  /** EvidenceId effettivamente citati (set). */
  usedEvidenceIds: Set<string>;
  /** Indici citati validi, unici, in ordine di PRIMO utilizzo nel documento. */
  usedIndexes: number[];
}

/**
 * Valida le citazioni numeriche dei paragrafi contro la tabella. Non lancia:
 * ritorna la risoluzione con le sezioni ripulite e i conteggi, così il
 * chiamante decide (synthesizer: retry/fallback; motore: backstop silenzioso).
 */
export function resolveReportCitations(
  sections: readonly ReportSection[],
  table: readonly Citation[],
): CitationResolution {
  const valid = new Map<number, string>(); // index -> evidenceId
  for (const entry of table) valid.set(entry.index, entry.evidenceId);

  const cleanedSections: ReportSection[] = [];
  const invalidKeys: number[] = [];
  const usedEvidenceIds = new Set<string>();
  const usedIndexes: number[] = [];

  const addUsed = (index: number): void => {
    if (usedIndexes.includes(index)) return;
    usedIndexes.push(index);
    const evidenceId = valid.get(index);
    if (evidenceId !== undefined) usedEvidenceIds.add(evidenceId);
  };

  for (const section of sections) {
    const paragraphs: ReportParagraph[] = [];
    for (const paragraph of section.paragraphs) {
      const citations: number[] = [];
      for (const number of paragraph.citations) {
        if (!Number.isInteger(number) || !valid.has(number)) {
          if (!invalidKeys.includes(number)) invalidKeys.push(number);
          continue;
        }
        citations.push(number);
        addUsed(number);
      }
      paragraphs.push({ ...paragraph, citations });
    }
    cleanedSections.push({ heading: section.heading, paragraphs });
  }

  return {
    sections: cleanedSections,
    invalidKeys,
    usedEvidenceIds,
    usedIndexes,
  };
}

/**
 * Deriva i `Claim` in modo DETERMINISTICO dai paragrafi classificati (kind):
 * un claim per ogni paragrafo con kind esplicito e almeno una citazione
 * valida, con `supportEvidenceIds` = evidenze citate dal paragrafo. Nessun
 * contenuto aggiunto: il testo del claim riprende quello del paragrafo.
 */
export function deriveClaims(
  sections: readonly ReportSection[],
  table: readonly Citation[],
): Claim[] {
  const byIndex = new Map<number, Citation>();
  for (const entry of table) byIndex.set(entry.index, entry);

  const claims: Claim[] = [];
  let counter = 0;
  for (const section of sections) {
    for (const paragraph of section.paragraphs) {
      if (paragraph.kind === undefined) continue;
      const supportEvidenceIds: string[] = [];
      for (const number of paragraph.citations) {
        const entry = byIndex.get(number);
        if (entry !== undefined && !supportEvidenceIds.includes(entry.evidenceId)) {
          supportEvidenceIds.push(entry.evidenceId);
        }
      }
      if (supportEvidenceIds.length === 0) continue; // nessun claim senza supporto
      counter += 1;
      const text = paragraph.text.replace(/\s+/g, " ").trim();
      claims.push({
        id: `claim-${counter}`,
        text: text.slice(0, CLAIM_TEXT_MAX_CHARS),
        kind: paragraph.kind,
        supportEvidenceIds,
      });
    }
  }
  return claims;
}

/**
 * Porta consumata dal motore (mapCitations): costruisce la tabella, valida le
 * citazioni dei paragrafi e restituisce la lista finale `Citation[]` = SOLO le
 * voci effettivamente citate, in ordine di primo utilizzo. I numeri invalidi
 * vengono rimossi silenziosamente (backstop: la sintesi ha già validato).
 */
export function mapCitations(input: {
  sections: readonly ReportSection[];
  claims?: readonly Claim[];
  evidences: readonly Evidence[];
  sourceRecords?: readonly SourceRecord[];
}): Citation[] {
  const table = buildCitationTable(input.evidences, input.sourceRecords ?? []);
  const resolution = resolveReportCitations(input.sections, table);

  const byIndex = new Map<number, Citation>();
  for (const entry of table) byIndex.set(entry.index, entry);

  const citations: Citation[] = [];
  for (const index of resolution.usedIndexes) {
    const entry = byIndex.get(index);
    if (entry !== undefined) citations.push(entry);
  }
  return citations;
}
