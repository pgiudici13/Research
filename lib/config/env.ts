// server-only — modulo di configurazione: legge process.env.
// NON importare da codice client (la guardia runtime/ESLint arriva nello Step 24).
// Non loggare mai i valori letti qui: possono contenere segreti.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Valori di default per i servizi (nessun segreto qui). */
const DEFAULTS = {
  nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1",
  logLevel: "info",
  researchMaxQueries: 20,
  researchMaxSources: 8,
  researchMaxDepth: 2,
  researchTimeoutMs: 50_000,
  researchMaxFetchBytes: 300_000,
} as const;

/** Intervalli di validita' (clamp) per le variabili numeriche RESEARCH_*. */
const RANGES = {
  researchMaxQueries: { min: 1, max: 100 },
  researchMaxSources: { min: 1, max: 50 },
  researchMaxDepth: { min: 1, max: 5 },
  researchTimeoutMs: { min: 5_000, max: 600_000 },
  researchMaxFetchBytes: { min: 1_000, max: 10_000_000 },
} as const;

export interface Env {
  /** Facoltative: se assenti, il servizio e' "unconfigured" (nessun crash). */
  nvidiaApiKey?: string;
  nvidiaModel?: string;
  searxngBaseUrl?: string;
  researchInternalAuthToken?: string;
  /** Non segreto; documentato in .env.example. */
  cloudflareTunnelHostname?: string;

  nvidiaBaseUrl: string;
  logLevel: LogLevel;

  researchMaxQueries: number;
  researchMaxSources: number;
  researchMaxDepth: number;
  researchTimeoutMs: number;
  researchMaxFetchBytes: number;
}

function hasValue(v: string | undefined): v is string {
  return v !== undefined && v.trim() !== "";
}

function readStr(source: Record<string, string | undefined>, name: string): string | undefined {
  const raw = source[name];
  return hasValue(raw) ? raw.trim() : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function readInt(
  source: Record<string, string | undefined>,
  name: string,
  def: number,
  min: number,
  max: number,
): number {
  const raw = source[name];
  if (!hasValue(raw)) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(
      `Invalid environment variable ${name}: expected an integer, got "${raw}".`,
    );
  }
  return clamp(n, min, max);
}

/**
 * Parsa e valida le variabili d'ambiente da una sorgente (di default process.env).
 * Funzione pura: testabile senza toccare process.env.
 */
export function parseEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const rawLevel = (readStr(source, "LOG_LEVEL") ?? DEFAULTS.logLevel).toLowerCase();
  const logLevel = LOG_LEVELS.find((l) => l === rawLevel);
  if (!logLevel) {
    throw new Error(
      `Invalid environment variable LOG_LEVEL: expected one of ${LOG_LEVELS.join("|")}, got "${rawLevel}".`,
    );
  }

  return {
    nvidiaApiKey: readStr(source, "NVIDIA_API_KEY"),
    nvidiaBaseUrl: readStr(source, "NVIDIA_BASE_URL") ?? DEFAULTS.nvidiaBaseUrl,
    nvidiaModel: readStr(source, "NVIDIA_MODEL"),
    searxngBaseUrl: readStr(source, "SEARXNG_BASE_URL"),
    researchInternalAuthToken: readStr(source, "RESEARCH_INTERNAL_AUTH_TOKEN"),
    cloudflareTunnelHostname: readStr(source, "CLOUDFLARE_TUNNEL_HOSTNAME"),

    logLevel,

    researchMaxQueries: readInt(
      source,
      "RESEARCH_MAX_QUERIES",
      DEFAULTS.researchMaxQueries,
      RANGES.researchMaxQueries.min,
      RANGES.researchMaxQueries.max,
    ),
    researchMaxSources: readInt(
      source,
      "RESEARCH_MAX_SOURCES",
      DEFAULTS.researchMaxSources,
      RANGES.researchMaxSources.min,
      RANGES.researchMaxSources.max,
    ),
    researchMaxDepth: readInt(
      source,
      "RESEARCH_MAX_DEPTH",
      DEFAULTS.researchMaxDepth,
      RANGES.researchMaxDepth.min,
      RANGES.researchMaxDepth.max,
    ),
    researchTimeoutMs: readInt(
      source,
      "RESEARCH_TIMEOUT_MS",
      DEFAULTS.researchTimeoutMs,
      RANGES.researchTimeoutMs.min,
      RANGES.researchTimeoutMs.max,
    ),
    researchMaxFetchBytes: readInt(
      source,
      "RESEARCH_MAX_FETCH_BYTES",
      DEFAULTS.researchMaxFetchBytes,
      RANGES.researchMaxFetchBytes.min,
      RANGES.researchMaxFetchBytes.max,
    ),
  };
}

let cached: Env | undefined;

/**
 * Restituisce l'ambiente validato, letto una sola volta (cache di modulo).
 * Le variabili non vengono rilette a ogni chiamata.
 */
export function getEnv(): Env {
  if (cached === undefined) {
    cached = parseEnv();
  }
  return cached;
}

/** Solo per test: azzera la cache di modulo. */
export function resetEnvCache(): void {
  cached = undefined;
}
