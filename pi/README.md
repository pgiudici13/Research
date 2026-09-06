# Raspberry Pi — SearXNG + Caddy + Cloudflare Tunnel

Deployment documentato per il Pi 3B (`p-pi`) che ospita SearXNG e il
collegamento verso il backend Vercel. **Nessun segreto in questo repository**:
tutti i valori reali vivono solo sul Pi (file con permessi `600`).

## Architettura

```text
Vercel (backend Deep Research)
   │  HTTPS + Authorization: Bearer <RESEARCH_INTERNAL_AUTH_TOKEN>
   ▼
Cloudflare Tunnel (cloudflared sul Pi, connessione outbound)
   ▼
127.0.0.1:8080  Caddy (controllo token, solo loopback)
   ▼
127.0.0.1:8893  SearXNG (container Docker, solo loopback)
```

- Il Pi non apre **nessuna porta inbound**: il tunnel è una connessione
  outbound verso la rete Cloudflare.
- Caddy è l'unico punto di ingresso locale e richiede l'header
  `Authorization: Bearer <token>` identico a `RESEARCH_INTERNAL_AUTH_TOKEN`
  configurato su Vercel.
- SSH resta confinato alla LAN (nessun forwarding pubblico dall'app).

## Stato reale (eseguito il 2026-09-06 su hardware)

- Sistema: Debian 13 (trixie), kernel `6.18.34+rpt-rpi-v8`,
  **Raspberry Pi 3 Model B Plus Rev 1.3** (aarch64, 1 GB RAM).
- Installati: `docker.io` 26.1.5 + `docker-compose` 2.26.1 (plugin),
  `caddy` 2.6.2 (pacchetto Debian), `cloudflared` 2026.8.3 (binario ufficiale).
- Layout sul Pi (fuori dal repository):
  - `/home/admin/deep-research/docker-compose.yml` + `searxng/settings.yml`;
  - `/home/admin/.secrets/deep-research.env` (`600`) — token e secret generati
    sul Pi con `openssl rand -hex 32`;
  - `/etc/caddy/env` (`root:root 600`) — token letto da Caddy via
    `EnvironmentFile`;
  - `/etc/caddy/Caddyfile` — reverse proxy con auth (vedi esempio in
    `pi/caddy/Caddyfile.example`);
  - `/home/admin/.cloudflared/` — credenziali tunnel (mai in questo repo).

## Prerequisiti OS e hardening

1. Utente non-root (`admin`) con sudo; disabilitare il login SSH di root.
2. `ufw` opzionale: consentire SSH **solo dalla LAN** (es.
   `sudo ufw allow from 192.168.0.0/16 to any port 22`); il servizio pubblico
   arriva solo via tunnel outbound, quindi non serve aprire altre porte.
3. Aggiornamenti regolari (`sudo apt update && sudo apt upgrade`).
4. Cambiare subito la password temporanea dell'utente; non usare mai `1234`.

## ⚠ Memory controller cgroup (fix necessario su Raspberry Pi OS/Debian rpi)

Le immagini Raspberry Pi avviano il kernel con **`cgroup_disable=memory`**,
quindi Docker ignora i memory limit (`docker inspect` mostra `MemLimit=0`,
`docker run --memory` avvisa *"limitation discarded"*).

**Attenzione**: su queste immagini il flag NON è (solo) in `cmdline.txt`: è
**cotto nei bootargs del DTB** in `/boot/firmware/*.dtb`. Il firmware Raspberry
Pi imposta `/chosen/bootargs` da `cmdline.txt` solo se il DTB non ne ha già
uno; quindi modificare `cmdline.txt` da solo **non basta**.

Procedura verificata (per `bcm2710-rpi-3-b-plus.dtb`, adattare al modello):

```bash
sudo cp /boot/firmware/bcm2710-rpi-3-b-plus.dtb /boot/firmware/bcm2710-rpi-3-b-plus.dtb.bak-cgroup
mkdir -p /tmp/dtb-fix && cd /tmp/dtb-fix
dtc -I dtb -O dts /boot/firmware/bcm2710-rpi-3-b-plus.dtb -o board.dts
sed -i 's/ cgroup_disable=memory//' board.dts          # rimuove il flag
dtc -I dts -O dtb board.dts -o board.dtb
grep -c cgroup_disable board.dtb || echo "assente"     # deve stampare 0
sudo cp board.dtb /boot/firmware/bcm2710-rpi-3-b-plus.dtb
sudo systemctl reboot
```

Dopo il riavvio verificare che il memory controller sia attivo:

```bash
cat /sys/fs/cgroup/cgroup.controllers   # deve includere: memory
```

(È sufficiente anche rimuovere il flag da `cmdline.txt`, ma senza il fix del
DTB non ha effetto su queste immagini.)

## Installazione servizi (Debian trixie, aarch64)

```bash
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose caddy
# Su trixie il plugin compose e' il pacchetto "docker-compose"
# (il nome "docker-compose-v2" esiste solo su bookworm).
sudo systemctl enable --now docker caddy
sudo usermod -aG docker admin     # ri-loggarsi per il gruppo
```

Caddy 2.6.2 del repo Debian: admin API disattivata nel nostro Caddyfile.

## SearXNG (Docker)

- Directory: `/home/admin/deep-research/` (vedi `pi/searxng/settings.yml.example`
  e il compose qui sotto; **su disco** i file hanno i valori reali).
- Il container ascolta **solo** su `127.0.0.1:8893`; nessuna porta su
  interfacce di rete.
- `server.secret_key` generata sul Pi: `openssl rand -hex 32` e scritta in
  `searxng/settings.yml` (permessi `600`). Mai nel repository.

`docker-compose.yml` (file reale sul Pi, identico a quello deployato):

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    container_name: searxng
    restart: unless-stopped
    ports:
      - "127.0.0.1:8893:8080"
    volumes:
      - ./searxng:/etc/searxng:ro
    environment:
      - SEARXNG_BASE_URL=https://${CLOUDFLARE_TUNNEL_HOSTNAME:-localhost}/
      - UWSGI_WORKERS=1
      - UWSGI_THREADS=2
    mem_limit: 512m
    pids_limit: 128
    cpu_shares: 512
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"
```

Comandi:

```bash
cd /home/admin/deep-research
docker compose pull
docker compose up -d
docker compose ps        # stato: Up (healthy)
```

## Caddy con auth token (locale, solo loopback)

Il Caddy di sistema serve **solo** su `127.0.0.1:8080`. Il token è in
`/etc/caddy/env` (`root:root 600`), caricato da systemd:

```bash
sudo mkdir -p /etc/systemd/system/caddy.service.d
# /etc/systemd/system/caddy.service.d/env.conf:
#   [Service]
#   EnvironmentFile=/etc/caddy/env
sudo systemctl daemon-reload
sudo systemctl restart caddy
```

Caddyfile reale in `/etc/caddy/Caddyfile`; versione di esempio:
`pi/caddy/Caddyfile.example`.

Verifica locale:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8080/search?q=test&format=json"        # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>" \
  "http://127.0.0.1:8080/search?q=test&format=json"                                               # 200
```

## Cloudflare Tunnel

1. Installare `cloudflared` (binario ufficiale arm64):

   ```bash
   curl -fsSL -o /tmp/cloudflared \
     https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
   sudo install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared
   ```

2. Login interattivo (apre il browser per autorizzare l'account Cloudflare):

   ```bash
   cloudflared tunnel login
   ```

3. Creare il tunnel e la route DNS (sostituire `<hostname>`):

   ```bash
   cloudflared tunnel create deep-research
   cloudflared tunnel route dns deep-research <CLOUDFLARE_TUNNEL_HOSTNAME>
   ```

   Il file delle credenziali (`~/.cloudflared/<tunnel-id>.json`) resta **solo
   sul Pi**, mai nel repository.

4. Configurazione e systemd: vedi `pi/cloudflared/config.example.yml`; unit
   systemd con `Restart=on-failure` e limite di memoria (es. `MemoryMax=96M`).

5. Autenticazione Vercel→Pi a due strati:
   - header `Authorization: Bearer <token>` verificato da Caddy (Step 30);
   - opzionale: Cloudflare Access Service Token sull'hostname pubblico.

**Nota**: `CLOUDFLARE_TUNNEL_HOSTNAME` (non segreto) va nelle env var Vercel e
nel `.env` locale del Pi; il **token del tunnel non va documentato da nessuna
parte**.

## Failure mode

Tunnel giù / SearXNG spento → il backend Vercel riceve errore di rete →
`E_SEARCH_UNAVAILABLE` secondo la matrice in `docs/error-matrix.md`: ricerca
degradata o fallimento esplicito, mai retry in loop.

## Checklist

- [ ] memcg attivo (`cgroup.controllers` contiene `memory`)
- [ ] SearXNG `Up (healthy)` e solo su `127.0.0.1:8893`
- [ ] Caddy solo su `127.0.0.1:8080`; 401 senza token, 200 con token
- [ ] memory limit applicato (`MemLimit=536870912`)
- [ ] cloudflared installato; tunnel creato e route DNS fatta (richiede login)
- [ ] verifica remota completata (`pi/docs/verifica.md`)
