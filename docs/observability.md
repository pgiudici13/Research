# Osservabilità (Step 28)

Log JSON strutturati su stdout (una riga per record) + metriche per-run
`ResearchMetrics` (`lib/metrics.ts`) loggate a fine ricerca. Nessun segreto,
nessun prompt/contenuto integrale: policy di redazione centrale in
`lib/logger.ts` (Step 5), rafforzata e testata qui.

## Correlazione

Il motore usa un logger child con base-context `{ researchId, clientRequestId }`
per ogni ricerca, quindi **ogni** riga del run è correlabile. L'API genera
`requestId` (header `x-client-request-id` o auto) e lo passa come
`clientRequestId` a `runResearch`; il motore genera/eredita `researchId`
(header `X-Research-Id` e campo di ogni evento NDJSON).

Per diagnosticare una ricerca:

```bash
grep '"researchId":"res-…"' deploy-log.txt
```

## Righe log attese

```json
{"ts":"…","level":"info","scope":"engine","event":"research.started","researchId":"res-…","clientRequestId":"req-…","budget":{"maxQueries":20,"maxSources":8,"maxDepth":2,"timeoutMs":50000}}

{"ts":"…","level":"info","scope":"engine","event":"phase.ended","researchId":"res-…","phase":"searching","durationMs":120,"counts":{"queries":4,"sourcesAnalyzed":0}}

{"ts":"…","level":"warn","scope":"api","event":"search.unconfigured","researchId":"res-…","clientRequestId":"req-…","query":"anno fondata università pisa"}

{"ts":"…","level":"info","scope":"engine","event":"research.finished","researchId":"res-…","clientRequestId":"req-…","status":"failed","metrics":{"rounds":1,"queries":4,"resultsFound":0,"sourcesConsulted":0,"sourcesFetched":0,"sourcesFailed":0,"evidences":0,"conflicts":0,"llmCalls":0,"llmFailures":1,"searchErrors":4,"fetchErrors":0,"bytesFetched":0,"planFallback":true,"phases":{"planning":0,"searching":0,"verifying":0}},"durationMs":0,"rounds":1,"stoppedReason":"search-down","evidenceDropped":0}
```

Eventi del motore: `research.started` (id, budget), `phase.ended` (fase,
`durationMs`, conteggi del momento), `research.finished` (stato, durata,
`stoppedReason`, metriche complete), `engine.plan_failed`/
`engine.synthesis_failed` (solo `errorCode` normalizzato). Gli errori loggati
hanno sempre `code`/`phase`/`retryable` da `toErrorInfo` — mai messaggi grezzi
fuori catalogo né `String(err)`.

## Metriche per-run

`ResearchMetrics` (tutte NON sensibili): `rounds`, `queries`, `resultsFound`,
`sourcesConsulted`, `sourcesFetched`, `sourcesFailed`, `evidences`,
`conflicts`, `llmCalls`, `llmFailures`, `searchErrors`, `fetchErrors`,
`bytesFetched`, `planFallback`, `phases` (durate ms per fase). Sono coerenti con
`report.budgetUsed` (verificato dai test di `failure-modes.test.ts` e usate per
il debug di timeout, Pi giù e budget mal impostati). Il report al client
continua a esporre solo `BudgetUsage` — le metriche restano nei log.

## Cosa NON si logga mai

- prompt completi o parziali, contenuti di pagina integrali, passaggi di
  evidenza (nel wire gli eventi espongono solo `passagePreview` ≤ 200 char);
- la domanda dell'utente (necessaria al debug solo a livello `debug` e solo se
  un futuro step la aggiunge esplicitamente);
- chiavi/token (`NVIDIA_API_KEY`, token tunnel), header `authorization`,
  password, dati personali: redatti da `lib/logger.ts` per chiave
  case-insensitive (`key|token|secret|password|authorization|cookie|credential`),
  per valore tipo credenziale (`sk-…`, `xoxb-…`, `ghp_…`, `AKIA…`, chiavi
  private) e per oggetti `Headers`/`Request`/`Response`.

## Verifica

```bash
npx vitest run tests/unit/logger-metrics.test.ts   # redazione su payload complessi + correlazione child
npx vitest run tests/integration/failure-modes.test.ts  # started/phase.ended/finished + metriche coerenti
```
