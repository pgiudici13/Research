// Audit di sicurezza statico (Step 24): confini server-only effettivi,
// nomi di variabili segrete fuori dai punti consentiti, assenza nei bundle
// pubblici, validazione input robusta e rate-limit policy di default.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProgressEvent } from "@/lib/types";
import { parseEventLine } from "@/research/progress/events";
import { getLimits } from "@/lib/config/limits";
import { POST } from "@/app/api/research/route";

function parseLines(text: string): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const event = parseEventLine(line);
    expect(event, `riga non parsabile: ${line.slice(0, 80)}`).not.toBeNull();
    if (event !== null) events.push(event);
  }
  return events;
}

const ROOT = process.cwd();

function trackedFilesUnder(dir: string): string[] {
  const all = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.startsWith(`${dir}/`));
  return all;
}

function readRelative(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

/** Import specifier di un file sorgente (stringhe statiche). */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:import\s+(?:[^'"]*?\s+from\s+)?|from\s+|require\(\s*|export\s+.*?\s+from\s+|import\s*\()\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

describe("confini server-only (client non importa mai lib/server)", () => {
  const clientDirs = ["app", "components", "hooks"];
  const forbidden =
    /(?:lib\/server(?:\/|$))|(?:lib\/config\/env)|(?:@\/lib\/logger)|(?:research\/engine(?:\/|$))/;

  it("nessun file client importa moduli server-only", () => {
    const offenders: string[] = [];
    for (const dir of clientDirs) {
      for (const file of trackedFilesUnder(dir)) {
        // la route API è server-side: si esclude app/api
        if (file.startsWith("app/api/")) continue;
        if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
        const source = readRelative(file);
        for (const specifier of importSpecifiers(source)) {
          if (forbidden.test(specifier)) {
            offenders.push(`${file} -> ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("i nomi delle variabili segrete NON compaiono nel codice client", () => {
    const secrets = ["NVIDIA_API_KEY", "RESEARCH_INTERNAL_AUTH_TOKEN"];
    const offenders: string[] = [];
    for (const dir of clientDirs) {
      for (const file of trackedFilesUnder(dir)) {
        if (file.startsWith("app/api/")) continue;
        if (!/\.(ts|tsx)$/.test(file)) continue;
        const source = readRelative(file);
        for (const secret of secrets) {
          if (source.includes(secret)) offenders.push(`${file}: ${secret}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("i nomi segreti compaiono solo nei file consentiti (server/env/test/docs)", () => {
    const secrets = ["NVIDIA_API_KEY", "RESEARCH_INTERNAL_AUTH_TOKEN"];
    const allowedPrefixes = [
      "lib/config/env.ts",
      "lib/server/",
      "tests/",
      "scripts/",
      "docs/",
      "AGENTS.md",
      "STEP.md",
      "README.md",
      ".env.example",
    ];
    const allFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f !== "" && !f.startsWith("package-lock.json"));
    const offenders: string[] = [];
    for (const file of allFiles) {
      if (!allowedPrefixes.some((prefix) => file === prefix || file.startsWith(prefix))) {
        const source = readRelative(file);
        for (const secret of secrets) {
          if (source.includes(secret)) offenders.push(`${file}: ${secret}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("il bundle pubblico (se la build è presente) non contiene nomi segreti", () => {
    const staticDir = join(ROOT, ".next", "static");
    if (!existsSync(staticDir)) return; // la build gira nella QA gate
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".js")) {
          const text = readFileSync(full, "utf8");
          for (const secret of ["NVIDIA_API_KEY", "RESEARCH_INTERNAL_AUTH_TOKEN"]) {
            if (text.includes(secret)) hits.push(`${full}: ${secret}`);
          }
        }
      }
    };
    walk(staticDir);
    expect(hits).toEqual([]);
  });
});

describe("validazione input robusta (fuzz leggero)", () => {
  const REQ = (body: string | Record<string, unknown>): Request =>
    new Request("http://localhost/api/research", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("JSON molto annidato con struttura non valida → 400 (mai 500/crash)", async () => {
    let deep: unknown = "fine";
    for (let i = 0; i < 200; i++) deep = { nested: deep };
    const response = await POST(
      REQ({ question: "Domanda di prova per profondità annidata?", options: { freshness: deep } }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("E_VALIDATION");
  });

  it("stringhe lunghe/controlli/HTML nella domanda non rompono la pipeline", async () => {
    // testo ostile: è SOLO un dato, mai un'istruzione — il wire la trasporta
    // come testo in un evento JSON e il report la contiene come domanda.
    const hostile = `<img src=x onerror="alert(1)"> ${"a".repeat(400)} \u0000 \u0001 \u007f`;
    const question = "Domanda ".repeat(20) + hostile;
    const response = await POST(REQ({ question }));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const events = parseLines(raw);
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]!.type).toBe("done");
    // il testo ostile arriva come campo di un evento JSON valido, non come riga a sé
    const hostileLine = raw.split("\n").find((l) => l.includes("alert(1)"));
    expect(hostileLine).toBeDefined();
    if (hostileLine !== undefined) {
      const parsed = parseEventLine(hostileLine);
      expect(parsed).not.toBeNull(); // JSON ben formato: nulla è stato "iniettato"
    }
  });

  it("question di 1000 caratteri accettata; 1001 → 400", async () => {
    const ok = await POST(REQ({ question: "a".repeat(1000) }));
    expect(ok.status).toBe(200);
    await ok.text();
    const ko = await POST(REQ({ question: "a".repeat(1001) }));
    expect(ko.status).toBe(400);
  });
});

describe("policy di default (rate limit e health)", () => {
  it("limiti rate di default come da policy (5/ora, 2 concorrenti)", () => {
    const limits = getLimits();
    expect(limits.rateLimitPerHourPerIp).toBe(5);
    expect(limits.rateLimitConcurrentPerIp).toBe(2);
  });
});
