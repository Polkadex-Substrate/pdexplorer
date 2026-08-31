# Polkadex Mainnet Explorer

A self-hosted block explorer and lightweight wallet UI for the [Polkadex](https://polkadex.ee) Mainnet. Browses blocks, transactions, events, validators, staking rewards and governance in real time, with a non-custodial wallet that delegates all signing to your existing Substrate wallet (Polkadot.js / Talisman / SubWallet on desktop, Nova Wallet / SubWallet on mobile via their in-app browsers).

Live: **https://explorer.polkadex.ee/**

---

## Features

**Chain browsing**

- Live feed of blocks, transactions, and on-chain events
- Per-block, per-extrinsic, per-account detail pages
- Validator directory with era history, commission, total stake, nominators
- Top-holder rankings sorted by balance
- On-chain governance views: democracy referenda, council motions, treasury proposals
- Polkadex-prefixed (SS58 88) addresses everywhere — the UI normalises whatever wallet extensions hand back

**Indexer**

- Combined blocks + events indexer with four passes per tick: forward (new head), backfill (genesis-ward), gap-fill (re-attempt missing block numbers detected via SQL window query), and a reorg sweep that re-verifies stored hashes against finality and repairs discarded forks (F-007)
- Transaction and reward rows are hash-keyed (F-021) so a fork row and its canonical replacement can never collide; the transactions table backfills to genesis automatically by deriving transfers from already-indexed events (F-008)
- Parallel block fetching (configurable concurrency, default 8) for fast catch-up after outages
- Per-sync backoff when the upstream RPC errors, so a flaky chain doesn't amplify load
- Staking-rewards crawler with resumable per-address history
- Governance history crawler (treasury + council)
- SQLite via Node 22's built-in `node:sqlite`, WAL mode, with prepared statements throughout

**Wallet (non-custodial)**

- Connect via injected Substrate wallet (Polkadot.js, Talisman, SubWallet, PolkaGate, Nova Wallet, …)
- Mobile wallet support: detects Nova/SubWallet in-app browsers; deep-link buttons + copy-URL fallback when accessed from a regular mobile browser
- Send PDEX (auto-picks `transferKeepAlive` / `transferAllowDeath` / legacy `transfer` based on runtime), live network-fee estimation via `paymentInfo`
- Stake more / nominate (replaces nomination set), pay out rewards (batched `payoutStakers`), unstake
- Read-only mode if no wallet is currently injected — dashboard still loads, signing actions hidden behind a clear callout
- Sign-in-with-wallet flow for the discussion board (nonce-bound signature, 24-byte session tokens, server-side TTL)

**SEO**

- Per-route titles, descriptions, canonical URLs, OG/Twitter cards
- `WebSite` + `Organization` + `SoftwareApplication` JSON-LD on every page; route-scoped `HowTo` + `FAQPage` JSON-LD on `/wallet`
- Clean URLs via the History API (no `#fragment` routing); nginx SPA fallback
- Dynamic `/sitemap.xml` (re-generated every 5 minutes from the SQLite index, includes top validators / recent blocks / top holders) and `/robots.txt`
- PWA manifest with home-screen shortcuts (`/blocks`, `/validators`, `/staking-rewards`, `/wallet`)

> **Audit F-061 — the manifest is JSON, so its reasoning has to live here.**
> Round 1 of this finding was a literal duplicate: a `manifest.webmanifest` at
> the repo root and another in `public/`, disagreeing about the theme colour,
> with only one of them ever reaching a browser. The root copy was deleted —
> but it was the copy whose colours were *right*, so the duplicate went away
> and the wrong values were the ones that shipped. That is worth remembering:
> de-duplicating by deletion silently picks a winner, and nothing checks that
> you picked the correct one.
>
> What the surviving manifest is now required to be is **true**, because every
> field in it is a promise the operating system keeps on our behalf long after
> the tab is closed:
>
> - `theme_color` / `background_color` are `#E6007A` / `#08080C`, the same
>   `--brand-primary` and `--bg-dark` that `styles.css`, `BRAND.md` and the
>   `index.html` `theme-color` meta tags use. They previously read `#7c3aed`
>   and `#0b0420`, an older purple palette, so an installed app opened to a
>   splash screen in colours that appear nowhere on the site.
> - Icon `sizes` describe the actual files. `logo.png` and `favicon.png` are
>   both 259×256; the manifest declared the same two files as `32x32`,
>   `192x192` and `512x512`. A browser that trusts `sizes` when picking an icon
>   and then decodes something else gets a scaled, blurry result at exactly the
>   size it was trying to avoid scaling. If real 192/512 assets are ever
>   produced, add them as separate files rather than re-labelling these.
> - `purpose: "maskable"` was dropped. Maskable art has to be drawn with a
>   ~40% safe zone because the platform crops it to whatever mask it likes;
>   ours is not, so the claim bought a cropped logo on Android instead of a
>   letterboxed one.
> - The `screenshots` entry was removed. It pointed at `logo.png` described as
>   a 512×512 screenshot. It was neither a screenshot nor 512×512, and its only
>   effect was to put the logo into the install dialog's screenshot carousel.
>
> `dist/manifest.webmanifest` is a Vite build artefact (gitignored) and is
> whatever `public/` last contained; it is not a second source.
>
> One instance of the old purple palette outlived this sweep and is **not** in
> the manifest: `index.html` still carries
> `<link rel="mask-icon" href="logo.png" color="#7c3aed">`. Safari uses that
> colour for a pinned-tab glyph, so it is low-traffic rather than harmless — it
> is the one surface where a user still sees the pre-rebrand purple, and it is
> exactly the kind of leftover that makes the next person assume the palette
> migration was never finished. Changing it is a one-line `index.html` edit to
> `#E6007A`.

**Operations**

- Containerised via Docker Compose (backend + frontend + certbot)
- TLS via Let's Encrypt with auto-renew
- Timestamped INFO/WARN/ERROR logs across the backend
- Persistent SQLite index (host bind-mount, survives container churn)
- Stale-while-revalidate caching for the home page's Network Information panel

---

## Architecture

```
                          ┌────────────────────────────────────────────┐
                          │  Browser (desktop ext / Nova / SubWallet)  │
                          └───────────────┬────────────────────────────┘
                                          │  HTTPS
                                          ▼
                          ┌────────────────────────────────────────────┐
                          │  nginx (Dockerfile.frontend)               │
                          │   - serves static SPA from /usr/share/...  │
                          │   - proxies /api/* and /sitemap.xml etc.   │
                          │   - terminates TLS (certbot)               │
                          └───────────────┬────────────────────────────┘
                                          │  HTTP (container network)
                                          ▼
                          ┌────────────────────────────────────────────┐
                          │  Node.js backend (Dockerfile.backend)      │
                          │   - Express 5 API (/api/*)                 │
                          │   - Indexers (blocks/events/tx/staking…)   │
                          │   - SQLite WAL (host bind-mount: ./data)   │
                          └───────────────┬────────────────────────────┘
                                          │  WebSocket (wss://)
                                          ▼
                          ┌────────────────────────────────────────────┐
                          │  Polkadex RPC (wss://rpc.polkadex.ee — CF  │
                          │  LB fronting so.polkadex.ee + faradaynodes)│
                          └────────────────────────────────────────────┘
```

The backend reads from the Polkadex RPC, persists into SQLite, and serves cached JSON to the frontend. All wallet signing happens **in the user's wallet**, not on the server — the explorer never sees private keys.

---

## Quick start

### Local development

```bash
git clone <repo-url>
cd pdexplorer
npm install

# Terminal 1 — backend (Node 22 required for node:sqlite)
node --experimental-sqlite server.js

# Terminal 2 — frontend with HMR (Vite dev server on :3000; proxies /api,
# /sitemap.xml, /robots.txt and /developers to :3001 — audit F-060, dev has to
# reach the same server-rendered documents production serves)
npm run dev
```

Open http://localhost:3000.

### Production (single command, fresh Ubuntu 24.04 LTS VPS)

```bash
sudo bash provision-ubuntu.sh
```

That script hardens the OS (UFW, fail2ban, key-only SSH, persistent journals, watchdog, fstab `nofail`, hardened sysctl), installs Docker, clones the repo, installs an origin TLS certificate, restricts 80/443 to Cloudflare's ranges, and starts the stack. Idempotent — safe to re-run. See [Deployment](#deployment) below for the details and prerequisites.

> **Audit F-190 — this line used to say "issues a Let's Encrypt cert", and it
> was not true.** On the default path (`DOMAIN` proxied by Cloudflare,
> orange-cloud) the ACME HTTP-01 challenge cannot reach the origin, so nothing
> is issued: `init-letsencrypt.sh` writes a **self-signed placeholder** whose
> only job is letting nginx boot. An operator who believed the old sentence
> pointed DNS at the new box, watched Cloudflare answer **526** (invalid origin
> certificate) under Full (Strict), and had no reason to suspect the cert. The
> supported ways to get a real origin certificate are, in the order you should
> prefer them for a permanently proxied zone:
>
> 1. **Cloudflare Origin CA** — 15-year cert, no renewal, no challenge, works
>    with the proxy on. Stage `secrets/cloudflare-origin.pem` + `.key` and run
>    `sudo bash provision-ubuntu.sh cf-origin-cert`. `provision-ubuntu.sh all`
>    runs this automatically when those files are present.
>
> **Audit F-024 (round 2):** `provision-ubuntu.sh all` now **fails** rather
> than finishing on the placeholder, whenever `DOMAIN` looks like a public
> hostname and no Origin CA material is staged. Warning and continuing was the
> round-1 attempt and it did not hold: the failure is invisible from the origin
> (nginx up, green summary, `curl -k https://localhost` fine) and only the
> public internet sees the 526, so scrollback is the wrong place for it.
> Override with `ALLOW_SELF_SIGNED_ORIGIN=1` **only** when the record is
> grey-clouded or there is no Cloudflare in front of the box.
> `init-letsencrypt.sh` likewise now runs a real `certonly` by default and
> exits non-zero if the result is still self-signed; the placeholder-only
> behaviour is `ORIGIN_CERT_MODE=self-signed-bootstrap`.
> 2. **Let's Encrypt via DNS-01** (`certbot/dns-cloudflare` + a scoped API
>    token) — a publicly trusted cert that renews unattended behind the proxy.
> 3. **Let's Encrypt via HTTP-01 with the record temporarily grey-clouded** —
>    works, but every renewal needs the same manual toggle.
>
> `INSTALL.md` carries the same three options; if these two lists ever disagree
> again, the README is the one that has drifted.

---

## Deployment

### Fresh server (recommended)

The `provision-ubuntu.sh` script targets Ubuntu 22.04 / 24.04 LTS and does the OS hardening + Docker install + app deploy in three idempotent phases.

**Before running**, on the fresh VPS:

1. Put your SSH public key in `/root/.ssh/authorized_keys`. The script disables password SSH; without a key already in place you'll lock yourself out.
2. Point the DNS A record for your domain at the VPS's public IP.
   - If the zone is **proxied (orange-cloud)** — the production setup — stage a
     Cloudflare Origin CA certificate at `secrets/cloudflare-origin.pem` and
     `secrets/cloudflare-origin.key` *before* running the script, so the `all`
     phase installs a certificate Cloudflare Full (Strict) accepts instead of
     leaving the self-signed placeholder in place (audit F-190/F-024).
   - Only if the record is **grey-cloud (DNS only)** does Let's Encrypt's
     HTTP-01 challenge reach the origin. Through the proxy it does not: "Always
     Use HTTPS" redirects `/.well-known/acme-challenge/…` before it arrives.
3. Edit the constants at the top of `provision-ubuntu.sh` if your domain / repo URL / email differ from the defaults, or pass them in via env:

```bash
sudo DOMAIN=explorer.polkadex.ee \
     LETSENCRYPT_EMAIL=you@example.com \
     REPO_URL=https://github.com/you/pdexplorer.git \
     bash provision-ubuntu.sh
```

You can run just one phase at a time:

```bash
sudo bash provision-ubuntu.sh harden          # OS hardening only
sudo bash provision-ubuntu.sh docker          # Docker install only
sudo bash provision-ubuntu.sh app             # Clone + build + deploy only
sudo bash provision-ubuntu.sh backup          # Nightly SQLite backup + cron
sudo bash provision-ubuntu.sh cloudflare      # Restrict 80/443 to Cloudflare IPs
sudo bash provision-ubuntu.sh cf-origin-cert  # Install a Cloudflare Origin CA cert
```

**Audit F-192 — do not run `all+cf` "to add Cloudflare".** `all` (the default,
what you get with no argument) already runs the Cloudflare firewall phase *and*
the Origin CA install when `secrets/cloudflare-origin.pem` is staged. This
README used to point at a separate `all+cf` arm, which was left over from before
audit F-098 and never called `setup_cf_origin_cert` — so following that
instruction *skipped* the origin certificate and left the box on a self-signed
placeholder, i.e. a Cloudflare 526 caused by taking the extra step. `all+cf` is
now an alias of `all`, kept only so existing runbooks don't break.

After the first run, re-test SSH on the configured port (default 22) *before* closing your current session — the script disables root password login.

### Cloudflare proxy mode

When the site is fronted by Cloudflare's proxy (orange-cloud DNS record), the only IPs that should ever reach 80/443 on the origin are Cloudflare's edge nodes. Direct hits to the VPS IP bypass Cloudflare's WAF, rate limiting and DDoS protection entirely. The `cloudflare` phase locks the host firewall down to Cloudflare's published ranges only.

```bash
# After `harden` has run (so UFW exists), enable Cloudflare-only mode:
sudo bash provision-ubuntu.sh cloudflare
```

What it does:

- Fetches `https://www.cloudflare.com/ips-v4` and `ips-v6` and caches them under `/etc/cloudflare/`.
- Removes the generic UFW `allow 80/tcp` and `allow 443/tcp` rules.
- Adds one allow-rule per Cloudflare CIDR (≈22 IPv4 + 7 IPv6 ranges), tagged with the `Cloudflare proxy` comment.
- Installs `cloudflare-ufw-refresh.timer` (systemd, weekly) which re-fetches the ranges and updates UFW only if they've changed — so additions/removals on Cloudflare's side propagate to your firewall without manual work.

nginx is already configured (in `nginx.conf`) to trust Cloudflare's ranges as proxies (`set_real_ip_from …`) and to extract the real client IP from the `CF-Connecting-IP` header. Without this, access logs and any IP-based rate limiting would only ever see Cloudflare's edge IPs. The CIDR list in `nginx.conf` is baked into the frontend image at build time — refresh by rebuilding (`docker compose up -d --build frontend`) if Cloudflare ever changes its ranges.

**Cloudflare-side settings to set in the dashboard:**

| Setting                           | Value                            | Why                                                    |
| --------------------------------- | -------------------------------- | ------------------------------------------------------ |
| DNS record for `explorer.polkadex.ee` | A record, **Proxied** (orange)   | Required for any of this to make sense                 |
| SSL/TLS encryption mode           | **Full (Strict)**                | CF validates the origin's Let's Encrypt cert           |
| Always Use HTTPS                  | On                               | Force browser → CF in HTTPS                            |
| Minimum TLS Version               | 1.2 or 1.3                       | Match the modern-only `options-ssl-nginx.conf`         |
| Automatic HTTPS Rewrites          | On                               | Rewrites stray `http://` references                    |
| Brotli                            | On                               | Better compression than gzip; CF handles it edge-side  |

**Important — Let's Encrypt + Cloudflare proxy is incompatible by default.** The HTTP-01 challenge that `init-letsencrypt.sh` uses goes through Cloudflare (because the DNS is proxied), so Let's Encrypt's validation server never reaches your origin and renewal fails. Pick one of:

1. **Install a Cloudflare Origin CA certificate** (recommended, and what production runs). Cloudflare dashboard → SSL/TLS → Origin Server → Create Certificate; 15-year lifetime, no renewal, no ACME challenge, valid only for Cloudflare→origin traffic — which is the only traffic the origin accepts once the `cloudflare` phase has locked 80/443 to CF ranges. Put the two files at `secrets/cloudflare-origin.pem` and `secrets/cloudflare-origin.key` (mode 600, root) and run:
   ```bash
   sudo bash provision-ubuntu.sh cf-origin-cert
   ```
   `provision-ubuntu.sh all` runs this for you when those files exist; when they don't, it warns and leaves the self-signed placeholder, which Full (Strict) rejects with 526.
2. **Use DNS-01 challenge with the Cloudflare API plugin** — a publicly trusted certificate that also renews unattended with the proxy on. Generate a scoped CF API token (`Zone:DNS:Edit` on the explorer zone), then issue certs with:
   ```bash
   # -v HOST_PATH:CONTAINER_PATH. $CERTBOT_PATH/conf on the host is
   # /etc/letsencrypt inside the container — see "Where the certificates
   # actually live" below.
   docker run --rm \
     -v /opt/pdexplorer/certbot/conf:/etc/letsencrypt \
     -v /opt/pdexplorer/certbot/www:/var/www/certbot \
     -e CLOUDFLARE_API_TOKEN=... \
     certbot/dns-cloudflare certonly \
       --dns-cloudflare \
       --dns-cloudflare-credentials /tmp/cf.ini \
       -d explorer.polkadex.ee \
       -m vivek@polkadex.ee --agree-tos --non-interactive
   ```
3. **Temporarily grey-cloud during cert issuance/renewal.** Toggle the DNS record to "DNS only" in the CF dashboard, run certbot, toggle back. Works, but every 60-day renewal needs the same manual toggle, so it is a standing outage risk.

(A Page Rule bypass for `/.well-known/acme-challenge/*` is sometimes suggested. It is fragile — it silently stops working when rules are reordered or the free rule quota is consumed elsewhere — and it is not used or supported here.)

### Where the certificates actually live (audit F-189)

The cert tree is a **bind mount**, so the same file has two paths and each one
exists on only one side:

| | Path |
| --- | --- |
| **Host** (the VPS; what `provision-ubuntu.sh`, `deploy.sh` and `backup` touch) | `$CERTBOT_PATH/conf/live/$DOMAIN/privkey.pem` — in production `/opt/pdexplorer/certbot/conf/live/explorer.polkadex.ee/privkey.pem` |
| **Container** (what `nginx.conf` names) | `/etc/letsencrypt/live/explorer.polkadex.ee/privkey.pem` |

`CERTBOT_PATH` is set in `.env`; `docker-compose.yml` interpolates it into the
mount, and `provision-ubuntu.sh` and `deploy.sh` now read it back out of that
same file rather than each hard-coding a path of their own.

**There is no `/etc/letsencrypt` on the host.** `ls /etc/letsencrypt` on the VPS
returns "No such file or directory", which reads exactly like a missing
certificate and has cost real debugging time. Inspect the right side:

```bash
ls -l /opt/pdexplorer/certbot/conf/live/explorer.polkadex.ee/     # host
docker compose exec frontend ls -l /etc/letsencrypt/live/         # container
```

The `live/<name>` segment in `nginx.conf` is a literal baked into the frontend
image at build time, so it does not follow `$DOMAIN`. When a deployment's
`DOMAIN` differs, `provision-ubuntu.sh` reads the name out of `nginx.conf` and
links it at `live/$DOMAIN` inside the mounted tree, so the container still opens
the certificate that was actually installed; the durable fix for a permanent
domain change is to edit the two `ssl_certificate*` lines and rebuild the
frontend image.

**Refreshing the Cloudflare range list manually**, if you don't want to wait for the weekly timer:

```bash
sudo systemctl start cloudflare-ufw-refresh.service
sudo systemctl status cloudflare-ufw-refresh.service
sudo ufw status | grep Cloudflare
```

### Existing server (manual)

```bash
git clone <repo-url> /opt/pdexplorer
cd /opt/pdexplorer
cp .env.example .env  # if present; otherwise create one — see Configuration

# Audit F-024: this issues a REAL certificate (HTTP-01) and exits non-zero if
# it ends up self-signed. Behind an orange-clouded Cloudflare record it will
# fail by design — use `provision-ubuntu.sh cf-origin-cert` there instead, or
# grey-cloud the record for the duration.
./init-letsencrypt.sh

docker compose up -d --build
```

### Updating

```bash
cd /opt/pdexplorer
git pull
docker compose up -d --build backend frontend
```

Note: the backend image bakes in `server.js` and `db.js`, and the frontend image bakes in the built static files. `docker compose restart` alone won't pick up code changes — always include `--build`.

### Restoring data on a new server

The SQLite index lives at `./data/explorer.db` (plus `-shm` / `-wal` sidecars in WAL mode). To seed a new server from a clean backup of the old one:

```bash
# On the old server (or from your backup):
sqlite3 /opt/pdexplorer/data/explorer.db ".backup /tmp/explorer.bak.db"
scp /tmp/explorer.bak.db new-server:/tmp/

# On the new server (after running provision-ubuntu.sh app):
docker compose down
mv /tmp/explorer.bak.db /opt/pdexplorer/data/explorer.db
sudo chown 1000:1000 /opt/pdexplorer/data/explorer.db
sudo chmod 0640 /opt/pdexplorer/data/explorer.db
docker compose up -d
```

The indexer's gap-fill code automatically backfills any blocks missed between the snapshot timestamp and the new server's current head.

---

## Configuration

All knobs are env vars. None are required to start — every value has a sensible default — but a production deploy will want at least `DOMAIN` and `LETSENCRYPT_EMAIL` set. (`CMC_API_KEY` is *not* needed: the default price provider is keyless CoinGecko.)

### General

| Env var              | Default                       | Notes                                                         |
| -------------------- | ----------------------------- | ------------------------------------------------------------- |
| `PORT`               | `3001`                        | Backend HTTP port (proxied by nginx)                          |
| `DATA_PATH`          | `./data`                      | **Compose-only.** Host directory bind-mounted to `/app/data` (`${DATA_PATH:-./data}:/app/data` in `docker-compose.yml`). Point it at an absolute path outside the checkout. |
| `SITE_URL`           | `https://explorer.polkadex.ee`| Used in sitemap.xml and robots.txt                            |
| `ALLOWED_ORIGINS`    | `https://explorer.polkadex.ee,http://localhost:3000` | Comma-separated CORS allowlist          |

> **There is no `DATA_DIR` env var** (audit F-099 — this table used to list one).
> `server.js` hard-codes the database directory as `path.join(process.cwd(), 'data')`,
> i.e. `/app/data` inside the container, and reads nothing from the environment
> to get there. The only knob is `DATA_PATH`, which Compose interpolates into
> the *host* side of the bind mount. Setting `DATA_DIR` has no effect; if you
> run the backend outside Docker, `cd` into the checkout so `process.cwd()/data`
> is the directory you mean.

### Chain RPC

| Env var                       | Default                | Notes                                                         |
| ----------------------------- | ---------------------- | ------------------------------------------------------------- |
| `POLKADEX_WS`                 | `wss://rpc.polkadex.ee` | Comma-separated WS endpoints (first = primary, rest = fallback). Default is the Cloudflare LB that fronts the origin pool — auto-fails over between origins. |
| `POLKADEX_WS_RECONNECT_MS`    | `2500`                 | Reconnect interval after a dropped socket                     |

### Email alerts (governance + network notifications)

Optional. Set `EMAIL_PROVIDER=disabled` (the default) and the explorer runs without email — the subscribe form returns a polite error, dispatchers no-op. Production needs:

| Env var                          | Default          | Notes                                                              |
| -------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `EMAIL_PROVIDER`                 | `disabled`       | `postmark` \| `sendgrid` \| `ses` \| `disabled`                    |
| `POSTMARK_TOKEN`                 | —                | Required when EMAIL_PROVIDER=postmark                              |
| `SENDGRID_API_KEY`               | —                | Required when EMAIL_PROVIDER=sendgrid                              |
| `EMAIL_FROM`                     | —                | Verified sender at the provider, e.g. `alerts@polkadex.ee`         |
| `EMAIL_FROM_NAME`                | `Polkadex Explorer` | Display name in the `From:` header                              |
| `EMAIL_REPLY_TO`                 | —                | Optional `Reply-To` for human replies                              |
| `EMAIL_MIN_INTERVAL_MS`          | `10000`          | Per-recipient cooldown to prevent accidental hammering             |
| `EMAIL_SIGNUP_RATE_LIMIT_PER_HOUR` | `30`           | Per-IP cap on /api/email/subscribe                                 |

**Deliverability setup is mandatory.** Without DKIM + SPF + DMARC records pointing at your transactional provider, most major inbox providers (Gmail, Outlook) will silently route your sends to spam:

1. Verify your sending domain (e.g. `polkadex.ee`) in the Postmark/SendGrid dashboard.
2. Add the DKIM CNAME records they generate to your DNS (Cloudflare → DNS).
3. Add an SPF record (or merge into your existing TXT): `v=spf1 include:spf.mtasv.net ~all` for Postmark, `include:sendgrid.net` for SendGrid.
4. Add a DMARC record: `v=DMARC1; p=none; rua=mailto:dmarc@polkadex.ee` — start with `p=none` for monitoring, tighten later.
5. Send yourself a test from the dashboard; check the resulting email's headers show DKIM=PASS, SPF=PASS.

Schema: subscribers live in `email_subscribers`, dispatch idempotency in `email_dispatches`. Backups (see Operations) include both. Inspect with `sqlite3 data/explorer.db "SELECT email, confirmed_at, source FROM email_subscribers"`.

### Indexer

| Env var                          | Default | Notes                                                              |
| -------------------------------- | ------- | ------------------------------------------------------------------ |
| `BLOCKS_FORWARD_MAX`             | `500`   | Max blocks per forward catch-up tick                               |
| `BLOCKS_BACKFILL_CHUNK`          | `200`   | Blocks per backfill chunk (descending toward genesis)              |
| `BLOCKS_GAP_FILL_CHUNK`          | `100`   | Blocks per gap-fill chunk (repair holes in indexed range)          |
| `BLOCKS_FETCH_CONCURRENCY`       | `8`     | Parallel block fetches per Promise.all batch                       |
| `BLOCKS_MIN_BLOCK`               | `1`     | Genesis-ward stop for backfill                                     |
| `SYNC_BACKOFF_MS`                | `60000` | Skip a sync's next ticks for this long after an error              |
| `NETWORK_INFO_REFRESH_MS`        | `600000`| Background pre-warm cadence for the home-page Network Information  |
| `TOTAL_UNLOCKING_TTL_MS`         | `1800000`| Cadence for the expensive `staking.ledger.entries()` scan         |
| `STAKING_REWARDS_FORWARD_MAX`    | `20000` | Max blocks per forward staking-rewards crawl                       |
| `STAKING_REWARDS_BACKFILL_CHUNK` | `500`   | Blocks per staking-rewards backfill chunk                          |
| `GOV_FORWARD_MAX`                | `50000` | Max blocks per governance crawl                                    |
| `TX_INITIAL_SCAN_BLOCKS`         | `20000` | Initial (RPC) transaction crawl depth; history older than this is derived from the local events table by the automatic backfill (F-008) |
| `TX_BACKFILL_CHUNK`              | `5000`  | Blocks of local events per tick the transactions backfill derives — zero RPC |
| `REORG_SWEEP_MAX`                | `200`   | Newly-finalized heights re-verified per tick against their canonical hash (F-007) |
| `REORG_TAIL_MAX`                 | `64`    | Cap on the unfinalized tail re-checked every tick (F-007) |

### Price feed

| Env var          | Default | Notes                                                                   |
| ---------------- | ------- | ----------------------------------------------------------------------- |
| `CMC_API_KEY`    | *(none)*| CoinMarketCap API key. **Optional** — only needed if you add `cmc` to `PRICE_PROVIDERS`. The default CoinGecko feed is keyless, so the chart works without this. |
| `CMC_SYMBOL`     | `PDEX`  | CMC symbol to query                                                     |

### Sitemap

| Env var                       | Default | Notes                                                  |
| ----------------------------- | ------- | ------------------------------------------------------ |
| `SITEMAP_TOP_VALIDATORS`      | `100`   | How many top-staked validators to include              |
| `SITEMAP_RECENT_BLOCKS`       | `200`   | How many recent blocks to include                      |
| `SITEMAP_TOP_HOLDERS`         | `100`   | How many top holders (account pages) to include        |
| `SITEMAP_CACHE_TTL_MS`        | `300000`| How long the rendered XML is cached                    |

### docker-compose `.env`

A typical `/opt/pdexplorer/.env`:

```dotenv
DOMAIN=explorer.polkadex.ee
LETSENCRYPT_EMAIL=you@example.com
DATA_PATH=/opt/pdexplorer/data
POLKADEX_WS=wss://rpc.polkadex.ee
CMC_API_KEY=your-cmc-key-here
ALLOWED_ORIGINS=https://explorer.polkadex.ee
```

---

## Repository layout

```
pdexplorer/
├── server.js              # Backend: Express API + chain indexers
├── db.js                  # SQLite schema + prepared-statement helpers
├── index.html             # SPA shell (meta, JSON-LD, modals)
├── script.js              # Frontend: routing, rendering, wallet flows
├── styles.css             # Stylesheet
├── public/
│   ├── manifest.webmanifest   # PWA manifest — the ONLY copy (audit F-061)
│   └── og-image.png           # 1200x630 social card
├── nginx.conf             # Reverse proxy: TLS, headers, /api proxy, SPA fallback
├── Dockerfile.backend     # Node 22.11-alpine, runs as `node` (uid 1000)
├── Dockerfile.frontend    # Node 22.11 (build) → nginx:1.27 (runtime)
├── docker-compose.yml     # backend + frontend + certbot services
├── vite.config.js         # Dev server + build config
├── package.json
├── init-letsencrypt.sh    # First-time TLS cert issuance
├── provision-ubuntu.sh    # Fresh-server OS hardening + deploy script
├── deploy.sh              # Earlier multi-distro deploy script
├── SECURITY_AUDIT.md      # Latest security review + remediation list
└── data/                  # Host bind-mount → /app/data inside container
    └── explorer.db        # SQLite index (WAL mode)
```

### Known debt: `script.js` and `server.js` are large (audit F-069)

Recorded rather than fixed, deliberately. `script.js` is ~14.6k lines with ~350
top-level functions; `server.js` is ~9.5k. Both grew between audit rounds
(`script.js` was 13.7k at round 1), and the **trend is the thing to watch** —
the absolute number matters less than whether each pass leaves it larger.

What makes them hard to split is not the length. It is the ~185 module-level
mutable variables in `script.js` (`globalApi`, `councilData`, `latestWallet`,
`pendingReferendumVote`, …) that the page modules share. Function names are
verb-first (`render*`, `fetch*`, `submit*`), not domain-first, so the page
modules are interleaved by line number rather than grouped; there is no
`staking/` or `governance/` cluster to lift out by prefix. Extracting a
*behaviour* module means threading that shared state through parameters, which
is the expensive and regression-prone part — and doing it in the same pass as a
batch of behavioural fixes makes every one of those fixes harder to review and
harder to revert.

So the rule this repo follows is the audit's own: **extract pure helpers behind
tests; do not split the files.** That is what `lib/` is — 25 modules, each one
either a pure function or pure data, each with a test file. `lib/help-topics.js`
(the help centre's 36 articles, ~670 lines) is the largest such extraction and
the model for the next one: it moved because it is data with no reference to
module state, so the move was verifiable by deep-equality against the original
array and could not change behaviour. It also gained tests that were impossible
while it sat in a bundle with no export surface — slug uniqueness, category
validity, and internal `/help/<slug>` links resolving.

Remaining candidates of the same kind, if someone wants the next slice:
`TOUR_SLIDES`, `MOBILE_WALLETS`, `DONATION_ADDRESSES`, `EMAIL_PREF_GROUPS`
(~110 lines total). Left in place for now because four more import lines buy
little; they are worth moving only alongside a test that needs them.

---

## API reference

All endpoints under `/api/*` return JSON. Most are read-only and public; a small subset requires a wallet-signed session token (see "Authenticated" below). The full developer-facing version of this reference is also served at [`/developers`](https://explorer.polkadex.ee/developers).

> **Where this route list lives** (audit F-060 / F-154). There used to be four
> hand-maintained copies. Two of them — `DEVELOPERS_HTML` in `server.js` (what a
> **hard load** of `/developers` serves) and `renderDevelopersPage()` in
> `script.js` (what **in-app navigation** paints, a genuinely different
> document) — went stale, and by the round-2 audit they were missing eight route
> families that this file and `llms.txt` documented: community labels,
> `/api/identity`, `/api/proxies`, `/api/proxy-types`, `/api/multisigs`,
> `/api/analytics/*`, `/api/extrinsic-by-hash`, `/api/version` and
> `/api/health`. An integrator reading the site's own Developers page could not
> see them.
>
> Both `/developers` renderers now build their endpoint lists from **one table**,
> `lib/api-reference.js`. Adding a route means adding one entry there.
> `test/api-reference.test.js` additionally asserts that every path in that
> table appears in this file and in `public/llms.txt`, so the two prose copies
> cannot silently fall behind either — but they are still prose, and their
> surrounding caveats are written by hand.
>
> The Vite dev proxy **does** forward `/developers` to the backend
> (`vite.config.js`), so a hard load under `npm run dev` now shows the same SSR
> copy production serves. That sentence used to say the opposite, and it was
> wrong in the most expensive direction: it told anyone verifying a change to
> `DEVELOPERS_HTML` that they could not see it locally, so they didn't look.
>
> What is still true is the older, larger half of F-060: `/developers` renders
> as **two different documents** depending on how you arrived. Their endpoint
> lists agree — that is what `lib/api-reference.js` bought — but everything
> around those lists does not. The exact inventory, because "they differ" is
> what let this sit through a round:
>
> | | SSR (`DEVELOPERS_HTML`, hard load) | SPA (`renderDevelopersPage()`, in-app) |
> |---|---|---|
> | Section anchors | none — bare `<h2>`s, no `id` | `<section id="chain">…` on every section |
> | Table of contents | none | 18 `href="#…"` links above the content |
> | CORS | one row inside the "Start here" table | its own `<h2>` at `#cors` |
> | Caching tiers | 15th, near the bottom | 3rd, above the endpoint lists |
> | network-info schema | 13th, after Build provenance | 6th, right after Chain inspection |
> | Errors / addresses | one combined "Errors &amp; addresses" `<h2>` | two sections, `#errors` and `#addresses` |
> | Discussions vs Email | Discussions first | Email first |
> | "Found a bug?" | a line in the footer | its own section |
>
> The anchors row is the one with a visible cost: `/developers#governance` is a
> working deep link from inside the app and a no-op on a hard load or a crawl —
> and a hard load is what a search engine, an LLM crawler and a shared link all
> do, so the version with no deep links is the version the outside world gets.
> The ordering rows cost less individually and more collectively: any future
> edit has to be applied twice, in two different positions, in two files, which
> is the mechanism that produced the stale tier table now sitting in **both**
> copies (see *Scaling → Endpoints that must not be shared-cached*, gap 3).
> Closing this means the two renderers emitting the same sections, in the same
> order, with the same wrapper and TOC — a `server.js` + `script.js` change, not
> a docs one. The durable form is to move the scaffolding into
> `lib/api-reference.js` beside the route table, so that "one table, two
> renderers" becomes "one document, two mount points".
>
> The table is curated rather than generated
> from the Express router on purpose: the SPA copy has no access to the router,
> and a generated list would publish operator-only routes (`/api/diag/*`, the
> email token endpoints) the moment one was registered. To see the raw route set
> the server actually has:
>
> ```bash
> grep -nE "^app\.(get|post|put|delete)\('" server.js
> ```

### CORS — who can call the API

The CORS policy in `server.js` allows three caller categories:

| Caller | Why it works |
|---|---|
| **Native mobile apps** (iOS, Android, React Native — anything not running inside a browser) | CORS is a browser-only mechanism; native HTTP clients don't send an `Origin` header, so the server's `if (!origin) allow` branch fires. |
| **Server-side proxies** (your backend calling ours) | Same — no `Origin` header. |
| **Web apps** at origins listed in `ALLOWED_ORIGINS` env var (defaults to `explorer.polkadex.ee` + `localhost:3000`) | Explicitly allowed. |

A web app at a different origin will be blocked by the browser's CORS check until its origin is added to `ALLOWED_ORIGINS`. Native mobile apps need no configuration.

### Caching tiers

Hot endpoints carry `Cache-Control` headers in three tiers — clients (mobile, web, server-side) should respect these and not poll faster than `max-age`:

| Tier | Used by | Header |
|---|---|---|
| **Short** | High-velocity feeds: `/api/blocks`, `/api/transactions`, `/api/events`, `/api/council`, `/api/governance/latest`, `/api/state/*` at the current head | `public, max-age=5, s-maxage=10, stale-while-revalidate=30` |
| **Medium** | `/api/validators`, `/api/network-info`, `/api/holders`, `/api/price-latest`, `/api/staking-rewards-status`, `/api/discussions`, `/api/analytics/*`, `/api/labels/:address` (anonymous only), `/api/consts/*` + `/api/runtime` at head | `public, max-age=30, s-maxage=60, stale-while-revalidate=120` |
| **Long** | `/api/price-history`, `/api/treasury`, `/api/democracy`, `/api/governance/calendar`, `/api/rpc/metadata`, `/api/decode/:block`, `/api/proxy-types`, `GET /api/rpc/call`, and any inspection route pinned to a past block with `?at=` | `public, max-age=300, s-maxage=600, stale-while-revalidate=3600` |

`/sitemap.xml` sets its own `public, max-age=300, s-maxage=300`.

The rest of the API splits into two groups, and audit F-083 is about not
conflating them — the distinction is invisible in a browser and decisive at a
CDN.

**Sends `no-store` explicitly:** `/api/wallet/:address`,
`/api/identity/:address`, `GET /api/labels/:address` *when the caller presents a
session*, `POST /api/rpc/call`, all of `/api/email/*`, `/api/version` and
`/api/health`. These are per-viewer or state-changing; an intermediary that
stored one caller's copy would serve it to the next.

**Sends no `Cache-Control` header at all:** `/api/block/:id`,
`/api/extrinsic/:block/:txHash`, `/api/extrinsic-by-hash/:txHash`,
`/api/validator/:address`, `/api/search/:query`, `/api/account/:address`,
`/api/staking-rewards/:address`, `/api/transactions/older`,
`/api/proxies/:address`, `/api/multisigs/:address`, `/api/discussions/:id`,
every **other** `POST`/`DELETE` route (`POST /api/rpc/call` and the `/api/email/*`
writes are the exceptions — they are in the `no-store` list above), and all of
`/api/diag/*`. These are omissions, not
decisions: their URL space is too large for a CDN to help, so nobody added a
header. **"No header" is not "do not cache."** A Cloudflare "Cache Everything"
rule applies its own default TTL to exactly these responses, so the enforcement
point for this group is the edge configuration described under *Scaling*, not
the origin. Treat the list as "must not be shared-cached" and configure the
edge accordingly.

### Chain data (read-only, public)

- `GET /api/blocks` — most recent blocks
- `GET /api/block/:number` — single-block detail with extrinsics + events
- `GET /api/events` — most recent on-chain events
- `GET /api/transactions` — most recent transactions. **Balance transfers only** — see the note below.
- `GET /api/transactions/older?before=<n>` — pagination further back
- `GET /api/extrinsic/:block/:txHash` — single-extrinsic detail
- `GET /api/extrinsic-by-hash/:txHash` — locate an extrinsic when you don't know its block, by scanning **recent blocks backwards from the head** (`?recent=` blocks, default 200 ≈ 40 min, max 2000 ≈ 6 h). Returns `{ found, block, txHash, scanned }` — a block number to feed to `/api/extrinsic/:block/:txHash`, not the extrinsic itself. `found: false` means "not in the scanned window", not "does not exist".
- `GET /api/validators` — full validator set with stake + commission
- `GET /api/validator/:address` — per-validator era history
- `GET /api/holders` — top-balance accounts
- `GET /api/account/:address` — account-level summary
- `GET /api/network-info` — home-page network metrics
- `GET /api/search/:query` — **live-RPC** block-hash / block-number / account lookup. Does *not* query the SQLite index and does *not* resolve extrinsic hashes — see the note below.
- `GET /api/staking-rewards/:address` — per-address reward history
- `GET /api/staking-rewards-status` — backfill progress
- `GET /api/wallet/:address` — wallet dashboard payload (balances, staking incl. **`activeStakedPlanck`** — the u128 active-stake value as a string for precision-safe full-unbonds — unpaid rewards, recent activity)

> **`/api/transactions` is `balances.Transfer` only** (audit F-051). The indexer
> builds the `transactions` table from `balances.Transfer` events and nothing
> else — see `lib/tx-from-event.js`, where every row is stamped
> `method: 'balances.Transfer'`. `balances.Deposit`, `Withdraw`, `Minted`,
> `Burned`, `DustLost`, treasury payouts, vesting
> releases and OCEX settlement movements are all real balance changes that
> **never appear** in this feed, so summing `/api/transactions` does not
> reconcile an account. Use `/api/events` (the full decoded event stream) or
> `/api/decode/:block` when you need every movement.

> **`/api/search/:query` is a live-RPC probe, not an index search** (audit
> F-086). The handler never touches SQLite. It tries, in order: an all-digits
> query as a block **number**, a 66-char `0x…` as a block **hash**, then the
> query as an **account** via `system.account`. An extrinsic hash therefore
> comes back `404` even when `/api/extrinsic-by-hash/:txHash` could have found
> it in the recent-block window — use that endpoint (or
> `/api/extrinsic/:block/:txHash`) for transactions.
> Because it is RPC-backed it also returns `503` while the node is unreachable.

### Price feed (multi-provider)

- `GET /api/price-latest` — current price, last-sync, plus a **`bySource`** map with one entry per active provider (`coingecko` by default, `cmc` if enabled; historical tags `ascendex`, `ascendex-backfill` and `defillama-backfill` also appear where those rows exist). Each entry: `{ label, configured, lastSync, status, error, latest, count }`.
- `GET /api/price-history?days=N` — daily series for the last N days (capped at 4000). Each row carries a `source` tag identifying which provider supplied it. Response also includes the same `bySource` rollup.

Providers are pluggable via `PRICE_PROVIDERS` env (csv; **default `coingecko`**). CoinGecko is keyless — set `COINGECKO_API_KEY` to a free demo key only if you want higher rate limits — and aggregates PDEX across its real markets rather than a single venue. Add `cmc` (with `CMC_API_KEY`) to poll CoinMarketCap alongside it.

**AscendEX was removed after the exchange shut down in July 2026.** Setting `PRICE_PROVIDERS=ascendex` polls nothing; historical rows tagged `ascendex` / `ascendex-backfill` remain in `price_history` and still render on the chart.

There is no price-history backfill script in the repo (audit F-025 — the README and INSTALL previously pointed at a `backfill-price-history.mjs` that does not exist). Existing historical rows were imported ad-hoc; a fresh install builds its chart from the first live poll onward.

### Chain inspection (polkadot.js-style, read-only)

Generic access to runtime metadata, storage and constants at any block — this is
what makes an on-chain claim independently checkable without polkadot.js Apps.
All of these need the chain RPC, so they answer `503` while it is down, and all
are per-IP rate-limited (`DEV_API_RATE_LIMIT_PER_MIN`, default 60/min).

- `GET /api/rpc/metadata` — every pallet with its storage items (key arity + key types), constants, calls, events, errors
- `GET /api/state/:pallet/:item` — read any storage item. `?args=` keys (repeat or comma-separate for multi-key maps), `?at=` block number or hash, `?entries=1` to page a map's entries
- `GET /api/consts/:pallet/:item` — runtime constants; `?at=` supported
- `GET /api/runtime` — runtime spec/impl version; `?at=` supported
- `GET /api/decode/:block` — every extrinsic in a block decoded argument by argument (name, declared type, human, JSON, raw hex). Filters: `?section=` `?method=` `?index=`
- `GET /api/rpc/call` — the allowlist of permitted read-only RPC methods
- `POST /api/rpc/call` — `{ "method": "…", "params": [ … ] }` against that allowlist

Read-only by construction: only `api.query`, `api.consts` and allowlisted read
RPCs are reachable — no endpoint can submit an extrinsic. `?at=` older than the
node's pruning window needs an archive node.

### Account inspection (RPC-backed)

- `GET /api/identity/:address` — on-chain identity, resolving `identity.superOf` → `identityOf` for sub-accounts. `501` if the runtime has no identity pallet
- `GET /api/proxies/:address` — proxy delegations declared by the address. `501` if no proxy pallet
- `GET /api/proxy-types` — the runtime's `ProxyType` enum variants, read out of the metadata
- `GET /api/multisigs/:address` — pending multisig calls for the address. `501` if no multisig pallet

### Community labels

Crowd-sourced address labels. The read is public; every write requires a
wallet-signed session (`401` without one) — see "Authenticated" below.

- `GET /api/labels/:address` — labels with score, up/down votes, report count, veto flag, plus `topLabel`. When a session is presented the payload also carries the caller's own `viewerVote`, so **only the anonymous response is CDN-cacheable**
- `POST /api/labels/:address` — add/replace the caller's own label for that address
- `DELETE /api/labels/:address` — remove the caller's own label
- `POST /api/labels/:address/:signer/vote` — up/down-vote someone else's label
- `POST /api/labels/:address/:signer/report` — report a label (self-reports rejected)
- `POST /api/labels/:address/:signer/veto` — veto a label on your **own** address (caller must be `:address`)

### Analytics

- `GET /api/analytics/timeseries?days=N` — daily series (N clamped to 1–365). The 7/30/90/365 windows are pre-warmed by the indexer; other windows are aggregated live
- `GET /api/analytics/snapshot` — current KPI rollup (issuance, bonded, validator/nominator counts, indexed row counts)

### Governance

- `GET /api/council` — council members, motions, runners-up
- `GET /api/treasury` — treasury balance, proposals (open + historical)
- `GET /api/democracy` — referenda + public proposals
- `GET /api/governance/latest` — most-recent OPEN referendum / proposal (drives homepage banner; only ongoing events)
- `GET /api/governance/calendar` — unified timeline across referenda + motions + treasury for `/calendar`

### Email alerts (governance + network events)

- `POST /api/email/subscribe` — double opt-in signup (rate-limited per IP)
- `GET /api/email/confirm?token=<t>` — renders a confirmation page with a button. **Read-only.**
- `POST /api/email/confirm` (`token` form field) — performs the confirmation
- `GET /api/email/unsubscribe?token=<t>` — renders an unsubscribe page with a button. **Read-only.**
- `POST /api/email/unsubscribe` (`token` form field) — performs the unsubscribe; also the RFC 8058 `List-Unsubscribe-Post` target

  The writes moved off GET in audit F-001/F-036: mail scanners, link checkers and browser prefetch fetch emailed URLs without a human, which was silently confirming and unsubscribing people.
- `GET /api/email/preferences?token=<t>` — fetch current event preferences
- `POST /api/email/preferences` — update preferences (token in body)

  Both back the **`/email/preferences?token=<t>`** page, linked from the footer of every alert email. The token is the credential (there is no login), so that route is `noindex` and `Disallow`ed in `robots.txt`.

### Discussions

- `GET /api/discussions` — discussion threads attached to governance items
- `GET /api/discussions/:id` — single thread with posts

### Authenticated (wallet sign-in for discussion posts)

Wallet-signed nonce login. Sessions are 192-bit random tokens with a 7-day TTL (audit F-152 — this used to say just "a TTL" while the UI said ~24 hours and the server used 7 days).

- `POST /api/auth/challenge` — request a sign-in nonce
- `POST /api/auth/verify` — submit `{ address, signature }`; the nonce is **not** sent (the server looks up the open challenge for that address). Returns `{ token, expiresIn }`, `expiresIn` in ms
- `POST /api/auth/logout`
- `POST /api/discussions/:id/posts` — post to a discussion (rate-limited, requires session)

### Build provenance + liveness (public, `no-store`)

- `GET /api/version` — `{ component: 'backend', gitSha, builtAt, dirty, startedAt, specVersion, rpcConnected }`. `dirty: true` means the image was built from a tree with uncommitted changes, so the SHA alone does not identify the running code. Node version, pid and raw uptime are deliberately **not** published (audit F-142) — they live on `/api/diag/*`. The frontend publishes its own `{ component, gitSha, builtAt }` as a static `GET /version.json`
- `GET /api/health` — `{ healthy: <bool> }`, true only when the chain RPC is connected

### Diagnostics (operator-facing)

All `/api/diag/*` routes sit behind the same gate (audit F-038): the token in a
**request header**, or a loopback source address when `DIAG_TOKEN` is unset.
They are not part of the public API contract and may change without notice.

```bash
curl -H "Authorization: Bearer $DIAG_TOKEN" https://explorer.polkadex.ee/api/diag/rpc-health
curl -H "X-Diag-Token: $DIAG_TOKEN"         https://explorer.polkadex.ee/api/diag/rpc-health
```

**Audit F-193: `?token=` is refused with 403.** The gate used to accept the
token as a query parameter and `.env.example` taught that form, which meant the
shared secret was simultaneously stored in Cloudflare's request logs, the
uptime vendor's saved URL (and its alert emails), the operator's shell history,
and the Referer of anything the page linked to. F-091 stopped *our* nginx
logging query strings; it could do nothing about the edge, the vendor, or the
browser. An uptime monitor that cannot send a header should watch the public
`GET /api/health` instead — it needs no credential and returns `{ healthy }`
with no URLs, pids, or email fields.

- `GET /api/diag/email` — email transport status
- `GET /api/diag/rpc-cache` — hit/miss stats for the block, block-hash and events-at caches
- `GET /api/diag/rpc-health` — RPC connectivity, peer count, sync flag, head freshness
- `GET /api/diag/subquery-lag` — SubQuery indexer lag in blocks/seconds vs `SUBQUERY_MAX_LAG_BLOCKS`

### Static / SEO

- `GET /sitemap.xml` — dynamically generated, 5-min cache
- `GET /robots.txt`

### Error envelope

Most failures return a 4xx/5xx with `{ "error": "<message>" }`. The `error`
string is a human-readable sentence intended for display; **do not match on
it** — it is reworded freely between releases.

RPC-dependent endpoints surface **503** during chain RPC outages. That one
response carries a stable machine-readable discriminator alongside the prose,
and is also sent `Retry-After: 5` and `Cache-Control: no-store` so an edge cache
cannot pin it:

```json
{
  "error": "Live blockchain data is not available right now — the explorer is still connecting to the Polkadex node. Please refresh in a few seconds.",
  "code": "RPC_NOT_READY"
}
```

Branch on `code === "RPC_NOT_READY"` (or simply on the 503 status) and retry with
backoff — it is not a permanent failure. Audit F-155: this section used to
promise the short string `{ "error": "rpc not connected" }`, which `requireRpc()`
has never sent; clients matching that literal treated every RPC outage as an
unknown error. `RPC_NOT_READY` is currently the only `code` the API emits.

### Address format

All paths that take an `:address` expect Polkadex-format SS58 (prefix 88, addresses start with `e…`). The server normalizes via `toPolkadexAddress()` so wallet-native prefixes (42, 0) usually also resolve, but consistency is recommended.

The full API is served behind `/api/*` and proxied by nginx. The frontend is a single-page app at `/` with clean-URL routes (`/blocks`, `/validator/<address>`, `/wallet/<address>`, etc.) — nginx's `try_files $uri $uri/ /index.html;` makes deep links work.

---

## Indexer behavior

The chain indexer runs continuously and is designed to be **outage-tolerant**:

1. **Forward pass.** Every tick, scan `latestScannedBlock + 1 … head`. Cap per-tick at `BLOCKS_FORWARD_MAX` so a multi-day outage doesn't try to catch up in one burst.
2. **Backfill pass.** Walk one `BLOCKS_BACKFILL_CHUNK` further toward genesis. Independent watermark — survives indexer restarts.
3. **Gap-fill pass.** Query SQLite for ranges of missing block numbers (using a `LEAD()` window function in `db.getBlockGaps`) and re-attempt one chunk per tick. This repairs blocks lost to mid-walk RPC errors.

Per-block fetches run in parallel batches (`BLOCKS_FETCH_CONCURRENCY`); per-block exceptions are caught individually so one bad block doesn't abort the whole range. Errors that escape a sync entry point engage the `SYNC_BACKOFF_MS` circuit breaker, which skips that sync's next ticks while the RPC recovers.

Staking rewards and on-chain governance have their own forward + backfill crawlers following the same pattern.

---

## Wallet & signing model

The explorer is **non-custodial** — it never sees private keys or seed phrases.

When the user clicks Connect Wallet, the explorer enumerates `window.injectedWeb3` (populated by browser extensions or mobile-wallet in-app browsers). Selecting an account stores its Polkadex-prefixed (SS58 88) form in `localStorage`, and that same form is used for display, URL routing and `signAndSend` alike. `isSameAddress` compares by public-key bytes, so any SS58 encoding of the same key reconciles.

> This paragraph used to describe a second, *native-prefixed* address (SS58 42 or 0) "kept in memory for `signAndSend` because that's what the injected signer recognizes". That field existed and nothing ever read it — audit F-117 removed it. Injected extensions (polkadot-js, Talisman, SubWallet, Nova) match accounts by public key, so the prefix-88 form is accepted. If a wallet ever did require its own encoding, signing would be failing today rather than working.

The signing helper (`submitSignedTx`):

1. Looks up the injected account matching the stored address by public-key equality
2. Calls `provider.enable('Polkadex Explorer')` to get the signer
3. Builds the extrinsic (a `balances.transferKeepAlive`, `staking.bondExtra`, `staking.payoutStakers`, etc.) and submits it via `signAndSend`
4. Surfaces the wallet's confirmation dialog to the user
5. Reports `InBlock` / `Finalized` / error states back into the modal

If `window.injectedWeb3` is empty when the user lands on their own dashboard, the action bar is replaced with a "read-only mode" callout plus deep-link buttons to mobile wallets — so the buttons never lead to a confusing "no wallet" error after click.

### ⚠️ `@polkadot/api` 10.13.1 and the manual `CheckMetadataHash` — one change, two files

**Read this before touching `@polkadot/api` in `package.json`.** The exact pin
and a hand-written signed-extension declaration are a single mechanism spread
across three files, and splitting them breaks signing on mainnet.

The Polkadex runtime declares the `CheckMetadataHash` signed extension.
`@polkadot/api` **10.13.1 predates support for it**: it logs
`Unknown signed extensions CheckMetadataHash ... no-effect` and then encodes
*nothing* for it. The runtime still expects a `Mode` byte in the signed extra and
an `Option<[u8;32]>` in the signing payload, so every signed extrinsic decoded
misaligned on-chain and panicked inside
`TaggedTransactionQueue_validate_transaction` — which reached the user as
`wasm 'unreachable' instruction executed`. Every transfer, stake and vote failed.

The fix is to declare the shape by hand, so 10.13.1 encodes `Mode::Disabled (0)`
+ `None` — byte-identical to what a current api sends when metadata-hash
checking is off. That declaration exists at **both** `ApiPromise.create` call
sites, for two different reasons:

| Where | Why it needs the declaration |
| --- | --- |
| `script.js` (frontend, `ApiPromise.create`) | It **signs**. Without it, submitted extrinsics are rejected by the runtime. |
| `server.js` (backend, `connectRpc` → `ApiPromise.create`) | It **decodes**. Without it the Mode byte is skipped when reading a signed extra, and every field after it (era, nonce, tip) is read from the wrong offset — silently wrong output from `/api/decode/:block` and the block indexer. |

The invariant, therefore:

- **`"@polkadot/api": "10.13.1"` is an exact pin, not a floor.** No caret, no
  tilde. A range would let `npm ci` resolve a version that knows the extension
  natively, and a native codec fighting a user-supplied override is undefined
  behaviour. `npm ci` (both Dockerfiles) installs the lockfile verbatim, which
  is the other half of this guarantee.
- **Bumping the api means deleting the `signedExtensions` block in BOTH files,
  in the same commit.** Removing it from one leaves the other's extrinsics
  misencoded; keeping both after the bump is the codec conflict.
- **Verify on-chain, not in the console.** The original bug produced a *warning*,
  not an error, and only failed at runtime validation. After any change here,
  sign one real `balances.transferKeepAlive` on mainnet and confirm it reaches
  `InBlock` — a green console is not evidence.

Audit F-119.

---

## Security

Two notable surfaces, both intentionally minimal:

**Wallet authentication for the discussion board.** Server issues a one-time nonce, user signs `"Polkadex Explorer login: <address> | nonce <nonce>"` with their wallet, server validates with `signatureVerify` from `@polkadot/util-crypto`. Sessions are 192-bit random tokens with a 7-day TTL.

**No code execution paths.** No `eval`, no `child_process`, no file uploads, no path-from-input. Every SQL query is a prepared statement. Discussion content is HTML-escaped at render time.

The full audit including container hardening, CORS, CSP recommendations, and dependency pinning notes is in [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md). The `provision-ubuntu.sh` script applies the OS-level subset of those recommendations automatically.

---

## Operations & maintenance

### Logs

The backend prefixes every log line with an ISO timestamp and a level (`INFO`/`WARN`/`ERROR`):

```bash
docker compose logs -f backend
docker compose logs -f backend | grep ' ERROR '
docker compose logs -f backend | grep '\[chain-index\]'
docker compose logs -f backend | grep '\[RPC\]'
```

The frontend (nginx) emits standard access + error logs.

### Health checks

```bash
curl -s https://explorer.polkadex.ee/api/network-info | head -c 200
curl -s https://explorer.polkadex.ee/api/blocks | head -c 200
docker compose ps
```

If `/api/network-info` returns 502, the backend isn't listening on 3001 — check `docker compose logs backend`. If it returns 200 but with empty/stale data, the RPC connection is down — check `[RPC]` lines.

### Scaling — cluster mode + Cache-Control

The backend uses Node's built-in `cluster` module to spread HTTP traffic across all CPU cores while keeping the chain indexer as a single writer. With Cloudflare in front, the combination raises practical sustained throughput from ~150 req/s (single-process) to several thousand req/s of user-perceived load.

**Topology.** The container's entrypoint runs as the cluster *primary*. It forks N workers (default = CPU count, capped at 8). Exactly one worker is started with `INDEXER_ROLE=on` — that worker runs all the chain sync loops (`syncChainIndex`, `syncStakingRewards`, `syncCouncil`, etc.). SQLite's WAL mode handles multi-process readers natively.

**The indexer worker does NOT serve HTTP when clustered** (audit F-156 — this
paragraph used to say it did). The decision is one line:

```js
const serveHttp = !indexer || WORKERS <= 1;
```

So:

| `WORKERS` | Processes that `app.listen()` | Indexer |
| --- | --- | --- |
| `1` | 1 (the same process) | same process, shares its event loop |
| `N > 1` | **`N − 1`** | a dedicated worker, no HTTP |

Sizing follows from that: `WORKERS=4` on a 4-core box gives you **three** HTTP
workers, not four. Inbound connections are load-balanced across the HTTP workers
by the OS. Keeping the indexer off the listen socket is the point — a heavy
backfill tick can block its event loop for seconds, and when it was also an HTTP
worker the OS kept handing it a share of requests that then stalled.

One consequence to know about: an operator running `WORKERS=1` for cleaner logs
is running a materially different topology, where indexer stalls *are* visible
as request latency.

**Crash recovery.** If any worker exits, the primary forks a replacement. If the *indexer* worker died, the replacement inherits the indexer role automatically so chain indexing resumes within a couple of seconds. Crashes are logged with `[cluster]` prefix to make this visible: `[cluster] worker N (pid …) exited (code=…, signal=…, was-indexer=true) — restarting`.

**Tuning.** Set the `WORKERS` env var to override the default:

| `WORKERS` value | Effect |
| --- | --- |
| unset | `min(cpus().length, WORKERS_MAX)` — sensible default |
| `1` | No clustering, single process (legacy behavior, useful for local dev) |
| `N` | Fork exactly N workers, clamped to ≤ `WORKERS_MAX` |
| `WORKERS_MAX` | Default `8`. The ceiling the two rows above clamp against |

For a 4-core VPS the default forks 4 workers — one indexer plus **three**
serving HTTP; for an 8-core box, 8 workers and seven HTTP servers. All four (or
eight) cores are busy, but only `N − 1` of them are answering requests: the
indexer's core is spent on chain sync. That distinction is audit F-156, and it
is the one that matters when you are sizing against a req/s target rather than
against a core count. For local development on a laptop, set `WORKERS=1` to
disable clustering and get cleaner logs — accepting that you are then testing a
topology where indexer stalls show up as request latency.

> **Audit F-191.** This table used to say "clamped to ≤16" while `server.js`
> clamps with `Math.min(n, WORKERS_MAX)` and `WORKERS_MAX` defaults to **8**.
> Setting `WORKERS=16` on a 16-core box therefore produced eight workers —
> half what was asked for, with nothing in the logs saying so, because the
> clamp is deliberately silent. Raise `WORKERS_MAX` explicitly if you want more
> than eight; keeping the ceiling as a named knob rather than a number in prose
> is what stops the docs and the code drifting apart again.

**Cache-Control tiers.** Read-only `/api` endpoints set `Cache-Control` headers so Cloudflare absorbs the bulk of read traffic — the origin only sees about one request per endpoint per `s-maxage` window regardless of how many users are hitting the site. The three tiers map onto how fast the underlying data changes:

| Tier | Headers | Endpoints |
| --- | --- | --- |
| `cacheShort` | `max-age=5, s-maxage=10, stale-while-revalidate=30` | `/api/blocks`, `/api/events`, `/api/transactions`, `/api/council`, `/api/governance/latest`, `/api/state/*` |
| `cacheMedium` | `max-age=30, s-maxage=60, stale-while-revalidate=120` | `/api/network-info`, `/api/validators`, `/api/holders`, `/api/price-latest`, `/api/discussions`, `/api/staking-rewards-status`, `/api/analytics/*`, `GET /api/labels/:address` (anonymous callers only) |
| `cacheLong` | `max-age=300, s-maxage=600, stale-while-revalidate=3600` | `/api/treasury`, `/api/democracy`, `/api/price-history`, `/api/governance/calendar`, `/api/rpc/metadata`, `/api/decode/:block`, `/api/proxy-types`, `GET /api/rpc/call`, and inspection routes pinned to a past block with `?at=` |

> **Audit F-083.** `/api/council` was listed here as `cacheLong` long after the
> handler was moved to `cacheShort`. That direction of drift is the dangerous
> one: the table is what an operator reads when writing a Cloudflare rule, so
> the docs were inviting a 10-minute edge TTL onto a list of live council
> motions where a fresh vote could hide for the whole window. The tier lists in
> *API reference → Caching tiers* above and this table are the same facts
> written twice; if you change a handler, change both.

The `stale-while-revalidate` clause means users never block on a cache refresh — Cloudflare serves the stale copy instantly and asynchronously fetches a fresh one. Caches are only set on 200-success responses; errors are never cached so a transient 5xx can't get pinned at the edge.

**Endpoints that must not be shared-cached.** These are either per-viewer,
mutation-bearing, or have a URL space large enough that CDN caching wouldn't
help:

- `/api/account/:address`, `/api/wallet/:address`, `/api/staking-rewards/:address`
- `/api/search/:query`, `/api/block/:id`, `/api/extrinsic/*`, `/api/validator/:address`
- `/api/extrinsic-by-hash/:txHash` — **listed separately on purpose.** A rule written as `/api/extrinsic/*` does not match it: the path is `extrinsic-by-hash`, not a child of `extrinsic/`. It is also the single most expensive route we have (it scans up to 2000 blocks backwards from the head per call), so an edge rule that silently misses it is the one omission on this list that costs RPC budget as well as freshness
- `/api/transactions/older`, `/api/proxies/:address`, `/api/multisigs/:address`, `/api/discussions/:id` — per-address or cursor-keyed, and all four send no `Cache-Control` at all
- every `/api/labels/*` route — the GET's payload contains the *caller's own* `viewerVote`, so caching one user's response would show their vote to everyone
- everything under `/api/auth/*`, `/api/email/*`, `/api/discussions/*/posts`, plus `POST /api/rpc/call`
- `/api/version`, `/api/health`, `/api/identity/:address`, and all of `/api/diag/*`

Audit F-083 — **what this list is, and the two ways it lies.** It is the
*policy*: endpoints that must never be served out of a shared cache. It is not a
description of the response headers, and the gap between the two is the finding.

The list originally omitted `/api/wallet/:address` and the label routes
outright. Both are now in it, and `/api/wallet/:address` and
`GET /api/identity/:address` send a real `no-store`; `GET /api/labels/:address`
sends `no-store` whenever a session is present. Those three are enforced at the
origin and need nothing from the edge.

Round 2 found the same defect a size smaller, and it is worth naming because it
is the shape this finding keeps coming back in. The list was checked against the
*dangerous* routes and stopped there, so five more that send no header —
`/api/extrinsic-by-hash/:txHash`, `/api/transactions/older`,
`/api/proxies/:address`, `/api/multisigs/:address`, `/api/discussions/:id` — were
still missing from it, and `POST /api/rpc/call` was missing too. An operator
writing Cloudflare rules from this list would have left all six cacheable. The
`extrinsic-by-hash` omission was the expensive one: it looks like it is already
covered by the `/api/extrinsic/*` line above it, and it is not, because the two
paths are siblings rather than parent and child. A glob that reads as complete
and matches nothing is worse than a missing line, which is why it now has its own
bullet saying so.

Three gaps remain, and none of them is fixable in this file:

1. **Anonymous `GET /api/labels/:address` still sends `cacheMedium`, with no
   `Vary: Authorization`.** The response body differs by caller (`viewerVote`),
   and the only thing distinguishing the two shapes is a request header the
   cache is not told to key on. A shared cache is therefore permitted to store
   the anonymous copy and hand it to a signed-in caller — or, if it ever caches
   the authenticated one first, to hand one user's vote state to everybody. The
   `no-store` branch protects the response it is on; `Vary` is what protects the
   *other* branch from being substituted for it.
2. **Most of the list sends no header at all** — see *API reference → Caching
   tiers* for the exact membership. A CDN configured with "Cache Everything"
   applies its own default TTL to a response with no `Cache-Control`, so silence
   is not a refusal.
3. **The three copies of the tier table that are not in this file still
   disagree with the handlers.** `public/llms.txt` says everything outside the
   three tiers "sends NO Cache-Control header", and names `/api/wallet/:address`,
   `/api/version` and `/api/health` as examples — all three send a real
   `no-store` now, so it understates the origin. The two `/developers`
   renderers are wrong in the other, worse direction: both put the **wallet
   dashboard** in the medium tier, and both put `/api/staking-rewards/:addr` and
   `/api/holders` in the long tier, when the wallet route is `no-store`, the
   per-address rewards route sends nothing, and holders is medium. `/developers`
   is the page an integrator actually reads, and it is currently telling them
   they may cache a per-account balance payload for 30 seconds. Fixing those
   three means editing `public/llms.txt`, `DEVELOPERS_HTML` in `server.js` and
   `renderDevelopersPage()` in `script.js` — or, better, moving the tier table
   into `lib/api-reference.js` next to the route table, which is where the same
   class of drift was already solved once (F-154).

Until all three are closed, the Cloudflare rules in "Configuring
Cloudflare" below are the actual enforcement point for this list, not the
origin. Write them from this list, not from the headers.

**Configuring Cloudflare to honor the headers.** Default Cloudflare settings already respect `s-maxage`. If you've enabled "Cache Everything" page rules, make sure they don't override the headers; the per-endpoint headers above are stricter than Cloudflare's auto-cache defaults for HTML and will give you better behavior. Confirm with `curl -sI https://explorer.polkadex.ee/api/network-info` — look for `cf-cache-status: HIT` on the second request.

**Throughput estimates** for a 4-core 16 GB VPS with the cluster + cache combo:

- Origin sustained: ~400–600 req/s mixed traffic (vs ~150 req/s pre-cluster).
- User-perceived (origin + Cloudflare hits): ~3,000–5,000 req/s for cacheable endpoints.
- Concurrent active users: easily 5,000+ before noticeable degradation.

The next bottleneck after this is the indexer worker's event loop during heavy backfill windows; if you push further, run the indexer as a separate sidecar container so HTTP workers never see its CPU.

### Backups

The provision script installs a nightly SQLite backup pipeline as the `backup` phase, which runs as part of the default `all` flow. Once provisioned, no further setup is needed.

**What's installed:**

- `/opt/pdexplorer/backup.sh` — the actual backup script. WAL-safe, but note the method: it uses **`VACUUM INTO`**, *not* SQLite's `.backup` online-backup API (audit F-095 — this line used to say the latter). `.backup` restarts the copy from scratch every time another connection writes the source, and the indexer writes every ~12s, so on a multi-GB DB it thrashed and never finished. `VACUUM INTO` reads one consistent snapshot while writers proceed, and emits a compacted single file with no `-wal`/`-shm` to ship. It runs with `.timeout 60000` (override `BUSY_TIMEOUT_MS`) plus one retry, because the sqlite3 CLI's default busy timeout is zero and would otherwise lose the race against the indexer.
- `/etc/cron.d/pdexplorer-backup` — invokes it nightly at 03:00 UTC as root
- `/etc/logrotate.d/pdexplorer-backup` — weekly rotation of the backup log, 8 weeks retained
- `/var/backup/` — destination dir, mode 0750

Backups deliberately live **outside** `/opt/pdexplorer`, so they are not in the
Docker build context, not in the repo, and not removed by a stray
`git clean -fdx` or `docker compose down -v`. Older revisions of this project
used `/opt/pdexplorer/backups/`; the provision script migrates anything found
there and that path no longer receives new snapshots.

**Schedule and retention** (defaults; each is an env override on `backup.sh`):

- Cron fires at 03:00 UTC nightly, but `MIN_INTERVAL_HOURS=48` throttles it to
  one snapshot every other day. **A run skipped by the throttle is normal** —
  check the log rather than concluding backups are broken.
- Output: `/var/backup/explorer-YYYYMMDDTHHMMSSZ.db.gz`
- Retention is **count-based, not age-based**: `MAX_BACKUPS=7` keeps the newest
  7 generations. (There is no `KEEP_DAYS`.) The DB is a derived index of chain
  state, so backups exist to restore fast, not to hold deep history.
- Compressed with `COMPRESS=gzip` at `COMPRESS_LEVEL=6` — `pigz` is used when
  present, so this is parallel. `COMPRESS=zstd` (also `-T0`) or `none` work too.
- A flock-based lockfile (`/var/lock/pdexplorer-backup.lock`) prevents overlapping runs
- Every snapshot is integrity-checked before rotation; failures are kept with a `.CORRUPT` suffix and old backups are NOT pruned
- Off-box shipping is built in: set `REMOTE_ENABLED=1` with `REMOTE_HOST` /
  `REMOTE_USER` / `SSH_KEY`, and `REMOTE_MAX_BACKUPS` (default 14) applies there

**Manual run:**

```bash
sudo /opt/pdexplorer/backup.sh                        # one-shot, uses defaults
sudo FORCE=1 /opt/pdexplorer/backup.sh                # ignore the 48h throttle
sudo DEST=/mnt/external MAX_BACKUPS=30 /opt/pdexplorer/backup.sh
```

**Inspect what's there:**

```bash
ls -lh /var/backup/
tail -n 50 /var/log/pdexplorer-backup.log
```

**Restore from a backup** (with the stack stopped so nothing is mid-write):

```bash
docker compose -f /opt/pdexplorer/docker-compose.yml down
gunzip -c /var/backup/explorer-YYYYMMDDTHHMMSSZ.db.gz \
    > /opt/pdexplorer/data/explorer.db
# Wipe any leftover WAL/SHM from the previous run — the gunzipped DB is a
# fully checkpointed snapshot, so these are stale and could corrupt the
# restored database if SQLite tries to replay them.
rm -f /opt/pdexplorer/data/explorer.db-wal /opt/pdexplorer/data/explorer.db-shm
chown -R 1000:1000 /opt/pdexplorer/data
docker compose -f /opt/pdexplorer/docker-compose.yml up -d backend
docker compose logs -f backend         # confirm the indexer picks up from the snapshot
```

**Off-host shipping (recommended).** The cron job only protects against accidental corruption / bad migrations, not against losing the host itself. `backup.sh` can push snapshots itself — set `REMOTE_ENABLED=1`, `REMOTE_HOST`, `REMOTE_USER`, `REMOTE_PATH`, and `SSH_KEY` (default `/root/.ssh/pdex_backup_ed25519`, no passphrase). Or use an external tool against `/var/backup`:

```bash
# rclone to S3 / B2 / GDrive / etc — daily sync after the backup runs:
30 3 * * * root rclone copy /var/backup remote:pdexplorer-backups --max-age 24h

# restic to any backend with deduplication + encryption:
30 3 * * * root RESTIC_PASSWORD_FILE=/root/.restic-pw \
  restic -r s3:s3.amazonaws.com/my-bucket/pdexplorer backup /var/backup
```

**Disaster-recovery story.** Because the explorer is reconstructable from chain state, a "lost everything including the off-host backup" failure is not a data-loss event — it's a downtime event. Bring up a fresh provisioned host with no `explorer.db`; the indexer starts re-indexing from genesis. Full backfill takes around 8–12 hours on a typical VPS with the current settings; serve traffic from a status page in the meantime, or restore a stale backup and let the gap-filler catch up.

**SQLite tuning at 5 GB.** `db.js` sets `cache_size=-65536` (64 MB), `mmap_size=256 MB`, `synchronous=NORMAL`, `temp_store=MEMORY`, and `wal_autocheckpoint=1000` on startup. These keep query latencies low as the DB grows — most "SQLite is slow" stories at multi-GB scale come from leaving the defaults in place. If you're seeing slow specific queries, the next thing to check is the planner output (`EXPLAIN QUERY PLAN <query>`) — a `SCAN TABLE` over a multi-million-row table means an index is missing, not that SQLite is the wrong tool.

### Watching the indexer

```bash
# Backfill + gap-fill progress:
docker compose logs -f backend | grep '\[chain-index\]'
# Coverage from inside the DB:
docker compose exec backend sqlite3 /app/data/explorer.db \
  "SELECT MIN(number), MAX(number), COUNT(*) FROM blocks;"
```

---

## Tech stack

- **Runtime**: Node.js 22 LTS (built-in `node:sqlite`)
- **Backend**: Express 5
- **Frontend**: Vanilla JavaScript SPA + History API routing, no framework
- **Build**: Vite 6
- **Database**: SQLite (WAL mode) via Node's experimental built-in
- **Chain access**: `@polkadot/api`, `@polkadot/util-crypto`
- **Reverse proxy**: nginx 1.27
- **TLS**: Let's Encrypt via certbot
- **Containers**: Docker Compose

---

## Contributing

PRs welcome. Local dev:

```bash
git clone <repo-url>
cd pdexplorer
npm install
node --experimental-sqlite server.js   # terminal 1
npm run dev                            # terminal 2
```

The frontend has no build step in dev — Vite serves `script.js` directly with HMR. The backend writes to `./data/explorer.db` (created on first run).

Before submitting:

- `node --check server.js && node --check db.js` — no syntax errors
- `npm run build` — frontend builds cleanly
- If you touch the indexer, prefer extending the existing forward / backfill / gap-fill pattern in `syncChainIndex` rather than adding a separate crawler

---

## License

[MIT](./LICENSE) — though check the file before assuming.

---

## Acknowledgements

Built on top of the Polkadex Mainnet ([polkadex.ee](https://polkadex.ee)) and the [Polkadot.js](https://polkadot.js.org) toolchain. Inspired by [Subscan](https://polkadex.subscan.io) and [Polkascan](https://polkascan.io).
