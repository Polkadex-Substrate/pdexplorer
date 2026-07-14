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

## 4. Backups → separate storage

The nightly cron (`/etc/cron.d/pdexplorer-backup`) runs `backup.sh`, which is
throttled with `ionice`/`nice` so it can't starve serving. To land backups on a
dedicated volume, either **mount that volume at `/var/backup`** (default
`DEST`), or set overrides in `/etc/default/pdexplorer-backup`:

```bash
# /etc/default/pdexplorer-backup   (values are exported into backup.sh)
DEST=/mnt/backups
MIN_INTERVAL_HOURS=24      # daily
INTEGRITY_CHECK=on         # set 'off' if the source volume can't absorb a full re-read
```

Restore is documented in the header of `backup.sh`.

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

## Why storage matters

The explorer is a large SQLite DB (tens of GB and growing). On a slow/throttled
disk, normal reads queue up and the server goes I/O-bound (high load, ~99%
`iowait`, no single CPU hog) even though CPU is idle. Use SSD with real
(provisioned) IOPS, give SQLite a large cache/mmap (step 2), and keep backups on
a separate volume so they never contend with serving. This is the single most
important sizing decision — especially ahead of the orderbook launch.
