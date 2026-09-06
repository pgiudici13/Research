# Sicurezza — checklist di audit (Step 24)

Verifica sistematica dei vincoli di `AGENTS.md` §9 e §18 sullo stato reale del
repository. Ogni voce elenca l'artefatto che la dimostra e il suo esito alla
data dell'ultimo deploy. Le verifiche di infrastruttura riportano lo stato
operativo osservato e non includono mai token, hostname temporanei o segreti.

| Voce (§9/§18) | Verifica nel repository | Esito |
| --- | --- | --- |
| Nessuna credenziale reale in codice, commit, log o prompt | `npm run check:secrets` (scanner su file tracciati: pattern di chiavi, assegnazioni sensibili, `.env` committati, password note, placeholder non vuoti in `.env.example`); test di redazione del logger | ✅ verde |
| Password `1234` (compromessa) mai usata | lo scanner segnala qualunque `password…=1234` nei sorgenti | ✅ nessun match |
| NVIDIA API / SearXNG server-side only | `tests/integration/security.test.ts`: nessun file client (`app`/`components`/`hooks`) importa `lib/server`/`lib/config/env`/logger/motore; nomi segreti solo nei file consentiti; assenza nei bundle `.next/static` | ✅ verde |
| La chiave non è mai nel contesto del modello | nessun prompt costruisce messaggi con la chiave; `lib/server/llm/*` legge solo da env server-side | ✅ |
| Autenticazione traffico Vercel→Pi (HTTPS + token) | Caddy richiede il Bearer `RESEARCH_INTERNAL_AUTH_TOKEN`; token configurato come secret sia sul Pi sia in Vercel | ✅ verificato |
| Pi mai esposto direttamente su Internet | Caddy e SearXNG ascoltano solo su loopback; cloudflared crea una connessione outbound HTTPS | ✅ verificato |
| Difesa SSRF | `lib/http/ssrf.ts` (IP/hostname privati, lookup DNS, allowlist) + redirect ri-validati nel fetcher; test `tests/unit/http/` | ✅ verde |
| Sanitizzazione HTML/UI, mai HTML sorgente renderizzato | componenti solo-testo (Step 23), nessun `dangerouslySetInnerHTML`; regressione payload ostile `<img onerror>`/`<script>` in `tests/integration/security-render.test.tsx` | ✅ verde |
| Limiti su input, prompt, query, fonti, dimensione, concorrenza, durata | `lib/config/limits.ts` + clamp; validazione `ResearchRequest`; body ≤ 16 KB; fuzz leggero in `security.test.ts` | ✅ verde |
| Prompt injection: pagine web = dati non istruzioni | delimitatori + framing in `lib/server/llm/prompts.ts` e test dedicati | ✅ Step 25 |
| Redazione segreti e dati personali dai log | `lib/logger.ts` con redazione automatica; test dedicati | ✅ verde |
| Rate limiting di default | `lib/server/rate-limit.ts` (5/ora, 2 concorrenti per IP, in-memory per funzione Vercel); test unit + API | ✅ verde |
| Errori client senza stack trace/prompt/segreti | catalogo `lib/errors.ts` + `ApiErrorBody`; test API | ✅ verde |
| Nessun endpoint che inoltri URL/prompt arbitrari | unico `POST /api/research` con schema rigido; gli URL di fetch nascono solo da SearXNG/evidenze | ✅ |

## Comandi di verifica

```bash
npm run check:secrets    # scan segreti su file tracciati (exit non-zero su match)
npm run test             # include security.test.ts e security-render.test.tsx
npm run build            # la build .next/static viene ispezionata dal test bundle
```

## Policy per le fixture di test

Le fixture che contengono stringhe simili a chiavi usano valori palesemente
finti (`sk-TEST-…`) e, dove serve, il marcatore di riga `// check-secrets:ignore`
(policy documentata in `scripts/check-secrets.mjs`). Non aggiungere mai un
valore reale-like senza marcatore: `check:secrets` fallirebbe.
