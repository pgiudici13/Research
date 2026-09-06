import { describe, expect, it } from "vitest";
import {
  REDACTED,
  createLogger,
  ctx,
  isLevelEnabled,
  redactValue,
  type Logger,
  type LoggerOptions,
} from "@/lib/logger";

function captureLogger(level: LoggerOptions["level"] = "debug"): {
  logger: Logger;
  lines: string[];
} {
  const lines: string[] = [];
  const logger = createLogger("test", { level, sink: (line) => lines.push(line) });
  return { logger, lines };
}

function parseLast(lines: string[]): Record<string, unknown> {
  const raw = lines[lines.length - 1];
  expect(raw).toBeTruthy();
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("logger di base", () => {
  it("emette una riga JSON con ts/level/scope/event e i campi", () => {
    const { logger, lines } = captureLogger();
    logger.info("research.started", { queries: 3 });
    expect(lines).toHaveLength(1);
    const rec = parseLast(lines);
    expect(rec.level).toBe("info");
    expect(rec.scope).toBe("test");
    expect(rec.event).toBe("research.started");
    expect(rec.queries).toBe(3);
    expect(typeof rec.ts).toBe("string");
  });

  it("filtra per livello", () => {
    expect(isLevelEnabled("info", "debug")).toBe(false);
    expect(isLevelEnabled("info", "info")).toBe(true);
    expect(isLevelEnabled("error", "warn")).toBe(false);

    const { logger, lines } = captureLogger("warn");
    logger.info("silenzioso");
    logger.warn("visibile");
    logger.error("grave");
    expect(lines).toHaveLength(2);
    expect(parseLast(lines).event).toBe("grave");
  });
});

describe("redazione", () => {
  it("redige le chiavi sensibili case-insensitive (anche annidate)", () => {
    const { logger, lines } = captureLogger();
    logger.info("x", {
      apiKey: "sk-secret",
      Authorization: "Bearer abc",
      token: "tok",
      nested: { api_token: "nested-secret", ok: "valore pulito" },
    });
    const rec = parseLast(lines);
    const text = JSON.stringify(rec);
    expect(text).not.toContain("sk-secret");
    expect(text).not.toContain("Bearer abc");
    expect(text).not.toContain("nested-secret");
    expect(rec.apiKey).toBe(REDACTED);
    expect(rec.Authorization).toBe(REDACTED);
    expect((rec.nested as Record<string, unknown>).ok).toBe("valore pulito");
  });

  it("redige Header/Request/Response e array annidati", () => {
    const { logger, lines } = captureLogger();
    logger.info("x", {
      headers: new Headers({ authorization: "Bearer tok123" }),
      list: [{ credential: "c1" }, { name: "ok" }],
    });
    const text = JSON.stringify(parseLast(lines));
    expect(text).not.toContain("tok123");
    expect(text).not.toContain("c1");
    expect(text).toContain("ok");
  });

  it("redige stringhe che sembrano credenziali anche su chiavi neutre", () => {
    const { logger, lines } = captureLogger();
    logger.info("x", { url: "https://example.com?t=sk-live-abcdef123456" });
    expect(JSON.stringify(parseLast(lines))).not.toContain("sk-live");
  });

  it("serializza Error senza stack trace", () => {
    const { logger, lines } = captureLogger();
    logger.error("phase.failed", { err: new Error("errore interno") });
    const rec = parseLast(lines);
    const text = JSON.stringify(rec);
    expect(text).toContain("errore interno");
    expect(text).not.toContain("at ");
    expect(text).not.toContain("stack");
  });
});

describe("correlazione", () => {
  it("ctx omette gli undefined e child aggiunge contesto", () => {
    expect(ctx("r1", undefined, "search")).toEqual({ researchId: "r1", phase: "search" });
    expect(ctx()).toEqual({});
    expect(redactValue({ a: 1 }, "")).toEqual({ a: 1 });
  });

  it("child() propaga il contesto base nei record", () => {
    const { logger, lines } = captureLogger();
    logger.child({ researchId: "r-123", phase: "planning" }).info("plan.ok");
    const rec = parseLast(lines);
    expect(rec.researchId).toBe("r-123");
    expect(rec.phase).toBe("planning");
  });
});

