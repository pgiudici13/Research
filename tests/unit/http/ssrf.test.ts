import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  assertAllowedFixedHost,
  assertSafeHttpUrl,
  describeDecision,
  isPrivateIp,
  isReservedHostname,
  type AddressLookup,
} from "@/lib/http/ssrf";

async function expectBlocked(rawUrl: string, lookup?: AddressLookup): Promise<void> {
  await expect(assertSafeHttpUrl(rawUrl, lookup ? { lookup } : {})).rejects.toMatchObject({
    code: "E_SSRF_BLOCKED",
  });
}

const lookupPublic = (async () => ["93.184.216.34"]) as AddressLookup;

describe("isPrivateIp", () => {
  it("blocca IP privati/riservati IPv4", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("172.16.5.5")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("0.0.0.0")).toBe(true);
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("224.0.0.1")).toBe(true); // multicast
  });

  it("blocca IP privati/riservati IPv6 (inclusi mapped)", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("ff02::1")).toBe(true); // multicast
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true); // v4-mapped loopback
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("consente IP pubblici", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
    expect(isPrivateIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
    expect(isPrivateIp("non-un-ip")).toBe(false);
  });
});

describe("isReservedHostname", () => {
  it("blocca hostname riservati", () => {
    expect(isReservedHostname("localhost")).toBe(true);
    expect(isReservedHostname("foo.localhost")).toBe(true);
    expect(isReservedHostname("raspberry.local")).toBe(true);
    expect(isReservedHostname("metadata.google.internal")).toBe(true);
    expect(isReservedHostname("host.internal")).toBe(true);
  });

  it("consente hostname pubblici", () => {
    expect(isReservedHostname("example.com")).toBe(false);
    expect(isReservedHostname("www.example.com")).toBe(false);
    expect(isReservedHostname("searxng.p-pi.example.com")).toBe(false);
  });
});

describe("assertSafeHttpUrl", () => {
  it("blocca schemi non http e userinfo senza risolvere nulla", async () => {
    await expectBlocked("file:///etc/passwd");
    await expectBlocked("ftp://example.com/file");
    await expectBlocked("http://user:pass@example.com/");
  });

  it("blocca IP letterali privati", async () => {
    await expectBlocked("http://127.0.0.1/");
    await expectBlocked("http://10.1.2.3/x");
    await expectBlocked("http://169.254.169.254/latest/meta-data");
    await expectBlocked("http://[::1]/");
  });

  it("blocca hostname riservati prima del lookup", async () => {
    const lookupSpy: AddressLookup = async () => {
      throw new Error("non deve essere chiamato");
    };
    await expectBlocked("http://localhost/", lookupSpy);
    await expectBlocked("http://metadata.google.internal/", lookupSpy);
  });

  it("consente URL pubbliche che risolvono a IP pubblici", async () => {
    const { url } = await assertSafeHttpUrl("https://example.com/a?b=1", {
      lookup: lookupPublic,
    });
    expect(url.hostname).toBe("example.com");
  });

  it("blocca host che risolvono (anche solo in parte) a IP privati", async () => {
    const mixed = (async () => ["93.184.216.34", "10.0.0.1"]) as AddressLookup;
    await expectBlocked("http://example.com/", mixed);
    const privateOnly = (async () => ["127.0.0.1"]) as AddressLookup;
    await expectBlocked("http://example.com/", privateOnly);
  });

  it("blocca se la risoluzione DNS fallisce o è vuota", async () => {
    const failing = (async () => {
      throw new Error("ENOTFOUND");
    }) as AddressLookup;
    await expectBlocked("http://example.com/", failing);
    const empty = (async () => []) as AddressLookup;
    await expectBlocked("http://example.com/", empty);
  });

  it("lancia AppError con code E_SSRF_BLOCKED", async () => {
    try {
      await assertSafeHttpUrl("http://192.168.1.1/");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("E_SSRF_BLOCKED");
      expect((err as AppError).retryable).toBe(false);
    }
  });
});

describe("assertAllowedFixedHost", () => {
  it("accetta una base https valida", () => {
    const url = assertAllowedFixedHost({ baseUrl: "https://searxng.example.com" });
    expect(url.hostname).toBe("searxng.example.com");
  });

  it("rifiuta http a meno di allowHttp esplicito", () => {
    expect(() =>
      assertAllowedFixedHost({ baseUrl: "http://127.0.0.1:8080" }),
    ).toThrowError(AppError);
    const ok = assertAllowedFixedHost({
      baseUrl: "http://127.0.0.1:8080",
      allowHttp: true,
    });
    expect(ok.port).toBe("8080");
  });

  it("rifiuta userinfo e URL non parsabili", () => {
    expect(() =>
      assertAllowedFixedHost({ baseUrl: "https://user:pass@host.example" }),
    ).toThrowError(AppError);
    expect(() => assertAllowedFixedHost({ baseUrl: "not a url" })).toThrowError(AppError);
  });
});

describe("describeDecision", () => {
  it("produce una descrizione deterministica per log/test", () => {
    expect(describeDecision("http://x/", "IP privato")).toBe("ssrf: blocked http://x/ (IP privato)");
  });
});
