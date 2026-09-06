// Estrazione di testo leggibile da HTML (server). Nessuna dipendenza di
// parsing (niente cheerio/jsdom in v1): scan conservativo, deterministico e
// senza crash su HTML malformato.
//
// REGOLE:
// - L'estrazione produce SOLO testo: qualunque markup residuo viene rimosso.
// - Il testo estratto è DATO NON ATTENDIBILE (può contenere istruzioni
//   ostili, policy Step 25): va trattato come contenuto della pagina, mai
//   come comando per l'agente.
// - Una pagina vuota/illeggibile è uno stato, non un errore: `text: ""`
//   (il chiamante la marca failed/unsupported, non si inventa contenuto).

import { getLimits } from "@/lib/config/limits";
import { createLogger, type Logger } from "@/lib/logger";
import type { ExtractedPage } from "@/lib/types";
import type { RawDocument } from "@/research/fetch/fetcher";
import { canonicalizeUrl, domainOf } from "@/research/urls/canonical";
import { normalizeWhitespace, truncateToChars } from "@/research/extract/text";

export interface ExtractContext {
  sourceId: string;
  logger?: Logger;
  /** Cap caratteri del testo conservato (default: limits.pageTextMaxChars). */
  maxChars?: number;
}

/** Blocchi rimossi INTERI (boilerplate/ineseguibili) con scan bilanciato. */
const BLOCK_REMOVE_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "form",
  "nav",
  "header",
  "footer",
  "aside",
]);

/** Tag di chiusura che introducono un separatore di riga. */
const BLOCK_CLOSE_SEPARATOR = /<\/(p|h[1-6]|li|tr|blockquote|pre|div|section|article|main|ul|ol|table)\s*>/gi;

const BR_SEPARATOR = /<br\s*\/?>/gi;

const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|rsquo|lsquo|ldquo|rdquo));/g;

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/** Decodifica le entità HTML più comuni (anche numeriche). */
export function htmlUnescape(input: string): string {
  return input.replace(ENTITY_RE, (_m, dec, hex, named) => {
    if (named !== undefined) return ENTITY_MAP[named] ?? _m;
    const code = dec !== undefined ? Number(dec) : Number.parseInt(hex, 16);
    if (Number.isNaN(code) || code < 0 || code > 0x10ffff) return _m;
    try {
      return String.fromCodePoint(code);
    } catch {
      return _m;
    }
  });
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_RE)) {
    attrs[m[1].toLowerCase()] = htmlUnescape(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Valore di un attributo su un tag (case-insensitive su chiave e valore). */
function attrValue(html: string, tagName: string, key: string, value: string): string | undefined {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  const want = `${key.toLowerCase()}="${value.toLowerCase()}"`;
  for (const m of html.matchAll(re)) {
    const attrs = parseAttrs(m[0]);
    const actual = `${(attrs[key.toLowerCase()] ?? "").toLowerCase()}`;
    if (attrs[key.toLowerCase()] !== undefined && actual === value.toLowerCase()) {
      return attrs.content;
    }
    if (want === "" && attrs.content !== undefined) return attrs.content;
  }
  return undefined;
}

/** Contenuto testuale di un tag (prima occorrenza), unescape + whitespace pulito. */
function tagContent(html: string, tagName: string): string | undefined {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, "i");
  const m = re.exec(html);
  if (!m) return undefined;
  const inner = htmlUnescape(m[1]).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return inner === "" ? undefined : inner;
}

/**
 * Rimuove i blocchi (anche annidati dello stesso tag) a partire dalla prima
 * occorrenza di qualunque tag nel set, finché non ne restano.
 */
function stripBlocks(html: string, tags: ReadonlySet<string>): string {
  const opens = new Map<string, RegExp>();
  for (const tag of tags) opens.set(tag, new RegExp(`<${tag}\\b`, "gi"));
  const closes = new Map<string, RegExp>();
  for (const tag of tags) closes.set(tag, new RegExp(`</${tag}\\s*>`, "gi"));

  let result = html;
  for (;;) {
    // Prima apertura (in assoluto) tra i tag del set.
    let bestStart = -1;
    let bestEnd = -1;
    let bestTag = "";
    for (const tag of tags) {
      const m = opens.get(tag)!.exec(result);
      if (m && (bestStart === -1 || m.index < bestStart)) {
        bestStart = m.index;
        bestEnd = m.index + m[0].length;
        bestTag = tag;
      }
      opens.get(tag)!.lastIndex = 0;
    }
    if (bestStart === -1) break;

    // Trova la chiusura bilanciata (gestisce annidamento dello stesso tag).
    const openRe = new RegExp(`<${bestTag}\\b`, "gi");
    const closeRe = new RegExp(`</${bestTag}\\s*>`, "gi");
    let depth = 1;
    const cursor = bestEnd;
    let blockEnd = result.length;
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    while (depth > 0 && cursor <= result.length) {
      const o = openRe.exec(result);
      const c = closeRe.exec(result);
      if (!c) break; // tag non chiuso: taglia fino alla fine (conservativo)
      if (o && o.index < c.index) {
        depth++;
        closeRe.lastIndex = c.index; // riallinea: la chiusura va rivalutata
        openRe.lastIndex = o.index + o[0].length;
      } else {
        depth--;
        if (depth === 0) blockEnd = c.index + c[0].length;
        openRe.lastIndex = c.index + c[0].length;
        closeRe.lastIndex = c.index + c[0].length;
      }
    }
    result = result.slice(0, bestStart) + result.slice(blockEnd);
  }
  return result;
}

/** Rimuove elementi con attributi `hidden` o `aria-hidden="true"`. */
function stripHidden(html: string): string {
  const HIDDEN_OPEN =
    /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(?:\shidden(?:\s*=\s*["']?[^"'\s>]*["']?)?|\baria-hidden\s*=\s*["']true["'])[^>]*>/gi;
  let result = html;
  for (;;) {
    const m = HIDDEN_OPEN.exec(result);
    if (!m) break;
    const tag = m[1].toLowerCase();
    if (BLOCK_REMOVE_TAGS.has(tag)) {
      // i blocchi boilerplate sono già stati rimossi; difesa extra
      result = stripBlocks(result, new Set([tag]));
      HIDDEN_OPEN.lastIndex = 0;
      continue;
    }
    // rimuovi il blocco bilanciato del tag che porta l'attributo
    const openRe = new RegExp(`<${tag}\\b`, "gi");
    const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
    let depth = 1;
    const cursor = m.index + m[0].length;
    let blockEnd = result.length;
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    while (depth > 0) {
      const o = openRe.exec(result);
      const c = closeRe.exec(result);
      if (!c) break;
      if (o && o.index < c.index) {
        depth++;
        openRe.lastIndex = o.index + o[0].length;
      } else {
        depth--;
        if (depth === 0) blockEnd = c.index + c[0].length;
        openRe.lastIndex = c.index + c[0].length;
        closeRe.lastIndex = c.index + c[0].length;
      }
    }
    result = result.slice(0, m.index) + result.slice(blockEnd);
    HIDDEN_OPEN.lastIndex = m.index; // ricontrolla dalla stessa posizione
  }
  return result;
}

/** Normalizza una data ISO-like in `YYYY-MM-DD`; non inventa nulla. */
function normalizeDate(value: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return undefined;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  if (
    date.getUTCFullYear() !== Number(m[1]) ||
    date.getUTCMonth() !== Number(m[2]) - 1 ||
    date.getUTCDate() !== Number(m[3])
  ) {
    return undefined;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

interface PageMetadata {
  title: string;
  description: string;
  type: string;
  lang?: string;
  author?: string;
  publishedDate?: string;
}

/** Estrae i metadati principali (head) PRIMA della rimozione dei blocchi. */
function extractMetadata(html: string): PageMetadata {
  const meta = (key: string, value: string): string | undefined =>
    attrValue(html, "meta", key, value);

  const title = tagContent(html, "title") ?? meta("property", "og:title") ?? "";
  const description = meta("property", "og:description") ?? meta("name", "description") ?? "";

  // lang: <html lang="…">
  const langMatch = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html);
  const lang = langMatch ? langMatch[1].trim().toLowerCase() : undefined;

  // autore: meta name=author, poi article:author se non è un URL
  let author = meta("name", "author");
  if (!author) {
    const articleAuthor = meta("property", "article:author");
    if (articleAuthor && !/^https?:\/\//i.test(articleAuthor)) author = articleAuthor;
  }

  // data: article:published_time / name=date / og:article:published_time
  let publishedDate: string | undefined;
  for (const candidate of [
    meta("property", "article:published_time"),
    meta("name", "article:published_time"),
    meta("name", "date"),
    meta("property", "og:article:published_time"),
  ]) {
    if (!candidate) continue;
    const normalized = normalizeDate(candidate);
    if (normalized) {
      publishedDate = normalized;
      break;
    }
  }

  return {
    title: htmlUnescape(title).trim(),
    description: normalizeWhitespace(htmlUnescape(description)),
    type: (meta("property", "og:type") ?? "").trim().toLowerCase(),
    lang,
    author: author ? normalizeWhitespace(author) : undefined,
    publishedDate,
  };
}

/**
 * Converte il markup residuo in testo leggibile per righe: i blocchi diventano
 * separatori di riga, i tag residui spariscono, gli spazi collassano.
 */
function htmlToLines(html: string): string {
  const stripped = stripBlocks(stripHidden(html), BLOCK_REMOVE_TAGS);
  const withBreaks = stripped
    .replace(BLOCK_CLOSE_SEPARATOR, "\n")
    .replace(BR_SEPARATOR, "\n");
  const noTags = withBreaks.replace(/<[^>]*>/g, "");
  const text = htmlUnescape(noTags);
  return text
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Individua una dichiarazione `charset=` nei primi byte del documento. */
function detectCharsetLabel(headSample: string): string | undefined {
  const m = /charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i.exec(headSample);
  return m ? m[1].trim() : undefined;
}

/** Decodifica il body: charset da `<meta charset>`/`<meta http-equiv>`, UTF-8 di default. */
function decodeBody(body: Uint8Array): string {
  const encoder = new TextDecoder("utf-8", { fatal: false });
  const sample = encoder.decode(body.slice(0, 4096));
  const label = detectCharsetLabel(sample);
  if (label) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(body);
    } catch {
      // label sconosciuta: riprova UTF-8 sul body intero
    }
  }
  return encoder.decode(body);
}

/** Da un documento HTML (o testo) grezzo a una pagina estratta in testo. */
export function extractPage(doc: RawDocument, ctx: ExtractContext): ExtractedPage {
  const logger = ctx.logger ?? createLogger("extract");
  const maxChars = ctx.maxChars ?? getLimits().pageTextMaxChars;
  const extractedAt = new Date().toISOString();

  // -- canale di uscita comune -------------------------------------------------
  const result = (partial: {
    title: string;
    author?: string;
    publishedDate?: string;
    lang?: string;
    rawText: string;
    truncated: boolean;
  }): ExtractedPage => {
    // Cap: testo conservato <= maxChars (C.2); oltre si tronca marcando.
    const cut = truncateToChars(partial.rawText, maxChars);
    return {
      sourceId: ctx.sourceId,
      url: doc.urlFinal,
      domain: deriveDomain(doc.canonicalUrl, doc.urlFinal),
      title: partial.title,
      author: partial.author,
      publishedDate: partial.publishedDate,
      lang: partial.lang,
      text: cut.text,
      truncated: doc.truncated || cut.truncated || partial.truncated,
      extractedAt,
    };
  };

  try {
    const isHtml =
      doc.contentType === "" ||
      doc.contentType === "text/html" ||
      doc.contentType === "application/xhtml+xml";

    // Pagine di solo testo: nessuna elaborazione HTML.
    if (!isHtml) {
      const text = normalizeWhitespace(decodeBody(doc.body));
      return result({ title: "", rawText: text, truncated: false });
    }

    const raw = decodeBody(doc.body);
    // I commenti possono contenere markup finto: via prima di ogni scan.
    const noComments = raw.replace(/<!--[\s\S]*?-->/g, "");
    // script/style/noscript/template non contengono metadati utili: tolti
    // prima dell'estrazione (un <title> finto dentro uno script non deve passare).
    const metaSource = stripBlocks(
      noComments,
      new Set(["script", "style", "noscript", "template"]),
    );
    const meta = extractMetadata(metaSource);
    let text = htmlToLines(noComments);

    // Fallback chiaro: testo quasi vuoto ma titolo presente -> titolo + descrizione.
    if (text.length < 80 && meta.title !== "") {
      const fallback = [meta.title, meta.description].filter((s) => s !== "").join("\n");
      if (fallback !== "") text = fallback;
    }

    // Pagina vuota/illeggibile: stato, non crash. Nessun contenuto inventato.
    if (text === "") {
      logger.warn("extract.empty", {
        sourceId: ctx.sourceId,
        url: doc.urlFinal,
        bytes: doc.textBytes,
      });
      return result({ title: meta.title, rawText: "", truncated: false });
    }

    return result({
      title: meta.title,
      author: meta.author,
      publishedDate: meta.publishedDate,
      lang: meta.lang,
      rawText: text,
      truncated: false,
    });
  } catch (err) {
    // Difesa finale: HTML ostile/malformato non deve MAI far crashare la fase.
    logger.error("extract.failed", {
      sourceId: ctx.sourceId,
      url: doc.urlFinal,
      error: err instanceof Error ? err.message : String(err),
    });
    return result({ title: "", rawText: "", truncated: false });
  }
}

function deriveDomain(...urls: string[]): string {
  for (const u of urls) {
    const c = canonicalizeUrl(u);
    if (c) return domainOf(c);
  }
  return "<unknown>";
}
