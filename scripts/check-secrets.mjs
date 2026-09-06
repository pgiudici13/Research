import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const suspicious = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bsk-(?!test(?:[-_]|\b)|example(?:[-_]|\b))[A-Za-z0-9_-]{16,}\b/,
  /\b(?:ghp|github_pat|glpat|xox[baprs])-?[A-Za-z0-9_-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
];

const findings = [];
for (const file of trackedFiles) {
  if (file === ".env.example" || file.startsWith("tests/")) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (suspicious.some((pattern) => pattern.test(line))) {
      findings.push(`${file}:${index + 1}`);
    }
    if (/^\s*(?:NVIDIA_API_KEY|.*TOKEN|.*SECRET|.*PASSWORD|.*PRIVATE_KEY)\s*=\s*[^#\s]/i.test(line)) {
      findings.push(`${file}:${index + 1} (sensitive assignment)`);
    }
  });
}

if (findings.length > 0) {
  console.error("[check:secrets] possibili segreti trovati:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`[check:secrets] ok — controllati ${trackedFiles.length} file tracciati.`);
