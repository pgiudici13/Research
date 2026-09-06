# Deep Research

App di Deep Research: trasforma una domanda in una risposta sintetica, verificabile e citata.

> **Stato attuale**: repository in fase iniziale. È in esecuzione la roadmap in `STEP.md`; le specifiche e i vincoli di prodotto sono in `AGENTS.md`. Al momento esiste solo lo scaffold (Step 1): Next.js App Router + TypeScript strict, nessuna funzionalità di ricerca ancora implementata.

## Stack (reale)

- Next.js 16 (App Router), React 19, TypeScript `strict`
- ESLint (`eslint-config-next`)
- Vitest (test runner)
- npm

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
