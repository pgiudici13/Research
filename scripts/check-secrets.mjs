// check:secrets — scanner attivo dei segreti sul repository (Step 24).
// - analizza SOLO i file tracciati da git (rispetta .gitignore);
// - pattern di chiavi reali, assegnazioni sensibili, `.env` committati,
//   placeholder non vuoti in `.env.example`, password note;
// - le fixture di test con stringhe simili a chiavi usano valori palesemente
//   finti (`sk-TEST-…`) e possono essere ignorate riga per riga con il
//   marcatore `check-secrets:ignore`;
// - exit code non-zero su qualunque match, output con `percorso:riga`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Marcatore per ignorare esplicitamente una riga (policy documentata). */
const IGNORE_MARKER = "check-secrets:ignore";

const suspicious = [
  // Chiavi private
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  // Chiavi API OpenAI/NVIDIA-like (esclude i valori finti sk-TEST-/sk-example-)
  /\bsk-(?!test(?:[-_]|\b)|example(?:[-_]|\b)|mock(?:[-_]|\b))[A-Za-z0-9_-]{16,}\b/,
  // Token GitHub/GitLab/Slack/Stripe/ecc.
  /\b(?:ghp|gho|github_pat|glpat|xox[baprs]|sk_live_|pk_live_|AIza)[A-Za-z0-9_-]{16,}\b/i,
  // AWS access key
  /\bAKIA[0-9A-Z]{16}\b/,
];

/** Assegnazione sensibile con valore non vuoto (nome chiave/token/secret…). */
const sensitiveAssignment =
  /^\s*(?:export\s+)?(?:NVIDIA_API_KEY|RESEARCH_INTERNAL_AUTH_TOKEN|.*TOKEN|.*SECRET|.*PASSWORD|.*PRIVATE_KEY|.*API_KEY)\s*=\s*(?![#\s"'`]|$).+/i;

const findings = [];

/** Aggiunge un finding se la riga non è marcata come ignorata. */
function report(file, lineNumber, line, reason) {
  if (line.includes(IGNORE_MARKER)) return;
  findings.push(`${file}:${lineNumber} (${reason})`);
}

/** Verifica che .env.example contenga SOLO placeholder vuoti. */
function checkEnvExample() {
  const path = ".env.example";
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    findings.push(`${path}:1 (file assente)`);
    return;
  }
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const eq = line.indexOf("=");
    if (eq === -1) {
      report(path, index + 1, line, "riga senza = in .env.example");
      return;
    }
    const value = line.slice(eq + 1).trim();
    if (value !== "" && !value.startsWith("#")) {
      report(path, index + 1, line, "placeholder con valore non vuoto");
    }
  });
}

/** Cerca file .env (o varianti) tracciati nel repository.
 * Eccezione: `.env.example` è il riferimento placeholder documentato e viene
 * gestito da `checkEnvExample` (deve contenere SOLO `KEY=` vuoti). */
function findTrackedEnvFiles(files) {
  for (const file of files) {
    if (file === ".env.example") continue;
    if (/(^|\/)(\.env|\.env\.[a-zA-Z0-9_-]+|\.env\.local)$/.test(file)) {
      findings.push(`${file}:1 (.env tracciato)`);
    }
  }
}

const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

findTrackedEnvFiles(trackedFiles);
checkEnvExample();

for (const file of trackedFiles) {
  // .env.example gestito sopra; lo script stesso non deve auto-segnalarsi
  // (le righe con "NVIDIA_API_KEY" qui sono il pattern, non un valore).
  if (file === ".env.example" || file === "scripts/check-secrets.mjs") continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const reasonSuspicious = suspicious.find((pattern) => pattern.test(line));
    if (reasonSuspicious !== undefined) {
      report(file, index + 1, line, "pattern di chiave/secret");
      return;
    }
    if (sensitiveAssignment.test(line)) {
      report(file, index + 1, line, "assegnazione sensibile con valore");
      return;
    }
    if (/(password|passwd|pwd)\s*[:=]\s*["']?1234\b/i.test(line)) {
      report(file, index + 1, line, "password nota e debole (1234)");
    }
  });
}

if (findings.length > 0) {
  console.error("[check:secrets] possibili segreti trovati:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(
  `[check:secrets] ok — controllati ${trackedFiles.length} file tracciati, nessun segreto trovato.`,
);
