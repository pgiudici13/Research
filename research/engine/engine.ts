// Motore Deep Research (Step 17): loop orchestrator.
// planner -> query -> SearXNG -> dedup -> ranking -> fetch -> estrazione ->
// evidenze -> verifica/gap -> (round successivi se necessari) -> contraddizioni
// -> handoff a sintesi/citazioni (porte iniettate: Step 18-19).
//
// INVARIANTI:
// - Loop SEMPRE limitato: ogni iterazione decrementa un budget (query, fonti,
//   depth, tempo, LLM) e controlla l'AbortSignal a ogni confine di fase.
// - Mai rifetch dello stesso canonicalUrl nella stessa ricerca (cache per-run).
// - Mai evidenze da URL non analizzati; mai citazioni vuote o inventate.
// - Errore locale (pagina giù, query vuota, LLM giù) NON ferma la ricerca.

import { getLimits } from "@/lib/config/limits";
import { toErrorInfo } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import type {
  Claim,
  Citation,
  Conflict,
  ResearchLimitations,
  ResearchOptions,
  ProgressEvent,
  ResearchPlan,
  ResearchReport,
  ResearchStatus,
  SearchResultItem,
  SourceCandidate,
  SourceRecord,
  SubQuestion,
} from "@/lib/types";
import { canonicalizeUrl, dedupeKey, domainOf } from "@/research/urls/canonical";
import {
  dedupeSearchResults,
  mergeCandidates,
  type DeduplicatedSearchItem,
} from "@/research/urls/dedupe";
import type { EvidenceStore } from "@/research/evidence/store";
import { shouldContinue, type CoverageReport } from "@/research/verification/coverage";
import { RunBudget } from "./budget";
import type { EngineDeps } from "./deps";

export interface ResearchRunInput {
  question: string;
  options?: ResearchOptions;
  /** Id predefinito (es. dall'API per l'header X-Research-Id); default: generato. */
  researchId?: string;
}

/** FNV-1a (32 bit, hex) per id deterministici di fonte dal canonicalUrl. */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sourceIdFromKey(key: string): string {
  return `src-${fnv1aHex(key)}`;
}

/** Converte un item deduplicato (Step 9) in SourceCandidate stabile. */
export function toSourceCandidate(item: DeduplicatedSearchItem): SourceCandidate {
  const canonical = canonicalizeUrl(item.url);
  const canonicalUrl = canonical ? canonical.href : item.url;
  const key = canonical ? dedupeKey(canonical) : item.url;
  const domain = canonical
    ? domainOf(canonical)
    : (() => {
        try {
          return new URL(item.url).hostname;
        } catch {
          return item.url;
        }
      })();
  return {
    sourceId: sourceIdFromKey(key),
    url: item.url,
    canonicalUrl,
    dedupeKey: key,
    domain,
    title: item.title,
    snippet: item.snippet,
    engines: item.engine.split(",").map((e) => e.trim()).filter((e) => e !== ""),
    occurrences: item.occurrences,
    publishedDate: item.publishedDate,
  };
}

/** Concorrenza limitata su una lista (mai oltre il limite). */
async function mapConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

export async function runResearch(
  input: ResearchRunInput,
  deps: EngineDeps,
  signal: AbortSignal,
): Promise<ResearchReport> {
  const startedAt = deps.now();
  const startedMs = startedAt.getTime();
  const researchId =
    input.researchId ??
    `res-${startedMs.toString(36)}-${fnv1aHex(Math.random().toString()).slice(0, 6)}`;
  const logger = deps.logger ?? createLogger("engine");
  const limits = getLimits();
  const budget = new RunBudget({ limits, options: input.options, startedAt: startedMs });

  const nowIso = (): string => deps.now().toISOString();
  const aborted = (): boolean => signal.aborted;

  const emit = (type: ProgressEvent["type"], fields: Record<string, unknown>): void => {
    deps.sink.emit({ type, researchId, ts: nowIso(), ...fields } as ProgressEvent);
  };

  const limitations: ResearchLimitations = {
    missingSources: false,
    llmUnavailable: false,
    searchUnavailable: false,
    budgetExceeded: false,
    timeBudgetExceeded: false,
    notes: [],
  };
  const noteLimitation = (code: string | undefined, text: string): void => {
    limitations.notes.push(text);
    emit("limitation", { note: text, ...(code !== undefined ? { code } : {}) });
  };

  const finishCancelled = (): ResearchReport => {
    const report: ResearchReport = {
      researchId,
      question: input.question,
      status: "cancelled",
      sections: [],
      claims: [],
      conflicts: [],
      citations: [],
      sourcesConsulted: [],
      sourcesUsed: [],
      limitations: { ...limitations, notes: [...limitations.notes, "Ricerca annullata dall'utente."] },
      budgetUsed: budget.toBudgetUsage(),
      startedAt: new Date(startedMs).toISOString(),
      completedAt: nowIso(),
      durationMs: budget.elapsed(deps.now()),
    };
    deps.sink.emit({ type: "status", researchId, ts: nowIso(), status: "cancelled" });
    deps.sink.emit({ type: "done", researchId, ts: nowIso(), status: "cancelled" });
    return report;
  };

  emit("status", { status: "planning" });
  emit("phase", { phase: "planning", status: "started" });

  // --- 1) planner ---------------------------------------------------------------
  let plan: ResearchPlan | null = null;
  let planFailed = false;
  try {
    const planOutcome = await deps.plan(
      { question: input.question, options: input.options },
      { researchId, signal, logger, now: deps.now },
    );
    plan = planOutcome.plan;
    if (planOutcome.usedFallback) {
      limitations.llmUnavailable = true;
      noteLimitation(
        planOutcome.llmError?.code ?? "E_LLM_UNAVAILABLE",
        "Piano generato senza LLM (modalità degradata).",
      );
    }
  } catch (err) {
    if (aborted()) return finishCancelled();
    planFailed = true;
    limitations.llmUnavailable = true;
    noteLimitation("E_LLM_UNAVAILABLE", "Planner non disponibile: nessun piano generato.");
    logger.warn("engine.plan_failed", { researchId, errorCode: toErrorInfo(err).code });
  }
  emit("phase", { phase: "planning", status: "ended" });

  if (planFailed || plan === null) {
    const report = assembleReport({
      researchId,
      question: input.question,
      status: "failed",
      plan: null,
      budget,
      startedMs,
      nowIso,
      durationMs: budget.elapsed(deps.now()),
      limitations,
      sourcesConsulted: [],
      evidenceStore: deps.evidenceStore(),
      conflicts: [],
      sections: [],
      claims: [],
      citations: [],
    });
    emitFinal(report, deps);
    return report;
  }

  // --- stato del run --------------------------------------------------------------
  const subQuestions: readonly SubQuestion[] = plan.subQuestions;
  let evidenceStore: EvidenceStore = deps.evidenceStore({ maxTotal: limits.maxEvidencesTotal });
  const sourcesConsulted: SourceRecord[] = [];
  let candidates: SourceCandidate[] = [];
  let conflicts: Conflict[] = [];
  let lastCoverage: CoverageReport | null = null;
  let evidenceDropped = 0;
  let stoppedReason = "";
  const runQueries = new Set<string>();

  // --- 2) round di ricerca ---------------------------------------------------------
  for (let round = 1; round <= budget.maxDepth; round++) {
    budget.depthUsed = round;
    if (aborted()) return finishCancelled();
    if (!budget.canContinue(deps.now())) {
      limitations.timeBudgetExceeded = true;
      stoppedReason = "time-budget";
      noteLimitation("E_TIMEOUT_RESEARCH", "Tempo massimo di ricerca raggiunto.");
      break;
    }

    const roundQueries: Array<{ query: string; purpose: string; subQuestionId?: string }> = [];
    if (round === 1) {
      for (const q of plan.queries) {
        if (runQueries.has(q.query)) continue;
        runQueries.add(q.query);
        roundQueries.push({ query: q.query, purpose: q.purpose, subQuestionId: q.subQuestionId });
      }
    } else if (lastCoverage !== null) {
      for (const gap of lastCoverage.gaps) {
        for (const suggested of gap.suggestedQueries) {
          if (runQueries.has(suggested)) continue;
          runQueries.add(suggested);
          roundQueries.push({
            query: suggested,
            purpose: "follow-up",
            subQuestionId: gap.subQuestionId,
          });
        }
      }
    }

    const queriesToRun = roundQueries.slice(0, budget.remainingQueries());
    if (queriesToRun.length === 0) {
      if (round === 1) {
        limitations.budgetExceeded = true;
        stoppedReason = "budget-query";
        noteLimitation("E_BUDGET_EXCEEDED", "Budget query esaurito prima di iniziare.");
      } else {
        stoppedReason = "no-followup-queries";
      }
      break;
    }

    emit("phase", { phase: "searching", status: "started" });
    const itemsThisRound: SearchResultItem[] = [];

    for (let i = 0; i < queriesToRun.length; i++) {
      if (aborted()) return finishCancelled();
      const q = queriesToRun[i];
      budget.consumeQuery();
      emit("query", { query: q.query, purpose: q.purpose, index: i + 1, total: queriesToRun.length });

      const outcome = await deps.search({ query: q.query }, { researchId, signal, logger });
      if (outcome.ok === false) {
        budget.markSearchError();
        emit("error", { error: outcome.error, phase: "searching" });
        noteLimitation(outcome.error.code, `Query senza esito: ${outcome.error.message}`);
        continue;
      }
      for (const item of outcome.items) {
        itemsThisRound.push(item);
        const canonical = canonicalizeUrl(item.url);
        emit("result-found", {
          url: item.url,
          title: item.title,
          domain: canonical ? domainOf(canonical) : item.url,
          engine: item.engine,
          ...(item.snippet !== undefined ? { snippet: item.snippet.slice(0, 200) } : {}),
        });
      }
    }
    emit("phase", { phase: "searching", status: "ended" });

    // dedup + merge candidati (Step 9)
    const incoming = dedupeSearchResults(itemsThisRound).map((item) => toSourceCandidate(item));
    candidates = mergeCandidates(candidates, incoming);

    const available = candidates.filter((c) => !budget.hasAttempted(c.canonicalUrl));
    if (available.length === 0) {
      if (round === 1 && budget.searchErrors > 0) {
        limitations.searchUnavailable = true;
        stoppedReason = "search-down";
        noteLimitation("E_SEARCH_UNAVAILABLE", "Motore di ricerca non disponibile.");
      } else {
        noteLimitation("E_SEARCH_EMPTY", "Nessun risultato nuovo in questo round.");
        stoppedReason = "no-results";
      }
      break;
    }

    const ranked = await deps.rank(available, {
      query: plan.objective,
      subQuestion: subQuestions.map((s) => s.text).join(" "),
      requireFreshness: plan.constraints.freshness !== "any",
    });
    const fetchBudget = Math.min(budget.remainingSources(), budget.maxFetchPerRound);
    if (fetchBudget <= 0) {
      limitations.budgetExceeded = true;
      stoppedReason = "budget-sources";
      noteLimitation("E_BUDGET_EXCEEDED", "Budget fonti esaurito.");
      break;
    }
    const fetchCandidates = ranked.slice(0, fetchBudget).map((r) => r.candidate);

    // --- fetch (concorrenza 4) -----------------------------------------------------
    emit("phase", { phase: "fetching", status: "started" });
    const docs: Array<{ candidate: SourceCandidate; page: import("@/lib/types").ExtractedPage | null }> =
      [];

    await mapConcurrency(fetchCandidates, 4, async (candidate) => {
      if (aborted()) return;
      budget.markFetchAttempt();
      budget.markAttempted(candidate.canonicalUrl);
      emit("source-consulted", { sourceId: candidate.sourceId, url: candidate.url, status: "fetching" });

      const outcome = await deps.fetchPage(candidate.url, { signal, logger });
      if (outcome.ok === false) {
        budget.markFetchFailed();
        emit("source-fetched", {
          sourceId: candidate.sourceId,
          url: candidate.url,
          domain: candidate.domain,
          status: "failed",
          error: outcome.error,
        });
        sourcesConsulted.push({
          sourceId: candidate.sourceId,
          urlFinal: candidate.url,
          canonicalUrl: candidate.canonicalUrl,
          domain: candidate.domain,
          title: candidate.title,
          status: "failed",
          failure: outcome.error,
          fetchedAt: nowIso(),
        });
        return;
      }

      const page = deps.extract(outcome.doc, { sourceId: candidate.sourceId, logger });
      const status = page.text === "" ? "unsupported" : "fetched";
      const record: SourceRecord = {
        sourceId: candidate.sourceId,
        urlFinal: outcome.doc.urlFinal,
        canonicalUrl: outcome.doc.canonicalUrl,
        domain: candidate.domain,
        title: page.title || candidate.title,
        author: page.author,
        publishedDate: page.publishedDate,
        lang: page.lang,
        status,
        fetchedAt: nowIso(),
      };
      sourcesConsulted.push(record);
      docs.push({ candidate, page });
      emit("source-fetched", {
        sourceId: candidate.sourceId,
        url: candidate.url,
        domain: candidate.domain,
        title: record.title,
        status: record.status === "fetched" ? "fetched" : "unsupported",
      });
      if (status === "fetched") budget.consumeSource();
    });
    emit("phase", { phase: "fetching", status: "ended" });

    // --- estrazione evidenze ---------------------------------------------------------
    emit("phase", { phase: "extracting", status: "started" });
    await mapConcurrency(docs, 4, async ({ page }) => {
      if (aborted() || page === null) return;
      const extracted = deps.makeEvidence({
        page,
        subQuestions,
        retrievedAt: page.extractedAt,
        allowLowConfidenceFallback: true,
      });
      for (const evidence of extracted) {
        const before = evidenceStore;
        evidenceStore = evidenceStore.addEvidence(evidence);
        evidenceDropped += evidenceStore.droppedCount - before.droppedCount;
        emit("evidence", {
          evidenceId: evidence.id,
          sourceId: evidence.sourceId,
          url: evidence.url,
          passagePreview: evidence.passage.slice(0, 200),
        });
      }
    });
    emit("phase", { phase: "extracting", status: "ended" });

    // --- analisi: copertura e gap ------------------------------------------------------
    emit("phase", { phase: "analyzing", status: "started" });
    const sourceDates = new Map<string, string | undefined>();
    for (const record of sourcesConsulted) sourceDates.set(record.sourceId, record.publishedDate);

    lastCoverage = deps.assessCoverage(plan, evidenceStore, { sourceDates });
    emit("phase", { phase: "analyzing", status: "ended" });

    const decision = shouldContinue({
      round,
      maxDepth: budget.maxDepth,
      budgetLeft: budget.remainingQueries(),
      gaps: lastCoverage.gaps,
    });

    if (decision.go) continue;
    stoppedReason = decision.reason;
    if (decision.reason === "depth-reached" && lastCoverage.gaps.length > 0) {
      limitations.missingSources = true;
      noteLimitation(undefined, "Profondità massima raggiunta con gap residui.");
    } else if (decision.reason === "budget-exhausted") {
      limitations.budgetExceeded = true;
      noteLimitation("E_BUDGET_EXCEEDED", "Budget di ricerca esaurito.");
    }
    break;
  }

  if (aborted()) return finishCancelled();

  // --- 3) contraddizioni consolidate ---------------------------------------------------
  conflicts = deps.detectConflicts(evidenceStore.all());
  for (const conflict of conflicts) {
    emit("conflict", {
      conflictId: conflict.id,
      topic: conflict.topic,
      severity: conflict.severity,
    });
  }

  // --- 4) verifica (stato; checker opzionale negli Step successivi) -----------------------
  emit("phase", { phase: "verifying", status: "started" });
  emit("phase", { phase: "verifying", status: "ended" });

  // --- 5) sintesi + citazioni (porte iniettate: Step 18-19) -------------------------------
  const allEvidences = evidenceStore.all();
  let sections: ResearchReport["sections"] = [];
  let claims: Claim[] = [];
  let citations: Citation[] = [];
  let synthOk = true;

  if (allEvidences.length > 0) {
    emit("phase", { phase: "synthesizing", status: "started" });
    try {
      budget.consumeLlm();
      const output = await deps.synthesize({
        researchId,
        question: input.question,
        plan,
        evidences: allEvidences,
        sourceRecords: sourcesConsulted,
        conflicts,
        limitations,
        budgetUsed: budget.toBudgetUsage(),
        startedAt: new Date(startedMs).toISOString(),
        now: deps.now,
      });
      sections = output.sections;
      claims = output.claims;
      if (output.usedFallback === true) {
        limitations.llmUnavailable = true;
        noteLimitation(
          output.llmError?.code ?? "E_LLM_UNAVAILABLE",
          output.llmError?.code === "E_LLM_INVALID_RESPONSE"
            ? "Sintesi generata senza LLM: output del modello non valido."
            : "Sintesi generata senza LLM (modalità degradata).",
        );
      }
      citations = await deps.mapCitations({
        sections,
        claims,
        evidences: allEvidences,
        sourceRecords: sourcesConsulted,
      });
    } catch (err) {
      if (aborted()) return finishCancelled();
      synthOk = false;
      limitations.llmUnavailable = true;
      noteLimitation("E_LLM_UNAVAILABLE", "Sintesi non disponibile: report senza sezioni.");
      logger.warn("engine.synthesis_failed", { researchId, errorCode: toErrorInfo(err).code });
    }
    emit("phase", { phase: "synthesizing", status: "ended" });
  }

  // --- 6) report finale ---------------------------------------------------------------------
  const hasUsable = allEvidences.length > 0;
  if (!hasUsable) {
    limitations.missingSources = true; // nessuna evidenza: fonti mancanti
  } else if (lastCoverage !== null) {
    limitations.missingSources = lastCoverage.gaps.length > 0;
    if (lastCoverage.overall !== "sufficient") {
      noteLimitation(
        undefined,
        "Copertura incompleta: alcune sotto-domande restano senza evidenze sufficienti.",
      );
    }
  }

  const failed = !hasUsable;
  const partial =
    !failed &&
    (limitations.missingSources ||
      limitations.llmUnavailable ||
      limitations.searchUnavailable ||
      limitations.timeBudgetExceeded ||
      limitations.budgetExceeded ||
      !synthOk);
  const status: ResearchStatus = failed ? "failed" : partial ? "partial" : "completed";

  const report = assembleReport({
    researchId,
    question: input.question,
    status,
    plan,
    budget,
    startedMs,
    nowIso,
    durationMs: budget.elapsed(deps.now()),
    limitations,
    sourcesConsulted,
    evidenceStore,
    conflicts,
    sections,
    claims,
    citations,
  });
  emit("status", { status });
  emitFinal(report, deps);

  logger.info("engine.completed", {
    researchId,
    status,
    queries: budget.queriesUsed,
    sources: budget.sourcesAnalyzed,
    evidences: allEvidences.length,
    rounds: budget.depthUsed,
    stoppedReason,
    evidenceDropped,
  });
  return report;
}

// --- assemble report ---------------------------------------------------------------------------

interface ReportParts {
  researchId: string;
  question: string;
  status: ResearchStatus;
  plan: ResearchPlan | null;
  budget: RunBudget;
  startedMs: number;
  nowIso: () => string;
  durationMs: number;
  limitations: ResearchLimitations;
  sourcesConsulted: SourceRecord[];
  evidenceStore: EvidenceStore;
  conflicts: Conflict[];
  sections: ResearchReport["sections"];
  claims: Claim[];
  citations: Citation[];
}

function assembleReport(parts: ReportParts): ResearchReport {
  const { citations } = parts;
  const sourcesUsed = [...new Set(citations.map((c) => c.sourceId))].sort();
  return {
    researchId: parts.researchId,
    question: parts.question,
    status: parts.status,
    sections: parts.sections,
    claims: parts.claims,
    conflicts: parts.conflicts,
    citations,
    sourcesConsulted: parts.sourcesConsulted,
    sourcesUsed,
    limitations: parts.limitations,
    budgetUsed: parts.budget.toBudgetUsage(),
    startedAt: new Date(parts.startedMs).toISOString(),
    completedAt: parts.nowIso(),
    durationMs: parts.durationMs,
  };
}

function emitFinal(report: ResearchReport, deps: EngineDeps): void {
  const ts = new Date().toISOString();
  deps.sink.emit({
    type: "result",
    researchId: report.researchId,
    ts,
    schemaVersion: 1,
    report,
  });
  deps.sink.emit({ type: "done", researchId: report.researchId, ts, status: report.status });
}
