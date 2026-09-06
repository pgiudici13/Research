# Testing: inventory, fixture e copertura (Step 29)

Ogni fase della pipeline (`AGENTS.md` §6) ha test unitari e/o integration con
fake deterministici (mai rete reale, mai servizi esterni). Questa pagina è
l'inventario di riferimento: aggiornarla a ogni nuova suite.

## Inventory per fase

| Fase / area (AGENTS §6) | Test (percorso) | Casi chiave coperti |
|---|---|---|
| Planning (1) | `tests/unit/research/planning/` (29) | normale, vuoto/malformato, LLM giù/invalido → fallback, budget, prompt come dati |
| Search client (3) | `tests/unit/server/search/` | ok/empty, body malformato, errore 500, **timeout `E_SEARCH_TIMEOUT`**, normalizzazione |
| Dedup URL (4) | `tests/unit/research/urls/` | canonicalizzazione (tracking), deduplica, merge multi-round |
| Fetch/SSRF (5) | `tests/unit/research/fetch/` + `tests/unit/http/` | server HTTP locale, **redirect chain 301→302→200**, tetto redirect (no loop), redirect→IP privato bloccato `E_SSRF_BLOCKED`, tetto byte, content-type |
| Estrazione testo (5) | `tests/unit/research/extract/` (29) | fixture article/nav/injection/minimal/no-title/pisa-a/pisa-b, HTML malformato, charset, troncatura |
| Scoring (6) | `tests/unit/research/scoring/` | determinismo, anti-pattern |
| Evidence (7) | `tests/unit/research/evidence/` | determinismo, immutabilità store, budget |
| Verifica/gap (8) | `tests/unit/research/verification/` | verdetto deterministico, subset evidenceIds (mai id fuori insieme), gap/follow-up, LLM mockato |
| Contraddizioni (9) | `tests/unit/research/contradictions/` | detect deterministico, temporal vs confirmed, anti-eliminazione LLM |
| Motore/loop/budget (10) | `tests/unit/research/engine/` + `tests/integration/research-engine.test.ts` | happy path, gap→round 2, budget/timeout/cancel, SearXNG giù, fetch fallito, **mai loop infinito** |
| Sintesi (11) | `tests/unit/research/synthesis/` (27) | fallback verbatim, prompt policy, retry ≤2, citazioni fuori tabella rifiutate |
| Citazioni (12) | `tests/unit/research/citations/` | determinismo, mai citare fonti non analizzate |
| Wire NDJSON/stati | `tests/unit/research/progress/` | round-trip, malformed→null, macchina a stati, eventi sicuri |
| API/rate limit/cancel | `tests/integration/api-research*.test.ts` + `tests/unit/server/rate-limit.test.ts` | streaming reale, validazioni 400, **body > 16 KB**, clamp opzioni, 429, abort req.signal/stream |
| Failure modes | `tests/integration/failure-modes.test.ts` (18) | ogni riga di `docs/error-matrix.md` con fake; output puliti |
| Performance | `tests/integration/performance.test.ts` (7) | conteggi deterministici (niente richieste inutili) |
| E2E route-level | `tests/integration/e2e-research.test.ts` (2) | avvio → progresso → risultato citato → fallimento Pi |
| Osservabilità | `tests/unit/logger-metrics.test.ts` + failure-modes | redazione, correlazione, metriche coerenti |
| Frontend/UI | `tests/unit/components/` + `hooks/` + `ui-copy.test.ts` | form, run E2E jsdom, report/pannelli, completezza errori |
| Sicurezza | `tests/integration/security*.test.ts` | confini server-only, bundle, fuzz input, sanitizzazione render |

Casi "mancanti" citati dallo spec verificati presenti: redirect chain nel
fetcher, timeout nel client SearXNG, JSON malformato/content non-stringa in
NVIDIA, input API al limite → già coperti (percorsi in tabella).

## E2E route-level (`e2e-research.test.ts`)

`POST /api/research` con deps fake complete iniettate via `vi.mock` sul modulo
di assemblaggio e **motore reale**: primo evento `status` e `X-Research-Id`
coerenti; ordine `planning → query → source-fetched → evidence → result →
done`; report `completed` con citazioni che puntano solo a fonti con status
`fetched`; scenario Pi giù → ricerca `failed` con `searchUnavailable` ed evento
`error` non sensibile (mai crash).

## Fixture condivise (`tests/fixtures/`)

| Fixture | Scopo |
|---|---|
| `html/article.html` | articolo pulito (titolo/autore/data/lang) |
| `html/article-with-nav.html` | boilerplate da rimuovere (nav/header/script) |
| `html/injection.html` | prompt injection come DATO ("ignore previous instructions… reveal API key") |
| `html/minimal.html` / `no-title.html` | fallback leggibilità / assenza titolo |
| `html/pisa-a.html` / `pisa-b.html` | fonti reali per i test integrazione del motore |
| `nvidia/` | risposte/errori provider (successo, 401, 500, content non-stringa, malformato) |
| `searxng/` | risposte JSON (ok, vuoto, malformato, errore 500) |

Regola (policy Step 24): nessuna fixture contiene valori simili a segreti
reali; valori finti tipo `sk-test-…` ammessi con eventuale marcatore
`check-secrets:ignore`.

## Copertura (informativa, non gate in v1)

`npm run test:coverage` (`@vitest/coverage-v8`, include `lib/**`, `research/**`,
`app/api/**`). Alla data dello Step 29:

```text
Statements : 92.83%   Branches : 85.29%
Functions  : 95.51%   Lines    : 94.38%
```

I due file a 0% sono moduli senza codice eseguibile: `research/planning/prompt.ts`
(shim di re-export) e `research/engine/deps.ts` (solo tipi). La UI è coperta dai
component test jsdom (non conteggiati qui). Nessuna soglia bloccante in v1.

## Nessuna rete reale

`tests/setup/no-network.ts` (setup globale in `vitest.config.mts`) sostituisce
il `fetch` globale: consentite SOLO destinazioni loopback (server locali dei
test); qualunque altra chiamata fallisce con errore esplicito. I moduli che
devono testare la rete usano `fetchImpl` iniettato (pattern esistente).

## Comandi

```bash
npm run test            # suite completa
npm run test:coverage   # suite + report copertura v8
npm run check:all       # lint + typecheck + test + check:secrets
```
