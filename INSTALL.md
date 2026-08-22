# Installing the Polkadex Explorer on a fresh server

A concise, repeatable runbook for standing the explorer up on a new box (e.g.
the new SSD VPS). Every script referenced here is **idempotent** — safe to
re-run. For the full list of tunables see `.env.example`; for architecture see
`README.md`.

## 0. Prerequisites

- Ubuntu 22.04/24.04 VPS, **SSD-backed storage** (the DB is I/O-heavy; a slow
  disk will bottleneck the whole app — see the note at the bottom).
- A DNS `A` record for your domain pointing at the server's IP.
- Ports 80 and 443 reachable (open them, or allow Cloudflare ranges — the
  provision script's `cloudflare` phase does the latter).
- Optional but recommended: a **separate volume for backups**, mounted at
  `/var/backup` (see step 4).

## 1. One-shot install (recommended)

`provision-ubuntu.sh` does everything: OS hardening (ufw, fail2ban,
unattended-upgrades), Docker, clone + `.env` + TLS + `docker compose up`, and
the nightly backup cron. It is phased and idempotent — re-running re-converges
each phase.

```bash
sudo DOMAIN=explorer.example.com LETSENCRYPT_EMAIL=you@example.com \
     bash provision-ubuntu.sh all
# add the Cloudflare-origin firewall too:
#   ... bash provision-ubuntu.sh all+cf
```

Run individual phases as needed: `harden` · `docker` · `app` · `backup` ·
`cloudflare`. Example: re-deploy only the app after a code change:
`sudo bash provision-ubuntu.sh app`.

## 2. Configure `.env` for this box

`provision` writes a starter `.env`; edit it, then rebuild the backend
(compose snapshots env at create time — a plain restart won't pick it up):

```bash
docker compose up -d --build backend
```

Key values for a new SSD box:

- `DATA_PATH` — host path bind-mounted to `/app/data`. Keep it on the SSD.
- `POLKADEX_WS` — **point at an archive RPC** if you need full historical event
  backfill (a pruned node can't serve old-block metadata).
- `SQLITE_CACHE_MB` / `SQLITE_MMAP_MB` — raise on a big box so the DB is served
  from RAM. For ~16 GB RAM: `SQLITE_CACHE_MB=512`, `SQLITE_MMAP_MB=4096`.
  (These are **per worker** — total ≈ value × `WORKERS`.)
- `CMC_API_KEY` — optional price feed. **Do not commit a real key** (the
  template ships blank).

## 3. Seed the database

Two options:

- **Restore the latest backup** (fastest; the indexer catches the gap up):
  ```bash
  docker compose down
  gunzip -c /var/backup/explorer-YYYYMMDDTHHMMSSZ.db.gz > "$DATA_PATH/explorer.db"
  rm -f "$DATA_PATH"/explorer.db-wal "$DATA_PATH"/explorer.db-shm
  chown -R 1000:1000 "$DATA_PATH"
  docker compose up -d
  ```
- **Index from genesis** — just start the stack; the chain indexer backfills
  toward genesis on its own (slower, but hands-off).

## 4. Backups → local + off-box (external storage)

The nightly cron (`/etc/cron.d/pdexplorer-backup`) runs `backup.sh`, which is
throttled with `ionice`/`nice` so it can't starve serving. It keeps a local copy
for fast restore and (recommended) pushes a verified copy **off-box to external
storage via rsync over SSH** — the mature backup target (encrypted, resumable,
incremental). All settings live in `/etc/default/pdexplorer-backup` (sourced
automatically by both cron and manual runs):

```bash
# /etc/default/pdexplorer-backup   (exported into backup.sh; root-owned 0644)
DEST=/var/backup                 # local staging dir (or a dedicated volume)
MAX_BACKUPS=7                    # keep newest N locally (count-based, not age)
MIN_INTERVAL_HOURS=24            # daily
INTEGRITY_CHECK=on               # set 'off' only if the disk can't absorb a re-read

# --- off-box copy to the external storage box (SSH + rsync) ---
REMOTE_ENABLED=1
REMOTE_HOST=storage.example.com
REMOTE_USER=pdexbackup           # non-root SSH user on the storage box
REMOTE_PATH=pdexplorer-backups
SSH_KEY=/root/.ssh/pdex_backup_ed25519
REMOTE_MAX_BACKUPS=14            # keep newest N off-box
```

Retention is **count-based** (newest N), not age-based: the DB is a rebuildable
index of on-chain data, so backups exist to restore fast — a few recent
generations guard against restoring a silently-corrupted copy, and that's all
you need. Lower the counts to save more storage (avoid `1` — no fallback).

One-time key setup (passphrase-less key, key auth only — cron never prompts):

```bash
ssh-keygen -t ed25519 -N '' -f /root/.ssh/pdex_backup_ed25519
ssh-copy-id -i /root/.ssh/pdex_backup_ed25519.pub pdexbackup@storage.example.com
sudo FORCE=1 /opt/pdexplorer/backup.sh     # test: writes local + pushes off-box
```

`backup.sh` exits `3` if the local backup succeeded but the off-box push failed
(the on-disk copy is intact) so monitoring can alert. Restore (from the local
copy or by pulling from the box first) is documented in `backup.sh`'s header.

## 5. Post-install: build analytics indexes (off-peak, one-off)

Index creation is deliberately **not** done at boot (a synchronous
`CREATE INDEX` on a multi-GB DB blocks startup). Run it once, out-of-band, when
traffic and disk are quiet:

```bash
docker compose exec backend node --experimental-sqlite migrate-add-indexes.mjs
```

Optional one-off data migrations (also idempotent, `INSERT OR IGNORE`):

```bash
docker compose exec backend node --experimental-sqlite backfill-transactions-from-events.mjs
docker compose exec backend node --experimental-sqlite backfill-price-history.mjs
```

## 6. Verify

```bash
docker compose ps                                   # all containers Up
docker compose logs --tail=50 backend | grep listening   # "Backend listening on port 3001"
curl -fsS http://127.0.0.1/api/network-info | head  # backend reachable via nginx
iostat -x 2 3                                        # %util low, r_await single-digit ms on SSD
```

## Migrating from an existing server

Moving the DB to a new box (e.g. SATA → SSD). Golden rule: **never copy the
SQLite file while it's being written — stop the writer and fold the WAL in
first.** Choose based on whether you can tolerate a short data gap.

**Before you start:** whitelist the new server's egress IP in the RPC origins'
rate-limit exemption (`geo $rate_limit_exempt` on each origin behind
`rpc.polkadex.ee`) and reload nginx there. Otherwise the new indexer gets
429-throttled during catch-up.

### Option A — Consistent snapshot (zero data gap; maintenance window)

On the **old** server, quiesce and checkpoint:

```bash
cd /opt/pdexplorer
sudo docker compose stop backend                                 # stop the only writer
sudo sqlite3 data/explorer.db 'PRAGMA wal_checkpoint(TRUNCATE);'  # fold WAL into the main file
```

On the **new** server, pull it (`-z` compresses in transit, `--partial`
resumes if the link drops), verify, fix ownership, start:

```bash
sudo rsync -avz --progress --partial olduser@OLD_IP:/opt/pdexplorer/data/explorer.db /opt/pdexplorer/data/explorer.db
sudo rm -f /opt/pdexplorer/data/explorer.db-wal /opt/pdexplorer/data/explorer.db-shm
sqlite3 /opt/pdexplorer/data/explorer.db 'PRAGMA quick_check;'    # expect "ok" (fast on SSD)
sudo chown -R 1000:1000 /opt/pdexplorer/data
cd /opt/pdexplorer && sudo docker compose up -d
```

Reading tens of GB off a slow old disk can take hours, and the old site is down
during the copy — plan the window.

### Option B — Restore latest backup + let the indexer catch up (fast)

Transfer the existing compressed backup (small) instead of re-reading the whole
DB; the indexer backfills the gap from the watermarks stored in the DB:

```bash
# on the NEW server:
sudo rsync -avz --progress --partial 'olduser@OLD_IP:/var/backup/explorer-*.db.gz' /tmp/
gunzip -c /tmp/explorer-YYYYMMDDTHHMMSSZ.db.gz > /opt/pdexplorer/data/explorer.db
sudo chown -R 1000:1000 /opt/pdexplorer/data
cd /opt/pdexplorer && sudo docker compose up -d
```

### Issue a real origin TLS cert (do this before cutover)

`provision`/`init-letsencrypt.sh` leave a **self-signed placeholder** at
`certbot/conf/live/<domain>/` so nginx can boot. Cloudflare on **Full (Strict)**
rejects a self-signed origin cert with **error 526**, so replace it with a real
one on the new box before pointing DNS at it:

```bash
cd /opt/pdexplorer
# NOTE: --entrypoint certbot is required — the compose certbot service's
# entrypoint is overridden to a renew-loop, so without it 'certonly' never runs.
sudo docker compose run --rm --entrypoint certbot certbot \
  certonly --webroot -w /var/www/certbot \
  -d explorer.polkadex.ee -m business@polkadex.ee --agree-tos --non-interactive
sudo docker compose exec frontend nginx -s reload
# verify issuer is Let's Encrypt (not self-signed):
echo | openssl s_client -connect 127.0.0.1:443 -servername explorer.polkadex.ee 2>/dev/null | openssl x509 -noout -issuer
```

**Important — Let's Encrypt HTTP-01 does NOT work through an orange-cloud
(proxied) Cloudflare record by default** (audit F-027; README explains why —
"Always Use HTTPS" redirects the challenge before it reaches the origin). The
`certonly` above only succeeds if one of these is true:

1. The DNS record is **grey-cloud** (DNS-only) during issuance, or
2. You use **DNS-01** validation instead of the webroot method, or
3. You skip Let's Encrypt entirely and install a **Cloudflare Origin
   Certificate** (15-year, no renewal): put the cert + key in
   `secrets/cloudflare-origin.pem` / `.key` and run
   `sudo bash provision-ubuntu.sh cf-origin-cert`. This is the recommended
   path for a permanently proxied zone.

The compose `certbot` service auto-renews LE certs every 12h thereafter
(option 1/2 only — Origin CA certs need no renewal).

### After cutover

1. Build the analytics indexes off-peak (step 5) once the DB is warm on SSD.
2. Confirm catch-up: `docker compose logs -f backend | grep chain-index` (no 429s).
3. Point DNS (`explorer.polkadex.ee`) at the new box; decommission the old one
   and remove its IP from the RPC exemption list.

## Why storage matters

The explorer is a large SQLite DB (tens of GB and growing). On a slow/throttled
disk, normal reads queue up and the server goes I/O-bound (high load, ~99%
`iowait`, no single CPU hog) even though CPU is idle. Use SSD with real
(provisioned) IOPS, give SQLite a large cache/mmap (step 2), and keep backups on
a separate volume so they never contend with serving. This is the single most
important sizing decision — especially ahead of the orderbook launch.
