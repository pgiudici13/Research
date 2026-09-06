# Performance: budget, conteggi e linee guida (Step 27)

Il sistema evita richieste inutili per costruzione e lo verifica con test
**deterministici sui conteggi** (`tests/integration/performance.test.ts`), mai
misurando secondi. I limiti sono la tabella C.2 in `lib/config/limits.ts`.

## Numeri attesi per una ricerca tipica (default di ambiente)

| Metrica | Limite / atteso | Dove è imposto/verificato |
|---|---|---|
| Query per ricerca | ≤ `RESEARCH_MAX_QUERIES` (default 20; tipico 3–6) | `RunBudget.consumeQuery`; planner fallback/LLM |
| Concorrenza search | 2 query in parallelo | `searchConcurrency` |
| Fonti analizzate | ≤ `RESEARCH_MAX_SOURCES` (default 8; opzione utente clampata) | `RunBudget.remainingSources` + `consumeSource` |
| Fetch per round | ≤ `min(fonti rimanenti, 6)` | `maxFetchPerRound` |
| Fetch totali in un run senza falliti | = fonti analizzate ≤ `maxSources` | test: `fetchAttempts == sourcesAnalyzed` |
| Fetch per canonicalUrl | 1 (mai duplicati, anche tra round) | cache `RunBudget.attemptedUrls` |
| Concorrenza fetch | 4 in parallelo | `fetchConcurrency` |
| LLM call | seriali; 1 sintesi a run; tetto `depth*2+2` (default 6) | `consumeLlm`/`maxLlmCallsFor`; 0 senza evidenze |
| Retry LLM/search/fetch | 1+2 / 1+2 / 1+1 tentativi | `llmMaxAttempts`, `searchMaxAttempts`, `fetchMaxAttempts` |
| Body pagina | ≤ `RESEARCH_MAX_FETCH_BYTES` (default 300 000 byte) | fetcher; oltre → tronca/`too-large` |
| Testo pagina → LLM | ≤ 60 000 caratteri (`pageTextMaxChars`), HTML ridotto a testo | `research/extract` |
| Passaggio evidenza | ≤ 1 200 caratteri | `passageMaxChars` |
| Evidenze per pagina / totali | 8 / 40 | `maxEvidencesPerPage`, `maxEvidencesTotal` |
| Durata ricerca | `RESEARCH_TIMEOUT_MS` (default 50 s) con margine 2 s | `RunBudget.canContinue`; stop pulito |

Ordine che evita lavoro inutile: **ranking prima del fetch** (si scaricano solo i
top-N), **dedup URL sul canonical** prima del ranking, **cache per-run** degli
URL tentati, LLM **serial** e chiamato solo dove serve (una sintesi; zero se non
ci sono evidenze). Niente ottimizzazioni speculative: le soglie sopra sono già
implementate e misurate dai test; una nuova ottimizzazione va introdotta solo
con una misura che dimostri il problema.

## Vercel

- Le route dichiarano `maxDuration` coerente con `RESEARCH_TIMEOUT_MS` più
  margine; memoria e streaming NDJSON con flush regolare per UX (nessuna attesa
  attiva: il fetch è guidato da AbortController e timeout per singola chiamata).
- Rate limit in-memory per funzione (`lib/server/rate-limit.ts`, 5/ora, 2
  concorrenti per IP): i limiti noti di Vercel vanno verificati al deploy
  (Step 32) — per più istanze serve uno store condiviso.
- Budget e conteggi (query/fetch/LLM/byte) sono già i massimi per funzione: una
  ricerca tipica usa 3–6 query, ≤ 8 fetch, 1 chiamata LLM di sintesi.

## Raspberry Pi (linee guida da applicare allo Step 30)

Il Pi 3B (1 GB RAM) esegue **solo SearXNG**:

- engine essenziali (pochi, non tutti), `limiter` attivo, `cache` con TTL,
  timeout server brevi, **1 worker**; niente scraping parallelo incontrollato.
- Il Pi **non fa fetch né LLM**: spostare il fetch sul Pi degraderebbe sia la
  latenza (Vercel→Pi→siti invece di Vercel→siti) sia la concorrenza del Pi
  (il meta-search già satura 1 GB RAM). Il backend Vercel deve trattare il
  tunnel/Pi come un servizio remoto: timeout, 502/503, retry limitati
  (`searchMaxAttempts`) e fallback `searchUnavailable` (matrice Step 26).

## Verifica

```bash
npx vitest run tests/integration/performance.test.ts
```

I test asseriscono: nessun fetch oltre `maxSources`; stesso URL da più
query/round → una sola fetch; nessuna sintesi/LLM senza evidenze; una sola
sintesi in una ricerca tipica; `BudgetUsage` coerente con i conteggi osservati.
