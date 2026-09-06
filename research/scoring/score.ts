// Source scoring e ranking dei candidati (funzioni pure, deterministiche).
//
// REGOLE:
// - Il punteggio ordina SOLO il lavoro del motore (quali pagine scaricare per
//   prime). NON è una prova di verità e non marca mai una fonte come "vera":
//   la verifica avviene altrove, sulle evidenze estratte dal testo completo.
// - Ogni segnale è normalizzato in [0,1] e documentato. Il sistema non finge
//   conoscenze che non ha: i segnali sono euristiche lessicali/esplicite.
// - Nessuna lista hardcoded di "fonti buone": solo un hook configurabile
//   `authorityDomains`, VUOTO di default.
// - I pesi stanno in `WEIGHTS` (costante esplicita, somma 1).
// - Uno snippet di ricerca non è una prova: la rilevanza si valuta su
//   titolo+snippet solo per PRIORITIZZARE il fetch.

export interface ScoreableSource {
  title: string;
  snippet: string;
  domain: string;
  engines: string[];
  occurrences: number;
  publishedDate?: string;
}

export interface ScoringContext {
  /** Query di ricerca principale (o testo della sotto-domanda). */
  query: string;
  /** Testo aggiuntivo della sotto-domanda, se distinto dalla query. */
  subQuestion?: string;
  /** Se true, le fonti datate e recenti vengono premiate (decay lineare). */
  requireFreshness?: boolean;
  /** Hook configurabile di domini autorevoli (vuoto di default). */
  authorityDomains?: ReadonlySet<string>;
  /** Timestamp iniettabile (ms) per test deterministici; default: ora reale. */
  now?: number;
}

/** Pesi espliciti dei segnali (somma = 1, valori documentati). */
export const WEIGHTS = {
  /** Rilevanza verso la domanda (title > snippet). Determina l'ordine. */
  relevance: 0.4,
  /** Ricchezza informativa di titolo/snippet disponibili (title 0.5 + snippet 0.5). */
  richness: 0.15,
  /** Freschezza: rilevante SOLO se richiesta; altrimenti neutro 0.5. */
  freshness: 0.1,
  /** Bonus TLD gov/edu o dominio in authorityDomains (0/1). */
  authority: 0.15,
  /** Engine distinti + occorrenze extra, saturato a 3+ (segnale debole). */
  independence: 0.1,
  /** Euristica lessicale molto conservativa su dominio vs entità nella query. */
  primarySource: 0.1,
} as const;

/** TLD che ricevono il bonus di autorevolezza (nessun altro hardcoded). */
export const AUTHORITY_TLDS: readonly string[] = [".gov", ".edu"];

/** Mezza vita del decay di freschezza (giorni): a 730 giorni il segnale è 0. */
export const FRESHNESS_HALF_LIFE_DAYS = 730;

/** Soglia: a 3+ segnali indipendenti l'independence signal satura a 1. */
const INDEPENDENCE_SATURATION = 3;

const MS_PER_DAY = 86_400_000;

/** Minuscole congiunzioni/stopword comuni (it/en) escluse dai token. */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "with", "that", "this", "these", "those", "have", "has",
  "not", "from", "into", "what", "when", "where", "who", "why", "how", "which",
  "che", "per", "con", "una", "uno", "un", "del", "della", "dei", "degli", "alla",
  "al", "nel", "nella", "come", "sono", "era", "più", "piu", "molto", "quale",
  "quali", "quando", "dove", "chi", "cosa", "quello", "questa", "questo", "suoi",
  "loro", "altri", "anche", "oltre", "contro", "dopo", "durante", "entro", "senza",
]);

export interface CandidateScore {
  total: number;
  components: Record<string, number>;
  flags: string[];
}

/** Converte un testo in token significativi (lowercase, lettere/numeri). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Overlap normalizzato tra token della query e token del documento. */
function overlapRatio(queryTokens: ReadonlySet<string>, docTokens: string[]): number {
  if (queryTokens.size === 0) return 0;
  let hits = 0;
  for (const token of docTokens) if (queryTokens.has(token)) hits++;
  return Math.min(1, hits / queryTokens.size);
}

/** Snippet/titolo ricchi di testo → più materiale per le fasi successive. */
function signalRichness(title: string, snippet: string): number {
  const titlePart = title.trim().length > 0 ? 0.5 : 0;
  const snippetPart = 0.5 * Math.min(1, snippet.trim().length / 200);
  return titlePart + snippetPart;
}

/**
 * Freschezza: decay lineare sull'età SOLO quando richiesta; data assente o
 * freschezza non richiesta → 0.5 neutro (mai penalizzare oltre misura).
 */
function signalFreshness(
  publishedDate: string | undefined,
  requireFreshness: boolean,
  now: number,
): { score: number; unknownDate: boolean } {
  if (!requireFreshness || publishedDate === undefined) {
    return { score: 0.5, unknownDate: requireFreshness && publishedDate === undefined };
  }
  const parsed = Date.parse(publishedDate);
  if (Number.isNaN(parsed)) return { score: 0.5, unknownDate: true };
  const ageDays = Math.max(0, (now - parsed) / MS_PER_DAY);
  return {
    score: clamp01(1 - ageDays / FRESHNESS_HALF_LIFE_DAYS),
    unknownDate: false,
  };
}

/** TLD gov/edu o suffisso esatto di un dominio della lista configurabile. */
function signalAuthority(
  domain: string,
  authorityDomains: ReadonlySet<string>,
): number {
  const host = domain.toLowerCase();
  const labels = host.split(".");
  const tld = labels.length > 1 ? `.${labels[labels.length - 1]}` : "";
  if (AUTHORITY_TLDS.includes(tld)) return 1;
  for (const listed of authorityDomains) {
    const normalized = listed.toLowerCase();
    if (host === normalized || host.endsWith(`.${normalized}`)) return 1;
  }
  return 0;
}

/**
 * Engine distinti + occorrenze extra come SEGNALE DEBOLE di indipendenza
 * (stessa fonte ripetuta da più motori vale poco, ma non è una prova).
 */
function signalIndependence(engines: string[], occurrences: number): number {
  const distinct = new Set(engines.map((e) => e.trim()).filter((e) => e !== "")).size;
  const extra = Math.max(0, occurrences - distinct);
  return clamp01((distinct + extra) / INDEPENDENCE_SATURATION);
}

/**
 * Euristica MOLTO conservativa e puramente lessicale: se un token lungo
 * (>= 5 caratteri) della domanda compare nel dominio, forse è il sito ufficiale
 * dell'ente nominato. Marca sempre `primary-source-heuristic`: NON è verità.
 */
function signalPrimarySource(queryTokens: string[], domain: string): { score: number; flag: boolean } {
  const host = domain.toLowerCase().replace(/^www\./, "");
  for (const token of queryTokens) {
    if (token.length >= 5 && host.includes(token)) return { score: 0.15, flag: true };
  }
  return { score: 0, flag: false };
}

/** Query tokens unione di query + sotto-domanda (rilevanza). */
function queryTokenSet(ctx: ScoringContext): ReadonlySet<string> {
  const tokens = [...tokenize(ctx.query), ...tokenize(ctx.subQuestion ?? "")];
  return new Set(tokens);
}

function clampTotal(total: number): number {
  // difesa da errori di arrotondamento: il totale è sempre in [0,1]
  return Math.min(1, Math.max(0, total));
}

/**
 * Assegna il punteggio a un candidato. Restituisce componenti normalizzati,
 * totale pesato e flag espliciti. Funzione pura (ctx.now iniettabile).
 */
export function scoreCandidate(source: ScoreableSource, ctx: ScoringContext): CandidateScore {
  const now = ctx.now ?? Date.now();
  const queryTokens = queryTokenSet(ctx);

  // -- rilevanza: overlap su title (peso maggiore) e snippet ----------------
  const relevance =
    queryTokens.size === 0
      ? 0.5 // query tutta stopword: nessun segnale → neutro
      : 0.6 * overlapRatio(queryTokens, tokenize(source.title)) +
        0.4 * overlapRatio(queryTokens, tokenize(source.snippet));

  const richness = signalRichness(source.title, source.snippet);

  const freshnessOutcome = signalFreshness(
    source.publishedDate,
    ctx.requireFreshness === true,
    now,
  );

  const authority = signalAuthority(source.domain, ctx.authorityDomains ?? new Set());

  const independence = signalIndependence(source.engines, source.occurrences);

  const primarySourceOutcome = signalPrimarySource([...queryTokens], source.domain);

  const components: Record<string, number> = {
    relevance,
    richness,
    freshness: freshnessOutcome.score,
    authority,
    independence,
    primarySource: primarySourceOutcome.score,
  };

  const flags: string[] = [];
  if (freshnessOutcome.unknownDate) flags.push("unknownDate");
  if (primarySourceOutcome.flag) flags.push("primary-source-heuristic");

  let total = 0;
  for (const [name, weight] of Object.entries(WEIGHTS)) {
    total += weight * (components[name] ?? 0);
  }

  return { total: clampTotal(total), components, flags };
}

export interface RankedCandidate<T extends ScoreableSource> {
  candidate: T;
  score: CandidateScore;
  /** Posizione 1-based dopo l'ordinamento (nessuno scartato qui). */
  rank: number;
}

/**
 * Ordina i candidati per punteggio decrescente, senza scartare nulla
 * (il taglio per budget avviene nel motore). Stabile: a parità di totale
 * mantiene l'ordine di ingresso. Funzione pura.
 */
export function rankCandidates<T extends ScoreableSource>(
  candidates: readonly T[],
  ctx: ScoringContext,
): RankedCandidate<T>[] {
  const ranked = candidates.map((candidate, index) => ({
    candidate,
    index,
    score: scoreCandidate(candidate, ctx),
  }));
  ranked.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    return a.index - b.index;
  });
  return ranked.map(({ candidate, score }, rank) => ({ candidate, score, rank: rank + 1 }));
}
