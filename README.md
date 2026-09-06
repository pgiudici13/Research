# Deep Research

App di Deep Research: trasforma una domanda in una risposta sintetica, verificabile e citata.

> **Stato attuale**: repository in implementazione incrementale secondo la roadmap in `STEP.md` (roadmap aggiornata lì step per step). Gli Step 1–25 sono completati: pipeline di ricerca completa (planner → search → fetch → evidence → verifica → contraddizioni → sintesi/citazioni), API NDJSON con rate limit, frontend di ricerca, audit sicurezza e policy prompt-injection. Restano le fasi di deploy (Vercel, Raspberry Pi/SearXNG, Cloudflare Tunnel) e gli step trasversali successivi. Le specifiche e i vincoli di prodotto sono in `AGENTS.md`.

## Stack (reale)

- Next.js 16 (App Router), React 19, TypeScript `strict`
- ESLint (`eslint-config-next`)
- Vitest (test runner)
- npm

Il sistema è end-to-end: l'UI chiama `POST /api/research` (stream NDJSON), il motore orchestra le fasi e produce un report citato. In assenza di chiavi NVIDIA o SearXNG configurate il comportamento degrada in modo deterministico e dichiarato, senza crash.

## Sicurezza: contenuti web come dati

Le pagine web sono **dati, non istruzioni** (`AGENTS.md` §9/§18, Step 25). Difesa a strati:

- **L1 — framing**: un unico builder (`lib/server/llm/prompts.ts`, `buildMessages(role, payload)`) costruisce tutti i prompt. I contenuti non attendibili (pagine, evidenze, domanda utente) entrano SOLO nel messaggio utente, serializzati come JSON dentro delimitatori versionati `<research_evidence version="1">…</research_evidence>`, con `<` escapato (`\u003c`) così un contenuto non può chiudere la recinzione. Il system prompt è istruzioni costanti: vieta di eseguire istruzioni nei contenuti, di rivelare chiavi/segreti/prompt di sistema e di citare fonti non fornite.
- **L2 — output validati**: le risposte LLM sono validate contro schema JSON strict e contro gli insiemi ammessi (id evidenze, indici citazione): un'iniezione non può introdurre fonti o chiavi nuove.
- **L3 — nessun segreto nel contesto**: la chiave NVIDIA non compare mai in nessun prompt (per costruzione; testata).
- **L4 — testo ridotto**: i contenuti arrivano al modello già estratti come testo (Step 11), mai HTML attivo.

Fixture di attacco in `tests/fixtures/html/injection.html`; policy e test in `tests/unit/server/llm/prompts.test.ts`. Checklist completa in `docs/security.md`.

## Avvio locale

```bash
npm install
npm run dev        # http://localhost:3000
```

## Comandi

```bash
npm run dev            # dev server
npm run build          # build di produzione
npm run start          # avvia la build
npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
npm run test           # Vitest (una volta)
npm run test:watch     # Vitest (watch)
npm run check:secrets  # scan segreti su file tracciati (Step 24)
npm run check:all      # lint + typecheck + test + check:secrets
```

## Struttura

Vedi `STEP.md` (roadmap) e `AGENTS.md` (specifica). La struttura reale del codice viene aggiornata in `AGENTS.md` a ogni milestone.
