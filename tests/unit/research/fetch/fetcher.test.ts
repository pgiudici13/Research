import { createServer, type Server } from "node:http";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressLookup } from "@/lib/http/ssrf";
import { fetchPage } from "@/research/fetch/fetcher";

const HOST = "pages.example.test"; // host "pubblico" finto; la rete reale resta su 127.0.0.1
const PUBLIC_IP = "93.184.216.34";

const publicLookup: AddressLookup = async () => [PUBLIC_IP];

interface RouteOutcome {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | string;
}

const routes = new Map<string, (count: number) => RouteOutcome>();

let baseUrl = "";
let requests = 0;

function register(path: string, handler: (count: number) => RouteOutcome): void {
  routes.set(path, handler);
}

const server: Server = createServer((req, res) => {
  requests++;
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const route = routes.get(url.pathname);
  if (!route) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const outcome = route(requests);
  res.writeHead(outcome.status, outcome.headers ?? { "content-type": "text/html; charset=utf-8" });
  res.end(outcome.body);
});

beforeEach(async () => {
  if (!server.listening) {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://${HOST}:${port}`;
  }
  routes.clear();
  requests = 0;
});

afterAll(async () => {
  if (server.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** fetch "proxy": l'host finto pubblico viene instradato al server locale. */
function proxyFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = new URL(String(input));
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}${target.pathname}${target.search}`;
  return fetch(local, {
    method: init?.method,
    headers: init?.headers,
    signal: init?.signal,
    redirect: "manual",
    cache: "no-store",
  });
}

function context(overrides: Parameters<typeof fetchPage>[1] = {}) {
  return { fetchImpl: proxyFetch as typeof fetch, lookup: publicLookup, baseDelayMs: 1, ...overrides };
}

const body = (text: string) => new TextEncoder().encode(text);

describe("fetchPage", () => {
  it("scarica una pagina 200 e restituisce il documento grezzo", async () => {
    const html = "<html><body><p>Articolo di prova</p></body></html>";
    register("/ok", () => ({ status: 200, body: html }));
    const outcome = await fetchPage(`${baseUrl}/ok`, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.doc.status).toBe(200);
    expect(outcome.doc.contentType).toBe("text/html");
    expect(outcome.doc.textBytes).toBe(body(html).length);
    expect(outcome.doc.truncated).toBe(false);
    expect(outcome.doc.urlFinal).toBe(`${baseUrl}/ok`);
    expect(new TextDecoder().decode(outcome.doc.body)).toBe(html);
  });

  it("404: errore non ritentabile con una sola richiesta", async () => {
    register("/missing", () => ({ status: 404, body: "no" }));
    const outcome = await fetchPage(`${baseUrl}/missing`, context());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("E_FETCH_FAILED");
      expect(outcome.error.retryable).toBe(false);
    }
    expect(requests).toBe(1);
  });

  it("500: retry controllato poi errore ritentabile", async () => {
    register("/error", () => ({ status: 500, body: "boom" }));
    const outcome = await fetchPage(`${baseUrl}/error`, context({ maxAttempts: 2 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.retryable).toBe(true);
    expect(requests).toBe(2);
  });

  it("segue redirect manuali (301→302→200) e identifica urlFinal", async () => {
    register("/r1", () => ({ status: 301, headers: { location: `${baseUrl}/r2` }, body: "" }));
    register("/r2", () => ({ status: 302, headers: { location: `${baseUrl}/final` }, body: "" }));
    register("/final", () => ({ status: 200, body: "<p>finale</p>" }));
    const outcome = await fetchPage(`${baseUrl}/r1`, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.doc.urlFinal).toBe(`${baseUrl}/final`);
    expect(outcome.doc.canonicalUrl).toBe(`${baseUrl}/final`);
    expect(requests).toBe(3);
  });

  it("blocca con E_SSRF_BLOCKED un redirect verso IP privato", async () => {
    register("/evil", () => ({
      status: 302,
      headers: { location: "http://127.0.0.1:9/private" },
      body: "",
    }));
    const outcome = await fetchPage(`${baseUrl}/evil`, context());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("E_SSRF_BLOCKED");
    expect(requests).toBe(1); // nessun fetch verso il privato
  });

  it("rispetta il tetto di redirect (niente loop infinito)", async () => {
    register("/a", () => ({ status: 301, headers: { location: `${baseUrl}/b` }, body: "" }));
    register("/b", () => ({ status: 301, headers: { location: `${baseUrl}/c` }, body: "" }));
    register("/c", () => ({ status: 301, headers: { location: `${baseUrl}/d` }, body: "" }));
    register("/d", () => ({ status: 200, body: "x" }));
    const outcome = await fetchPage(`${baseUrl}/a`, context({ maxRedirects: 2 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("E_FETCH_FAILED");
    expect(requests).toBeLessThanOrEqual(4);
  });

  it("tronca il body oltre il limite marcando truncated", async () => {
    const big = "<p>" + "a".repeat(20_000) + "</p>";
    register("/big", () => ({ status: 200, body: big }));
    const outcome = await fetchPage(`${baseUrl}/big`, context({ maxBytes: 4_096 }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.doc.truncated).toBe(true);
    expect(outcome.doc.textBytes).toBe(4_096);
  });

  it("content-type non supportato: piccolo → UNSUPPORTED, enorme → TOO_LARGE", async () => {
    register("/small.pdf", () => ({
      status: 200,
      headers: { "content-type": "application/pdf" },
      body: "%PDF-1.4 piccolo",
    }));
    register("/big.pdf", () => ({
      status: 200,
      headers: { "content-type": "application/pdf" },
      body: "%PDF-1.4 " + "x".repeat(20_000),
    }));
    const small = await fetchPage(`${baseUrl}/small.pdf`, context());
    expect(small.ok).toBe(false);
    if (!small.ok) expect(small.error.code).toBe("E_FETCH_UNSUPPORTED");

    const big = await fetchPage(`${baseUrl}/big.pdf`, context({ maxBytes: 4_096 }));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error.code).toBe("E_FETCH_TOO_LARGE");
  });

  it("timeout su fetch che non risponde: E_FETCH_FAILED", async () => {
    const hanging = (async (_input: unknown, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
      return new Response("mai");
    }) as typeof fetch;
    const started = Date.now();
    const outcome = await fetchPage("https://pages.example.test/slow", {
      fetchImpl: hanging,
      lookup: publicLookup,
      timeoutMs: 15,
      maxAttempts: 1,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("E_FETCH_FAILED");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("annullamento utente: propaga AbortError (non un outcome)", async () => {
    const controller = new AbortController();
    const hanging = (async (_input: unknown, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
      return new Response("mai");
    }) as typeof fetch;
    setTimeout(() => controller.abort(), 5);
    await expect(
      fetchPage("https://pages.example.test/x", {
        fetchImpl: hanging,
        lookup: publicLookup,
        signal: controller.signal,
        timeoutMs: 5_000,
        maxAttempts: 2,
      }),
    ).rejects.toThrow("aborted");
  });

  it("pagina non raggiungibile → outcome ok:false, mai eccezione", async () => {
    const exploding = (async () => {
      throw new TypeError("fetch failed: connection refused");
    }) as typeof fetch;
    const outcome = await fetchPage("https://pages.example.test/down", {
      fetchImpl: exploding,
      lookup: publicLookup,
      maxAttempts: 1,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("E_FETCH_FAILED");
  });
});
