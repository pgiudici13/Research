# Verifica — SearXNG locale + Caddy auth (eseguita su hardware reale)

Data esecuzione: **2026-09-06** su `p-pi` (Raspberry Pi 3 Model B Plus Rev 1.3,
Debian 13 trixie, kernel 6.18.34+rpt-rpi-v8, 1 GB RAM).

## 1. Memory controller cgroup attivo

```bash
cat /sys/fs/cgroup/cgroup.controllers
```

**Atteso**: deve contenere `memory`.
**Risultato**: `cpuset cpu io memory pids` ✅ (dopo il fix del DTB, vedi
`pi/README.md` — il flag `cgroup_disable=memory` era cotto nei bootargs del
DTB, non solo in `cmdline.txt`).

## 2. SearXNG in ascolto solo su loopback

```bash
ss -tlnp | grep 8893
docker ps --format '{{.Names}} {{.Status}} {{.Ports}}'
```

**Atteso**: bind `127.0.0.1:8893`; stato `Up (healthy)`.
**Risultato**: ✅ `127.0.0.1:8893->8080/tcp`, `Up (healthy)`.
Health check diretto: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8893/healthz` → **200** ✅

## 3. Limite di memoria applicato

```bash
docker inspect --format 'MemLimit={{.HostConfig.Memory}} OOMKilled={{.State.OOMKilled}}' searxng
docker stats --no-stream
```

**Atteso**: `MemLimit=536870912` (512 MB), nessun OOM.
**Risultato**: ✅ `MemLimit=536870912 OOMKilled=false`; RSS ~163 MB sotto carico
di 2 query concorrenti; host con ~460 MB disponibili su 905 MB totali.

## 4. Caddy: solo loopback, 401 senza token, JSON con token

```bash
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8080/search?q=test&format=json"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer sbagliato" "http://127.0.0.1:8080/search?q=test&format=json"
curl -s -H "Authorization: Bearer <token-reale>" "http://127.0.0.1:8080/search?q=deep+research&format=json"
```

**Atteso**: `401` / `401` / `200` con body JSON (`{"query": ..., "results": [...]}`).
**Risultato**: ✅ `401`, `401`, `200` + JSON valido (motore attivo, risultati reali).

## 5. Stabilità sotto carico (2 query concorrenti)

```bash
(curl ... 'q=raspberry+pi' & curl ... 'q=debian+13' & wait)
free -m
```

**Risultato**: ✅ entrambe `200`; `free`: 442 MB usati / ~462 MB disponibili;
load medio 1.4 momentaneo, rientrato. Nessun restart (`RestartCount=0`).

## 6. Verifica remota (dopo Cloudflare Tunnel) — DA ESEGUIRE

Richiede il login Cloudflare e la route DNS (Step 31). Da un host esterno:

```bash
# senza token → atteso 401
curl -s -o /dev/null -w '%{http_code}\n' "https://<CLOUDFLARE_TUNNEL_HOSTNAME>/search?q=test&format=json"
# con token → atteso 200 + JSON
curl -s -H "Authorization: Bearer <token>" "https://<CLOUDFLARE_TUNNEL_HOSTNAME>/search?q=deep+research&format=json"
# il Pi non deve rispondere su altre porte dall'esterno (scan esterno opzionale)
```

**Stato**: in attesa della configurazione tunnel (passo interattivo utente).
