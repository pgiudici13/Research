# Deep Research

App di Deep Research: trasforma una domanda in una risposta sintetica, verificabile e citata.

> **Stato attuale**: repository in implementazione incrementale. Gli Step 1–14 della roadmap in `STEP.md` sono completati; le API, il motore completo, la sintesi/citazioni, la UI di ricerca e i deploy Pi/Vercel restano da implementare. Le specifiche e i vincoli di prodotto sono in `AGENTS.md`.

## Stack (reale)

- Next.js 16 (App Router), React 19, TypeScript `strict`
- ESLint (`eslint-config-next`)
- Vitest (test runner)
- npm

Sono già presenti i moduli server-side per NVIDIA e SearXNG, la protezione SSRF, il fetch/extract delle pagine, la deduplicazione URL, il ranking, il planner con fallback deterministico e il modello di evidenze. Non sono ancora collegati a un endpoint API o a un flusso UI completo.

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
npm run check:secrets  # scan segreti (placeholder fino allo Step 24)
npm run check:all      # lint + typecheck + test + check:secrets
```

## Struttura

Vedi `STEP.md` (roadmap) e `AGENTS.md` (specifica). La struttura reale del codice viene aggiornata in `AGENTS.md` a ogni milestone.
