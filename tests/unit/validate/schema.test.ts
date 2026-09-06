import { describe, expect, it } from "vitest";
import {
  ValidationError,
  arr,
  bool,
  enumOf,
  literal,
  nullable,
  num,
  obj,
  opt,
  safe,
  str,
} from "@/lib/validate/schema";

describe("guard primitivi", () => {
  it("str valida stringhe e lunghezze min/max", () => {
    expect(str()("ciao")).toBe("ciao");
    expect(str(3, 5)("ciao")).toBe("ciao");
    expect(() => str(4)("abc")).toThrow(ValidationError);
    expect(() => str(0, 2)("abc")).toThrow(/at most 2/);
    expect(() => str()(42)).toThrow(/expected string/);
  });

  it("num accetta solo numeri finiti e rispetta i range", () => {
    expect(num()(1.5)).toBe(1.5);
    expect(() => num()(NaN)).toThrow(ValidationError);
    expect(() => num()(Infinity)).toThrow(ValidationError);
    expect(() => num()("1")).toThrow(/finite number/);
    expect(() => num(0)(-1)).toThrow(ValidationError);
  });

  it("bool, enumOf e literal", () => {
    expect(bool()(true)).toBe(true);
    expect(() => bool()("true")).toThrow(/boolean/);

    const kind = enumOf(["a", "b"] as const);
    expect(kind("a")).toBe("a");
    expect(() => kind("c")).toThrow(/one of/);

    expect(literal(7)(7)).toBe(7);
    expect(() => literal(7)(8)).toThrow(/literal/);
  });
});

describe("guard compositi", () => {
  it("arr valida item e indicizza i percorsi", () => {
    const guard = arr(str(1));
    expect(guard(["a", "b"])).toEqual(["a", "b"]);
    expect(() => guard("nope")).toThrow(/expected array/);
    expect(() => guard(["ok", 3])).toThrow(/\[1\]/); // path con indice
    const nested = arr(obj({ a: num() }));
    expect(() => nested([{ a: 1 }, { a: "x" }])).toThrow(/\[1\]\.a/); // path annidato
    expect(() => arr(str(), 2)(["uno"])).toThrow(/at least 2/);
  });

  it("nullable e opt", () => {
    expect(nullable(str())("x")).toBe("x");
    expect(nullable(str())(null)).toBeNull();
    expect(() => nullable(str())(3)).toThrow(/expected string/);

    expect(opt(str())(undefined)).toBeUndefined();
    expect(opt(str())("x")).toBe("x");
  });
});

describe("obj", () => {
  const shape = { title: str(1), count: num(0), tags: arr(str()), extra: opt(bool()) };

  it("valida i campi dichiarati e il percorso annidato", () => {
    const out = obj(shape)({ title: "t", count: 1, tags: ["a"] });
    expect(out).toEqual({ title: "t", count: 1, tags: ["a"], extra: undefined });
    expect(() =>
      obj({ a: obj({ b: num() }) })({ a: { b: "x" } }),
    ).toThrow(/a\.b/);
  });

  it("chiave mancante obbligatoria → errore con percorso", () => {
    expect(() => obj(shape)({ title: "t", tags: [] })).toThrow(/count/);
  });

  it("chiave opzionale assente → undefined senza errore", () => {
    const out = obj(shape)({ title: "t", count: 0, tags: [] });
    expect(out.extra).toBeUndefined();
  });

  it("policy unknownKeys: strip di default, reject se richiesto", () => {
    const out = obj(shape)({ title: "t", count: 0, tags: [], sconosciuta: 1 });
    expect("sconosciuta" in out).toBe(false);

    const strict = obj(shape, { unknownKeys: "reject" });
    expect(() => strict({ title: "t", count: 0, tags: [], x: 1 })).toThrow(/at x: expected no unknown/);
    expect(strict({ title: "t", count: 0, tags: [] })).toBeTruthy();
  });

  it("rifiuta null, array e primitivi", () => {
    const guard = obj({ a: str() });
    expect(() => guard(null)).toThrow(/expected object/);
    expect(() => guard([])).toThrow(/expected object/);
    expect(() => guard("x")).toThrow(/expected object/);
  });
});

describe("safe", () => {
  it("restituisce ok/value o ok:false con ValidationError", () => {
    const ok = safe(str(1), "abc");
    expect(ok).toEqual({ ok: true, value: "abc" });

    const ko = safe(str(1), "");
    expect(ko.ok).toBe(false);
    if (!ko.ok) {
      expect(ko.error).toBeInstanceOf(ValidationError);
      expect(ko.error.message).toMatch(/at least 1/);
    }
  });

  it("non cattura errori non di validazione", () => {
    const throwing = (): never => {
      throw new Error("programming error");
    };
    expect(() => safe(throwing, 1)).toThrow(/programming error/);
  });
});
