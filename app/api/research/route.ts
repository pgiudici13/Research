// POST /api/research — avvia una ricerca Deep Research e streamma lo stato
// come NDJSON (una riga per ProgressEvent, poi il report completo e `done`).
// Backend-only: il browser parla SOLO con questa API. Nessun URL/prompt
// arbitrario viene inoltrato; la chiave NVIDIA vive solo in lib/server/llm.
//
// Legame temporale: `maxDuration` deve coprire RESEARCH_TIMEOUT_MS + margine
// (limiti.researchTimeoutMs + endMarginMs); il valore sotto è il massimo del
// piano Vercel e va ridotto se il timeout di ricerca scende.

import { ERROR_CATALOG } from "@/lib/errors";
import { appError, toErrorInfo } from "@/lib/errors";
import { getLimits } from "@/lib/config/limits";
import { createLogger } from "@/lib/logger";
import { buildResearchDeps } from "@/lib/server/research/deps";
import {
  DEFAULT_RATE_LIMIT_CONFIG,
  InMemoryRateLimiter,
} from "@/lib/server/rate-limit";
import { createStreamSink } from "@/research/progress/sink";
import { runResearch } from "@/research/engine/engine";
import type { Freshness, ProgressEvent, ResearchOptions } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// researchTimeoutMs (default 120s) + endMarginMs (2s) ≪ 60s di Vercel; se il
// timeout di ricerca scende sotto ~58s, ridurre questo valore.
export const maxDuration = 60;

const BODY_MAX_BYTES = 16 * 1024;
const QUESTION_MAX_CHARS = 1_000;
const CLIENT_REQUEST_ID_MAX = 100;
const FRESHNESS_VALUES: ReadonlySet<string> = new Set(["any", "recent", "year"]);

/** Limiter in-memory (si azzera a ogni deploy): esportato per i test. */
export const researchRateLimiter = new InMemoryRateLimiter(DEFAULT_RATE_LIMIT_CONFIG);

const logger = createLogger("api");
const encoder = new TextEncoder();

function nowIso(): string {
  return new Date().toISOString();
}

function newRequestId(clientRequestId: string | undefined): string {
  if (clientRequestId !== undefined && clientRequestId.trim() !== "") {
    return clientRequestId.trim();
  }
  return `req-${crypto.randomUUID().slice(0, 8)}`;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

function errorResponse(
  code: "E_VALIDATION" | "E_RATE_LIMIT" | "E_INTERNAL",
  requestId: string,
  extra?: { retryAfterSeconds?: number },
): Response {
  const entry = ERROR_CATALOG[code];
  const body = {
    error: toErrorInfo(
      appError(code, { phase: entry.phase, retryable: entry.retryable }),
    ),
    requestId,
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (extra?.retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(Math.ceil(extra.retryAfterSeconds));
  }
  return Response.json(body, {
    status: entry.httpStatus ?? 500,
    headers,
  });
}

interface ParsedBody {
  question: string;
  options?: ResearchOptions;
  clientRequestId?: string;
}

/** Parsa e valida il body (max 16 KB). Su errore ritorna il motivo. */
function parseBody(text: string): { ok: true; value: ParsedBody } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "JSON malformato" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "body non è un oggetto" };
  }
  const record = raw as Record<string, unknown>;

  const allowedTop = new Set(["question", "options", "clientRequestId"]);
  for (const key of Object.keys(record)) {
    if (!allowedTop.has(key)) return { ok: false, reason: `campo sconosciuto: ${key}` };
  }

  if (typeof record.question !== "string") {
    return { ok: false, reason: "question non è una stringa" };
  }
  const question = record.question.replace(/\s+/g, " ").trim();
  if (question.length < 10 || question.length > QUESTION_MAX_CHARS) {
    return { ok: false, reason: "question fuori dai limiti (10..1000 caratteri)" };
  }

  let clientRequestId: string | undefined;
  if (record.clientRequestId !== undefined) {
    if (
      typeof record.clientRequestId !== "string" ||
      record.clientRequestId.length > CLIENT_REQUEST_ID_MAX
    ) {
      return { ok: false, reason: "clientRequestId non valido" };
    }
    clientRequestId = record.clientRequestId;
  }

  const limits = getLimits();
  let options: ResearchOptions | undefined;
  if (record.options !== undefined) {
    if (typeof record.options !== "object" || record.options === null || Array.isArray(record.options)) {
      return { ok: false, reason: "options non è un oggetto" };
    }
    const opts = record.options as Record<string, unknown>;
    const allowedOpts = new Set(["depth", "maxSources", "freshness", "lang"]);
    for (const key of Object.keys(opts)) {
      if (!allowedOpts.has(key)) return { ok: false, reason: `opzione sconosciuta: ${key}` };
    }

    let depth: 1 | 2 | 3 | undefined;
    if (opts.depth !== undefined) {
      if (typeof opts.depth !== "number" || !Number.isInteger(opts.depth)) {
        return { ok: false, reason: "depth non intero" };
      }
      depth = Math.min(3, Math.max(1, opts.depth)) as 1 | 2 | 3;
    }

    let maxSources: number | undefined;
    if (opts.maxSources !== undefined) {
      if (typeof opts.maxSources !== "number" || !Number.isInteger(opts.maxSources) || opts.maxSources < 1) {
        return { ok: false, reason: "maxSources non valido" };
      }
      maxSources = Math.min(limits.maxSources, opts.maxSources); // clamp ai limiti runtime
    }

    let freshness: Freshness | undefined;
    if (opts.freshness !== undefined) {
      if (typeof opts.freshness !== "string" || !FRESHNESS_VALUES.has(opts.freshness)) {
        return { ok: false, reason: "freshness non valida" };
      }
      freshness = opts.freshness as Freshness;
    }

    let lang: string | undefined;
    if (opts.lang !== undefined) {
      if (typeof opts.lang !== "string" || opts.lang.length > 20) {
        return { ok: false, reason: "lang non valido" };
      }
      lang = opts.lang.trim() || undefined;
    }

    if (depth !== undefined || maxSources !== undefined || freshness !== undefined || lang !== undefined) {
      options = {
        ...(depth !== undefined ? { depth } : {}),
        ...(maxSources !== undefined ? { maxSources } : {}),
        ...(freshness !== undefined ? { freshness } : {}),
        ...(lang !== undefined ? { lang } : {}),
      };
    }
  }

  return { ok: true, value: { question, options, clientRequestId } };
}

function makeErrorEvent(
  researchId: string,
  phase: string,
  err: unknown,
): ProgressEvent {
  return {
    type: "error",
    researchId,
    ts: nowIso(),
    phase,
    error: toErrorInfo(err),
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId(request.headers.get("x-client-request-id") ?? undefined);

  // 1) body con limite di dimensione
  let bodyBytes: ArrayBuffer;
  try {
    bodyBytes = await request.arrayBuffer();
  } catch {
    return errorResponse("E_VALIDATION", requestId);
  }
  if (bodyBytes.byteLength > BODY_MAX_BYTES) {
    return errorResponse("E_VALIDATION", requestId);
  }
  const parsed = parseBody(new TextDecoder().decode(bodyBytes));
  if (!parsed.ok) {
    logger.warn("api.validation", { requestId, reason: parsed.reason });
    return errorResponse("E_VALIDATION", requestId);
  }

  // 2) rate limit (sliding window oraria + concorrenza per IP)
  const ip = clientIp(request);
  const verdict = researchRateLimiter.acquire(ip);
  if (!verdict.allowed) {
    logger.warn("api.rate_limited", { requestId, ip, reason: verdict.reason });
    return errorResponse("E_RATE_LIMIT", requestId, {
      retryAfterSeconds: verdict.retryAfterMs / 1000,
    });
  }

  // 3) stream NDJSON (container per evitare narrowing da chiusura su let)
  const researchId = `res-${crypto.randomUUID().slice(0, 8)}-${Date.now().toString(36)}`;
  const streamState: { controller: ReadableStreamDefaultController<Uint8Array> | null } = {
    controller: null,
  };

  // Annullamento: il segnale del client (req.signal) e la disconnessione dello
  // stream (cancel) abortano un controller interno passato al motore.
  const runAbort = new AbortController();
  const onRequestAbort = (): void => runAbort.abort();
  request.signal.addEventListener("abort", onRequestAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(startController) {
      streamState.controller = startController;
    },
    cancel() {
      // client disconnesso: stream chiuso e motore abortito (nessun lavoro orfano)
      streamState.controller = null;
      runAbort.abort();
    },
  });

  const sink = createStreamSink({
    write(line: string): void {
      const controller = streamState.controller;
      if (controller === null) return;
      try {
        controller.enqueue(encoder.encode(line));
      } catch {
        // stream già chiuso (client andato via): ignora
      }
    },
  });

  const deps = buildResearchDeps(sink, logger);

  // il motore gira in background e alimenta lo stream; `finally` rilascia il rate
  void (async () => {
    try {
      await runResearch(
        {
          question: parsed.value.question,
          options: parsed.value.options,
          researchId,
        },
        deps,
        runAbort.signal,
      );
    } catch (err) {
      if (runAbort.signal.aborted) return; // cancelled già emesso dal motore
      logger.error("api.engine_crash", { researchId, error: String(err) });
      sink.emit(makeErrorEvent(researchId, "engine", err));
      sink.emit({
        type: "done",
        researchId,
        ts: nowIso(),
        status: "failed",
      });
    } finally {
      request.signal.removeEventListener("abort", onRequestAbort);
      researchRateLimiter.release(ip);
      const active = streamState.controller;
      streamState.controller = null;
      if (active !== null) {
        try {
          active.close();
        } catch {
          // già chiuso
        }
      }
    }
  })();

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-research-id": researchId,
      "x-request-id": requestId,
    },
  });
}
