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
- PWA manifest with home-screen shortcuts

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

# Terminal 2 — frontend with HMR (Vite dev server on :3000, proxies /api to :3001)
npm run dev
```

Open http://localhost:3000.

### Production (single command, fresh Ubuntu 24.04 LTS VPS)

```bash
sudo bash provision-ubuntu.sh
```

That script hardens the OS (UFW, fail2ban, key-only SSH, persistent journals, watchdog, fstab `nofail`, hardened sysctl), installs Docker, clones the repo, issues a Let's Encrypt cert, and starts the stack. Idempotent — safe to re-run. See [Deployment](#deployment) below for the details and prerequisites.

---

## Deployment

### Fresh server (recommended)

The `provision-ubuntu.sh` script targets Ubuntu 22.04 / 24.04 LTS and does the OS hardening + Docker install + app deploy in three idempotent phases.

**Before running**, on the fresh VPS:

1. Put your SSH public key in `/root/.ssh/authorized_keys`. The script disables password SSH; without a key already in place you'll lock yourself out.
2. Point the DNS A record for your domain at the VPS's public IP. Let's Encrypt's HTTP-01 challenge needs this to issue the cert.
3. Edit the constants at the top of `provision-ubuntu.sh` if your domain / repo URL / email differ from the defaults, or pass them in via env:

```bash
sudo DOMAIN=explorer.polkadex.ee \
     LETSENCRYPT_EMAIL=you@example.com \
     REPO_URL=https://github.com/you/pdexplorer.git \
     bash provision-ubuntu.sh
```

You can run just one phase at a time:

```bash
sudo bash provision-ubuntu.sh harden       # OS hardening only
sudo bash provision-ubuntu.sh docker       # Docker install only
sudo bash provision-ubuntu.sh app          # Clone + build + deploy only
sudo bash provision-ubuntu.sh cloudflare   # Restrict 80/443 to Cloudflare IPs
sudo bash provision-ubuntu.sh all+cf       # All phases including cloudflare
```

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

1. **Temporarily grey-cloud during cert issuance/renewal** (simplest). Toggle the DNS record to "DNS only" in the CF dashboard, run certbot, toggle back. Annoying for automated renewal.
2. **Use DNS-01 challenge with the Cloudflare API plugin** (recommended for production). Generate a scoped CF API token (`Zone:DNS:Edit` on the explorer zone), then issue certs with:
   ```bash
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
   Renewal then runs unattended with the proxy on.
3. **Page Rule bypass for `/.well-known/acme-challenge/*`** — fragile, breaks if you change rules. Not recommended.

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
| `DATA_DIR`           | `./data`                      | SQLite directory (host bind-mount → container `/app/data`)    |
| `SITE_URL`           | `https://explorer.polkadex.ee`| Used in sitemap.xml and robots.txt                            |
| `ALLOWED_ORIGINS`    | `https://explorer.polkadex.ee,http://localhost:3000` | Comma-separated CORS allowlist          |

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
│   ├── manifest.webmanifest   # PWA manifest
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

---

## API reference

All endpoints under `/api/*` return JSON. Most are read-only and public; a small subset requires a wallet-signed session token (see "Authenticated" below). The full developer-facing version of this reference is also served at [`/developers`](https://explorer.polkadex.ee/developers).

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
| **Short** | High-velocity feeds (`/api/blocks`, `/api/transactions`, `/api/events`) | `public, max-age=5, s-maxage=10, stale-while-revalidate=30` |
| **Medium** | Wallet dashboard, validators, network info, price-latest | `public, max-age=30, s-maxage=60, stale-while-revalidate=300` |
| **Long** | Historical (`/api/price-history`, `/api/staking-rewards/:addr`, holders, sitemap) | `public, max-age=300, s-maxage=600, stale-while-revalidate=3600` |

### Chain data (read-only, public)

- `GET /api/blocks` — most recent blocks
- `GET /api/block/:number` — single-block detail with extrinsics + events
- `GET /api/events` — most recent on-chain events
- `GET /api/transactions` — most recent transactions
- `GET /api/transactions/older?before=<n>` — pagination further back
- `GET /api/extrinsic/:block/:txHash` — single-extrinsic detail
- `GET /api/validators` — full validator set with stake + commission
- `GET /api/validator/:address` — per-validator era history
- `GET /api/holders` — top-balance accounts
- `GET /api/account/:address` — account-level summary
- `GET /api/network-info` — home-page network metrics
- `GET /api/search/:query` — block / extrinsic / account lookup
- `GET /api/staking-rewards/:address` — per-address reward history
- `GET /api/staking-rewards-status` — backfill progress
- `GET /api/wallet/:address` — wallet dashboard payload (balances, staking incl. **`activeStakedPlanck`** — the u128 active-stake value as a string for precision-safe full-unbonds — unpaid rewards, recent activity)

### Price feed (multi-provider)

- `GET /api/price-latest` — current price, last-sync, plus a **`bySource`** map with one entry per active provider (`coingecko` by default, `cmc` if enabled; historical tags `ascendex`, `ascendex-backfill` and `defillama-backfill` also appear where those rows exist). Each entry: `{ label, configured, lastSync, status, error, latest, count }`.
- `GET /api/price-history?days=N` — daily series for the last N days (capped at 4000). Each row carries a `source` tag identifying which provider supplied it. Response also includes the same `bySource` rollup.

Providers are pluggable via `PRICE_PROVIDERS` env (csv; **default `coingecko`**). CoinGecko is keyless — set `COINGECKO_API_KEY` to a free demo key only if you want higher rate limits — and aggregates PDEX across its real markets rather than a single venue. Add `cmc` (with `CMC_API_KEY`) to poll CoinMarketCap alongside it.

**AscendEX was removed after the exchange shut down in July 2026.** Setting `PRICE_PROVIDERS=ascendex` polls nothing; historical rows tagged `ascendex` / `ascendex-backfill` remain in `price_history` and still render on the chart.

There is no price-history backfill script in the repo (audit F-025 — the README and INSTALL previously pointed at a `backfill-price-history.mjs` that does not exist). Existing historical rows were imported ad-hoc; a fresh install builds its chart from the first live poll onward.

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

Wallet-signed nonce login. Sessions are 192-bit random tokens with a TTL.

- `POST /api/auth/challenge` — request a sign-in nonce
- `POST /api/auth/verify` — submit `{ address, signature, nonce }`, receive a session token
- `POST /api/auth/logout`
- `POST /api/discussions/:id/posts` — post to a discussion (rate-limited, requires session)

### Diagnostics (operator-facing)

- `GET /api/diag/email` — email transport status

### Static / SEO

- `GET /sitemap.xml` — dynamically generated, 5-min cache
- `GET /robots.txt`

### Error envelope

Most failures return a 4xx/5xx with `{ "error": "<message>" }`. RPC-dependent endpoints surface **503** with `{ "error": "rpc not connected" }` during chain RPC outages — treat 503 as "retry with backoff," not a permanent failure.

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

When the user clicks Connect Wallet, the explorer enumerates `window.injectedWeb3` (populated by browser extensions or mobile-wallet in-app browsers). Selecting an account stores its Polkadex-prefixed (SS58 88) form in `localStorage` for display + URL routing; the wallet's *native-prefixed* form (often SS58 42 or 0) is kept in memory for `signAndSend` because that's what the injected signer recognizes. `isSameAddress` compares by public-key bytes so the two forms reconcile.

The signing helper (`submitSignedTx`):

1. Looks up the injected account matching the stored address by public-key equality
2. Calls `provider.enable('Polkadex Explorer')` to get the signer
3. Builds the extrinsic (a `balances.transferKeepAlive`, `staking.bondExtra`, `staking.payoutStakers`, etc.) and submits it via `signAndSend`
4. Surfaces the wallet's confirmation dialog to the user
5. Reports `InBlock` / `Finalized` / error states back into the modal

If `window.injectedWeb3` is empty when the user lands on their own dashboard, the action bar is replaced with a "read-only mode" callout plus deep-link buttons to mobile wallets — so the buttons never lead to a confusing "no wallet" error after click.

---

## Security

Two notable surfaces, both intentionally minimal:

**Wallet authentication for the discussion board.** Server issues a one-time nonce, user signs `"Polkadex Explorer login: <address> | nonce <nonce>"` with their wallet, server validates with `signatureVerify` from `@polkadot/util-crypto`. Sessions are 192-bit random tokens with a TTL.

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

**Topology.** The container's entrypoint runs as the cluster *primary*. It forks N workers (default = CPU count, capped at 8). Exactly one worker is started with `INDEXER_ROLE=on` — that worker handles HTTP *and* runs all the chain sync loops (`syncChainIndex`, `syncStakingRewards`, `syncCouncil`, etc.). The other workers serve HTTP only. Inbound connections are load-balanced across all workers by the OS, so all cores actively serve requests. SQLite's WAL mode handles multi-process readers natively; the single-writer invariant is preserved because only the indexer worker mutates the database.

**Crash recovery.** If any worker exits, the primary forks a replacement. If the *indexer* worker died, the replacement inherits the indexer role automatically so chain indexing resumes within a couple of seconds. Crashes are logged with `[cluster]` prefix to make this visible: `[cluster] worker N (pid …) exited (code=…, signal=…, was-indexer=true) — restarting`.

**Tuning.** Set the `WORKERS` env var to override the default:

| `WORKERS` value | Effect |
| --- | --- |
| unset | `min(cpus().length, 8)` — sensible default |
| `1` | No clustering, single process (legacy behavior, useful for local dev) |
| `N` | Fork exactly N workers, clamped to ≤16 |

For a 4-core VPS, the default forks 4 workers and uses all four cores. For an 8-core box, 8. For local development on a laptop, set `WORKERS=1` to disable clustering and get cleaner logs.

**Cache-Control tiers.** Read-only `/api` endpoints set `Cache-Control` headers so Cloudflare absorbs the bulk of read traffic — the origin only sees about one request per endpoint per `s-maxage` window regardless of how many users are hitting the site. The three tiers map onto how fast the underlying data changes:

| Tier | Headers | Endpoints |
| --- | --- | --- |
| `cacheShort` | `max-age=5, s-maxage=10, stale-while-revalidate=30` | `/api/blocks`, `/api/events`, `/api/transactions` |
| `cacheMedium` | `max-age=30, s-maxage=60, stale-while-revalidate=120` | `/api/network-info`, `/api/validators`, `/api/holders`, `/api/price-latest`, `/api/discussions`, `/api/staking-rewards-status` |
| `cacheLong` | `max-age=300, s-maxage=600, stale-while-revalidate=3600` | `/api/council`, `/api/treasury`, `/api/democracy`, `/api/price-history` |

The `stale-while-revalidate` clause means users never block on a cache refresh — Cloudflare serves the stale copy instantly and asynchronously fetches a fresh one. Caches are only set on 200-success responses; errors are never cached so a transient 5xx can't get pinned at the edge.

**Per-user endpoints are NOT cached.** `/api/account/:address`, `/api/staking-rewards/:address`, `/api/block/:id`, `/api/search/:query`, and everything under `/api/auth/*` and `/api/discussions/*/posts` deliberately have no cache headers. They're either per-user, mutation-bearing, or have a URL space large enough that CDN caching wouldn't help.

**Configuring Cloudflare to honor the headers.** Default Cloudflare settings already respect `s-maxage`. If you've enabled "Cache Everything" page rules, make sure they don't override the headers; the per-endpoint headers above are stricter than Cloudflare's auto-cache defaults for HTML and will give you better behavior. Confirm with `curl -sI https://explorer.polkadex.ee/api/network-info` — look for `cf-cache-status: HIT` on the second request.

**Throughput estimates** for a 4-core 16 GB VPS with the cluster + cache combo:

- Origin sustained: ~400–600 req/s mixed traffic (vs ~150 req/s pre-cluster).
- User-perceived (origin + Cloudflare hits): ~3,000–5,000 req/s for cacheable endpoints.
- Concurrent active users: easily 5,000+ before noticeable degradation.

The next bottleneck after this is the indexer worker's event loop during heavy backfill windows; if you push further, run the indexer as a separate sidecar container so HTTP workers never see its CPU.

### Backups

The provision script installs a nightly SQLite backup pipeline as the `backup` phase, which runs as part of the default `all` flow. Once provisioned, no further setup is needed.

**What's installed:**

- `/opt/pdexplorer/backup.sh` — the actual backup script (uses SQLite's online backup API, WAL-safe)
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
