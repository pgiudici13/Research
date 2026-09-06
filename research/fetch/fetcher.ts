// Fetcher di pagine (server-only) con protezione SSRF a OGNI hop di redirect.
// Scarica UNA pagina e restituisce un documento grezzo limitato; la decodifica
// e l'estrazione del testo sono dello Step 11, il ranking dello Step 12.
// Un sito non raggiungibile NON interrompe la ricerca: esito per-pagina
// tipizzato (mai eccezioni, tranne l'annullamento utente che si propaga).

import { getLimits } from "@/lib/config/limits";
import { appError, isAppError, toErrorInfo } from "@/lib/errors";
import { retry } from "@/lib/http/retry";
import {
  assertSafeHttpUrl,
  type AddressLookup,
  defaultAddressLookup,
} from "@/lib/http/ssrf";
import { createLogger, type Logger } from "@/lib/logger";
import type { ErrorInfo } from "@/lib/types";
import { canonicalizeUrl } from "@/research/urls/canonical";

export interface FetchContext {
  signal?: AbortSignal;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** Lookup DNS iniettabile (default: dns.promises). */
  lookup?: AddressLookup;
  timeoutMs?: number;
  /** Limite byte del documento (default: limits.maxFetchBytes). */
  maxBytes?: number;
  /** Tentativi HTTP totali (default: limits.fetchMaxAttempts). */
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Redirect massimi seguiti (default: limits.maxRedirects). */
  maxRedirects?: number;
}

export interface RawDocument {
  /** URL finale DOPO i redirect (identità della fonte). */
  urlFinal: string;
  /** URL finale ricanonicalizzato (Step 9). */
  canonicalUrl: string;
  status: number;
  contentType: string;
  textBytes: number;
  truncated: boolean;
  /** Body grezzo (da decodificare nello Step 11). */
  body: Uint8Array;
}

export type FetchOutcome =
  | { ok: true; doc: RawDocument }
  | { ok: false; error: ErrorInfo };

const ACCEPTED_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
]);

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = "DeepResearch/0.1 (server; page fetcher)";

type AttemptResult =
  | { kind: "ok"; response: Response }
  | { kind: "redirect"; location: string };

/** Legge il body con tetto di byte: oltre il limite tronca e marca truncated. */
async function readBodyWithCap(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (response.body === null) {
    const all = new Uint8Array(await response.arrayBuffer());
    return { bytes: all.slice(0, maxBytes), truncated: all.length > maxBytes };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    if (value.length > remaining) {
      chunks.push(value.subarray(0, remaining));
      total += remaining;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.length;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: merged, truncated };
}

function rawContentType(value: string | null): string {
  if (!value) return "";
  return value.split(";", 1)[0].trim().toLowerCase();
}

/**
 * Scarica una pagina (GET, senza cookie) applicando la guardia SSRF prima di
 * ogni hop di redirect. Restituisce sempre un outcome (non lancia), tranne
 * quando l'utente annulla (AbortError propagato).
 */
export async function fetchPage(url: string, ctx: FetchContext = {}): Promise<FetchOutcome> {
  const {
    signal,
    logger = createLogger("fetch"),
    fetchImpl = globalThis.fetch,
    lookup = defaultAddressLookup,
    timeoutMs = getLimits().fetchTimeoutMs,
    maxBytes = getLimits().maxFetchBytes,
    maxAttempts = getLimits().fetchMaxAttempts,
    baseDelayMs = 100,
    maxRedirects = getLimits().maxRedirects,
  } = ctx;

  const startedAt = Date.now();
  let currentUrl = url;
  let redirectsFollowed = 0;

  try {
    for (;;) {
      // Guardia SSRF sul prossimo hop (incluso l'URL iniziale).
      await assertSafeHttpUrl(currentUrl, { lookup });

      const attempt = await retry<AttemptResult>({
        attempts: maxAttempts,
        baseDelayMs,
        maxDelayMs: 1_000,
        signal,
        fn: async () => {
          const timeoutSignal = AbortSignal.timeout(timeoutMs);
          const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

          let response: Response;
          try {
            response = await fetchImpl(currentUrl, {
              method: "GET",
              headers: {
                Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
                "User-Agent": USER_AGENT,
              },
              signal: combined,
              redirect: "manual",
              cache: "no-store",
            });
          } catch (err) {
            if (timeoutSignal.aborted) throw appError("E_FETCH_FAILED", { phase: "fetch" });
            if (signal?.aborted) throw err; // annullamento utente
            throw appError("E_FETCH_FAILED", { phase: "fetch" });
          }

          if (REDIRECT_CODES.has(response.status)) {
            const location = response.headers.get("location");
            if (location === null) {
              throw appError("E_FETCH_FAILED", {
                phase: "fetch",
                retryable: false,
                details: { status: response.status, reason: "redirect senza Location" },
              });
            }
            return { kind: "redirect", location };
          }
          if (response.status >= 200 && response.status < 300) {
            return { kind: "ok", response };
          }
          // 404/410 non ritentabili; 429/5xx ritentabili (gestiti da retry).
          const retryable = response.status === 429 || response.status >= 500;
          logger.warn("fetch.http_error", {
            url: currentUrl,
            status: response.status,
            retryable,
          });
          throw appError("E_FETCH_FAILED", {
            phase: "fetch",
            retryable,
            details: { status: response.status },
          });
        },
      });

      if (attempt.kind === "redirect") {
        redirectsFollowed++;
        if (redirectsFollowed > maxRedirects) {
          return fail(
            appError("E_FETCH_FAILED", {
              phase: "fetch",
              retryable: false,
              details: { reason: "troppi redirect", redirects: redirectsFollowed },
            }),
          );
        }
        currentUrl = new URL(attempt.location, currentUrl).href;
        continue;
      }

      // --- Risposta finale 2xx ---
      const response = attempt.response;
      const contentType = rawContentType(response.headers.get("content-type"));

      // Legge prima (con tetto di byte): per i tipi non accettati distinguiamo
      // tra documento troppo grande (E_FETCH_TOO_LARGE) e tipo non supportato
      // ma di dimensioni accettabili (E_FETCH_UNSUPPORTED). La lettura resta
      // comunque limitata dal tetto, quindi il costo è contenuto.
      const { bytes, truncated } = await readBodyWithCap(response, maxBytes);

      if (contentType !== "" && !ACCEPTED_TYPES.has(contentType)) {
        if (truncated) {
          logger.warn("fetch.too_large", { url: currentUrl, contentType, bytes: bytes.length });
          return fail(
            appError("E_FETCH_TOO_LARGE", {
              phase: "fetch",
              details: { contentType },
            }),
          );
        }
        logger.warn("fetch.unsupported_type", { url: currentUrl, contentType });
        return fail(
          appError("E_FETCH_UNSUPPORTED", {
            phase: "fetch",
            details: { contentType },
          }),
        );
      }

      const finalCanonical = canonicalizeUrl(currentUrl);
      const canonicalUrl = finalCanonical ? finalCanonical.href : currentUrl;

      logger.info("fetch.completed", {
        domain: safeHost(currentUrl),
        status: response.status,
        bytes: bytes.length,
        truncated,
        redirects: redirectsFollowed,
        durationMs: Date.now() - startedAt,
      });

      return {
        ok: true,
        doc: {
          urlFinal: currentUrl,
          canonicalUrl,
          status: response.status,
          contentType,
          textBytes: bytes.length,
          truncated,
          body: bytes,
        },
      };
    }
  } catch (err) {
    if (signal?.aborted) throw err; // annullamento utente: mai outcome "errore"
    return fail(err);
  }
}

function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "<invalid>";
  }
}

function fail(err: unknown): FetchOutcome {
  // Errori interni non-AppError -> E_INTERNAL via toErrorInfo.
  return { ok: false, error: isAppError(err) ? toErrorInfo(err) : toErrorInfo(new Error()) };
}
