// Planner di fallback DETERMINISTICO (nessun LLM): genera un piano conforme
// allo schema quando il servizio LLM non è disponibile o l'output è invalido.
// Regole: non inventa sotto-argomenti (una sola sotto-domanda), produce da 3
// a 6 query deterministiche derivate dalla domanda, non usa anni hardcoded
// (l'anno corrente arriva dal clock, iniettabile nei test).

import type { Freshness, ResearchOptions, ResearchPlan } from "@/lib/types";

export const FALLBACK_MAX_QUERY_CHARS = 300;

/** Congiunzioni/verbi comuni (it/en) escluse dalle parole chiave. */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "with", "that", "this", "these", "those", "have", "has",
  "not", "from", "into", "what", "when", "where", "who", "why", "how", "which",
  "che", "per", "con", "una", "uno", "un", "del", "della", "dei", "degli", "alla",
  "al", "nel", "nella", "come", "sono", "era", "più", "piu", "molto", "quale",
  "quali", "quando", "dove", "chi", "cosa", "quello", "questa", "questo", "suoi",
  "loro", "altri", "anche", "oltre", "contro", "dopo", "durante", "entro", "senza",
  "quale", "sul", "sulla", "sui", "dagli", "dalle", "dello", "fatto", "fare", "può",
]);

/** Normalizzazione minima della domanda (trim + spazi singoli). */
export function normalizeQuestion(question: string): string {
  return question.replace(/\s+/g, " ").trim();
}

/** Tronca una stringa a max caratteri su confine di parola (fallback: taglio). */
export function clampText(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(" ", max);
  return cut > Math.floor(max * 0.6) ? t.slice(0, cut) : t.slice(0, max);
}

/** Parole chiave principali: token significativi (no stopword, no numeri puri). */
export function extractKeywords(question: string): string[] {
  const tokens = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !STOPWORDS.has(t));
  return [...new Set(tokens)].slice(0, 8);
}

/**
 * Euristica lessicale conservativa e documentata: la restrizione di dominio
 * pubblico (.gov/.edu) ha senso solo per domande su istituzioni/dati pubblici.
 * NON è una lista di "fonti buone" e non influenza mai i punteggi.
 */
const PUBLIC_SECTOR_HINT =
  /(istat|statistic|govern|minister|parliament|parlament|ministero|istituto nazionale|agenzia|comune|regione|sanit|pubblic|unione europea|commissione europea|who|oms|unicef|fda|cdc|nasa|onu|fao)\b/i;

function hasPublicSectorHint(question: string): boolean {
  return PUBLIC_SECTOR_HINT.test(question);
}

export interface FallbackPlanInput {
  question: string;
  options?: ResearchOptions;
  /** Budget massimo di query da rispettare (>= 3). */
  maxQueries: number;
  /** Clock iniettabile per test (default: adesso). */
  now?: Date;
}

export interface FallbackQuery {
  query: string;
  purpose: "sub-question" | "synonym" | "primary-source" | "recent" | "counter-argument";
  priority: number;
}

/**
 * Genera il piano di fallback: 3-6 query deterministiche. La prima è la
 * domanda testuale, le altre varianti derivate dalle parole chiave.
 */
export function buildFallbackPlan(input: FallbackPlanInput): ResearchPlan {
  const question = clampText(normalizeQuestion(input.question), 1_000);
  const effectiveMax = Math.max(3, input.maxQueries);
  const now = input.now ?? new Date();
  const year = now.getUTCFullYear();

  const options = input.options;
  const freshness: Freshness = options?.freshness ?? "any";
  const keywords = extractKeywords(question);
  const keywordQuery = keywords.length > 0 ? keywords.join(" ") : clampText(question, 120);

  const candidates: FallbackQuery[] = [
    {
      query: clampText(question, FALLBACK_MAX_QUERY_CHARS),
      purpose: "sub-question",
      priority: 1.0,
    },
    {
      query: clampText(keywordQuery, FALLBACK_MAX_QUERY_CHARS),
      purpose: "synonym",
      priority: 0.95,
    },
    {
      query: clampText(`${keywordQuery} facts`, FALLBACK_MAX_QUERY_CHARS),
      purpose: "synonym",
      priority: 0.9,
    },
  ];

  if (freshness !== "any") {
    candidates.push({
      query: clampText(`${keywordQuery} ${year}`, FALLBACK_MAX_QUERY_CHARS),
      purpose: "recent",
      priority: 0.85,
    });
  }

  if (hasPublicSectorHint(question)) {
    candidates.push({
      query: clampText(`${keywordQuery} site:.gov OR site:.edu`, FALLBACK_MAX_QUERY_CHARS),
      purpose: "primary-source",
      priority: 0.8,
    });
  }

  candidates.push({
    query: clampText(
      `${keywordQuery} controversy OR criticism OR problems`,
      FALLBACK_MAX_QUERY_CHARS,
    ),
    purpose: "counter-argument",
    priority: 0.75,
  });

  // Deterministico: unico per stringa (case-insensitive), ordinato per priorità.
  const seen = new Set<string>();
  const queries = candidates
    .filter((c) => {
      const key = c.query.toLowerCase();
      if (key === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, effectiveMax)
    .map((c) => ({
      query: c.query,
      purpose: c.purpose,
      subQuestionId: "sub-1",
      priority: c.priority,
    }));

  const plan: ResearchPlan = {
    objective: question,
    subQuestions: [
      {
        id: "sub-1",
        text: `Fornire una risposta verificata e citata a: ${question}`,
        importance: "critical",
      },
    ],
    queries,
    constraints: {
      lang: options?.lang ?? "auto",
      freshness,
    },
    ambiguities: [],
    source: "fallback",
  };

  return plan;
}
