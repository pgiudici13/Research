// Parsing JSON robusto per output LLM e dati esterni.
//
// Policy documentata (Step 4 di STEP.md): NIENTE `repairJsonLoose` (riparazione
// di JSON corrotto). Se il parse fallisce, la strategia è il RETRY della
// chiamata LLM con un messaggio di correzione conciso (vedi Step 7, chatJson).

/** JSON.parse rigoroso: lancia SyntaxError su input non-JSON. */
export function parseJsonStrict(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * JSON.parse tollerante: restituisce `null` su input non-JSON (mai lancia).
 * Rimuove l'eventuale BOM iniziale.
 */
export function parseJsonLoose(text: string): unknown | null {
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    return null;
  }
}

/**
 * Estrae e parsifica il primo blocco strutturato `{...}` o `[...]` bilanciato
 * presente nel testo, anche se il modello ha aggiunto prologo/epilogo o fence
 * markdown. Restituisce il valore parsificato oppure `null` se non trovato.
 *
 * Gestisce correttamente `}`/`]` e virgolette dentro le stringhe.
 */
export function extractJsonValue(text: string): unknown | null {
  const direct = parseJsonLoose(text);
  if (direct !== null) return direct;

  let start = -1;
  let opener = "";
  const closerOf: Record<string, string> = { "{": "}", "[": "]" };

  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (start === -1 && (ch === "{" || ch === "[")) {
      start = i;
      opener = ch;
      continue;
    }
    if (start !== -1) {
      // scansione del blocco: dopo l'opener cerchiamo la chiusura bilanciata
      break;
    }
  }
  if (start === -1) return null;

  const close = closerOf[opener];
  let depth = 0;
  inString = false;
  escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === opener) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        const block = text.slice(start, i + 1);
        return parseJsonLoose(block);
      }
    }
  }
  return null;
}

/** Versione specializzata per oggetti (vedi extractJsonValue). */
export function extractJsonBlock(text: string): Record<string, unknown> | null {
  const value = extractJsonValue(text);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}
