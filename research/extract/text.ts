// Utility di testo (funzioni pure, deterministiche). Nessuna dipendenza.

export interface TruncationResult {
  text: string;
  truncated: boolean;
}

/** Comprime qualunque sequenza di spazi bianchi in un singolo spazio. */
export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/**
 * Tronca il testo a `max` caratteri cercando un confine naturale (riga,
 * poi fine frase, poi spazio) nell'ultimo 20% del limite. Aggiunge "…".
 */
export function truncateToChars(text: string, max: number): TruncationResult {
  if (text.length <= max) return { text, truncated: false };
  const low = Math.floor(max * 0.8);
  let cut = -1;

  // Priorità: confine di paragrafo/riga, poi fine frase, poi spazio.
  for (let i = max; i >= low && cut === -1; i--) {
    if (text[i] === "\n") cut = i;
  }
  if (cut === -1) {
    for (let i = max; i >= low && cut === -1; i--) {
      if (text[i] === "." || text[i] === "!" || text[i] === "?") cut = i + 1;
    }
  }
  if (cut === -1) {
    for (let i = max; i >= low && cut === -1; i--) {
      if (text[i] === " ") cut = i;
    }
  }
  const end = cut === -1 ? max : cut;
  return { text: `${text.slice(0, end).trimEnd()}…`, truncated: true };
}

/**
 * Spezza una riga più lunga di maxChars a confini di frase (fallback: taglio
 * netto). Restituisce pezzi di lunghezza <= maxChars.
 */
function chunkLongLine(line: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > maxChars) {
    // cerca l'ultimo confine di frase entro maxChars
    const window = rest.slice(0, maxChars);
    const boundaries: number[] = [];
    let match: RegExpExecArray | null;
    const re = /[.!?]\s+/g;
    while ((match = re.exec(window)) !== null) {
      boundaries.push(match.index + match[0].length);
    }
    if (boundaries.length === 0) {
      pieces.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    } else {
      const end = boundaries[boundaries.length - 1];
      pieces.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * Divide il testo in passaggi deterministici di lunghezza <= maxChars.
 * I passaggi successivi riportano una coda di overlap (contesto continuo per
 * le evidenze, Step 14).
 */
export function splitIntoPassages(text: string, maxChars = 1_200, overlap = 80): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const passages: string[] = [];
  let buffer = "";
  let previousTail = "";

  function pushCompletePassage(passage: string): void {
    passages.push(passage);
    previousTail = passage.length > overlap ? passage.slice(-overlap) : passage;
  }

  for (const line of lines) {
    if (line.length <= maxChars) {
      const candidate = buffer === "" ? line : `${buffer}\n${line}`;
      if (candidate.length <= maxChars) {
        buffer = candidate;
        continue;
      }
      // il buffer è pieno: chiudi e ricomincia con overlap
      pushCompletePassage(buffer);
      const withTail = previousTail === "" ? line : `${previousTail} ${line}`;
      buffer = withTail.length <= maxChars ? withTail : line;
      continue;
    }

    // riga più lunga del limite: chiudi il buffer e spezza la riga
    if (buffer !== "") {
      pushCompletePassage(buffer);
      buffer = "";
    }
    const chunks = chunkLongLine(line, maxChars);
    chunks.forEach((chunk, index) => {
      if (index === 0 && previousTail !== "") {
        const merged = `${previousTail} ${chunk}`;
        pushCompletePassage(merged.length <= maxChars ? merged : chunk);
      } else {
        pushCompletePassage(chunk);
      }
    });
  }
  if (buffer !== "") passages.push(buffer.trim());

  return passages.filter((p) => p.trim().length > 0);
}

/** Euristico: un testo è "leggibile" se ha abbastanza caratteri alfabetici. */
export function isProbablyReadable(text: string, minChars = 80): boolean {
  if (text.trim().length < minChars) return false;
  const letters = (text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) ?? []).length;
  const nonSpace = text.replace(/\s/g, "").length;
  if (nonSpace === 0) return false;
  return letters / nonSpace >= 0.5;
}
