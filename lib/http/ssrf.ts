// Guardia SSRF (AGENTS.md §9): due livelli.
//   1) assertAllowedFixedHost: destinazione FISSA e allowlist (es. SearXNG).
//   2) assertSafeHttpUrl: URL arbitrarie (fetch pagine) — schema http/https,
//      niente userinfo, niente hostname/IP riservati o privati/loopback/
//      link-local/metadata, e blocco se QUALUNQUE indirizzo risolto dal DNS
//      è vietato (difesa da DNS rebinding parziale).
//
// La guardia va riapplicata a OGNI hop di redirect (lo fa il fetcher, Step 10).
// Policy di rete documentata: non blocchiamo le porte non standard sugli host
// pubblici (impedirebbe servizi legittimi); la protezione SSRF si basa su
// schema/hostname/IP/DNS. Il fetch con IP pinnato + Host header è valutato
// nello Step 10; qui resta il check DNS subito prima del fetch.

import { BlockList, isIP } from "node:net";
import { appError } from "@/lib/errors";

const E_SSRF = (reason: string, details?: unknown) =>
  appError("E_SSRF_BLOCKED", { phase: "fetch", details: { reason, ...(details ?? {}) } });

// --- Blocco per IP ------------------------------------------------------------

const PRIVATE_NETS = new BlockList();
function block(cidr: string): void {
  const [net, prefix] = cidr.split("/");
  const type = isIP(net) === 6 ? "ipv6" : "ipv4";
  PRIVATE_NETS.addSubnet(net, Number(prefix), type);
}
// IPv4: RFC1918, loopback, link-local, CGNAT, metadata, TEST-NET, multicast, reserved.
block("0.0.0.0/8");
block("10.0.0.0/8");
block("100.64.0.0/10");
block("127.0.0.0/8");
block("169.254.0.0/16");
block("172.16.0.0/12");
block("192.168.0.0/16");
block("192.0.0.0/24");
block("192.0.2.0/24");
block("198.18.0.0/15");
block("198.51.100.0/24");
block("203.0.113.0/24");
block("224.0.0.0/4");
block("240.0.0.0/4");
block("255.255.255.255/32");
// IPv6: non specificato, loopback, ULA, link-local, multicast.
block("::/128");
block("::1/128");
block("fc00::/7");
block("fe80::/10");
block("ff00::/8");

/** True se l'IP (v4 o v6) è privato/loopback/link-local/metadata/vietato. */
export function isPrivateIp(ip: string): boolean {
  if (ip.toLowerCase().startsWith("::ffff:")) {
    // IPv4-mapped IPv6: valuta la parte v4 embedded.
    const v4 = ip.slice("::ffff:".length);
    if (isIP(v4) === 4) return isPrivateIp(v4);
  }
  const type = isIP(ip);
  if (type === 0) return false; // non è un IP: non è questo il controllo giusto
  return PRIVATE_NETS.check(ip, type === 6 ? "ipv6" : "ipv4");
}

// --- Hostname riservati ---------------------------------------------------------

const RESERVED_HOSTNAMES =
  /(^|\.)(localhost|local|internal|home\.arpa|in-addr\.arpa|ip6\.arpa)$/i;
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.azure.internal",
  "169.254.169.254",
]);

export function isReservedHostname(host: string): boolean {
  const h = host.toLowerCase();
  return RESERVED_HOSTNAMES.test(h) || METADATA_HOSTS.has(h);
}

// --- Lookup DNS iniettabile ------------------------------------------------------

export type AddressLookup = (hostname: string) => Promise<string[]>;

/** Lookup di default: dns.promises.lookup con tutti gli indirizzi. */
export async function defaultAddressLookup(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

// --- Livello 1: destinazione fissa (allowlist) -------------------------------------

export interface FixedHostConfig {
  baseUrl: string;
  /** Consente http:// solo se esplicitamente richiesto (dev locale). Default: false. */
  allowHttp?: boolean;
}

/** Verifica che la base URL configurata sia https (o http se allowHttp) senza userinfo. */
export function assertAllowedFixedHost(config: FixedHostConfig): URL {
  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw E_SSRF("base URL non parsabile", { host: config.baseUrl });
  }
  if (parsed.protocol !== "https:" && !(config.allowHttp && parsed.protocol === "http:")) {
    throw E_SSRF(`schema non consentito per host fisso: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw E_SSRF("userinfo non consentito", { host: parsed.host });
  }
  if (!parsed.hostname) throw E_SSRF("host mancante");
  return parsed;
}

// --- Livello 2: URL arbitrarie -------------------------------------------------------

export interface SafeHttpUrlOptions {
  lookup?: AddressLookup;
}

export interface SafeHttpUrlResult {
  url: URL;
}

/**
 * Valida un URL http(s) arbitrario: schema, userinfo, hostname/IP riservati,
 * quindi risoluzione DNS con blocco se un qualunque indirizzo è vietato.
 * Lancia AppError(E_SSRF_BLOCKED) con `details.reason` (mai inviato al client).
 */
export async function assertSafeHttpUrl(
  rawUrl: string,
  options: SafeHttpUrlOptions = {},
): Promise<SafeHttpUrlResult> {
  const lookup = options.lookup ?? defaultAddressLookup;
  const url = tryParseHttpUrl(rawUrl);
  const host = url.hostname.toLowerCase();

  if (url.username || url.password) {
    throw E_SSRF("userinfo non consentito", { host });
  }

  // Hostname riservato: nessuna risoluzione necessaria.
  if (isReservedHostname(host)) {
    throw E_SSRF("hostname riservato", { host });
  }

  const literalType = isIP(host);
  if (literalType !== 0) {
    if (isPrivateIp(host)) {
      throw E_SSRF("IP privato/riservato", { host });
    }
    return { url };
  }

  // Hostname: risolvi e blocca se UN QUALUNQUE indirizzo è vietato.
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw E_SSRF("risoluzione DNS fallita", { host });
  }
  if (addresses.length === 0) {
    throw E_SSRF("nessun indirizzo risolto", { host });
  }
  const blocked = addresses.find((ip) => isPrivateIp(ip));
  if (blocked !== undefined) {
    throw E_SSRF("IP privato/riservato tra gli indirizzi risolti", {
      host,
      blockedIp: blocked,
      addresses: addresses.length,
    });
  }
  return { url };
}

function tryParseHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw E_SSRF("URL non parsabile");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw E_SSRF(`schema non consentito: ${parsed.protocol}`);
  }
  return parsed;
}

/** Descrizione deterministica per log/test. */
export function describeDecision(url: string, reason: string): string {
  return `ssrf: blocked ${url} (${reason})`;
}
