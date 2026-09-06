import { describe, expect, it } from "vitest";
import {
  ERROR_CATALOG,
  ERROR_CODES,
  AppError,
  appError,
  isAppError,
  isRetryable,
  isRetryableError,
  toErrorInfo,
} from "@/lib/errors";

describe("ERROR_CATALOG", () => {
  it("copre tutti i codici stabili C.4 con messaggi non vuoti", () => {
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      const entry = ERROR_CATALOG[code];
      expect(entry.message.length).toBeGreaterThan(0);
      expect(entry.phase.length).toBeGreaterThan(0);
    }
  });

  it("rispetta la tabella retryable/httpStatus di C.4", () => {
    expect(ERROR_CATALOG.E_VALIDATION.retryable).toBe(false);
    expect(ERROR_CATALOG.E_VALIDATION.httpStatus).toBe(400);
    expect(ERROR_CATALOG.E_RATE_LIMIT.httpStatus).toBe(429);
    expect(ERROR_CATALOG.E_INTERNAL.httpStatus).toBe(500);
    expect(ERROR_CATALOG.E_LLM_TIMEOUT.retryable).toBe(true);
    expect(ERROR_CATALOG.E_SEARCH_UNAVAILABLE.retryable).toBe(true);
    expect(ERROR_CATALOG.E_LLM_INVALID_RESPONSE.retryable).toBe(false);
    expect(ERROR_CATALOG.E_SSRF_BLOCKED.retryable).toBe(false);
    expect(ERROR_CATALOG.E_TIMEOUT_RESEARCH.httpStatus).toBeUndefined();
  });
});

describe("AppError", () => {
  it("propaga code, phase di default, retryable e messaggio di catalogo", () => {
    const err = new AppError("E_SEARCH_TIMEOUT");
    expect(err.code).toBe("E_SEARCH_TIMEOUT");
    expect(err.phase).toBe("search");
    expect(err.retryable).toBe(true);
    expect(err.message).toBe(ERROR_CATALOG.E_SEARCH_TIMEOUT.message);
  });

  it("accetta phase custom e message non sensibile", () => {
    const err = appError("E_SEARCH_UNAVAILABLE", { phase: "round-2" });
    expect(err.phase).toBe("round-2");
    expect(isAppError(err)).toBe(true);
    expect(isRetryableError(err)).toBe(true);
  });

  it("isRetryable distingue i codici", () => {
    expect(isRetryable("E_LLM_TIMEOUT")).toBe(true);
    expect(isRetryable("E_VALIDATION")).toBe(false);
  });
});

describe("toErrorInfo", () => {
  it("converte AppError senza stack/cause/details", () => {
    const info = toErrorInfo(
      new AppError("E_FETCH_TOO_LARGE", { phase: "fetch", details: { url: "x" } }),
    );
    expect(info).toEqual({
      code: "E_FETCH_TOO_LARGE",
      message: ERROR_CATALOG.E_FETCH_TOO_LARGE.message,
      phase: "fetch",
      retryable: false,
    });
    expect(JSON.stringify(info)).not.toContain("stack");
    expect(JSON.stringify(info)).not.toContain("details");
  });

  it("non espone mai il messaggio grezzo di errori non-AppError (anche con segreti)", () => {
    const info = toErrorInfo(new Error("secret sk-123 in message"));
    expect(info.code).toBe("E_INTERNAL");
    expect(info.message).toBe(ERROR_CATALOG.E_INTERNAL.message);
    expect(info.message).not.toContain("sk-123");
  });

  it("gestisce input non-Error come E_INTERNAL", () => {
    expect(toErrorInfo("stringa").code).toBe("E_INTERNAL");
    expect(toErrorInfo(undefined).code).toBe("E_INTERNAL");
  });
});
