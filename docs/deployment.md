# Deploy e diagnosi produzione

## Architettura attiva

`Browser → Vercel → Cloudflare Quick Tunnel → Caddy → SearXNG sul Raspberry Pi`

Il modello NVIDIA viene chiamato esclusivamente dalla Function Vercel. Il browser non riceve mai chiavi, token interni o URL della rete privata.

## Configurazione Vercel

Il progetto è distribuito con `vercel deploy --prod --yes`. Configurare solo nei secret settings di produzione:

- `NVIDIA_API_KEY`
- `NVIDIA_MODEL` (attualmente `meta/muse-glimmer-30b`)
- `SEARXNG_BASE_URL` (l'URL HTTPS del Quick Tunnel)
- `RESEARCH_INTERNAL_AUTH_TOKEN` (uguale al token Caddy sul Pi)

`NVIDIA_BASE_URL` può essere omesso: il default è `https://integrate.api.nvidia.com/v1`. Non aggiungere valori reali a `.env*`, commit, output di comandi o log.

## Verifica rapida

1. Aprire `/api/health`: deve rispondere 200 con `ok: true`.
2. Eseguire una domanda breve e concreta nella UI; devono apparire pianificazione, query, fonti e il report.
3. In Vercel Logs cercare `planning.completed`, `search.completed`, `research.finished`; i log non devono contenere segreti.
4. Sul Pi verificare Caddy, Docker/SearXNG e il processo `cloudflared` prima di modificare l'app.

## Diagnosi risultati vuoti

- SearXNG può restituire zero risultati per query troppo lunghe o molto specifiche. Il backend ritenta automaticamente con parole chiave compatte.
- Se SearXNG è irraggiungibile o vuoto, il backend prova gli endpoint HTML/Lite di DuckDuckGo.
- Se non arrivano comunque fonti, il report deve dichiarare il limite: non deve inventare una risposta o citazioni.

## Quick Tunnel

Il Quick Tunnel è adatto a sviluppo e uso personale: l'hostname `trycloudflare.com` cambia se il processo viene riavviato. Dopo un riavvio aggiornare `SEARXNG_BASE_URL` in Vercel e ridistribuire. Per un hostname stabile usare un tunnel nominato Cloudflare con dominio/account.

## Rollback

Dal progetto Vercel: selezionare l'ultima distribuzione verificata e promuoverla, oppure usare `vercel rollback`. Non modificare token o file sul Pi come misura di rollback applicativo.
