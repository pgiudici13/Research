// Sintesi di fallback DETERMINISTICA senza LLM (Step 18). Usata quando l'LLM
// non è configurato, fallisce o produce un report non valido. Regole:
// - NESSUN contenuto inventato: i paragrafi elencano SOLO passaggi verbatim
//   delle evidenze (etichettati `kind: "uncertain"`) con le loro citazioni
//   numeriche reali, preceduti dalla nota che è una sintesi meccanica;
// - conflitti presentati con entrambe le posizioni, mai risolti;
// - limiti della ricerca elencati come dati del run;
// - stesso input → stesso output (determinismo).

import type {
  Citation,
  Claim,
  Conflict,
  Evidence,
  ResearchLimitations,
  ResearchPlan,
  ReportSection,
} from "@/lib/types";
import { deriveClaims } from "@/research/citations/map";

/** Prefisso che marca ogni paragrafo come sintesi meccanica (mai rimossa). */
export const FALLBACK_NOTE_PREFIX = "Sintesi meccanica senza LLM: ";

export interface FallbackSynthesisInput {
  question: string;
  plan: ResearchPlan;
  evidences: readonly Evidence[];
  /** Tabella di citazione già costruita (stesso ordinamento del motore). */
  table: readonly Citation[];
  conflicts: readonly Conflict[];
  limitations: ResearchLimitations;
}

export interface FallbackSynthesisOutput {
  sections: ReportSection[];
  claims: Claim[];
}

function paragraph(
  text: string,
  citations: number[],
): ReportSection["paragraphs"][number] {
  return { text, kind: "uncertain", citations };
}

/**
 * Elenca un'evidenza come riga `[n] passage` (passage già troncato in tabella).
 * Il passaggio è riportato verbatim: nessuna parafrasi.
 */
function evidenceLine(entry: Citation): string {
  return `[${entry.index}] ${entry.passage}`;
}

export function buildFallbackSynthesis(
  input: FallbackSynthesisInput,
): FallbackSynthesisOutput {
  const { plan, evidences, table, conflicts, limitations } = input;

  const tableByEvidence = new Map<string, Citation>();
  for (const entry of table) tableByEvidence.set(entry.evidenceId, entry);

  const subOf = new Map<string, string | undefined>();
  for (const evidence of evidences) subOf.set(evidence.id, evidence.subQuestionId);

  // ordinamento evidenze = ordine della tabella (deterministico)
  const ordered: Evidence[] = [];
  for (const entry of table) {
    const evidence = evidences.find((e) => e.id === entry.evidenceId);
    if (evidence !== undefined) ordered.push(evidence);
  }
  const unassigned = ordered.filter(
    (e) => (e.subQuestionId ?? undefined) === undefined,
  );

  const sections: ReportSection[] = [];

  // --- una sezione per sotto-domanda -----------------------------------------
  for (const sub of plan.subQuestions) {
    const matching = ordered.filter((e) => e.subQuestionId === sub.id);
    const entries = matching
      .map((e) => tableByEvidence.get(e.id))
      .filter((e): e is Citation => e !== undefined);

    if (entries.length === 0) {
      sections.push({
        heading: sub.text,
        paragraphs: [
          paragraph(
            `${FALLBACK_NOTE_PREFIX}nessuna evidenza sufficiente è stata raccolta per questa sotto-domanda.`,
            [],
          ),
        ],
      });
      continue;
    }

    const lines = [`${FALLBACK_NOTE_PREFIX}evidenze disponibili per questa sotto-domanda:`];
    for (const entry of entries) lines.push(evidenceLine(entry));
    sections.push({
      heading: sub.text,
      paragraphs: [
        paragraph(lines.join("\n"), entries.map((e) => e.index)),
      ],
    });
  }

  // --- evidenze non assegnate (se esistono, mai perse) ------------------------
  if (unassigned.length > 0) {
    const entries = unassigned
      .map((e) => tableByEvidence.get(e.id))
      .filter((e): e is Citation => e !== undefined);
    const lines = [
      `${FALLBACK_NOTE_PREFIX}evidenze raccolte non riconducibili a una sotto-domanda specifica:`,
    ];
    for (const entry of entries) lines.push(evidenceLine(entry));
    sections.push({
      heading: "Evidenze non assegnate",
      paragraphs: [
        paragraph(lines.join("\n"), entries.map((e) => e.index)),
      ],
    });
  }

  // --- conflitti: entrambe le posizioni, mai risolti ---------------------------
  if (conflicts.length > 0) {
    const paragraphs: ReportSection["paragraphs"] = [];
    for (const conflict of conflicts) {
      const lines: string[] = [];
      if (conflict.temporalNote !== undefined) {
        lines.push(`Nota temporale: ${conflict.temporalNote}`);
      }
      const citations: number[] = [];
      for (const statement of conflict.statements) {
        const entry = tableByEvidence.get(statement.evidenceId);
        if (entry !== undefined) {
          citations.push(entry.index);
          lines.push(`Posizione ${entry.index}: ${statement.position}`);
        } else {
          lines.push(statement.position);
        }
      }
      lines.push(
        `Conflitto non risolto (severity: ${conflict.severity}): entrambe le posizioni restano aperte.`,
      );
      paragraphs.push(paragraph(lines.join("\n"), citations));
    }
    sections.push({ heading: "Conflitti", paragraphs });
  }

  // --- limiti della ricerca -----------------------------------------------------
  const limitationLines: string[] = [];
  if (limitations.missingSources) {
    limitationLines.push("Non tutte le sotto-domande hanno evidenze sufficienti.");
  }
  if (limitations.searchUnavailable) {
    limitationLines.push("Il motore di ricerca non era disponibile per parte della ricerca.");
  }
  if (limitations.llmUnavailable) {
    limitationLines.push("Il servizio LLM non era disponibile: sintesi generata senza LLM.");
  }
  if (limitations.budgetExceeded) {
    limitationLines.push("Il budget di ricerca è stato esaurito prima della copertura completa.");
  }
  if (limitations.timeBudgetExceeded) {
    limitationLines.push("Il tempo massimo di ricerca è stato raggiunto.");
  }
  limitationLines.push(...limitations.notes.map((note) => `Nota: ${note}`));

  if (limitationLines.length > 0) {
    sections.push({
      heading: "Limiti",
      paragraphs: [paragraph(`Limiti della ricerca:\n${limitationLines.map((l) => `- ${l}`).join("\n")}`, [])],
    });
  }

  const claims = deriveClaims(sections, table);
  return { sections, claims };
}
