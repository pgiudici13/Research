// Guardia di rete per i test (Step 29): nessun test deve dipendere da servizi
// esterni reali. Il `fetch` globale è sostituito con un wrapper che consente
// SOLO destinazioni loopback (http://127.0.0.1, localhost, [::1]) — i test che
// girano server HTTP locali (fetcher/SSRF) restano validi — e fallisce con un
// errore esplicito su qualunque altra destinazione. I moduli che devono usare
// un fetch iniettabile lo ricevono via `fetchImpl` (pattern esistente).

const realFetch = globalThis.fetch;

function destinationOf(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input.url);
}

const originalFetch: typeof fetch = (...args) => realFetch(...args);

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = destinationOf(input);
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[test] protocollo di rete non consentito: ${url.href}`);
  }
  if (!isLoopback) {
    throw new Error(
      `[test] rete reale non consentita: ${url.href}. Usa un fetch iniettabile (fetchImpl) o un server loopback.`,
    );
  }
  return originalFetch(input, init);
}) as typeof fetch;
