// Canonicalizzazione URL (funzioni pure). Non segue redirect (lo fa il
// fetcher, Step 10): dopo un redirect si ricanonicalizza l'URL finale.

/** Parametri di tracking rimossi (match esatto o prefisso `utm_`). */
export const TRACKING_PARAMS: readonly string[] = [
  "fbclid",
  "gclid",
  "msclkid",
  "twclid",
  "igshid",
  "ref",
  "ref_src",
  "spm",
  "mc_cid",
  "mc_eid",
  "yclid",
  "dclid",
  "vero_id",
];

export function isTrackingParam(key: string): boolean {
  return key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.includes(key.toLowerCase());
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * Canonicalizza un URL http(s): host minuscolo, porta di default rimossa,
 * frammento rimosso, query normalizzata (parametri di tracking/ vuoti rimossi,
 * coppie ordinate). Restituisce `null` se non è un URL http(s) parsabile.
 */
export function canonicalizeUrl(rawUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  url.hash = "";
  if (DEFAULT_PORTS[url.protocol] && url.port === DEFAULT_PORTS[url.protocol]) {
    url.port = "";
  }

  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (isTrackingParam(key)) continue;
    if (value === "") continue;
    kept.push([key, value]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  const search = new URLSearchParams();
  for (const [key, value] of kept) search.append(key, value);
  const searchString = search.toString();
  url.search = searchString === "" ? "" : `?${searchString}`;

  return url;
}

/**
 * Chiave di deduplicazione: scheme://host + pathname + query normalizzata.
 * NOTA: scheme e porta fanno parte della chiave (http vs https NON si fondono).
 */
export function dedupeKey(canonical: URL): string {
  const query = canonical.search === "" ? "" : canonical.search;
  return `${canonical.protocol}//${canonical.host}${canonical.pathname}${query}`;
}

/** True se due URL canonicalizzati rappresentano la stessa risorsa. */
export function isSameResource(a: URL, b: URL): boolean {
  return dedupeKey(a) === dedupeKey(b);
}

/** Hostname (lowercase) di un URL canonicalizzato. */
export function domainOf(canonical: URL): string {
  return canonical.hostname;
}
