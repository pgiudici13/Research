// Test osservabilità (Step 28): redazione garantita su payload complessi
// (oggetti annidati, Error con causa, Headers, array, chiavi sensibili) e
// forma base delle metriche per-run (lib/metrics.ts). Ogni riga log emessa è
// JSON valido e non contiene mai segreti (chiavi, token, header authorization).

import { describe, expect, it } from "vitest";
import { createLogger, REDACTED } from "@/lib/logger";
import { emptyMetrics, type ResearchMetrics } from "@/lib/metrics";

function captureLogger(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger("test", { level: "debug", sink: (line) => lines.push(line) });
  return { logger, lines };
}

describe("redazione regressione (payload complessi)", () => {
  it("oggetti annidati, Error con causa e Headers non fanno trapelare segreti", () => {
    const { logger, lines } = captureLogger();
    const secret = "sk-test-abcdef1234567890abcdef";
    const cause = new Error(`causa con ${secret}`);
    const headers = new Headers({ authorization: `Bearer ${secret}` });
    logger.error("prova.complessa", {
      researchId: "res-abc",
      config: {
        apiKey: secret,
        nested: { authToken: secret, ok: true },
        list: ["a", secret, 3],
        cause,
        headers,
        message: secret,
      },
    });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record.event).toBe("prova.complessa");
    expect(record.researchId).toBe("res-abc");
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).toContain(REDACTED);
    // ogni voce dell'array sensibile è redatta per chiave (list conserva gli altri)
    const config = record.config as Record<string, unknown>;
    expect(config.apiKey).toBe(REDACTED);
    expect((config.nested as Record<string, unknown>).authToken).toBe(REDACTED);
    expect(config.headers).toBe(REDACTED);
  });

  it("valori che sembrano credenziali vengono redatti anche senza chiave sensibile", () => {
    const { logger, lines } = captureLogger();
    logger.info("prova.valori", {
      note: "token di esempio: xoxb-1234567890-abcdefghijk e ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const serialized = JSON.stringify(JSON.parse(lines[0]!));
    expect(serialized).not.toContain("xoxb-");
    expect(serialized).not.toContain("ghp_");
    expect(serialized).toContain(REDACTED);
  });

  it("il contesto di correlazione (child) entra in ogni riga, senza annidamenti", () => {
    const { logger, lines } = captureLogger();
    const child = logger.child({ researchId: "res-xyz", clientRequestId: "req-1" });
    child.info("prova.correlazione", { n: 1 });
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record.scope).toBe("test");
    expect(record.researchId).toBe("res-xyz");
    expect(record.clientRequestId).toBe("req-1");
    expect(record.n).toBe(1);
  });
});

describe("ResearchMetrics (lib/metrics.ts)", () => {
  it("emptyMetrics restituisce tutte le metriche a zero con fasi vuote", () => {
    const metrics: ResearchMetrics = emptyMetrics();
    expect(metrics).toEqual({
      rounds: 0,
      queries: 0,
      resultsFound: 0,
      sourcesConsulted: 0,
      sourcesFetched: 0,
      sourcesFailed: 0,
      evidences: 0,
      conflicts: 0,
      llmCalls: 0,
      llmFailures: 0,
      searchErrors: 0,
      fetchErrors: 0,
      bytesFetched: 0,
      planFallback: false,
      phases: {},
    });
  });
});
