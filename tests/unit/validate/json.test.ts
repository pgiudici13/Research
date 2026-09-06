import { describe, expect, it } from "vitest";
import {
  extractJsonBlock,
  extractJsonValue,
  parseJsonLoose,
  parseJsonStrict,
} from "@/lib/validate/json";

describe("parseJsonStrict / parseJsonLoose", () => {
  it("parseJsonStrict parsifica JSON valido e lancia su input invalido", () => {
    expect(parseJsonStrict('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJsonStrict("not json")).toThrow(SyntaxError);
  });

  it("parseJsonLoose restituisce null su input invalido e gestisce il BOM", () => {
    expect(parseJsonLoose("not json")).toBeNull();
    expect(parseJsonLoose("\uFEFF{\"a\":1}")).toEqual({ a: 1 });
    expect(parseJsonLoose("null")).toBeNull(); // null JSON → null sentinella
  });
});

describe("extractJsonValue / extractJsonBlock", () => {
  it("parse diretto quando il testo e' gia' JSON", () => {
    expect(extractJsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonValue("[1,2]")).toEqual([1, 2]);
  });

  it("estrae il blocco da una fence markdown", () => {
    const text = "Ecco il risultato:\n```json\n{\"a\":1,\"b\":[true,null]}\n```\nFine.";
    expect(extractJsonValue(text)).toEqual({ a: 1, b: [true, null] });
  });

  it("estrae il blocco con prologo ed epilogo testuale", () => {
    expect(extractJsonValue('Prologo: {"x": "y"} epilogo')).toEqual({ x: "y" });
  });

  it("gestisce } e ] dentro le stringhe (caso limite richiesto)", () => {
    const text = 'Testo prima {"msg": "chiudo } e [ ma resto } in stringa", "n": {"deep": [1, {"s": "}"}]}} dopo';
    expect(extractJsonValue(text)).toEqual({
      msg: "chiudo } e [ ma resto } in stringa",
      n: { deep: [1, { s: "}" }] },
    });
  });

  it("gestisce stringhe con backslash escapati", () => {
    const text = '{"a": "quote \\" inside"}';
    expect(extractJsonValue(text)).toEqual({ a: 'quote " inside' });
  });

  it("supporta blocchi array come top-level", () => {
    expect(extractJsonValue('testo [{"a":1},{"a":2}] fine')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("restituisce null su input senza blocchi o non bilanciati", () => {
    expect(extractJsonValue("nessun json qui")).toBeNull();
    expect(extractJsonValue('{"a": }')).toBeNull();
    expect(extractJsonValue('{"a":1')).toBeNull();
    expect(extractJsonValue('{"a":"stringa non chiusa}')).toBeNull();
  });

  it("extractJsonBlock accetta solo oggetti", () => {
    expect(extractJsonBlock('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonBlock("[1,2]")).toBeNull();
    expect(extractJsonBlock("niente")).toBeNull();
  });
});
