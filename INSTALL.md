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
unattended-upgrades), Docker, clone + `.env` + TLS + `docker compose up`, the
Cloudflare-only firewall, and the nightly backup cron. It is phased and
idempotent — re-running re-converges each phase.

```bash
# Stage the Cloudflare Origin CA cert FIRST if the zone is proxied (see §"Issue
# a real origin TLS cert" below) — `all` installs it when it is present:
#   /opt/pdexplorer/secrets/cloudflare-origin.pem
#   /opt/pdexplorer/secrets/cloudflare-origin.key
sudo DOMAIN=explorer.example.com LETSENCRYPT_EMAIL=you@example.com \
     bash provision-ubuntu.sh all
```

**Audit F-192: `all` already includes Cloudflare — there is no second step.**
This block used to say "add the Cloudflare-origin firewall too: `... all+cf`".
Since audit F-098, `all` runs the Cloudflare firewall phase *and*
`cf-origin-cert`; the older `all+cf` arm ran the firewall but **not** the origin
certificate. So the "extra" step was a downgrade: it left the box serving the
self-signed placeholder, and Cloudflare Full (Strict) answered 526 — for
operators who had staged the Origin CA files correctly. `all+cf` is now an alias
of `all`, kept only so old runbooks keep working. Prefer `all`.

Run individual phases as needed: `harden` · `docker` · `app` · `backup` ·
`cloudflare` · `cf-origin-cert`. Example: re-deploy only the app after a code
change: `sudo bash provision-ubuntu.sh app`.

> **Audit F-097 — `app` prepares, `deploy.sh` deploys.** The `app` phase used to
> contain its own copy of the build-and-start sequence, and it began with
> `git reset --hard origin/HEAD`. That combination made re-running `app` on a
> box you had hot-patched destroy the patch with no warning and no way back,
> and it meant a provision-built stack and a `deploy.sh`-built stack were
> separately-maintained artefacts answering the same URL.
>
> `app` now clones only when there is no checkout, leaves an existing working
> tree alone, and ends by calling `deploy.sh` — which is the repo's only
> `docker compose up`. Re-running `app` is therefore safe on an edited box:
> `deploy.sh`'s `git pull` will refuse to merge over your changes instead of
> deleting them. To genuinely discard local edits, ask for it by name:
>
> ```bash
> sudo PROVISION_DESTROY_LOCAL_EDITS=1 bash provision-ubuntu.sh app
> ```
>
> For a routine redeploy of an already-provisioned box, `sudo bash deploy.sh`
> remains the shorter path and now produces the identical result.

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
- `SQLITE_CACHE_MB` / `SQLITE_MMAP_MB` — see **SQLite RAM budget** below before
  changing either. They are per worker and they add up.
- `CMC_API_KEY` — optional price feed. **Do not commit a real key** (the
  template ships blank).

### SQLite RAM budget

Audit F-093. This section used to read "for ~16 GB RAM: `SQLITE_CACHE_MB=512`,
`SQLITE_MMAP_MB=4096`", with a parenthetical that the values were per worker.
Both statements were true and together they were a recipe for an OOM: the
explorer runs `WORKERS` node processes, **each opens its own SQLite connection**,
and each connection applies both PRAGMAs. On an 8-core box that recipe asks for
`(512 + 4096) × 8 = 36 GB` on a 16 GB machine. Nothing fails at startup — the
box degrades under load and the kernel eventually OOM-kills a worker, which
looks like an unrelated crash-loop.

Size from a single budget, not per knob:

```
total ≈ (SQLITE_CACHE_MB + SQLITE_MMAP_MB) × WORKERS
```

Give SQLite **at most half** of physical RAM; the rest is node heaps, the
@polkadot/api metadata registries (hundreds of MB per worker on a big runtime),
nginx, and the OS. So:

```
budget_mb        = RAM_MB / 2
per_worker_mb    = budget_mb / WORKERS
SQLITE_MMAP_MB   = per_worker_mb - SQLITE_CACHE_MB      # derive mmap, don't guess it
```

`WORKERS` defaults to `min(nproc, WORKERS_MAX)` and `WORKERS_MAX` defaults to
**8** — so on any box with 8+ cores, assume 8 unless you have pinned `WORKERS`
yourself. Pin it. A recipe that is safe at 4 workers is a 2× over-commit the
day someone deploys the same `.env` onto a 16-core host.

Worked example, 16 GB / 8 workers: budget 8192 MB → 1024 MB per worker →
`SQLITE_CACHE_MB=256`, `SQLITE_MMAP_MB=768`.

| RAM | WORKERS | `SQLITE_CACHE_MB` | `SQLITE_MMAP_MB` | total |
|-----|---------|-------------------|------------------|-------|
| 4 GB  | 2 | 128 | 384  | ~1.0 GB |
| 8 GB  | 4 | 128 | 896  | ~4.0 GB |
| 16 GB | 8 | 256 | 768  | ~8.0 GB |
| 32 GB | 8 | 512 | 1536 | ~16 GB  |

Two notes before you decide the table is too conservative:

- **Raising `WORKERS` raises SQLite RAM too.** The budget is fixed by the box,
  so more workers means *smaller* per-worker values, not the same ones repeated.
  This is the trap the old recipe set.
- `mmap_size` is a *file-backed* mapping, so the resident cost of the mmap half
  is shared between workers and capped by the size of `explorer.db` — measured
  RSS will usually come in under the formula. Budget with the formula anyway:
  it is the number that stays correct when the DB outgrows RAM, which is the
  only case where getting this wrong hurts. There is no benefit to setting
  `SQLITE_MMAP_MB` far above the DB file size.

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
```

> **Price history on a fresh install.** This list used to include a
> `backfill-price-history.mjs`; that script is not in the repo (audit F-025)
> and the command failed with `Cannot find module`. The historical rows on the
> production database were imported ad-hoc and carry the `defillama-backfill`
> and `ascendex-backfill` source tags. A brand-new deployment therefore starts
> its price chart from the first live poll and fills in at
> `PRICE_SYNC_INTERVAL_MS` (default 10 min) — long ranges such as
> `/api/price-history?days=365` stay sparse until enough time has passed.
> Nothing else depends on those rows.

## 6. Verify

```bash
docker compose ps                                   # all containers Up
docker compose logs --tail=50 backend | grep listening   # "Backend listening on port 3001"
curl -fsS http://127.0.0.1/api/network-info | head  # backend reachable via nginx
curl -fsS http://127.0.0.1/api/version              # gitSha matches the tree you deployed
df -h /var/lib/docker .                             # disk headroom for images + the SQLite index
```

Optional disk-latency check. `iostat` comes from the `sysstat` package, which
`provision-ubuntu.sh` does **not** install (audit F-146 — this step used to call
`iostat` unconditionally and failed with `command not found` on every freshly
provisioned box). Install it first if you want the numbers:

```bash
sudo apt-get install -y sysstat
iostat -x 2 3                                       # %util low, r_await single-digit ms on SSD
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

During provisioning, `init-letsencrypt.sh` writes a **self-signed placeholder**
at `$CERTBOT_PATH/conf/live/<domain>/` on the host so nginx can boot — nothing
else in the provision can run until it does. Cloudflare on **Full (Strict)**
rejects a self-signed origin cert with **error 526**, so it must be replaced
before you point DNS at the box.

**Audit F-024 (round 2) — you can no longer finish a provision on the
placeholder by accident.** Two guards, both of which you can trip deliberately
and neither of which you can trip silently:

- `provision-ubuntu.sh all` **aborts** if `DOMAIN` looks like a public hostname
  and `secrets/cloudflare-origin.pem` is absent. Set
  `ALLOW_SELF_SIGNED_ORIGIN=1` only for a grey-clouded origin (or no Cloudflare
  at all), where a self-signed cert is genuinely the right answer.
- `init-letsencrypt.sh` defaults to `ORIGIN_CERT_MODE=letsencrypt`: it runs a
  real `certonly` and exits non-zero if the cert is still self-signed
  afterwards. `ORIGIN_CERT_MODE=self-signed-bootstrap` is the placeholder-only
  mode, and it is what `provision` calls to get nginx started.

The previous round warned and continued. That is not enough here because the
symptom is entirely on the far side of Cloudflare: the origin comes up clean,
`curl -k https://localhost` returns the site, the provision summary is green,
and only real visitors see 526.

**Path note (audit F-189).** `$CERTBOT_PATH/conf` on the **host** is
`/etc/letsencrypt` inside the **frontend container** — the host has no
`/etc/letsencrypt` at all. In production that is
`/opt/pdexplorer/certbot/conf/live/explorer.polkadex.ee/`. Commands run through
`docker compose run/exec` use the container path; `ls`/`chmod` on the VPS use
the host path. `CERTBOT_PATH` lives in `.env`, and compose, `provision` and
`deploy.sh` all read it from there.

**Recommended for a proxied (orange-cloud) zone — Cloudflare Origin CA.**
15-year certificate, no ACME challenge, no renewal, and it works with the proxy
on. Cloudflare dashboard → SSL/TLS → Origin Server → Create Certificate, then:

```bash
cd /opt/pdexplorer
sudo install -d -m 700 secrets
sudo tee secrets/cloudflare-origin.pem >/dev/null   # paste the certificate body
sudo tee secrets/cloudflare-origin.key >/dev/null   # paste the private key
sudo chmod 600 secrets/cloudflare-origin.*
sudo bash provision-ubuntu.sh cf-origin-cert
```

`provision-ubuntu.sh all` performs this automatically when those two files are
already in place, which is why they should be staged *before* the first run.

**Alternative — Let's Encrypt.** Only if you need a publicly trusted cert (e.g.
you also serve the origin directly):

```bash
cd /opt/pdexplorer
# No --entrypoint override needed (audit F-096): the compose entrypoint execs
# certbot when it is given arguments and only runs the renew loop when it is not.
sudo docker compose run --rm certbot \
  certonly --webroot -w /var/www/certbot \
  -d explorer.polkadex.ee -m business@polkadex.ee --agree-tos --non-interactive
sudo docker compose exec frontend nginx -s reload
# verify issuer is Let's Encrypt (not self-signed):
echo | openssl s_client -connect 127.0.0.1:443 -servername explorer.polkadex.ee 2>/dev/null | openssl x509 -noout -issuer
```

Or run the same thing through the script, which does the placeholder dance,
the `certonly`, and the self-signed check for you and fails loudly if the
result is not a real certificate (audit F-024):

```bash
cd /opt/pdexplorer
ORIGIN_CERT_MODE=letsencrypt bash ./init-letsencrypt.sh
```

**Important — Let's Encrypt HTTP-01 does NOT work through an orange-cloud
(proxied) Cloudflare record by default** (audit F-027; README explains why —
"Always Use HTTPS" redirects the challenge before it reaches the origin). The
`certonly` above only succeeds if one of these is true:

1. The DNS record is **grey-cloud** (DNS-only) during issuance — and stays that
   way, or is toggled again, for every 60-day renewal, or
2. You use **DNS-01** validation instead of the webroot method.

Otherwise use the **Cloudflare Origin CA** path above; for a permanently
proxied zone that is the recommended option, not a fallback.

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

## One-off maintenance: the hash-keyed id migration (audit F-021 / F-182)

Transaction and staking-reward rows are keyed by `event-<blockHash>-<eventIndex>`.
Databases created before that change key them by block NUMBER, which names a
*slot* rather than an event — after a reorg the canonical chain puts a different
block in the same slot and `INSERT OR IGNORE` silently drops the real one.

`initDb` runs the migration automatically, once, behind a kv flag. It is chunked
with a commit per chunk, so it does not hold the write lock for minutes. **On a
large database you may still prefer to run it yourself, during a window:**

```sh
docker compose exec backend node --experimental-sqlite tools/migrate-hash-ids.mjs
# resumable — re-running continues from the last committed chunk
# --chunk=<blocks> tunes the transaction size (default 250000)
```

Either path queues every height whose fork-inconsistent rows were removed into
`scan_failures`, so the chain indexer re-fetches the canonical data. Audit F-182:
the script previously omitted that hook, which made running it the documented way
*worse* than letting it happen at boot — the orphan row deleted, the canonical one
never fetched, and nothing recording the debt.

Check whether it has already run:

```sh
sqlite3 /opt/pdexplorer/data/explorer.db \
  "SELECT value FROM kv WHERE key='migration:hash-keyed-ids';"
```
