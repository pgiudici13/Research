// Helper di type-guard componibili, senza dipendenze.
// Ogni guard valida un valore e RESTITUISCE il valore tipizzato; su input
// malformato lancia ValidationError con percorso deterministico.
// Usare `safe(guard, value)` quando si vuole scartare un singolo item senza
// far fallire l'intera struttura (es. un risultato di ricerca rotto).

export class ValidationError extends Error {
  readonly path: string;
  readonly expected: string;
  readonly received: string;

  constructor(path: string, expected: string, received: unknown) {
    super(
      `invalid value at ${path === "" ? "<root>" : path}: expected ${expected}, received ${describeValue(received)}`,
    );
    this.name = "ValidationError";
    this.path = path;
    this.expected = expected;
    this.received = describeValue(received);
  }
}

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "string") {
    const s = v as string;
    return s.length > 40 ? `string(${s.length} chars)` : `string "${s}"`;
  }
  if (t === "object") return "object";
  if (t === "number" || t === "boolean") return String(v);
  return t;
}

export type Guard<T> = (value: unknown, path?: string) => T;

export interface OptionalGuard<T> extends Guard<T | undefined> {
  readonly __optional?: true;
}

function isOptional(guard: Guard<unknown>): boolean {
  return (guard as { __optional?: true }).__optional === true;
}

function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return parent === "" ? String(key) : `${parent}.${key}`;
}

// --- Guard primitivi ---------------------------------------------------------

export function str(min = 0, max = Infinity): Guard<string> {
  return (value, path = "") => {
    if (typeof value !== "string") throw new ValidationError(path, "string", value);
    if (value.length < min) throw new ValidationError(path, `string with at least ${min} chars`, value);
    if (value.length > max) throw new ValidationError(path, `string with at most ${max} chars`, value);
    return value;
  };
}

export function num(min = -Infinity, max = Infinity): Guard<number> {
  return (value, path = "") => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ValidationError(path, "finite number", value);
    }
    if (value < min) throw new ValidationError(path, `number >= ${min}`, value);
    if (value > max) throw new ValidationError(path, `number <= ${max}`, value);
    return value;
  };
}

export function bool(): Guard<boolean> {
  return (value, path = "") => {
    if (typeof value !== "boolean") throw new ValidationError(path, "boolean", value);
    return value;
  };
}

export function literal<T extends string | number | boolean | null>(expected: T): Guard<T> {
  return (value, path = "") => {
    if (!Object.is(value, expected)) {
      throw new ValidationError(path, `literal ${JSON.stringify(expected)}`, value);
    }
    return expected;
  };
}

// --- Composti ----------------------------------------------------------------

export function arr<T>(item: Guard<T>, min = 0, max = Infinity): Guard<T[]> {
  return (value, path = "") => {
    if (!Array.isArray(value)) throw new ValidationError(path, "array", value);
    if (value.length < min) throw new ValidationError(path, `array with at least ${min} items`, value);
    if (value.length > max) throw new ValidationError(path, `array with at most ${max} items`, value);
    return value.map((itemValue, i) => item(itemValue, childPath(path, i)));
  };
}

export function enumOf<T extends string>(values: readonly T[]): Guard<T> {
  const allowed = new Set<string>(values);
  return (value, path = "") => {
    if (typeof value !== "string" || !allowed.has(value)) {
      throw new ValidationError(path, `one of ${values.map((v) => JSON.stringify(v)).join("|")}`, value);
    }
    return value as T;
  };
}

/** Campo facoltativo: accetta `undefined` e consente la chiave assente in obj(). */
export function opt<T>(guard: Guard<T>): OptionalGuard<T> {
  const fn = (value: unknown, path = "") =>
    value === undefined ? undefined : guard(value, path);
  const optional = fn as OptionalGuard<T>;
  Object.defineProperty(optional, "__optional", { value: true, enumerable: false });
  return optional;
}

/** Campo nullable: accetta `null`. */
export function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value, path = "") => (value === null ? null : guard(value, path));
}

// --- Oggetti ------------------------------------------------------------------

export type ShapeOf<T extends object> = { [K in keyof T]-?: Guard<T[K]> };

export interface ObjectOptions {
  /** Policy per le chiavi non dichiarate: `"strip"` le ignora, `"reject"` fallisce. Default: `"strip"`. */
  unknownKeys?: "strip" | "reject";
}

export function obj<T extends object>(
  shape: ShapeOf<T>,
  options: ObjectOptions = {},
): Guard<T> {
  const rejectUnknown = options.unknownKeys === "reject";
  const shapeRecord = shape as unknown as Record<string, Guard<unknown>>;
  return (value, path = "") => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ValidationError(path, "object", value);
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(shapeRecord)) {
      const guard = shapeRecord[key];
      if (!(key in record)) {
        if (isOptional(guard)) {
          out[key] = undefined;
          continue;
        }
        throw new ValidationError(childPath(path, key), "present key", undefined);
      }
      out[key] = guard(record[key], childPath(path, key));
    }

    if (rejectUnknown) {
      for (const key of Object.keys(record)) {
        if (!(key in shapeRecord)) {
          throw new ValidationError(childPath(path, key), "no unknown keys allowed", record[key]);
        }
      }
    }
    return out as T;
  };
}

// --- Esecuzione sicura ----------------------------------------------------------

export type SafeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ValidationError };

/** Esegue una guard senza lanciare: utile per scartare item malformati. */
export function safe<T>(guard: Guard<T>, value: unknown): SafeResult<T> {
  try {
    return { ok: true, value: guard(value) };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: err };
    throw err; // errore di programmazione, non di validazione
  }
}
