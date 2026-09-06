import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  dedupeKey,
  domainOf,
  isSameResource,
  isTrackingParam,
} from "@/research/urls/canonical";

describe("isTrackingParam", () => {
  it("riconosce utm_* e i parametri noti", () => {
    expect(isTrackingParam("utm_source")).toBe(true);
    expect(isTrackingParam("UTM_CAMPAIGN")).toBe(true);
    expect(isTrackingParam("fbclid")).toBe(true);
    expect(isTrackingParam("gclid")).toBe(true);
    expect(isTrackingParam("ref")).toBe(true);
    expect(isTrackingParam("ref_src")).toBe(true);
    expect(isTrackingParam("spm")).toBe(true);
    expect(isTrackingParam("id")).toBe(false);
    expect(isTrackingParam("page")).toBe(false);
  });
});

describe("canonicalizeUrl", () => {
  it("rimuove frammenti, parametri di tracking e parametri vuoti", () => {
    const url = canonicalizeUrl(
      "https://Example.com/path?utm_source=x&ref=1&a=2&empty=&b=3#section",
    );
    expect(url).not.toBeNull();
    expect(url!.href).toBe("https://example.com/path?a=2&b=3");
  });

  it("ordina i parametri e conserva i duplicati", () => {
    const url = canonicalizeUrl("https://x.com/p?b=1&a=2&a=1");
    expect(url!.href).toBe("https://x.com/p?a=1&a=2&b=1");
  });

  it("rimuove la porta di default", () => {
    expect(canonicalizeUrl("https://x.com:443/a")!.href).toBe("https://x.com/a");
    expect(canonicalizeUrl("http://x.com:80/a")!.href).toBe("http://x.com/a");
    const nonDefault = canonicalizeUrl("http://x.com:8080/a")!;
    expect(nonDefault.host).toBe("x.com:8080");
  });

  it("tratta come uguali + e %20 nelle query", () => {
    const a = canonicalizeUrl("https://x.com/p?q=hello+world")!;
    const b = canonicalizeUrl("https://x.com/p?q=hello%20world")!;
    expect(isSameResource(a, b)).toBe(true);
  });

  it("restituisce null per schemi non http(s), userinfo o URL non parsabili", () => {
    expect(canonicalizeUrl("ftp://x.com/a")).toBeNull();
    expect(canonicalizeUrl("file:///etc/passwd")).toBeNull();
    expect(canonicalizeUrl("https://user:pass@x.com/a")).toBeNull();
    expect(canonicalizeUrl("non è un url")).toBeNull();
    expect(canonicalizeUrl("/percorso/relativo")).toBeNull();
  });
});

describe("dedupeKey / isSameResource", () => {
  it("non fonde http vs https", () => {
    expect(
      isSameResource(canonicalizeUrl("http://x.com/a")!, canonicalizeUrl("https://x.com/a")!),
    ).toBe(false);
  });

  it("non fonde path diversi dello stesso dominio", () => {
    expect(
      isSameResource(canonicalizeUrl("https://x.com/a")!, canonicalizeUrl("https://x.com/b")!),
    ).toBe(false);
  });

  it("fonde la stessa risorsa con o senza tracking", () => {
    expect(
      isSameResource(
        canonicalizeUrl("https://x.com/a?utm_source=s")!,
        canonicalizeUrl("https://x.com/a")!,
      ),
    ).toBe(true);
  });

  it("genera chiavi deterministiche e domainOf", () => {
    const canonical = canonicalizeUrl("https://Sub.Example.com:443/A?b=1")!;
    expect(dedupeKey(canonical)).toBe("https://sub.example.com/A?b=1");
    expect(domainOf(canonical)).toBe("sub.example.com");
  });
});
