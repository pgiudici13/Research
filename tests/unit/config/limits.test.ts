import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv, resetEnvCache } from "@/lib/config/env";
import {
  checkBudget,
  computeLimits,
  getLimits,
  resetLimitsCache,
} from "@/lib/config/limits";

describe("computeLimits", () => {
  it("mappa i valori env sui limiti principali", () => {
    const env = parseEnv({
      RESEARCH_MAX_QUERIES: "30",
      RESEARCH_MAX_SOURCES: "10",
      RESEARCH_MAX_DEPTH: "3",
      RESEARCH_TIMEOUT_MS: "60000",
      RESEARCH_MAX_FETCH_BYTES: "500000",
    });
    const limits = computeLimits(env);
    expect(limits.maxQueries).toBe(30);
    expect(limits.maxSources).toBe(10);
    expect(limits.maxDepth).toBe(3);
    expect(limits.researchTimeoutMs).toBe(60_000);
    expect(limits.maxFetchBytes).toBe(500_000);
  });

  it("espone le costanti interne di C.2 (concorrenza, timeout, retry, dimensioni)", () => {
    const limits = computeLimits(parseEnv({}));
    expect(limits.searchConcurrency).toBe(2);
    expect(limits.fetchConcurrency).toBe(4);
    expect(limits.llmConcurrency).toBe(1);
    expect(limits.llmTimeoutMs).toBe(25_000);
    expect(limits.searchTimeoutMs).toBe(15_000);
    expect(limits.fetchTimeoutMs).toBe(15_000);
    expect(limits.llmMaxAttempts).toBe(3);
    expect(limits.searchMaxAttempts).toBe(3);
    expect(limits.fetchMaxAttempts).toBe(2);
    expect(limits.maxRedirects).toBe(5);
    expect(limits.pageTextMaxChars).toBe(60_000);
    expect(limits.passageMaxChars).toBe(1_200);
    expect(limits.maxEvidencesPerPage).toBe(8);
    expect(limits.maxEvidencesTotal).toBe(40);
    expect(limits.maxSearchResultsPerQuery).toBe(10);
    expect(limits.plannerMaxTokens).toBe(1_000);
    expect(limits.synthesisMaxTokens).toBe(4_000);
    expect(limits.questionMinChars).toBe(10);
    expect(limits.questionMaxChars).toBe(1_000);
  });
});

describe("getLimits", () => {
  afterEach(() => {
    resetLimitsCache();
    resetEnvCache();
    vi.unstubAllEnvs();
  });

  it("usa i default senza variabili RESEARCH_* impostate", () => {
    resetLimitsCache();
    resetEnvCache();
    const limits = getLimits();
    expect(limits.maxQueries).toBe(20);
    expect(limits.maxSources).toBe(8);
    expect(limits.maxDepth).toBe(2);
    expect(limits.researchTimeoutMs).toBe(50_000);
    expect(limits.maxFetchBytes).toBe(300_000);
  });

  it("riflette le variabili RESEARCH_* da process.env", () => {
    vi.stubEnv("RESEARCH_MAX_QUERIES", "12");
    resetLimitsCache();
    resetEnvCache();
    expect(getLimits().maxQueries).toBe(12);
  });
});

describe("checkBudget", () => {
  it("confronta contatore e limite", () => {
    expect(checkBudget(0, 5)).toBe(true);
    expect(checkBudget(4, 5)).toBe(true);
    expect(checkBudget(5, 5)).toBe(false);
    expect(checkBudget(6, 5)).toBe(false);
  });
});
