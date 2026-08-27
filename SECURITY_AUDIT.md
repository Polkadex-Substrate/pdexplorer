# Security Audit — Polkadex Explorer

**Scope.** A targeted review of the application code (`server.js`, `db.js`, `script.js`, `index.html`), container configuration (`Dockerfile.backend`, `Dockerfile.frontend`, `docker-compose.yml`), reverse-proxy config (`nginx.conf`), and dependency manifest (`package.json`) — performed in response to the Perfctl rootkit infection identified by InterServer support on the production host. Goal: identify entry vectors that could have allowed the malware in, and harden everything before redeploying to a fresh server.

## Executive summary

**The application itself is unlikely to have been the entry vector.** A careful walk through the request handlers shows no command-execution surface, no file-upload/path-traversal surface, no SQL-injection surface (every query uses prepared statements), and no eval/spawn/exec anywhere. Discussion content — the only piece of user-supplied text the app stores and re-serves — is HTML-escaped before insertion (`stakingEscapeHtml(p.content)` at `script.js:4000`). The wallet auth flow uses nonce-bound signature verification with a TTL.

**The most likely entry vector was OS-level**, outside this repository's control: weak/exposed SSH, an unpatched CVE in a system package (Polkit `pkexec` CVE-2021-4034 is the classic Perfctl vector on RHEL/Alma installs), or another exposed service on the same host. The `provision-ubuntu.sh` script eliminates these by default on the fresh server.

That said, the audit found several issues worth fixing before redeploying. The high-severity items are container hardening and dependency pinning — both of which materially reduce blast radius if a future compromise occurs.

Severity legend:

- **CRITICAL** — immediately exploitable, fix before redeploy
- **HIGH** — significant risk reduction, fix in the same change set as the redeploy
- **MEDIUM** — defense in depth, schedule before the next release
- **LOW / INFO** — recommended hygiene

---

## Findings

### CRITICAL — none

No critical issues found in the application or container surface.

### HIGH H-1 — Containers run as root

**Evidence.** Neither Dockerfile drops privileges:

```dockerfile
# Dockerfile.backend (current)
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js db.js ./
EXPOSE 3001
CMD ["node", "--experimental-sqlite", "server.js"]
```

The Node process runs as PID 1 with `uid=0` inside the container. Same applies to nginx in `Dockerfile.frontend`.

**Risk.** A container escape (rare but historically present in Docker, runc, and the Linux kernel) lands as root on the host. Bind mounts (`./data`, `./certbot/conf`) are also writable as root from inside the container.

**Fix.** Add a `USER` directive after the `COPY`s, and `chown` the workdir. For the bind-mounted `./data` on the host, give it `uid=1000` so the non-root container can write:

```dockerfile
# Dockerfile.backend (fixed)
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && chown -R node:node /app
COPY --chown=node:node server.js db.js ./
USER node
EXPOSE 3001
CMD ["node", "--experimental-sqlite", "server.js"]
```

On the host (the new provision script does this automatically):

```bash
install -d -m 0750 -o 1000 -g 1000 /opt/pdexplorer/data
```

### HIGH H-2 — Dependencies pinned to `"latest"`

**Evidence.** `package.json`:

```json
"@polkadot/api": "latest"
```

**Risk.** Supply-chain attack: if the npm account for `@polkadot/api` is compromised (account hijack, expired maintainer token, malicious co-maintainer), the next image build pulls and runs the attacker's code as part of your backend. Several major npm-supply-chain incidents in the last two years (event-stream, ua-parser-js, colors.js, faker.js) follow this exact pattern.

**Fix.** Pin to specific versions and commit `package-lock.json`, then build with `npm ci` (which fails the build if lockfile and package.json drift). Recommended `package.json` patch:

```json
{
  "scripts": {
    "build": "vite build",
    "start": "node --experimental-sqlite server.js"
  },
  "dependencies": {
    "@polkadot/api": "16.4.7",
    "cors": "2.8.5",
    "express": "5.2.1"
  },
  "devDependencies": {
    "vite": "6.4.2"
  }
}
```

And in `Dockerfile.backend`:

```dockerfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
```

Re-run `npm install` once locally to refresh `package-lock.json`, commit it, then rebuild.

### HIGH H-3 — `Dockerfile.frontend` builds on EOL Node 18

**Evidence.**

```dockerfile
FROM node:18-alpine AS build
```

Node.js 18 went end-of-life in April 2025 — no further security patches.

**Risk.** Known CVEs in the Node runtime that built your frontend artifacts. While the runtime stage is `nginx:alpine` (so the EOL Node isn't *running* in production), the build itself is unpatched — supply-chain risk if a vulnerability in Node 18's npm allows tampered packages to be installed silently.

**Fix.** Bump both stages to a pinned `node:22-alpine` (matches backend). Update `Dockerfile.frontend`:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

Pin `nginx:1.27-alpine` (or whatever current minor) for reproducibility — `nginx:alpine` floats and breaks reproducible builds.

### MEDIUM M-1 — CORS open to all origins

**Evidence.** `server.js:33`:

```js
app.use(cors());
```

Default CORS responds with `Access-Control-Allow-Origin: *` on every request.

**Risk.** Any website can make a request to your API from a user's browser. For pure read endpoints this is generally fine. The risk is that the POST endpoints (`/api/auth/challenge`, `/api/auth/verify`, `/api/discussions/:id/posts`) can be invoked cross-origin without a same-origin check — meaning a hostile site can attempt to use a user's session cookie or token. Since sessions are bearer-token (`Authorization: Bearer`) not cookie-based, this is partly mitigated, but defense-in-depth is cheap.

**Fix.** Restrict the allowlist:

```js
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://explorer.polkadex.ee,http://localhost:3000')
    .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
    origin: (origin, callback) => {
        // Same-origin (no Origin header) and listed origins only.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: false
}));
```

### MEDIUM M-2 — No rate limiting on POST endpoints

**Evidence.** The three POST routes (`/api/auth/challenge`, `/api/auth/verify`, `/api/discussions/:id/posts`) have no IP-level rate limiting. Discussions has a per-address cooldown (`POST_COOLDOWN_MS`), but the cooldown is keyed on Polkadex address — a flooder can rotate through addresses freely.

**Risk.** Cheap denial-of-service against the auth flow (each verify call hits the chain via `signatureVerify`), nonce-table pollution, and spam against discussions.

**Fix.** Add `express-rate-limit`:

```js
import rateLimit from 'express-rate-limit';
const authLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth', authLimiter);
app.use('/api/discussions', rateLimit({ windowMs: 60_000, max: 30 }));
```

Add `express-rate-limit` to `package.json` (pinned: `"7.4.1"` or newer).

### MEDIUM M-3 — No Content-Security-Policy

**Evidence.** `nginx.conf` sets `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `Permissions-Policy`, `Referrer-Policy`, but no `Content-Security-Policy`.

**Risk.** Discussion content goes through `stakingEscapeHtml`, so stored XSS is mitigated today. But there's no defense-in-depth if a future change accidentally introduces unescaped output. A CSP would block inline scripts and limit script sources, neutering most XSS.

**Fix.** Add to `nginx.conf` in the 443 server block (test carefully — strict CSPs commonly break SPAs):

```nginx
add_header Content-Security-Policy "
    default-src 'self';
    script-src  'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com;
    style-src   'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com;
    font-src    'self' https://fonts.gstatic.com data:;
    img-src     'self' data: https:;
    connect-src 'self' wss: https:;
    frame-ancestors 'self';
    base-uri    'self';
    form-action 'self';
" always;
```

Roll out via `Content-Security-Policy-Report-Only` first to catch violations before enforcing.

### MEDIUM M-4 — No off-host backup of `./data`

**Evidence.** SQLite at `./data/` is the entire indexer state. The bind mount survives container churn but not host loss / ransomware / Perfctl corruption.

**Risk.** A future incident with data damage means re-indexing from scratch (hours for the full backfill).

**Fix.** Add a nightly cron that snapshots `./data/explorer.db` to off-host storage (S3, Backblaze B2, rsync.net). Use SQLite's `.backup` command so the snapshot is a consistent single file even while the indexer is writing in WAL mode:

```bash
0 3 * * * docker compose -f /opt/pdexplorer/docker-compose.yml exec -T backend sqlite3 /app/data/explorer.db ".backup /app/data/explorer.bak.db" && rsync -a /opt/pdexplorer/data/explorer.bak.db backup-host:/backups/pdexplorer/$(date +\%Y-\%m-\%d)/explorer.db
```

### LOW L-1 — `nginx:alpine` and other unpinned image tags

**Evidence.** `Dockerfile.frontend` uses `FROM nginx:alpine` — a floating tag that resolves to whatever's latest at build time.

**Risk.** Non-reproducible builds; an upstream change can silently break or expand attack surface.

**Fix.** Pin to a specific minor: `FROM nginx:1.27-alpine`. Update intentionally during patch windows.

### LOW L-2 — No `--read-only` / `--cap-drop` on containers

**Evidence.** `docker-compose.yml` doesn't set `read_only`, `cap_drop`, `security_opt`, or `pids_limit` on the containers.

**Risk.** Reduces blast radius of a future container escape.

**Fix.** Tighten the compose service definitions:

```yaml
services:
  backend:
    # ...existing fields...
    read_only: true
    tmpfs:
      - /tmp:size=50M
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]
    security_opt:
      - no-new-privileges:true
    pids_limit: 200
  frontend:
    # ...existing fields...
    cap_drop: [ALL]
    cap_add: [CHOWN, SETGID, SETUID, NET_BIND_SERVICE]
    security_opt:
      - no-new-privileges:true
    pids_limit: 100
```

### LOW L-3 — `--experimental-sqlite` flag is, well, experimental

**Evidence.** `Dockerfile.backend` runs `node --experimental-sqlite server.js`, using Node's built-in SQLite (gated behind the experimental flag in Node 22).

**Risk.** Behavior or API changes in a future Node minor could break the indexer. Not a security risk per se, but operational fragility.

**Fix.** Either accept the risk (it's stable enough in practice) or migrate to `better-sqlite3` (a battle-tested npm package, pinned). The latter removes the experimental dependency entirely.

**Status — accepted risk, 2026-08-26 (audit F-147).** The pin stays at
`node:22.11-alpine` and the flag stays on every entrypoint. The reasoning, in
full, is in the comment above `CMD` in `Dockerfile.backend`; in short:

* On 22.11 the flag is **required**. `db.js` imports `node:sqlite` at the top
  level, so dropping it does not degrade anything — the container crash-loops on
  `ERR_UNKNOWN_BUILTIN_MODULE` and every `/api/*` route goes dark while nginx
  keeps serving the SPA.
* Later 22.x releases load `node:sqlite` unflagged but **still accept the flag**,
  so the current `CMD` survives a minor bump instead of becoming a crash-loop.
* There is no Node in reach where `node:sqlite` is non-experimental — 22.23 still
  emits `ExperimentalWarning: SQLite is an experimental feature` — so the
  "upgrade until it's stable" branch buys a re-test and nothing else.
* `better-sqlite3` is a native addon and a full rewrite of `db.js`'s call sites;
  the flag is not what makes that worth doing.
* A **major** Node bump is out of scope on its own terms: `@polkadot/api` is
  pinned to exactly `10.13.1` with a manually declared `CheckMetadataHash` signed
  extension, and that pair is what makes wallet signing produce valid extrinsics.

Every place the flag must appear is asserted by `test/infra-config.test.js`, so
removing it from one entrypoint and not the others fails the suite rather than
one deployment path.

### INFO I-1 — Auth flow looks correct

`POST /api/auth/verify` constructs the expected signed message from a nonce stored at challenge time, with a TTL (`AUTH_CHALLENGE_TTL`). Signature is verified via `signatureVerify` from `@polkadot/util-crypto`. Sessions use 192-bit random tokens (`randomAsHex(24)`). The accepted-bytes branch (`u8aWrapBytes(message)`) safely handles wallet extensions that wrap the message — but always verifies against the *same* canonical message string.

### INFO I-2 — No dynamic execution surface

No `eval`, `new Function`, `child_process`, or `vm` usage anywhere in the JavaScript code. SQL queries all use prepared statements with bound parameters in `db.js`. There is no file-upload route, no path-construction from user input, and no shell-out anywhere in `server.js`.

### INFO I-3 — Discussion content is escaped at render time

`script.js:4000` escapes content with `stakingEscapeHtml(p.content)` before injection. Server-side `db.createPost(...)` stores the raw content but no rendering happens server-side.

### INFO I-4 — Discussion content is unsanitized when stored

Posts are stored verbatim (only length-validated to 4000 chars). This is fine — escaping at render is the right pattern — but be aware that the DB contains raw user input. If a future feature exports posts (CSV, RSS) it must escape per-format.

### INFO I-5 — `CMC_API_KEY` was hardcoded in the source

`server.js:64` used to read:

```js
const CMC_API_KEY = process.env.CMC_API_KEY || '<REDACTED — key literal removed from this doc; it remains in git history until a history rewrite>';
```

That fallback key is committed to git history. **Rotate this CMC key immediately** — it's been exposed in source control for an unknown period and should be considered compromised. (The literal was also quoted verbatim in this document until 2026-08-21; quoting a secret in the audit that reported it keeps it greppable at HEAD — audit F-033.) Replace the literal with an empty string:

```js
const CMC_API_KEY = process.env.CMC_API_KEY || '';
```

Then provide a real key via `.env` only.

---

## Most likely Perfctl entry vectors (outside this repo)

Aqua Security's published Perfctl IOCs and the symptoms observed on your host point to these candidates, in rough order of likelihood:

1. **SSH with password auth enabled and a weak password.** AlmaLinux 9 default is `PasswordAuthentication yes`. Perfctl frequently spreads via SSH brute-force. The `provision-ubuntu.sh` script disables password auth by default.

2. **Polkit / `pkexec` CVE-2021-4034 (PwnKit).** Local-privilege-escalation that lets any local user become root. If a low-privilege user account ever existed on the box and Polkit wasn't patched, this is the textbook escalation step.

3. **Another internet-exposed service.** Apache RocketMQ, Confluence, CrushFTP, Jenkins, and Gitea have all been observed as initial Perfctl footholds. Anything running on the host outside the explorer stack is suspect.

4. **A vulnerable kernel allowing local privilege escalation.** Less common as an initial vector but possible if the OS was significantly behind on updates.

The fresh server eliminates all four by default: SSH key-only auth, latest kernel via unattended-upgrades, UFW limited to 22/80/443, no services installed beyond Docker + the explorer.

---

## Remediation checklist

Order of operations for the rebuild:

1. **Don't restore from the compromised host.** Rebuild from a clean git clone. (`provision-ubuntu.sh` does this.)
2. **Rotate the CMC API key** (I-5). It's been in source control.
3. **Rotate every SSH key, deploy token, and API credential** that ever touched the old box.
4. **Apply container hardening (H-1).** Add `USER node` to `Dockerfile.backend`; chown the host `data/` to uid 1000.
5. **Pin dependencies (H-2).** Lock `@polkadot/api`, `express`, `cors`; commit `package-lock.json`; switch backend Dockerfile to `npm ci`.
6. **Upgrade frontend Node (H-3).** `node:22-alpine` for the build stage; pin `nginx:1.27-alpine`.
7. **Restrict CORS (M-1)** in `server.js`.
8. **Add rate limiting (M-2)** to auth + discussion POST routes.
9. **Add CSP (M-3)** in `nginx.conf` — roll out in Report-Only mode first.
10. **Set up off-host backups (M-4)** of the SQLite database.
11. Optionally tighten container security (L-2: `read_only`, `cap_drop`, `no-new-privileges`).
12. Run `provision-ubuntu.sh` on the new VPS.
13. External uptime monitor on `https://explorer.polkadex.ee/api/network-info`.
14. Public disclosure note (precautionary): the previous host was compromised; the explorer is non-custodial and no user funds were at risk; the codebase has been audited and redeployed from clean source. Optional but builds trust.

---

## What `provision-ubuntu.sh` already handles

The fresh-server provisioning script addresses many of the OS-level findings directly:

- SSH locked down to key-only, no root password login
- UFW firewall (22/80/443 only)
- fail2ban
- Unattended security upgrades enabled
- Persistent journald + 500 MB cap
- `softdog` watchdog + watchdog daemon
- `/boot` and swap marked `nofail`
- `emergency.service` auto-resume after 60 s
- Hardened sysctl (network + kernel)
- Docker with log rotation, `no-new-privileges`, `live-restore`, ICC off
- Pre-creates `data/` with `uid=1000:gid=1000` so the non-root container can write

It does **not** do these (they require code changes that this audit recommends):

- Pin npm dependencies (H-2)
- Add `USER` to Dockerfiles (H-1)
- Restrict CORS (M-1)
- Add rate limiting (M-2)
- Add CSP header (M-3)

Apply those fixes in `server.js` / Dockerfiles before redeploying, and the new server starts in a substantially better posture than the old one.
