# Deep Research

Applicazione web per ricerche guidate, con pianificazione LLM, raccolta di fonti, estrazione di evidenze, verifica e citazioni. La UI riceve aggiornamenti live via NDJSON.

## Stato operativo

L'app è distribuita su [Vercel](https://deep-research-pearl.vercel.app/). Il backend chiama SearXNG sul Raspberry Pi attraverso un Cloudflare Quick Tunnel HTTPS autenticato da Caddy; NVIDIA viene usato solo dal server per planning e sintesi.

Il Raspberry Pi è stato verificato: Caddy e SearXNG sono attivi e SearXNG restituisce risultati per query generiche. Le query troppo specifiche vengono ritentate con parole chiave compatte; se SearXNG è indisponibile o vuoto, il backend prova DuckDuckGo. Risultati e disponibilità dei motori esterni possono comunque variare.

## Stack (reale)

- Next.js 16 (App Router), React 19, TypeScript `strict`
- ESLint (`eslint-config-next`)
- Vitest (test runner)
- npm

Il sistema è end-to-end: l'UI chiama `POST /api/research` (stream NDJSON), il motore orchestra le fasi e produce un report citato. In assenza di NVIDIA o di una ricerca disponibile il comportamento degrada in modo esplicito, senza esporre segreti né inventare citazioni.

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

Copiando `.env.example` in un file locale non tracciato, configura i valori necessari. Non usare mai chiavi reali nel repository.

```text
NVIDIA_API_KEY=
NVIDIA_MODEL=meta/muse-glimmer-30b
SEARXNG_BASE_URL=
RESEARCH_INTERNAL_AUTH_TOKEN=
```

## Produzione

Le variabili sono configurate esclusivamente nei secret settings di Vercel. Quelle richieste sono `NVIDIA_API_KEY`, `NVIDIA_MODEL`, `SEARXNG_BASE_URL` e `RESEARCH_INTERNAL_AUTH_TOKEN`; `NVIDIA_BASE_URL` usa di default l'endpoint NVIDIA Integrate. La checklist di deploy e diagnosi è in [docs/deployment.md](docs/deployment.md); il setup del Pi è in [pi/README.md](pi/README.md).

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
