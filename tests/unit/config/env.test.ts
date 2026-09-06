import { afterEach, describe, expect, it, vi } from "vitest";
import { getEnv, parseEnv, resetEnvCache } from "@/lib/config/env";

describe("parseEnv", () => {
  it("usa i default quando l'ambiente e' vuoto", () => {
    const env = parseEnv({});
    expect(env.nvidiaApiKey).toBeUndefined();
    expect(env.nvidiaModel).toBeUndefined();
    expect(env.searxngBaseUrl).toBeUndefined();
    expect(env.researchInternalAuthToken).toBeUndefined();
    expect(env.cloudflareTunnelHostname).toBeUndefined();

    expect(env.nvidiaBaseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(env.logLevel).toBe("info");

    expect(env.researchMaxQueries).toBe(20);
    expect(env.researchMaxSources).toBe(8);
    expect(env.researchMaxDepth).toBe(2);
    expect(env.researchTimeoutMs).toBe(50_000);
    expect(env.researchMaxFetchBytes).toBe(300_000);
  });

  it("legge e normalizza i valori espliciti", () => {
    const env = parseEnv({
      NVIDIA_API_KEY: "  sk-test-123  ",
      NVIDIA_MODEL: "meta/llama-test",
      SEARXNG_BASE_URL: "https://searxng.example.com",
      LOG_LEVEL: "DEBUG",
      RESEARCH_MAX_DEPTH: "3",
      RESEARCH_TIMEOUT_MS: "40000",
    });
    expect(env.nvidiaApiKey).toBe("sk-test-123");
    expect(env.nvidiaModel).toBe("meta/llama-test");
    expect(env.searxngBaseUrl).toBe("https://searxng.example.com");
    expect(env.logLevel).toBe("debug");
    expect(env.researchMaxDepth).toBe(3);
    expect(env.researchTimeoutMs).toBe(40_000);
  });

  it("tratta le stringhe di soli spazi come assenti", () => {
    const env = parseEnv({ NVIDIA_API_KEY: "   ", NVIDIA_MODEL: "" });
    expect(env.nvidiaApiKey).toBeUndefined();
    expect(env.nvidiaModel).toBeUndefined();
  });

  it("lancia un errore per numeri non validi", () => {
    expect(() =>
      parseEnv({ RESEARCH_MAX_DEPTH: "abc" }),
    ).toThrow(/RESEARCH_MAX_DEPTH/);
    expect(() =>
      parseEnv({ RESEARCH_TIMEOUT_MS: "12.5" }),
    ).toThrow(/RESEARCH_TIMEOUT_MS/); // non intero
  });

  it("applica il clamp ai limiti (min e max)", () => {
    const env = parseEnv({
      RESEARCH_MAX_DEPTH: "9", // sopra il max 5
      RESEARCH_TIMEOUT_MS: "1000", // sotto il min 5000
      RESEARCH_MAX_QUERIES: "-5", // sotto il min 1
      RESEARCH_MAX_FETCH_BYTES: "9999999999", // sopra il max
    });
    expect(env.researchMaxDepth).toBe(5);
    expect(env.researchTimeoutMs).toBe(5_000);
    expect(env.researchMaxQueries).toBe(1);
    expect(env.researchMaxFetchBytes).toBe(10_000_000);
  });

  it("lancia un errore per LOG_LEVEL non valido", () => {
    expect(() => parseEnv({ LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });
});

describe("getEnv", () => {
  afterEach(() => {
    resetEnvCache();
    vi.unstubAllEnvs();
  });

  it("e' memoizzato: non rilegge process.env dopo il primo accesso", () => {
    vi.stubEnv("RESEARCH_MAX_DEPTH", "4");
    resetEnvCache();
    const first = getEnv();
    expect(first.researchMaxDepth).toBe(4);

    vi.stubEnv("RESEARCH_MAX_DEPTH", "2");
    expect(getEnv()).toBe(first); // stessa istanza dalla cache
    expect(getEnv().researchMaxDepth).toBe(4);
  });
});
