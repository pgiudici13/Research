// Completezza testi UI errori (Step 26): ogni codice della tassonomia C.4 ha
// una voce utente NON vuota in `ERROR_COPY` (`lib/ui-copy.ts`), e i testi non
// contengono dettagli infrastrutturali o segreti.

import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@/lib/errors";
import { ERROR_COPY } from "@/lib/ui-copy";

describe("ERROR_COPY (lib/ui-copy.ts)", () => {
  it("ogni ErrorCode ha una voce di testo (completezza)", () => {
    const keys = Object.keys(ERROR_COPY).sort();
    expect(keys).toEqual([...ERROR_CODES].sort());
  });

  it("ogni testo è non vuoto, in italiano e senza dettagli tecnici/segreti", () => {
    for (const code of ERROR_CODES) {
      const text = ERROR_COPY[code];
      expect(text, code).toBeTruthy();
      expect(text.trim().length, code).toBeGreaterThan(10);
      expect(text, code).not.toMatch(/NVIDIA|API key|Bearer|token|stack|at file/i);
      expect(text, code).not.toMatch(/\bsk-[a-z]/i);
    }
  });

  it("i testi usati dalla UI restano disponibili (network/generic + codici)", () => {
    // vincolo di struttura usato da hooks/use-research.ts (errorTextForKey)
    expect(ERROR_COPY.E_RATE_LIMIT.length).toBeGreaterThan(0);
    expect(ERROR_COPY.E_VALIDATION.length).toBeGreaterThan(0);
    expect(ERROR_COPY.E_INTERNAL.length).toBeGreaterThan(0);
  });
});
