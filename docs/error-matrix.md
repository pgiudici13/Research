# Matrice degli errori e comportamento degradato (Step 26)

Tabella di riferimento unica per i fallimenti della pipeline (`AGENTS.md` §12,
codici tassonomia C.4 in `lib/errors.ts`). Per ogni caso: comportamento atteso,
classe (recuperabile / parziale / terminale) e dove è verificato.

Classi:
- **Recuperabile** — retry controllato o fallback di fase; mai crash.
- **Parziale** — ricerca continua e produce un risultato con avvisi espliciti
  (`limitations` + note).
- **Terminale** — la ricerca si ferma in modo esplicito e comprensibile.

| Caso | Classe | Comportamento | Dove verificato |
|---|---|---|---|
| NVIDIA non configurata | Parziale | planner/verifica/sintesi → fallback deterministico; report marcato `limitations.llmUnavailable` + nota | `failure-modes.test.ts` (LLM non configurato); unit Step 7/13/15/18 |
| NVIDIA timeout/5xx | Recuperabile | retry (2), poi fallback di fase; mai crash | unit retry Step 7; `failure-modes.test.ts` (sintesi fallback con `E_LLM_TIMEOUT`) |
| Risposta LLM JSON invalida | Recuperabile | retry con correzione (≤2 chiamate), poi fallback deterministico | unit Step 13/18; `failure-modes.test.ts` (`E_LLM_INVALID_RESPONSE`) |
| SearXNG non raggiungibile (tunnel/Pi giù) | Terminale/Parziale | query falliscono ma si continua; se nessuna fonte → report `failed` con `searchUnavailable` e spiegazione; altrimenti note + risultato | `failure-modes.test.ts`; Step 8/17/21 |
| SearXNG timeout | Recuperabile | retry (2) poi errore della singola query (`E_SEARCH_TIMEOUT`) | unit retry Step 8; `failure-modes.test.ts` |
| Ricerca vuota | Terminale | gap `no-evidence`, follow-up o stop onesto: `failed`/`partial` con `missingSources`, zero citazioni | `failure-modes.test.ts`; Step 15/17 |
| Pagina 404/irraggiungibile | Recuperabile | `SourceRecord failed` con codice `E_FETCH_FAILED`, `fetchFailed` contato, si continua | `failure-modes.test.ts`; Step 10/17 |
| Pagina vuota/illeggibile | Recuperabile | `SourceRecord` con status `unsupported`/`empty`, si continua | `failure-modes.test.ts`; Step 10/11/17 |
| Troppi byte | Recuperabile | tronca se HTML (`truncated`); altrimenti `E_FETCH_TOO_LARGE` e salta | unit Step 10; `failure-modes.test.ts` |
| Contenuto non supportato | Recuperabile | `E_FETCH_UNSUPPORTED`, fonte marcata, si continua | unit Step 10; `failure-modes.test.ts` |
| Conflitti tra fonti | Parziale | conservati nel report (entrambe le posizioni), mai risolti | `failure-modes.test.ts`; Step 16/23 |
| Timeout globale ricerca | Terminale | stop pulito → `partial` con `timeBudgetExceeded` (mai crash) | `failure-modes.test.ts`; Step 17 |
| Utente annulla | Terminale | abort → `cancelled` (stato + evento done coerenti) | `failure-modes.test.ts`; Step 17/21/22 |
| Rate limit | Terminale (HTTP) | 429 con `E_RATE_LIMIT` e Retry-After; nessuna esecuzione | `failure-modes.test.ts` (API); Step 21/24 |
| Input non valido | Terminale (HTTP) | 400 `E_VALIDATION` prima dello stream | `failure-modes.test.ts` (API); Step 21/24 |
| Errore imprevisto | Terminale | `toErrorInfo` → `E_INTERNAL`, messaggio di catalogo; mai stack trace/segreti in eventi, log o risposte | `failure-modes.test.ts`; Step 5/21 |

## Contratti di sicurezza (verificati in ogni scenario)

- Nessun output (evento NDJSON, errore HTTP, log) contiene stack trace, messaggi
  grezzi fuori catalogo o segreti: helper di test `expectOutputClean`.
- I flag di `limitations` sono coerenti con lo stato finale
  (`failed`/`partial`/`completed`/`cancelled`).
- Testi utente: ogni codice C.4 ha una voce in `ERROR_COPY` (`lib/ui-copy.ts`),
  verificato dal test di completezza in `tests/unit/ui-copy.test.ts`.

## Come leggere un report degradato

1. Guarda `status`: `partial` = risultato con limiti; `failed` = nessun
   risultato utilizzabile (mai un crash).
2. Guarda `limitations`: `llmUnavailable`, `searchUnavailable`,
   `missingSources`, `budgetExceeded`, `timeBudgetExceeded`, `notes`.
3. I dettagli delle fonti fallite hanno `failure.code` stabile (es.
   `E_FETCH_TOO_LARGE`) — mai stack trace.
