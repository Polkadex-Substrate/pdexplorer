import express from 'express';
import cors from 'cors';
import cluster from 'node:cluster';
import { cpus } from 'node:os';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { decodeAddress, encodeAddress, signatureVerify, randomAsHex } from '@polkadot/util-crypto';
import { u8aWrapBytes, stringToU8a, u8aConcat } from '@polkadot/util';
import { isOpenGovStatus } from './lib/gov-status.js';
import { deriveIndexStatus, describeIndexStatus } from './lib/index-status.js';
import { isRpcUnavailableError } from './lib/rpc-errors.js';
import { summarizeRewards, buildClaimedIndex, claimedRewardKey } from './lib/reward-dedup.js';
import { attributeBatchRewards, isBatchDelimiter, isAttributableBatch } from './lib/reward-attribution.js';
import { resolveClientIp } from './lib/client-ip.js';
import { planReorgSweep, hashesDiffer, heightsToVerify } from './lib/reorg.js';
import { planTxPage } from './lib/tx-paging.js';
import { buildTxRowFromEventRow, eventTxId, rewardId } from './lib/tx-from-event.js';
import { checkUserText } from './lib/user-text.js';
import { summarizeExtrinsicAmount } from './lib/extrinsic-summary.js';
import { chooseGap, recordAttempt, shouldRetire, exhaustedGapCount, DEFAULT_MAX_GAP_ATTEMPTS } from './lib/gap-scheduling.js';
import { checkWindow, perWorkerLimit } from './lib/rate-limit.js';
import { summarizeCommissionHistory, describeCommissionHistory, raisedRecently, pendingRaise } from './lib/commission-history.js';
import { retryTransient, isTransientSqliteError } from './lib/sqlite-errors.js';
import { contiguousWatermark, isCaughtUp, readHeadSeen } from './lib/watermark.js';
import { escapeHtml as sharedEscapeHtml } from './lib/html-escape.js';
import { hasSeriesData } from './lib/series-shape.js';
// Audit F-164 — the superOf → identityOf walk lives in ONE module that this
// file and the debug probes both import. Two copies of it drifted apart across
// a runtime upgrade once; see the header of lib/identity.js.
import { getOnChainIdentity } from './lib/identity.js';
// Audit F-154/F-155 — the /developers route list and the RPC-outage envelope
// live in ONE module that both this file and script.js render from. See the
// header of lib/api-reference.js for what four hand-maintained copies cost.
import { renderSection, renderToc, renderOutline, renderCacheTiers, RPC_NOT_READY, rpcNotReadyExample } from './lib/api-reference.js';
import {
    selectDispatchable, selectNewlyResolved, isTerminalRefStatus, describeRefOutcome
} from './lib/email-events.js';
import path from 'path';
import * as db from './db.js';
import { sendEmail, emailProviderStatus } from './email.js';

// --- Timestamped logging ---------------------------------------------------
// Prefix every console.* line with an ISO-8601 UTC timestamp so raw stdout
// (and `docker logs` without -t, journald, or a serial console) is always
// self-describing. Patching the global console here means all call sites in
// this file AND in db.js (console is process-global) pick it up automatically,
// without touching 50+ individual log statements. The `level` tag makes it
// easy to grep (e.g. `docker logs backend | grep ' ERROR '`).
//
// We also filter a small set of known-harmless polkadot.js library warnings
// that would otherwise flood the log on every chain interaction. Each one is
// emitted once with a [silenced] note so operators know the filter is active
// and can investigate if the volume of suppressed messages ever changes.
(function installTimestampedConsole() {
    const native = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        debug: console.debug ? console.debug.bind(console) : console.log.bind(console)
    };

    // ---- Library-noise filter ----
    // polkadot.js prints these once per storage decoration / type lookup miss,
    // which can be hundreds of times a minute under load. They're informational
    // (the chain keeps working) but they drown out everything else worth
    // reading.
    //
    // Matching: we strip the library's own "YYYY-MM-DD HH:MM:SS" timestamp
    // prefix (which polkadot.js's logger always emits) then check whether the
    // remaining text STARTS WITH a known library prefix. Using startsWith —
    // rather than a free-floating substring search — keeps our own indexer
    // warns intact even when they happen to quote the same error text inside
    // a "scan skipped block N: …" wrapper.
    //
    // To add an entry: capture an offending line, copy the leading text the
    // library emits (after its timestamp, if any), and append it here. Each
    // distinct match is announced exactly once, then suppressed silently.
    const SUPPRESSED_LIBRARY_PREFIXES = [
        'Unable to map',                // @polkadot/types: storage decoration miss
        'API/INIT: Not decorating',     // @polkadot/api: pallet shape doesn't match v14 metadata
        'API/INIT: api.consts.',        // @polkadot/api: missing const after runtime upgrade
        'API/INIT: api.query.',         // @polkadot/api: missing query after runtime upgrade
        'RPC-CORE:',                    // metadata-drift / decoder errors from RPC layer
        'Unable to decode storage',     // raw decoder error (no RPC-CORE prefix)
        'has multiple versions, ensure' // @polkadot duplicate-package warning
    ];
    const alreadyAnnouncedSuppression = new Set();
    // Matches the leading "YYYY-MM-DD HH:MM:SS" timestamp polkadot.js's
    // internal logger adds to every line it emits.
    const POLKADOTJS_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+/;

    function maybeSuppress(fn, level, args) {
        // polkadot.js's logger calls console.error(timestamp, ' RPC-CORE:',
        // '...message...') as THREE separate arguments — not as a pre-joined
        // single string. An earlier version of this matcher only looked at
        // args[0] (the timestamp), so the RPC-CORE prefix in args[1] was
        // never seen and the error leaked through. Join all args first so
        // the match runs against the same text the operator sees in the
        // terminal, then strip the leading timestamp + any whitespace so
        // startsWith() can do its job.
        if (!args || !args.length) return false;
        const joined = args.map(a => (typeof a === 'string') ? a : (() => {
            try { return String(a); } catch (_) { return ''; }
        })()).join(' ');
        const stripped = joined.replace(POLKADOTJS_TIMESTAMP_PREFIX, '').trimStart();
        for (const prefix of SUPPRESSED_LIBRARY_PREFIXES) {
            if (stripped.startsWith(prefix)) {
                if (!alreadyAnnouncedSuppression.has(prefix)) {
                    alreadyAnnouncedSuppression.add(prefix);
                    native.warn(
                        `${new Date().toISOString()} WARN  [silenced] polkadot.js noise starting with "${prefix}" ` +
                        `— first occurrence: ${stripped.slice(0, 160)}. Further matches will be suppressed.`
                    );
                }
                return true;
            }
        }
        return false;
    }

    const stamp = (level, fn) => (...args) => {
        if ((level === 'WARN ' || level === 'ERROR') && maybeSuppress(fn, level, args)) return;
        fn(`${new Date().toISOString()} ${level}`, ...args);
    };
    console.log = stamp('INFO ', native.log);
    console.info = stamp('INFO ', native.info);
    console.warn = stamp('WARN ', native.warn);
    console.error = stamp('ERROR', native.error);
    console.debug = stamp('DEBUG', native.debug);
})();

// ─── Sync-error dedupe ─────────────────────────────────────────────────────
// When the chain RPC is dead for a long time, every sync tick (and there are
// many) emits the same multi-line "WebSocket is not connected" stack. Over
// hours that's thousands of identical error blocks crowding out everything
// else. logSyncError() collapses repeats: it logs the FIRST occurrence of a
// given (label,message) pair immediately, then suppresses further identical
// occurrences within SYNC_ERROR_DEDUP_WINDOW_MS, and emits a single rollup
// "×N in the last Mm" line on the next non-suppressed log.
const SYNC_ERROR_DEDUP_WINDOW_MS = 5 * 60 * 1000;
const syncErrorSeen = new Map(); // key: "label:message" -> { firstAt, lastAt, count }

function logSyncError(label, err) {
    const msg = (err && err.message) ? err.message : String(err);
    const key = `${label}:${msg}`;
    const now = Date.now();
    const prev = syncErrorSeen.get(key);
    if (prev && (now - prev.lastAt) < SYNC_ERROR_DEDUP_WINDOW_MS) {
        // Within dedup window — suppress but bump the count.
        prev.count++;
        prev.lastAt = now;
        return;
    }
    // Either first occurrence or window expired. If there were suppressed
    // copies during the previous window, emit one rollup before resetting.
    if (prev && prev.count > 1) {
        const dur = Math.round((prev.lastAt - prev.firstAt) / 1000);
        console.error(`${label} error: ${msg} (×${prev.count} over ${dur}s)`);
    } else {
        console.error(`${label} error: ${msg}`);
    }
    syncErrorSeen.set(key, { firstAt: now, lastAt: now, count: 1 });
}

const app = express();
// Restrict CORS to known origins instead of the default wildcard. Same-origin
// requests (no Origin header) are always allowed. Override the list via
// ALLOWED_ORIGINS env (comma-separated).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://explorer.polkadex.ee,http://localhost:3000')
    .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS: ' + origin));
    },
    credentials: false
}));
app.use(express.json({ limit: '64kb' }));

// ─── Audit F-087: a cacheable error is an outage that outlives its cause ────
//
// The cache helpers below are documented "do NOT call these on error
// responses", and every endpoint was expected to honour that by calling them
// only after the work succeeded. Several call them first — set the header, then
// query SQLite or the RPC, then throw. Cloudflare obeys explicit caching
// headers on 5xx, so one transient failure gets pinned at the edge for the full
// s-maxage: up to ten minutes of every visitor seeing a 500 for an endpoint
// that recovered in a second. The origin never sees the traffic, so nothing in
// our logs says it is still happening.
//
// A convention is the wrong shape for this. Any new endpoint, or any reordering
// of an existing one, silently reopens it — and the failure is invisible until
// it is an incident. So it is enforced once, here, on the way out: if the
// status is not cacheable, the public caching header is replaced with no-store
// no matter who set it or when.
//
// Deliberately a header rewrite rather than a lint rule or a code convention:
// it holds for handlers that have not been written yet.
// A review catch on the first version of this list: 304 and 206 were missing.
//
// 304 is the one that mattered. Express 5 has ETags on by default and answers
// a conditional request with 304 automatically, WITHOUT clearing Cache-Control
// — so every successful revalidation was being rewritten to `no-store`. Per
// RFC 9111 §4.3.4 a 304's headers UPDATE the stored response, so each
// revalidation told Cloudflare to discard the entry it had just confirmed was
// still good. The cache hit ratio would have collapsed to roughly zero after
// the first freshness window and every body would have come from origin: the
// exact inverse of what F-087 is for, shipped as a cache fix.
//
// 206 (Range) is included for the same reason — a partial response to a range
// request is a normal success, not an error.
const CACHEABLE_STATUSES = new Set([200, 203, 204, 206, 300, 301, 304, 404, 410]);

// Audit F-076. `express.json({ limit: '64kb' })` caps what clients may SEND,
// and the developer docs described it as though it capped the exchange in both
// directions. It does not: a GET response has no limit at all, and several
// endpoints can return megabytes (a storage-map page, a decoded block full of
// large extrinsics). Those large responses also carry `public` cache headers,
// so one expensive query can occupy a CDN cache entry indefinitely — and a
// caller who requested it once gets it re-served cheaply, which is the wrong
// incentive for exactly the queries we least want repeated.
//
// We do not TRUNCATE the body: silently returning half a JSON document is
// worse than returning a large one, because the client cannot tell. Instead an
// oversized response stops being cacheable and says so in a header, so the
// cost lands on the caller that asked for it rather than on the shared edge.
const RESPONSE_CACHE_MAX_BYTES = readPositiveInteger(process.env.RESPONSE_CACHE_MAX_BYTES, 512 * 1024);

app.use((req, res, next) => {
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
        // Express sets statusCode before writeHead; the first positional arg
        // wins when a caller passes one explicitly.
        const status = typeof args[0] === 'number' ? args[0] : res.statusCode;
        const current = res.getHeader('Cache-Control');
        const isPublic = current && /public|max-age|s-maxage/i.test(String(current));

        if (isPublic && !CACHEABLE_STATUSES.has(status)) {
            res.setHeader('Cache-Control', 'no-store');
        } else if (isPublic) {
            // F-076: an oversized 200 is not worth an edge cache entry.
            const len = Number(res.getHeader('Content-Length'));
            if (Number.isFinite(len) && len > RESPONSE_CACHE_MAX_BYTES) {
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('X-Response-Size-Warning',
                    `${len} bytes exceeds the ${RESPONSE_CACHE_MAX_BYTES}-byte cache threshold; this response is not cached`);
            }
        }
        return writeHead.apply(this, args);
    };
    next();
});

// Form-encoded bodies, scoped to the two routes that need them (the email
// confirm/unsubscribe pages, F-001/F-036 — plain <form method="POST">
// submissions from a mail client, no JavaScript to serialise JSON).
//
// Deliberately NOT app.use(). application/x-www-form-urlencoded is a
// CORS-"simple" content type: it triggers no preflight, so the request is
// delivered even when the origin check below would have rejected it — only the
// response is hidden. Registering it globally would have made every POST in the
// app reachable by a cross-site auto-submitting form; on /api/email/subscribe
// that means any page on the web could make the explorer mail a confirmation to
// an address of its choosing and burn a visitor's signup quota. Those routes
// still require JSON, which forces a preflight.
const formBody = express.urlencoded({ extended: false, limit: '4kb' });

// Use dedicated data directory for Docker volumes
const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(process.cwd(), 'data');
const FIVE_MINUTES = 5 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const THIRTY_SECONDS = 30 * 1000;
const RECENT_SYNC_INTERVAL = 12 * 1000;
// Network-info cache pre-warm cadence. Bumped from 3 → 10 minutes because the
// underlying compute does a `staking.ledger.entries()` scan over every staker
// on the chain, which is one of our heaviest RPC operations. The TTL on
// getNetworkInfo() is still 5 minutes, so the endpoint serves stale data for
// at most ~5 minutes while the background refresh catches up.
const NETWORK_INFO_REFRESH_MS = readPositiveInteger(process.env.NETWORK_INFO_REFRESH_MS, 10 * 60 * 1000);
// /api/analytics/snapshot relies on COUNT(*) over blocks/events/transactions
// — full table scans in SQLite. On a chain with tens of millions of indexed
// rows this can take 30-60s and blow past nginx's proxy_read_timeout. We
// pre-compute those counts on the indexer worker every N ms and store them
// in KV; the HTTP endpoint then just reads the cached object.
const ANALYTICS_COUNTS_REFRESH_MS = readPositiveInteger(process.env.ANALYTICS_COUNTS_REFRESH_MS, 5 * 60 * 1000);

// Cache for the EFFECTIVE bond minimum enforced by the staking pallet on
// partial unbonds. On Polkadex this is empirically max(minNominatorBond,
// minValidatorBond) — the runtime rejects partial unbonds that would leave
// the bonded balance below this floor, even for nominators (non-standard
// Substrate behaviour, but consistent with Polkadex's custom staking pallet:
// minNominatorBond returns 0 in storage but minValidatorBond=100 PDEX is the
// real threshold that fires the validate_transaction WASM trap).
//
// We cache both values for an hour because they change only by governance,
// and the unstake modal's pre-flight check + display depend on having a
// fresh value at all times. A transient RPC error during /api/wallet would
// otherwise silently zero this out, the frontend would skip the protective
// check, and users would see raw WASM traps instead of friendly messages.
// Cache returns a stale-but-good value through reconnect blips.
const MIN_NOMINATOR_BOND_TTL_MS = readPositiveInteger(
    process.env.MIN_NOMINATOR_BOND_TTL_MS, 60 * 60 * 1000);
let cachedMinNominatorBond = { value: 0, fetchedAt: 0 };

async function getMinNominatorBondCached() {
    const now = Date.now();
    const fresh = cachedMinNominatorBond.value > 0
        && (now - cachedMinNominatorBond.fetchedAt) < MIN_NOMINATOR_BOND_TTL_MS;
    if (fresh) return cachedMinNominatorBond.value;
    if (!isRpcReady()) {
        // Don't blank the cache when RPC is mid-reconnect — serve the last
        // good value if we have one, even if technically stale.
        return cachedMinNominatorBond.value;
    }
    try {
        // Fetch both threshold-relevant storage values in parallel and take
        // the max. Either may legitimately be 0 (Polkadex sets nominator=0,
        // for example). What matters is the larger of the two — that's the
        // runtime gate that produces WASM traps on partial unbond.
        const [nominatorRaw, validatorRaw] = await Promise.all([
            globalApi.query.staking.minNominatorBond().catch(() => null),
            globalApi.query.staking.minValidatorBond().catch(() => null),
        ]);
        const nominator = nominatorRaw ? balanceToPDEX(nominatorRaw) : 0;
        const validator = validatorRaw ? balanceToPDEX(validatorRaw) : 0;
        const effective = Math.max(nominator, validator);
        if (effective > 0) {
            cachedMinNominatorBond = { value: effective, fetchedAt: now };
        }
        return cachedMinNominatorBond.value;
    } catch (err) {
        // Log the failure (vs the previous silent swallow) so we can spot
        // patterns in production. Keep returning the cached value if any.
        console.warn('[wallet] min-bond fetch failed:',
            err && err.message ? err.message : err);
        return cachedMinNominatorBond.value;
    }
}

// Governance sync cadence (council motions, treasury proposals, democracy
// referenda). These changed every 5 minutes by default historically;
// override via GOVERNANCE_REFRESH_MS for all three at once, or use the
// per-pallet vars to tune each independently. Note: governance state changes
// over hours/days, not seconds — running these too often adds RPC load
// without surfacing meaningfully fresher data.
const GOVERNANCE_REFRESH_MS = readPositiveInteger(process.env.GOVERNANCE_REFRESH_MS, 5 * 60 * 1000);
const COUNCIL_REFRESH_MS    = readPositiveInteger(process.env.COUNCIL_REFRESH_MS,    GOVERNANCE_REFRESH_MS);
const TREASURY_REFRESH_MS   = readPositiveInteger(process.env.TREASURY_REFRESH_MS,   GOVERNANCE_REFRESH_MS);
const DEMOCRACY_REFRESH_MS  = readPositiveInteger(process.env.DEMOCRACY_REFRESH_MS,  GOVERNANCE_REFRESH_MS);

// Tick cadence for the resumable-backfill crawlers. Each tick does the forward
// pass + one backfill chunk + (for chain-index) one gap-fill chunk. Lower
// these to make backfill complete sooner — the forward pass is a no-op when
// the head hasn't moved, so the extra ticks are essentially free. Total
// per-second RPC load = chunk_size * fetch_concurrency / interval_seconds.
// Defaults tuned for STEADY-STATE operation (backfill complete). The per-tick
// work in steady state is "RPC for chain head + maybe a handful of new blocks"
// — there is no benefit to ticking aggressively for events that change at
// era / weekly cadences. Lower these only if you're explicitly trying to
// finish a fresh-install backfill faster (the trade-off is RPC load).
//   * STAKING_REWARDS_INTERVAL_MS — new rewards land at era boundaries (~24h)
//     and at payoutStakers claims. 60s gives ~5 blocks/tick of granularity.
//   * GOVERNANCE_INDEXER_INTERVAL_MS — council motions + treasury proposals
//     are rare events (a few per week). 90s is plenty.
//   * CHAIN_INDEX_INTERVAL_MS — the live blocks/transactions indexer that
//     drives the home page Recent Blocks feed. Pinned at the chain's block
//     time so the feed always shows the latest block.
const STAKING_REWARDS_INTERVAL_MS   = readPositiveInteger(process.env.STAKING_REWARDS_INTERVAL_MS,   60 * 1000);
const GOVERNANCE_INDEXER_INTERVAL_MS = readPositiveInteger(process.env.GOVERNANCE_INDEXER_INTERVAL_MS, 90 * 1000);
const CHAIN_INDEX_INTERVAL_MS       = readPositiveInteger(process.env.CHAIN_INDEX_INTERVAL_MS,       12 * 1000);

// Gap-fill (scan_failures retry queue) tuning. SCAN_GAP_FILL_BATCH is how
// many failures each indexer pops + retries per tick; SCAN_MAX_ATTEMPTS is
// the per-row retry cap — above that the row stays in the table as a
// "permanent skip" for operator inspection but is no longer retried.
// Together they bound per-tick CPU/RPC load: with three indexers, defaults
// give ~60 retries/minute of capacity, enough to drain a multi-hour
// outage in roughly half an hour after the chain comes back.
const SCAN_GAP_FILL_BATCH = readPositiveInteger(process.env.SCAN_GAP_FILL_BATCH, 20);
const SCAN_MAX_ATTEMPTS   = readPositiveInteger(process.env.SCAN_MAX_ATTEMPTS,   10);

// --- Chain index tuning (blocks + events combined indexer) ----------------
// The chain indexer keeps two watermarks: latestScannedBlock (forward, head)
// and backfillCursor (descending, genesis-ward), so a missed window during an
// RPC outage is automatically filled in on subsequent ticks. A third "gap
// fill" pass re-attempts any block numbers missing within the indexed range
// (RPC blips that previously left holes).
const BLOCKS_FORWARD_MAX = readPositiveInteger(process.env.BLOCKS_FORWARD_MAX, 500);
const BLOCKS_BACKFILL_CHUNK = readPositiveInteger(process.env.BLOCKS_BACKFILL_CHUNK, 200);
const BLOCKS_GAP_FILL_CHUNK = readPositiveInteger(process.env.BLOCKS_GAP_FILL_CHUNK, 100);
const BLOCKS_MIN_BLOCK = readPositiveInteger(process.env.BLOCKS_MIN_BLOCK, 1);
// Gap-scan cadence. Running the getBlockGaps window scan every chain-index tick
// (12s) over a multi-million-row blocks table was the dominant steady-state CPU
// cost. Instead: scan a bounded recent window at most every CHAIN_GAP_SCAN_MS,
// a full-history scan at most every CHAIN_FULL_GAP_SCAN_MS (to catch deep holes),
// and always immediately after a tick that had block-fetch failures. A late gap
// repair is harmless for an explorer, so these can be generous.
const CHAIN_GAP_SCAN_MS = readPositiveInteger(process.env.CHAIN_GAP_SCAN_MS, 5 * 60 * 1000);
const CHAIN_FULL_GAP_SCAN_MS = readPositiveInteger(process.env.CHAIN_FULL_GAP_SCAN_MS, 60 * 60 * 1000);
const CHAIN_GAP_SCAN_WINDOW = readPositiveInteger(process.env.CHAIN_GAP_SCAN_WINDOW, 5000);
// F-047: how many block heights one "full" gap sweep covers. The sweep walks
// the whole history across successive ticks in slices this size, so the
// synchronous LEAD is O(window) rather than O(table). 500k heights is a few
// hundred ms on the production index; the whole 12.8M-block history is covered
// in ~26 sweeps, i.e. about a day at the hourly cadence.
const CHAIN_FULL_SCAN_WINDOW = readPositiveInteger(process.env.CHAIN_FULL_SCAN_WINDOW, 500_000);
// Per-tick parallelism for block fetches. Each Promise.all batch hits the RPC
// node with this many concurrent block-hash + derived-block requests. Higher
// = faster catch-up but more RPC load; lower = gentler but slower. 8 is a
// good trade-off for a typical Polkadex node; lower it under stress.
const BLOCKS_FETCH_CONCURRENCY = readPositiveInteger(process.env.BLOCKS_FETCH_CONCURRENCY, 8);
// When any sync function throws, skip the next ticks for this long. Prevents
// the load-amplification spiral where a timing-out RPC causes every 12s/30s
// sync timer to stack up parallel hung promises.
const SYNC_BACKOFF_MS = readPositiveInteger(process.env.SYNC_BACKOFF_MS, 60 * 1000);
// How long the cached `totalUnlocking` figure (sum of all unbonding stake on
// the chain) is considered fresh. The underlying query — a full scan of
// staking.ledger.entries() — is the single most expensive RPC in this app,
// so we run it rarely and serve the cached value from the network-info path.
const TOTAL_UNLOCKING_TTL_MS = readPositiveInteger(process.env.TOTAL_UNLOCKING_TTL_MS, 30 * 60 * 1000);
const TX_CACHE_LIMIT = readPositiveInteger(process.env.TX_CACHE_LIMIT, 500);
const TX_INITIAL_SCAN_BLOCKS = readPositiveInteger(process.env.TX_INITIAL_SCAN_BLOCKS, 20000);
const TX_OLDER_SCAN_BLOCKS = readPositiveInteger(process.env.TX_OLDER_SCAN_BLOCKS, TX_INITIAL_SCAN_BLOCKS);
// F-008: how many blocks of the LOCAL events table the transactions backfill
// derives per tick. Zero RPC — this is a range read over events plus INSERT OR
// IGNORE — so it can be generous; 5000/tick walks the full 12.8M-block history
// in well under a day without the chain node noticing anything happened.
const TX_BACKFILL_CHUNK = readPositiveInteger(process.env.TX_BACKFILL_CHUNK, 5000);
// Below this height there is nothing to derive (block 1 onward by default).
const TX_MIN_BLOCK = readPositiveInteger(process.env.TX_MIN_BLOCK, 1);
const TX_SCAN_BATCH_SIZE = readPositiveInteger(process.env.TX_SCAN_BATCH_SIZE, 25);
// v3: hash-keyed transaction ids (F-021). Bumped only because initDb's
// migrateHashKeyedIds rewrites the EXISTING rows first — the audit is explicit
// that changing the writer without a migration just creates duplicates.
const FINANCIAL_TX_SCANNER_VERSION = 3;
const VALIDATOR_HISTORY_ERAS = readPositiveInteger(process.env.VALIDATOR_HISTORY_ERAS, 30);
// How often to re-walk the validator set + per-era commission history.
// Eras are ~24h on Polkadex, so hourly catches every boundary with margin.
const VALIDATOR_SYNC_INTERVAL_MS = readPositiveInteger(process.env.VALIDATOR_SYNC_INTERVAL_MS, 60 * 60 * 1000);
// Staking rewards indexer tuning. The crawler scans blocks for staking.Rewarded
// events (claimed payouts) and appends them to a local per-address index.
// Steady-state defaults (post-backfill). These knobs only matter during
// backfill or after a long outage; in steady state the forward pass walks
// only the handful of new blocks since the previous tick. If you're starting
// a fresh install and want backfill to finish faster, override:
//   STAKING_REWARDS_SCAN_BATCH=50 STAKING_REWARDS_BACKFILL_CHUNK=500
const STAKING_REWARDS_SCAN_BATCH = readPositiveInteger(process.env.STAKING_REWARDS_SCAN_BATCH, 8);
const STAKING_REWARDS_BACKFILL_CHUNK = readPositiveInteger(process.env.STAKING_REWARDS_BACKFILL_CHUNK, 100);
// Forward-pass cap: ~5000 blocks ≈ 17 hours of chain history at 12s blocks.
// If the indexer is offline longer than that, it walks recent-N once, then
// the gap-fill retry queue picks up the rest across subsequent ticks.
const STAKING_REWARDS_FORWARD_MAX = readPositiveInteger(process.env.STAKING_REWARDS_FORWARD_MAX, 5000);
const STAKING_REWARDS_MIN_BLOCK = readPositiveInteger(process.env.STAKING_REWARDS_MIN_BLOCK, 1);
// Governance history crawler (treasury proposals + council motions).
const GOV_SCAN_BATCH = readPositiveInteger(process.env.GOV_SCAN_BATCH, 50);
// Governance history-walker tuning. Same steady-state philosophy: backfill is
// a one-time operation, the forward pass is bounded by new-blocks-per-tick.
// Override these (e.g. GOV_BACKFILL_CHUNK=1000, GOV_FORWARD_MAX=50000) only
// when explicitly running a fresh-install catch-up.
const GOV_BACKFILL_CHUNK = readPositiveInteger(process.env.GOV_BACKFILL_CHUNK, 200);
const GOV_FORWARD_MAX = readPositiveInteger(process.env.GOV_FORWARD_MAX, 5000);
const GOV_MIN_BLOCK = readPositiveInteger(process.env.GOV_MIN_BLOCK, 1);
// Wallet dashboard / price chart / unpaid-reward tuning.
// CMC API key for the PDEX/USD price feed. Never hardcode — supply via .env
// (the previous in-source default was committed to git and is now considered
// compromised; rotate it at CoinMarketCap if you haven't already).
const CMC_API_KEY = process.env.CMC_API_KEY || '';
const CMC_SYMBOL = process.env.CMC_SYMBOL || 'PDEX';
// Multi-provider price feed. Comma-separated names in PRICE_PROVIDERS select
// which live pollers run. AscendEX was removed after the exchange shut down
// (Jul 2026); the default live source is now CoinGecko — a keyless public API
// that aggregates PDEX across its real markets (KuCoin, Poloniex, Gate, …)
// rather than a single venue or the stale Ethereum-bridged Uniswap pool.
// CoinMarketCap remains available (add 'cmc' + CMC_API_KEY). Historical rows
// tagged 'ascendex'/'ascendex-backfill' stay in price_history and still render.
const PRICE_PROVIDERS = (process.env.PRICE_PROVIDERS || 'coingecko')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
// CoinGecko: keyless is fine at 10-min polling; set COINGECKO_API_KEY to a free
// "demo" key for higher limits. COINGECKO_ID is the coin id, i.e. the slug in
// coingecko.com/en/coins/<id>.
const COINGECKO_ID = process.env.COINGECKO_ID || 'polkadex';
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || '';
const PRICE_SYNC_INTERVAL = readPositiveInteger(process.env.PRICE_SYNC_INTERVAL_MS, 10 * 60 * 1000);
function isPriceProviderEnabled(name) {
    return PRICE_PROVIDERS.includes(name);
}
function isPriceProviderConfigured(name) {
    if (name === 'cmc') return !!CMC_API_KEY;
    if (name === 'coingecko') return true; // public endpoint; API key optional
    return false;
}
const PRICE_PROVIDER_LABELS = { coingecko: 'CoinGecko', cmc: 'CoinMarketCap', ascendex: 'AscendEX', 'defillama-backfill': 'DefiLlama (historical)' };
function priceProviderLabel(name) {
    return PRICE_PROVIDER_LABELS[name] || name;
}
const UNCLAIMED_TTL = readPositiveInteger(process.env.UNCLAIMED_TTL_MS, 20 * 60 * 1000);
const DISPLAY_NAME_OVERRIDES = new Map([
    ['esoEt6uZ9vs23yW8aqTACLf1tViGpSLZKnhPXt5Nq7vQwHGew', 'Polkadex Treasury'],
    ['esm4teFDTrvy4VJ8msKTQmAywumeinGjzsrFzmTEB5FBiiekE', 'Gate.IO']
]);
// Known Polkadex mainnet treasury account — used as a fallback if the
// pallet-id derivation is unavailable on the connected runtime.
const TREASURY_ACCOUNT = process.env.TREASURY_ACCOUNT || 'esoEt6uZ9vs23yW8aqTACLf1tViGpSLZKnhPXt5Nq7vQwHGew';

// Comma-separated list of WebSocket RPC endpoints. WsProvider will rotate
// across them on failure and reconnect with exponential-ish backoff. Set
// POLKADEX_WS to a comma-separated list (your private node first, plus any
// public fallbacks) when the default endpoint is rate-limiting — that's the
// single biggest cause of `WebSocket is not connected`.
// rpc.polkadex.ee is a Cloudflare Load Balancer endpoint that fronts multiple
// origin nodes (so.polkadex.ee, polkadex-rpc.faradaynodes.com, ...). Using
// the LB endpoint here means the explorer benefits from automatic failover
// when an origin goes unhealthy, without each client having to know about
// every origin. Override POLKADEX_WS in .env to point at a private node.
const RPC_ENDPOINTS = (process.env.POLKADEX_WS || 'wss://rpc.polkadex.ee')
    .split(',').map(s => s.trim()).filter(Boolean);
const RPC_AUTO_RECONNECT_MS = readPositiveInteger(process.env.POLKADEX_WS_RECONNECT_MS, 2500);

// RPC resilience watchdog thresholds. WsProvider auto-reconnects every
// RPC_AUTO_RECONNECT_MS but in extreme outages (chain RPC down for hours)
// the ApiPromise object on top can land in a half-reconnected state where
// the underlying WS comes back up but the api keeps reporting disconnected.
// We work around this in layers:
//
//   * RPC_RESET_AFTER_MS — after this much continuous disconnect, tear down
//     globalApi and call connectRpc() fresh. This forces polkadot.js to
//     re-handshake metadata + types, which is usually enough.
//   * RPC_EXIT_AFTER_MS — if even an api rebuild doesn't restore service,
//     exit so Docker (restart=unless-stopped) brings up a fresh container.
//     Last-resort backstop; should rarely fire in practice.
//
// Operators can disable either by setting the env to a very large value.
// 5-min default was sized for the single-origin era, when a real upstream
// outage was the dominant disconnect cause and rebuilds during transient
// blips were undesired noise. With the CF Load Balancer now fronting two
// origins, the failure mode flips: the LB is statistically almost always
// reachable, so any disconnect lasting >30s is far more likely to be
// "WsProvider stuck after origin churn" than "the entire LB is down" —
// in which case a fresh rebuild lets the new connection re-roll onto a
// healthy origin. Failover drill confirmed this empirically: with the old
// 5-min reset, automatic failover to Faraday took 5m11s. With a 30s reset,
// the same drill recovers within ~45s of nginx going down on the primary.
const RPC_RESET_AFTER_MS = readPositiveInteger(process.env.RPC_RESET_AFTER_MS, 30 * 1000);
const RPC_EXIT_AFTER_MS  = readPositiveInteger(process.env.RPC_EXIT_AFTER_MS,  30 * 60 * 1000);
// Watchdog tick has to be shorter than RPC_RESET_AFTER_MS for the reset
// threshold to fire promptly. 10s gives ~3 ticks of grace before the 30s reset.
const RPC_WATCHDOG_INTERVAL_MS = readPositiveInteger(process.env.RPC_WATCHDOG_INTERVAL_MS, 10 * 1000);
let rpcConnected = false;

// True only when both the `WsProvider` thinks it's connected *and* the
// ApiPromise reports `isConnected`. Background sync loops should skip ticks
// when this is false instead of throwing `WebSocket is not connected`.
function isRpcReady() {
    return rpcConnected && !!globalApi && globalApi.isConnected;
}

// Request-handler guard: bail out of any endpoint that needs live RPC access
// when the WsProvider hasn't completed its handshake yet. Without this, code
// like `globalApi.rpc.chain.getBlockHash(...)` blows up with the unhelpful
// "Cannot read properties of null (reading 'rpc')" TypeError, which then
// surfaces verbatim in the UI. A 503 with Retry-After tells both humans and
// caches that this is a transient state worth retrying — Cloudflare honors
// the header and browsers display the friendly message instead of stack-y
// noise.
//
//   Usage:
//     app.get('/api/block/:id', async (req, res) => {
//         if (!requireRpc(res)) return;
//         ...uses globalApi safely...
//     });
//
// Returns true (and does nothing to `res`) when RPC is healthy; returns
// false and writes a 503 JSON body when not. Callers MUST `return` on false
// so the rest of the handler doesn't run.
function requireRpc(res) {
    if (!globalApi || !globalApi.isConnected) {
        res.set('Retry-After', '5');
        // Never let a transient "RPC not ready" 503 be cached — a CDN/edge cache
        // (e.g. a Cloudflare rule that makes /api/* eligible for cache) could
        // otherwise pin this empty-data error and serve it to every client long
        // after the RPC recovered. no-store defeats that regardless of TTL.
        res.set('Cache-Control', 'no-store');
        // Audit F-155: the literal used to live here AND, differently, in four
        // documents. It now lives in lib/api-reference.js, which is also what
        // /developers renders — so the documented envelope is this envelope by
        // construction, not by somebody remembering to update both. If you
        // change the wording, change it there; `code` is the part clients are
        // told to branch on and must stay stable.
        res.status(503).json({ error: RPC_NOT_READY.error, code: RPC_NOT_READY.code });
        return false;
    }
    return true;
}

let isSyncing = false;
let isSyncingHolders = false;
let isSyncingTx = false;
// Audit F-141: `isSyncingBlocks` / `isSyncingEvents` are deliberately absent.
// They were the re-entrancy latches for the standalone syncBlocks/syncEvents
// crawlers, which syncChainIndex replaced. Leaving the latches behind after
// deleting the crawlers is how a "harmless" dead variable becomes a live bug:
// the next person wiring a blocks crawler finds a plausible-looking flag,
// reuses it, and gets a latch that no error path ever clears. If you need a
// second writer, declare its own flag next to its own function so the two
// cannot drift apart.
let isSyncingStakingRewards = false;
let isSyncingPrice = false;
let isSyncingCouncil = false;
let isSyncingDemocracy = false;
let isSyncingTreasury = false;
let isSyncingGovernance = false;
const computingUnclaimed = new Set();
let isCrawlingAccount = {};
let globalApi = null;

// Watchdog state. rpcDisconnectStartedAt is set when we first observe a
// disconnect and cleared on a successful reconnect; the watchdog interval
// reads it to decide when to escalate (rebuild api -> exit process).
// rpcResetInFlight prevents concurrent reset attempts when the watchdog tick
// overlaps with a slow reconnect.
let rpcDisconnectStartedAt = null;
let rpcResetInFlight = false;

// Generation counter: incremented at the start of every connectRpc() call.
// Each WsProvider/ApiPromise's event handlers capture the generation they
// were registered under. When a stale (orphaned) handler fires after a
// rebuild, it sees a mismatched generation and no-ops — preventing zombie
// handlers from older WsProvider instances from mutating global state
// (rpcConnected / rpcDisconnectStartedAt) after they've been logically
// replaced. This was the root cause of the indexer worker getting stuck
// after RPC incidents: many concurrent in-flight calls during disconnect
// caused multiple rebuilds in quick succession, each leaving event handlers
// behind, and the resulting zombie events kept resetting rpcDisconnectStartedAt
// to "now" so the watchdog's outage timer never advanced past the reset
// threshold.
let rpcGen = 0;

// Chain-head freshness tracking. A separate failure mode from "WS dropped":
// the WebSocket stays connected but the upstream node stops advancing the
// chain head (peer loss, clock skew rejecting incoming blocks, runtime
// upgrade pause, etc.). The disconnect watchdog can't see this because the
// WsProvider is happy. recordChainHead() is called every time syncChainIndex
// observes a head, and the chainHeadWatchdog interval escalates when nothing
// has advanced for CHAIN_HEAD_STALE_MS.
const CHAIN_HEAD_STALE_MS = readPositiveInteger(process.env.CHAIN_HEAD_STALE_MS, 5 * 60 * 1000);
const CHAIN_HEAD_WATCHDOG_INTERVAL_MS = readPositiveInteger(process.env.CHAIN_HEAD_WATCHDOG_INTERVAL_MS, 60 * 1000);

// ─── SubQuery indexer integration ──────────────────────────────────────────
// Optional secondary read path. The /api/diag/subquery-lag endpoint queries
// the indexer's GraphQL `_metadata` to report how many blocks behind chain
// head it is. The healthy threshold is what later integration code will
// also use to decide "trust the indexer's data or fall back to SQLite".
//
//   SUBQUERY_ENDPOINT       — GraphQL URL. Empty string disables the feature.
//   SUBQUERY_TIMEOUT_MS     — abort any request taking longer than this.
//   SUBQUERY_MAX_LAG_BLOCKS — above this lag, the indexer is unhealthy.
//   POLKADEX_BLOCK_TIME_MS  — block time used to translate lag into seconds.
const SUBQUERY_ENDPOINT       = (process.env.SUBQUERY_ENDPOINT || 'https://indexer.polkadex.ee/').trim();
const SUBQUERY_TIMEOUT_MS     = readPositiveInteger(process.env.SUBQUERY_TIMEOUT_MS, 1500);
const SUBQUERY_MAX_LAG_BLOCKS = readPositiveInteger(process.env.SUBQUERY_MAX_LAG_BLOCKS, 200);
const POLKADEX_BLOCK_TIME_MS  = readPositiveInteger(process.env.POLKADEX_BLOCK_TIME_MS, 12000);

// Minimum acceptable peer count for /api/diag/rpc-health to report healthy.
// A node with fewer than this is likely struggling to receive new blocks.
const RPC_HEALTH_MIN_PEERS    = readPositiveInteger(process.env.RPC_HEALTH_MIN_PEERS, 3);
// Maximum time to wait for the chain RPC's system_health response before
// declaring it unhealthy. Should be well under the external monitor's
// timeout (Cloudflare LB monitor uses 5s).
const RPC_HEALTH_TIMEOUT_MS   = readPositiveInteger(process.env.RPC_HEALTH_TIMEOUT_MS, 3000);
let lastHeadValue = 0;
let lastHeadAdvanceAt = Date.now();
let chainStaleSince = null;            // timestamp when head first went stale
let chainStaleRebuildAttempted = false;
let chainSS58 = 88; // Polkadex SS58 prefix; refreshed from the chain registry on connect.
const identityCache = new Map();

// ─── LRU caches for immutable chain reads ──────────────────────────────────
// Substrate RPC calls that reference a specific block hash (or a block number
// that's already finalised) are deterministically immutable — once we've
// fetched them, the chain will never return a different answer for the same
// key. Caching them takes pressure off the upstream RPC, which is especially
// useful during indexer gap-fill (the same block is retried until it lands).
//
// Why hand-rolled instead of an npm dep: this is the only LRU in the
// codebase, the implementation is ~30 lines, and adding a dep would mean
// bumping package-lock and rebuilding the image. Map.delete + Map.set
// preserves insertion order, which is exactly what we need for the LRU
// recency move.
//
// IMPORTANT: cached values are polkadot.js codec objects that hold references
// to the api's type registry. After the watchdog rebuilds the api (long-
// outage path), these references become stale — `clearRpcCaches()` is called
// at the start of every connectRpc() to prevent that.
class LRU {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this.cache = new Map();
        this.hits = 0;
        this.misses = 0;
    }
    get(key) {
        const val = this.cache.get(key);
        if (val === undefined) { this.misses++; return undefined; }
        // Move to MRU position by reinserting.
        this.cache.delete(key);
        this.cache.set(key, val);
        this.hits++;
        return val;
    }
    set(key, val) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Evict LRU (first inserted).
            const oldest = this.cache.keys().next().value;
            this.cache.delete(oldest);
        }
        this.cache.set(key, val);
    }
    clear() { this.cache.clear(); this.hits = 0; this.misses = 0; }
    // Targeted eviction — the reorg repair (F-007) must drop a single
    // number->hash entry without nuking every cache in the process.
    evict(key) { this.cache.delete(key); }
    stats() {
        const total = this.hits + this.misses;
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hits: this.hits,
            misses: this.misses,
            hitRate: total > 0 ? Math.round(this.hits / total * 1000) / 10 + '%' : 'n/a'
        };
    }
}

// Three caches sized for the workload:
//   blockCache       — full SignedBlock objects, biggest payload, smaller cap.
//   blockHashCache   — Hash codec by block number, tiny payload, larger cap.
//   eventsAtCache    — Vec<EventRecord> at a block hash, medium payload.
// Sizes were chosen so each cache fits comfortably under ~50 MB at steady
// state. Override via env if memory pressure ever becomes an issue.
const RPC_BLOCK_CACHE_SIZE       = readPositiveInteger(process.env.RPC_BLOCK_CACHE_SIZE,       2000);
const RPC_BLOCK_HASH_CACHE_SIZE  = readPositiveInteger(process.env.RPC_BLOCK_HASH_CACHE_SIZE,  5000);
const RPC_EVENTS_AT_CACHE_SIZE   = readPositiveInteger(process.env.RPC_EVENTS_AT_CACHE_SIZE,   2000);
const blockCache      = new LRU(RPC_BLOCK_CACHE_SIZE);
const blockHashCache  = new LRU(RPC_BLOCK_HASH_CACHE_SIZE);
const eventsAtCache   = new LRU(RPC_EVENTS_AT_CACHE_SIZE);

function clearRpcCaches() {
    blockCache.clear();
    blockHashCache.clear();
    eventsAtCache.clear();
}

// Cached lookup: blockNumber -> Hash. Only safe for finalised heights, which
// is every block our indexer ever asks about (the head is fetched separately
// via getHeader()). On reconnect, clearRpcCaches() wipes the table so we
// don't serve a hash from a pre-reorg view.
async function getBlockHashCached(blockNumber) {
    // Guard against the brief window between a WsProvider disconnect and the
    // watchdog rebuilding globalApi — in-flight scan tasks can land here with
    // globalApi=null and otherwise throw a misleading TypeError.
    if (!isRpcReady()) throw new Error('rpc not ready (disconnected mid-fetch)');
    if (blockNumber === undefined || blockNumber === null) {
        // No-arg getBlockHash returns the current head; not cacheable.
        return await globalApi.rpc.chain.getBlockHash();
    }
    const key = String(blockNumber);
    const hit = blockHashCache.get(key);
    if (hit !== undefined) return hit;
    const hash = await globalApi.rpc.chain.getBlockHash(blockNumber);
    // toString() on a null/empty hash returns '0x000...'; don't cache misses.
    if (hash && hash.toHex && hash.toHex() !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
        blockHashCache.set(key, hash);
    }
    return hash;
}

// Cached lookup: blockHash -> SignedBlock. Always safe — the hash uniquely
// identifies the block content. Accepts either a string or a Hash codec; we
// key by hex so both forms hit the same entry.
async function getBlockCached(blockHash) {
    // See getBlockHashCached for the disconnect-race rationale.
    if (!isRpcReady()) throw new Error('rpc not ready (disconnected mid-fetch)');
    if (!blockHash) {
        // No-arg getBlock returns the current head's block; not cacheable.
        return await globalApi.rpc.chain.getBlock();
    }
    const key = typeof blockHash === 'string' ? blockHash : blockHash.toHex();
    const hit = blockCache.get(key);
    if (hit !== undefined) return hit;
    const block = await globalApi.rpc.chain.getBlock(blockHash);
    if (block) blockCache.set(key, block);
    return block;
}

function readPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Audit F-043: this was `Number(balance) / 10 ** 12`. A u128 above 2^53
// planck (≈9007 PDEX) loses low digits BEFORE the division, so large transfer
// amounts and whale balances were subtly wrong in the database and every KPI
// summed from them. BigInt splits whole tokens from the fractional remainder
// so precision loss is confined to sub-planck display rounding.
function formatPDEX(balance) {
    try {
        const planck = BigInt(balance.toString());
        const whole = planck / 1000000000000n;
        const frac = Number(planck % 1000000000000n) / 1e12;
        return Number(whole) + frac;
    } catch (e) {
        return Number(balance) / 10 ** 12;
    }
}

// Convert a chain Balance codec to a PDEX number safely for large u128 values.
function balanceToPDEX(balance) {
    // Same precision rules as formatPDEX (F-043) — Number(BigInt(x)) rounds
    // above 2^53 just like Number(x) does.
    return formatPDEX(balance);
}

// True when the string decodes as a valid SS58 address.
function isValidAddress(address) {
    try { decodeAddress(address); return true; }
    catch (e) { return false; }
}

// Canonicalise any SS58/hex address to the Polkadex-prefixed form so that
// indexed keys and lookups always match regardless of the input format.
function normalizeAddress(address) {
    return encodeAddress(decodeAddress(address), chainSS58);
}

function getCommissionPercent(prefs) {
    if (!prefs || !prefs.commission) return 0;
    const commission = prefs.commission.unwrap ? prefs.commission.unwrap() : prefs.commission;
    return (commission.toNumber() / 1000000000) * 100;
}

function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function chunkArray(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

async function getEraValidatorStake(api, era, address) {
    let totalStake = 0;
    if (api.query.staking.erasStakersOverview) {
        const overviewOpt = await api.query.staking.erasStakersOverview(era, address);
        if (overviewOpt.isSome) totalStake = overviewOpt.unwrap().total;
    } else if (api.query.staking.erasStakers) {
        const exposure = await api.query.staking.erasStakers(era, address);
        totalStake = exposure.total;
    }
    return totalStake && totalStake.unwrap ? totalStake.unwrap() : totalStake;
}

// In-flight dedupe: a cold request and the background pre-warm should share a
// single expensive computation rather than each hammering the RPC node with
// the per-validator queries + full ledger scan.
let networkInfoInFlight = null;

// Stale-while-revalidate read used by the API endpoints. Returns whatever is
// cached immediately — even slightly stale — and kicks a background refresh so
// the *next* read is fresh. Only a genuinely cold cache (nothing stored yet)
// blocks the caller on a full computation. This is what keeps the home page's
// "Network Information" panel from occasionally eating a multi-second recompute.
async function getNetworkInfo() {
    if (!globalApi) throw new Error('API not ready');
    const cacheData = db.getKv('network_info') || { networkInfo: null, lastSync: 0, status: 'Initializing' };
    const fresh = cacheData.networkInfo && (Date.now() - cacheData.lastSync < FIVE_MINUTES);
    if (fresh) return cacheData;
    if (cacheData.networkInfo) {
        // Stale but usable: serve now, refresh behind the scenes.
        refreshNetworkInfoInBackground();
        return { ...cacheData, status: 'Stale' };
    }
    // Cold cache (fresh process, never computed): compute once and wait.
    return await computeNetworkInfo();
}

// Fire-and-forget refresh. Safe to call frequently — it's deduped by the
// in-flight promise and gated on the RPC being connected.
function refreshNetworkInfoInBackground() {
    if (!isRpcReady()) return;
    computeNetworkInfo().catch(err => console.warn('[network-info] background refresh failed:', err && err.message ? err.message : err));
}

// Pre-warm the heavy row counts that drive /api/analytics/snapshot. Each
// SELECT COUNT(*) in this set is a full table scan in SQLite, and on the
// `events` table (~50M rows after backfill) that scan alone takes 30-60s.
// Running it inside the request blew past nginx's default proxy_read_timeout
// (60s) — see the upstream-timeout log lines from /api/analytics/snapshot.
// Pre-computing on a timer in the indexer worker only and storing in KV
// turns the HTTP endpoint into a single fast key-value read.
let isRefreshingAnalyticsCounts = false;
function refreshAnalyticsCountsInBackground() {
    if (isRefreshingAnalyticsCounts) return;
    isRefreshingAnalyticsCounts = true;
    const t0 = Date.now();
    try {
        const counts = {
            indexedBlocks:       db.countBlocks(),
            indexedEvents:       db.countEvents(),
            indexedTransactions: db.countTransactions(),
            indexedReferenda:    db.countDemocracyReferenda(),
            indexedThreads:      db.countThreads(),
            computedAt:          Date.now(),
            computeMs:           0,
        };
        counts.computeMs = Date.now() - t0;
        db.setKv('analytics_counts', counts);
        if (counts.computeMs > 5000) {
            console.log(`[analytics] counts refreshed in ${counts.computeMs}ms (blocks=${counts.indexedBlocks} events=${counts.indexedEvents} tx=${counts.indexedTransactions})`);
        }
    } catch (err) {
        console.warn('[analytics] counts refresh failed:', err && err.message ? err.message : err);
    } finally {
        isRefreshingAnalyticsCounts = false;
    }
}

// Pre-warm the analytics daily time-series for the ranges the UI actually uses
// (the 7d / 30d / 90d / Year pills). getDailyAnalytics runs GROUP-BY aggregates
// over transactions/blocks; computing it inline on every /api/analytics/timeseries
// request was the main reason the analytics page took a few seconds to load.
// Here the indexer worker computes it on a timer and stashes each range in KV,
// so the HTTP endpoint becomes a single fast key-value read. (The timestamp
// indexes added in initDb keep this refresh itself cheap.)
const ANALYTICS_TS_RANGES = [7, 30, 90, 365];
let isRefreshingAnalyticsTs = false;
function refreshAnalyticsTimeseriesInBackground() {
    if (isRefreshingAnalyticsTs) return;
    isRefreshingAnalyticsTs = true;
    const t0 = Date.now();
    try {
        for (const days of ANALYTICS_TS_RANGES) {
            const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
            const series = db.getDailyAnalytics(sinceTs);
            db.setKv('analytics_ts_' + days, { days, since: sinceTs, series, computedAt: Date.now() });
        }
        const ms = Date.now() - t0;
        if (ms > 3000) console.log(`[analytics] timeseries pre-warm in ${ms}ms`);
    } catch (err) {
        console.warn('[analytics] timeseries refresh failed:', err && err.message ? err.message : err);
    } finally {
        isRefreshingAnalyticsTs = false;
    }
}

// Separate, slow refresher for `totalUnlocking`. Reads every staking ledger
// on the chain to sum unbonding amounts — the heaviest single RPC operation
// in the app — and stores it in its own KV cache so computeNetworkInfo can
// reuse the result without re-running the scan each time. Deduped + gated.
let isRefreshingTotalUnlocking = false;
async function refreshTotalUnlockingInBackground() {
    if (isRefreshingTotalUnlocking || !isRpcReady()) return;
    isRefreshingTotalUnlocking = true;
    try {
        const ledgerEntries = await globalApi.query.staking.ledger.entries();
        let totalUnlocking = 0;
        for (const [, ledgerOpt] of ledgerEntries) {
            const ledger = ledgerOpt.isSome ? ledgerOpt.unwrap() : ledgerOpt;
            for (const unlocking of ledger.unlocking || []) {
                totalUnlocking += formatPDEX(unlocking.value);
            }
        }
        db.setKv('network_totalUnlocking', { value: totalUnlocking, lastSync: Date.now() });
    } catch (err) {
        console.warn('[network-info] totalUnlocking refresh failed:', err && err.message ? err.message : err);
    } finally {
        isRefreshingTotalUnlocking = false;
    }
}

// The heavy computation (dozens of validator queries + a full staking.ledger
// scan). Always writes the result to the `network_info` cache key. Concurrent
// callers share one run via networkInfoInFlight.
async function computeNetworkInfo() {
    if (!globalApi) throw new Error('API not ready');
    if (networkInfoInFlight) return networkInfoInFlight;
    networkInfoInFlight = (async () => {
    try {
    const activeEraOption = await globalApi.query.staking.activeEra();
    const activeEra = activeEraOption.isSome ? activeEraOption.unwrap().index.toNumber() : 0;
    const previousEra = Math.max(activeEra - 1, 0);
    const [
        totalIssuanceRaw,
        totalStakeRaw,
        previousTotalStakeRaw,
        validators,
        counterForValidators,
        counterForNominators,
        lastEraRewardsRaw
    ] = await Promise.all([
        globalApi.query.balances.totalIssuance(),
        globalApi.query.staking.erasTotalStake(activeEra),
        globalApi.query.staking.erasTotalStake(previousEra),
        globalApi.query.session.validators(),
        globalApi.query.staking.counterForValidators(),
        globalApi.query.staking.counterForNominators(),
        globalApi.query.staking.erasValidatorReward(previousEra)
    ]);

    const stakes = [];
    const commissions = [];
    const activeNominators = new Set();

    for (const chunk of chunkArray(validators, 25)) {
        const results = await Promise.all(chunk.map(async address => {
            const [prefs, exposure] = await Promise.all([
                globalApi.query.staking.validators(address),
                globalApi.query.staking.erasStakers(activeEra, address)
            ]);
            return { prefs, exposure };
        }));
        for (const { prefs, exposure } of results) {
            stakes.push(formatPDEX(exposure.total));
            commissions.push(getCommissionPercent(prefs));
            for (const nomination of exposure.others) activeNominators.add(nomination.who.toString());
        }
    }

    // `totalUnlocking` requires scanning every staking.ledger on the chain
    // (potentially thousands of entries) which is by far the most expensive
    // RPC operation in this function. It changes slowly, so we cache it
    // separately and let a dedicated background timer refresh it on a much
    // slower cadence — this single change reduces per-tick load dramatically
    // when getNetworkInfo runs.
    const cachedUnlocking = db.getKv('network_totalUnlocking') || { value: 0, lastSync: 0 };
    let totalUnlocking = Number(cachedUnlocking.value) || 0;
    // Kick the background refresh if the value is stale; we never block on it.
    if (Date.now() - (cachedUnlocking.lastSync || 0) > TOTAL_UNLOCKING_TTL_MS) {
        refreshTotalUnlockingInBackground();
    }

    const totalIssuance = formatPDEX(totalIssuanceRaw);
    const totalStake = formatPDEX(totalStakeRaw);
    const previousTotalStake = formatPDEX(previousTotalStakeRaw);
    const avgCommissionPct = average(commissions);
    // Headline "AVG APY": the chain's nominal max APY (23.09% — its target at
    // the ~50% staking ratio, the same base used for per-validator APY above)
    // discounted by the mean validator commission. Exposed server-side so API
    // consumers get the number the home page shows without recomputing it.
    const MAX_APY_BASE = 23.09;
    const avgApy = MAX_APY_BASE * (1 - avgCommissionPct / 100);
    const networkInfo = {
        activeEra,
        avgValidatorCommission: avgCommissionPct,
        avgApy,                 // headline AVG APY (%), commission-adjusted
        avg_apy: avgApy,        // snake_case alias for external integrators
        validators: {
            active: validators.length,
            total: Number(counterForValidators)
        },
        nominators: {
            active: activeNominators.size,
            total: Number(counterForNominators)
        },
        maxActiveStake: Math.max(...stakes),
        minStake: Math.min(...stakes),
        averageStake: average(stakes),
        avgStakePerAccount: activeNominators.size ? totalStake / activeNominators.size : 0,
        // `totalIssuance` is needed by the analytics snapshot endpoint (and
        // any future "staking ratio" derivation that doesn't want to reverse
        // it from totalBondingPercent). Keep it in the cached object so the
        // /api/analytics/snapshot reader doesn't have to call the chain.
        totalIssuance,
        totalBonding: totalStake,
        totalBondingPercent: totalIssuance ? (totalStake / totalIssuance) * 100 : 0,
        totalUnbonding: totalUnlocking,
        totalStakeChange: totalStake - previousTotalStake,
        lastEraRewardsTotal: formatPDEX(lastEraRewardsRaw)
    };

    const nextCacheData = {
        networkInfo,
        lastSync: Date.now(),
        status: 'Synced'
    };
    db.setKv('network_info', nextCacheData);
    return nextCacheData;
    } finally {
        networkInfoInFlight = null;
    }
    })();
    return networkInfoInFlight;
}

// Audit F-164 — `formatIdentityName` and `getOnChainIdentity` were defined
// here; they now come from lib/identity.js (imported at the top of this file)
// so the debug probes can run the SAME walk instead of a copy of it. Do not
// re-add local definitions: the sub-identity hop and the two identityOf
// storage shapes are the parts that drift, and drift is the finding.
//
// What stays here is the part that is genuinely server-only — the cache and
// the DISPLAY_NAME_OVERRIDES policy. A standalone probe must not inherit
// either: an override would make the probe report a name the chain does not
// have, which defeats the purpose of running it.
async function getIdentity(api, address) {
    const cacheKey = address.toString();
    const hasOverride = DISPLAY_NAME_OVERRIDES.has(cacheKey);
    if (!hasOverride && identityCache.has(cacheKey)) return identityCache.get(cacheKey);

    // If the api is currently unusable (in flight during a reconnect, for
    // example), return Unknown to the caller WITHOUT writing it to the cache.
    // Otherwise a brief reconnect window would poison the cache with false-
    // negative "Unknown" entries for addresses that DO have on-chain
    // identities, and we'd never look them up again.
    if (!api || !api.query || !api.query.identity) {
        return DISPLAY_NAME_OVERRIDES.get(cacheKey) || "Unknown";
    }

    // onError keeps the previous per-address warn. It is passed in rather than
    // baked into the helper so the probes can stay silent (or louder) without
    // changing what production logs.
    const onChainName = await getOnChainIdentity(api, address, {
        onError: (e, addr) => console.warn(`Identity lookup failed for ${String(addr)}:`, e.message)
    });
    if (onChainName !== "Unknown") {
        identityCache.set(cacheKey, onChainName);
        return onChainName;
    }

    const fallbackName = DISPLAY_NAME_OVERRIDES.get(cacheKey) || "Unknown";
    if (!hasOverride) identityCache.set(cacheKey, fallbackName);
    return fallbackName;
}

// Audit F-114: the fallback was Date.now() — so a block whose timestamp.set
// extrinsic couldn't be read got stamped with the moment the INDEXER looked at
// it. During the historical backfill that means a 2022 block dated today,
// which corrupts the analytics day-buckets and makes timeAgo nonsense. Null
// says "unknown", and callers already treat a null timestamp as unknown.
function getBlockTimestamp(signedBlock) {
    let timestamp = null;
    signedBlock.block.extrinsics.forEach((ex) => {
        if (ex.method.section === 'timestamp' && ex.method.method === 'set') timestamp = ex.method.args[0].toNumber();
    });
    return timestamp;
}

function getExtrinsicStatus(events, index) {
    const txEvents = events.filter(record => record.phase.isApplyExtrinsic && record.phase.asApplyExtrinsic.toNumber() === index);
    return txEvents.some(record => record.event.section === 'system' && record.event.method === 'ExtrinsicFailed') ? 'failed' : 'success';
}

function getExtrinsicMethod(ex) {
    return `${ex.method.section}.${ex.method.method}`;
}

// Audit F-045: the method table now lives in lib/extrinsic-summary.js, shared
// with script.js. Only the planck→PDEX converter differs between the two.
function getExtrinsicAmountSummary(ex) {
    return summarizeExtrinsicAmount(ex, formatPDEX, getExtrinsicMethod(ex));
}

// Audit F-049. `buildFinancialTransaction` lived here: it keyed a transfer row
// by `ex.hash.toHex()` — the EXTRINSIC hash — while the live crawler writes
// event-derived rows keyed `event-<blockHash>-<eventIndex>` (F-021). Both id
// schemes described the same on-chain Transfer, and `INSERT OR IGNORE` cannot
// collapse two different primary keys, so the same transfer could appear twice:
// once per source, with different ids, on the same block.
//
// It is deleted rather than fixed, because by the time F-021 landed nothing
// called it — the event-derived path is now the only writer, which is the
// property the finding actually wants. Leaving a working, plausible-looking
// builder in the file is how a future change re-introduces the second id
// scheme without anyone realising there ever was one.
//
// If a future feature needs a row built from an extrinsic rather than an event,
// it must produce the SAME id the event path would (see lib/tx-from-event.js
// `eventTxId`) or the duplicate returns.

// Audit F-114 (round 2). The catch used to `return Date.now()`.
//
// That is not a fallback, it is a fabrication: the caller stores the result as
// the block's timestamp, so an RPC hiccup while indexing block 4,000,000 wrote
// TODAY's wall-clock time onto a row from 2022. Nothing downstream can tell the
// difference — the column is an INTEGER either way — and the damage is
// permanent and silent:
//
//   * the analytics day-buckets (db.js, `WHERE timestamp >= ?`) put an
//     ancient transfer in this week's totals;
//   * a reward row carries a payout date that never happened, which is what a
//     nominator reconciles against for tax;
//   * a treasury/motion row sorts to the top of a "recent governance" list.
//
// The round-1 fix corrected the OTHER helper (getBlockTimestamp, which reads
// the timestamp.set extrinsic and now returns null) and left this one — which
// is the one all three indexers call.
//
// Returning null makes the failure visible instead of plausible. Every caller
// now refuses to write the block and queues it for retry, so an unreadable
// timestamp costs one re-fetch rather than a wrong row nobody will ever notice.
// `timestamp` is nullable in both schemas, so a stored null would not throw —
// but it would sort and bucket unpredictably, and "no row yet" is a state the
// gap-fill pass already knows how to fix.
// Audit F-006. When true (default), a block whose events could not be decoded
// is queued for retry rather than stored as a zero-event success. Set
// EVENTS_STRICT=0 on a PRUNED (non-archive) node, where historical event
// metadata is genuinely unavailable and retrying can never succeed — otherwise
// every old block accumulates a permanent failure and the index reports
// Degraded forever. explorer.polkadex.ee runs an archive node, so strict.
// How long an exhausted scan_failures row waits before its retry budget is
// returned. Matches the F-046 in-memory gap amnesty so the two do not drift.
const SCAN_AMNESTY_MS = readPositiveInteger(process.env.SCAN_AMNESTY_MS, 6 * 60 * 60 * 1000);

const EVENTS_STRICT = String(process.env.EVENTS_STRICT ?? '1') !== '0';

async function getBlockTimestampAt(blockHash) {
    try {
        return Number(await globalApi.query.timestamp.now.at(blockHash));
    } catch (err) {
        return null;
    }
}

// Compress polkadot.js's noisy multi-line decode errors into a single short
// summary suitable for a per-block warn line. The library packs full hex
// byte dumps and stacked codec context into err.message, which is great for
// debugging a single failure but turns the log into a wall of noise when
// hundreds of blocks fail. This keeps the diagnostic intent (what failed,
// roughly why) without the bytes.
function shortErrorMessage(err) {
    let msg = (err && err.message) ? err.message : String(err || '');
    // Replace long hex byte dumps (8+ hex chars) with an ellipsis.
    msg = msg.replace(/0x[0-9a-f]{8,}/gi, '0x…');
    // Collapse multi-line / multi-space into a single line.
    msg = msg.replace(/\s+/g, ' ').trim();
    if (msg.length > 200) msg = msg.slice(0, 200) + '…';
    return msg;
}

// Read system.events for a historical block using THAT block's runtime
// metadata instead of the current chain-tip metadata. Without this, decoding
// blocks produced under an older runtime fails with messages like:
//   "Unable to decode storage system.events:: createType(Lookup26):: Vec<EventRecord>::
//    Decoded input doesn't match input, received 0x… (64 bytes), created 0x… (67 bytes)"
// because the current Lookup26 definition of EventRecord has a different
// shape than the one in use at that block. `api.at(hash)` returns an
// ApiDecoration bound to that block's metadata; polkadot.js caches the
// decoration per runtime version, so this is cheap to call per-block.
//
// Returns null on failure (event prune'd, decode genuinely impossible, etc.)
// so callers can skip the block without a log explosion. The single concise
// warn is emitted by the caller, not here.
async function getEventsAtBlock(blockHash) {
    // Cache by hex form so callers passing a string vs. Hash codec hit the
    // same entry. The hash uniquely identifies the block, so cached events
    // are correct forever (until cleared on reconnect).
    const key = !blockHash ? null : (typeof blockHash === 'string' ? blockHash : blockHash.toHex());
    if (key) {
        const hit = eventsAtCache.get(key);
        if (hit !== undefined) return hit;
    }
    try {
        const apiAt = await globalApi.at(blockHash);
        const events = await apiAt.query.system.events();
        if (key && events) eventsAtCache.set(key, events);
        return events;
    } catch (_err) {
        // Don't cache misses — a transient failure may be retried, and we
        // want the retry to actually hit the chain.
        return null;
    }
}

function buildFinancialTransactionFromEvent(record, eventIndex, blockNumber, blockHash, timestamp) {
    const event = record.event;
    if (event.section !== 'balances' || event.method !== 'Transfer' || event.data.length < 3) return null;

    // Audit F-080: these were raw `.toString()` — whatever SS58 prefix the
    // codec happened to render — while getTransactionsByAddress compares the
    // stored string to the queried one. A prefix-42 and a prefix-88 encoding
    // of the SAME AccountId therefore returned different (often empty)
    // histories. staking_rewards already normalised at write time; transfers
    // now do the same, so one account has one spelling in the table.
    let from = event.data[0].toString();
    let to = event.data[1].toString();
    try { from = normalizeAddress(from); } catch (e) { /* keep raw */ }
    try { to = normalizeAddress(to); } catch (e) { /* keep raw */ }
    const numericAmount = formatPDEX(event.data[2]);
    return {
        // F-021: hash-keyed, so a fork row and its canonical replacement can
        // never collide under INSERT OR IGNORE. See lib/tx-from-event.js.
        hash: eventTxId(blockHash && blockHash.toString ? blockHash.toString() : blockHash, blockNumber, eventIndex),
        from,
        to,
        block: blockNumber,
        method: 'balances.Transfer',
        amount: `${numericAmount.toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX`,
        numericAmount,
        value: '-',
        status: 'success',
        timestamp,
        eventIndex,
        blockHash: blockHash.toString(),
        eventDerived: true
    };
}

function normalizeTransactionRecord(tx) {
    if (!tx || typeof tx !== 'object') return tx;
    if (typeof tx.amount === 'string' && tx.amount.includes('.') && (!tx.method || tx.value === 'System')) {
        return {
            ...tx,
            method: tx.method || tx.amount,
            to: tx.method || tx.amount,
            amount: '-',
            numericAmount: 0,
            value: '-'
        };
    }
    return tx;
}

function isFinancialTransactionRecord(tx) {
    if (!tx || tx.amount === '-' || tx.amount === undefined || tx.amount === null) return false;
    if (tx.method) {
        return [
            'balances.transfer',
            'balances.transferAllowDeath',
            'balances.transferKeepAlive',
            'balances.forceTransfer',
            'balances.transferAll',
            'balances.Transfer'
        ].includes(tx.method);
    }
    return tx.amount === 'All' || (typeof tx.amount === 'string' && tx.amount.includes('PDEX'));
}

function getCachedFinancialTransactions(cacheData) {
    return Array.isArray(cacheData.transactions)
        ? cacheData.transactions.map(normalizeTransactionRecord).filter(isFinancialTransactionRecord)
        : [];
}

function mergeFinancialTransactions(existingTransactions, incomingTransactions) {
    const transactionsByHash = new Map();
    for (const tx of existingTransactions) {
        if (tx && tx.hash) transactionsByHash.set(tx.hash, tx);
    }
    for (const tx of incomingTransactions) {
        if (!tx || !tx.hash) continue;
        transactionsByHash.set(tx.hash, {
            ...(transactionsByHash.get(tx.hash) || {}),
            ...tx
        });
    }

    return Array.from(transactionsByHash.values())
        .filter(isFinancialTransactionRecord)
        .sort((a, b) => {
            const blockDiff = (Number(b.block) || 0) - (Number(a.block) || 0);
            if (blockDiff !== 0) return blockDiff;
            return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
        })
        .slice(0, TX_CACHE_LIMIT);
}

// Scan one block for financial-transaction (transfer) events. Extracted
// from scanFinancialTransactions's inline Promise.all so the gap-fill
// retry phase in syncTransactions can share the same logic. Returns
// { blockNumber, transactions, ok } — see scanBlockForRewards for the
// rationale on the two-field shape.
async function scanBlockForTransactions(blockNumber) {
    try {
        const blockHash = await getBlockHashCached(blockNumber);
        const [events, timestamp] = await Promise.all([
            getEventsAtBlock(blockHash),
            getBlockTimestampAt(blockHash)
        ]);
        // Audit F-006 (round 2). `ok: true` here told the gap-fill pass "this
        // height is done", so the failure row was cleared and the watermark
        // advanced past a block whose events were never decoded. Any transfer
        // in it is absent from the index forever, and nothing anywhere records
        // that it might be. The chain indexer was fixed in round 1; the
        // transaction and reward scanners kept the old behaviour.
        //
        // EVENTS_STRICT=0 remains the pruned-node escape hatch: on a node that
        // has discarded historical state, un-decodable events are the expected
        // steady state and queueing every one of them just fills the table.
        if (!events) {
            if (!EVENTS_STRICT) return { blockNumber, transactions: [], ok: true };
            db.recordScanFailure('transactions', blockNumber,
                'events could not be decoded at this height (F-006)');
            return { blockNumber, transactions: [], ok: false };
        }
        // F-114: refuse to write rows stamped with a time we do not know.
        // The error text deliberately avoids the words requeueTransientScanFailures
        // matches on (rpc/websocket/disconnected/socket/econn…), or an amnesty
        // pass would reset the attempt counter forever.
        if (timestamp === null) {
            db.recordScanFailure('transactions', blockNumber,
                'block timestamp unavailable at this height (F-114)');
            return { blockNumber, transactions: [], ok: false };
        }
        const blockTransactions = [];
        events.forEach((record, eventIndex) => {
            const tx = buildFinancialTransactionFromEvent(record, eventIndex, blockNumber, blockHash, timestamp);
            if (tx) blockTransactions.push(tx);
        });
        return { blockNumber, transactions: blockTransactions, ok: true };
    } catch (err) {
        const short = shortErrorMessage(err);
        // Transport failure ≠ bad block: don't spend one of this block's
        // retry attempts on the node being down (see lib/rpc-errors.js).
        if (isRpcUnavailableError(err)) {
            console.warn(`Financial transaction scan deferred block ${blockNumber} (node unavailable, attempt not counted): ${short}`);
            return { blockNumber, transactions: [], ok: false, transient: true };
        }
        console.warn(`Financial transaction scan skipped block ${blockNumber}: ${short}`);
        db.recordScanFailure('transactions', blockNumber, short);
        return { blockNumber, transactions: [], ok: false };
    }
}

async function scanFinancialTransactions({
    startBlock,
    stopBlock = 0,
    limit = TX_CACHE_LIMIT,
    maxBlocks = TX_INITIAL_SCAN_BLOCKS,
    onProgress = null,
    progressInterval = 100,
    // F-078 intra-block resume: the height the caller already read part of,
    // and how many of its rows it received.
    skipBlock = -1,
    skipCount = 0
}) {
    const transactions = [];
    let scannedBlocks = 0;
    let lastScannedBlock = startBlock;
    let lastEmittedBlock = null;   // F-078: last height fully returned to the caller
    // F-078 intra-block paging: where to resume inside a partially-returned
    // height, and where the caller told us it had already read to.
    let resumeInBlock = null;
    const skipInBlock = { block: Number(skipBlock) || -1, count: Number(skipCount) || 0 };

    for (let nextBlock = startBlock; nextBlock >= stopBlock && transactions.length < limit && scannedBlocks < maxBlocks;) {
        const blockNumbers = [];
        while (nextBlock >= stopBlock && blockNumbers.length < TX_SCAN_BATCH_SIZE && scannedBlocks + blockNumbers.length < maxBlocks) {
            blockNumbers.push(nextBlock);
            nextBlock--;
        }
        if (blockNumbers.length === 0) break;

        // Per-block scan logic now lives in scanBlockForTransactions —
        // shared with the gap-fill retry phase in syncTransactions.
        const batchResults = await Promise.all(blockNumbers.map(scanBlockForTransactions));

        scannedBlocks += blockNumbers.length;
        lastScannedBlock = blockNumbers[blockNumbers.length - 1];
        // Audit F-078: the cursor used to be the oldest height in the BATCH,
        // regardless of where the `limit` cut the results. If the limit filled
        // mid-batch, every remaining tx in the batch's older blocks was
        // skipped — the next page started below them and those transfers were
        // unreachable through the UI. Track the last height we actually
        // emitted from, and stop the cursor there.
        // A review caught two defects in the first version of this. (1) It set
        // `truncatedAt` even when the limit was reached on a block's LAST tx —
        // a fully-drained block re-served every page. (2) Re-serving via
        // `truncatedAt + 1` meant that if the limit filled inside the FIRST
        // block of the scan, nextBeforeBlock came back equal to the caller's
        // beforeBlock: the cursor stalled and any block holding >= limit
        // transfers became a permanent dead end — the exact case F-078's close
        // test names. Fixed by tracking the leftover explicitly and paging
        // WITHIN the block by transaction offset.
        // The cursor arithmetic lives in lib/tx-paging.js, where its PROGRESS
        // and COMPLETENESS properties are asserted over simulated full runs.
        // It was written inline here twice and wrong both times (see that
        // file's header), so it is deliberately no longer inline.
        const page = planTxPage({
            blocks: batchResults,
            limit: limit - transactions.length,   // remaining budget for this scan
            skip: skipInBlock.block >= 0 ? skipInBlock : null
        });
        for (const tx of page.emitted) transactions.push(tx);
        if (page.nextBeforeBlock !== null && page.resumeInBlock === null) {
            lastEmittedBlock = page.nextBeforeBlock;
        }
        if (page.resumeInBlock) {
            lastEmittedBlock = page.resumeInBlock.block + 1;
            resumeInBlock = page.resumeInBlock;
            break;
        }

        if (onProgress && (scannedBlocks % progressInterval === 0 || transactions.length >= limit)) {
            await onProgress({
                transactions,
                scannedBlocks,
                oldestScannedBlock: lastScannedBlock,
                nextBeforeBlock: Math.max(lastScannedBlock, 0)
            });
        }
    }

    return {
        transactions,
        scannedBlocks,
        // F-078: prefer the last height whose transactions were actually
        // returned; fall back to the scan floor when nothing matched (a run of
        // transfer-free blocks still has to advance or paging would stall).
        nextBeforeBlock: lastEmittedBlock !== null
            ? Math.max(lastEmittedBlock, 0)
            : (scannedBlocks > 0 ? Math.max(lastScannedBlock, 0) : Math.max(startBlock, 0)),
        // Non-null when the last height was only partly returned: the caller
        // echoes these back so the next page resumes mid-block instead of
        // stalling or re-serving rows.
        resumeInBlock,
        oldestScannedBlock: scannedBlocks > 0 ? lastScannedBlock : 0
    };
}

async function applyDisplayNameOverridesToHolders(holders) {
    return Promise.all(holders.map(async holder => {
        if (!DISPLAY_NAME_OVERRIDES.has(holder.address)) return holder;
        if (!globalApi) {
            return {
                ...holder,
                name: holder.name && holder.name !== "Unknown" ? holder.name : DISPLAY_NAME_OVERRIDES.get(holder.address)
            };
        }
        return { ...holder, name: await getIdentity(globalApi, holder.address) };
    }));
}

async function syncValidatorHistory(activeEra, validators) {
    if (!globalApi || !globalApi.query.staking.erasValidatorPrefs) return;

    const validatorAddresses = validators.map(address => address.toString());

    // Clamp the window to the chain's own HistoryDepth.
    //
    // staking.erasValidatorPrefs is PRUNED past HistoryDepth (84 by default)
    // and is a ValueQuery, so reading a pruned era returns default prefs —
    // 0% commission — rather than failing. Because upsertValidatorHistory is
    // INSERT OR REPLACE, setting VALIDATOR_HISTORY_ERAS above HistoryDepth
    // would write 0% rows for every validator for every pruned era AND
    // overwrite anything true we had already stored there. That is a genuine
    // history rewrite, triggerable by one env var, and it would feed straight
    // into the commission-history feature as fabricated "raised from 0%" moves.
    let depthCap = VALIDATOR_HISTORY_ERAS;
    try {
        const hd = Number(globalApi.consts?.staking?.historyDepth ?? 0);
        if (Number.isFinite(hd) && hd > 0 && VALIDATOR_HISTORY_ERAS > hd) {
            console.warn(`[validators] VALIDATOR_HISTORY_ERAS=${VALIDATOR_HISTORY_ERAS} exceeds the chain's historyDepth=${hd}; clamping. Eras beyond it are pruned and would read back as 0% commission.`);
            depthCap = hd;
        }
    } catch (e) { /* consts unavailable — keep the configured value */ }

    const firstEra = Math.max(activeEra - depthCap + 1, 0);
    const historyRows = [];
    const perAddress = {};

    for (let era = activeEra; era >= firstEra; era--) {
        for (const address of validators) {
            const addrStr = address.toString();
            try {
                const [prefs, totalStake] = await Promise.all([
                    globalApi.query.staking.erasValidatorPrefs(era, address),
                    getEraValidatorStake(globalApi, era, address)
                ]);
                const commission = getCommissionPercent(prefs);
                const row = { era, address: addrStr, commission, stake: formatPDEX(totalStake), apy: 23.09 * (1 - (commission / 100)) };
                historyRows.push(row);
                (perAddress[addrStr] = perAddress[addrStr] || []).push(row);
            } catch (err) {
                console.warn(`Validator history skipped ${addrStr} era ${era}:`, err.message);
            }
        }
    }

    // UPSERT keeps eras already stored, so history grows past the rolling window.
    db.upsertValidatorHistory(historyRows);
    for (const address of validatorAddresses) {
        // F-115: derive from the FULL stored history, not just the eras this
        // pass happened to scan. upsertValidatorHistory above has already
        // folded the new rows in, so reading back gives every era we have ever
        // seen — which is the only way a cross older than the rolling window
        // survives. Merging (not replacing) keeps it that way even if a future
        // caller passes a partial set.
        const stored = db.getValidatorHistory(address);
        const rows = (stored && stored.length ? stored : (perAddress[address] || []))
            .slice().sort((a, b) => a.era - b.era);
        db.mergeValidatorTriggers(address, getCommissionTriggers(rows));
    }
}

function getCommissionTriggers(history) {
    const triggers = [];
    const chronologicalHistory = [...history].sort((a, b) => a.era - b.era);
    for (let i = 1; i < chronologicalHistory.length; i++) {
        const prev = chronologicalHistory[i - 1];
        const current = chronologicalHistory[i];
        if (prev.commission <= 50 && current.commission > 50) {
            triggers.push({
                era: current.era,
                prevCommission: prev.commission,
                newCommission: current.commission,
                timestamp: Date.now()
            });
        }
    }
    return triggers;
}

// Realized APR over a sliding time window.
//
// Formula:
//   APR_window = (annualised_rewards / bondedAmount) × 100%
//   annualised_rewards = (window_rewards / window_span_days) × 365
//
// Notes:
//   • `windowDays` = null → use the user's entire claimed history.
//   • We use the ACTUAL time span of rewards inside the window, not the
//     window cap itself, so an account with only 5 days of claim history
//     doesn't get a misleadingly small 30-day APR. The min-span floor of
//     1 day keeps a single same-day reward from blowing up the annualised
//     number to infinity.
//   • Returns null when there's no data to compute against (no rewards in
//     window, or zero bonded amount).
function computeRealizedApr(claimed, bondedAmount, nowTs, windowDays) {
    if (!bondedAmount || bondedAmount <= 0) return null;
    if (!Array.isArray(claimed) || !claimed.length) return null;
    const cutoff = windowDays ? (nowTs - windowDays * 86400000) : 0;
    const inWindow = claimed.filter(r => r.timestamp && r.timestamp >= cutoff);
    if (!inWindow.length) return null;
    const totalRewards = inWindow.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const oldest = Math.min(...inWindow.map(r => Number(r.timestamp) || nowTs));
    const spanMs = Math.max(86400000, nowTs - oldest); // floor at 1 day
    const spanDays = spanMs / 86400000;
    const annualised = (totalRewards / spanDays) * 365;
    return (annualised / bondedAmount) * 100;
}

async function loadValidatorHistory(address) {
    if (!globalApi || !globalApi.query.staking.erasValidatorPrefs) return { history: [], triggers: [] };

    const activeEraOption = await globalApi.query.staking.activeEra();
    const activeEra = activeEraOption.isSome ? activeEraOption.unwrap().index.toNumber() : 0;
    const firstEra = Math.max(activeEra - VALIDATOR_HISTORY_ERAS + 1, 0);
    const history = [];

    for (let era = activeEra; era >= firstEra; era--) {
        try {
            const [prefs, totalStake] = await Promise.all([
                globalApi.query.staking.erasValidatorPrefs(era, address),
                getEraValidatorStake(globalApi, era, address)
            ]);
            const commission = getCommissionPercent(prefs);
            history.push({
                era,
                commission,
                stake: formatPDEX(totalStake),
                apy: 23.09 * (1 - (commission / 100))
            });
        } catch (err) {
            console.warn(`Validator history skipped ${address} era ${era}:`, err.message);
        }
    }

    // F-115: persist the freshly-scanned eras first, then derive triggers from
    // everything we hold — the scan covers a rolling window, the table does not.
    db.upsertValidatorHistory(history.map(h => ({ era: h.era, address, commission: h.commission, stake: h.stake, apy: h.apy })));
    const stored = db.getValidatorHistory(address);
    const triggers = getCommissionTriggers(stored && stored.length ? stored : history);
    db.mergeValidatorTriggers(address, triggers);

    return { history, triggers };
}

// =============================================================================
// Developer / chain-inspection API  ("polkadot.js Apps parity")
// =============================================================================
// Generic, READ-ONLY access to runtime metadata, storage and constants at any
// block, so the explorer can replace polkadot.js Apps for chain forensics —
// e.g. reading OCEX.Authorities(6280) at block 12,250,870 and comparing it
// against OCEX.Authorities(9223372036854775808).
//
// Three invariants hold everywhere below:
//
//  1. READ ONLY. Only api.query / api.consts / an allowlisted set of read RPCs
//     are reachable. api.tx is never touched, so no endpoint here can submit an
//     extrinsic no matter what it's fed.
//
//  2. ARGUMENTS STAY STRINGS. Storage keys are passed to polkadot-js exactly as
//     the client sent them, never via JSON.parse or Number(). A u64 key like
//     9223372036854775808 (2^63) is far beyond Number.MAX_SAFE_INTEGER
//     (9007199254740991) — parsing it as a JS number silently returns
//     9223372036854776000 and you'd query the WRONG key while the UI showed the
//     right one. That failure mode is invisible and would quietly corrupt
//     exactly the forensic answers this API exists to provide.
//
//  3. BOUNDED. Public and unauthenticated, so every path is rate limited, time
//     limited, and size capped — an arbitrary storage query is otherwise a
//     first-class DoS vector against the chain RPC node.
// =============================================================================

// Per-IP rate limit for the developer endpoints.
//
// Audit F-075: this stays an in-process sliding window, but the budget is now
// DIVIDED by the worker count so the number we advertise is the number the
// cluster enforces in aggregate. Previously each of up to 8 workers enforced
// the full 60/min against its own share of the traffic, so the real limit was
// up to 480/min — wrong by a factor that grew every time the host got more
// cores, and invisible from outside.
//
// It stays per-process rather than moving to the shared SQLite counter (as
// auth and email signup did) because this is the HIGH-VOLUME surface: a row
// write per request would make the limiter itself the bottleneck it exists to
// prevent. The trade is stated plainly rather than hidden — the division is
// approximate under uneven load balancing, and approximate-and-documented
// beats exact-sounding-and-wrong.
const DEV_API_RATE_LIMIT_PER_MIN = readPositiveInteger(process.env.DEV_API_RATE_LIMIT_PER_MIN, 60);
const devApiHits = new Map(); // ip -> [timestamps]
// Resolved lazily: WORKERS is computed further down the file.
let devApiPerWorkerLimit = null;

function devApiRateOk(ip) {
    if (devApiPerWorkerLimit === null) {
        devApiPerWorkerLimit = perWorkerLimit(DEV_API_RATE_LIMIT_PER_MIN, WORKERS);
        if (devApiPerWorkerLimit !== DEV_API_RATE_LIMIT_PER_MIN) {
            console.log(`[rate-limit] dev API: ${DEV_API_RATE_LIMIT_PER_MIN}/min advertised → ${devApiPerWorkerLimit}/min per worker × ${WORKERS} workers (F-075)`);
        }
    }
    const res = checkWindow(devApiHits.get(ip), {
        windowMs: 60 * 1000, limit: devApiPerWorkerLimit
    });
    devApiHits.set(ip, res.kept);
    return res.allowed;
}
// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
    const cutoff = Date.now() - 60 * 1000;
    for (const [ip, arr] of devApiHits) {
        const live = arr.filter(t => t > cutoff);
        if (live.length) devApiHits.set(ip, live); else devApiHits.delete(ip);
    }
}, 5 * 60 * 1000).unref();

// Audit F-019 — see lib/client-ip.js for why the leftmost X-Forwarded-For was
// the wrong value and what replaced it. ONE definition, used by every limiter:
// the old code had this expression written out twice (here and in the email
// signup handler), which is how a trust decision drifts.
function clientIp(req) {
    return resolveClientIp(req.headers, req.socket && req.socket.remoteAddress) || req.ip || 'unknown';
}

// Gate shared by every developer endpoint: rate limit + live RPC.
function devApiGate(req, res) {
    if (!devApiRateOk(clientIp(req))) {
        res.set('Cache-Control', 'no-store');
        res.status(429).json({ error: `Too many requests — the developer API allows ${DEV_API_RATE_LIMIT_PER_MIN} queries per minute per IP.` });
        return false;
    }
    return requireRpc(res);
}

// Audit F-038: the /api/diag/* endpoints print operational internals — the
// live POLKADEX_WS URL (a private archive node is exactly the thing an
// attacker wants a map of post-Perfctl), worker pids, the SubQuery endpoint,
// and the email provider's from-address + readiness (phishing prep). They
// were reachable by anyone. Gate them behind a shared secret:
//   - DIAG_TOKEN set   → require the token in a REQUEST HEADER, either
//     `Authorization: Bearer <token>` or `X-Diag-Token: <token>`.
//   - DIAG_TOKEN unset → loopback callers only (operator on the box via
//     `curl 127.0.0.1:3001/...`; nginx-proxied traffic arrives with a
//     non-loopback X-Forwarded-For and is refused).
// Monitors that used to keyword-match these URLs should point at the public
// /api/health below, which returns only { healthy } with no URLs, pids, or
// email fields.
//
// ─── Audit F-193: why `?token=` is refused rather than merely discouraged ────
//
// This gate used to read `bearer || req.query.token`, and .env.example taught
// the query form as the monitor recipe. A secret in a URL is not a secret in
// one place — the same string is simultaneously written into:
//
//   * the operator's shell history and the monitoring vendor's stored config
//     (UptimeRobot/BetterStack show the full URL in their UI and their alert
//     emails, so the token leaves the operator's control the moment it is
//     pasted in);
//   * every intermediary's request line — Cloudflare's HTTP logs and analytics
//     see the full path+query even though the origin nginx was fixed under
//     F-091 to log `$uri` only. F-091 closed OUR log, not the edge's;
//   * the Referer header of anything the response links to, and the browser
//     history / autocomplete of whoever opened the URL to "just check".
//
// None of those are fixed by rotating the token, because the next monitor URL
// leaks it exactly the same way. Headers are not logged by any of the above by
// default, so the header form is the only one that keeps the secret to the two
// endpoints of the connection.
//
// If this is reverted to accept `req.query.token`, nothing appears to break —
// which is the whole problem. The gate still answers 200 for the operator, the
// tests that only check "wrong token is refused" still pass, and the leak is
// invisible until the token turns up somewhere it was never typed.
const DIAG_TOKEN = (process.env.DIAG_TOKEN || '').trim();
function diagGate(req, res) {
    res.set('Cache-Control', 'no-store');
    // Audit F-074: the diag routes had no rate limit at all, and
    // /api/diag/subquery-lag makes an OUTBOUND request per call — an
    // amplification proxy for anyone holding (or guessing at) the token.
    // Reuse the dev-API limiter so the budget is shared and per-IP.
    if (!devApiRateOk(clientIp(req))) {
        res.status(429).json({ error: 'Too many diagnostic requests.' });
        return false;
    }
    if (DIAG_TOKEN) {
        const auth = String(req.headers['authorization'] || '');
        const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        // X-Diag-Token is the alternative for monitors that cannot send an
        // Authorization header without also enabling some auth scheme of their
        // own. Both are headers; neither ends up in a log line or a Referer.
        const header = String(req.headers['x-diag-token'] || '').trim();
        const supplied = bearer || header;
        if (supplied && supplied === DIAG_TOKEN) return true;
        // F-193: a caller who put the token in the query string gets a distinct
        // 403 telling them where to move it. Answering a generic 401 here would
        // read as "wrong token" and send the operator off rotating a token that
        // was never wrong — and the token would stay in the monitor URL while
        // they looked. The token itself is never echoed back.
        if (req.query && req.query.token !== undefined) {
            res.status(403).json({
                error: 'diagnostics no longer accept a ?token= query parameter — a URL-borne secret ' +
                       'is recorded by Cloudflare, browser history and Referer headers. Send it as ' +
                       '`Authorization: Bearer <token>` or `X-Diag-Token: <token>` instead. Header-less ' +
                       'uptime monitors should point at the public /api/health.'
            });
            return false;
        }
        res.status(401).json({ error: 'diagnostics require a valid token in an Authorization: Bearer or X-Diag-Token header' });
        return false;
    }
    // No token configured: only trust a socket-level loopback connection that
    // was NOT proxied (nginx always adds X-Forwarded-For).
    const sock = (req.socket && req.socket.remoteAddress) || '';
    const isLoopback = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
    // Both proxy headers must be absent: nginx sets X-Forwarded-For AND
    // X-Real-IP, so requiring neither keeps this to a genuine on-box curl.
    if (isLoopback && !req.headers['x-forwarded-for'] && !req.headers['x-real-ip']) return true;
    res.status(403).json({ error: 'diagnostics are operator-only (set DIAG_TOKEN to enable remote access)' });
    return false;
}

const DEV_API_TIMEOUT_MS = readPositiveInteger(process.env.DEV_API_TIMEOUT_MS, 20000);

// Chain queries can hang when the node is unhealthy; never let one pin a
// worker (these are synchronous-ish awaits on a shared event loop).
// ─── Audit F-073: what a timeout can and cannot do here ─────────────────────
//
// The finding asks for an abort signal so a timed-out query stops running on
// the shared WsProvider. That is not available: @polkadot/api 10.13.1 exposes
// no cancellation on `api.query.*()`, `api.rpc.*` or `entriesPaged`, and the
// version is pinned hard (removing the pin breaks wallet signing — see the
// CheckMetadataHash note at both ApiPromise.create sites). Claiming to cancel
// would be worse than the current behaviour, because the next reader would
// stop worrying about the load.
//
// So this does the three things that ARE achievable, and says plainly that
// cancellation is not one of them:
//
//   1. STOP THE ABANDONED REJECTION ESCALATING. Promise.race leaves the loser
//      unhandled. When it eventually rejects — and a query slow enough to hit
//      our timeout very often does — it reaches process.on('unhandledRejection'),
//      which for a polkadot WS request timeout calls rebuildApiOnce(). So a
//      single slow dev-API query could tear down and rebuild the shared
//      WebSocket that every other request and all four indexers depend on.
//      The timeout was making the problem it exists to contain strictly worse.
//
//   2. BOUND THE IN-FLIGHT WORK. Since the query keeps running, the only way
//      to stop a client's retries from multiplying load on rpc.polkadex.ee is
//      to cap how many can be outstanding at once and shed the rest fast. A
//      429-shaped rejection here is honest: we are refusing, not timing out.
//
//   3. Keep the timer unref'd so a pending timeout never holds the process open.
const DEV_RPC_MAX_INFLIGHT = readPositiveInteger(process.env.DEV_RPC_MAX_INFLIGHT, 12);
let devRpcInflight = 0;

function withTimeout(promise, ms = DEV_API_TIMEOUT_MS, label = 'query') {
    // The abandoned-loser guard. Attaching .catch() to the ORIGINAL promise
    // marks it handled for the global hook while leaving the value/rejection
    // available to the race below — a promise can have many reactions.
    Promise.resolve(promise).catch((err) => {
        // Deliberately swallowed. This is the copy the caller stopped waiting
        // for; the race already reported the timeout to them. Logged at debug
        // level only, because during an RPC brownout this fires a lot and the
        // useful signal is the timeout line, not this one.
        if (process.env.DEBUG_RPC) {
            console.warn(`[rpc] abandoned ${label} rejected after its timeout:`, err && err.message);
        }
    });

    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            if (timer.unref) timer.unref();
        })
    ]).finally(() => { if (timer) clearTimeout(timer); });
}

// Run an uncancellable RPC call under an in-flight cap.
//
// Used by the developer endpoints, which are the ones that can issue expensive
// unbounded reads. Refusing immediately is better than queueing: a queued
// request still holds a socket and still eventually runs the query, which is
// the load we are trying to avoid.
async function withRpcBudget(label, fn) {
    if (devRpcInflight >= DEV_RPC_MAX_INFLIGHT) {
        const err = new Error(`Too many chain queries in flight (${devRpcInflight}/${DEV_RPC_MAX_INFLIGHT}). Please retry shortly.`);
        err.statusCode = 503;
        throw err;
    }
    devRpcInflight++;
    try {
        return await fn();
    } finally {
        devRpcInflight--;
    }
}

// Human-readable type name for a metadata type id.
function typeName(typeId) {
    try { return globalApi.registry.lookup.getTypeDef(typeId).type; }
    catch (e) { return 'unknown'; }
}

// Describe one storage entry: how many keys it needs and of what types. The
// UI uses this to render the right number of typed inputs, and the query
// endpoint uses keyCount to reject malformed calls before touching the node.
function describeStorageEntry(pallet, item) {
    const entry = globalApi.query[pallet] && globalApi.query[pallet][item];
    if (!entry || !entry.creator || !entry.creator.meta) return null;
    const meta = entry.creator.meta;
    const out = {
        pallet, item,
        modifier: meta.modifier ? meta.modifier.toString() : null,
        docs: (meta.docs || []).map(d => d.toString().trim()).filter(Boolean),
        keyCount: 0,
        keyTypes: [],
        valueType: null
    };
    try {
        if (meta.type.isPlain) {
            out.valueType = typeName(meta.type.asPlain.toNumber());
        } else if (meta.type.isMap) {
            const map = meta.type.asMap;
            // V14+ metadata models single/double/N maps uniformly: the number
            // of hashers is the number of keys.
            out.keyCount = map.hashers.length;
            const keyTypeName = typeName(map.key.toNumber());
            out.keyTypes = out.keyCount > 1
                ? keyTypeName.replace(/^\(|\)$/g, '').split(',').map(s => s.trim())
                : [keyTypeName];
            out.valueType = typeName(map.value.toNumber());
        }
    } catch (e) { /* leave partial description */ }
    return out;
}

// ---- GET /api/rpc/metadata --------------------------------------------------
// Everything the UI needs to build polkadot.js-style dropdowns: pallets, their
// storage entries (with key arity + types), constants, calls, events, errors.
// Cached per runtime spec version — metadata only changes on a runtime upgrade.
let devMetadataCache = { specVersion: null, payload: null };

app.get('/api/rpc/metadata', async (req, res) => {
    if (!devApiGate(req, res)) return;
    try {
        const specVersion = globalApi.runtimeVersion.specVersion.toNumber();
        if (devMetadataCache.specVersion === specVersion && devMetadataCache.payload) {
            cacheLong(res);
            return res.json(devMetadataCache.payload);
        }

        // Resolve a metadata pallet name to the key polkadot-js actually uses on
        // api.query / api.consts / api.tx.
        //
        // Naively lowercasing the first character is WRONG for all-caps pallet
        // names: "OCEX" becomes "oCEX", but polkadot-js camelCases it to "ocex".
        // The lookup then misses and the pallet is reported as having ZERO
        // storage items — so OCEX, the very pallet under investigation, was
        // invisible in the metadata while /api/state/ocex/... worked fine.
        // Match against the real key list instead of guessing at the spelling.
        const queryKeyIndex = new Map();
        const normKey = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const k of Object.keys(globalApi.query)) queryKeyIndex.set(normKey(k), k);

        const pallets = [];
        for (const p of globalApi.runtimeMetadata.asLatest.pallets) {
            const name = p.name.toString();
            const q = queryKeyIndex.get(normKey(name))
                   || (name.charAt(0).toLowerCase() + name.slice(1));
            const storage = [];
            if (globalApi.query[q]) {
                for (const item of Object.keys(globalApi.query[q]).sort()) {
                    const d = describeStorageEntry(q, item);
                    if (d) storage.push(d);
                }
            }
            const constants = [];
            if (globalApi.consts[q]) {
                for (const c of Object.keys(globalApi.consts[q]).sort()) constants.push(c);
            }
            pallets.push({
                name, queryKey: q,
                storage, constants,
                calls:  p.calls.isSome  ? (globalApi.tx[q]  ? Object.keys(globalApi.tx[q]).sort()  : []) : [],
                events: p.events.isSome ? (globalApi.events[q] ? Object.keys(globalApi.events[q]).sort() : []) : [],
                errors: p.errors.isSome ? (globalApi.errors[q] ? Object.keys(globalApi.errors[q]).sort() : []) : []
            });
        }

        const payload = {
            chain: (await globalApi.rpc.system.chain()).toString(),
            specName: globalApi.runtimeVersion.specName.toString(),
            specVersion,
            ss58Prefix: chainSS58,
            palletCount: pallets.length,
            pallets
        };
        devMetadataCache = { specVersion, payload };
        cacheLong(res);
        res.json(payload);
    } catch (err) {
        res.set('Cache-Control', 'no-store');
        serverError(res, err, req.path);
    }
});

// Resolve an ?at= parameter (block number or hash) to a block hash, or null
// for "current head". Kept separate so every endpoint treats `at` identically.
async function resolveAtBlock(at) {
    if (at === undefined || at === null || at === '') return null;
    const raw = String(at).trim();
    if (/^\d+$/.test(raw)) {
        const hash = await globalApi.rpc.chain.getBlockHash(parseInt(raw, 10));
        if (hash.isEmpty) throw new Error(`Block ${raw} not found`);
        return { hash: hash.toHex(), block: parseInt(raw, 10) };
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(raw)) {
        const header = await globalApi.rpc.chain.getHeader(raw);
        return { hash: raw, block: header.number.toNumber() };
    }
    throw new Error(`Invalid 'at' value: expected a block number or 0x-prefixed 32-byte hash, got "${raw}"`);
}

// Historical state reads need an ARCHIVE node. A pruned node keeps only the
// last ~256 blocks of state and fails with "State already discarded". Turn
// that into an explanation rather than a raw RPC error.
// Audit F-084 (round 2). This used to return `err.message` — verbatim, to the
// client, on four public 500s.
//
// The pruning case is a genuinely useful thing to tell a caller, and that is
// what kept the raw message here: the polkadot.js text ("state already
// discarded at 0x…") is how a developer learns their query needs an archive
// node. But the same return path also carried every OTHER error, and those
// messages describe our infrastructure — a failed WS dial names the internal
// endpoint host and port, a decode failure spills a hex byte dump with codec
// internals. None of it helps the caller and all of it is free reconnaissance.
//
// So: recognise the one case worth explaining, describe it in OUR words, and
// give everything else a fixed sentence. `code` is the part a client should
// branch on, matching the RPC_NOT_READY convention.
//
// PRUNED_STATE is deliberately NOT a 500 at the call sites below — it is a
// fact about the requested block, not a fault on our side. The caller can act
// on it (ask for a recent block, or point at an archive node); a 500 tells
// them to retry, which will never work.
//
// The archive-node guidance that used to live in this string now lives on
// /developers, where it can be a paragraph rather than an error message.
function archiveHint(err, at) {
    const msg = String(err && err.message || err);
    if (/state already discarded|unknown block|not available|pruned/i.test(msg) && at) {
        return {
            status: 409,
            body: {
                error: `Block ${at.block} is outside this node's pruning window. Historical state requires an archive node — see /developers for how to point a client at one.`,
                code: 'PRUNED_STATE'
            }
        };
    }
    return {
        status: 500,
        body: {
            error: 'Internal error while reading chain state. If this persists, please report it with the time and the URL.',
            code: 'INTERNAL'
        }
    };
}

// Serialise a codec value into every representation a forensic user needs.
// `human` can hide anomalies (it formats big numbers with separators and
// shortens hashes), so `json` and `hex` are always returned alongside it.
function serialiseCodec(value) {
    const out = { isEmpty: undefined, human: undefined, json: undefined, hex: undefined, count: undefined };
    try { out.isEmpty = value.isEmpty; } catch (e) { /* not all codecs expose it */ }
    try { out.human = value.toHuman(); } catch (e) { out.human = null; }
    try { out.json = value.toJSON(); } catch (e) { out.json = null; }
    try { out.hex = value.toHex(); } catch (e) { out.hex = null; }
    // Vec-like results (e.g. a validator set) — surface the length directly so
    // "is this empty or does it hold 200 validators?" is answerable at a glance.
    if (Array.isArray(out.json)) out.count = out.json.length;
    return out;
}

// ---- GET /api/state/:pallet/:item -------------------------------------------
// Generic storage read. Examples:
//   /api/state/ocex/authorities?args=6280&at=12250870
//   /api/state/ocex/authorities?args=9223372036854775808&at=12250870
//   /api/state/staking/activeEra
//   /api/state/system/account?args=esoEt6...
// Multiple keys: repeat ?args= or pass a comma-separated list.
const DEV_API_MAX_ENTRIES = readPositiveInteger(process.env.DEV_API_MAX_ENTRIES, 100);

app.get('/api/state/:pallet/:item', async (req, res) => {
    if (!devApiGate(req, res)) return;
    let at = null;
    try {
        const pallet = String(req.params.pallet).trim();
        const item = String(req.params.item).trim();

        if (!globalApi.query[pallet]) {
            return res.status(404).json({ error: `Unknown pallet "${pallet}".`, hint: 'GET /api/rpc/metadata lists every queryable pallet.' });
        }
        if (!globalApi.query[pallet][item]) {
            return res.status(404).json({
                error: `Unknown storage item "${pallet}.${item}".`,
                available: Object.keys(globalApi.query[pallet]).sort().slice(0, 50)
            });
        }

        const desc = describeStorageEntry(pallet, item);

        // Args arrive as raw strings and STAY strings — see invariant 2 at the
        // top of this section. Passing 9223372036854775808 through Number()
        // would silently query 9223372036854776000 instead.
        let args = [];
        if (req.query.args !== undefined) {
            const raw = Array.isArray(req.query.args) ? req.query.args : [req.query.args];
            args = raw.flatMap(a => String(a).split(',')).map(s => s.trim()).filter(s => s !== '');
        }

        at = await resolveAtBlock(req.query.at);
        const q = at ? (await withTimeout(globalApi.at(at.hash), DEV_API_TIMEOUT_MS, 'api.at')).query : globalApi.query;
        const entry = q[pallet] && q[pallet][item];
        if (!entry) {
            return res.status(404).json({ error: `"${pallet}.${item}" does not exist in the runtime at that block.` });
        }

        // No keys supplied for a map → that's an .entries() scan. Genuinely
        // useful, but unbounded on a large map, so it must be asked for
        // explicitly and is hard-capped.
        if (desc && desc.keyCount > 0 && args.length === 0) {
            if (String(req.query.entries) !== '1') {
                return res.status(400).json({
                    error: `${pallet}.${item} is a map needing ${desc.keyCount} key(s); none were supplied.`,
                    keyTypes: desc.keyTypes,
                    hint: `Pass ?args=<key>, or ?entries=1 to list the first ${DEV_API_MAX_ENTRIES} entries.`
                });
            }
            // Audit F-018: this called `entry.entries()` — UNBOUNDED — and only
            // then sliced to DEV_API_MAX_ENTRIES. The HTTP body was capped; the
            // RPC work never was. The chain node materialised the entire
            // storage map, shipped every (key, value) pair over the wire, and
            // this worker decoded all of them before throwing away all but 100.
            // On a big map that is a one-request denial of service against
            // rpc.polkadex.ee — which is the same endpoint the wallet dials to
            // sign — reachable by any anonymous caller.
            //
            // entriesPaged fetches exactly one page. We ask for one extra row
            // beyond the cap purely to learn whether more exist.
            const pageSize = DEV_API_MAX_ENTRIES + 1;
            let page;
            try {
                page = await withRpcBudget('entriesPaged', () =>
                    withTimeout(entry.entriesPaged({ args: [], pageSize }), DEV_API_TIMEOUT_MS, 'entriesPaged'));
            } catch (pagedErr) {
                // Some runtimes/older metadata don't expose entriesPaged for a
                // given entry. Refuse rather than silently falling back to the
                // unbounded walk this finding is about.
                return res.status(501).json({
                    error: `${pallet}.${item} cannot be listed in pages on this runtime, and an unpaged scan is not permitted.`,
                    hint: 'Query a specific key with ?args=<key>.',
                    detail: pagedErr && pagedErr.message ? pagedErr.message : String(pagedErr)
                });
            }
            const truncated = page.length > DEV_API_MAX_ENTRIES;
            const rows = page.slice(0, DEV_API_MAX_ENTRIES).map(([k, v]) => ({
                key: k.toHuman(),
                keyHex: k.toHex(),
                value: serialiseCodec(v)
            }));
            cacheShort(res);
            return res.json({
                pallet, item, at, storage: desc,
                // entriesTotal is deliberately NOT a map size any more. Knowing
                // the true total requires the full walk this endpoint refuses
                // to do, and returning the page length under a name that used
                // to mean "total" would be a quietly wrong number. `truncated`
                // still answers the only question a caller can act on.
                entriesReturned: rows.length,
                truncated,
                entriesTotal: null,
                totalUnknownReason: 'counting every entry requires an unbounded storage walk (F-018)',
                limit: DEV_API_MAX_ENTRIES, entries: rows
            });
        }

        if (desc && desc.keyCount > 0 && args.length !== desc.keyCount) {
            return res.status(400).json({
                error: `${pallet}.${item} expects ${desc.keyCount} key(s), received ${args.length}.`,
                keyTypes: desc.keyTypes
            });
        }

        // Keys supplied for a PLAIN (unkeyed) storage value. polkadot-js simply
        // ignores the extra arguments and returns the single stored value — so
        // every key you try returns an identical result, which reads exactly
        // like "this key and that key both hold the same thing" when in truth
        // neither key was ever used. That is a false confirmation, and this API
        // exists to prevent precisely that class of mistake. Fail loudly.
        if (desc && desc.keyCount === 0 && args.length > 0) {
            return res.status(400).json({
                error: `${pallet}.${item} is a plain (unkeyed) storage value, but ${args.length} key(s) were supplied.`,
                hint: 'The keys would have been silently ignored and the same value returned for any key. Drop ?args=, or you may be looking for a different storage item.',
                storage: desc
            });
        }

        const value = await withRpcBudget('storage read', () =>
            withTimeout(entry(...args), DEV_API_TIMEOUT_MS, 'storage read'));
        // Historical reads are immutable; current head is not.
        if (at) cacheLong(res); else cacheShort(res);
        res.json({
            pallet, item,
            args,                       // echoed verbatim so the caller can confirm no coercion happened
            at,                         // null = current head
            storage: desc,
            ...serialiseCodec(value)
        });
    } catch (err) {
        res.set('Cache-Control', 'no-store');
        // F-084: archiveHint chooses the status too — a pruned block is 409
        // (a fact about the request), not 500 (a fault on our side).
        { const a = archiveHint(err, at); res.status(a.status).json(a.body); }
    }
});

// ---- GET /api/consts/:pallet/:item ------------------------------------------
// Runtime constants (api.consts). Constants are baked into the runtime, so
// "at a block" means "the runtime active at that block".
app.get('/api/consts/:pallet/:item', async (req, res) => {
    if (!devApiGate(req, res)) return;
    let at = null;
    try {
        const pallet = String(req.params.pallet).trim();
        const item = String(req.params.item).trim();
        at = await resolveAtBlock(req.query.at);
        const consts = at ? (await withTimeout(globalApi.at(at.hash), DEV_API_TIMEOUT_MS, 'api.at')).consts : globalApi.consts;
        if (!consts[pallet] || consts[pallet][item] === undefined) {
            return res.status(404).json({
                error: `Unknown constant "${pallet}.${item}".`,
                available: consts[pallet] ? Object.keys(consts[pallet]).sort() : undefined
            });
        }
        if (at) cacheLong(res); else cacheMedium(res);
        res.json({ pallet, item, at, ...serialiseCodec(consts[pallet][item]) });
    } catch (err) {
        res.set('Cache-Control', 'no-store');
        // F-084: archiveHint chooses the status too — a pruned block is 409
        // (a fact about the request), not 500 (a fault on our side).
        { const a = archiveHint(err, at); res.status(a.status).json(a.body); }
    }
});

// ---- GET /api/runtime -------------------------------------------------------
// Runtime version at head or at ?at=. Essential context for any historical
// decode: a call's argument layout is only meaningful against the runtime that
// was live at that block.
app.get('/api/runtime', async (req, res) => {
    if (!devApiGate(req, res)) return;
    let at = null;
    try {
        at = await resolveAtBlock(req.query.at);
        const rv = at
            ? await withTimeout(globalApi.rpc.state.getRuntimeVersion(at.hash), DEV_API_TIMEOUT_MS, 'runtimeVersion')
            : globalApi.runtimeVersion;
        if (at) cacheLong(res); else cacheMedium(res);
        res.json({
            at,
            specName: rv.specName.toString(),
            implName: rv.implName.toString(),
            specVersion: rv.specVersion.toNumber(),
            implVersion: rv.implVersion.toNumber(),
            transactionVersion: rv.transactionVersion ? rv.transactionVersion.toNumber() : null
        });
    } catch (err) {
        res.set('Cache-Control', 'no-store');
        // F-084: archiveHint chooses the status too — a pruned block is 409
        // (a fact about the request), not 500 (a fault on our side).
        { const a = archiveHint(err, at); res.status(a.status).json(a.body); }
    }
});

// ---- POST /api/rpc/call -----------------------------------------------------
// polkadot.js's "RPC calls" tab, restricted to an explicit allowlist of
// READ-ONLY methods. Everything that submits, signs, mutates or touches the
// node's keystore/offchain storage (author_*, offchain_*, system_addReservedPeer,
// ...) is absent by construction — an allowlist, never a denylist, so a new
// upstream RPC method can't quietly become reachable.
// F-077: hard ceiling on state_getKeysPaged's caller-supplied `count`. The
// storage browser pages at 100; anything larger is either a mistake or an
// attempt to make one request cost the node a full prefix walk.
const RPC_MAX_PAGE = readPositiveInteger(process.env.RPC_MAX_PAGE, 100);

const RPC_ALLOWLIST = new Set([
    'chain_getBlock', 'chain_getBlockHash', 'chain_getFinalizedHead', 'chain_getHeader',
    // Audit F-077: state_queryStorageAt was reachable here. It takes an
    // ARRAY of keys and answers for all of them in one call — an unbounded
    // multiplier against the shared RPC node from a public endpoint, which is
    // exactly what F-018 removed from /api/state. state_getKeysPaged stays
    // (it is paged by construction and needs an explicit page size).
    'state_getRuntimeVersion', 'state_getStorage', 'state_getKeysPaged', 'state_getStorageHash', 'state_getStorageSize',
    'system_chain', 'system_chainType', 'system_health', 'system_name', 'system_properties', 'system_version', 'system_syncState',
    'payment_queryInfo'
]);

// Discoverable allowlist, so the UI can populate its method picker without
// firing a deliberately-invalid POST just to read the list out of a 400 body.
app.get('/api/rpc/call', (req, res) => {
    if (!devApiGate(req, res)) return;
    cacheLong(res);
    res.json({ readOnly: true, allowed: [...RPC_ALLOWLIST].sort() });
});

app.post('/api/rpc/call', async (req, res) => {
    if (!devApiGate(req, res)) return;
    try {
        const method = String((req.body && req.body.method) || '').trim();
        const params = Array.isArray(req.body && req.body.params) ? req.body.params : [];
        if (!RPC_ALLOWLIST.has(method)) {
            return res.status(400).json({
                error: `RPC method "${method}" is not permitted.`,
                hint: 'This console is read-only.',
                allowed: [...RPC_ALLOWLIST].sort()
            });
        }
        if (params.length > 8) return res.status(400).json({ error: 'Too many parameters (max 8).' });

        // Audit F-077 (round 2). `state_queryStorageAt` was removed from the
        // allowlist in round 1; `state_getKeysPaged` stayed, and it is the one
        // where the CALLER picks how much work the node does.
        //
        //   state_getKeysPaged(prefix, count, startKey, at)
        //
        // `count` was unbounded, so a single request could ask an archive node
        // to walk a whole storage prefix — and the node does that work
        // synchronously on the connection every request in this process shares.
        // The dev-API rate limit caps requests per minute, not the size of one.
        //
        // Clamping rather than rejecting: the /chain-state storage browser is a
        // legitimate consumer and a 400 would break it. But a silent clamp is
        // its own dishonesty — a client that asked for 5,000 keys and got 100
        // would read the short page as "the prefix ended here" and stop. So the
        // effective value is echoed back in `pageSize`, alongside the `params`
        // the response already returns.
        let clampedPageSize = null;
        if (method === 'state_getKeysPaged') {
            // Clamp INTO the range, don't snap to the ceiling. The first
            // version treated `asked < 1` the same as `asked > MAX` and set
            // both to MAX — so `count: 0`, which asks the node for nothing,
            // became a request for the largest page allowed. A guard that
            // increases the work for its most conservative input is worse than
            // no guard.
            const asked = Number(params[1]);
            if (!Number.isFinite(asked)) {
                params[1] = RPC_MAX_PAGE;
                clampedPageSize = RPC_MAX_PAGE;
            } else {
                const bounded = Math.min(Math.max(Math.trunc(asked), 1), RPC_MAX_PAGE);
                if (bounded !== asked) {
                    params[1] = bounded;
                    clampedPageSize = bounded;
                }
            }
        }

        const [section, ...rest] = method.split('_');
        const fn = rest.join('_').replace(/_(.)/g, (_, c) => c.toUpperCase());
        const target = globalApi.rpc[section] && globalApi.rpc[section][fn];
        if (!target) return res.status(400).json({ error: `RPC method "${method}" is not available on this node.` });

        const value = await withRpcBudget(method, () =>
            withTimeout(target(...params), DEV_API_TIMEOUT_MS, method));
        res.set('Cache-Control', 'no-store');
        res.json({
            method, params, ...serialiseCodec(value),
            // F-077: non-null when the requested page size was clamped, so a
            // short page is not mistaken for the end of the prefix.
            ...(clampedPageSize !== null ? { pageSize: clampedPageSize, pageSizeClamped: true } : {})
        });
    } catch (err) {
        res.set('Cache-Control', 'no-store');
        serverError(res, err, req.path);
    }
});

// Audit F-084: handlers echoed `err.message` straight to the client. Those
// strings come from SQLite, polkadot.js and the filesystem, and carry absolute
// paths, SQL fragments, internal hostnames and RPC URLs — free reconnaissance
// on any endpoint you can make throw. Clients get a stable generic message;
// the real error is logged server-side where operators can read it.
//
// Deliberately NOT applied to the 4xx validation replies: "Invalid Polkadex
// address." is our own text and is the useful thing to say.
function serverError(res, err, context) {
    const detail = err && err.message ? err.message : String(err);
    console.error(`[api] ${context || 'request'} failed:`, err && err.stack ? err.stack : detail);
    if (res.headersSent) return;
    res.set('Cache-Control', 'no-store');

    // F-073: a load-shed refusal is not an internal error, and telling the
    // caller "internal error" for it is both wrong and unactionable. When the
    // thrower set an explicit statusCode AND a message it meant for the client,
    // pass both through. Everything else stays deliberately opaque (F-084 —
    // err.message used to leak SQL and file paths to the public).
    if (err && err.statusCode === 503 && err.message) {
        res.set('Retry-After', '5');
        res.status(503).json({ error: err.message });
        return;
    }
    res.status(500).json({ error: 'Internal error. If this persists, please report it with the time and the URL.' });
}

// Response ceiling for /api/decode (audit F-072).
const DECODE_MAX_EXTRINSICS = readPositiveInteger(process.env.DECODE_MAX_EXTRINSICS, 50);

// ---- GET /api/decode/:block -------------------------------------------------
// Every extrinsic in a block, decoded argument by argument, with each argument's
// NAME, declared TYPE, human form, JSON form AND raw hex.
//
// Why the raw hex is non-negotiable here: toHuman() is a presentation layer. It
// groups big integers with separators and abbreviates long hashes to
// "0x0000…0000", so an all-zero H256 and a mostly-zero one look identical, and
// a u64 of 2^63 reads as an innocuous "9,223,372,036,854,775,808". Anyone
// verifying a claim about a call needs the bytes, not the formatting.
//
// Vec-typed arguments also report a `count`, because "how many signatures were
// attached" is usually the actual question and counting a rendered array is a
// poor way to answer it.
//
// Filters: ?section=ocex&method=submit_snapshot&index=2
app.get('/api/decode/:block', async (req, res) => {
    if (!devApiGate(req, res)) return;
    try {
        const blockId = String(req.params.block).trim();
        let blockHash = blockId;
        if (/^\d+$/.test(blockId)) {
            const h = await withTimeout(globalApi.rpc.chain.getBlockHash(parseInt(blockId, 10)), DEV_API_TIMEOUT_MS, 'getBlockHash');
            if (h.isEmpty) return res.status(404).json({ error: `Block ${blockId} not found` });
            blockHash = h.toHex();
        } else if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
            return res.status(400).json({ error: 'Expected a block number or a 0x-prefixed 32-byte block hash.' });
        }

        const signedBlock = await withRpcBudget('getBlock', () =>
            withTimeout(globalApi.rpc.chain.getBlock(blockHash), DEV_API_TIMEOUT_MS, 'getBlock'));
        if (!signedBlock) return res.status(404).json({ error: 'Block not found' });

        // Match section/method loosely. polkadot-js exposes calls in
        // lowerCamelCase (`submitSnapshot`) while the runtime source, docs and
        // every bug report write snake_case (`submit_snapshot`). Comparing the
        // two verbatim silently matches nothing and returns an empty list —
        // indistinguishable from "that call isn't in this block", which is a
        // dangerously wrong answer for an audit tool. Normalise both sides.
        const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
        const wantSection = req.query.section ? norm(req.query.section) : null;
        const wantMethod = req.query.method ? norm(req.query.method) : null;
        const wantIndex = req.query.index !== undefined ? parseInt(req.query.index, 10) : null;

        // Audit F-072: this decoded EVERY extrinsic with full human + JSON +
        // hex per argument and no ceiling on the response. A block packed with
        // large calls could produce a multi-megabyte JSON body from one
        // request, CDN-cacheable, from a public endpoint. Cap the number of
        // extrinsics decoded per response; `?index=` and the section/method
        // filters already exist for reaching a specific one.
        const out = [];
        const extrinsics = signedBlock.block.extrinsics || [];
        let decodeBudget = DECODE_MAX_EXTRINSICS;
        let decodeTruncated = false;
        for (let i = 0; i < extrinsics.length; i++) {
            if (wantIndex !== null && i !== wantIndex) continue;
            const ex = extrinsics[i];
            const call = ex.method;
            const section = call.section, method = call.method;
            if (wantSection && norm(section) !== wantSection) continue;
            // Audit F-188 (round 2). The budget is spent on MATCHES, not on
            // candidates — and the first fix only got that right for
            // ?section=. The decrement sat BETWEEN the two filters, so
            // ?method= still burned budget on every non-matching call: the
            // documented `?method=submit_snapshot` on a busy block came back
            // `truncated: true` with an EMPTY list, and the SPA rendered "none
            // matched the filter" for a call that was right there.
            //
            // Both filters now run first. The cap bounds what we RETURN, which
            // is what F-072 is actually about (a multi-megabyte cacheable
            // body), not how many rows we look at — looking is cheap, the
            // decode below is not.
            if (wantMethod && norm(method) !== wantMethod) continue;
            if (decodeBudget <= 0) { decodeTruncated = true; break; }
            decodeBudget--;

            // Pair each decoded value with its declared name and type from the
            // call metadata — positional args alone are near-useless for audit.
            const argMeta = (call.meta && call.meta.args) || [];
            const args = call.args.map((v, ai) => {
                const m = argMeta[ai];
                const s = serialiseCodec(v);
                return {
                    name: m ? m.name.toString() : `arg${ai}`,
                    type: m ? (m.typeName ? m.typeName.toString() : typeName(m.type)) : null,
                    ...s
                };
            });

            out.push({
                index: i,
                hash: ex.hash.toHex(),
                section, method,
                isSigned: ex.isSigned,
                signer: ex.isSigned ? ex.signer.toString() : null,
                nonce: ex.isSigned ? ex.nonce.toNumber() : null,
                args,
                // Full SCALE-encoded call, so a reader can re-decode independently.
                callHex: call.toHex(),
                callLength: call.toU8a().length
            });
        }

        cacheLong(res); // historical blocks are immutable
        const body = {
            block: signedBlock.block.header.number.toNumber(),
            blockHash,
            extrinsicCount: extrinsics.length,
            returned: out.length,
            // F-072: say so when the cap bit, so a client can page with
            // ?index= rather than silently believing it saw the whole block.
            truncated: decodeTruncated,
            // F-188: when a filter truncates to nothing, "no results" is
            // indistinguishable from "your filter is wrong". Listing what IS
            // in the block costs one cheap pass over already-decoded metadata
            // and turns a dead end into a next step.
            present: (decodeTruncated && out.length === 0)
                ? [...new Set(extrinsics.map(e => `${e.method.section}.${e.method.method}`))].slice(0, 100)
                : undefined,
            limit: DECODE_MAX_EXTRINSICS,
            extrinsics: out
        };
        if (decodeTruncated) {
            body.note = `Only the first ${DECODE_MAX_EXTRINSICS} extrinsics are decoded per request. Use ?index=<n>, or ?section=/?method= to narrow.`;
        }
        // A filter that matches nothing returns [], which reads identically to
        // "that call is not in this block". For an audit tool those are very
        // different statements, so when a filter eliminated everything, list
        // what the block actually contains.
        if (!out.length && !decodeTruncated && (wantSection || wantMethod || wantIndex !== null)) {
            body.note = 'No extrinsic in this block matched the filter. Section/method matching ignores case and underscores, so submit_snapshot and submitSnapshot are equivalent.';
            body.present = extrinsics.map((ex, i) => `${i}: ${ex.method.section}.${ex.method.method}`);
        }
        res.json(body);
    } catch (err) {
        res.set('Cache-Control', 'no-store');
        // F-084: archiveHint chooses the status too — a pruned block is 409
        // (a fact about the request), not 500 (a fault on our side).
        { const a = archiveHint(err, { block: req.params.block }); res.status(a.status).json(a.body); }
    }
});

// ---- GET /api/version -------------------------------------------------------
// What is this process actually running? Baked in at image build time by
// deploy.sh (see the ARG/ENV pair in Dockerfile.backend).
//
// This exists because "the fix doesn't work" and "the fix isn't deployed" look
// identical from the outside, and we burned real time today on the second while
// debugging as if it were the first — a `git pull` that silently aborted, a
// `docker compose up` that reported "Running" instead of "Recreated", and a
// browser holding a cached bundle. Compare against your checkout with:
//     curl -s https://explorer.polkadex.ee/api/version | jq -r .gitSha
//     git rev-parse --short=12 HEAD
//
// NEVER cached: a cached answer to "what version are you?" is worse than no
// answer, because it is confidently wrong.
app.get('/api/version', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        component: 'backend',
        gitSha: process.env.GIT_SHA || 'unknown',
        builtAt: process.env.BUILD_TIME || 'unknown',
        // `-dirty` means the tree had uncommitted changes when the image was
        // built, so the SHA alone does NOT identify the running code.
        dirty: /-dirty$/.test(process.env.GIT_SHA || ''),
        // Audit F-142: node version, pid, uptime AND startedAt were public.
        // The build SHA is the useful part (it answers "is my fix deployed?");
        // the rest is reconnaissance — an exact Node patch level maps to known
        // CVEs, and process start time is "when did you last patch", which is
        // why removing uptimeSeconds while keeping startedAt (as a first pass
        // here did) achieved nothing. Operators get the full detail on
        // /api/diag/* behind DIAG_TOKEN.
        specVersion: globalApi && globalApi.runtimeVersion ? globalApi.runtimeVersion.specVersion.toNumber() : null,
        rpcConnected: !!(globalApi && globalApi.isConnected)
    });
});

// --- SEO endpoints (robots, sitemap) -----------------------------------------
// These are served by the backend so the sitemap can be generated dynamically
// from the SQLite index (top validators, recent blocks, top holders). nginx
// is configured to forward /robots.txt and /sitemap.xml here.
const SITE_URL = (process.env.SITE_URL || 'https://explorer.polkadex.ee').replace(/\/+$/, '');
const SITEMAP_STATIC_ROUTES = [
    { path: '/',                  changefreq: 'always',  priority: '1.0' },
    { path: '/blocks',            changefreq: 'always',  priority: '0.9' },
    { path: '/transactions',      changefreq: 'always',  priority: '0.9' },
    { path: '/events',            changefreq: 'always',  priority: '0.8' },
    { path: '/validators',        changefreq: 'hourly',  priority: '0.9' },
    { path: '/holders',           changefreq: 'hourly',  priority: '0.7' },
    { path: '/staking-rewards',   changefreq: 'hourly',  priority: '0.8' },
    { path: '/democracy',         changefreq: 'daily',   priority: '0.7' },
    { path: '/council',           changefreq: 'daily',   priority: '0.6' },
    { path: '/treasury',          changefreq: 'daily',   priority: '0.6' },
    { path: '/discussions',       changefreq: 'daily',   priority: '0.5' },
    // /wallet (no address) is the public connect-wallet landing — covers
    // "connect Polkadex wallet" / "send PDEX" / "Nova Wallet" search intent.
    // /wallet/:addr is intentionally not listed (personal).
    { path: '/wallet',            changefreq: 'monthly', priority: '0.6' },
    { path: '/donate',            changefreq: 'monthly', priority: '0.3' },
    // Network analytics dashboard — recently added, KPIs update hourly so a
    // higher changefreq is appropriate.
    { path: '/analytics',         changefreq: 'hourly',  priority: '0.7' },
    // Full-screen PDEX price chart, reachable from the sidebar price ticker.
    // High-traffic landing (any visitor scanning "PDEX price" intent).
    { path: '/price',             changefreq: 'hourly',  priority: '0.8' },
    // Developer-facing API reference — targets searches like "Polkadex API"
    // or "Polkadex mobile app integration".
    { path: '/developers',        changefreq: 'monthly', priority: '0.6' },
    { path: '/chain-state',       changefreq: 'monthly', priority: '0.6' },
    { path: '/decode',            changefreq: 'monthly', priority: '0.6' },
    { path: '/runtime',           changefreq: 'monthly', priority: '0.5' },
    { path: '/utilities',         changefreq: 'monthly', priority: '0.5' },
    // Static legal pages — low changefreq but want them indexed so users
    // searching for "Polkadex explorer privacy" land on the right page.
    { path: '/privacy',           changefreq: 'yearly',  priority: '0.4' },
    { path: '/cookies',           changefreq: 'yearly',  priority: '0.4' },
    // Help center — landing page + every article. Each article is an
    // indexable TechArticle so users searching for specific concepts
    // ("how to stake on Polkadex", "PDEX referendum voting", "Polkadex tax CSV")
    // land directly on the relevant help topic instead of the generic landing.
    { path: '/help',                          changefreq: 'monthly', priority: '0.6' },
    { path: '/help/quick-start',              changefreq: 'monthly', priority: '0.7' },
    { path: '/help/installing-a-wallet',      changefreq: 'monthly', priority: '0.6' },
    { path: '/help/connecting-wallet',        changefreq: 'monthly', priority: '0.6' },
    { path: '/help/home-dashboard',           changefreq: 'monthly', priority: '0.5' },
    { path: '/help/blocks',                   changefreq: 'monthly', priority: '0.5' },
    { path: '/help/transactions',             changefreq: 'monthly', priority: '0.5' },
    { path: '/help/events',                   changefreq: 'monthly', priority: '0.5' },
    { path: '/help/validators',               changefreq: 'monthly', priority: '0.5' },
    { path: '/help/holders',                  changefreq: 'monthly', priority: '0.5' },
    { path: '/help/accounts',                 changefreq: 'monthly', priority: '0.5' },
    { path: '/help/search',                   changefreq: 'monthly', priority: '0.5' },
    { path: '/help/sending-pdex',             changefreq: 'monthly', priority: '0.7' },
    { path: '/help/switching-wallets',        changefreq: 'monthly', priority: '0.5' },
    { path: '/help/identity',                 changefreq: 'monthly', priority: '0.6' },
    { path: '/help/proxies-and-multisig',     changefreq: 'monthly', priority: '0.6' },
    { path: '/help/how-staking-works',        changefreq: 'monthly', priority: '0.7' },
    { path: '/help/nominating',               changefreq: 'monthly', priority: '0.7' },
    { path: '/help/claiming-rewards',         changefreq: 'monthly', priority: '0.6' },
    { path: '/help/unstaking',                changefreq: 'monthly', priority: '0.6' },
    { path: '/help/staking-rewards-page',     changefreq: 'monthly', priority: '0.6' },
    { path: '/help/governance-overview',      changefreq: 'monthly', priority: '0.6' },
    { path: '/help/democracy-and-voting',     changefreq: 'monthly', priority: '0.6' },
    { path: '/help/council-and-motions',      changefreq: 'monthly', priority: '0.5' },
    { path: '/help/treasury',                 changefreq: 'monthly', priority: '0.5' },
    { path: '/help/discussions',              changefreq: 'monthly', priority: '0.5' },
    { path: '/help/analytics',                changefreq: 'monthly', priority: '0.5' },
    { path: '/help/watchlist',                changefreq: 'monthly', priority: '0.5' },
    { path: '/help/community-labels',         changefreq: 'monthly', priority: '0.5' },
    { path: '/help/privacy',                  changefreq: 'monthly', priority: '0.4' },
    { path: '/help/troubleshooting',          changefreq: 'monthly', priority: '0.6' },
    { path: '/help/glossary',                 changefreq: 'monthly', priority: '0.5' },
    { path: '/help/brand-kit',                changefreq: 'monthly', priority: '0.4' },
    { path: '/help/governance-calendar',      changefreq: 'monthly', priority: '0.5' },
    { path: '/help/governance-notifications', changefreq: 'monthly', priority: '0.4' },
    { path: '/help/email-alerts',             changefreq: 'monthly', priority: '0.5' },
    { path: '/help/price-chart',              changefreq: 'monthly', priority: '0.5' },
    // Brand kit cheatsheet — designer-/dev-facing reference, indexable so
    // searches for "Polkadex brand colours" / "Polkadex logo download" land here.
    { path: '/brand',                         changefreq: 'monthly', priority: '0.5' },
    // Unified governance calendar — referenda, motions, treasury together.
    { path: '/calendar',                      changefreq: 'daily',   priority: '0.6' }
    // Note: /watchlist intentionally omitted (noindex — personal page).
];
const SITEMAP_TOP_VALIDATORS = readPositiveInteger(process.env.SITEMAP_TOP_VALIDATORS, 100);
const SITEMAP_RECENT_BLOCKS  = readPositiveInteger(process.env.SITEMAP_RECENT_BLOCKS, 200);
const SITEMAP_TOP_HOLDERS    = readPositiveInteger(process.env.SITEMAP_TOP_HOLDERS, 100);
// Don't recompute the sitemap on every crawler hit — they tend to come in
// bursts. Cache the rendered XML for a few minutes.
const SITEMAP_CACHE_TTL_MS = readPositiveInteger(process.env.SITEMAP_CACHE_TTL_MS, 5 * 60 * 1000);
let sitemapCache = { xml: null, at: 0 };

function xmlEscape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildSitemapXml() {
    const now = new Date().toISOString();
    const urls = [];

    for (const r of SITEMAP_STATIC_ROUTES) {
        urls.push({ loc: SITE_URL + r.path, lastmod: now, changefreq: r.changefreq, priority: r.priority });
    }

    // Top validators by stake — deep pages that benefit from indexing.
    try {
        const v = db.getValidators();
        const list = Array.isArray(v) ? v : (v && Array.isArray(v.validators) ? v.validators : []);
        const top = list
            .slice()
            .sort((a, b) => (Number(b.totalStake) || 0) - (Number(a.totalStake) || 0))
            .slice(0, SITEMAP_TOP_VALIDATORS);
        for (const val of top) {
            if (val && val.address) {
                urls.push({ loc: SITE_URL + '/validator/' + encodeURIComponent(val.address), lastmod: now, changefreq: 'daily', priority: '0.6' });
            }
        }
    } catch (e) { /* tolerate missing tables before first sync */ }

    // Recent blocks — useful when a search engine is looking at "polkadex block <n>".
    try {
        const blocks = db.getRecentBlocks(SITEMAP_RECENT_BLOCKS) || [];
        for (const b of blocks) {
            if (b && b.number != null) {
                const lastmod = b.timestamp ? new Date(Number(b.timestamp)).toISOString() : now;
                urls.push({ loc: SITE_URL + '/block/' + b.number, lastmod, changefreq: 'never', priority: '0.4' });
            }
        }
    } catch (e) { /* ignore */ }

    // Top holders — public ranking pages.
    try {
        const h = db.getHolders();
        const list = h && Array.isArray(h.holders) ? h.holders : [];
        for (const holder of list.slice(0, SITEMAP_TOP_HOLDERS)) {
            if (holder && holder.address) {
                urls.push({ loc: SITE_URL + '/account/' + encodeURIComponent(holder.address), lastmod: now, changefreq: 'weekly', priority: '0.4' });
            }
        }
    } catch (e) { /* ignore */ }

    const items = urls.map(u => {
        return '  <url>\n' +
               '    <loc>' + xmlEscape(u.loc) + '</loc>\n' +
               (u.lastmod ? '    <lastmod>' + xmlEscape(u.lastmod) + '</lastmod>\n' : '') +
               (u.changefreq ? '    <changefreq>' + u.changefreq + '</changefreq>\n' : '') +
               (u.priority ? '    <priority>' + u.priority + '</priority>\n' : '') +
               '  </url>';
    }).join('\n');

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
           items + '\n' +
           '</urlset>\n';
}

// --- Cache-Control helpers ---
// Three tiers, applied to the success path of read-only list endpoints so a
// CDN (Cloudflare in our deployment) can absorb the bulk of read traffic and
// the origin only sees ~one request per endpoint per s-maxage window.
//
// max-age         = browser cache (per user)
// s-maxage        = shared-proxy cache (Cloudflare)
// stale-while-revalidate = serve a stale copy instantly while the proxy
//                          refreshes asynchronously, so a user never blocks
//                          on a cache miss caused by an expiry.
//
// IMPORTANT: do NOT call these on error responses — Cloudflare obeys explicit
// caching headers on 5xx and would happily pin a transient error in its edge.
// Prefer calling them on the success path, immediately before res.json.
//
// That is now a style preference rather than a correctness requirement: audit
// F-087 found endpoints that set the header BEFORE the work that can throw, so
// the rule was being broken by ordering rather than by intent. The response
// middleware near express.json() strips a public Cache-Control from any
// non-cacheable status, so getting this wrong is no longer a production
// incident. Do not delete that middleware on the grounds that "the endpoints
// already do this correctly" — they did not.
function cacheShort(res)  { res.set('Cache-Control', 'public, max-age=5, s-maxage=10, stale-while-revalidate=30'); }   // 10s-fresh-at-CDN — for endpoints fed by the 12s chain indexer
function cacheMedium(res) { res.set('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=120'); } // 1min-fresh-at-CDN — for endpoints fed by 5–30 min indexers
function cacheLong(res)   { res.set('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600'); } // 10min-fresh-at-CDN — governance, price history, slow-moving lists

app.get('/sitemap.xml', (req, res) => {
    const now = Date.now();
    if (!sitemapCache.xml || (now - sitemapCache.at) > SITEMAP_CACHE_TTL_MS) {
        try {
            sitemapCache = { xml: buildSitemapXml(), at: now };
        } catch (err) {
            return res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n');
        }
    }
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.type('application/xml').send(sitemapCache.xml);
});

app.get('/robots.txt', (req, res) => {
    const lines = [
        'User-agent: *',
        'Allow: /',
        // Personal / dynamic surfaces — disallow so crawlers don't index per-user
        // pages. Each is also noindex-tagged at render time as defence-in-depth.
        //   /wallet           — public connect-wallet landing (indexable).
        //   /wallet/<addr>    — personal dashboard (NOT indexable).
        //   /watchlist        — personal local-storage page.
        //   /search           — query-result page, no canonical content.
        //   /email/           — the preferences page; its ?token= IS the
        //                       credential, so a crawled URL is a leaked one.
        //   /api/             — JSON endpoints, not human-readable.
        'Allow: /wallet',
        'Disallow: /wallet/',
        'Disallow: /watchlist',
        'Disallow: /search',
        'Disallow: /email/',
        'Disallow: /api/',
        // Reference + content surfaces — explicitly allowed so the wildcard
        // root Allow can't be mis-parsed by older or stricter crawlers.
        'Allow: /help',
        'Allow: /help/',
        'Allow: /developers',
        'Allow: /chain-state',
        'Allow: /decode',
        'Allow: /runtime',
        'Allow: /utilities',
        'Allow: /brand',
        'Allow: /privacy',
        'Allow: /cookies',
        // Machine-readable API index for crawlers / AI assistants.
        'Allow: /llms.txt',
        '',
        'Sitemap: ' + SITE_URL + '/sitemap.xml',
        ''
    ];
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('text/plain').send(lines.join('\n'));
});

// --- /developers — SERVER-RENDERED API reference -----------------------------
// The rest of the site is a client-rendered SPA, but the developer docs must be
// readable by crawlers, AI assistants, and non-browser integrators that don't
// run JavaScript. So — exactly like /robots.txt and /sitemap.xml — nginx
// forwards `/developers` to the backend, which returns a complete, self-
// contained HTML document (no JS bundle, no Cloudflare HTML-cache dependency).
// In-app client-side navigation to /developers still renders via
// renderDevelopersPage() in script.js; only direct hits / refreshes reach here.
// Keep this in sync with renderDevelopersPage() (script.js) and public/llms.txt.

// Audit F-060 (round 2). The section ORDER, ids and headings now come from
// DOC_OUTLINE in lib/api-reference.js; this object supplies only the BODY of
// each one. That split is what stops the two /developers documents drifting
// apart again: a section here cannot exist without being in the outline, and
// cannot be titled differently from the SPA's copy, because neither renderer
// owns the title any more.
//
// Round 1 had already moved the route table into lib/. The residual the audit
// found was everything around it — only the SPA had anchors and a table of
// contents, so a shared `/developers#caching` link worked in the SPA and landed
// at the top of the page for anyone who fetched the server-rendered document;
// and the two put their sections in different orders, which made them read as
// unrelated pages.
//
// A body may be '' — the outline still emits the heading and its anchor, so a
// section with prose in only one renderer at least keeps a stable URL.
const DEVELOPERS_BODIES = {
    overview: `<p>This explorer is a client-rendered single-page app: HTML pages are a shell that JavaScript fills in inside the browser. A non-browser client that fetches an HTML page will <strong>not</strong> see the data. Don't scrape the HTML — call the JSON API below, which returns plain JSON. Every figure on the site comes from an <code>/api/*</code> endpoint. (This developer page is the exception: it is server-rendered on purpose.)</p>`,

    cors: `<table>
<thead><tr><th>Behavior</th><th>What to do</th></tr></thead>
<tbody>
<tr><td>The site sits behind Cloudflare. Requests from cloud/datacenter IP ranges are sometimes challenged, so a call from a CI runner or hosted backend can come back empty where the same call from a laptop succeeds.</td><td>It is an edge policy, not an API restriction — a plain <code>curl</code> receives HTTP 200. Send a descriptive <code>User-Agent</code>, respect the <code>Cache-Control</code> headers, and ask the operator to allowlist your range if you call from a data centre.</td></tr>
<tr><td>The API is open to non-browser clients at the origin. CORS is a browser-only mechanism, so a caller that sends no <code>Origin</code> header (native app, server, script, AI agent) is always allowed by the app.</td><td>Call the API directly from servers and native apps. Only browser callers from other web origins need to be added to <code>ALLOWED_ORIGINS</code>.</td></tr>
</tbody>
</table>`,

    // F-083: the tier table is rendered from CACHE_TIERS, shared with the SPA.
    // Both pages used to describe the tiers in prose they each maintained, and
    // both had drifted the same dangerous way — listing /api/wallet/:address as
    // a 30-second cacheable response when the handler sends no-store.
    caching: renderCacheTiers(),

    chain: renderSection('chain'),

    inspect: `<p>Generic access to runtime metadata, storage and constants at <strong>any block</strong>, so on-chain claims can be verified independently. Backed by an archive node, so historical queries work.</p>
${renderSection('inspect')}
<p><strong>Read-only by construction</strong> — only <code>api.query</code>, <code>api.consts</code> and allowlisted read RPCs are reachable; nothing here can submit an extrinsic.</p>
<p><strong>Send storage keys as strings.</strong> A u64 key like <code>9223372036854775808</code> (2&#8310;&#179;) exceeds JavaScript's <code>MAX_SAFE_INTEGER</code>; a client that parses it as a number queries <code>9223372036854776000</code> instead — a different key whose empty result reads like confirmation. Responses echo <code>args</code> back so you can check.</p>
<p><strong>Verify against <code>hex</code>, not <code>human</code>.</strong> <code>toHuman()</code> abbreviates hashes (an all-zero H256 shows as <code>0x0000…0000</code>) and group-separates integers, so every response carries human, JSON and hex together, plus a <code>count</code> for Vec results.</p>
<p>There is an interactive UI for this at <a href="${SITE_URL}/chain-state">/chain-state</a>, with shareable deep links (<code>?pallet=&amp;item=&amp;args=&amp;at=</code>).</p>
<pre><code>curl '${SITE_URL}/api/decode/12250870?method=submit_snapshot'
curl '${SITE_URL}/api/state/ocex/validatorSetId?at=12250870'
curl '${SITE_URL}/api/state/ocex/authorities?args=6280&amp;at=12250870'</code></pre>`,

    accounts:    renderSection('accounts'),
    labels:      renderSection('labels'),
    analytics:   renderSection('analytics'),
    price:       renderSection('price'),
    governance:  renderSection('governance'),
    email:       renderSection('email'),
    discussions: renderSection('discussions'),
    auth:        renderSection('auth'),
    meta:        renderSection('meta'),

    schema: `<pre><code>{
  "networkInfo": {
    "activeEra": number,              // current staking era index
    "avgValidatorCommission": number, // mean active-validator commission, %
    "avgApy": number,                 // headline AVG APY %, commission-adjusted
    "avg_apy": number,                // snake_case alias of avgApy
    "validators":  { "active": number, "total": number },
    "nominators":  { "active": number, "total": number },
    "maxActiveStake": number,         // largest active-validator total stake, PDEX
    "minStake": number,               // minimum active stake, PDEX
    "averageStake": number,           // mean active-validator stake, PDEX
    "avgStakePerAccount": number,     // total bonded / staking accounts, PDEX
    "totalIssuance": number,          // total PDEX issuance
    "totalBonding": number,           // total PDEX bonded for staking
    "totalBondingPercent": number,    // totalBonding / totalIssuance, %
    "totalUnbonding": number,         // total PDEX currently unbonding
    "totalStakeChange": number,       // net stake change vs previous era, PDEX
    "lastEraRewardsTotal": number     // total rewards paid last era, PDEX
  },
  "lastSync": number,                 // epoch ms when networkInfo was computed
  "status": "Synced" | "Stale" | "Initializing" | "Error",
  "chainHead": {
    "value": number,                  // best block number
    "lastAdvanceAt": number,          // epoch ms the head last advanced
    "staleSeconds": number,           // seconds since the head last advanced
    "isStale": boolean                // true if the head looks stuck
  }
}</code></pre>
<p><strong>AVG APY</strong> is returned directly (<code>avgApy</code>, and the <code>avg_apy</code> alias), derived as <code>avgApy = 23.09 &times; (1 &minus; avgValidatorCommission / 100)</code>, where 23.09% is the chain's nominal maximum APY at its target staking ratio.</p>`,

    errors: `<p>Failures return a 4xx/5xx status with <code>{ "error": "&lt;message&gt;" }</code>. The <code>error</code> string is a human-readable sentence intended for display — <strong>do not match on it</strong>; it is reworded freely between releases.</p>
<p>Endpoints that depend on the chain RPC return <strong>503</strong> during RPC outages, with a stable machine-readable <code>code</code> alongside the prose, plus <code>Retry-After: 5</code> and <code>Cache-Control: no-store</code> so an edge cache cannot pin it:</p>
<pre><code>${rpcNotReadyExample().replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre>
<p>Branch on <code>code === "${RPC_NOT_READY.code}"</code> (or simply on the 503 status) and retry with backoff — it is not permanent. <strong>Audit F-155:</strong> this page used to promise a short fixed <code>error</code> string that the server has never sent; clients matching that literal treated every RPC outage as an unknown error and did not back off. This block is now rendered from the same constant the 503 handler uses, so the two cannot disagree again.</p>`,

    addresses: `<p>Paths that take an <code>:address</code> expect Polkadex SS58 (prefix 88, addresses start with <code>e&hellip;</code>); the server normalizes via <code>toPolkadexAddress()</code>, so prefix-42/0 forms usually resolve too.</p>`,

    examples: `<pre><code>curl ${SITE_URL}/api/network-info
curl ${SITE_URL}/api/price-latest
curl '${SITE_URL}/api/price-history?days=30'</code></pre>`,

    contact: `<p>Found a bug or a missing endpoint? Open an issue on GitHub or reach the team via <a href="https://polkadex.ee" rel="noopener">polkadex.ee</a>.</p>`
};

const DEVELOPERS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Developers — Polkadex Explorer API Reference</title>
<meta name="description" content="Public read-only JSON API for the Polkadex Mainnet blockchain explorer: blocks, transactions, validators, staking rewards, governance, and the /api/network-info schema. Server-rendered, JavaScript-free reference.">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${SITE_URL}/developers">
<meta property="og:type" content="website">
<meta property="og:title" content="Developers — Polkadex Explorer API Reference">
<meta property="og:description" content="Public read-only JSON API for the Polkadex Mainnet: chain data, governance, price feed, and the exact /api/network-info schema.">
<meta property="og:url" content="${SITE_URL}/developers">
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#08080C;color:#E6E6F0;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:#8B7CFF;text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:920px;margin:0 auto;padding:32px 20px 80px}
header.site{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:20px;border-bottom:1px solid #23232E;margin-bottom:28px;flex-wrap:wrap}
header.site nav a{margin-left:16px;color:#B9B9C9;font-size:.92rem}
h1{font-size:1.9rem;margin:.2em 0}
h2{font-size:1.3rem;margin:2em 0 .5em;padding-top:.4em;border-top:1px solid #1C1C26}
h3{font-size:1.05rem;margin:1.4em 0 .4em}
.tag{color:#B9B9C9;font-size:1.02rem}
code{font-family:"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:#15151F;border:1px solid #23232E;border-radius:4px;padding:1px 5px}
pre{background:#101018;border:1px solid #23232E;border-radius:8px;padding:16px;overflow:auto}
pre code{background:none;border:none;padding:0;font-size:.82rem;line-height:1.5}
ul.endpoints{list-style:none;padding:0;margin:0}
ul.endpoints li{padding:7px 0;border-bottom:1px solid #15151F}
ul.endpoints li code{color:#9FE6C0}
table{border-collapse:collapse;width:100%;margin:.6em 0}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #23232E;vertical-align:top;font-size:.93rem}
th{color:#B9B9C9;font-weight:600}
footer{margin-top:48px;padding-top:20px;border-top:1px solid #23232E;color:#8A8A9A;font-size:.9rem}
footer a{margin-right:16px}
</style>
</head>
<body>
<div class="wrap">
<header class="site">
  <strong><a href="${SITE_URL}/">Polkadex Mainnet Explorer</a></strong>
  <nav>
    <a href="${SITE_URL}/">Home</a>
    <a href="${SITE_URL}/llms.txt">llms.txt</a>
    <a href="${SITE_URL}/help">Help</a>
  </nav>
</header>

<main>
<h1>Developers — Polkadex Mainnet Explorer API</h1>
<p class="tag">Public read-only JSON API for the Polkadex Mainnet (a Polkadot-SDK / Substrate Layer-1). Used by this explorer and freely consumable by external apps, native mobile clients, servers, and AI assistants.</p>

${renderToc()}

${renderOutline((entry) => DEVELOPERS_BODIES[entry.id] || '')}
</main>

<footer>
<a href="${SITE_URL}/">Explorer</a>
<a href="${SITE_URL}/llms.txt">llms.txt</a>
<a href="${SITE_URL}/help">Help center</a>
<a href="https://github.com/Polkadex-Substrate" rel="noopener">GitHub</a>
</footer>
</div>
</body>
</html>`;

app.get('/developers', (req, res) => {
    // Static content — safe to cache at the edge, but keep it short enough that
    // a docs update propagates without a manual Cloudflare purge.
    res.set('Cache-Control', 'public, max-age=600');
    res.type('html').send(DEVELOPERS_HTML);
});

// Diagnostic: worker-local RPC cache stats. Useful for confirming the
// LRU is doing what we think during a load test or post-deploy. Each
// cluster worker has its own caches, so hitting this endpoint multiple
// times in a row will round-robin across workers and show different numbers.
// Public liveness probe for uptime monitors: boolean only, by design.
// Everything richer (endpoint URLs, pids, provider names) lives behind
// diagGate on /api/diag/* — see audit F-038.
// Audit F-184 (round 2). This returned HTTP 200 unconditionally with a single
// `healthy` boolean in the body, which makes it useless as a monitor:
//
//   * a STATUS-CODE monitor (the default in UptimeRobot, Pingdom, k8s probes)
//     stays green while healthy is false, because 200 is 200;
//   * a KEYWORD monitor watching for "healthy" stays green while the node is
//     syncing, under-peered, or the indexed head is hours stale, because the
//     word is still there.
//
// So the one endpoint whose entire job is to go red could not go red. Comments
// elsewhere also pointed uptime tools at /api/diag/rpc-health, which is gated
// and answers 403 through nginx — a monitor pointed there alerts constantly
// and gets muted, which is worse than no monitor.
//
// Now: the STATUS CODE carries the verdict (200 healthy, 503 not), and the body
// says which component is unhappy so a human reading the alert knows where to
// look. Deliberately no pid, no URLs, no version — this is public.
app.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store');

    const chainState = db.getSyncState('chain_index') || {};
    const headState = db.getKv('chain_head_state') || null;
    const lastAdvanceAt = headState ? Number(headState.lastAdvanceAt) || 0 : 0;

    const checks = {
        // The chain WebSocket is up and the api handle is decorated.
        rpc: !!(rpcConnected && globalApi),
        // The database answered a query just now.
        database: (() => {
            try { db.getSyncState('chain_index'); return true; } catch (_) { return false; }
        })(),
        // The chain head is advancing. Unknown (never recorded) is NOT a
        // failure — a worker that has not seen a head yet is starting, not sick.
        chainAdvancing: lastAdvanceAt ? (Date.now() - lastAdvanceAt) <= CHAIN_HEAD_STALE_MS : true,
        // The indexer is not sitting on a hole it has given up on. Repairing is
        // fine; Repairing with every gap exhausted is not (F-046).
        indexerProgressing: !(Number(chainState.gapsExhausted) > 0)
    };

    const healthy = Object.values(checks).every(Boolean);
    res.status(healthy ? 200 : 503).json({
        healthy,
        checks,
        // Which ones failed, so the alert body is actionable on its own.
        failing: Object.keys(checks).filter(k => !checks[k])
    });
});

app.get('/api/diag/rpc-cache', (req, res) => {
    if (!diagGate(req, res)) return;
    res.json({
        pid: process.pid,
        block:     blockCache.stats(),
        blockHash: blockHashCache.stats(),
        eventsAt:  eventsAtCache.stats()
    });
});

// SubQuery indexer lag check. Queries the indexer's GraphQL `_metadatas`
// entity to read lastProcessedHeight vs targetHeight and reports how many
// blocks behind the indexer is. The `healthy` flag is what future integration
// code will gate on — when the indexer is too far behind, the explorer
// should skip it and fall through to SQLite.
//
// The fetch is timed out via AbortController so a hung indexer doesn't pin
// HTTP workers. 503 on any error — the indexer being unreachable IS an
// unhealthy state worth surfacing to the caller, not a transparent passthrough.
async function fetchSubqueryMetadata() {
    if (!SUBQUERY_ENDPOINT) throw new Error('SUBQUERY_ENDPOINT not configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBQUERY_TIMEOUT_MS);
    try {
        const r = await fetch(SUBQUERY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: '{ _metadatas { nodes { lastProcessedHeight targetHeight chain genesisHash specName } } }'
            }),
            signal: controller.signal
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
        const json = await r.json();
        const node = json && json.data && json.data._metadatas
            && Array.isArray(json.data._metadatas.nodes) && json.data._metadatas.nodes[0];
        if (!node) throw new Error('SubQuery returned no _metadata');
        return {
            lastProcessedHeight: Number(node.lastProcessedHeight) || 0,
            targetHeight: Number(node.targetHeight) || 0,
            chain: node.chain || null,
            genesisHash: node.genesisHash || null,
            specName: node.specName || null
        };
    } finally {
        clearTimeout(timer);
    }
}

app.get('/api/diag/subquery-lag', async (req, res) => {
    if (!diagGate(req, res)) return;
    const startMs = Date.now();
    try {
        const meta = await fetchSubqueryMetadata();
        const lagBlocks = Math.max(0, meta.targetHeight - meta.lastProcessedHeight);
        const lagSeconds = Math.round(lagBlocks * POLKADEX_BLOCK_TIME_MS / 1000);
        const lagMinutes = Math.round(lagSeconds / 60);
        const healthy = lagBlocks <= SUBQUERY_MAX_LAG_BLOCKS;
        res.json({
            endpoint: SUBQUERY_ENDPOINT,
            chain: meta.chain,
            specName: meta.specName,
            genesisHash: meta.genesisHash,
            lastProcessedHeight: meta.lastProcessedHeight,
            targetHeight: meta.targetHeight,
            lagBlocks,
            lagSeconds,
            lagMinutes,
            lagHours: Math.round(lagMinutes / 60 * 10) / 10,
            healthThresholdBlocks: SUBQUERY_MAX_LAG_BLOCKS,
            healthy,
            latencyMs: Date.now() - startMs
        });
    } catch (err) {
        res.status(503).json({
            endpoint: SUBQUERY_ENDPOINT,
            healthy: false,
            error: err && err.name === 'AbortError'
                ? `timed out after ${SUBQUERY_TIMEOUT_MS}ms`
                : (err && err.message ? err.message : String(err)),
            latencyMs: Date.now() - startMs
        });
    }
});

// Composite RPC health endpoint. Reports the same multi-signal view that the
// local check-rpc-health.sh script produces, but over HTTP so external
// monitors (UptimeRobot keyword check, Healthchecks.io, dashboards) can poll
// without SSH access. Returns 200 with healthy:true when ALL of:
//   - The explorer's WsProvider is connected to the chain RPC
//   - system.health() reports peers >= RPC_HEALTH_MIN_PEERS
//   - isSyncing is false
//   - Chain head has advanced within CHAIN_HEAD_STALE_MS
// Returns 503 with a per-check breakdown otherwise. The breakdown shape is
// stable so dashboards can chart individual signals over time.
//
// Each worker has its own globalApi and lastHeadValue, so repeated calls
// against the load-balanced cluster may round-robin across slightly different
// per-worker views. The drift is bounded by the indexer worker's tick rate
// (~12s) — not significant for an external monitor.
app.get('/api/diag/rpc-health', async (req, res) => {
    if (!diagGate(req, res)) return;
    const startMs = Date.now();

    const checks = {
        rpcConnected: false,
        minPeers: false,
        notSyncing: false,
        headFresh: false
    };

    // Head freshness must be read from SQLite, not the in-process variable.
    // recordChainHead() only runs on the indexer worker (it's the only worker
    // that calls syncChainIndex). HTTP-only workers initialize lastHeadAdvanceAt
    // at boot and never update it — so after CHAIN_HEAD_STALE_MS, their copy
    // is permanently stale. The cluster round-robins requests across all 4
    // workers, so ~75% of probes would falsely report headFresh=false.
    // db.setKv('chain_head_state', ...) is written by the indexer and visible
    // to every worker, so reading from there gives a consistent answer.
    const headState = db.getKv('chain_head_state') || null;
    const headValue = headState ? headState.value : null;
    const headAdvanceAt = headState ? Number(headState.lastAdvanceAt) || null : null;

    const out = {
        endpoint: RPC_ENDPOINTS && RPC_ENDPOINTS[0] ? RPC_ENDPOINTS[0] : null,
        pid: process.pid,
        checks,
        peers: null,
        isSyncing: null,
        shouldHavePeers: null,
        head: {
            value: headValue,
            lastAdvanceAt: headAdvanceAt,
            secondsSinceAdvance: headAdvanceAt
                ? Math.round((Date.now() - headAdvanceAt) / 1000)
                : null,
            staleThresholdSeconds: Math.round(CHAIN_HEAD_STALE_MS / 1000)
        },
        thresholds: {
            minPeers: RPC_HEALTH_MIN_PEERS,
            staleMs: CHAIN_HEAD_STALE_MS
        },
        healthy: false,
        latencyMs: null,
        error: null
    };

    // Check 1 — explorer's WsProvider is connected.
    if (!isRpcReady()) {
        out.error = 'WsProvider not connected — explorer is between reconnects';
        out.latencyMs = Date.now() - startMs;
        return res.status(503).json(out);
    }
    checks.rpcConnected = true;

    // Check 2+3 — system.health() with explicit timeout. polkadot.js calls
    // don't have built-in timeouts; if the upstream is hung, the call could
    // wait indefinitely. Promise.race against a timer ensures we always
    // return within RPC_HEALTH_TIMEOUT_MS.
    let healthJson;
    try {
        const health = await Promise.race([
            globalApi.rpc.system.health(),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error(`system_health timeout after ${RPC_HEALTH_TIMEOUT_MS}ms`)),
                RPC_HEALTH_TIMEOUT_MS
            ))
        ]);
        // toJSON gives us plain primitives — { peers: N, isSyncing: bool, shouldHavePeers: bool }.
        healthJson = health.toJSON();
    } catch (e) {
        out.error = e && e.message ? e.message : String(e);
        out.latencyMs = Date.now() - startMs;
        return res.status(503).json(out);
    }

    out.peers = Number(healthJson.peers);
    out.isSyncing = Boolean(healthJson.isSyncing);
    out.shouldHavePeers = Boolean(healthJson.shouldHavePeers);
    checks.minPeers   = out.peers >= RPC_HEALTH_MIN_PEERS;
    checks.notSyncing = !out.isSyncing;

    // Check 4 — chain head advanced recently. Read from SQLite (see comment
    // at the top of this handler) so HTTP-only workers report consistently
    // with the indexer worker.
    if (headAdvanceAt) {
        checks.headFresh = (Date.now() - headAdvanceAt) < CHAIN_HEAD_STALE_MS;
    } else {
        // Never observed a head — could be cold start or the indexer worker
        // hasn't ticked yet. Mark as failing explicitly so external monitors
        // notice rather than treating "unknown" as "healthy by default."
        checks.headFresh = false;
        out.error = 'chain head has never been observed (cold start? wait one indexer tick)';
    }

    out.healthy = checks.rpcConnected && checks.minPeers && checks.notSyncing && checks.headFresh;
    out.latencyMs = Date.now() - startMs;
    res.status(out.healthy ? 200 : 503).json(out);
});

// --- LIST ENDPOINTS (served from SQLite) ---
app.get('/api/validators', (req, res) => {
    try {
        const payload = db.getValidators();

        // Commission track record, per validator.
        //
        // A nominator told us the list was "useless" because validators raise
        // commission right after being nominated — and they were right that the
        // page gave them no way to see it. Every number on this list (including
        // the APY, which F-044 relabelled) derives from the CURRENT commission,
        // so it could not distinguish a validator that has held 1% for forty
        // eras from one that dropped to 1% yesterday.
        //
        // Attached here rather than stored: see db.getCommissionHistoryByValidator.
        // Best-effort — a failure must degrade the extra column, never the list
        // itself, which is the page's actual job.
        try {
            const byAddress = db.getCommissionHistoryByValidator();
            const activeEra = Number((db.getKv('network_info') || {}).networkInfo?.activeEra) || null;
            payload.validators = payload.validators.map(v => {
                const summary = summarizeCommissionHistory(byAddress[v.address]);
                return {
                    ...v,
                    commissionHistory: {
                        erasTracked: summary.erasTracked,
                        min: summary.min,
                        max: summary.max,
                        changes: summary.changes,
                        raises: summary.raises,
                        cuts: summary.cuts,
                        lastChange: summary.lastChange,
                        volatility: summary.volatility,
                        // Pre-rendered so the list, the validator page and any
                        // third-party consumer describe it identically.
                        note: describeCommissionHistory(summary),
                        raisedRecently: raisedRecently(summary, activeEra),
                        // The live commission has already moved past the newest
                        // era we hold history for. erasValidatorPrefs is stamped
                        // at era start, so a raise made today does not enter
                        // history until the next boundary (~24h) — which is
                        // exactly the "day after you nominate them" window this
                        // feature exists for, and would otherwise be invisible.
                        pendingRaise: pendingRaise(summary, v.commission),
                        // How much of the span the tracked eras actually cover,
                        // so a client can weigh the claim (see `note`).
                        eraSpan: summary.eraSpan,
                        gaps: summary.gaps
                    }
                };
            });
            // The era every `raisedRecently` above was measured against. Null
            // means recency checking was OFF for this response (cold
            // network_info) — without it a client cannot tell "nobody raised
            // recently" from "we could not check".
            payload.commissionHistoryEra = activeEra;
        } catch (e) {
            console.warn('[api] commission-history enrichment skipped:', e && e.message);
        }

        cacheMedium(res);
        res.json(payload);
    }
    catch (err) { /* F-084 */ console.error('[api] /api/validators failed:', err && err.stack ? err.stack : err); res.status(500).json({ validators: [], status: 'Error', error: 'Internal error.' }); }
});
app.get('/api/network-info', async (req, res) => {
    try {
        const data = await getNetworkInfo();
        // Attach chain-head freshness state. The indexer worker writes
        // chain_head_state to SQLite as it polls the chain; every worker
        // (including HTTP-only ones) reads from there so the frontend can
        // render a "chain may be stalled" banner uniformly.
        const headState = db.getKv('chain_head_state') || null;
        const lastAdvanceAt = headState ? Number(headState.lastAdvanceAt) || 0 : 0;
        const sinceAdvance = lastAdvanceAt ? Date.now() - lastAdvanceAt : null;
        const isStale = lastAdvanceAt
            ? (Date.now() - lastAdvanceAt) > CHAIN_HEAD_STALE_MS
            : false; // never-recorded state isn't stale — it's just "unknown"
        cacheMedium(res);
        res.json({
            ...data,
            chainHead: {
                value: headState ? headState.value : null,
                lastAdvanceAt,
                staleSeconds: sinceAdvance != null ? Math.round(sinceAdvance / 1000) : null,
                isStale
            }
        });
    } catch (err) {
        // Explicit no-store on the error fallback — a CDN/edge cache (e.g. a
        // Cloudflare rule that makes /api/* eligible for cache) must never pin
        // this "Error" / empty-data response and serve it to every client.
        // Merely omitting Cache-Control isn't enough if the edge applies a
        // default TTL; no-store is unambiguous.
        res.set('Cache-Control', 'no-store');
        const cacheData = db.getKv('network_info') || { networkInfo: null, lastSync: 0, status: 'Initializing' };
        /* F-084 */ console.error('[api] network-info stale-serve path failed:', err && err.stack ? err.stack : err); res.json({ ...cacheData, status: 'Error', error: 'Internal error.' });
    }
});
app.get('/api/holders', async (req, res) => {
    try {
        const cacheData = db.getHolders();
        cacheData.holders = await applyDisplayNameOverridesToHolders(cacheData.holders);
        cacheMedium(res);
        res.json(cacheData);
    } catch (err) { /* F-084 */ console.error('[api] /api/holders failed:', err && err.stack ? err.stack : err); res.status(500).json({ holders: [], status: 'Error', error: 'Internal error.' }); }
});
app.get('/api/transactions', (req, res) => {
    try {
        const state = db.getSyncState('transactions');
        cacheShort(res);
        res.json({
            transactions: db.getRecentTransactions(1000),
            totalCount: db.countTransactions(),
            lastSync: state.lastSync || 0,
            status: state.status || 'Initializing',
            latestScannedBlock: state.latestScannedBlock || 0,
            oldestScannedBlock: state.oldestScannedBlock || 0,
            // F-008: whether the genesis-ward derivation has finished, so the
            // UI can label partial coverage instead of implying completeness.
            backfillComplete: !!state.txBackfillComplete,
            detail: state.detail || null
        });
    } catch (err) { /* F-084 */ console.error('[api] /api/transactions failed:', err && err.stack ? err.stack : err); res.status(500).json({ transactions: [], status: 'Error', error: 'Internal error.' }); }
});
app.get('/api/transactions/older', async (req, res) => {
    if (!requireRpc(res)) return;
    const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 100);
    const maxBlocks = Math.min(readPositiveInteger(req.query.maxBlocks, TX_OLDER_SCAN_BLOCKS), 100000);
    try {
        const latestHeader = await globalApi.rpc.chain.getHeader();
        const latestBlock = latestHeader.number.toNumber();
        // Audit F-079: was `parseInt(q || latest+1) || latest+1` — a double
        // falsy trap. beforeBlock=0 means "I have paged to genesis", but `0 ||`
        // read it as absent and RESET the cursor to the chain head, so the
        // Load-Older button silently looped back to the newest page. Also
        // accept `?before=` since /developers documents that name.
        const rawBefore = (req.query.beforeBlock !== undefined && req.query.beforeBlock !== '')
            ? req.query.beforeBlock
            : req.query.before;
        let beforeBlock;
        if (rawBefore === undefined || rawBefore === '') {
            beforeBlock = latestBlock + 1;
        } else {
            const parsed = Number.parseInt(rawBefore, 10);
            if (!Number.isFinite(parsed) || parsed < 0) {
                return res.status(400).json({ error: 'beforeBlock must be a non-negative integer.' });
            }
            beforeBlock = Math.min(parsed, latestBlock + 1);
        }
        if (beforeBlock === 0) {
            // Genesis reached: nothing older exists. Say so instead of wrapping.
            return res.json({ transactions: [], nextBeforeBlock: 0, scannedBlocks: 0, endOfChain: true, status: 'Synced' });
        }
        // F-078: when the previous page stopped mid-block it returned
        // resumeInBlock; the client echoes it as ?resumeBlock=&resumeCount= so
        // this page continues after the rows it already has. Without this the
        // cursor could not advance inside a block with >= limit transfers.
        const resumeBlock = Number.parseInt(req.query.resumeBlock, 10);
        const resumeCount = Number.parseInt(req.query.resumeCount, 10);
        const hasResume = Number.isFinite(resumeBlock) && resumeBlock >= 0 && Number.isFinite(resumeCount) && resumeCount > 0;

        const scan = await scanFinancialTransactions({
            // Resuming inside a height means starting AT it, not below it.
            startBlock: hasResume ? resumeBlock : Math.max(beforeBlock - 1, 0),
            limit,
            maxBlocks,
            skipBlock: hasResume ? resumeBlock : -1,
            skipCount: hasResume ? resumeCount : 0
        });

        res.json({
            transactions: scan.transactions,
            nextBeforeBlock: scan.nextBeforeBlock,
            // F-078: when a single block holds more transfers than one page,
            // `nextBeforeBlock` alone cannot express "resume in the middle of
            // block N". When resumeRequired is true a client MUST echo
            // resumeInBlock back as ?resumeBlock=&resumeCount= — following the
            // height cursor alone will re-read the same block.
            resumeInBlock: scan.resumeInBlock || null,
            resumeRequired: !!scan.resumeInBlock,
            scannedBlocks: scan.scannedBlocks,
            status: 'Synced'
        });
    } catch (err) {
        serverError(res, err, req.path);
    }
});
// Audit F-020: these two endpoints used to read getSyncState('blocks') and
// getSyncState('events') — keys that only the RETIRED standalone syncBlocks /
// syncEvents crawlers ever wrote. The live writer is the combined chain
// indexer under 'chain_index'. Consequences of the dead keys: a fresh install
// reported 'Initializing' forever (SPA refused to render the tables even with
// a healthy index), while long-lived deployments served a fossilised 'Synced'
// + months-old lastSync that no longer described anything. Both endpoints now
// report the health of the indexer that actually populates their tables.
// coverage: the indexer's own account of what it is missing (audit F-004 /
// F-050). Sent on both feeds so a client can distinguish "up to date" from
// "serving data with a known hole in it" without a manual measurement.
function coverageOf(state) {
    return {
        knownGapBlocks: Number(state.knownGapBlocks) || 0,
        // F-046: > 0 means some holes are no longer being retried this round.
        gapsExhausted: Number(state.gapsExhausted) || 0,
        retryableFailures: Number(state.retryableFailures) || 0,
        permanentFailures: Number(state.permanentFailures) || 0,
        detail: state.detail || null
    };
}
app.get('/api/blocks', (req, res) => {
    try {
        const state = db.getSyncState('chain_index');
        cacheShort(res);
        res.json({ blocks: db.getRecentBlocks(200), lastSync: state.lastSync || 0, status: state.status || 'Initializing', coverage: coverageOf(state) });
    } catch (err) { /* F-084 */ console.error('[api] /api/blocks failed:', err && err.stack ? err.stack : err); res.status(500).json({ blocks: [], status: 'Error', error: 'Internal error.' }); }
});
app.get('/api/events', (req, res) => {
    try {
        const state = db.getSyncState('chain_index');
        cacheShort(res);
        res.json({ events: db.getRecentEvents(500), lastSync: state.lastSync || 0, status: state.status || 'Initializing', coverage: coverageOf(state) });
    } catch (err) { /* F-084 */ console.error('[api] /api/events failed:', err && err.stack ? err.stack : err); res.status(500).json({ events: [], status: 'Error', error: 'Internal error.' }); }
});

// --- DETAIL ENDPOINTS (Restored) ---
app.get('/api/block/:id', async (req, res) => {
    // Block detail reads finalized chain state, so it MUST have a live RPC
    // connection. Without this guard the next line would dereference null and
    // throw "Cannot read properties of null (reading 'rpc')" into the UI.
    if (!requireRpc(res)) return;
    try {
        const id = req.params.id.trim();
        let hash = id;
        if (/^\d+$/.test(id)) hash = await getBlockHashCached(parseInt(id));
        const signedBlock = await getBlockCached(hash);
        if (!signedBlock) return res.status(404).json({ error: "Block not found" });

        const timestamp = getBlockTimestamp(signedBlock);

        res.json({
            hash: signedBlock.block.header.hash.toHex(),
            date: timestamp,
            block: signedBlock.toHuman().block
        });
    } catch (err) { serverError(res, err, req.path); }
});

// Normalise an extrinsic hash as it might appear in a URL or shared link:
//   "0xABcd…"  → "0xabcd…"          (case-insensitive)
//   "abcd…"    → "0xabcd…"          (missing 0x prefix)
//   "  0x…  "  → "0x…"              (stray whitespace)
// Returns null when the input doesn't look like a 32-byte hex hash so the
// caller can short-circuit with a 400 instead of doing pointless RPC work.
function normalizeExtrinsicHash(raw) {
    if (typeof raw !== 'string') return null;
    let s = raw.trim().toLowerCase();
    if (!s.startsWith('0x')) s = '0x' + s;
    if (!/^0x[0-9a-f]{64}$/.test(s)) return null;
    return s;
}

// Inspect a single block's extrinsics for one matching `txHash`. Returns
// { extIndex, targetExt, blockNumber } on hit or null on miss. Pulled out
// of the route handler so the ±2 neighbour-block fallback can reuse it
// without duplicating the iteration.
async function findExtrinsicInBlock(blockNumberOrHash, txHash) {
    let blockHash = blockNumberOrHash;
    if (/^\d+$/.test(String(blockNumberOrHash))) {
        try {
            blockHash = await getBlockHashCached(parseInt(blockNumberOrHash, 10));
        } catch (_e) { return null; }
    }
    let signedBlock;
    try { signedBlock = await getBlockCached(blockHash); }
    catch (_e) { return null; }
    if (!signedBlock) return null;
    const extrinsics = signedBlock.block.extrinsics || [];
    for (let i = 0; i < extrinsics.length; i++) {
        if (extrinsics[i].hash.toHex() === txHash) {
            return {
                extIndex: i,
                targetExt: extrinsics[i],
                signedBlock,
                blockHash,
                blockNumber: signedBlock.block.header.number.toNumber()
            };
        }
    }
    return null;
}

app.get('/api/extrinsic/:block/:txHash', async (req, res) => {
    if (!requireRpc(res)) return;
    try {
        const blockId = req.params.block.trim();
        const rawHash = req.params.txHash.trim();
        const txHash = normalizeExtrinsicHash(rawHash);
        if (!txHash) return res.status(400).json({
            error: "That doesn't look like a transaction hash — it should be 64 hex characters (optionally prefixed with 0x).",
            txHash: rawHash,
            hint: 'invalid-format'
        });

        // Try the requested block first.
        let hit = await findExtrinsicInBlock(blockId, txHash);

        // ±2 fallback. Only safe when the URL contained a block NUMBER (we
        // can do arithmetic on it); a block-hash URL points at one specific
        // block, so we don't try to guess neighbours from it. The most
        // common "wrong block" case is an off-by-one from a chain reorg
        // between the time a link was generated and clicked.
        const triedBlocks = [blockId];
        if (!hit && /^\d+$/.test(blockId)) {
            const target = parseInt(blockId, 10);
            for (const delta of [-1, 1, -2, 2]) {
                const candidate = target + delta;
                if (candidate < 0) continue;
                triedBlocks.push(String(candidate));
                hit = await findExtrinsicInBlock(String(candidate), txHash);
                if (hit) break;
            }
        }

        if (!hit) {
            return res.status(404).json({
                error: "Extrinsic not found in block",
                txHash,
                searchedBlocks: triedBlocks,
                // Hint the frontend so it can surface the "search recent blocks"
                // escape hatch instead of just showing a dead-end error.
                hint: 'try-recent-search'
            });
        }

        const { extIndex, targetExt, signedBlock, blockHash, blockNumber } = hit;
        const allEvents = await getEventsAtBlock(blockHash);
        if (!allEvents) return res.status(503).json({ error: 'Cannot decode events at this historical block (the node may have pruned its state).' });
        const txEvents = allEvents.filter(record => record.phase.isApplyExtrinsic && record.phase.asApplyExtrinsic.toNumber() === extIndex);

        const timestamp = getBlockTimestamp(signedBlock);
        const status = getExtrinsicStatus(allEvents, extIndex);
        const summary = getExtrinsicAmountSummary(targetExt);

        // If we found the tx in a neighbour block, surface `correctedFrom`
        // so the frontend can replaceState the URL onto the right block.
        const correctedFrom = (/^\d+$/.test(blockId) && parseInt(blockId, 10) !== blockNumber)
            ? parseInt(blockId, 10)
            : null;

        res.json({
            hash: txHash,
            block: blockNumber,
            correctedFrom,
            time: timestamp,
            event: `${targetExt.method.section} -> ${targetExt.method.method}`,
            from: targetExt.isSigned ? targetExt.signer.toString() : "System",
            to: summary.to,
            amount: summary.amount,
            status: status,
            extrinsic: targetExt.toHuman(),
            events: txEvents.map(e => e.toHuman().event)
        });
    } catch (err) { serverError(res, err, req.path); }
});

// Locate a transaction by hash when the user has the hash but not the
// correct block number. Scans backwards from the chain head up to a
// capped window (default 200 blocks; ?recent=N to widen, max 2000).
// Useful as a fallback when /api/extrinsic/:block/:txHash 404s — the
// frontend's tx-detail error UX hits this to recover the right URL.
//
// Returns either:
//   { found: true,  block, txHash }                 → frontend redirects
//   { found: false, txHash, scanned, fromBlock, toBlock } → suggest deep search
//
// Note: deliberately scans the chain (RPC) rather than the SQLite index
// because the tx might exist on chain but not yet in our event index
// (e.g. during a backfill gap). The chain is the source of truth here.
app.get('/api/extrinsic-by-hash/:txHash', async (req, res) => {
    if (!requireRpc(res)) return;
    try {
        const txHash = normalizeExtrinsicHash(req.params.txHash);
        if (!txHash) return res.status(400).json({
            error: "That doesn't look like a transaction hash — it should be 64 hex characters (optionally prefixed with 0x).",
            txHash: rawHash,
            hint: 'invalid-format'
        });

        // Cap the scan so a runaway query can't burn through the RPC node.
        // 200 blocks ≈ 40 minutes of chain history at 12s/block — covers
        // the "stale link" use case without scanning forever. Raise via
        // ?recent= if you really need to (max 2000 = ~6h).
        const requested = parseInt(req.query.recent, 10);
        const recent = Math.min(Math.max(Number.isFinite(requested) ? requested : 200, 1), 2000);

        const head = (await globalApi.rpc.chain.getHeader()).number.toNumber();
        const fromBlock = head;
        const toBlock = Math.max(0, head - recent + 1);
        let scanned = 0;

        // Walk backwards. We chunk into small concurrent batches (8 at a
        // time) so a 200-block scan completes in ~2-3 seconds on a healthy
        // node instead of ~20s serially.
        const BATCH = 8;
        for (let top = fromBlock; top >= toBlock; top -= BATCH) {
            const chunk = [];
            for (let n = top; n > top - BATCH && n >= toBlock; n--) chunk.push(n);
            scanned += chunk.length;
            const results = await Promise.all(chunk.map(n => findExtrinsicInBlock(String(n), txHash)));
            const found = results.find(r => r && r.targetExt);
            if (found) {
                return res.json({ found: true, block: found.blockNumber, txHash, scanned });
            }
        }
        res.json({ found: false, txHash, scanned, fromBlock, toBlock });
    } catch (err) {
        console.error('API Error /api/extrinsic-by-hash/:txHash:', err);
        serverError(res, err, req.path);
    }
});

app.get('/api/validator/:address', async (req, res) => {
    if (!requireRpc(res)) return;
    // F-082: this took req.params.address.trim() raw into getIdentity and
    // staking.bonded, so junk in the URL surfaced as a 500 from the catch
    // below instead of a 400.
    //
    // Normalising is also a correctness win, not just a validation one. The
    // writer stores whatever the chain returns — prefix 88 — while a user can
    // paste the same key in prefix-42 or -0 form from another explorer.
    // getValidatorHistory matches on `address = ?` exactly, so that paste
    // previously returned an empty era history for a validator that has one,
    // with nothing to indicate the address had simply been spelled differently.
    const gated = gateAddressParams(req, res, 'address');
    if (!gated) return;
    try {
        const address = gated.address;

        let identity = await getIdentity(globalApi, address);
        let controller = address;
        const bondedOpt = await globalApi.query.staking.bonded(address);
        if (bondedOpt && bondedOpt.isSome) controller = bondedOpt.unwrap().toString();

        let history = db.getValidatorHistory(address);
        let triggers = db.getValidatorTriggers(address);

        if (history.length < VALIDATOR_HISTORY_ERAS) {
            const loadedHistory = await loadValidatorHistory(address);
            history = loadedHistory.history;
            triggers = loadedHistory.triggers.slice().sort((a, b) => b.era - a.era);
        }

        // Derived metrics for the validator scorecard. Computed here rather
        // than on the frontend so every caller (UI, API consumers, future
        // alerts) gets identical numbers.
        const scorecard = computeValidatorScorecard(history, triggers);

        res.json({ address, identity, controller, history, triggers, scorecard });
    } catch (err) { serverError(res, err, req.path); }
});

// Pure function — derives summary metrics from a validator's per-era history.
// Returns null when there's no history (caller should hide the card in that
// case). Kept as a free function so we can also wire it into an alerts pipeline
// later without re-fetching from the chain.
function computeValidatorScorecard(history, triggers) {
    if (!Array.isArray(history) || history.length === 0) return null;
    // Only count eras where the validator was actually in the active set
    // (stake > 0). Idle eras would otherwise drag the APY average down to
    // zero and misrepresent the validator's actual performance.
    const activeEntries = history.filter(h => Number(h.stake) > 0);
    const totalEras = history.length;
    const activeEras = activeEntries.length;
    const activeEraRate = totalEras ? activeEras / totalEras : 0;

    const commissions = history.map(h => Number(h.commission) || 0);
    const avgCommission = commissions.reduce((s, c) => s + c, 0) / Math.max(commissions.length, 1);
    const minCommission = commissions.length ? Math.min(...commissions) : 0;
    const maxCommission = commissions.length ? Math.max(...commissions) : 0;

    // APY estimate — average across the active eras. Using the active subset
    // avoids the misleading "0% APY" pull from idle eras (which encode no
    // payout, not a payout of zero).
    const apys = activeEntries.map(h => Number(h.apy) || 0);
    const estimatedApy = apys.length ? apys.reduce((s, a) => s + a, 0) / apys.length : 0;

    const currentStake = Number(history[0] && history[0].stake) || 0;

    return {
        estimatedApy,        // mean APY over active eras
        avgCommission,       // mean commission over all eras in history window
        minCommission,
        maxCommission,
        activeEras,          // eras where stake > 0
        totalEras,           // total eras in the history window
        activeEraRate,       // 0..1
        currentStake,        // PDEX in the most recent era we have
        // Audit F-115: this was `slashCount`, and the frontend rendered it under
        // a "Slash history" heading. It has never counted slashes. It counts
        // commission-cross triggers — eras where this validator raised its
        // commission from <=50% to >50%. Those are worth surfacing, but calling
        // them slashes tells a nominator their validator was PENALISED by the
        // chain when it was not, which is a serious thing to get wrong on a
        // page people use to choose where to stake.
        commissionSpikeCount: Array.isArray(triggers) ? triggers.length : 0,
        // Kept so an older cached frontend bundle does not render "undefined"
        // during the deploy window. Remove after one release.
        slashCount: Array.isArray(triggers) ? triggers.length : 0,
        historyWindow: totalEras
    };
}

app.get('/api/search/:query', async (req, res) => {
    const q = req.params.query.trim();
    // Fail fast with a JSON error when the chain RPC isn't currently usable —
    // otherwise the sequential getBlockHash/derive.chain.getBlock/system.account
    // calls below can each stall for tens of seconds while the WsProvider is
    // reconnecting, leaving nginx to time out at its proxy_read_timeout and
    // return an HTML 504 page (which then breaks the frontend's JSON parser).
    if (!requireRpc(res)) return;
    try {
        if (/^\d+$/.test(q)) {
            const hash = await getBlockHashCached(parseInt(q));
            if (hash && !hash.isEmpty) {
                const derivedBlock = await globalApi.derive.chain.getBlock(hash);
                if (derivedBlock) return res.json({ type: 'block', data: { number: parseInt(q), hash: hash.toHex(), authorAddress: derivedBlock.author ? derivedBlock.author.toString() : "System", extrinsicsCount: derivedBlock.block.extrinsics.length, eventsCount: derivedBlock.events ? derivedBlock.events.length : 0 } });
            }
        }
        if (q.startsWith('0x') && q.length === 66) {
            try {
                const derivedBlock = await globalApi.derive.chain.getBlock(q);
                if (derivedBlock) return res.json({ type: 'block', data: { number: derivedBlock.block.header.number.toNumber(), hash: q, authorAddress: derivedBlock.author ? derivedBlock.author.toString() : "System", extrinsicsCount: derivedBlock.block.extrinsics.length, eventsCount: derivedBlock.events ? derivedBlock.events.length : 0 } });
            } catch (e) { }
        }
        try {
            const accountInfo = await globalApi.query.system.account(q);
            const name = await getIdentity(globalApi, q);
            const free = formatPDEX(accountInfo.data.free);
            const reserved = formatPDEX(accountInfo.data.reserved); // F-043: BigInt-safe
            if (free > 0 || reserved > 0 || name !== "Unknown") return res.json({ type: 'account', data: { address: q, name: name, balance: free + reserved, free: free, reserved: reserved } });
        } catch (e) { }
        res.status(404).json({ error: 'No exact deep network match found.' });
    } catch (err) { serverError(res, err, req.path); }
});

app.get('/api/account/:address', async (req, res) => {
    // Audit F-080 / F-082: this endpoint took the path segment raw — no
    // validation, no SS58 normalisation — so a prefix-42 spelling of an
    // account returned a different (usually empty) transaction list than the
    // prefix-88 one, and garbage reached the chain query. Every other address
    // route already validates + normalises; this one now shares that gate,
    // and the raw form is passed alongside so history written before the
    // writer normalised is still found.
    const raw = (req.params.address || '').trim();
    if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid Polkadex address.' });
    let address;
    try { address = normalizeAddress(raw); }
    catch (e) { return res.status(400).json({ error: 'Invalid Polkadex address.' }); }
    if (!requireRpc(res)) return;
    try {
        const accountInfo = await globalApi.query.system.account(address);
        const name = await getIdentity(globalApi, address);
        const free = formatPDEX(accountInfo.data.free);
        const reserved = formatPDEX(accountInfo.data.reserved); // F-043: BigInt-safe

        // F-053: rank is null when the address is outside the top-500
        // snapshot — "0" read as a rank better than #1.
        let txs = [], evs = [], rank = null;
        try {
            const holderRank = db.getHolderRank(address);
            if (holderRank) rank = holderRank.toString();
            txs = db.getTransactionsByAddress(address, 200, raw);
            evs = db.getEventsByAddress(address, 200);
        } catch (e) { }

        // Audit F-136 (round 2). `balanceFrozen` used to be the RESERVED value.
        //
        // Reserved and frozen are different Substrate concepts — reserves back
        // deposits (identity, proxies, multisig) and are removed from `free`;
        // freezes back locks (vesting, staking) and OVERLAP `free`. Round 1
        // added the correctly-named `balanceReserved` and left `balanceFrozen`
        // aliased to it "for one release", so the field is still on the wire
        // and still wrong.
        //
        // Making it TRUE rather than deleting it: a client reading a field
        // called "frozen" wants the frozen amount, and any that still reads it
        // gets a right answer instead of a missing one. Deleting would have
        // rendered NaN in every cached SPA bundle that still has the fallback.
        //
        // `frozen` is the modern single field; older runtimes split it into
        // miscFrozen/feeFrozen and the effective lock is the LARGER of the two
        // (they overlap rather than sum). Falls back to 0 rather than to
        // `reserved`, because 0 is honest about not knowing and `reserved` is
        // the exact confusion this finding is about.
        const frozen = (() => {
            const d = accountInfo.data;
            if (d.frozen !== undefined) return formatPDEX(d.frozen);
            const misc = d.miscFrozen !== undefined ? formatPDEX(d.miscFrozen) : 0;
            const fee  = d.feeFrozen  !== undefined ? formatPDEX(d.feeFrozen)  : 0;
            return Math.max(misc, fee);
        })();
        // Audit F-085: this payload mixes two very different kinds of data and
        // used to hard-code `status: 'Synced'` over both.
        //
        //   LIVE (chain RPC, always current): balances, identity.
        //   INDEXED (our SQLite, only as complete as the indexer): the
        //     transaction and event lists, which are capped at 200 rows AND
        //     bounded below by however far the backfill has reached (F-008).
        //
        // A caller reading `status: 'Synced'` next to a truncated, backfilling
        // transaction list reasonably concludes the account simply has no older
        // activity. It is the same class of untruth as F-004's status: an
        // absence presented as a fact. The real watermark comes from
        // getSyncState, and the two provenances are now labelled separately so
        // nobody has to guess which half a field came from.
        const chainState = db.getSyncState('chain_index') || {};
        const blocksState = db.getSyncState('blocks') || {};
        res.json({
            account: address, display: name,
            balanceTotal: free + reserved, balanceFree: free,
            balanceReserved: reserved, balanceFrozen: frozen,
            roles: "User", rank: rank,
            transactions: txs, events: evs,
            // F-085: what each half of this response actually is.
            provenance: {
                balances: 'live-rpc',
                identity: 'live-rpc',
                transactions: 'index',
                events: 'index'
            },
            index: {
                status: chainState.status || blocksState.status || 'Unknown',
                lastSync: chainState.lastSync || blocksState.lastSync || 0,
                // True when the lists may be missing older rows, so a client
                // can say "as far back as we have indexed" instead of implying
                // the account had no earlier activity.
                //
                // A review caught the first version testing only the ROW CAP,
                // while the comment above this block already named the other
                // half: the lists are also bounded below by however far the
                // backfill has reached (F-008). An account with five transfers
                // all older than oldestScannedBlock returned truncated:false
                // and read as "no earlier activity" — the absence-as-fact this
                // finding exists to stop, surviving inside its own fix.
                truncated: (txs.length >= 200) || (evs.length >= 200)
                    || !chainState.backfillComplete,
                rowLimit: 200,
                // Below this height we have not indexed yet; anything older is
                // unknown rather than absent.
                oldestScannedBlock: chainState.oldestScannedBlock ?? null,
                backfillComplete: !!chainState.backfillComplete
            },
            // Deprecated: kept one release so an older cached bundle does not
            // render "undefined". It was never a truthful field — read
            // `index.status` instead.
            status: chainState.status || 'Unknown'
        });
    } catch (err) { serverError(res, err, req.path); }
});

// --- STAKING REWARDS ENDPOINTS ---
app.get('/api/staking-rewards-status', (req, res) => {
    try {
        const s = db.getSyncState('staking_rewards');
        cacheMedium(res);
        res.json({
            // F-009 (round 2): two watermarks, because they answer different
            // questions. `latestScannedBlock` is now the VERIFIED top — nothing
            // missing at or below it — so on its own it would understate how
            // much history is actually queryable while a hole is being
            // repaired. `headSeen` is how far the crawler has reached. A client
            // showing coverage wants headSeen; one deciding whether a payout
            // total is complete wants latestScannedBlock.
            latestScannedBlock: s.latestScannedBlock || 0,
            headSeen: readHeadSeen(s),
            oldestScannedBlock: s.oldestScannedBlock || 0,
            backfillComplete: !!s.backfillComplete,
            retryableFailures: Number(s.retryableFailures) || 0,
            permanentFailures: Number(s.permanentFailures) || 0,
            addressesIndexed: db.countStakingRewardStashes(),
            totalRewardsIndexed: db.countStakingRewards(),
            lastSync: s.lastSync || 0,
            status: s.status || 'Initializing'
        });
    } catch (err) {
        serverError(res, err, req.path);
    }
});

app.get('/api/staking-rewards/:address', async (req, res) => {
    const raw = (req.params.address || '').trim();
    if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid Polkadex wallet address.' });
    let address;
    try { address = normalizeAddress(raw); }
    catch (e) { return res.status(400).json({ error: 'Invalid Polkadex wallet address.' }); }

    try {
        const claimed = db.getStakingRewards(address).map(r => ({
            era: r.era, amount: r.amount, validator: r.validator, block: r.block,
            blockHash: r.blockHash, eventIndex: r.eventIndex, timestamp: r.timestamp, status: 'claimed'
        }));
        const unclaimedRaw = db.getUnclaimed(address).map(r => ({
            era: r.era, amount: r.amount, validator: r.validator || null, block: null,
            blockHash: null, eventIndex: null, timestamp: null, status: 'unclaimed'
        }));

        // F-002: reconcile at READ time, not just when the cache is recomputed.
        // The cached unclaimed set has a TTL, so right after a claim the era is
        // in `claimed` (the indexer is seconds behind the chain) and still in
        // the cache — and the old code added both into totalAmount.
        const reconciled = summarizeRewards(claimed, unclaimedRaw);
        const unclaimed = reconciled.unclaimed;

        // Unpaid rewards are computed on demand; refresh in the background when stale.
        const unclaimedAt = db.getUnclaimedComputedAt(address);
        const unclaimedFresh = unclaimedAt > Date.now() - UNCLAIMED_TTL;
        if (!unclaimedFresh && !computingUnclaimed.has(address)) recomputeUnclaimed(address);

        let identity = 'Unknown';
        try { identity = await getIdentity(globalApi, address); } catch (e) { }

        // Current bonded (active) stake — the denominator for the realized
        // APR calculation. Resolved by the standard two-hop pattern: the
        // address's stash holds the controller via staking.bonded, and the
        // controller holds the ledger via staking.ledger.
        //
        // IMPORTANT: modern Substrate unified stash and controller, so an
        // account that bonded after that change has staking.bonded(stash)
        // returning NONE — the controller is the stash itself. The
        // previous version of this code only queried ledger(controller)
        // when bondedOpt.isSome, which meant post-unification accounts
        // always got bondedAmount = null, which surfaced as the misleading
        // "No bonded stake on this account" message on the My Account APR
        // card even when the wallet was fully staked.
        //
        // Mirror the /api/wallet/:address logic by falling back to the
        // address itself as the controller candidate when staking.bonded
        // returns None. Both ledger and bonded lookups are wrapped in
        // try/catch so an RPC disconnect mid-fetch leaves bondedAmount
        // null cleanly rather than throwing.
        let bondedAmount = null;
        try {
            if (globalApi && globalApi.query && globalApi.query.staking && globalApi.query.staking.bonded) {
                const bondedOpt = await globalApi.query.staking.bonded(address);
                const controller = (bondedOpt && bondedOpt.isSome) ? bondedOpt.unwrap().toString() : address;
                const ledgerOpt = await globalApi.query.staking.ledger(controller);
                if (ledgerOpt && ledgerOpt.isSome) {
                    bondedAmount = balanceToPDEX(ledgerOpt.unwrap().active);
                }
            }
        } catch (_e) { /* keep bondedAmount null */ }

        const newest = claimed.length ? claimed[0] : null;
        const oldest = claimed.length ? claimed[claimed.length - 1] : null;
        const syncState = db.getSyncState('staking_rewards');

        // Realized APR — three sliding windows. Uses CLAIMED rewards only
        // (unclaimed entitlements aren't realised income yet) and the
        // current bonded amount as the stake denominator. The stake-at-
        // each-era approach would be more accurate but requires per-era
        // bond snapshots we don't index; current bonded is a reasonable
        // proxy for accounts whose stake hasn't changed dramatically.
        // See computeRealizedApr for the formula and edge-case handling.
        const nowTs = Date.now();
        const apr = bondedAmount && bondedAmount > 0 ? {
            bondedAmount,
            apr30d: computeRealizedApr(claimed, bondedAmount, nowTs, 30),
            apr90d: computeRealizedApr(claimed, bondedAmount, nowTs, 90),
            aprAll: computeRealizedApr(claimed, bondedAmount, nowTs, null)
        } : { bondedAmount, apr30d: null, apr90d: null, aprAll: null };

        res.json({
            address,
            identity,
            claimed,
            unclaimed,
            apr,
            summary: {
                // claimedTotal / unclaimedTotal / totalAmount / eraCount all
                // come from the reconciled figures (F-002) — see
                // lib/reward-dedup.js.
                ...reconciled.summary,
                firstBlock: oldest ? oldest.block : null,
                lastBlock: newest ? newest.block : null,
                firstTimestamp: oldest ? oldest.timestamp : null,
                lastTimestamp: newest ? newest.timestamp : null
            },
            unclaimedFresh,
            unclaimedComputing: !unclaimedFresh,
            index: {
                latestScannedBlock: syncState.latestScannedBlock || 0,
                oldestScannedBlock: syncState.oldestScannedBlock || 0,
                backfillComplete: !!syncState.backfillComplete,
                lastSync: syncState.lastSync || 0,
                status: syncState.status || 'Initializing'
            },
            status: syncState.status || 'Initializing'
        });
    } catch (err) {
        serverError(res, err, req.path);
    }
});

// --- PRICE ENDPOINTS ---
// Multi-provider: each row in price_history carries a `source` tag. The
// dashboard treats the series as one (it doesn't matter who supplied a
// given point), but the bySource map lets advanced consumers — and a future
// "show CMC vs AscendEX" overlay — pick a specific feed.
function buildProviderRollup() {
    const rollup = {};
    for (const name of PRICE_PROVIDERS) {
        const state = db.getSyncState(`price:${name}`);
        rollup[name] = {
            label: priceProviderLabel(name),
            configured: isPriceProviderConfigured(name),
            lastSync: state.lastSync || 0,
            status: state.status || 'Initializing',
            error: state.error || null,
            latest: db.getLatestPriceBySource(name),
            count: db.countPricePointsBySource(name),
        };
    }
    return rollup;
}
app.get('/api/price-latest', (req, res) => {
    try {
        const state = db.getSyncState('price');
        cacheMedium(res);
        // "configured" is true if AT LEAST ONE provider is set up — historically
        // the frontend used this to gate "Price feed not configured" copy. With
        // AscendEX defaulted on (public endpoint), this is always true now, but
        // keep the field for backwards compatibility.
        const configured = PRICE_PROVIDERS.some(p => isPriceProviderConfigured(p));
        res.json({
            price: db.getLatestPrice(),
            lastSync: state.lastSync || 0,
            status: state.status || 'Initializing',
            configured,
            providers: PRICE_PROVIDERS,
            bySource: buildProviderRollup(),
        });
    } catch (err) { serverError(res, err, req.path); }
});
app.get('/api/price-history', (req, res) => {
    try {
        // Cap raised from 365 → 4000 days so the /price page's "All-time"
        // view can serve the full backfilled history (PDEX has been trading
        // since March 2022 ≈ 1500 days as of June 2026). 4000 days = ~11
        // years, comfortably covers any conceivable PDEX history.
        const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 4000);
        const since = Date.now() - days * 24 * 60 * 60 * 1000;
        const configured = PRICE_PROVIDERS.some(p => isPriceProviderConfigured(p));
        cacheLong(res);
        res.json({
            history: db.getPriceHistory(since),
            latest: db.getLatestPrice(),
            configured,
            providers: PRICE_PROVIDERS,
            bySource: buildProviderRollup(),
        });
    } catch (err) { serverError(res, err, req.path); }
});

// --- WALLET DASHBOARD ENDPOINT ---
// Summarize the governance crawler progress for the frontend.
function governanceHistoryMeta() {
    const s = db.getSyncState('governance');
    return {
        status: s.status || 'Initializing',
        backfillComplete: !!s.backfillComplete,
        oldestScannedBlock: Number(s.oldestScannedBlock) || 0,
        // F-010 (round 2): verified vs reached. See /api/staking-rewards-status.
        latestScannedBlock: Number(s.latestScannedBlock) || 0,
        headSeen: readHeadSeen(s),
        lastSync: s.lastSync || 0
    };
}

app.get('/api/council', (req, res) => {
    try {
        const data = db.getKv('council') || { members: [], runnersUp: [], candidates: [], motions: [], blocksRemaining: 0, termDuration: 0, desiredMembers: 0, desiredRunnersUp: 0, collectivePallet: null };
        data.motionHistory = db.getCouncilMotions();
        data.history = governanceHistoryMeta();
        // Short tier, not long. This payload carries LIVE vote tallies on open
        // motions; cacheLong meant a fresh vote could hide behind up to 5 min
        // of browser cache + 10 min of CDN cache — council members watched
        // their own just-cast vote fail to appear. The KV read this serves is
        // trivially cheap, so the short tier costs the origin nothing.
        cacheShort(res);
        res.json(data);
    } catch (err) {
        console.error('API Error /api/council:', err);
        res.status(500).json({ error: 'Failed to fetch council data' });
    }
});

app.get('/api/treasury', (req, res) => {
    try {
        const data = db.getKv('treasury') || {
            proposals: [],
            approvals: [],
            spendPeriod: 0,
            burn: 0,
            blocksRemaining: 0,
            spendableFunds: 0,
            proposalCount: 0
        };
        data.allProposals = db.getTreasuryProposals();
        data.history = governanceHistoryMeta();
        cacheLong(res);
        res.json(data);
    } catch (err) {
        console.error('API Error /api/treasury:', err);
        res.status(500).json({ error: 'Failed to fetch treasury data' });
    }
});

app.get('/api/democracy', (req, res) => {
    try {
        const meta = db.getKv('democracy_meta') || {};
        const state = db.getSyncState('democracy');
        cacheLong(res);
        res.json({
            referendumCount: meta.referendumCount || 0,
            publicPropCount: meta.publicPropCount || 0,
            activeReferenda: meta.activeReferenda || 0,
            activeProposals: meta.activeProposals || 0,
            launchPeriod: meta.launchPeriod || 0,
            currentBlock: meta.currentBlock || 0,
            lowestUnbaked: meta.lowestUnbaked || 0,
            totalIssuance: meta.totalIssuance || 0,
            publicProposals: meta.publicProposals || [],
            externalProposal: meta.externalProposal || null,
            referenda: db.getDemocracyReferenda(),
            lastSync: meta.lastSync || state.lastSync || 0,
            status: state.status || 'Initializing'
        });
    } catch (err) {
        console.error('API Error /api/democracy:', err);
        res.status(500).json({ error: 'Failed to fetch democracy data' });
    }
});

// isOpenGovStatus is imported from ./lib/gov-status.js (audit F-003 — one
// case-insensitive predicate shared by banner, calendar, and email so the
// indexer's casing can't drift from the consumers' comparison again).
// Unit-tested in test/gov-status.test.js.

// --- Governance: latest events (for notification polling) ---------------------
// Small, hot endpoint that frontend polls every ~30s to detect new referenda
// or proposals. Returns just the indices + tabled timestamps the frontend
// compares against locally-stored "last seen" values; payload stays under
// ~1KB so polling cost is negligible. cacheShort so an update reaches users
// within ~10s of the indexer recording it.
app.get('/api/governance/latest', (req, res) => {
    try {
        const meta = db.getKv('democracy_meta') || {};
        const referenda = db.getDemocracyReferenda();
        const proposals = meta.publicProposals || [];

        // Only surface OPEN referenda in the notification stream. Closed ones
        // (passed/cancelled/notpassed) shouldn't pop a banner — the user
        // can't do anything actionable about them.
        const openReferenda = referenda.filter(r => r && isOpenGovStatus(r.status));
        // Of those, surface the highest-indexed one (most recently tabled).
        let topOpenRef = null;
        for (const r of openReferenda) {
            if (!topOpenRef || (Number(r.refIndex) || 0) > (Number(topOpenRef.refIndex) || 0)) {
                topOpenRef = r;
            }
        }
        const latestReferendum = topOpenRef ? {
            refIndex: Number(topOpenRef.refIndex) || 0,
            status: topOpenRef.status || null,
            endBlock: topOpenRef.endBlock || null,
            proposal: topOpenRef.proposal || null,
            isActive: true
        } : null;

        // Public proposals come from the chain in array form; element 0 is the
        // most recently submitted on most runtimes. Defensive in case ordering
        // ever changes upstream — take the max-index entry.
        let latestProposal = null;
        if (proposals.length > 0) {
            let top = proposals[0];
            for (const p of proposals) {
                if ((Number(p.index) || 0) > (Number(top.index) || 0)) top = p;
            }
            latestProposal = {
                index: Number(top.index) || 0,
                proposer: top.proposer || null,
                deposit: top.deposit || null,
                preimage: top.preimage || null
            };
        }

        cacheShort(res);
        res.json({
            latestReferendum,
            latestProposal,
            activeReferendaCount: meta.activeReferenda || 0,
            activeProposalsCount: meta.activeProposals || 0,
            lastSync: meta.lastSync || 0
        });
    } catch (err) {
        console.error('API Error /api/governance/latest:', err);
        res.status(500).json({ error: 'Failed to fetch latest governance events' });
    }
});

// --- Governance: unified calendar ---------------------------------------------
// One endpoint feeding the /calendar page. Aggregates democracy referenda,
// council motions, and treasury proposals into a single time-anchored event
// list. Each event carries: id, kind, title, status, startBlock/Time,
// endBlock/Time (where applicable), isActive, link. Frontend can group/sort
// by time, filter by kind, or render as month-grid or list.
//
// End times for in-progress events are estimated from the chain's current
// block + per-block average (Polkadex runs ~12s blocks). For resolved
// events we use the recorded resolved_at timestamp directly.
app.get('/api/governance/calendar', async (req, res) => {
    try {
        const referenda = db.getDemocracyReferenda();
        const treasury  = db.getTreasuryProposals();
        const motions   = db.getCouncilMotions();
        const meta      = db.getKv('democracy_meta') || {};

        const currentBlock = meta.currentBlock || 0;
        const currentTime  = Date.now();
        const BLOCK_TIME_MS = 12000; // Polkadex BABE expectedBlockTime

        // Convert an absolute block number to estimated wall-clock time. Returns
        // null when we don't have a current-block anchor (cold start). Used for
        // both future end times (referenda) and past block-only timestamps.
        const blockToTime = (block) => {
            if (!block || !currentBlock) return null;
            const blockDiff = Number(block) - currentBlock;
            return currentTime + blockDiff * BLOCK_TIME_MS;
        };

        const events = [];

        // Democracy referenda. Ongoing entries have an end_block that hasn't
        // happened yet; resolved entries (passed/cancelled/notpassed) have an
        // end_block in the past.
        for (const r of referenda) {
            const isActive = isOpenGovStatus(r.status);
            events.push({
                id: 'ref-' + r.refIndex,
                kind: 'referendum',
                title: 'Referendum #' + r.refIndex,
                status: r.status || 'unknown',
                proposal: r.proposal || null,
                ayes: r.ayes || null,
                nays: r.nays || null,
                turnout: r.turnout || null,
                startBlock: null, // we don't store the tabled block
                startTime: null,
                endBlock: r.endBlock || null,
                endTime: blockToTime(r.endBlock),
                isActive,
                link: '/democracy?ref=' + r.refIndex
            });
        }

        // Treasury proposals — proposed_at / resolved_at are real epoch ms.
        for (const p of treasury) {
            // Audit F-111: `approved` was treated as inactive, but an approved
            // treasury proposal is still LIVE — it sits in the approvals queue
            // waiting for the next spend period to pay it, and it is arguably
            // the most interesting thing on the calendar because it has a
            // predictable payout date. Only 'awarded', 'rejected' and F-052's
            // 'resolved' mean finished.
            const isActive = !p.status || p.status === 'proposed' || p.status === 'approved';
            events.push({
                id: 'treasury-' + p.id,
                kind: 'treasury',
                title: 'Treasury Proposal #' + p.id,
                status: p.status || 'proposed',
                proposer: p.proposer || null,
                proposerName: p.proposerName || null,
                beneficiary: p.beneficiary || null,
                beneficiaryName: p.beneficiaryName || null,
                value: p.value || null,
                startBlock: p.proposedBlock || null,
                startTime: p.proposedAt || blockToTime(p.proposedBlock),
                endBlock: p.resolvedBlock || null,
                endTime: p.resolvedAt || blockToTime(p.resolvedBlock),
                isActive,
                link: '/treasury?proposal=' + p.id
            });
        }

        // Council motions — similar to treasury, with proposer + extrinsic info.
        for (const m of motions) {
            // F-052: 'resolved' (left chain storage, outcome unknown) is NOT
            // active. Motions have no equivalent of treasury's approved-and-
            // waiting state — a motion is open until it is closed.
            const isActive = !m.status || m.status === 'proposed';
            events.push({
                id: 'motion-' + m.motionIndex,
                kind: 'motion',
                title: 'Council Motion #' + m.motionIndex,
                status: m.status || 'proposed',
                proposer: m.proposer || null,
                proposerName: m.proposerName || null,
                section: m.section || null,
                method: m.method || null,
                threshold: m.threshold || null,
                ayes: m.ayes || null,
                nays: m.nays || null,
                startBlock: m.proposedBlock || null,
                startTime: m.proposedAt || blockToTime(m.proposedBlock),
                endBlock: m.resolvedBlock || null,
                endTime: m.resolvedAt || blockToTime(m.resolvedBlock),
                isActive,
                link: '/council?motion=' + m.motionIndex
            });
        }

        // Sort: most recently-active first (max of endTime, startTime); active
        // events float above resolved when timestamps tie.
        events.sort((a, b) => {
            if (a.isActive && !b.isActive) return -1;
            if (b.isActive && !a.isActive) return 1;
            const at = a.endTime || a.startTime || 0;
            const bt = b.endTime || b.startTime || 0;
            return bt - at;
        });

        cacheLong(res);
        res.json({
            events,
            count: events.length,
            activeCount: events.filter(e => e.isActive).length,
            currentBlock,
            blockTimeMs: BLOCK_TIME_MS,
            lastUpdate: Date.now()
        });
    } catch (err) {
        console.error('API Error /api/governance/calendar:', err);
        res.status(500).json({ error: 'Failed to fetch governance calendar' });
    }
});

// --- DISCUSSION BOARD: wallet-signature auth ---
const AUTH_SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const AUTH_CHALLENGE_TTL = 10 * 60 * 1000;
const POST_COOLDOWN_MS = 8 * 1000;
// F-075: the per-process Map that used to back POST_COOLDOWN_MS is gone —
// the cooldown now lives in the shared rate_limits table (db.consumeRateLimit).

function challengeMessage(address, nonce) {
    return `Sign in to the Polkadex Explorer discussion board.\n\nAddress: ${address}\nNonce: ${nonce}`;
}

function getAuthAddress(req) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;
    const session = db.getSession(token);
    return session ? session.address : null;
}

// Audit F-070 (SECURITY_AUDIT.md M-2): both auth endpoints were uncapped.
// Unlimited /challenge lets one IP spray INSERT OR REPLACE rows and — because
// the challenge PK is the address — repeatedly overwrite a victim's in-flight
// nonce so their honest login keeps failing. Unlimited /verify burns worker
// CPU on signatureVerify.
//
// Audit F-075 changed HOW it is counted. It used to borrow the developer-API
// Map, which meant (a) the cap was multiplied by the worker count like every
// other in-process limiter, and (b) nonce-overwrite protection — a real
// security property — was sharing a budget with a fairness knob, so raising
// DEV_API_RATE_LIMIT_PER_MIN for developers silently weakened login. Now it has
// its own shared, cluster-wide counter. Login is a once-per-session action, so
// a NAT full of real users stays comfortably under 60/min.
const AUTH_RATE_LIMIT_PER_MIN = readPositiveInteger(process.env.AUTH_RATE_LIMIT_PER_MIN, 60);

function authRateGate(req, res) {
    const result = db.consumeRateLimit('auth', String(clientIp(req)), (hits) =>
        checkWindow(hits, { windowMs: 60 * 1000, limit: AUTH_RATE_LIMIT_PER_MIN })
    );
    if (result.allowed) return true;
    res.set('Cache-Control', 'no-store');
    res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000) || 60));
    res.status(429).json({ error: 'Too many auth requests from this address — wait a minute and retry.' });
    return false;
}

app.post('/api/auth/challenge', (req, res) => {
    if (!authRateGate(req, res)) return;
    const raw = (req.body && req.body.address || '').trim();
    if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid wallet address.' });
    let address;
    try { address = normalizeAddress(raw); } catch (e) { return res.status(400).json({ error: 'Invalid wallet address.' }); }
    const nonce = randomAsHex(16);
    db.setChallenge(address, nonce);
    res.json({ address, message: challengeMessage(address, nonce) });
});

app.post('/api/auth/verify', (req, res) => {
    if (!authRateGate(req, res)) return;
    const raw = (req.body && req.body.address || '').trim();
    const signature = (req.body && req.body.signature || '').trim();
    if (!isValidAddress(raw) || !signature) return res.status(400).json({ error: 'Invalid request.' });
    let address;
    try { address = normalizeAddress(raw); } catch (e) { return res.status(400).json({ error: 'Invalid wallet address.' }); }
    const challenge = db.getChallenge(address);
    if (!challenge || Date.now() - challenge.createdAt > AUTH_CHALLENGE_TTL) {
        return res.status(400).json({ error: 'Login challenge expired — please try again.' });
    }
    const message = challengeMessage(address, challenge.nonce);
    let valid = false;
    try {
        // Browser extensions wrap raw-bytes payloads in <Bytes>…</Bytes>, so accept either form.
        valid = signatureVerify(message, signature, address).isValid
            || signatureVerify(u8aWrapBytes(message), signature, address).isValid;
    } catch (e) { valid = false; }
    if (!valid) {
        // Audit F-134: a failed verify used to LEAVE the challenge row, so the
        // same nonce could be attacked repeatedly for its whole 10-minute TTL.
        // One nonce, one attempt — the client simply requests a new challenge.
        db.deleteChallenge(address);
        return res.status(401).json({ error: 'Signature verification failed — request a new login challenge.' });
    }
    db.deleteChallenge(address);
    const token = randomAsHex(24);
    db.createSession(token, address, AUTH_SESSION_TTL);
    res.json({ token, address, expiresIn: AUTH_SESSION_TTL });
});

app.post('/api/auth/logout', (req, res) => {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) db.deleteSession(token);
    res.json({ ok: true });
});

// ─── Email alert subscriptions ───────────────────────────────────────────────
// Defaults the subscribe modal can render against. Update DEFAULT_EMAIL_PREFS
// alongside any new event type added in the dispatcher.
//
// Schema (all booleans default false unless noted):
//
//   {
//     governance: {
//       newReferendum: true,        // new open referendum tabled
//       newProposal: true,          // new public proposal
//       closingReminder: true,      // 24h before referendum voting closes
//       referendumResult: false,    // passed / cancelled / notpassed
//       treasuryProposal: false,    // new + resolved
//       councilMotion: false        // new + resolved
//     },
//     network: {
//       runtimeUpgrade: false,      // runtime spec version bumped
//       eraBoundary: false,         // new era + summary (validators changed, etc.)
//       chainStalled: false         // chain hasn't advanced for N min (ops-style)
//     },
//     account: {
//       walletAddress: null,        // only set when wallet-signed subscription
//       transferIncoming: { enabled: false, minPdex: 0 },
//       transferOutgoing: { enabled: false, minPdex: 0 },
//       stakingReward:    { enabled: false, minPdex: 0 }
//     },
//     cadence: 'immediate'          // 'immediate' | 'digest'
//   }
const DEFAULT_EMAIL_PREFS = {
    governance: {
        newReferendum: true,
        newProposal: true,
        closingReminder: true,
        referendumResult: false,
        treasuryProposal: false,
        councilMotion: false
    },
    network: {
        runtimeUpgrade: false,
        eraBoundary: false,
        chainStalled: false
    },
    account: {
        walletAddress: null,
        transferIncoming: { enabled: false, minPdex: 0 },
        transferOutgoing: { enabled: false, minPdex: 0 },
        stakingReward:    { enabled: false, minPdex: 0 }
    },
    cadence: 'immediate'
};

// Naive per-IP rate limiter for /api/email/subscribe to deter abuse. The
// limit applies to fresh signups only; resends of the confirmation email
// for an already-pending row are independently rate-limited inside email.js.
const EMAIL_SIGNUP_RATE_LIMIT_PER_HOUR = readPositiveInteger(
    process.env.EMAIL_SIGNUP_RATE_LIMIT_PER_HOUR, 30);
// Audit F-075: was an in-process Map, so the advertised per-hour signup cap was
// really cap × WORKERS. This one is a SECURITY control — it is what stops one
// IP using us to flood arbitrary mailboxes with confirmation mail — and signups
// are rare enough that a SQLite write per attempt costs nothing. Shared counter.
function emailSignupRateOk(ip) {
    return db.consumeRateLimit('email-signup', String(ip), (hits) =>
        checkWindow(hits, { windowMs: 60 * 60 * 1000, limit: EMAIL_SIGNUP_RATE_LIMIT_PER_HOUR })
    ).allowed;
}

// Deep-merge user-submitted partial prefs into DEFAULT_EMAIL_PREFS so unknown
// keys are dropped and required structure stays intact. Defends against the
// frontend ever sending a malformed payload.
// Audit F-135: `walletAddress` is NOT read from `input`. It identifies which
// on-chain account a subscriber gets transfer and reward alerts for, so it is
// an authorisation decision, not a preference — and this function is reached
// by two routes that authenticate very differently:
//
//   POST /api/email/subscribe     — unauthenticated (anyone, any email)
//   POST /api/email/preferences   — the unsubscribe token only
//
// Both used to let the JSON body set it. Account-event dispatchers are not
// implemented yet, which is the only reason this was never exploitable: the
// moment they ship, whoever wrote them inherits a field that any caller could
// already point at any address. It also runs the other way — a subscriber's
// own address could be silently repointed by anyone holding the unsubscribe
// token (which, per F-091, used to appear in access logs).
//
// So the caller must state the provenance explicitly:
//   walletAddress: <address>  — proven by a verified wallet session
//   walletAddress: null       — no session; clear it
//   preserveWallet: <address> — keep what is already stored (prefs update)
function normalizePrefs(input, { walletAddress = null } = {}) {
    const out = JSON.parse(JSON.stringify(DEFAULT_EMAIL_PREFS));
    // Not re-normalised here: the only source is db.getSession(bearer).address,
    // which /api/auth/verify already stored through normalizeAddress (F-080).
    // Normalising again would be harmless but would also imply this function
    // accepts untrusted input, which after F-135 it deliberately does not.
    out.account.walletAddress = walletAddress || null;
    if (!input || typeof input !== 'object') return out;
    for (const cat of ['governance', 'network']) {
        if (input[cat] && typeof input[cat] === 'object') {
            for (const k of Object.keys(out[cat])) {
                if (typeof input[cat][k] === 'boolean') out[cat][k] = input[cat][k];
            }
        }
    }
    if (input.account && typeof input.account === 'object') {
        // NOTE: input.account.walletAddress is deliberately ignored (F-135).
        for (const k of ['transferIncoming', 'transferOutgoing', 'stakingReward']) {
            if (input.account[k] && typeof input.account[k] === 'object') {
                if (typeof input.account[k].enabled === 'boolean')
                    out.account[k].enabled = input.account[k].enabled;
                if (Number.isFinite(Number(input.account[k].minPdex)))
                    out.account[k].minPdex = Math.max(0, Number(input.account[k].minPdex));
            }
        }
    }
    if (input.cadence === 'digest' || input.cadence === 'immediate') {
        out.cadence = input.cadence;
    }
    return out;
}

// Build the user-facing site URL (origin only) — used in confirmation +
// unsubscribe links. Honors SITE_URL env if set, otherwise falls back to
// the request's host header so dev / staging deploys work out of the box.
// Audit F-037: this fell back to `req.protocol://Host` when SITE_URL was
// unset. Behind nginx→backend the protocol on that hop is http, and Host is
// attacker-controllable, so a confirmation link could be minted as
// http://whatever-they-sent/ — mailed to a real person, over a bearer token.
// emailSiteOrigin() is what every ALERT mail already used; confirmation mail
// now shares it, so there is exactly one answer to "what is our origin".
// `req` is kept in the signature for call-site compatibility and ignored.
// F-185: callers that build SEO URLs, not tokenised ones. Kept as a separate
// name so a future tokenised caller cannot reach the production fallback by
// accident — it would have to ask for it explicitly.
function siteOrigin(_req) {
    return siteOriginForSeo();
}

// HTML-escape for token values that go into URLs and templates.
// Audit F-133: forwards to lib/html-escape.js, the same module script.js uses.
// This used to be an independent chain of five .replace() calls that had
// already drifted from the client copy on the apostrophe entity (&#039; here,
// &#39; there). Harmless in itself; the point is that two hand-maintained
// escapers on an XSS boundary will eventually disagree about something that
// is not harmless. The name stays for the existing call sites.
function htmlEscape(s) {
    return sharedEscapeHtml(s);
}

// POST /api/email/subscribe
//   { email, prefs, source, walletAddress (optional), walletAuth (optional Bearer) }
//
// Flow:
//   1. Rate-limit by IP (signup attempts/hour cap).
//   2. Validate email shape; reject obvious junk.
//   3. Normalize prefs against the schema.
//   4. Insert (if-missing) into email_subscribers with random confirmation
//      and unsubscribe tokens. If an existing row is unconfirmed, resend
//      the confirmation; if it's already confirmed, no-op + 200.
//   5. Email the confirmation link.
//   6. Respond JSON { status: 'pending'|'already-confirmed', email }.
app.post('/api/email/subscribe', async (req, res) => {
    // Audit F-185: refuse rather than mail a link that names someone else's
    // host. Without SITE_URL this process would mint a token in its OWN
    // database and send a confirmation URL pointing at the production origin,
    // where that token does not exist — a real email, from us, with a link
    // that can never work. A 503 the operator can see beats a support ticket
    // from a user who confirmed nothing.
    if (!canMintEmailUrls()) {
        console.error('[email] refusing to subscribe: SITE_URL is not set, so any confirmation link would name the wrong host (F-185)');
        res.set('Cache-Control', 'no-store');
        return res.status(503).json({
            error: 'Email signup is not configured on this deployment. Please try again later.'
        });
    }
    // F-019: was a second, spoofable copy of the leftmost-XFF expression.
    const ip = clientIp(req);
    if (!emailSignupRateOk(ip)) {
        return res.status(429).json({ error: 'Too many signup attempts. Please wait an hour.' });
    }
    const email = String((req.body && req.body.email) || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const source = (req.body && req.body.source) || null;

    // Optional wallet-signature path. If the request includes a Bearer token
    // from /api/auth/verify, look up the session and pin the subscription to
    // that address so account-specific events can be wired later. Otherwise
    // walletAddress stays null and the subscriber is email-only.
    //
    // F-135: the session lookup now happens BEFORE normalizePrefs and is the
    // only way the field gets set. Previously prefs were normalised first —
    // copying the body's walletAddress verbatim — and this block only
    // OVERWROTE it when a session existed, so the unauthenticated case kept
    // whatever the caller sent.
    let walletAddress = null;
    const header = req.headers['authorization'] || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (bearer) {
        const sess = db.getSession(bearer);
        if (sess && sess.address) walletAddress = sess.address;
    }
    const prefs = normalizePrefs(req.body && req.body.prefs, { walletAddress });

    const confirmationToken = randomAsHex(24);
    const unsubscribeToken  = randomAsHex(24);
    const { created, subscriber } = db.createEmailSubscriberIfMissing({
        email, confirmationToken, unsubscribeToken, eventPrefs: prefs, source, walletAddress
    });

    // Already-confirmed AND still subscribed: short-circuit, no email.
    //
    // Audit F-042: this used to test `confirmedAt` alone, so anyone who had
    // ever unsubscribed was told "already-confirmed" forever and could never
    // opt back in — the UI reported success while the row stayed
    // unsubscribed and getConfirmedEmailSubscribers kept excluding it. A
    // previously-unsubscribed row now gets a fresh confirmation mail, and
    // confirming it clears unsubscribed_at (db.confirmEmailSubscriber).
    if (!created && subscriber && subscriber.confirmedAt && !subscriber.unsubscribedAt) {
        return res.json({ status: 'already-confirmed', email: subscriber.email });
    }

    // Audit F-110: we used to REUSE the original confirmation token on a
    // resend, so every link ever mailed stayed live forever. Rotate on resend:
    // the newest mail is the only one that works, and its 24h clock restarts.
    // Rotate on ANY resend, not just for never-confirmed rows. A review caught
    // the gap: a confirmed-then-unsubscribed subscriber taking the F-042
    // resubscribe path fell through with its ORIGINAL, never-rotated token,
    // and the freshness checks skip confirmed rows — so that path preserved
    // exactly the "a months-old link is still a live opt-in credential"
    // property F-110 exists to remove.
    let effective = subscriber;
    if (!created && subscriber) {
        try { effective = db.rotateConfirmationToken(subscriber.id, confirmationToken) || subscriber; }
        catch (e) { console.warn('[email] confirmation token rotation failed:', e && e.message ? e.message : e); }
    }
    const origin = siteOrigin(req);
    const confirmUrl     = `${origin}/api/email/confirm?token=${encodeURIComponent(effective.confirmationToken)}`;
    const unsubscribeUrl = `${origin}/api/email/unsubscribe?token=${encodeURIComponent(effective.unsubscribeToken)}`;

    try {
        await sendEmail({
            to: effective.email,
            subject: 'Confirm your Polkadex Explorer alerts subscription',
            tag: 'confirm',
            text:
`Welcome to Polkadex Explorer alerts.

Click the link below to confirm your subscription:

${confirmUrl}

You'll receive an email when new governance events you've subscribed to happen on-chain.

If you didn't sign up, you can ignore this email — without confirmation, no further emails will be sent.

— Polkadex Explorer
${origin}
Unsubscribe at any time: ${unsubscribeUrl}
`,
            html:
`<!doctype html><html><body style="font-family:Inter,-apple-system,Segoe UI,Arial,sans-serif;background:#0a0e1a;color:#e8eaed;margin:0;padding:24px;">
<div style="max-width:560px;margin:0 auto;background:#141929;border-radius:12px;padding:32px;border:1px solid #2a3045;">
  <h1 style="margin:0 0 16px;font-size:1.4rem;color:#fff;">Confirm your subscription</h1>
  <p style="line-height:1.55;color:#cfd5e1;">Welcome to Polkadex Explorer alerts. Click the button below to confirm and start receiving notifications for the events you subscribed to.</p>
  <p style="margin:28px 0;text-align:center;">
    <a href="${htmlEscape(confirmUrl)}" style="display:inline-block;padding:12px 24px;background:#E6007A;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Confirm subscription</a>
  </p>
  <p style="font-size:0.82rem;color:#8a92a6;line-height:1.5;">Didn't sign up? Just ignore this email — we won't send anything else.</p>
  <hr style="border:none;border-top:1px solid #2a3045;margin:28px 0;">
  <p style="font-size:0.75rem;color:#6a7387;line-height:1.5;">
    Polkadex Mainnet Explorer · <a href="${htmlEscape(origin)}" style="color:#8a92a6;">${htmlEscape(origin.replace(/^https?:\/\//, ''))}</a><br>
    <a href="${htmlEscape(unsubscribeUrl)}" style="color:#6a7387;">Unsubscribe</a>
  </p>
</div>
</body></html>`
        });
    } catch (err) {
        console.error('[email] failed to send confirmation:', err && err.message ? err.message : err);
        return res.status(502).json({ error: 'Could not send confirmation email. Please try again in a few minutes.' });
    }

    res.json({ status: 'pending', email: effective.email });
});

// Audit F-001 / F-036: opting in and opting out are STATE CHANGES, and they
// used to happen on GET.
//
// A GET is supposed to be safe — the whole internet assumes it. Corporate mail
// scanners (Microsoft Safe Links, Proofpoint, Gmail's image proxy), antivirus
// link checkers, chat-app unfurlers and browser prefetch all fetch URLs they
// find in email without a human ever clicking. So:
//   * F-001 — subscribe a victim's address, and the first scanner to touch the
//     mailed link completes the opt-in on their behalf. The double-opt-in
//     stopped proving consent, which is the one job it has.
//   * F-036 — the unsubscribe link fires the same way, silently opting real
//     subscribers out.
//
// Both are now: GET renders a page with a button, the button POSTs, the POST
// does the write. Scanners follow links, not form submissions.
//
// This is also why the confirm page no longer prints the unsubscribe token —
// it used to embed it twice in a body that ends up in mail-scanner logs, proxy
// caches, and browser history.

// GET /api/email/confirm?token=... — renders a confirm BUTTON. No write.
app.get('/api/email/confirm', (req, res) => {
    const token = String(req.query.token || '').trim();
    const subscriber = db.getEmailSubscriberByConfirmationToken(token);
    // Audit F-110: enforce the 24h the subscribe modal promises. An expired
    // link reads as "not recognised" and the user requests a fresh one.
    // Expiry applies to any link that still has work to do — a never-confirmed
    // row, OR a confirmed-but-unsubscribed one going through the F-042
    // resubscribe path (that link reactivates a subscription, so it is just as
    // much a live credential).
    const needsConfirmAction = subscriber && (!subscriber.confirmedAt || subscriber.unsubscribedAt);
    if (needsConfirmAction && !db.isConfirmationTokenFresh(subscriber)) {
        res.set('Cache-Control', 'no-store');
        return res.status(410).type('html').send(confirmResultPage({
            title: 'This confirmation link has expired',
            body: '<p>Confirmation links are valid for 24 hours. Request a new one from the explorer and we\'ll email you a fresh link.</p>',
            isError: true
        }));
    }
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (!subscriber) {
        return res.status(404).type('html').send(confirmResultPage({
            title: 'Confirmation link not recognised',
            body: '<p>This confirmation link is invalid or has already been used. If you meant to subscribe, please request a new link from the explorer.</p>',
            isError: true
        }));
    }
    // Only short-circuit when the subscription is confirmed AND live, so a
    // confirmed-then-unsubscribed row at least reaches the POST.
    //
    // Note this does NOT fix F-042, and an earlier version of this comment
    // wrongly claimed it did. Resubscribing is broken at two other points:
    // /api/email/subscribe short-circuits on confirmedAt alone without checking
    // unsubscribedAt, so no new confirmation mail is ever sent; and
    // db.confirmEmailSubscriber guards its write with `if (!row.confirmedAt)`,
    // so even reaching the POST leaves unsubscribed_at set while the page says
    // "You're subscribed!". Fixing that properly is F-042's own change.
    if (subscriber.confirmedAt && !subscriber.unsubscribedAt) {
        return res.type('html').send(confirmResultPage({
            title: 'Already confirmed',
            body: `<p>Your subscription for <strong>${htmlEscape(subscriber.email)}</strong> is already active. Nothing more to do.</p>`,
            isError: false
        }));
    }
    res.type('html').send(confirmResultPage({
        title: 'Confirm your subscription',
        body: `<p>Click the button below to start receiving explorer alerts at <strong>${htmlEscape(subscriber.email)}</strong>.</p>
               ${confirmActionForm('/api/email/confirm', token, 'Confirm subscription')}`,
        isError: false
    }));
});

// POST /api/email/confirm — the actual write.
app.post('/api/email/confirm', formBody, (req, res) => {
    const token = String((req.body && req.body.token) || req.query.token || '').trim();
    // F-110: re-check freshness on the write path too — the GET could have
    // been rendered while still valid and submitted much later.
    const pending = db.getEmailSubscriberByConfirmationToken(token);
    if (pending && (!pending.confirmedAt || pending.unsubscribedAt) && !db.isConfirmationTokenFresh(pending)) {
        res.set('Cache-Control', 'no-store');
        return res.status(410).type('html').send(confirmResultPage({
            title: 'This confirmation link has expired',
            body: '<p>Confirmation links are valid for 24 hours. Request a new one from the explorer.</p>',
            isError: true
        }));
    }
    const subscriber = db.confirmEmailSubscriber(token);
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (!subscriber) {
        return res.status(404).type('html').send(confirmResultPage({
            title: 'Confirmation link not recognised',
            body: '<p>This confirmation link is invalid or has already been used. If you meant to subscribe, please request a new link from the explorer.</p>',
            isError: true
        }));
    }
    res.type('html').send(confirmResultPage({
        title: 'You\'re subscribed!',
        body: `<p>Your subscription is confirmed for <strong>${htmlEscape(subscriber.email)}</strong>. You'll start receiving alerts at the next matching on-chain event.</p>
               <p>Every alert email carries your unsubscribe link. (It is deliberately not repeated on this page — mail scanners fetch these URLs, and the link is a bearer token.)</p>`,
        isError: false
    }));
});

// GET /api/email/unsubscribe?token=... — renders an unsubscribe BUTTON.
//
// Note on RFC 8058 (List-Unsubscribe-Post): mail clients that offer a native
// "unsubscribe" button POST to the List-Unsubscribe URL, so pointing that
// header at the POST route below keeps one-click unsubscribe working without
// reopening the prefetch hole.
app.get('/api/email/unsubscribe', (req, res) => {
    const token = String(req.query.token || '').trim();
    const subscriber = db.getEmailSubscriberByUnsubscribeToken(token);
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (!subscriber) {
        return res.status(404).type('html').send(confirmResultPage({
            title: 'Unsubscribe link not recognised',
            body: '<p>This unsubscribe link is invalid. You may have already unsubscribed, or the link was corrupted in transit. If you continue to receive emails, please contact the explorer team.</p>',
            isError: true
        }));
    }
    if (subscriber.unsubscribedAt) {
        return res.type('html').send(confirmResultPage({
            title: 'Already unsubscribed',
            body: `<p>We are not sending alerts to <strong>${htmlEscape(subscriber.email)}</strong>.</p>`,
            isError: false
        }));
    }
    res.type('html').send(confirmResultPage({
        title: 'Unsubscribe from explorer alerts?',
        body: `<p>This will stop all alert emails to <strong>${htmlEscape(subscriber.email)}</strong>.</p>
               ${confirmActionForm('/api/email/unsubscribe', token, 'Unsubscribe')}`,
        isError: false
    }));
});

// POST /api/email/unsubscribe — the actual write.
app.post('/api/email/unsubscribe', formBody, (req, res) => {
    const token = String((req.body && req.body.token) || req.query.token || '').trim();
    const subscriber = db.unsubscribeEmailSubscriber(token);
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (!subscriber) {
        return res.status(404).type('html').send(confirmResultPage({
            title: 'Unsubscribe link not recognised',
            body: '<p>This unsubscribe link is invalid. You may have already unsubscribed, or the link was corrupted in transit. If you continue to receive emails, please contact the explorer team.</p>',
            isError: true
        }));
    }
    res.type('html').send(confirmResultPage({
        title: 'You\'ve been unsubscribed',
        body: `<p>We've stopped sending alerts to <strong>${htmlEscape(subscriber.email)}</strong>. You can resubscribe any time from the explorer.</p>`,
        isError: false
    }));
});

// POST /api/email/preferences { token, prefs }
// Token-authenticated preferences update. Uses the unsubscribeToken — the
// user only needs that one URL to manage everything.
app.post('/api/email/preferences', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = String((req.body && req.body.token) || '').trim();
    // F-135: this route proves possession of the unsubscribe token, which says
    // "you can read this mailbox" — not "you control that on-chain account".
    // Carry the stored address forward untouched; changing it requires a wallet
    // signature through /api/email/subscribe.
    const existing = db.getEmailSubscriberByUnsubscribeToken(token);
    if (!existing) return res.status(404).json({ error: 'Subscription not found.' });
    const keepWallet = (existing.eventPrefs && existing.eventPrefs.account
        && existing.eventPrefs.account.walletAddress) || null;
    const prefs = normalizePrefs(req.body && req.body.prefs, { walletAddress: keepWallet });
    const subscriber = db.setEmailSubscriberPrefs(token, prefs);
    if (!subscriber) return res.status(404).json({ error: 'Subscription not found.' });
    res.json({ status: 'ok', prefs: subscriber.eventPrefs });
});

// GET /api/email/preferences?token=... — read current prefs for the modal.
app.get('/api/email/preferences', (req, res) => {
    // Never cacheable, and never indexable. The token is in the URL and the
    // subscriber's email address is in the body, so a cached copy anywhere
    // between here and the browser is a personal-data leak. The confirm and
    // unsubscribe HTML routes have always set these; this one did not.
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const token = String(req.query.token || '').trim();
    const subscriber = db.getEmailSubscriberByUnsubscribeToken(token);
    if (!subscriber) return res.status(404).json({ error: 'Subscription not found.' });
    res.json({
        email: subscriber.email,
        prefs: subscriber.eventPrefs,
        confirmed: !!subscriber.confirmedAt,
        unsubscribed: !!subscriber.unsubscribedAt
    });
});

// Diag: how many confirmed subscribers + provider status.
app.get('/api/diag/email', (req, res) => {
    if (!diagGate(req, res)) return;
    res.json({
        provider: emailProviderStatus(),
        confirmedSubscribers: db.countEmailSubscribers()
    });
});

// Tiny shared template for the confirmation / unsubscribe result page.
function confirmResultPage({ title, body, isError }) {
    const color = isError ? '#ff8a8a' : '#5cf591';
    return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)} — Polkadex Explorer</title>
<meta name="robots" content="noindex">
<style>
  body { background:#0a0e1a; color:#e8eaed; font-family:Inter,-apple-system,Segoe UI,Arial,sans-serif; margin:0; padding:40px 20px; }
  .card { max-width:520px; margin:60px auto; background:#141929; border:1px solid #2a3045; border-radius:14px; padding:36px 32px; }
  h1 { margin:0 0 16px; color:${color}; font-size:1.5rem; }
  p { color:#cfd5e1; line-height:1.55; margin:0 0 14px; }
  a { color:#00c4ff; }
  .home-link { display:inline-block; margin-top:18px; color:#fff; padding:10px 18px; background:#E6007A; border-radius:8px; text-decoration:none; font-weight:600; }
  .home-link:hover { opacity:0.92; }
</style>
</head><body>
<div class="card">
  <h1>${htmlEscape(title)}</h1>
  ${body}
  <a class="home-link" href="/">Back to the explorer</a>
</div>
</body></html>`;
}

// The button that turns a prefetchable GET into a deliberate POST (F-001,
// F-036). A plain HTML form, no JavaScript: these pages are opened straight
// from a mail client and must work with scripting disabled.
function confirmActionForm(action, token, label) {
    return `<form method="POST" action="${htmlEscape(action)}" style="margin:18px 0 4px;">
  <input type="hidden" name="token" value="${htmlEscape(token)}">
  <button type="submit" style="cursor:pointer;border:0;font:inherit;font-weight:600;color:#fff;padding:11px 20px;background:#E6007A;border-radius:8px;">${htmlEscape(label)}</button>
</form>`;
}

// --- DISCUSSION BOARD: threads + posts ---
// --- PROXY + MULTISIG LOOKUPS ---
// Read-only views of on-chain state. The actual wallet flows (add/remove
// proxy, approve multisig) are signed client-side from the wallet
// dashboard — these endpoints just deliver the current state so the UI
// has something to render.

// List proxies delegated TO the given account. Returns:
//   { account, proxies: [{ delegate, proxyType, delay }], deposit }
app.get('/api/proxies/:address', async (req, res) => {
    if (!requireRpc(res)) return;
    try {
        const raw = (req.params.address || '').trim();
        if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid Polkadex address.' });
        let address;
        try { address = normalizeAddress(raw); } catch (e) { return res.status(400).json({ error: 'Invalid Polkadex address.' }); }
        if (!globalApi.query.proxy || !globalApi.query.proxy.proxies) {
            return res.status(501).json({ error: 'Proxy pallet not present on this runtime.' });
        }
        // The proxy pallet stores (Vec<ProxyDefinition>, Balance) in
        // `proxy.proxies(account)`. Each ProxyDefinition has { delegate,
        // proxyType, delay }.
        const result = await globalApi.query.proxy.proxies(address);
        const [defsRaw, depositRaw] = result;
        const proxies = (defsRaw || []).toArray ? defsRaw.toArray() : Array.from(defsRaw || []);
        const mapped = proxies.map(p => ({
            delegate: p.delegate ? p.delegate.toString() : null,
            proxyType: p.proxyType ? p.proxyType.toString() : 'Any',
            delay: p.delay ? p.delay.toNumber() : 0
        }));
        res.json({
            account: address,
            proxies: mapped,
            deposit: depositRaw ? balanceToPDEX(depositRaw) : 0
        });
    } catch (err) {
        console.error('API Error /api/proxies/:address:', err);
        serverError(res, err, req.path);
    }
});

// List the available ProxyType variants on this runtime. The frontend uses
// this to populate the "Proxy type" dropdown when adding a new proxy.
// Returns an array of strings: ['Any', 'NonTransfer', 'Governance', ...].
app.get('/api/proxy-types', async (req, res) => {
    if (!requireRpc(res)) return;
    try {
        let types = [];
        try {
            // The ProxyType enum's variants live in the chain metadata.
            // Look up the type used by the proxy.addProxy extrinsic's
            // second argument — that's authoritative for this runtime.
            const meta = globalApi.tx.proxy && globalApi.tx.proxy.addProxy;
            if (meta && meta.meta && meta.meta.args && meta.meta.args[1]) {
                const argTypeId = meta.meta.args[1].type.toString();
                const def = globalApi.registry.lookup.getTypeDef(argTypeId);
                if (def && def.sub && Array.isArray(def.sub)) {
                    types = def.sub.map(s => s.name).filter(Boolean);
                }
            }
        } catch (_) { /* fall through to defaults */ }
        if (!types.length) types = ['Any', 'NonTransfer', 'Governance', 'Staking', 'IdentityJudgement', 'CancelProxy'];
        cacheLong(res); // changes only on runtime upgrade
        res.json({ types });
    } catch (err) {
        console.error('API Error /api/proxy-types:', err);
        serverError(res, err, req.path);
    }
});

// Pending multisig approvals for the given multisig address. Each entry is
// an in-flight `asMulti`/`approveAsMulti` call awaiting more signatures.
// Returns:
//   { account, pending: [{ callHash, when:{height,index}, approvals[], deposit, depositor }] }
app.get('/api/multisigs/:address', async (req, res) => {
    if (!requireRpc(res)) return;
    try {
        const raw = (req.params.address || '').trim();
        if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid Polkadex address.' });
        let address;
        try { address = normalizeAddress(raw); } catch (e) { return res.status(400).json({ error: 'Invalid Polkadex address.' }); }
        if (!globalApi.query.multisig || !globalApi.query.multisig.multisigs) {
            return res.status(501).json({ error: 'Multisig pallet not present on this runtime.' });
        }
        // multisig.multisigs is a double-map: (multisigAccount, callHash) ->
        // Multisig. We iterate the prefix to enumerate every in-flight call
        // for this multisig address.
        const entries = await globalApi.query.multisig.multisigs.entries(address);
        const pending = entries.map(([key, optMulti]) => {
            const callHash = key.args && key.args[1] ? key.args[1].toHex() : null;
            if (!optMulti || optMulti.isNone) return null;
            const m = optMulti.unwrap();
            const when = m.when ? { height: m.when.height.toNumber(), index: m.when.index.toNumber() } : null;
            const approvals = m.approvals ? m.approvals.map(a => a.toString()) : [];
            return {
                callHash,
                when,
                approvals,
                depositor: m.depositor ? m.depositor.toString() : null,
                deposit: m.deposit ? balanceToPDEX(m.deposit) : 0
            };
        }).filter(Boolean);
        res.json({ account: address, pending });
    } catch (err) {
        console.error('API Error /api/multisigs/:address:', err);
        serverError(res, err, req.path);
    }
});

// --- IDENTITY (set / clear / read) ---
// The existing getIdentity() helper flattens identity to a display-name string
// for UI display everywhere else in the explorer. This endpoint returns the
// FULL structured info so the set-identity modal can pre-fill the form, plus
// the chain's deposit constants so we can show the cost up front.
//
// Response shape:
//   { address, hasIdentity, info: { display, legal, email, twitter, web, riot, image }
//     hasParent, parent, judgements,
//     deposit, basicDeposit, fieldDeposit, maxAdditionalFields }
// Each info field is a plain string (or '' if unset / not Raw-encoded).
app.get('/api/identity/:address', async (req, res) => {
    if (!requireRpc(res)) return;
    try {
        const raw = (req.params.address || '').trim();
        if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid Polkadex address.' });
        let address;
        try { address = normalizeAddress(raw); } catch (e) { return res.status(400).json({ error: 'Invalid Polkadex address.' }); }
        if (!globalApi.query.identity || !globalApi.query.identity.identityOf) {
            return res.status(501).json({ error: 'Identity pallet not present on this runtime.' });
        }

        // Pull constants for the deposit calculator. The identity pallet exposes
        // basicDeposit (flat) + fieldDeposit (per additional field) + maxAdditionalFields.
        const planckToPdex = (raw) => {
            try { return balanceToPDEX(raw); } catch (e) { return 0; }
        };
        const basicDeposit = globalApi.consts.identity && globalApi.consts.identity.basicDeposit
            ? planckToPdex(globalApi.consts.identity.basicDeposit) : 0;
        const fieldDeposit = globalApi.consts.identity && globalApi.consts.identity.fieldDeposit
            ? planckToPdex(globalApi.consts.identity.fieldDeposit) : 0;
        const maxAdditional = globalApi.consts.identity && globalApi.consts.identity.maxAdditionalFields
            ? Number(globalApi.consts.identity.maxAdditionalFields.toString()) : 100;

        // Read sub-identity link first — if this account is a sub-identity of
        // a parent, setting a fresh identity here would orphan it from the
        // parent. We surface this so the frontend can warn.
        let hasParent = false, parent = null;
        try {
            const superOf = await globalApi.query.identity.superOf(address);
            if (superOf && superOf.isSome) {
                hasParent = true;
                parent = superOf.unwrap()[0].toString();
            }
        } catch (e) { /* superOf may not exist on older runtimes */ }

        // Read the main identity record.
        const identityOpt = await globalApi.query.identity.identityOf(address);
        // The pallet has two storage shapes across versions:
        //   newer:  Option<Registration>
        //   older:  (Registration, Hash | null)
        // toHuman() normalises both to either an object or null/array.
        const human = identityOpt && identityOpt.toHuman ? identityOpt.toHuman() : null;
        let reg = null;
        if (Array.isArray(human) && human[0]) reg = human[0];
        else if (human && human.info) reg = human;
        else if (human && human.toJSON) reg = human.toJSON ? human.toJSON() : null;

        // Coerce each Data-typed field to a plain string. Data variants:
        //   { Raw: '...' }       — the only one we can faithfully edit
        //   { None: null }       — empty
        //   { BlakeTwo256: ... } — hashed; we treat as empty for editing
        const fieldStr = (field) => {
            if (!field) return '';
            if (typeof field === 'string') return field;
            if (field.Raw !== undefined) return String(field.Raw || '');
            if (field.raw !== undefined) return String(field.raw || '');
            return '';
        };

        const info = reg && reg.info ? reg.info : {};
        const judgements = (reg && Array.isArray(reg.judgements)) ? reg.judgements.map(j => {
            // [registrarIndex, judgement] tuple
            if (Array.isArray(j)) return { registrar: Number(j[0]), judgement: j[1] };
            return j;
        }) : [];

        res.set('Cache-Control', 'no-store');
        res.json({
            address,
            hasIdentity: !!reg,
            info: {
                display: fieldStr(info.display),
                legal:   fieldStr(info.legal),
                email:   fieldStr(info.email),
                twitter: fieldStr(info.twitter),
                web:     fieldStr(info.web),
                riot:    fieldStr(info.riot),
                image:   fieldStr(info.image)
            },
            hasParent,
            parent,
            judgements,
            // Cost surface for the modal.
            deposit: reg && reg.deposit ? planckToPdex(reg.deposit) : 0,
            basicDeposit,
            fieldDeposit,
            maxAdditionalFields: maxAdditional
        });
    } catch (err) {
        console.error('API Error /api/identity/:address:', err);
        serverError(res, err, req.path);
    }
});

// --- ADDRESS LABELS (v2: community-sourced + voting) ---
// Anyone signed in via the wallet-signature auth flow can SUGGEST a label
// for any address. Each label can be up/down voted by other signed-in users.
// The address's owner can VETO a community label (hide it from display).
// Reaching REPORT_HIDE_THRESHOLD reports also auto-hides the label until
// an operator intervenes (out of band — no admin UI in this v2).
const MAX_LABEL_LENGTH = 64;
const MIN_LABEL_LENGTH = 1;
const LABEL_POST_COOLDOWN_MS = 60 * 1000;   // 60 s between any two label writes per signer
const REPORT_HIDE_THRESHOLD = 3;             // labels with this many reports auto-hide
const MAX_REPORT_REASON_LENGTH = 200;        // matches the db.js column slice (F-170)
// F-075: likewise — the label cooldown moved to db.consumeRateLimit.

// Public read — returns ALL visible labels for an address with vote
// aggregates. When the caller is signed in, each row carries the caller's
// own vote so the UI can render arrow states without an extra query.
// Response shape:
//   { address, labels: [{ label, signer, isSelf, score, upvotes, downvotes,
//                          viewerVote, reportCount, vetoed, createdAt }],
//     topLabel: <best visible label> | null }
app.get('/api/labels/:address', (req, res) => {
    try {
        const raw = (req.params.address || '').trim();
        if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid Polkadex address.' });
        let address;
        try { address = normalizeAddress(raw); } catch (e) { return res.status(400).json({ error: 'Invalid Polkadex address.' }); }
        const viewer = getAuthAddress(req);                       // null if not signed in
        const labels = db.getLabelsForAddress(address, viewer);
        const top = db.getTopLabel(address, REPORT_HIDE_THRESHOLD);
        // Endpoint must NOT be cached at the CDN when there's a viewer-
        // specific viewerVote in the payload — Cloudflare would otherwise
        // pin one user's vote state for everyone else.
        // Audit F-083: a viewer-specific response is per-USER content; sending it
    // with a shared cacheMedium header lets Cloudflare serve one visitor's
    // view to the next. no-store when a viewer is present.
    if (viewer) res.set('Cache-Control', 'no-store'); else cacheMedium(res);
        res.json({
            address,
            labels,
            topLabel: top,
            // v1-compat: surface the self-label's text + updatedAt directly
            // so any clients still reading the v1 shape keep working.
            label: top && top.isSelf ? top.label : null,
            updatedAt: top && top.isSelf ? top.updatedAt : null
        });
    } catch (err) {
        console.error('API Error /api/labels/:address:', err);
        serverError(res, err, req.path);
    }
});

// Authenticated write. Any signed-in user can suggest a label for any
// address (v1's self-only restriction is lifted). Self-labels (signer ==
// address) are still treated specially in the read path: they outrank
// every community label. A 60-second cooldown per signer dampens spam.
app.post('/api/labels/:address', express.json({ limit: '4kb' }), (req, res) => {
    try {
        const signer = getAuthAddress(req);
        if (!signer) return res.status(401).json({ error: 'Sign in with your wallet first.' });

        const raw = (req.params.address || '').trim();
        if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid Polkadex address.' });
        let address;
        try { address = normalizeAddress(raw); } catch (e) { return res.status(400).json({ error: 'Invalid Polkadex address.' }); }

        // Spam guard — applies to suggestions on ANY address by the same signer.
        //
        // Audit F-075 (round 2). This was a per-process Map, with a comment
        // saying "memory-only per worker is fine". It is not: the cluster runs
        // WORKERS-1 HTTP processes and node:cluster round-robins connections,
        // so a signer who simply retried landed on a different worker with an
        // empty Map and the 60-second cooldown became 60/(WORKERS-1) seconds in
        // practice. The advertised number and the enforced number were
        // different, which is the part that matters — an operator reading the
        // constant cannot tell what the limit actually is.
        //
        // db.consumeRateLimit is the shared SQLite counter already used for
        // auth and email signup. Fails open on lock contention, which for a
        // spam pacer is the right trade (the alternative is refusing a
        // legitimate post because the indexer holds the write lock).
        // Rejects ASCII control chars and angle brackets — both for
        // log-injection hygiene and so the UI never has to escape user input it
        // received as "trusted". Shared with the report route (F-170) so the
        // two free-text fields on this table cannot drift apart again.
        const checked = checkUserText(req.body && req.body.label, {
            minLength: MIN_LABEL_LENGTH, maxLength: MAX_LABEL_LENGTH, field: 'Label'
        });
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        const label = checked.value;

        // Consume the cooldown only once the input is known to be acceptable.
        //
        // Adversarial review caught this: moving the guard to a shared counter
        // (F-075) also moved it ABOVE validation, and consumeRateLimit spends
        // the slot on the attempt rather than on the write. The in-process Map
        // it replaced recorded the timestamp AFTER a successful upsert, so a
        // rejected label — too short, or containing an angle bracket — cost
        // nothing. Under the first version of this change a typo burned the
        // signer's full 60 seconds and the UI just said "wait 60s" with no
        // explanation of what they had done wrong.
        const labelGate = db.consumeRateLimit('label-write', signer, (hits) =>
            checkWindow(hits, { windowMs: LABEL_POST_COOLDOWN_MS, limit: 1 })
        );
        if (!labelGate.allowed) {
            const wait = Math.ceil(labelGate.retryAfterMs / 1000) || 1;
            res.set('Retry-After', String(wait));
            return res.status(429).json({ error: `Please wait ${wait}s before submitting another label.` });
        }

        db.upsertAddressLabel({ address, signer, label });
        // Mirror the post-condition the GET endpoint returns so the client
        // can do an optimistic update without a re-fetch.
        res.json({ address, label, signer, isSelf: signer === address, ok: true });
    } catch (err) {
        console.error('API Error POST /api/labels/:address:', err);
        serverError(res, err, req.path);
    }
});

// Authenticated delete — removes the SIGNER's own row (whether it's a
// self-label or a community suggestion they made). Cascades votes/reports.
app.delete('/api/labels/:address', (req, res) => {
    try {
        const signer = getAuthAddress(req);
        if (!signer) return res.status(401).json({ error: 'Sign in with your wallet first.' });
        const raw = (req.params.address || '').trim();
        if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid Polkadex address.' });
        let address;
        try { address = normalizeAddress(raw); } catch (e) { return res.status(400).json({ error: 'Invalid Polkadex address.' }); }
        db.deleteAddressLabel(address, signer);
        res.json({ ok: true });
    } catch (err) {
        console.error('API Error DELETE /api/labels/:address:', err);
        serverError(res, err, req.path);
    }
});

// Audit F-082 (round 2). The isValid → 400 → normalize → 400 pattern is
// repeated across ~10 routes, and the three label sub-routes below skipped it
// entirely: they called normalizeAddress() bare inside a try whose catch is
// serverError, so a malformed address in the URL produced a 500.
//
// That is not cosmetic. A 500 says "we broke"; a 400 says "your request was
// wrong". The wrong one sends the caller to retry, sends us an alert, and
// buries a client bug in the error-rate graph. It also means a crawler walking
// bad label URLs looks like an outage.
//
// The gate cannot move into lib/ — isValidAddress and normalizeAddress close
// over the runtime-detected chain SS58 prefix — but it can stop being copied.
// Returns null and answers the request on failure, so callers read:
//
//     const addrs = gateAddressParams(req, res, 'address', 'signer');
//     if (!addrs) return;
//
// The 400 body deliberately reuses the exact literal the older routes send;
// clients may already switch on it.
function gateAddressParams(req, res, ...names) {
    const out = {};
    for (const name of names) {
        const raw = String((req.params && req.params[name]) || '').trim();
        if (!isValidAddress(raw)) {
            res.status(400).json({ error: 'Invalid Polkadex address.' });
            return null;
        }
        try {
            out[name] = normalizeAddress(raw);
        } catch (e) {
            res.status(400).json({ error: 'Invalid Polkadex address.' });
            return null;
        }
    }
    return out;
}

// Vote on a label. Body: { vote: 1 | -1 | 0 }. 0 clears an existing vote.
// Voting on one's own row is harmless but a no-op for display ranking
// (self-labels skip the score check), so we don't reject it.
app.post('/api/labels/:address/:signer/vote', express.json({ limit: '1kb' }), (req, res) => {
    try {
        const voter = getAuthAddress(req);
        if (!voter) return res.status(401).json({ error: 'Sign in with your wallet first.' });
        // F-082: 400 on a malformed address, not a 500 out of the catch below.
        const addrs = gateAddressParams(req, res, 'address', 'signer');
        if (!addrs) return;
        const labelAddress = addrs.address;
        const labelSigner  = addrs.signer;
        const raw = req.body && req.body.vote;
        const vote = (raw === 0 || raw === '0') ? 0 : (Number(raw) > 0 ? 1 : Number(raw) < 0 ? -1 : NaN);
        if (Number.isNaN(vote)) return res.status(400).json({ error: 'vote must be -1, 0, or 1.' });
        db.upsertLabelVote({ labelAddress, labelSigner, voter, vote });
        // Return the refreshed label so the client can update the row in place.
        const labels = db.getLabelsForAddress(labelAddress, voter);
        const row = labels.find(l => l.signer === labelSigner) || null;
        res.json({ ok: true, label: row });
    } catch (err) {
        console.error('API Error POST /api/labels/:address/:signer/vote:', err);
        serverError(res, err, req.path);
    }
});

// Report a label. Body: { reason?: string }. Idempotent per (label, reporter)
// — a second report by the same user is silently ignored. Once the row's
// report count hits REPORT_HIDE_THRESHOLD, the label disappears from the
// visible-labels query the rest of the explorer reads.
app.post('/api/labels/:address/:signer/report', express.json({ limit: '1kb' }), (req, res) => {
    try {
        const reporter = getAuthAddress(req);
        if (!reporter) return res.status(401).json({ error: 'Sign in with your wallet first.' });
        // F-082: 400 on a malformed address, not a 500 out of the catch below.
        const addrs = gateAddressParams(req, res, 'address', 'signer');
        if (!addrs) return;
        const labelAddress = addrs.address;
        const labelSigner  = addrs.signer;
        if (reporter === labelSigner) {
            return res.status(400).json({ error: 'You can\'t report your own label.' });
        }
        // Audit F-170: this took whatever it was given. Optional (minLength 0),
        // but if present it obeys the same rules as the label itself — the
        // reason is stored for a human to read later, and a moderation screen
        // has no way to know this field was never checked.
        const checkedReason = checkUserText(req.body && req.body.reason, {
            maxLength: MAX_REPORT_REASON_LENGTH, field: 'Reason'
        });
        if (!checkedReason.ok) return res.status(400).json({ error: checkedReason.error });
        db.reportLabel({ labelAddress, labelSigner, reporter, reason: checkedReason.value });
        res.json({ ok: true });
    } catch (err) {
        console.error('API Error POST /api/labels/:address/:signer/report:', err);
        serverError(res, err, req.path);
    }
});

// Veto / un-veto a community label. Only the address owner (signer ==
// labelAddress) can hide labels on their own address. Vetoing a self-label
// would be pointless (the signer can just delete it), so we 400.
//   Body: { vetoed: boolean }
app.post('/api/labels/:address/:signer/veto', express.json({ limit: '1kb' }), (req, res) => {
    try {
        const acting = getAuthAddress(req);
        if (!acting) return res.status(401).json({ error: 'Sign in with your wallet first.' });
        // F-082: 400 on a malformed address, not a 500 out of the catch below.
        const addrs = gateAddressParams(req, res, 'address', 'signer');
        if (!addrs) return;
        const labelAddress = addrs.address;
        const labelSigner  = addrs.signer;
        if (acting !== labelAddress) {
            return res.status(403).json({ error: 'Only the address owner can veto labels on their own address.' });
        }
        if (labelSigner === labelAddress) {
            return res.status(400).json({ error: 'To remove your own self-label, use DELETE /api/labels/<address>.' });
        }
        const vetoed = !!(req.body && req.body.vetoed);
        db.setLabelVeto(labelAddress, labelSigner, vetoed);
        res.json({ ok: true, vetoed });
    } catch (err) {
        console.error('API Error POST /api/labels/:address/:signer/veto:', err);
        serverError(res, err, req.path);
    }
});

app.get('/api/discussions', (req, res) => {
    try {
        const kind = (req.query.kind === 'proposal' || req.query.kind === 'motion') ? req.query.kind : null;
        cacheMedium(res);
        res.json({ threads: db.getThreads(kind) });
    } catch (err) { serverError(res, err, req.path); }
});

// --- ANALYTICS ENDPOINTS ---
// Daily time-series aggregates derived from the existing chain index, plus
// a point-in-time snapshot of staking metrics from the network-info cache.
// Lives behind the same medium-cache TTL as other slow-moving lists so
// Cloudflare absorbs the bulk of traffic.
app.get('/api/analytics/timeseries', (req, res) => {
    try {
        // Audit F-081 follow-up, and a bug the fix for it introduced.
        //
        // `days` used to be free (1..365) and the live-aggregate fallthrough was
        // absorbed by cacheMedium. Making empty results no-store — correct on
        // its own — turned that fallthrough into an unauthenticated event-loop
        // DoS: only 7/30/90/365 are pre-warmed, so 358 other values each ran
        // db.getDailyAnalytics(), a GROUP BY over `blocks` and `transactions`
        // filtered on `timestamp`, synchronous in node:sqlite, with no edge
        // cache left to shorten the loop.
        //
        // Being exact about the cost, because it differs by deployment:
        // idx_tx_timestamp / idx_blocks_timestamp are created at boot ONLY when
        // the table is under FRESH_INDEX_MAX_ROWS (200k) — see db.js and the
        // F-088 note. A 12.8M-row production database is deliberately skipped,
        // because building that index inline would hold the write lock for
        // minutes; it gets the index only if an operator has run
        // migrate-add-indexes.mjs (repo root). So on a dev box this was a slow query
        // and on production it was an unindexed full scan of the largest table
        // in the schema — the environment where it matters is the one without
        // the index.
        //
        // The window is a UI control with four settings, so it is now a closed
        // set. Anything else snaps to the nearest supported range instead of
        // commissioning an unbounded scan on a stranger's behalf, and the
        // response says which range it actually answered.
        const askedDays = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
        const days = ANALYTICS_TS_RANGES.reduce(
            (best, r) => Math.abs(r - askedDays) < Math.abs(best - askedDays) ? r : best,
            ANALYTICS_TS_RANGES[0]
        );
        // Standard UI ranges are pre-warmed into KV by the indexer — serve those
        // instantly. Any non-standard window falls back to a live aggregate
        // (rare; the UI only ever asks for 7/30/90/365).
        //
        // Audit F-081 (round 2). The guard was `if (cached && cached.series)`,
        // and `cacheMedium(res)` ran BEFORE it. An empty array is truthy, and
        // refreshAnalyticsTimeseriesInBackground pre-warms every range on
        // startup — including before the indexer has written a single row — so
        // a fresh or still-backfilling deployment served `series: []` and then
        // pinned that emptiness at the edge for the medium TTL. The chart drew
        // a flat line labelled with real dates, which reads as "no activity on
        // this chain" rather than "not indexed yet". The snapshot endpoint's
        // countsReady gate was fixed in round 1; this one was missed.
        //
        // An empty series is now never cached, by anyone: not the browser, not
        // Cloudflare. A populated one keeps the medium TTL it always had.
        const cached = db.getKv('analytics_ts_' + days);
        if (cached && hasSeriesData(cached.series)) {
            cacheMedium(res);
            return res.json(cached);
        }
        // Empty or missing: derive it once, but STILL let the edge hold it for a
        // short while. The finding was that an empty series was served as
        // though it were an answer and pinned for the medium TTL — not that it
        // must never be cached at all. A short TTL keeps a genuinely empty
        // window from re-running the aggregate per request while still
        // self-correcting within seconds of the indexer producing rows.
        //
        // `indexIncomplete` is what actually fixes the finding: it tells the
        // client the difference between "nothing happened in this window" and
        // "we cannot answer yet", which the bare empty array could not.
        cacheShort(res);
        const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
        res.json({
            days, requestedDays: askedDays, since: sinceTs,
            series: (cached && hasSeriesData(cached.series)) ? cached.series : db.getDailyAnalytics(sinceTs),
            computedAt: Date.now(),
            indexIncomplete: (db.getSyncState('chain_index') || {}).status !== 'Synced'
        });
    } catch (err) {
        console.error('API Error /api/analytics/timeseries:', err);
        serverError(res, err, req.path);
    }
});

// Snapshot of the current chain state — counts and ratios used by the
// dashboard's KPI cards. Reads from the existing network_info KV (kept hot
// by refreshNetworkInfoInBackground) so this is cheap to call.
//
// Field-name note: the cached `networkInfo` shape lives in getNetworkInfo()
// above. Validators / nominators are nested objects with { active, total };
// total staked is `totalBonding` (not `totalStaked`). Earlier versions of
// this endpoint read the wrong paths and surfaced 0s in the UI — keep this
// mapping in sync with any future networkInfo shape change.
app.get('/api/analytics/snapshot', (req, res) => {
    try {
        const ni = db.getKv('network_info') || {};
        const network = ni.networkInfo || {};
        const validators = network.validators || {};
        const nominators = network.nominators || {};
        const totalIssuance = Number(network.totalIssuance) || 0;
        const totalStaked = Number(network.totalBonding) || 0;
        // Counts of things in the indexer's database — pre-computed by
        // refreshAnalyticsCountsInBackground() on the indexer worker every
        // ANALYTICS_COUNTS_REFRESH_MS (default 5 min) and stored in KV.
        // This used to run SELECT COUNT(*) inline, which on a multi-million-
        // row events table took 30-60s and timed out nginx (110 errors from
        // upstream timed out / response header). The first ~20s of process
        // life has empty counts (refresh hasn't fired yet) — zeros are an
        // acceptable transient state for an analytics dashboard.
        const counts = db.getKv('analytics_counts') || {};

        // Audit F-081: `?? 0` turned "not computed yet" into a confident zero,
        // and cacheMedium() then let Cloudflare hold that zero for a minute —
        // so the dashboard could show "0 blocks indexed, 0 events" for an
        // explorer with 12.8 million blocks in it, and keep showing it after
        // the real numbers were available. Every deploy hit this window.
        //
        // Two changes. Missing counts are now null (unknown), not 0 (a claim);
        // and a response carrying unknown counts is not cacheable, so the very
        // next request picks up the real values instead of waiting out the TTL.
        const countsReady = Number(counts.computedAt) > 0;
        if (countsReady) cacheMedium(res);
        else res.set('Cache-Control', 'no-store');

        res.json({
            indexedBlocks:       countsReady ? (counts.indexedBlocks ?? null) : null,
            indexedEvents:       countsReady ? (counts.indexedEvents ?? null) : null,
            indexedTransactions: countsReady ? (counts.indexedTransactions ?? null) : null,
            indexedReferenda:    countsReady ? (counts.indexedReferenda ?? null) : null,
            indexedThreads:      countsReady ? (counts.indexedThreads ?? null) : null,
            countsAt:            counts.computedAt ?? 0,
            // Lets a client distinguish "we counted and there are none" from
            // "we have not counted yet" without inferring it from countsAt.
            countsReady,
            // Chain-state network info (populated by refreshNetworkInfoInBackground).
            totalIssuance,
            totalStaked,
            stakingRatio: totalIssuance > 0 ? totalStaked / totalIssuance : 0,
            // Prefer the active-set count for the KPI card — it's what most
            // observers mean by "validator count" on a Substrate chain.
            // `totalValidators` / `totalNominators` ship the full registered
            // count alongside for callers that want both.
            validatorCount: Number(validators.active) || 0,
            totalValidators: Number(validators.total) || 0,
            nominatorCount: Number(nominators.active) || 0,
            totalNominators: Number(nominators.total) || 0,
            activeEra: network.activeEra || 0,
            lastSync: ni.lastSync || 0,
            status: ni.status || 'Initializing'
        });
    } catch (err) {
        console.error('API Error /api/analytics/snapshot:', err);
        serverError(res, err, req.path);
    }
});

app.get('/api/discussions/:id', (req, res) => {
    try {
        const thread = db.getThread(req.params.id);
        if (!thread) return res.status(404).json({ error: 'Discussion thread not found.' });
        res.json({ thread, posts: db.getPosts(thread.id) });
    } catch (err) { serverError(res, err, req.path); }
});

app.post('/api/discussions/:id/posts', async (req, res) => {
    try {
        const address = getAuthAddress(req);
        if (!address) return res.status(401).json({ error: 'Sign in with your wallet to post.' });
        const thread = db.getThread(req.params.id);
        if (!thread) return res.status(404).json({ error: 'Discussion thread not found.' });
        if (thread.status === 'closed') return res.status(403).json({ error: 'This discussion is closed.' });

        const content = (req.body && req.body.content || '').trim();
        if (!content) return res.status(400).json({ error: 'Post content is required.' });
        if (content.length > 4000) return res.status(400).json({ error: 'Post is too long (4000 character limit).' });

        // F-075: shared SQLite counter, not a per-process Map. See the label
        // route above for why — the same round-robin made this 8s cooldown
        // 8/(WORKERS-1)s for anyone who retried.
        const postGate = db.consumeRateLimit('discussion-post', address, (hits) =>
            checkWindow(hits, { windowMs: POST_COOLDOWN_MS, limit: 1 })
        );
        if (!postGate.allowed) {
            res.set('Retry-After', String(Math.ceil(postGate.retryAfterMs / 1000) || 1));
            return res.status(429).json({ error: 'You are posting too quickly — please wait a moment.' });
        }

        let authorName = 'Unknown';
        try { authorName = await getIdentity(globalApi, address); } catch (e) { }
        db.createPost({ threadId: thread.id, author: address, authorName, content });
        res.json({ thread: db.getThread(thread.id), posts: db.getPosts(thread.id) });
    } catch (err) { serverError(res, err, req.path); }
});

// Auto-create one discussion thread per active item and close threads whose
// underlying proposal/motion has moved on (to voting, or concluded).
function reconcileProposalThreads(publicProposals) {
    const activeIds = new Set();
    for (const p of (publicProposals || [])) {
        const id = `proposal-${p.index}`;
        activeIds.add(id);
        db.createThreadIfMissing({ id, kind: 'proposal', refKey: String(p.index), title: `Public Proposal #${p.index}` });
    }
    for (const openId of db.getOpenThreadIds('proposal')) {
        if (!activeIds.has(openId)) db.closeThread(openId, 'Proposal tabled and moved to a referendum (voting).');
    }
}

function reconcileMotionThreads(motions) {
    const activeIds = new Set();
    for (const m of (motions || [])) {
        const id = `motion-${m.hash}`;
        activeIds.add(id);
        db.createThreadIfMissing({ id, kind: 'motion', refKey: m.hash, title: m.title || 'Council Motion' });
    }
    for (const openId of db.getOpenThreadIds('motion')) {
        if (!activeIds.has(openId)) db.closeThread(openId, 'Council motion concluded.');
    }
}

app.get('/api/wallet/:address', async (req, res) => {
    // Audit F-083: this handler set NO Cache-Control at all, so the response
    // fell through to nginx's `map` default (`public, max-age=300`) — one
    // visitor's balance, staking positions and unpaid rewards, cacheable at
    // the edge for five minutes under a URL that only differs by address.
    res.set('Cache-Control', 'no-store');
    const raw = (req.params.address || '').trim();
    if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid Polkadex wallet address.' });
    if (!requireRpc(res)) return;
    let address;
    try { address = normalizeAddress(raw); }
    catch (e) { return res.status(400).json({ error: 'Invalid Polkadex wallet address.' }); }

    try {
        const [accountInfo, identity, bondedOpt, nominatorsOpt, activeEraOpt, sessionValidators] = await Promise.all([
            globalApi.query.system.account(address),
            getIdentity(globalApi, address),
            globalApi.query.staking.bonded(address),
            globalApi.query.staking.nominators(address),
            globalApi.query.staking.activeEra(),
            globalApi.query.session.validators()
        ]);
        const free = balanceToPDEX(accountInfo.data.free);
        const reserved = balanceToPDEX(accountInfo.data.reserved);

        // Bonded ledger (total staked).
        let totalStaked = 0, activeStaked = 0, unlocking = 0;
        // BigInt-precision copy of the active stake's planck u128 — used by
        // the Unstake modal's Max button to submit a full unbond without
        // floating-point round-trip loss. See note next to activeStakedPlanck
        // in the response payload below.
        let activeStakedPlanck = null;
        const controller = (bondedOpt && bondedOpt.isSome) ? bondedOpt.unwrap().toString() : address;
        try {
            const ledgerOpt = await globalApi.query.staking.ledger(controller);
            if (ledgerOpt && ledgerOpt.isSome) {
                const ledger = ledgerOpt.unwrap();
                totalStaked = balanceToPDEX(ledger.total);
                activeStaked = balanceToPDEX(ledger.active);
                // Capture the raw u128 planck for precision-critical UI flows
                // (Max-button unbond). toString() on a polkadot.js Codec gives
                // a decimal string suitable for direct passing into a tx call.
                try { activeStakedPlanck = ledger.active.toString(); } catch (_) {}
                for (const u of (ledger.unlocking || [])) unlocking += balanceToPDEX(u.value);
            }
        } catch (e) { }

        // My validators (nomination targets).
        let nominating = [];
        if (nominatorsOpt && nominatorsOpt.isSome) {
            const targets = nominatorsOpt.unwrap().targets.map(t => t.toString());
            nominating = await Promise.all(targets.map(async t => ({ address: t, name: await getIdentity(globalApi, t) })));
        }
        const sessionValAddrs = sessionValidators.map(v => v.toString());

        // Rewards from the local index; trigger an unpaid-reward refresh if stale.
        const claimed = db.getStakingRewards(address);
        // F-002 applies here too, and with sharper consequences than on the
        // rewards page: `unpaidEntries` below is what the frontend turns into
        // staking.payoutStakers(validator, era) calls. An entry the indexer has
        // already seen claimed doesn't just inflate a total — it puts a button
        // in front of the user whose only possible outcome is an AlreadyClaimed
        // dispatch error. Reconcile against the claimed rows first.
        const reconciled = summarizeRewards(claimed, db.getUnclaimed(address));
        const unclaimed = reconciled.unclaimed;
        const claimedTotal = reconciled.summary.claimedTotal;
        const unpaidTotal = reconciled.summary.unclaimedTotal;
        const unclaimedAt = db.getUnclaimedComputedAt(address);
        const unclaimedFresh = unclaimedAt > Date.now() - UNCLAIMED_TTL;
        if (!unclaimedFresh && !computingUnclaimed.has(address)) recomputeUnclaimed(address);

        // Network staking parameters.
        const networkData = await getNetworkInfo().catch(() => null);
        const ni = networkData ? networkData.networkInfo : null;
        // Caches the value and serves a stale-but-good copy through reconnect
        // blips so the unstake modal never silently loses its constraint info.
        const minStake = await getMinNominatorBondCached();
        const constNumber = c => { try { return c != null ? Number(c.toString()) : 0; } catch (e) { return 0; } };
        const staking = globalApi.consts.staking || {};
        const babe = globalApi.consts.babe || {};
        const sessionsPerEra = constNumber(staking.sessionsPerEra);
        const bondingDuration = constNumber(staking.bondingDuration);
        const epochDuration = constNumber(babe.epochDuration);
        const blockTime = constNumber(babe.expectedBlockTime);
        const eraDurationMs = (sessionsPerEra && epochDuration && blockTime) ? sessionsPerEra * epochDuration * blockTime : 0;

        res.json({
            address,
            identity,
            // `free` is the non-reserved balance, but on Substrate it still
            // includes bonded/staked tokens (they're locked, not reserved).
            // `transferable` excludes the staked amount so the staking UI can
            // show what's actually available to bond on top of the current stake.
            // F-136 note: the audit's close test asks transferable to also
            // subtract `reserved`, but on Substrate reserved is NOT part of
            // `free` — locks (staking) live inside free, reserves live beside
            // it — so `free - staked` is the correct spendable figure and
            // subtracting reserved again would understate it. The real F-136
            // defect was /api/account LABELLING reserved as "frozen", fixed
            // there. Left as a comment so the next reader doesn't "fix" this
            // into a double subtraction.
            balance: { free, reserved, total: free + reserved, transferable: Math.max(0, free - totalStaked) },
            staking: {
                isStaker: totalStaked > 0,
                isValidator: sessionValAddrs.includes(address),
                isNominator: nominating.length > 0,
                totalStaked,
                activeStaked,
                // Exact planck (u128 → string) for the active stake. The
                // float-form `activeStaked` is what the UI displays, but
                // float arithmetic loses precision below ~12 significant
                // digits, so the Unstake modal's Max button cannot use it
                // to construct an "unbond the full amount" tx — parseFloat
                // round-trips the rounded display value to a number that
                // may be ULP-greater than the original, tripping the
                // client-side > check, or ULP-lesser, leaving a sub-PDEX
                // residue that fails minNominatorBond. The frontend reads
                // this string and passes it untouched into api.tx.staking.unbond().
                activeStakedPlanck: activeStakedPlanck != null ? String(activeStakedPlanck) : '0',
                unlocking,
                nominating
            },
            rewards: {
                claimedTotal,
                claimedCount: claimed.length,
                unpaidTotal,
                unpaidCount: unclaimed.length,
                unclaimedFresh,
                recentClaimed: claimed.slice(0, 10),
                // Per-validator/era unpaid entries — the frontend needs these to
                // build the staking.payoutStakers(validator, era) calls for the
                // "Pay out rewards" action.
                unpaidEntries: unclaimed.slice(0, 200)
            },
            recentTransactions: db.getTransactionsByAddress(address, 10, raw), // F-080
            // ── F-085 (wallet route) ─────────────────────────────────────────
            // Marked differently from the account route's block on purpose:
            // test/server-infra.test.js locates that route by searching for its
            // comment header, and a second copy of the same header anywhere in
            // this file would silently move which route those assertions run
            // against. (This paragraph does not quote the header for the same
            // reason — a comment that names the string it is avoiding
            // reintroduces the collision it is warning about.)
            //
            // Same finding, same fix: this payload interleaves values that are
            // read live from the chain with values read out of our index, and
            // presents them flat. `balance` is authoritative to the block.
            // `rewards` and `recentTransactions` are only as complete as the
            // staking and chain indexers have managed to get, and the tx list is
            // additionally capped at 10 rows — so a wallet with a busy history
            // and a wallet whose backfill has not reached its first transfer
            // look identical. A user checking "did my transfer go through"
            // cannot tell "no" from "not indexed yet".
            provenance: {
                balance: 'live-rpc', identity: 'live-rpc', staking: 'live-rpc', network: 'live-rpc',
                rewards: 'index', recentTransactions: 'index', price: 'index'
            },
            index: {
                rewards: {
                    status: (db.getSyncState('staking_rewards') || {}).status || 'Unknown',
                    latestScannedBlock: (db.getSyncState('staking_rewards') || {}).latestScannedBlock ?? null,
                    oldestScannedBlock: (db.getSyncState('staking_rewards') || {}).oldestScannedBlock ?? null,
                    backfillComplete: !!(db.getSyncState('staking_rewards') || {}).backfillComplete
                },
                transactions: {
                    status: (db.getSyncState('chain_index') || {}).status || 'Unknown',
                    oldestScannedBlock: (db.getSyncState('chain_index') || {}).oldestScannedBlock ?? null,
                    backfillComplete: !!(db.getSyncState('chain_index') || {}).backfillComplete,
                    // Always true: the list is sliced to 10 regardless of how
                    // much history exists. Stated rather than computed, because
                    // "10 rows returned" and "10 rows exist" are the same
                    // observation from the client's side.
                    truncated: true,
                    rowLimit: 10
                }
            },
            network: {
                currentEra: activeEraOpt && activeEraOpt.isSome ? activeEraOpt.unwrap().index.toNumber() : 0,
                activeValidators: ni ? ni.validators.active : sessionValAddrs.length,
                totalValidators: ni ? ni.validators.total : sessionValAddrs.length,
                activeNominators: ni ? ni.nominators.active : 0,
                totalNominators: ni ? ni.nominators.total : 0,
                totalStakedNetwork: ni ? ni.totalBonding : 0,
                minStake,
                eraDurationMs,
                bondingDurationEras: bondingDuration,
                unbondingMs: eraDurationMs * bondingDuration
            },
            price: db.getLatestPrice()
        });
    } catch (err) {
        serverError(res, err, req.path);
    }
});

// --- BACKGROUND CRAWLERS ---
async function syncTreasury() {
    // isRpcReady() also covers !globalApi, plus catches the half-reconnected
    // case where globalApi exists but the WsProvider has dropped.
    if (!isRpcReady() || isSyncingTreasury) return;
    isSyncingTreasury = true;
    try {
        if (!globalApi.query.treasury) {
            console.warn('Treasury sync: no treasury pallet found on this runtime.');
            db.setSyncState('treasury', { lastSync: Date.now(), status: 'Unavailable' });
            return;
        }

        const [proposalsEntries, approvalsData, currentBlockOpt, proposalCountOpt] = await Promise.all([
            globalApi.query.treasury.proposals.entries(),
            globalApi.query.treasury.approvals(),
            globalApi.query.system.number(),
            globalApi.query.treasury.proposalCount ? globalApi.query.treasury.proposalCount() : Promise.resolve({ toNumber: () => 0 })
        ]);

        const currentBlock = currentBlockOpt.toNumber();
        const spendPeriod = globalApi.consts.treasury.spendPeriod ? globalApi.consts.treasury.spendPeriod.toNumber() : 0;
        const burn = globalApi.consts.treasury.burn ? globalApi.consts.treasury.burn.toNumber() : 0;

        const progress = spendPeriod > 0 ? currentBlock % spendPeriod : 0;
        const blocksRemaining = spendPeriod > 0 ? spendPeriod - progress : 0;

        const approvedProposalIds = approvalsData.map(id => id.toNumber());

        const proposals = await Promise.all(proposalsEntries.map(async ([key, proposalOpt]) => {
            const id = key.args[0].toNumber();
            const proposal = proposalOpt.unwrap();
            const proposer = proposal.proposer.toString();
            const beneficiary = proposal.beneficiary.toString();
            
            const proposerName = await getIdentity(globalApi, proposer);
            const beneficiaryName = await getIdentity(globalApi, beneficiary);

            return {
                id,
                proposer,
                proposerName,
                beneficiary,
                beneficiaryName,
                value: balanceToPDEX(proposal.value),
                bond: balanceToPDEX(proposal.bond)
            };
        }));
        
        // Sort proposals descending by ID
        proposals.sort((a, b) => b.id - a.id);

        // Treasury balance. Try the pallet-id derived account (modl + palletId
        // + zero padding) and the known mainnet treasury address, then take the
        // funded one. The candidates resolve to the same account when the
        // derivation succeeds; the fallback covers runtimes that don't expose
        // treasury.palletId as a const.
        let spendableFunds = 0;
        try {
            const candidates = [];
            if (globalApi.consts.treasury && globalApi.consts.treasury.palletId) {
                const palletId = globalApi.consts.treasury.palletId.toU8a();
                const treasuryAccountU8a = u8aConcat(
                    stringToU8a('modl'),
                    palletId,
                    new Uint8Array(32)
                ).slice(0, 32);
                candidates.push(encodeAddress(treasuryAccountU8a, chainSS58));
            }
            if (TREASURY_ACCOUNT) candidates.push(TREASURY_ACCOUNT);

            for (const addr of candidates) {
                try {
                    const accountData = await globalApi.query.system.account(addr);
                    const free = balanceToPDEX(accountData.data.free);
                    if (free > spendableFunds) spendableFunds = free;
                } catch (e) { /* try the next candidate */ }
            }
        } catch (e) {
            console.warn('Treasury balance lookup failed:', e.message);
        }

        db.setKv('treasury', {
            proposals,
            approvals: approvedProposalIds,
            spendPeriod,
            burn,
            blocksRemaining,
            spendableFunds,
            proposalCount: proposalCountOpt.toNumber()
        });

        // Keep the persistent proposal history fresh with the live open/approved
        // proposals. Resolved (paid/rejected) ones are filled in by syncGovernance.
        const approvedSet = new Set(approvedProposalIds);
        for (const p of proposals) {
            db.upsertTreasuryProposal({
                id: p.id,
                proposer: p.proposer,
                proposerName: p.proposerName,
                beneficiary: p.beneficiary,
                beneficiaryName: p.beneficiaryName,
                value: p.value,
                bond: p.bond,
                status: approvedSet.has(p.id) ? 'approved' : 'proposed'
            });
        }

        // Audit F-052: `proposals` above is the COMPLETE set of proposals still
        // in chain storage. Anything our history table still calls open, but
        // which is not in that set, has left the chain — mark it resolved so it
        // stops being listed as awaiting a decision forever.
        //
        // Only safe because we got here: every read above either succeeded or
        // threw into the catch below, and proposalCountOpt decoded, so an empty
        // `proposals` here genuinely means "no open proposals" rather than "the
        // query failed". Without that guarantee this would close every open row
        // on the first bad tick.
        try {
            // trusted: every read above either succeeded or threw to the catch
            // below — unlike the council path, nothing here logs-and-continues.
            const closed = db.resolveMissingTreasuryProposals(proposals.map(p => p.id), { trusted: true });
            if (closed > 0) {
                console.log(`Treasury sync: ${closed} proposal(s) left chain storage without a resolving event; marked resolved (F-052).`);
            }
        } catch (e) {
            console.warn('Treasury reconcile failed (non-fatal):', e.message);
        }
        db.setSyncState('treasury', { lastSync: Date.now(), status: 'Synced' });
    } catch (err) {
        logSyncError('Treasury sync', err);
        db.setSyncState('treasury', { lastSync: Date.now(), status: 'Error' });
    } finally {
        isSyncingTreasury = false;
    }
}

async function syncCouncil() {
    // isRpcReady() also covers !globalApi, plus catches the half-reconnected
    // case where globalApi exists but the WsProvider has dropped.
    if (!isRpcReady() || isSyncingCouncil) return;
    isSyncingCouncil = true;
    try {
        // The elections-phragmen pallet is registered under different names
        // across runtimes (elections / phragmenElection / electionsPhragmen).
        const electionsModule = ['elections', 'phragmenElection', 'electionsPhragmen']
            .find(name => globalApi.query[name] && globalApi.consts[name]);
        if (!electionsModule) {
            console.warn('Council sync: no elections pallet found on this runtime.');
            db.setSyncState('council', { lastSync: Date.now(), status: 'Unavailable' });
            return;
        }
        const electionsQuery = globalApi.query[electionsModule];
        const electionsConsts = globalApi.consts[electionsModule];

        const [membersData, runnersUpData, candidatesData, currentBlockObj] = await Promise.all([
            electionsQuery.members(),
            electionsQuery.runnersUp(),
            electionsQuery.candidates(),
            globalApi.query.system.number()
        ]);

        const currentBlock = currentBlockObj.toNumber();
        const termDuration = electionsConsts.termDuration ? electionsConsts.termDuration.toNumber() : 0;
        const desiredMembers = electionsConsts.desiredMembers ? electionsConsts.desiredMembers.toNumber() : 0;
        const desiredRunnersUp = electionsConsts.desiredRunnersUp ? electionsConsts.desiredRunnersUp.toNumber() : 0;
        const progress = termDuration > 0 ? currentBlock % termDuration : 0;
        const blocksRemaining = termDuration > 0 ? termDuration - progress : 0;
        
        const processAccountList = async (list) => {
            const arr = [];
            const items = list.toJSON() || [];
            for (const item of items) {
                let address = item;
                let stake = 0;
                if (Array.isArray(item)) {
                    address = item[0];
                    stake = balanceToPDEX(item[1]);
                } else if (item && item.who) {
                    address = item.who;
                    stake = balanceToPDEX(item.stake);
                }
                const name = await getIdentity(globalApi, address);
                arr.push({ address, name, stake });
            }
            return arr;
        };
        
        const members = await processAccountList(membersData);
        const runnersUp = await processAccountList(runnersUpData);
        const candidates = await processAccountList(candidatesData);

        // Council motions (the collective pallet). The collective is registered
        // under different names across runtimes (council / councilCollective / generalCouncil).
        const motions = [];
        // Audit F-052, and a review catch on its first version. `motions` is
        // filled inside a try/catch that LOGS AND CONTINUES, so an RPC blip, a
        // decode failure, or a runtime that renames the collective all leave it
        // as [] while execution carries on to the reconcile below. Reconciling
        // against an empty "live set" would mark every open motion resolved —
        // and because the status ranks refuse to downgrade, the next successful
        // sync could never undo it. Every open motion, permanently shown as
        // concluded, from one dropped WebSocket frame.
        //
        // db.js documents that the callers "pass a trusted flag". They did not;
        // the contract was asserted in a comment and never implemented. This is
        // that flag, and it starts false.
        let motionsTrusted = false;
        let collectivePallet = null;
        for (const name of ['council', 'councilCollective', 'generalCouncil']) {
            const mod = globalApi.query[name];
            if (mod && mod.proposals && mod.proposalOf) { collectivePallet = name; break; }
        }
        if (collectivePallet) {
            const collectiveModule = globalApi.query[collectivePallet];
            try {
                const motionHashes = await collectiveModule.proposals();
                const probeAddress = members[0] ? members[0].address : null;
                for (const h of motionHashes) {
                    const hash = h.toString();
                    let section = '', method = '', args = [];
                    let lengthBound = 0;
                    // Generous defaults used as the close() weight bound when an
                    // exact estimate cannot be computed (bound only needs to be >= actual).
                    let weightRefTime = '10000000000', weightProofSize = '500000';
                    try {
                        const callOpt = await collectiveModule.proposalOf(h);
                        if (callOpt && callOpt.isSome) {
                            const call = callOpt.unwrap();
                            section = String(call.section);
                            method = String(call.method);
                            lengthBound = call.encodedLength;
                            const argMeta = (call.meta && call.meta.args) || [];
                            args = call.args.map((a, i) => {
                                let value;
                                try { value = a.toString(); } catch (e) { value = '[unprintable]'; }
                                // Cap large args (e.g. a runtime wasm blob) so the
                                // council payload stays small.
                                if (value.length > 512) value = value.slice(0, 512) + '…(truncated)';
                                return { name: argMeta[i] ? String(argMeta[i].name) : ('arg' + i), value };
                            });
                            if (probeAddress) {
                                try {
                                    const info = await globalApi.tx(call).paymentInfo(probeAddress);
                                    const w = info.weight;
                                    if (w && w.refTime !== undefined) {
                                        weightRefTime = (BigInt(w.refTime.toString()) * 2n).toString();
                                        weightProofSize = (BigInt(w.proofSize.toString()) * 2n + 32768n).toString();
                                    } else if (w) {
                                        weightRefTime = (BigInt(w.toString()) * 2n).toString();
                                    }
                                } catch (e) { /* keep generous defaults */ }
                            }
                        }
                    } catch (e) { }
                    let index = null, threshold = 0, ayes = [], nays = [], end = 0;
                    try {
                        const votingOpt = await collectiveModule.voting(h);
                        if (votingOpt && votingOpt.isSome) {
                            const v = votingOpt.unwrap();
                            index = v.index.toNumber();
                            threshold = v.threshold.toNumber();
                            ayes = v.ayes.map(a => a.toString());
                            nays = v.nays.map(a => a.toString());
                            end = v.end.toNumber();
                        }
                    } catch (e) { }
                    motions.push({
                        hash,
                        title: (section && method) ? `${section}.${method}` : 'Council Motion',
                        section, method, args,
                        index, threshold, ayes, nays, end,
                        lengthBound, weightRefTime, weightProofSize
                    });
                }
                motions.sort((a, b) => (b.index || 0) - (a.index || 0));
                // Only here — after proposals() returned AND every hash was
                // walked without throwing — is `motions` the complete live set.
                motionsTrusted = true;
            } catch (e) { console.warn('Council motions skipped:', e.message); }
        }

        const councilData = {
            members,
            runnersUp,
            candidates,
            motions,
            currentBlock,
            termDuration,
            blocksRemaining,
            desiredMembers,
            desiredRunnersUp,
            pallet: electionsModule,
            collectivePallet,
            lastSync: Date.now()
        };
        
        db.setKv('council', councilData);
        db.setSyncState('council', { lastSync: Date.now(), status: 'Synced' });
        // Same hazard as the F-052 reconcile, and it predates it:
        // reconcileMotionThreads closes the discussion thread of every motion
        // absent from `motions`, so an empty list from a swallowed error would
        // close every open thread. Gate it on the same flag.
        if (motionsTrusted) reconcileMotionThreads(motions);

        // Keep the persistent motions history fresh with the live open motions.
        for (const m of motions) {
            db.upsertCouncilMotion({
                hash: m.hash,
                motionIndex: m.index,
                section: m.section || null,
                method: m.method || null,
                threshold: m.threshold || null,
                ayes: (m.ayes || []).length,
                nays: (m.nays || []).length,
                status: 'proposed'
            });
        }

        // F-052, council half. Same reasoning as syncTreasury: `motions` is the
        // full live open set, so a stored 'proposed' motion missing from it was
        // closed without us seeing the ProposalClosed/Executed event.
        if (!motionsTrusted) {
            console.warn('Council sync: motion list incomplete this tick; skipping the F-052 reconcile.');
        } else {
            try {
                const closed = db.resolveMissingCouncilMotions(motions.map(m => m.hash), { trusted: true });
                if (closed > 0) {
                    console.log(`Council sync: ${closed} motion(s) left chain storage without a resolving event; marked resolved (F-052).`);
                }
            } catch (e) {
                console.warn('Council reconcile failed (non-fatal):', e.message);
            }
        }
    } catch (err) {
        logSyncError('Council sync', err);
    } finally {
        isSyncingCouncil = false;
    }
}

// --- Governance history crawler ---------------------------------------------
// Treasury proposals and council motions are removed from chain storage once
// they resolve (paid out / rejected / closed), so the live syncs only ever see
// the open ones. This crawler walks block events — a forward pass for new
// blocks plus a resumable backfill toward genesis — and indexes every
// proposal/motion lifecycle event into SQLite so the full history survives.

// Flatten an event's data into positional + named lookups.
function govEventFields(ev) {
    const data = ev.data;
    const names = data.names || null;
    const out = {};
    for (let i = 0; i < data.length; i++) {
        out[i] = data[i];
        if (names && names[i]) out[names[i]] = data[i];
    }
    return out;
}
function govNum(x) {
    if (x === undefined || x === null) return null;
    try { if (typeof x.toNumber === 'function') return x.toNumber(); } catch (e) { }
    try { const n = Number(x.toString()); return Number.isFinite(n) ? n : null; } catch (e) { }
    return null;
}
function govStr(x) {
    if (x === undefined || x === null) return null;
    try { return x.toString(); } catch (e) { return null; }
}

// Scan one block's events for governance activity. Returns null when the block
// has none (the overwhelming majority), so the extra block/storage reads only
// happen on the rare blocks that matter.
async function scanBlockForGovernance(blockNumber, collectiveName) {
    try {
        const blockHash = await getBlockHashCached(blockNumber);
        // Decode with the block's OWN runtime metadata — see getEventsAtBlock.
        const events = await getEventsAtBlock(blockHash);
        if (!events) return null;

        const TREASURY_METHODS = ['Proposed', 'Awarded', 'Rejected', 'SpendApproved'];
        const COLLECTIVE_METHODS = ['Proposed', 'Closed', 'Approved', 'Disapproved', 'Executed', 'MemberExecuted'];
        const relevant = [];
        events.forEach((record) => {
            const ev = record.event;
            if (ev.section === 'treasury' && TREASURY_METHODS.includes(ev.method)) relevant.push(ev);
            else if (ev.section === collectiveName && COLLECTIVE_METHODS.includes(ev.method)) relevant.push(ev);
        });
        // Clean scan with no governance events of interest in this block.
        // Returned as ok=true so the gap-fill retry phase clears the
        // failure row instead of treating it as another error.
        if (!relevant.length) return { treasury: [], motions: [], ok: true };

        const timestamp = await getBlockTimestampAt(blockHash);
        // F-114: the audit named the transaction and reward sinks; this is a
        // fourth. A motion or treasury proposal stamped with wall-clock time
        // sorts to the top of the governance list as though it were current.
        if (timestamp === null) {
            db.recordScanFailure('governance', blockNumber,
                'block timestamp unavailable at this height (F-114)');
            return { treasury: [], motions: [], ok: false };
        }
        const treasury = [];
        const motions = [];

        for (const ev of relevant) {
            const f = govEventFields(ev);
            if (ev.section === 'treasury') {
                const id = govNum(f.proposalIndex ?? f.index ?? f[0]);
                if (id === null) continue;
                if (ev.method === 'Proposed') {
                    const rec = { id, status: 'proposed', proposedBlock: blockNumber, proposedAt: timestamp };
                    try {
                        const opt = await globalApi.query.treasury.proposals.at(blockHash, id);
                        if (opt && opt.isSome) {
                            const pr = opt.unwrap();
                            rec.proposer = pr.proposer.toString();
                            rec.beneficiary = pr.beneficiary.toString();
                            rec.value = balanceToPDEX(pr.value);
                            rec.bond = balanceToPDEX(pr.bond);
                        }
                    } catch (e) { }
                    treasury.push(rec);
                } else if (ev.method === 'Awarded') {
                    treasury.push({ id, status: 'awarded', resolvedBlock: blockNumber, resolvedAt: timestamp });
                } else if (ev.method === 'Rejected') {
                    treasury.push({ id, status: 'rejected', resolvedBlock: blockNumber, resolvedAt: timestamp });
                } else if (ev.method === 'SpendApproved') {
                    treasury.push({ id, status: 'approved' });
                }
            } else {
                // Collective (council) motion events.
                if (ev.method === 'Proposed') {
                    const hash = govStr(f.proposalHash ?? f[2]);
                    if (!hash) continue;
                    const rec = {
                        hash,
                        motionIndex: govNum(f.proposalIndex ?? f[1]),
                        proposer: govStr(f.account ?? f[0]),
                        threshold: govNum(f.threshold ?? f[3]),
                        status: 'proposed',
                        proposedBlock: blockNumber,
                        proposedAt: timestamp
                    };
                    try {
                        const opt = await globalApi.query[collectiveName].proposalOf.at(blockHash, hash);
                        if (opt && opt.isSome) {
                            const call = opt.unwrap();
                            rec.section = String(call.section);
                            rec.method = String(call.method);
                        }
                    } catch (e) { }
                    motions.push(rec);
                } else {
                    const hash = govStr(f.proposalHash ?? f[0]);
                    if (!hash) continue;
                    if (ev.method === 'Closed') {
                        motions.push({ hash, status: 'closed', ayes: govNum(f.yes ?? f[1]), nays: govNum(f.no ?? f[2]), resolvedBlock: blockNumber, resolvedAt: timestamp });
                    } else if (ev.method === 'Approved') {
                        motions.push({ hash, status: 'approved', resolvedBlock: blockNumber, resolvedAt: timestamp });
                    } else if (ev.method === 'Disapproved') {
                        motions.push({ hash, status: 'disapproved', resolvedBlock: blockNumber, resolvedAt: timestamp });
                    } else if (ev.method === 'Executed' || ev.method === 'MemberExecuted') {
                        motions.push({ hash, status: 'executed', resolvedBlock: blockNumber, resolvedAt: timestamp });
                    }
                }
            }
        }
        return { treasury, motions, ok: true };
    } catch (err) {
        const short = shortErrorMessage(err);
        // A node disconnect says nothing about this block, so it must not
        // consume one of the block's SCAN_MAX_ATTEMPTS lives. Counting them is
        // what permanently retired blocks 472,223 / 473,207 / 473,599 in June
        // 2026 — see lib/rpc-errors.js.
        if (isRpcUnavailableError(err)) {
            console.warn(`Governance scan deferred block ${blockNumber} (node unavailable, attempt not counted): ${short}`);
            return { treasury: [], motions: [], ok: false, transient: true };
        }
        console.warn(`Governance scan skipped block ${blockNumber}: ${short}`);
        db.recordScanFailure('governance', blockNumber, short);
        return { treasury: [], motions: [], ok: false };
    }
}

// Scan a descending block range in concurrent batches.
async function scanGovernanceRange({ startBlock, stopBlock, maxBlocks, collectiveName }) {
    const treasury = [];
    const motions = [];
    let scanned = 0;
    let oldest = startBlock;
    for (let next = startBlock; next >= stopBlock && scanned < maxBlocks;) {
        const nums = [];
        while (next >= stopBlock && nums.length < GOV_SCAN_BATCH && scanned + nums.length < maxBlocks) {
            nums.push(next);
            next--;
        }
        if (!nums.length) break;
        const results = await Promise.all(nums.map(b => scanBlockForGovernance(b, collectiveName)));
        scanned += nums.length;
        oldest = nums[nums.length - 1];
        for (const r of results) {
            if (!r) continue;
            for (const t of r.treasury) treasury.push(t);
            for (const m of r.motions) motions.push(m);
        }
    }
    return { treasury, motions, scanned, oldest };
}

// Resolve identities and persist a batch of scanned governance records.
async function applyGovernanceRecords(treasury, motions) {
    for (const t of treasury) {
        if (t.proposer && !t.proposerName) { try { t.proposerName = await getIdentity(globalApi, t.proposer); } catch (e) { } }
        if (t.beneficiary && !t.beneficiaryName) { try { t.beneficiaryName = await getIdentity(globalApi, t.beneficiary); } catch (e) { } }
        db.upsertTreasuryProposal(t);
    }
    for (const m of motions) {
        if (m.proposer && !m.proposerName) { try { m.proposerName = await getIdentity(globalApi, m.proposer); } catch (e) { } }
        db.upsertCouncilMotion(m);
    }
}

// One crawl pass: index new blocks (forward) and walk a resumable chunk of
// older history (backfill).
async function syncGovernance() {
    if (isSyncingGovernance || !isRpcReady() || inBackoff('governance')) return;
    isSyncingGovernance = true;
    try {
        const collectiveName = ['council', 'councilCollective', 'generalCouncil']
            .find(n => globalApi.query[n] && globalApi.query[n].proposalOf) || 'council';

        const state = db.getSyncState('governance');
        const head = (await globalApi.rpc.chain.getHeader()).number.toNumber();

        let initialized = !!state.initialized;
        // Audit F-010 (round 2) — the same watermark split as chain_index and
        // staking. Governance has no LEAD gap scan of its own, so before this
        // the skip queue was the ONLY record that a height was missed, and a
        // watermark that jumped past it made that record invisible to every
        // consumer. A missed height here is a motion or treasury proposal whose
        // resolving event never lands, so the page shows it open forever.
        let headSeen = readHeadSeen(state);
        let oldestScannedBlock = Number(state.oldestScannedBlock) || 0;
        let backfillCursor = Number(state.backfillCursor) || 0;
        let backfillComplete = !!state.backfillComplete;

        // Anchor just below head so the forward pass scans head itself
        // (audit F-048/F-113 — see the note in syncChainIndex).
        if (!initialized) {
            initialized = true;
            headSeen = head - 1;
            oldestScannedBlock = head;
            backfillCursor = head - 1;
            backfillComplete = (head - 1) < GOV_MIN_BLOCK;
        }

        // FORWARD PASS — blocks produced since the previous crawl.
        if (head > headSeen) {
            const fwd = await scanGovernanceRange({
                startBlock: head,
                stopBlock: headSeen + 1,
                maxBlocks: GOV_FORWARD_MAX,
                collectiveName
            });
            await applyGovernanceRecords(fwd.treasury, fwd.motions);
            // Audit F-010: after downtime longer than GOV_FORWARD_MAX blocks,
            // the cap means the oldest part of the gap is never fetched. Round
            // 1 recorded those heights but still jumped the watermark to head;
            // now only `headSeen` jumps, and the skip queue holds the verified
            // watermark back until the gap-fill pass clears it.
            const govLowestAttempted = Math.max(headSeen + 1, head - GOV_FORWARD_MAX + 1);
            if (govLowestAttempted > headSeen + 1) {
                const skipFrom = headSeen + 1;
                const skipTo = govLowestAttempted - 1;
                console.warn(`[governance] forward cap skipped ${skipFrom}-${skipTo} (${skipTo - skipFrom + 1} blocks) — recording for repair`);
                recordSkippedRange('governance', skipFrom, skipTo, 'forward cap: not attempted this tick');
            }
            headSeen = head;
            db.setSyncState('governance', {
                initialized, headSeen, oldestScannedBlock, backfillCursor, backfillComplete,
                latestScannedBlock: contiguousWatermark({
                    headSeen,
                    lowestOutstandingFailure: db.getLowestScanFailure('governance'),
                    floor: oldestScannedBlock
                }),
                lastSync: Date.now(), status: 'Backfilling'
            });
        }

        // BACKFILL PASS — one resumable chunk further down the chain.
        if (!backfillComplete) {
            if (backfillCursor >= GOV_MIN_BLOCK) {
                const stop = Math.max(backfillCursor - GOV_BACKFILL_CHUNK + 1, GOV_MIN_BLOCK);
                const bf = await scanGovernanceRange({
                    startBlock: backfillCursor,
                    stopBlock: stop,
                    maxBlocks: GOV_BACKFILL_CHUNK,
                    collectiveName
                });
                await applyGovernanceRecords(bf.treasury, bf.motions);
                oldestScannedBlock = Math.min(oldestScannedBlock || backfillCursor, bf.oldest);
                backfillCursor = bf.oldest - 1;
                if (backfillCursor < GOV_MIN_BLOCK) backfillComplete = true;
            } else {
                backfillComplete = true;
            }
        }

        // GAP-FILL PASS — retry blocks recorded in scan_failures by previous
        // ticks. Same recovery pattern as the staking-rewards indexer: clear
        // the failure row on a clean re-scan, leave it (with bumped attempts)
        // on another error.
        const govFailures = db.getScanFailures('governance', SCAN_GAP_FILL_BATCH, SCAN_MAX_ATTEMPTS);
        if (govFailures.length) {
            const recoveredTreasury = [];
            const recoveredMotions = [];
            let recovered = 0;
            let stillFailing = 0;
            for (const f of govFailures) {
                const r = await scanBlockForGovernance(f.block, collectiveName);
                if (r && r.ok) {
                    for (const t of r.treasury) recoveredTreasury.push(t);
                    for (const m of r.motions) recoveredMotions.push(m);
                    db.clearScanFailure('governance', f.block);
                    recovered++;
                } else {
                    stillFailing++;
                }
            }
            if (recoveredTreasury.length || recoveredMotions.length) {
                await applyGovernanceRecords(recoveredTreasury, recoveredMotions);
            }
            const stats = db.countScanFailures('governance', SCAN_MAX_ATTEMPTS);
            console.log(`[governance] gap-fill: ${recovered} recovered, ${stillFailing} still failing (${stats.retrying} retrying / ${stats.permanent} permanent in queue)`);
        }

        // Audit F-010 (round 2). The status was `backfillComplete ? 'Synced' :
        // 'Backfilling'` — it could not say 'Repairing' at all, so a governance
        // skip queue with entries in it still reported 'Synced'. deriveIndexStatus
        // is the same ranking the chain indexer uses; governance gets it too
        // rather than a second, subtly different notion of "fine".
        const govLowestFailure = db.getLowestScanFailure('governance');
        const latestScannedBlock = contiguousWatermark({
            headSeen, lowestOutstandingFailure: govLowestFailure, floor: oldestScannedBlock
        });
        // Adversarial review: this was `headSeen - latestScannedBlock`, which is
        // the size of the UNVERIFIED SPAN, not the number of missing blocks.
        // describeIndexStatus renders it as "N blocks missing inside the
        // indexed range", so ONE failed height 750k blocks back announced
        // "750001 blocks missing" — the same class of untruth F-010 exists to
        // remove, pointing the other way. The queue knows the real count.
        const govFailCounts = db.countScanFailures('governance', SCAN_MAX_ATTEMPTS);
        const govUnverified = govFailCounts.total;
        const govStatus = deriveIndexStatus({
            initialized,
            backfillComplete,
            knownGapBlocks: govUnverified,
            retryableFailures: govFailCounts.retrying,
            permanentFailures: govFailCounts.permanent
        });
        db.setSyncState('governance', {
            initialized, headSeen, latestScannedBlock, oldestScannedBlock, backfillCursor, backfillComplete,
            lastSync: Date.now(),
            status: govStatus,
            retryableFailures: govFailCounts.retrying,
            permanentFailures: govFailCounts.permanent,
            caughtUp: isCaughtUp({ headSeen, head, lowestOutstandingFailure: govLowestFailure }),
            detail: describeIndexStatus({
                knownGapBlocks: govUnverified,
                retryableFailures: govFailCounts.retrying,
                permanentFailures: govFailCounts.permanent
            }) || undefined
        });
        console.log(`Governance indexer: reached ${oldestScannedBlock}-${headSeen} verified ${latestScannedBlock}, ${db.countTreasuryProposals()} treasury proposals, ${db.countCouncilMotions()} motions, status=${govStatus}, backfill ${backfillComplete ? 'complete' : 'in progress'}.`);
    } catch (err) {
        logSyncError('Governance sync', err);
        db.setSyncState('governance', { ...db.getSyncState('governance'), status: 'Error', error: err.message });
        noteSyncError('governance');
    } finally {
        isSyncingGovernance = false;
    }
}

// Indexes the democracy pallet: referenda (status + vote tally), active public
// proposals, the queued external proposal, and launch-period progress.
async function syncDemocracy() {
    if (isSyncingDemocracy || !isRpcReady()) return;
    isSyncingDemocracy = true;
    try {
        const dem = globalApi.query.democracy;
        if (!dem || !dem.referendumCount) {
            db.setSyncState('democracy', { lastSync: Date.now(), status: 'Unavailable' });
            return;
        }

        const [refCountRaw, propCountRaw, publicPropsRaw, nextExternalRaw, lowestUnbakedRaw, currentBlockRaw, totalIssuanceRaw] = await Promise.all([
            dem.referendumCount(),
            dem.publicPropCount ? dem.publicPropCount() : Promise.resolve(null),
            dem.publicProps(),
            dem.nextExternal ? dem.nextExternal() : Promise.resolve(null),
            dem.lowestUnbaked ? dem.lowestUnbaked() : Promise.resolve(null),
            globalApi.query.system.number(),
            globalApi.query.balances.totalIssuance()
        ]);

        const referendumCount = refCountRaw.toNumber();
        const publicPropCount = propCountRaw ? propCountRaw.toNumber() : 0;
        const currentBlock = currentBlockRaw.toNumber();
        const totalIssuance = balanceToPDEX(totalIssuanceRaw);
        const launchPeriod = (globalApi.consts.democracy && globalApi.consts.democracy.launchPeriod)
            ? Number(globalApi.consts.democracy.launchPeriod.toString()) : 0;

        // Active public proposals.
        const publicProposals = [];
        const propsJson = publicPropsRaw.toJSON() || [];
        for (const entry of propsJson) {
            const propIndex = Array.isArray(entry) ? entry[0] : entry;
            const proposer = Array.isArray(entry) ? entry[entry.length - 1] : null;
            let deposit = 0, seconds = 0;
            try {
                const depOpt = await dem.depositOf(propIndex);
                if (depOpt && depOpt.isSome) {
                    const depJson = depOpt.unwrap().toJSON();
                    if (Array.isArray(depJson[0])) { seconds = depJson[0].length; deposit = balanceToPDEX(depJson[1]); }
                    else { deposit = balanceToPDEX(depJson[0]); seconds = Array.isArray(depJson[1]) ? depJson[1].length : 0; }
                }
            } catch (e) { }
            let proposerName = 'Unknown';
            if (proposer) { try { proposerName = await getIdentity(globalApi, proposer); } catch (e) { } }
            publicProposals.push({ index: propIndex, proposer, proposerName, deposit, seconds });
        }

        // Current external proposal.
        let externalProposal = null;
        if (nextExternalRaw && nextExternalRaw.isSome) {
            const ext = nextExternalRaw.unwrap();
            externalProposal = {
                proposal: ext[0] ? ext[0].toString().slice(0, 66) : null,
                threshold: ext[1] ? ext[1].toString() : null
            };
        }

        // Referenda — index new/ongoing ones; finalised ones with a known tally are skipped.
        const existing = {};
        for (const r of db.getDemocracyReferenda()) existing[r.refIndex] = r;
        let activeReferenda = 0;
        for (let i = 0; i < referendumCount; i++) {
            const prev = existing[i];
            if (prev && prev.status !== 'Ongoing' && prev.tallyKnown) continue;
            let info;
            try { info = await dem.referendumInfoOf(i); } catch (e) { continue; }
            if (!info || info.isNone) continue;
            const r = info.unwrap();
            if (r.isOngoing) {
                activeReferenda++;
                const s = r.asOngoing;
                db.upsertDemocracyReferendum({
                    refIndex: i, status: 'Ongoing', endBlock: s.end.toNumber(),
                    ayes: balanceToPDEX(s.tally.ayes), nays: balanceToPDEX(s.tally.nays), turnout: balanceToPDEX(s.tally.turnout),
                    tallyKnown: 1,
                    proposal: s.proposal ? s.proposal.toString().slice(0, 66) : null,
                    threshold: s.threshold ? s.threshold.toString() : null
                });
            } else if (r.isFinished) {
                const f = r.asFinished;
                const status = f.approved.isTrue ? 'Passed' : 'NotPassed';
                const endBlock = f.end.toNumber();
                let ayes = prev ? prev.ayes : null;
                let nays = prev ? prev.nays : null;
                let turnout = prev ? prev.turnout : null;
                let tallyKnown = (prev && prev.tallyKnown) ? 1 : 0;
                // Recover the final tally from historical state (archive nodes only).
                if (!tallyKnown) {
                    try {
                        const histHash = await getBlockHashCached(Math.max(endBlock - 1, 0));
                        const histInfo = await dem.referendumInfoOf.at(histHash, i);
                        if (histInfo && histInfo.isSome && histInfo.unwrap().isOngoing) {
                            const hs = histInfo.unwrap().asOngoing;
                            ayes = balanceToPDEX(hs.tally.ayes);
                            nays = balanceToPDEX(hs.tally.nays);
                            turnout = balanceToPDEX(hs.tally.turnout);
                            tallyKnown = 1;
                        }
                    } catch (e) { /* node is not an archive — tally remains unknown */ }
                }
                db.upsertDemocracyReferendum({
                    refIndex: i, status, endBlock, ayes, nays, turnout, tallyKnown,
                    proposal: prev ? prev.proposal : null, threshold: prev ? prev.threshold : null
                });
            }
        }

        reconcileProposalThreads(publicProposals);

        db.setKv('democracy_meta', {
            referendumCount, publicPropCount, launchPeriod, currentBlock, totalIssuance,
            lowestUnbaked: lowestUnbakedRaw ? lowestUnbakedRaw.toNumber() : 0,
            activeReferenda, activeProposals: publicProposals.length,
            publicProposals, externalProposal, lastSync: Date.now()
        });
        db.setSyncState('democracy', { lastSync: Date.now(), status: 'Synced' });
        console.log(`Democracy indexer: ${referendumCount} referenda, ${publicProposals.length} active proposals.`);
        // Email-alert dispatch hooks. Fire-and-forget; failures are logged
        // inside dispatchGovernanceEmails and don't fail this indexer tick.
        dispatchGovernanceEmails({
            referenda: db.getDemocracyReferenda(),
            publicProposals
        }).catch(err => console.warn('[email] governance dispatch failed:', err && err.message ? err.message : err));
    } catch (err) {
        logSyncError('Democracy sync', err);
        db.setSyncState('democracy', { ...db.getSyncState('democracy'), status: 'Error', error: err.message });
    } finally {
        isSyncingDemocracy = false;
    }
}

// ─── Email alert dispatcher ──────────────────────────────────────────────────
// Two paths fire emails:
//   1. Event-driven (called from syncDemocracy at the end of each tick):
//      compare current chain state to "what we've already emailed about" and
//      dispatch for anything new. Idempotency via email_dispatches table.
//   2. Time-driven (closing-reminder timer, every 5 min): scan ongoing
//      referenda; if any has 22–26 h remaining and we haven't sent its
//      closing-soon reminder, do so.
//
// All dispatches go through `dispatchToSubscribers` which: reserves the
// idempotency row first, then sends the email, then records the result. A
// process crash mid-send leaves the row in 'pending' state — the dispatcher
// won't retry it (the user gets one chance per event), but the dispatch log
// makes it easy to spot. Better than the alternative of double-sending.

// F-185: the same gate for ALERT mail. Every alert carries a "Manage
// preferences" link with the unsubscribe token in it, so an unconfigured
// SITE_URL would send tokenised links to the wrong host at dispatch volume
// rather than one at a time.
function emailDispatchBlocked(context) {
    if (canMintEmailUrls()) return false;
    if (!emailOriginWarned) {
        emailOriginWarned = true;
        console.error(`[email] SITE_URL is not set — suppressing all outbound mail (${context}). Every link would name the wrong host (F-185).`);
    }
    return true;
}
let emailOriginWarned = false;

async function dispatchToSubscribers({ eventKind, eventId, prefMatches, makeEmail }) {
    // F-185: checked BEFORE reserveEmailDispatch. Reserving first would mark
    // these events as dispatched, so once SITE_URL was configured the
    // idempotency table would suppress the mail that should have gone out —
    // silently converting a config mistake into permanently missed alerts.
    if (emailDispatchBlocked(`${eventKind} ${eventId}`)) return;
    const subs = db.getConfirmedEmailSubscribers();
    if (subs.length === 0) return;
    let sentCount = 0;
    for (const s of subs) {
        if (!prefMatches(s.eventPrefs || {})) continue;
        const reserved = db.reserveEmailDispatch({
            eventKind, eventId: String(eventId), subscriberId: s.id
        });
        if (!reserved) continue; // already dispatched
        const tmpl = makeEmail({ subscriber: s });
        try {
            const r = await sendEmail({
                to: s.email,
                subject: tmpl.subject,
                text: tmpl.text,
                html: tmpl.html,
                tag: eventKind,
                // RFC 8058 one-click. `List-Unsubscribe-Post` tells the mail
                // client to POST rather than follow the link, which is exactly
                // what the F-036 fix requires: the GET now only renders a
                // button, so a client that merely fetched the URL would report
                // success while nothing had been unsubscribed.
                headers: {
                    'List-Unsubscribe': `<${tmpl.unsubscribeUrl}>`,
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
                }
            });
            db.recordEmailDispatchResult({
                eventKind, eventId: String(eventId), subscriberId: s.id,
                providerId: r && r.providerId || null,
                result: r && r.disabled ? 'sent-disabled' : (r && r.rateLimited ? 'rate-limited' : 'sent')
            });
            sentCount++;
        } catch (err) {
            db.recordEmailDispatchResult({
                eventKind, eventId: String(eventId), subscriberId: s.id,
                providerId: null, result: 'failed'
            });
            // Audit F-090: this printed the subscriber's address into the
            // app log (and thus into journald/docker logs, retained and
            // shipped). The subscriber id is enough to trace a failure
            // through the email_dispatches table.
            console.warn(`[email] send to subscriber #${s.id} failed (${eventKind}/${eventId}):`, err && err.message ? err.message : err);
        }
    }
    if (sentCount > 0) {
        console.log(`[email] dispatched ${sentCount} ${eventKind} emails for ${eventId}`);
    }
}

// Build a versioned canonical site URL for use in email links. SITE_URL env
// is the authority; if missing we use the public domain since these mails
// are user-facing and need stable absolute URLs.
// Audit F-185 (round 2), an over-correction of F-037.
//
// F-037 was right to stop building confirmation URLs from the request Host —
// an attacker-supplied Host meant an attacker-controlled confirmation link.
// The replacement defaults to the PRODUCTION origin when SITE_URL is unset,
// which is wrong in a different direction: a developer or a staging box that
// subscribes an address mints a token in its OWN SQLite and mails a link
// pointing at explorer.polkadex.ee, where that token does not exist. The
// recipient gets a real email with a dead link, and the confirmation they
// think they completed never happened.
//
// So: no default. If SITE_URL is not configured, we refuse to mint tokenised
// URLs rather than mint one that names someone else's host. The subscribe
// route turns that into a 503 the operator can act on.
//
// Non-tokenised uses (sitemap, robots, canonical) keep the production default
// via siteOriginForSeo() — a wrong canonical is an SEO nit, a wrong
// confirmation link is a broken user journey and a support ticket.
// SITE_URL is REQUIRED before this process may send mail. `canMintEmailUrls()`
// is the gate; every mail path checks it before building anything. Returning a
// sentinel object or throwing from here was the obvious shape and is wrong —
// a dozen callers interpolate this into template literals, so a Symbol throws
// "Cannot convert a Symbol value to a string" from ten different stack frames
// and a null silently mints "null/email/preferences?token=…". One gate, checked
// where the decision belongs, beats a booby-trapped getter.
function emailSiteOrigin() {
    return (process.env.SITE_URL || 'https://explorer.polkadex.ee').replace(/\/+$/, '');
}

// May this process mint URLs that carry a token?
//
// Only when SITE_URL is explicitly configured. Unset means we do not know our
// own public name, and the production default would name a host where the
// token we just wrote does not exist.
function canMintEmailUrls() {
    return String(process.env.SITE_URL || '').trim() !== '';
}

// For sitemap / robots / canonical only — never for anything with a token in
// it. A wrong canonical is an SEO nit; a wrong confirmation link is a dead
// user journey and a support ticket.
function siteOriginForSeo() {
    return emailSiteOrigin();
}

// Common email layout — keeps brand consistent across event types.
function emailLayout({ title, intro, ctaText, ctaHref, details, unsubscribeUrl }) {
    const origin = emailSiteOrigin();
    // The preferences page takes the same bearer token as the unsubscribe URL,
    // so it is derived rather than threaded through every caller.
    //
    // This link was withheld for exactly one commit: an earlier pass added it
    // while `/email/preferences` was still a blank pane (F-066 — no matching
    // `data-page`, so routeTo matched nothing), which would have shipped a
    // dead link to every subscriber. The page is real now, hence the link.
    //
    // Only the ALERT emails carry it, not the confirmation email — at confirm
    // time the subscriber has nothing to manage yet, and that page is fetched
    // by mail scanners.
    const preferencesUrl = unsubscribeUrl
        ? String(unsubscribeUrl).replace('/api/email/unsubscribe?token=', '/email/preferences?token=')
        : `${origin}/email/preferences`;
    const text =
`${title}

${intro}

${details ? details + '\n\n' : ''}${ctaText}: ${ctaHref}

— Polkadex Mainnet Explorer
${origin}

Manage preferences: ${preferencesUrl}
Unsubscribe: ${unsubscribeUrl}
`;
    const html =
`<!doctype html><html><body style="font-family:Inter,-apple-system,Segoe UI,Arial,sans-serif;background:#0a0e1a;color:#e8eaed;margin:0;padding:24px;">
<div style="max-width:560px;margin:0 auto;background:#141929;border-radius:12px;padding:32px;border:1px solid #2a3045;">
  <h1 style="margin:0 0 14px;font-size:1.35rem;color:#fff;">${htmlEscape(title)}</h1>
  <p style="line-height:1.55;color:#cfd5e1;margin:0 0 16px;">${htmlEscape(intro)}</p>
  ${details ? `<p style="line-height:1.55;color:#cfd5e1;margin:0 0 16px;">${htmlEscape(details)}</p>` : ''}
  <p style="margin:24px 0;text-align:center;">
    <a href="${htmlEscape(ctaHref)}" style="display:inline-block;padding:12px 24px;background:#E6007A;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">${htmlEscape(ctaText)}</a>
  </p>
  <hr style="border:none;border-top:1px solid #2a3045;margin:28px 0;">
  <p style="font-size:0.75rem;color:#6a7387;line-height:1.5;">
    Polkadex Mainnet Explorer · <a href="${htmlEscape(origin)}" style="color:#8a92a6;">${htmlEscape(origin.replace(/^https?:\/\//, ''))}</a><br>
    <a href="${htmlEscape(preferencesUrl)}" style="color:#6a7387;">Manage preferences</a> ·
    <a href="${htmlEscape(unsubscribeUrl)}" style="color:#6a7387;">Unsubscribe</a>
  </p>
</div>
</body></html>`;
    return { text, html };
}

// Convenience: build the per-subscriber unsubscribe URL for any email.
function unsubscribeUrlFor(subscriber) {
    return `${emailSiteOrigin()}/api/email/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribeToken)}`;
}

// ─── Guarded dispatchers for the six previously-dead preferences ────────────
//
// Until now the subscribe modal offered nine checkboxes and the dispatcher
// honoured three. Someone who ticked "Runtime upgrade" in June has been
// waiting for an email that no code could ever send. These close that gap.
//
// Every one of them reads a table of FULL CHAIN HISTORY, so every one of them
// goes through lib/email-events.js. Read that file's header before changing
// anything here: without the first-run watermark, the first tick after deploy
// mails every confirmed subscriber once per historical row, and the
// idempotency table then makes it permanent.

// How old an event may be and still be worth an email. Deliberately short —
// this is the blast radius if a watermark is ever lost.
const EMAIL_EVENT_MAX_AGE_MS = readPositiveInteger(process.env.EMAIL_EVENT_MAX_AGE_MS, 3 * 24 * 3600_000);
// Hard cap on emails per event kind per tick.
const EMAIL_EVENT_BATCH_MAX = readPositiveInteger(process.env.EMAIL_EVENT_BATCH_MAX, 10);
// How often to check for a runtime upgrade / new era.
const NETWORK_EMAIL_CHECK_MS = readPositiveInteger(process.env.NETWORK_EMAIL_CHECK_MS, 2 * 60 * 1000);

// kv-backed watermark helpers. One row per event kind, so a bug in one
// dispatcher cannot re-arm another.
function emailWatermark(kind) {
    const row = db.getKv(`email:watermark:${kind}`);
    return row && row.value !== undefined ? row.value : null;
}
function setEmailWatermark(kind, value) {
    db.setKv(`email:watermark:${kind}`, { value, updatedAt: Date.now() });
}

// Run a watermark-guarded dispatch. Centralised so the first-run behaviour and
// the "always persist the new watermark" rule can't be forgotten by one call
// site — forgetting to persist means replaying the same events every tick.
async function dispatchWatermarked({ kind, items, rankOf, timeOf, prefMatches, makeEmail, eventIdOf }) {
    const { dispatch, nextBaseline, firstRun, suppressed } = selectDispatchable({
        items,
        rankOf,
        timeOf,
        baseline: emailWatermark(kind),
        nowMs: Date.now(),
        maxAgeMs: EMAIL_EVENT_MAX_AGE_MS,
        limit: EMAIL_EVENT_BATCH_MAX
    });

    if (firstRun) {
        console.log(`[email] ${kind}: first run — adopting watermark ${nextBaseline}, sending nothing for ${suppressed} historical row(s)`);
    } else if (suppressed > 0) {
        console.log(`[email] ${kind}: ${suppressed} row(s) above the watermark suppressed (too old, or over the per-tick cap)`);
    }

    // Per-item try/catch, and the watermark persisted in `finally`.
    //
    // dispatchToSubscribers only wraps the sendEmail call itself — the
    // surrounding getConfirmedEmailSubscribers, prefMatches,
    // reserveEmailDispatch and makeEmail calls are all outside its try, so any
    // of them can throw straight through. Without this, one malformed row
    // (a null motionIndex reaching toLocaleString, say) would abort the loop
    // BEFORE the watermark write and the dispatcher would re-evaluate the same
    // failing item on every tick forever, silently blocking every event behind
    // it. The idempotency table means a retry is harmless, but a permanent
    // wedge is not.
    //
    // A failing item still advances the watermark: skipping one event is a far
    // better outcome than freezing the queue.
    try {
        for (const item of dispatch) {
            try {
                await dispatchToSubscribers({
                    eventKind: kind, eventId: eventIdOf(item), prefMatches,
                    makeEmail: ({ subscriber }) => makeEmail(item, subscriber)
                });
            } catch (err) {
                console.warn(`[email] ${kind}: skipping one event after an error:`, err && err.message ? err.message : err);
            }
        }
    } finally {
        if (nextBaseline !== null && nextBaseline !== undefined) setEmailWatermark(kind, nextBaseline);
    }
}

async function dispatchResolvedReferenda(referenda) {
    const kind = 'gov.ref-result';
    const stored = db.getKv(`email:seen:${kind}`);
    const { dispatch, nextSeen, firstRun } = selectNewlyResolved({
        items: referenda || [],
        idOf: r => r.refIndex,
        isResolved: r => isTerminalRefStatus(r.status),
        seen: stored && Array.isArray(stored.ids) ? stored.ids : null,
        limit: EMAIL_EVENT_BATCH_MAX
    });

    if (firstRun) {
        console.log(`[email] ${kind}: first run — adopting ${nextSeen.length} already-decided referendum id(s), sending nothing`);
    }

    // Same throw-safety as dispatchWatermarked: the seen-set must be persisted
    // even if one referendum's send blows up, or the dispatcher re-evaluates
    // the same failing row on every tick and never announces anything again.
    try {
    for (const r of dispatch) {
        const outcome = describeRefOutcome(r.status);
        try {
        await dispatchToSubscribers({
            eventKind: kind,
            eventId: r.refIndex,
            prefMatches: (p) => p.governance && p.governance.referendumResult,
            makeEmail: ({ subscriber }) => {
                const unsub = unsubscribeUrlFor(subscriber);
                const href = `${emailSiteOrigin()}/democracy?ref=${r.refIndex}`;
                const tally = (r.ayes != null && r.nays != null && r.tallyKnown)
                    ? `Final tally: ${Number(r.ayes).toLocaleString('en-US')} aye / ${Number(r.nays).toLocaleString('en-US')} nay.`
                    : null;
                const tmpl = emailLayout({
                    title:   `Referendum #${r.refIndex} ${outcome}`,
                    intro:   `Voting on referendum #${r.refIndex} has closed. It ${outcome}.`,
                    details: tally,
                    ctaText: 'See the result',
                    ctaHref: href,
                    unsubscribeUrl: unsub
                });
                return { subject: `[Polkadex] Referendum #${r.refIndex} ${outcome}`, ...tmpl, unsubscribeUrl: unsub };
            }
        });
        } catch (err) {
            console.warn(`[email] ${kind}: skipping referendum #${r.refIndex} after an error:`, err && err.message ? err.message : err);
        }
    }
    } finally {
        db.setKv(`email:seen:${kind}`, { ids: nextSeen, updatedAt: Date.now() });
    }
}

async function dispatchNewTreasuryProposals() {
    await dispatchWatermarked({
        kind: 'gov.treasury-prop',
        items: db.getTreasuryProposals(),
        rankOf: p => p.id,
        timeOf: p => p.proposedAt,
        eventIdOf: p => p.id,
        prefMatches: (pp) => pp.governance && pp.governance.treasuryProposal,
        makeEmail: (p, subscriber) => {
            const unsub = unsubscribeUrlFor(subscriber);
            const href = `${emailSiteOrigin()}/treasury?proposal=${p.id}`;
            const amount = p.value != null ? `${Number(p.value).toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX` : 'an unspecified amount';
            const who = p.beneficiaryName && p.beneficiaryName !== 'Unknown' ? p.beneficiaryName : p.beneficiary;
            const tmpl = emailLayout({
                title:   `New treasury proposal — #${p.id}`,
                intro:   `Treasury proposal #${p.id} requests ${amount}.`,
                details: who ? `Beneficiary: ${who}` : null,
                ctaText: 'View proposal',
                ctaHref: href,
                unsubscribeUrl: unsub
            });
            return { subject: `[Polkadex] New treasury proposal #${p.id} — ${amount}`, ...tmpl, unsubscribeUrl: unsub };
        }
    });
}

async function dispatchNewCouncilMotions() {
    await dispatchWatermarked({
        kind: 'gov.council-motion',
        items: db.getCouncilMotions(),
        rankOf: m => m.motionIndex,
        timeOf: m => m.proposedAt,
        // Keyed by hash, not index: a motion index can be reused across
        // council terms, and the hash is the row's actual primary key.
        eventIdOf: m => m.hash,
        prefMatches: (p) => p.governance && p.governance.councilMotion,
        makeEmail: (m, subscriber) => {
            const unsub = unsubscribeUrlFor(subscriber);
            const href = `${emailSiteOrigin()}/council?motion=${m.motionIndex}`;
            const call = m.section && m.method ? `${m.section}.${m.method}` : 'a runtime call';
            const tmpl = emailLayout({
                title:   `New council motion — #${m.motionIndex}`,
                intro:   `The council has proposed motion #${m.motionIndex}: ${call}.`,
                details: m.threshold != null ? `It needs ${m.threshold} approval(s) to pass.` : null,
                ctaText: 'View motion',
                ctaHref: href,
                unsubscribeUrl: unsub
            });
            return { subject: `[Polkadex] New council motion #${m.motionIndex} — ${call}`, ...tmpl, unsubscribeUrl: unsub };
        }
    });
}

// ─── Network-milestone dispatchers ──────────────────────────────────────────
//
// The three `network.*` preferences. Unlike the governance ones these read
// LIVE chain state rather than a history table, so there is nothing to
// backfill — but each still needs a "have we already announced this one?"
// marker, because the tick that observes them runs every couple of minutes and
// the condition persists across many ticks.

let isDispatchingNetworkEmails = false;

async function dispatchNetworkEmails() {
    if (isDispatchingNetworkEmails || !isRpcReady()) return;
    isDispatchingNetworkEmails = true;
    try {
        // ── Runtime upgrade ──────────────────────────────────────────────
        // specVersion is monotonic, so the watermark IS the version number.
        let specVersion = null;
        try { specVersion = globalApi.runtimeVersion.specVersion.toNumber(); } catch (_) {}
        if (Number.isFinite(specVersion)) {
            const seen = emailWatermark('net.runtime-upgrade');
            if (seen === null || seen === undefined) {
                // First run: adopt the current version silently. Announcing it
                // would tell every subscriber the chain had "just upgraded" to
                // whatever it happened to be running when we deployed.
                setEmailWatermark('net.runtime-upgrade', specVersion);
                console.log(`[email] net.runtime-upgrade: first run — adopting specVersion ${specVersion}, sending nothing`);
            } else if (specVersion > Number(seen)) {
                await dispatchToSubscribers({
                    eventKind: 'net.runtime-upgrade',
                    eventId: specVersion,
                    prefMatches: (p) => p.network && p.network.runtimeUpgrade,
                    makeEmail: ({ subscriber }) => {
                        const unsub = unsubscribeUrlFor(subscriber);
                        const tmpl = emailLayout({
                            title:   `Polkadex runtime upgraded to v${specVersion}`,
                            intro:   `The Polkadex runtime has been upgraded from spec version ${seen} to ${specVersion}.`,
                            details: 'Wallet extensions and tooling sometimes need a refresh after an upgrade — if signing starts failing, reload the explorer first.',
                            ctaText: 'View runtime details',
                            ctaHref: `${emailSiteOrigin()}/runtime`,
                            unsubscribeUrl: unsub
                        });
                        return { subject: `[Polkadex] Runtime upgraded to spec v${specVersion}`, ...tmpl, unsubscribeUrl: unsub };
                    }
                });
                setEmailWatermark('net.runtime-upgrade', specVersion);
            }
        }

        // ── Era boundary ─────────────────────────────────────────────────
        let activeEra = null;
        try {
            const opt = await globalApi.query.staking.activeEra();
            if (opt && opt.isSome) activeEra = opt.unwrap().index.toNumber();
        } catch (_) {}
        if (Number.isFinite(activeEra)) {
            const seen = emailWatermark('net.era');
            if (seen === null || seen === undefined) {
                setEmailWatermark('net.era', activeEra);
                console.log(`[email] net.era: first run — adopting era ${activeEra}, sending nothing`);
            } else if (activeEra > Number(seen)) {
                // Only announce the era we just entered, never the gap. If the
                // indexer was down for a week, `activeEra - seen` could be 30+
                // and a loop would send 30 emails about eras that are already
                // over.
                await dispatchToSubscribers({
                    eventKind: 'net.era',
                    eventId: activeEra,
                    prefMatches: (p) => p.network && p.network.eraBoundary,
                    makeEmail: ({ subscriber }) => {
                        const unsub = unsubscribeUrlFor(subscriber);
                        const skipped = Number(activeEra) - Number(seen) - 1;
                        const tmpl = emailLayout({
                            title:   `Era ${activeEra} has begun`,
                            intro:   `Polkadex has entered staking era ${activeEra}. Rewards for the previous era are now claimable.`,
                            details: skipped > 0 ? `(${skipped} earlier era boundary email${skipped === 1 ? '' : 's'} were skipped — the explorer was not watching.)` : null,
                            ctaText: 'Check your rewards',
                            ctaHref: `${emailSiteOrigin()}/staking-rewards`,
                            unsubscribeUrl: unsub
                        });
                        return { subject: `[Polkadex] Era ${activeEra} has begun`, ...tmpl, unsubscribeUrl: unsub };
                    }
                });
                setEmailWatermark('net.era', activeEra);
            }
        }
    } catch (err) {
        console.warn('[email] network dispatch failed:', err && err.message ? err.message : err);
    } finally {
        isDispatchingNetworkEmails = false;
    }
}

// Chain-stalled alert. Called from chainHeadWatchdog the moment an episode
// starts, so `eventId` is the episode's start timestamp — one email per stall,
// not one per watchdog tick while the stall persists.
async function dispatchChainStalledEmail({ staleSince, lastBlock, minutesStale }) {
    try {
        await dispatchToSubscribers({
            eventKind: 'net.chain-stalled',
            eventId: staleSince,
            prefMatches: (p) => p.network && p.network.chainStalled,
            makeEmail: ({ subscriber }) => {
                const unsub = unsubscribeUrlFor(subscriber);
                const tmpl = emailLayout({
                    title:   'Polkadex chain head has stopped advancing',
                    intro:   `The explorer has not seen a new block for ${minutesStale} minutes. The last block it observed was #${Number(lastBlock).toLocaleString('en-US')}.`,
                    details: 'This can mean the chain itself has stalled, or that the explorer\'s upstream RPC node has lost its peers. It is an operational alert, not a governance one.',
                    ctaText: 'Check explorer status',
                    ctaHref: `${emailSiteOrigin()}/`,
                    unsubscribeUrl: unsub
                });
                return { subject: `[Polkadex] Chain head stalled for ${minutesStale} minutes`, ...tmpl, unsubscribeUrl: unsub };
            }
        });
    } catch (err) {
        console.warn('[email] chain-stalled dispatch failed:', err && err.message ? err.message : err);
    }
}

async function dispatchGovernanceEmails({ referenda, publicProposals }) {
    // 1. New OPEN referenda — one email per ongoing referendum, idempotent
    //    by (event_kind='gov.new-ref', event_id=refIndex).
    for (const r of (referenda || [])) {
        if (!isOpenGovStatus(r.status)) continue;
        await dispatchToSubscribers({
            eventKind: 'gov.new-ref',
            eventId: r.refIndex,
            prefMatches: (p) => p.governance && p.governance.newReferendum,
            makeEmail: ({ subscriber }) => {
                const unsub = unsubscribeUrlFor(subscriber);
                const href  = `${emailSiteOrigin()}/democracy?ref=${r.refIndex}`;
                const tmpl  = emailLayout({
                    title:   `New referendum tabled — #${r.refIndex}`,
                    intro:   `A new referendum (#${r.refIndex}) is now open for voting on Polkadex.`,
                    details: `Voting closes at block ${r.endBlock != null ? Number(r.endBlock).toLocaleString('en-US') : 'unknown'}. Cast your vote before it does.`,
                    ctaText: 'View and vote',
                    ctaHref: href,
                    unsubscribeUrl: unsub
                });
                return { subject: `[Polkadex] New referendum #${r.refIndex} is open for voting`, ...tmpl, unsubscribeUrl: unsub };
            }
        });
    }

    // 2. New public proposals — same pattern.
    for (const p of (publicProposals || [])) {
        await dispatchToSubscribers({
            eventKind: 'gov.new-prop',
            eventId: p.index,
            prefMatches: (pp) => pp.governance && pp.governance.newProposal,
            makeEmail: ({ subscriber }) => {
                const unsub = unsubscribeUrlFor(subscriber);
                const href  = `${emailSiteOrigin()}/democracy?proposal=${p.index}`;
                const tmpl  = emailLayout({
                    title:   `New public proposal — #${p.index}`,
                    intro:   `A new public proposal (#${p.index}) has been tabled. Seconders can endorse it to move it toward a referendum.`,
                    details: null,
                    ctaText: 'View proposal',
                    ctaHref: href,
                    unsubscribeUrl: unsub
                });
                return { subject: `[Polkadex] New public proposal #${p.index}`, ...tmpl, unsubscribeUrl: unsub };
            }
        });
    }

    // 4. Referendum RESULTS — announce a referendum the tick it stops being
    //    open. Not a watermark: a referendum's index says nothing about when
    //    it resolves (#7 can be cancelled while #5 is still open), and the
    //    rows carry no timestamp. See selectNewlyResolved.
    await dispatchResolvedReferenda(referenda);

    // 5. Treasury proposals and 6. council motions — both read tables that
    //    hold FULL chain history, so both go through the first-run watermark.
    await dispatchNewTreasuryProposals();
    await dispatchNewCouncilMotions();

    // 3. Closing-in-24h reminder — for each ongoing referendum whose endBlock
    //    is within the window, dispatch once (idempotent).
    if (typeof globalApi !== 'undefined' && globalApi && globalApi.rpc && globalApi.rpc.chain) {
        let currentBlock = 0;
        try {
            const header = await globalApi.rpc.chain.getHeader();
            currentBlock = header.number.toNumber();
        } catch (_) { /* skip closing-reminder this tick */ }
        const BLOCK_TIME_MS = 12_000;
        for (const r of (referenda || [])) {
            if (!isOpenGovStatus(r.status)) continue;
            if (!r.endBlock || !currentBlock) continue;
            const blocksLeft = Number(r.endBlock) - currentBlock;
            if (blocksLeft <= 0) continue;
            const msLeft = blocksLeft * BLOCK_TIME_MS;
            // Send when between 22h and 26h remaining — a 4-hour window means
            // a slow indexer tick still catches it; tighter ranges risk missing.
            if (msLeft < 22 * 3600_000 || msLeft > 26 * 3600_000) continue;
            await dispatchToSubscribers({
                eventKind: 'gov.closing-24h',
                eventId: r.refIndex,
                prefMatches: (p) => p.governance && p.governance.closingReminder,
                makeEmail: ({ subscriber }) => {
                    const unsub = unsubscribeUrlFor(subscriber);
                    const href  = `${emailSiteOrigin()}/democracy?ref=${r.refIndex}`;
                    const hoursLeft = Math.round(msLeft / 3600_000);
                    const tmpl  = emailLayout({
                        title:   `Referendum #${r.refIndex} closes in ~${hoursLeft} hours`,
                        intro:   `Voting on referendum #${r.refIndex} is ending soon. Cast or change your vote before block ${Number(r.endBlock).toLocaleString('en-US')}.`,
                        details: null,
                        ctaText: 'Vote now',
                        ctaHref: href,
                        unsubscribeUrl: unsub
                    });
                    return { subject: `[Polkadex] Referendum #${r.refIndex} closes in ~${hoursLeft}h`, ...tmpl, unsubscribeUrl: unsub };
                }
            });
        }
    }
}

async function syncData() {
    if (isSyncing || !isRpcReady()) return;
    isSyncing || (isSyncing = true);
    try {
        console.log("Starting validator indexer sync...");
        const activeEraOption = await globalApi.query.staking.activeEra();
        const activeEra = activeEraOption.isSome ? activeEraOption.unwrap().index.toNumber() : 0;
        const validators = await globalApi.query.session.validators();
        const validatorData = [];

        for (const address of validators) {
            const addrStr = address.toString();
            const name = await getIdentity(globalApi, address);
            const [totalStake, prefs] = await Promise.all([
                getEraValidatorStake(globalApi, activeEra, address),
                globalApi.query.staking.validators(address)
            ]);
            const commissionPct = getCommissionPercent(prefs);
            const currentApy = 23.09 * (1 - (commissionPct / 100));

            // Audit F-044: `avg30DayApy` used to be THIS SAME current-prefs
            // number wearing a "(30d)" label. It is the nominal max APY
            // adjusted for today's commission — a projection, not a measured
            // average — and the field name now says so. The old key is kept
            // one release for SPA compatibility and mirrors the same value.
            validatorData.push({ address: addrStr, name: name, totalStake: formatPDEX(totalStake), commission: commissionPct, realApy: currentApy, currentApy, avg30DayApy: currentApy });
        }
        await syncValidatorHistory(activeEra, validators);
        db.replaceValidators(validatorData, { totalCount: validators.length, lastSync: Date.now(), status: 'Synced' });
    } catch (err) {
        logSyncError('Validator sync', err);
        db.setSyncState('validators', { ...db.getSyncState('validators'), status: 'Error', error: err.message });
    } finally { isSyncing = false; }
}

async function syncHolders() {
    if (isSyncingHolders || !isRpcReady()) return;
    isSyncingHolders = true;
    try {
        console.log("Starting holder indexer sync...");
        const entries = await globalApi.query.system.account.entries();
        const totalIssuance = formatPDEX(await globalApi.query.balances.totalIssuance());
        // Audit F-043: converted through formatPDEX (BigInt-safe) instead of
        // Number(...)/1e12 — whale balances above 2^53 planck sorted and
        // displayed with silently truncated low digits.
        const balances = entries.map(([key, data]) => ({ address: key.args[0].toString(), free: formatPDEX(data.data.free), reserved: formatPDEX(data.data.reserved) }))
            .sort((a, b) => (b.free + b.reserved) - (a.free + a.reserved));

        const topHolders = balances.slice(0, 500);
        const holderData = [];
        for (let i = 0; i < topHolders.length; i++) {
            const h = topHolders[i];
            const name = await getIdentity(globalApi, h.address);
            const total = h.free + h.reserved;
            holderData.push({ rank: i + 1, address: h.address, name: name, balance: total, share: (total / totalIssuance) * 100 });
        }
        db.replaceHolders(holderData, { totalCount: entries.length, lastSync: Date.now(), status: 'Synced' });
    } catch (err) {
        logSyncError('Holder sync', err);
        db.setSyncState('holders', { ...db.getSyncState('holders'), status: 'Error', error: err.message });
    } finally { isSyncingHolders = false; }
}

// --- Per-sync backoff -----------------------------------------------------
// When an RPC call times out it can take seconds before the WebSocket gives
// up. With many sync timers, those slow failures stack up and the load
// average climbs (Node event loop saturated + SQLite WAL writes queueing on
// flaky storage). After ANY sync error we skip that sync's next ticks for
// SYNC_BACKOFF_MS. Keys are arbitrary strings; one bucket per sync.
const syncBackoffUntil = new Map();
function inBackoff(key) {
    const until = syncBackoffUntil.get(key) || 0;
    return Date.now() < until;
}
function noteSyncError(key) {
    syncBackoffUntil.set(key, Date.now() + SYNC_BACKOFF_MS);
}

// --- Combined chain indexer (blocks + events) ------------------------------
// Replaces the old syncBlocks + syncEvents pair, which each made their own
// per-block RPC calls (wasted RPC budget) and stopped on the first error
// (left permanent gaps after RPC outages). The new design:
//   1. ONE `derive.chain.getBlock(hash)` per block yields both block data
//      AND events in a single round-trip.
//   2. Forward pass: scan latestScannedBlock+1..head, capped by BLOCKS_FORWARD_MAX.
//   3. Backfill pass: walk one chunk further from backfillCursor toward genesis.
//   4. Gap-fill pass: query DB for any holes within the indexed range and
//      re-attempt one chunk per tick. Catches blocks lost to mid-walk RPC blips.
//   5. Per-block try/catch + N-concurrent batches — one bad block doesn't
//      abort the rest of the range.
let isSyncingChain = false;
// Throttle state for the gap scan (see CHAIN_GAP_SCAN_MS). Module-scoped so it
// persists across ticks on the indexer worker.
let lastRecentGapScanAt = 0;
let lastFullGapScanAt = 0;
// F-046: per-gap consecutive-failure counts, and the tick counter the rotation
// alternates on. Process-local by design — the indexer lease (F-092) means one
// process owns this loop, and losing the counts on restart just means the next
// process re-attempts everything once, which is the safe direction.
const gapAttempts = new Map();
// How many known gaps we have stopped attempting (F-046). Published in the
// index status so "Repairing" can be distinguished from "Repairing, but stuck".
let gapsExhausted = 0;
let gapRotationTick = 0;
let gapAttemptsResetAt = Date.now();
const GAP_ATTEMPT_RESET_MS = readPositiveInteger(process.env.GAP_ATTEMPT_RESET_MS, 6 * 60 * 60 * 1000);

// Throttled operator notice (at most once per minute) that the RPC cannot
// serve historical metadata at the heights being backfilled, so pre-upgrade
// blocks are being indexed without their events.
let _noHistEventsWarnAt = 0;
function warnNoHistoricalEvents(blockNumber) {
    const now = Date.now();
    if (now - _noHistEventsWarnAt < 60000) return;
    _noHistEventsWarnAt = now;
    console.warn(`[chain-index] indexing blocks without events (e.g. #${blockNumber}) — the RPC has pruned historical metadata at that height; point POLKADEX_WS at an archive node for full event history.`);
}

// Fetch a single block by number, returning { block, events } records ready
// for db.insertBlocks / db.insertEvents. Throws on RPC failure so the caller
// can decide whether to mark as a gap.
async function scanSingleBlock(blockNumber) {
    // Guard up-front so a disconnect landing between awaits doesn't dereference
    // a null globalApi. The catch in scanChainRange treats this as a per-block fail.
    if (!isRpcReady()) throw new Error('rpc not ready (disconnected mid-fetch)');
    const hash = await getBlockHashCached(blockNumber);
    if (!isRpcReady()) throw new Error('rpc not ready (disconnected mid-fetch)');

    // Fetch the raw signed block — this gives us extrinsic *envelopes* and does
    // NOT decode system.events. We then decode events against the block's OWN
    // runtime metadata via getEventsAtBlock (api.at(hash)).
    //
    // We deliberately avoid derive.chain.getBlock here: it eagerly decodes
    // system.events with the CURRENT chain-tip metadata, so it throws on every
    // block produced under an older runtime whose EventRecord (Lookup26) shape
    // differs ("Decoded input doesn't match input, 64 vs 67 bytes"). That throw
    // aborted the whole block and re-queued it forever, stalling the backfill —
    // and meant the getEventsAtBlock mitigation below was never even reached.
    const signedBlock = await globalApi.rpc.chain.getBlock(hash);
    if (!signedBlock || !signedBlock.block) return null;
    const header = signedBlock.block.header;
    const blockHash = header.hash.toHex();
    const extrinsics = signedBlock.block.extrinsics;
    const timestamp = getBlockTimestamp(signedBlock);

    // Events via the block's own ApiDecoration. On a NON-archive node that has
    // pruned historical metadata, api.at() fails and getEventsAtBlock returns
    // null; we then index the block with zero events (best-effort) instead of
    // throwing. Full historical event backfill requires an archive RPC.
    // Audit F-006: distinguish "this block genuinely has no events" from "we
    // could not decode its events". getEventsAtBlock returns null for the
    // latter, and coercing that to [] stored the block as a COMPLETE success
    // with zero events — permanent, silent event loss that no retry would ever
    // revisit, while the status said Synced.
    //
    // The block row is still written (the blocks table stays complete and the
    // backfill keeps moving), but the height is flagged so the caller can queue
    // it for retry. On an archive node a null here is a real, transient failure
    // and retrying fixes it. Operators on a PRUNED node — where historical
    // metadata is genuinely gone and no retry can ever succeed — can set
    // EVENTS_STRICT=0 to accept zero-event blocks as final instead of
    // accumulating permanent failures.
    const decodedEvents = await getEventsAtBlock(hash);
    const allEvents = decodedEvents || [];
    const eventsIncomplete = EVENTS_STRICT && decodedEvents === null;
    if (!allEvents.length && extrinsics.length > 1) warnNoHistoricalEvents(blockNumber);

    // Author is best-effort — derived from the consensus digest via
    // derive.chain.getHeader, which does NOT decode events (safe on old blocks).
    let authorAddr = 'System';
    try {
        const h = await globalApi.derive.chain.getHeader(hash);
        if (h && h.author) authorAddr = h.author.toString();
    } catch (_e) { /* leave as System */ }
    const block = {
        number: blockNumber,
        hash: blockHash,
        authorAddress: authorAddr,
        authorName: await getIdentity(globalApi, authorAddr),
        extrinsicsCount: extrinsics.length,
        eventsCount: allEvents.length,
        timestamp
    };
    const events = [];
    for (let eventIndex = 0; eventIndex < allEvents.length; eventIndex++) {
        const record = allEvents[eventIndex];
        const eventId = `${blockHash}-${eventIndex}`;
        const extrinsicIndex = record.phase.isApplyExtrinsic ? record.phase.asApplyExtrinsic.toNumber() : null;
        const extrinsic = extrinsicIndex !== null ? extrinsics[extrinsicIndex] : null;
        const signerAddress = extrinsic && extrinsic.isSigned ? extrinsic.signer.toString() : 'System';
        const txHash = extrinsic ? extrinsic.hash.toHex() : '';
        const status = record.event.section === 'system' && record.event.method === 'ExtrinsicFailed' ? 'failed' : 'success';
        const signerName = signerAddress !== 'System' ? await getIdentity(globalApi, signerAddress) : 'System';
        events.push({
            hash: eventId, txHash, blockHash, block: blockNumber, eventIndex, extrinsicIndex,
            section: record.event.section, method: record.event.method,
            data: record.event.data.toHuman(), signerAddress, signerName, timestamp, status
        });
    }
    return { block, events, eventsIncomplete };
}

// Scan an inclusive numeric range, processing blocks in parallel batches.
// Returns { blocks, events, attempts, succeeded, failedNumbers, incompleteNumbers }.
// `incompleteNumbers` are heights whose BLOCK was stored but whose EVENTS could
// not be decoded (audit F-006) — the caller queues them for retry.
async function scanChainRange(startBlock, endBlock, maxAttempts) {
    const top = Math.max(startBlock, endBlock);
    const bottom = Math.min(startBlock, endBlock);
    const total = Math.min(top - bottom + 1, maxAttempts);
    // Build the descending list of numbers to attempt; capped at total.
    const numbers = [];
    for (let n = top; numbers.length < total && n >= bottom; n--) numbers.push(n);

    const blocks = [];
    const events = [];
    const failedNumbers = [];
    const incompleteNumbers = [];
    // Heights the node simply couldn't serve right now. Kept separate from
    // failedNumbers so the caller doesn't record a scan failure for them.
    const transientNumbers = [];
    const failureReasons = new Map();
    let succeeded = 0;

    for (let i = 0; i < numbers.length; i += BLOCKS_FETCH_CONCURRENCY) {
        const chunk = numbers.slice(i, i + BLOCKS_FETCH_CONCURRENCY);
        const results = await Promise.all(chunk.map(n => scanSingleBlock(n).catch(err => {
            const message = shortErrorMessage(err);
            // Keep the MESSAGE, don't just log it. The caller has to know
            // whether this was the node being unreachable or the block being
            // undecodable, because a transport failure must not consume one of
            // the block's ten retry attempts (lib/rpc-errors.js). The previous
            // version logged the message and returned a bare `{__error}`, so a
            // single disconnect mid-tick could burn an attempt on up to
            // BLOCKS_FORWARD_MAX + BLOCKS_BACKFILL_CHUNK heights at once —
            // reintroducing, on the busiest indexer, exactly the defect that
            // permanently retired three governance blocks in June.
            const transient = isRpcUnavailableError(err);
            if (!transient) console.warn(`[chain-index] block ${n} fetch failed: ${message}`);
            return { __error: true, n, message, transient };
        })));
        for (let j = 0; j < results.length; j++) {
            const r = results[j];
            if (r && !r.__error) {
                blocks.push(r.block);
                for (const e of r.events) events.push(e);
                succeeded++;
                if (r.eventsIncomplete) incompleteNumbers.push(chunk[j]);
            } else if (r && r.transient) {
                transientNumbers.push(chunk[j]);
            } else {
                failedNumbers.push(chunk[j]);
                failureReasons.set(chunk[j], (r && r.message) || 'fetch failed');
            }
        }
    }
    if (transientNumbers.length) {
        console.warn(`[chain-index] deferred ${transientNumbers.length} block(s) (node unavailable, attempts not counted)`);
    }
    return {
        blocks, events, attempts: numbers.length, succeeded,
        failedNumbers, incompleteNumbers, transientNumbers, failureReasons
    };
}

// Audit F-004 support. Write a skipped height range into scan_failures so the
// hole is an explicit, queryable fact instead of something a later window scan
// has to rediscover.
//
// Bounded on purpose: a long outage can skip tens of thousands of heights, and
// one row per block would bloat the table and the retry queue. Record the
// OLDEST portion — those are the blocks at risk of drifting out of the cheap
// recent-gap window (CHAIN_GAP_SCAN_WINDOW) into the 12×-slower hourly full
// scan. The remainder stays discoverable by the window scan, which is exactly
// the pre-existing behaviour, so this is strictly an improvement.
const SKIP_RECORD_MAX = readPositiveInteger(process.env.SKIP_RECORD_MAX, 2000);

// How many interior gaps to total up per scan. Bounded because the LEAD window
// query already ran — this only affects how many rows come back — but not 1,
// which is what it was, and which made a hundred holes report as one.
const CHAIN_GAP_COUNT_LIMIT = readPositiveInteger(process.env.CHAIN_GAP_COUNT_LIMIT, 500);

// Record what a scanChainRange pass could not complete.
//
// Two rules, both learned the hard way:
//   * transientNumbers are NOT recorded at all. A node that was unreachable
//     tells us nothing about a block, so those attempts must be free
//     (lib/rpc-errors.js — ten unlucky disconnects permanently retired three
//     governance blocks in June).
//   * the reason string is the ACTUAL error. requeueTransientScanFailures
//     matches on last_error, so a constant like 'forward pass fetch failed'
//     would leave a genuine transport casualty unrescuable forever.
function recordChainScanFailures(result, passName) {
    if (!result) return;
    const reasons = result.failureReasons instanceof Map ? result.failureReasons : new Map();
    for (const n of (result.failedNumbers || [])) {
        db.recordScanFailure('chain_index', n, `${passName}: ${reasons.get(n) || 'fetch failed'}`);
    }
    for (const n of (result.incompleteNumbers || [])) {
        db.recordScanFailure('chain_index', n, `${passName}: events could not be decoded (F-006) — block stored, events pending`);
    }
}

function recordSkippedRange(indexer, from, to, reason) {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const total = hi - lo + 1;
    const cap = Math.min(total, SKIP_RECORD_MAX);
    for (let n = lo; n < lo + cap; n++) db.recordScanFailure(indexer, n, reason);
    if (total > cap) {
        console.warn(`[${indexer}] skipped range ${lo}-${hi} is ${total} blocks; recorded the oldest ${cap} (SKIP_RECORD_MAX) — the rest remain discoverable by the gap scan`);
    }
    return cap;
}

// ─── Reorg detection and repair (audit F-007) ───────────────────────────────
//
// `blocks.number` is the primary key and no pass ever revisits a written
// height, so until now the first hash the indexer saw at a height was the hash
// it kept — forever. The forward pass follows the BEST head, which is exactly
// the part of the chain that can still be discarded, so after any short reorg
// the explorer kept presenting the orphan block, its events, its transactions
// and its reward rows as canonical. The tx-detail endpoint even ships a ±2
// "in case of reorgs" neighbour search on top of tables that keep the fork.
//
// Anchor: a GRANDPA-FINALIZED hash can never change. Two passes per tick, both
// planned by lib/reorg.js (where the range arithmetic is unit-tested):
//
//   FINALITY SWEEP — kv watermark `reorg:verified` = highest height whose
//   stored hash was compared against its FINALIZED hash. Sweep
//   (verified, finalizedHead], repair mismatches, advance. Every height gets
//   exactly one guaranteed check against its immutable hash — including the
//   race where a block is written, reorged AND finalized between two ticks.
//   Steady state: 1–2 heights per tick.
//
//   TAIL CHECK — (finalizedHead, bestHead] re-checked every tick, watermark
//   untouched (nothing there is final). This bounds how long a visitor can be
//   looking at an orphan to roughly one tick instead of one finalization lag.
//
// First run adopts verified = finalizedHead: verifying 12.8M historical rows
// would be one RPC call each, and an orphan that old is a cosmetic artefact
// rather than a live hazard. Repairs are exact, not blind: delete rows whose
// stored hash differs from canonical (lib/id-migration.js — which is also why
// tx/reward ids are hash-keyed now, F-021), then rescan the height.

const REORG_SWEEP_MAX = readPositiveInteger(process.env.REORG_SWEEP_MAX, 200);
const REORG_TAIL_MAX = readPositiveInteger(process.env.REORG_TAIL_MAX, 64);

// Derive event-derived transaction rows for a local block range and insert
// them. Zero RPC — reads the events table. Shared by the F-008 backfill pass,
// the reorg repair, and the chain_index gap-fill/failure-queue (which insert
// events for repaired heights that the backfill cursor has long passed, so
// someone has to re-derive or those transfers never reach the tx table).
function deriveTransactionsFromLocalEvents(lo, hi) {
    // F-080: pass the normaliser so backfilled rows carry the SAME SS58
    // spelling as live-indexed ones. A review caught that only the live writer
    // normalised, while this path produces the bulk of the table.
    const rows = db.getTransferEventRowsRange(lo, hi)
        .map(ev => buildTxRowFromEventRow(ev, normalizeAddress))
        .filter(Boolean);
    if (rows.length) db.insertTransactions(rows);
    return rows.length;
}

// Repair one height whose canonical hash is known and differs from storage.
async function repairReorgedBlock(n, canonicalHash, storedHash) {
    console.warn(`[reorg] block ${n}: stored ${storedHash} is not canonical ${canonicalHash} — repairing`);

    // Delete the fork's rows FIRST. Rescan inserts use OR IGNORE / OR REPLACE,
    // so inserting before deleting would leave orphan events beside canonical
    // ones — the audit's "second event set" failure.
    const del = db.deleteForkRows(n, canonicalHash);

    // The number→hash cache is the one cache keyed by NUMBER, so it is the one
    // place the pre-reorg view survives a repair. Evict before rescanning or
    // scanSingleBlock would faithfully re-fetch the orphan.
    blockHashCache.evict(String(n));

    // Rescan the canonical block: blocks row (INSERT OR REPLACE overwrites the
    // orphan header), events, event-derived transactions, reward rows.
    // Self-healing note: if scanSingleBlock THROWS here, the fork rows are
    // deleted but nothing is reinserted — and that is recoverable BECAUSE the
    // blocks row still holds the old hash (INSERT OR REPLACE never ran), so
    // the next sweep sees the same mismatch and redoes the whole repair. The
    // dangerous cases are the ones where the rescan half-succeeds, below.
    const rescan = await scanSingleBlock(n);
    if (rescan && rescan.block) db.insertBlocks([rescan.block]);
    if (rescan && rescan.events && rescan.events.length) db.insertEvents(rescan.events);
    if (rescan && rescan.eventsIncomplete) {
        db.recordScanFailure('chain_index', n, 'reorg repair: events could not be decoded (F-006) — block stored, events pending');
        // Half-success trap the batch review caught: the blocks row is now
        // canonical, so this sweep will NEVER revisit the height — and the
        // chain_index failure queue only reinstates blocks and events, while
        // the F-008 cursor is monotonic and long past. Without this row the
        // transfers we just deleted would be gone permanently.
        db.recordScanFailure('transactions', n, 'reorg repair: events pending — transfers must be re-derived');
    }

    deriveTransactionsFromLocalEvents(n, n);

    // Same trap for rewards: they were deleted above, so a rescan that does
    // not complete MUST leave a queue entry or the rows are lost. A
    // non-transient failure records its own scan_failures row inside
    // scanBlockForRewards; the transient/thrown paths deliberately do not
    // (lib/rpc-errors.js) — correct for ordinary scanning, wrong after a
    // delete — so those two cases are recorded here.
    const rw = await scanBlockForRewards(n).catch(() => null);
    if (rw && rw.ok) {
        if (rw.rewards.length) db.insertStakingRewards(rw.rewards.map(toRewardRow));
    } else if (!rw || rw.transient) {
        db.recordScanFailure('staking_rewards', n, 'reorg repair: reward rows deleted, rescan deferred — retry');
    }

    console.log(`[reorg] block ${n} repaired: removed ${del.events} event(s), ${del.transactions} tx row(s), ${del.rewards} reward row(s) from the discarded fork; canonical data reinserted`);
}

async function reorgSweep(head) {
    if (!isRpcReady()) return;

    const finalizedHash = await globalApi.rpc.chain.getFinalizedHead();
    const finalizedNumber = (await globalApi.rpc.chain.getHeader(finalizedHash)).number.toNumber();

    const stored = db.getKv('reorg:verified');
    const plan = planReorgSweep({
        verified: stored && stored.value !== undefined ? stored.value : null,
        finalizedNumber,
        head,
        sweepMax: REORG_SWEEP_MAX,
        tailMax: REORG_TAIL_MAX
    });

    if (plan.firstRun) {
        db.setKv('reorg:verified', { value: plan.adopt, updatedAt: Date.now() });
        console.log(`[reorg] first run — verified watermark adopted at finalized head ${plan.adopt}; heights below it are assumed canonical, everything above is checked from now on`);
    }

    // What do we hold for the planned ranges? Heights we never stored cannot
    // hold an orphan block and cost nothing.
    //
    // Read each NON-EMPTY range separately. The obvious-looking
    // `min(sweepFrom, tailFrom)..max(sweepTo, tailTo)` is a trap the batch
    // review caught before it shipped: an empty sweep is encoded as
    // (from=1, to=0), so on the FIRST TICK AFTER DEPLOY min() resolved to 1
    // and max() to the chain head — a synchronous read of all 12.8M block
    // rows into a JS Map, minutes of blocked event loop or an OOM-kill,
    // exactly once, on the deploy where it would be least explicable.
    const storedHashes = new Map();
    for (const [a, b] of [[plan.sweepFrom, plan.sweepTo], [plan.tailFrom, plan.tailTo]]) {
        if (b < a) continue;
        for (const r of db.getBlockHashesRange(a, b)) storedHashes.set(Number(r.number), r.hash);
    }
    if (storedHashes.size === 0 && plan.sweepTo < plan.sweepFrom) return;
    const heights = heightsToVerify(plan, new Set(storedHashes.keys()));

    // Verify ascending. `verifiedUpTo` only advances past heights whose check
    // COMPLETED — an RPC failure mid-sweep stops the watermark exactly there,
    // so the unchecked remainder is next tick's work rather than silently
    // marked verified.
    let verifiedUpTo = null;
    let repaired = 0;
    try {
        for (const n of heights) {
            // Direct RPC, NOT getBlockHashCached: the cache is precisely where
            // the pre-reorg view lives.
            const canonical = (await globalApi.rpc.chain.getBlockHash(n)).toHex();
            if (hashesDiffer(storedHashes.get(n), canonical)) {
                await repairReorgedBlock(n, canonical, storedHashes.get(n));
                repaired++;
            } else if (canonical && canonical.startsWith('0x') && !/^0x0+$/.test(canonical)) {
                // The blocks row agrees with the chain — but the CHILD tables
                // can still disagree. syncTransactions and syncChainIndex run
                // un-awaited in the same interval and fetch their hashes
                // independently, so around an in-flight reorg one pass can
                // store fork-A tx rows while the other stores the canonical-B
                // block. blocks.hash then matches canonical, no repair fires,
                // and nothing else ever compares transactions.block_hash to
                // blocks.hash — the fork tx row would be permanent. So every
                // verified height also gets the (normally no-op, indexed)
                // child-table consistency delete, and anything it removes is
                // queued for rescan through the machinery that owns it.
                const del = db.deleteForkRows(n, canonical);
                if (!del.skipped && (del.events || del.transactions || del.rewards)) {
                    console.warn(`[reorg] block ${n}: blocks row canonical but child tables held fork rows — removed ${del.events} event(s), ${del.transactions} tx, ${del.rewards} reward(s); queueing rescans`);
                    if (del.events) db.recordScanFailure('chain_index', n, 'reorg consistency: fork events removed — rescan');
                    if (del.transactions) db.recordScanFailure('transactions', n, 'reorg consistency: fork tx rows removed — rescan');
                    if (del.rewards) db.recordScanFailure('staking_rewards', n, 'reorg consistency: fork reward rows removed — rescan');
                }
            }
            if (n >= plan.sweepFrom && n <= plan.sweepTo) verifiedUpTo = n;
        }
        // A clean pass verifies the whole sweep range even where nothing was
        // stored (nothing stored = nothing to be wrong about).
        if (plan.sweepTo >= plan.sweepFrom) verifiedUpTo = plan.sweepTo;
    } finally {
        if (!plan.firstRun && verifiedUpTo !== null && verifiedUpTo >= plan.sweepFrom) {
            db.setKv('reorg:verified', { value: verifiedUpTo, updatedAt: Date.now() });
        }
        if (repaired > 0) {
            console.warn(`[reorg] repaired ${repaired} reorged height(s) this tick`);
        }
    }
}

async function syncChainIndex() {
    if (isSyncingChain || !isRpcReady() || inBackoff('chain_index')) return;
    isSyncingChain = true;
    try {
        const state = db.getSyncState('chain_index');
        const head = (await globalApi.rpc.chain.getHeader()).number.toNumber();
        // Feed the freshness watchdog. recordChainHead is a no-op when head
        // didn't advance, so calling it on every tick is cheap.
        recordChainHead(head);
        let initialized = !!state.initialized;
        // Audit F-004 (round 2). `headSeen` is the top of the CLAIMED span —
        // how far the forward pass has reached. `latestScannedBlock` is now
        // DERIVED from the failure queue at the end of the tick and means "no
        // known hole at or below here"; nothing assigns it directly any more.
        // See lib/watermark.js for why one field could not answer both.
        // readHeadSeen adopts the pre-upgrade `latestScannedBlock` so the first
        // tick after deploy does not re-walk the chain from genesis.
        let headSeen = readHeadSeen(state);
        let oldestScannedBlock = Number(state.oldestScannedBlock) || 0;
        let backfillCursor = Number(state.backfillCursor) || 0;
        let backfillComplete = !!state.backfillComplete;

        // First run: anchor watermarks just BELOW the current head; backfill
        // then walks everything under it toward genesis on later ticks.
        //
        // Audit F-113: this used to set the watermark = head, which claims the
        // head block is indexed without ever fetching it — block `head` was
        // permanently absent on every fresh database (and only recoverable by a
        // later gap scan). Anchoring at head-1 means the forward pass below
        // scans `head` on this very tick, because head > headSeen.
        if (!initialized) {
            initialized = true;
            headSeen = head - 1;
            oldestScannedBlock = head;
            backfillCursor = head - 1;
            backfillComplete = (head - 1) < BLOCKS_MIN_BLOCK;
        }

        // Set when a fetch fails this tick, so the gap-fill pass runs
        // immediately instead of waiting for its throttled cadence.
        let tickHadFailures = false;

        // 1) FORWARD PASS — index everything new since the last tick.
        if (head > headSeen) {
            if (head - headSeen > BLOCKS_FORWARD_MAX) {
                console.warn(`[chain-index] forward gap ${head - headSeen} exceeds cap; scanning newest ${BLOCKS_FORWARD_MAX} this tick — remainder will be picked up by gap-fill.`);
            }
            const forward = await scanChainRange(headSeen + 1, head, BLOCKS_FORWARD_MAX);
            if (forward.blocks.length) db.insertBlocks(forward.blocks);
            if (forward.events.length) db.insertEvents(forward.events);
            // Event-driven governance refresh. The council snapshot otherwise
            // renews on a slow timer (COUNCIL_REFRESH_MS), which meant a new
            // motion or a fresh vote took minutes to appear — painful for a
            // 3-seat-threshold council watching a live vote. The forward pass
            // runs every ~12s on new blocks only, so piggy-backing here makes
            // motions appear within one block-tick of landing on-chain at
            // near-zero extra cost (the events are already in hand).
            if (forward.events.some(e => /^(council|councilCollective|generalCouncil)$/i.test(e.section || ''))) {
                console.log('[chain-index] council event in fresh block — refreshing council snapshot now');
                syncCouncil().catch(() => { /* the interval pass remains the safety net */ });
            }
            if (forward.failedNumbers && forward.failedNumbers.length) tickHadFailures = true;

            // Audit F-004. scanChainRange() walks DOWNWARD from `head` and stops
            // after BLOCKS_FORWARD_MAX attempts, so when the explorer has been
            // offline the oldest part of [headSeen+1, head] is never attempted
            // this tick. Round 1 recorded those heights in scan_failures but
            // still jumped the watermark to `head`, so the API kept reporting
            // "Synced" over the hole — round 2 called that "recovery around the
            // jump, not removal of the jump". That is how a 4-hour outage on
            // 2026-08-22 produced a silent 1,213-block gap.
            //
            // Now the jump belongs to `headSeen` ALONE, which only ever claims
            // "we have reached this far", never "everything below is present".
            // The trustworthy watermark is derived from the failure queue at
            // the end of the tick, so it stops at the skip and advances again
            // by itself once the repair pass clears the row.
            const lowestAttempted = Math.max(headSeen + 1, head - BLOCKS_FORWARD_MAX + 1);
            if (lowestAttempted > headSeen + 1) {
                const skipFrom = headSeen + 1;
                const skipTo = lowestAttempted - 1;
                console.warn(`[chain-index] forward cap skipped ${skipFrom}-${skipTo} (${skipTo - skipFrom + 1} blocks) — recording for repair`);
                recordSkippedRange('chain_index', skipFrom, skipTo, 'forward cap: not attempted this tick');
            }
            // Real reason strings, not a constant. requeueTransientScanFailures
            // matches on last_error, so a hardcoded 'forward pass fetch failed'
            // would make a transport casualty permanently unrescuable.
            recordChainScanFailures(forward, 'forward pass');

            headSeen = head;
            if (oldestScannedBlock === 0) oldestScannedBlock = head;
            db.setSyncState('chain_index', {
                // MERGE, not replace. setSyncState is setKv, which overwrites
                // the whole row — so this mid-tick checkpoint used to drop
                // knownGapBlocks, interiorGapBlocks, gapsExhausted,
                // retryableFailures, permanentFailures and detail every tick.
                // /api/blocks and /api/events read exactly those, so coverage
                // reported all zeros for the window between the forward pass
                // and the end of tick — every tick. Worse, a restart inside
                // that window made the next tick's carry-forward read 0 and
                // deriveIndexStatus could report Synced over an interior hole,
                // which is the flapping the carry-forward exists to prevent.
                ...state,
                initialized, headSeen, oldestScannedBlock, backfillCursor, backfillComplete,
                // Mid-tick checkpoint. Derived here too, so a crash between the
                // forward pass and the end of the tick cannot leave a persisted
                // watermark that claims more than the failure queue supports.
                latestScannedBlock: contiguousWatermark({
                    headSeen,
                    lowestOutstandingFailure: db.getLowestScanFailure('chain_index'),
                    floor: oldestScannedBlock
                }),
                lastSync: Date.now(), status: 'Syncing'
            });
        }

        // 2) BACKFILL PASS — extend coverage one chunk toward genesis.
        if (!backfillComplete && backfillCursor >= BLOCKS_MIN_BLOCK) {
            const stop = Math.max(backfillCursor - BLOCKS_BACKFILL_CHUNK + 1, BLOCKS_MIN_BLOCK);
            const back = await scanChainRange(stop, backfillCursor, BLOCKS_BACKFILL_CHUNK);
            if (back.blocks.length) db.insertBlocks(back.blocks);
            if (back.events.length) db.insertEvents(back.events);
            if (back.failedNumbers && back.failedNumbers.length) tickHadFailures = true;
            // Same F-006 bookkeeping as the forward pass: a stored block whose
            // events failed to decode must not count as finished.
            recordChainScanFailures(back, 'backfill');
            oldestScannedBlock = Math.min(oldestScannedBlock || backfillCursor, stop);
            backfillCursor = stop - 1;
            if (backfillCursor < BLOCKS_MIN_BLOCK) backfillComplete = true;
        }

        // 3) GAP-FILL PASS — repair holes inside the indexed range. The window
        // scan (getBlockGaps) used to run on EVERY tick over the whole blocks
        // table — the dominant steady-state CPU cost. Now it's throttled:
        //   * while backfilling, holes can be deep, so use a full scan but only
        //     every CHAIN_GAP_SCAN_MS (the backfill pass makes the real progress);
        //   * once backfill is complete, new holes only appear near the head, so
        //     scan a bounded recent window every CHAIN_GAP_SCAN_MS, with a full
        //     scan every CHAIN_FULL_GAP_SCAN_MS as a safety net;
        //   * a tick that had fetch failures forces a scan immediately.
        const nowTs = Date.now();
        let doScan = false, fullScan = false;
        if (tickHadFailures) { doScan = true; fullScan = !backfillComplete; }
        if (!backfillComplete) {
            if (nowTs - lastFullGapScanAt >= CHAIN_GAP_SCAN_MS) { doScan = true; fullScan = true; }
        } else {
            if (nowTs - lastRecentGapScanAt >= CHAIN_GAP_SCAN_MS) doScan = true;
            if (nowTs - lastFullGapScanAt >= CHAIN_FULL_GAP_SCAN_MS) { doScan = true; fullScan = true; }
        }

        let gaps = [];
        // Repair candidates are a SUPERSET of `gaps`: interior holes plus the
        // edge holes F-183 added. Kept separate because `gaps` is also the
        // array the interior block COUNT is reduced from, and merging the two
        // double-counted every edge hole into knownGapBlocks.
        let repairCandidates = [];
        if (doScan) {
            // Audit F-047 (round 2): the "full" scan is now a rolling WINDOW,
            // not an unbounded LEAD over the whole table.
            //
            // node:sqlite is synchronous. An O(rows) window function on 12.8M
            // rows blocks the event loop for seconds — and in WORKERS<=1 the
            // indexer IS the HTTP server, so that is a gateway timeout on every
            // request unlucky enough to land during it. Round 1's throttle made
            // it hourly and capped the result count; neither bounds the SCAN.
            //
            // Each full-scan tick now sweeps one FULL_SCAN_WINDOW slice and
            // advances a persistent cursor, so the whole history is still
            // covered — just across many ticks, none of them long. The cursor
            // is in kv so a restart resumes rather than re-walking from head.
            let sinceBlock, untilBlock = null;
            if (!fullScan) {
                sinceBlock = Math.max(BLOCKS_MIN_BLOCK, head - CHAIN_GAP_SCAN_WINDOW);
            } else {
                const saved = Number((db.getKv('chain_index:fullScanCursor') || {}).next);
                let cursorTop = Number.isFinite(saved) && saved > BLOCKS_MIN_BLOCK ? saved : head;
                if (cursorTop > head) cursorTop = head;
                untilBlock = cursorTop;
                sinceBlock = Math.max(BLOCKS_MIN_BLOCK, cursorTop - CHAIN_FULL_SCAN_WINDOW + 1);
                // Next tick continues below this slice; wrap at the bottom so
                // the sweep is continuous rather than one-shot.
                const next = sinceBlock <= BLOCKS_MIN_BLOCK ? head : sinceBlock - 1;
                db.setKv('chain_index:fullScanCursor', { next, at: Date.now() });
                console.log(`[chain-index] full gap sweep ${sinceBlock}-${untilBlock} (window ${CHAIN_FULL_SCAN_WINDOW}, F-047)`);
            }
            // Limit is for the COUNT, not the repair: this used to be 1, so
            // `knownGapBlocks` reported a single hole however many there were.
            // Repair takes ONE gap per tick — chosen by the F-046 rotation
            // below, not gaps[0]. (This comment used to say "gaps[0] (the
            // newest), which is the intended pacing" and sat directly above the
            // rotation that replaced it.)
            gaps = db.getBlockGaps(CHAIN_GAP_COUNT_LIMIT, sinceBlock, untilBlock);
            repairCandidates = gaps;
            lastRecentGapScanAt = nowTs;
            if (fullScan) lastFullGapScanAt = nowTs;

            // Audit F-183 (round 2): EDGE holes must be repairable, not just
            // countable.
            //
            // getBlockGaps uses a LEAD window, which by construction can only
            // see holes BETWEEN two stored rows — it is blind to a missing
            // prefix (below the oldest stored block) or suffix (above the
            // newest). F-005 added getEdgeGaps so those holes reach
            // knownGapBlocks and the status honestly says "Repairing"… and
            // then nothing ever scanned them. The operator saw a hole, the
            // visitor saw a hole, and no pass anywhere was going to visit it.
            //
            // "Repairing" has to mean a crawler will get there. Edge holes now
            // join the same candidate list the rotation picks from, so they
            // compete for the repair budget on equal terms with interior ones.
            // Against the CLAIMED span (headSeen). The derived watermark is not
            // in scope yet — and must not be used here anyway: a suffix hole
            // drags it below itself, which would hide the hole from the very
            // query meant to find it.
            const edgeForRepair = db.getEdgeGaps(oldestScannedBlock, headSeen);
            if (edgeForRepair.length) {
                for (const eg of edgeForRepair) {
                    console.warn(`[chain-index] ${eg.kind} hole ${eg.gapStart}-${eg.gapEnd} (${eg.gapSize} blocks) — queued for repair (F-183)`);
                }
                // Edge holes first: a suffix hole sits at the HEAD, which is
                // what a visitor loads on the home page, and a prefix hole
                // means the claimed oldestScannedBlock is a lie about coverage.
                // Adversarial review: this used to reassign `gaps`, and `gaps`
                // is what line ~8240 reduces into `interiorGapBlocks` — which
                // is then ADDED to the edge total again a line later. So every
                // edge hole was counted twice in `knownGapBlocks`, and because
                // the inflated `interiorGapBlocks` is persisted and carried
                // forward on the ~24 of 25 ticks that skip the throttled scan,
                // the doubling stuck. The comment below the reduce states the
                // exact invariant this broke.
                //
                // Repair candidates and the interior COUNT are now separate
                // values: the rotation still gets edge holes first, and the
                // arithmetic still sees only interior ones.
                repairCandidates = edgeForRepair.concat(gaps);
            }
            // F-046: periodic amnesty. A hole that was unfillable six hours ago
            // may be fillable now — repointing RPC at an archive node is the
            // obvious case, and nothing in this process can observe that.
            if (shouldRetire(gapAttemptsResetAt, nowTs, GAP_ATTEMPT_RESET_MS)) {
                if (gapAttempts.size) {
                    console.log(`[chain-index] clearing ${gapAttempts.size} gap attempt counter(s) for a retry round (F-046)`);
                }
                gapAttempts.clear();
                gapAttemptsResetAt = nowTs;
            }

            // F-046: was unconditionally gaps[0] — the newest hole — so a hole
            // the RPC cannot serve absorbed the entire repair budget on every
            // tick, forever, and older holes were never reached. Alternate
            // newest/oldest and set aside gaps that have failed repeatedly.
            const g = chooseGap(repairCandidates, {
                attempts: gapAttempts,
                tick: gapRotationTick++,
                maxAttempts: DEFAULT_MAX_GAP_ATTEMPTS
            });
            // F-046's honest-status half. A review caught exhaustedGapCount
            // being imported and never used while lib/gap-scheduling.js said
            // "the caller surfaces this in the index status so Repairing does
            // not imply making progress" — so the status stayed at "Repairing"
            // indefinitely with nothing to say repair was PAUSED. That is the
            // F-004 dishonesty this finding claims to close, one level up.
            gapsExhausted = exhaustedGapCount(repairCandidates, gapAttempts, DEFAULT_MAX_GAP_ATTEMPTS);
            if (gaps.length && !g) {
                console.warn(`[chain-index] all ${gaps.length} known gap(s) have failed ${DEFAULT_MAX_GAP_ATTEMPTS}× — pausing repair until the next retry round. Is the RPC an archive node?`);
            }
            if (g) {
                const chunkEnd = g.gapEnd;
                const chunkStart = Math.max(g.gapStart, g.gapEnd - BLOCKS_GAP_FILL_CHUNK + 1);
                const fill = await scanChainRange(chunkStart, chunkEnd, BLOCKS_GAP_FILL_CHUNK);
                if (fill.blocks.length) db.insertBlocks(fill.blocks);
                if (fill.events.length) db.insertEvents(fill.events);
                // Retire the scan_failures rows we just repaired, and bump the
                // ones that failed again. Without this the recorded-skip rows
                // from the forward pass would linger forever and keep the
                // status pinned at "Repairing" over an index that is actually
                // whole.
                const stillFailed = new Set(fill.failedNumbers || []);
                const stillIncomplete = new Set(fill.incompleteNumbers || []);
                for (const blk of fill.blocks) {
                    // Only retire a height if its events came through too —
                    // otherwise the F-006 case would clear its own retry row.
                    if (blk && blk.number != null && !stillIncomplete.has(blk.number)) {
                        db.clearScanFailure('chain_index', blk.number);
                    }
                }
                recordChainScanFailures(fill, 'gap-fill');
                // Late events (F-008): the tx backfill cursor is monotonic and
                // has usually passed these heights, so derive their transfers
                // here or they never reach the transactions table.
                if (fill.events.length) deriveTransactionsFromLocalEvents(chunkStart, chunkEnd);
                // F-046: any progress clears this gap's failure count; none
                // increments it. Keyed on gapStart, which is stable while the
                // fill works downward — keying on size would reset the count
                // every time a gap shrank, so a slowly-failing gap would never
                // be set aside.
                recordAttempt(gapAttempts, g, fill.blocks.length);
                console.log(`[chain-index] gap-fill ${chunkStart}-${chunkEnd} (gap of ${g.gapSize}): ${fill.succeeded}/${fill.attempts} repaired`);
            }
        }

        // 3b) FAILURE-QUEUE PASS — retry the heights recorded in scan_failures.
        //
        // The gap scan above cannot do this job. It finds holes with a LEAD
        // window over STORED rows, so it is blind to exactly the case F-006
        // introduced: a block whose row was written but whose events could not
        // be decoded. That height is present in `blocks`, absent from `events`,
        // and invisible to getBlockGaps forever. Without this pass its
        // scan_failures row is write-only — nothing ever clears it, so
        // retryableFailures stays above zero and the status is pinned at
        // "Repairing" permanently while claiming a queue that no code reads.
        //
        // The other two indexers (governance, staking_rewards) have had this
        // pass all along; chain_index simply never grew one, because until
        // F-004/F-006 it never wrote failure rows.
        const queued = db.getScanFailures('chain_index', SCAN_GAP_FILL_BATCH, SCAN_MAX_ATTEMPTS);
        if (queued.length) {
            let repaired = 0;
            for (const row of queued) {
                const n = Number(row.block);
                if (!Number.isFinite(n)) continue;
                const one = await scanChainRange(n, n, 1);
                if (one.blocks.length) db.insertBlocks(one.blocks);
                if (one.events.length) db.insertEvents(one.events);
                // Clear only on a fully clean re-scan: the block came back AND
                // its events decoded. Otherwise recordChainScanFailures leaves
                // the row with its attempts counter bumped — or, for a
                // transport failure, untouched and free to retry.
                const clean = one.blocks.length > 0
                    && (one.incompleteNumbers || []).length === 0
                    && (one.failedNumbers || []).length === 0;
                if (clean) { db.clearScanFailure('chain_index', n); repaired++; }
                else recordChainScanFailures(one, 'failure-queue retry');
                if (one.events.length) deriveTransactionsFromLocalEvents(n, n);
            }
            console.log(`[chain-index] failure-queue: ${repaired}/${queued.length} height(s) repaired`);
        }

        // 3c) REORG SWEEP (audit F-007) — does the chain still agree with what
        // we stored? Transport errors are the node's problem, not this
        // height's; anything else is logged and retried next tick because the
        // verified-watermark only advances past heights actually checked.
        try {
            await reorgSweep(head);
        } catch (err) {
            if (!isRpcUnavailableError(err)) {
                console.warn('[reorg] sweep failed this tick:', err && err.message ? err.message : err);
            }
        }

        // ── Honest status (audit F-004 / F-050) ─────────────────────────────
        // This used to hardcode status:'Synced' — on the very tick that could
        // log "known gaps=1". Derive it from what we actually know instead.
        //
        // Cheap by construction: edge gaps are MIN/MAX on the PK, the failure
        // counts are an indexed aggregate, and `gaps` is already in hand from
        // the throttled scan above. No extra window scan.
        // Re-measured here for the status total (F-005). No warning: the
        // repair pass above already logged and QUEUED these (F-183), and
        // warning twice per tick about a hole that is being worked on trains
        // the operator to filter the log.
        // Compared against the CLAIMED span (headSeen), not the verified one.
        // Using the derived watermark here would be circular: a suffix hole
        // pulls the watermark down to just below itself, and comparing
        // MAX(number) against that lowered value makes the hole disappear from
        // the very measurement that is supposed to report it.
        const edgeGaps = db.getEdgeGaps(oldestScannedBlock, headSeen);
        const failCounts = db.countScanFailures('chain_index', SCAN_MAX_ATTEMPTS);

        // Audit F-004 (round 2): the watermark is DERIVED, once, from the state
        // of the failure queue after this tick's repairs — never assigned from
        // `head`. One outstanding hole at height F pins it to F-1 no matter how
        // many blocks above F are stored, and clearing that row is all a repair
        // has to do for it to advance again.
        const lowestFailure = db.getLowestScanFailure('chain_index');
        const latestScannedBlock = contiguousWatermark({
            headSeen, lowestOutstandingFailure: lowestFailure, floor: oldestScannedBlock
        });

        // Interior-gap total. Two traps here, both of which made the status
        // dishonest again in the exact scenario this code exists for:
        //
        //  1. The window scan is THROTTLED (5 min) while the tick runs every
        //     12 s, so on ~24 of every 25 ticks `gaps` is [] — not because the
        //     index is whole but because we didn't look. Recomputing from it
        //     unconditionally flapped the status back to 'Synced' between
        //     scans, over the very 1,213-block hole this was written to
        //     surface. So when we didn't scan, carry the last measurement
        //     forward instead of asserting zero.
        //  2. getBlockGaps takes a LIMIT, and it was being called with 1, so
        //     the total counted one hole no matter how many existed. Count over
        //     a batch; still repair only the newest one per tick.
        // Carried forward from `interiorGapBlocks`, NOT from the persisted
        // `knownGapBlocks` — that one already includes the edge component,
        // which is re-measured every tick and would be double-counted.
        const interiorGapBlocks = doScan
            ? gaps.reduce((sum, g) => sum + (Number(g.gapSize) || 0), 0)
            : (Number(state.interiorGapBlocks) || 0);
        const knownGapBlocks =
            interiorGapBlocks +
            edgeGaps.reduce((sum, g) => sum + (Number(g.gapSize) || 0), 0);
        const chainStatus = deriveIndexStatus({
            initialized,
            backfillComplete,
            knownGapBlocks,
            retryableFailures: failCounts.retrying,
            permanentFailures: failCounts.permanent
        });
        db.setSyncState('chain_index', {
            initialized, headSeen, latestScannedBlock, oldestScannedBlock, backfillCursor, backfillComplete,
            lastSync: Date.now(),
            status: chainStatus,
            // Surfaced by /api/blocks and /api/events so a hole is visible in
            // the product, not only to whoever runs tools/index-health.mjs.
            knownGapBlocks,
            // F-046: gaps we have given up attempting for now (the RPC cannot
            // serve them — usually a pruned, non-archive node). Without this,
            // "Repairing" is indistinguishable from "Repairing, but stuck and
            // not going to finish", which is the F-004 problem restated.
            gapsExhausted,
            // Persisted so a tick that skipped the throttled window scan can
            // carry the last real measurement forward instead of reporting 0.
            interiorGapBlocks,
            retryableFailures: failCounts.retrying,
            permanentFailures: failCounts.permanent,
            detail: describeIndexStatus({
                knownGapBlocks,
                retryableFailures: failCounts.retrying,
                permanentFailures: failCounts.permanent
            }) || undefined
        });
        if (gaps.length || edgeGaps.length || !backfillComplete || failCounts.retrying || failCounts.permanent) {
            // Both watermarks, because the gap between them IS the diagnosis:
            // `reached` is how far the forward pass got, `verified` is how far
            // we can honestly claim completeness. reached >> verified means a
            // hole is pinning the watermark, and `missing`/`retryable` say
            // which. One number could never show that.
            console.log(`[chain-index] head=${head} reached=${oldestScannedBlock}-${headSeen} verified=${latestScannedBlock} (${db.countBlocks()} blocks), backfill=${backfillComplete ? 'complete' : 'in progress'}, status=${chainStatus}, missing=${knownGapBlocks}, retryable=${failCounts.retrying}, permanent=${failCounts.permanent}`);
        }
    } catch (err) {
        logSyncError('Chain index sync', err);
        db.setSyncState('chain_index', { ...db.getSyncState('chain_index'), status: 'Error', error: err && err.message ? err.message : String(err) });
        noteSyncError('chain_index');
    } finally {
        isSyncingChain = false;
    }
}

// Audit F-141 — DELETED: `syncBlocks()` lived here and `syncEvents()` lived
// just below syncTransactions. Both were tip-walking crawlers that stopped at
// the first already-indexed block, and both were superseded by syncChainIndex
// (one derive.chain.getBlock per block, yielding blocks AND events, with a
// gap queue instead of a silent early break). Nothing has called either since
// that replacement landed; they were reachable only by editing this file.
//
// They are deleted rather than left in place because they were not inert. Each
// was the ONLY writer of the sync-state keys 'blocks' and 'events', and each
// wrote `status: 'Synced'` unconditionally at the end of its 50-block walk. If
// anyone re-armed them — a stray call in startIndexerLoops, a merge that
// resurrected the old on-connect kick — they would race syncChainIndex for the
// SQLite write lock, re-insert rows the combined indexer already owns, and
// stamp a fossilised 'Synced' onto keys that /api/blocks and /api/events were
// only just repointed away from (audit F-020). "Dead code that writes" is the
// dangerous kind: the cost of keeping it is a second, worse indexer one call
// site away from being live.
//
// If a standalone tip crawler is ever wanted again, write it against the gap
// queue and give it its own sync-state key — do not restore this one.

async function syncTransactions() {
    if (isSyncingTx || !isRpcReady() || inBackoff('transactions')) return;
    isSyncingTx = true;
    try {
        const state = db.getSyncState('transactions');
        const latestHeader = await globalApi.rpc.chain.getHeader();
        const latestBlock = latestHeader.number.toNumber();
        const latestScannedBlock = Number(state.latestScannedBlock) || 0;
        const needsInitialCrawl = latestScannedBlock === 0 || state.scannerVersion !== FINANCIAL_TX_SCANNER_VERSION;
        const previousScannedBlocks = Number(state.scannedBlocks) || 0;
        let scan = { transactions: [], scannedBlocks: 0, oldestScannedBlock: Number(state.oldestScannedBlock) || 0 };

        db.setSyncState('transactions', { ...state, status: 'Syncing' });

        if (needsInitialCrawl) {
            scan = await scanFinancialTransactions({
                startBlock: latestBlock,
                limit: Number.MAX_SAFE_INTEGER,
                maxBlocks: TX_INITIAL_SCAN_BLOCKS,
                onProgress: progress => { db.insertTransactions(progress.transactions); }
            });
        } else if (latestBlock > latestScannedBlock) {
            scan = await scanFinancialTransactions({
                startBlock: latestBlock,
                stopBlock: latestScannedBlock + 1,
                limit: Number.MAX_SAFE_INTEGER,
                maxBlocks: latestBlock - latestScannedBlock
            });
        }

        db.insertTransactions(scan.transactions);

        // GAP-FILL PASS — same recovery pattern as the staking-rewards
        // and governance indexers. Pop oldest failures, retry each via
        // scanBlockForTransactions, clear on success.
        const txFailures = db.getScanFailures('transactions', SCAN_GAP_FILL_BATCH, SCAN_MAX_ATTEMPTS);
        if (txFailures.length) {
            const recoveredTx = [];
            let recovered = 0;
            let stillFailing = 0;
            for (const f of txFailures) {
                const r = await scanBlockForTransactions(f.block);
                if (r.ok) {
                    for (const t of r.transactions) recoveredTx.push(t);
                    db.clearScanFailure('transactions', f.block);
                    recovered++;
                } else {
                    stillFailing++;
                }
            }
            if (recoveredTx.length) db.insertTransactions(recoveredTx);
            const stats = db.countScanFailures('transactions', SCAN_MAX_ATTEMPTS);
            console.log(`[transactions] gap-fill: ${recovered} recovered, ${stillFailing} still failing (${stats.retrying} retrying / ${stats.permanent} permanent in queue)`);
        }

        // ── F-008: BACKFILL PASS — walk the rest of history, genesis-ward ──
        //
        // The finding: this indexer crawled a ~20k-block window once, then
        // stored `status: 'Synced'` forever after, while account histories,
        // the volume KPI and the analytics series silently omitted everything
        // older (~94 days of coverage on the live database against 4+ years
        // of chain). "Synced" was the same word F-004 was misusing.
        //
        // The pass derives transfers from the LOCAL events table — zero RPC —
        // because the chain indexer already backfilled events to genesis.
        // Exactly what the operator script (backfill-transactions-from-
        // events.mjs) does, sharing lib/tx-from-event.js, but resumable and
        // automatic instead of a command someone has to know to run. Where
        // events are missing (F-006 undecodable rows) nothing is derivable —
        // the chain_index failure queue owns repairing those, and this cursor
        // must not stall waiting for them.
        let txBackfillCursor = Number.isFinite(Number(state.txBackfillCursor))
            ? Number(state.txBackfillCursor)
            : null;
        let txBackfillComplete = !!state.txBackfillComplete;
        // The version bump forces an initial re-crawl; taking min() keeps the
        // previously earned coverage record instead of resetting it to
        // head-20k (which would have re-broken F-008's bookkeeping).
        let oldestScannedBlock = needsInitialCrawl
            ? Math.min(scan.oldestScannedBlock || Infinity, Number(state.oldestScannedBlock) || Infinity)
            : (Number(state.oldestScannedBlock) || latestScannedBlock);
        if (!Number.isFinite(oldestScannedBlock)) oldestScannedBlock = latestBlock;

        if (txBackfillCursor === null && !txBackfillComplete) {
            // First run of the backfill: start just below the live coverage.
            txBackfillCursor = Math.max(TX_MIN_BLOCK - 1, oldestScannedBlock - 1);
            txBackfillComplete = txBackfillCursor < TX_MIN_BLOCK;
        }

        // The cursor must never outrun the EVENTS table's own coverage. On the
        // production database events reach genesis, so this floor is 1 and the
        // gate is invisible — but on a fresh install this local derivation
        // (5000 blocks/tick, zero RPC) laps the RPC-bound events backfill by
        // orders of magnitude. Ungated, it would stride through empty ranges,
        // find nothing, declare itself complete, and report Synced over a
        // near-empty transfer history — the exact lie F-008 is about, rebuilt
        // by its own fix. The batch review caught this. Chain_index's
        // backfillCursor is the next height IT will scan going down, so
        // everything ABOVE it holds events.
        const chainIdxState = db.getSyncState('chain_index');
        const eventsFloor = chainIdxState.backfillComplete
            ? TX_MIN_BLOCK
            : (Number.isFinite(Number(chainIdxState.backfillCursor))
                ? Number(chainIdxState.backfillCursor) + 1
                : Infinity);

        if (!txBackfillComplete && txBackfillCursor >= TX_MIN_BLOCK && txBackfillCursor >= eventsFloor) {
            const lo = Math.max(TX_MIN_BLOCK, eventsFloor, txBackfillCursor - TX_BACKFILL_CHUNK + 1);
            deriveTransactionsFromLocalEvents(lo, txBackfillCursor);
            oldestScannedBlock = Math.min(oldestScannedBlock, lo);
            txBackfillCursor = lo - 1;
            // Completion is only reachable when eventsFloor itself is
            // TX_MIN_BLOCK (events reach genesis) — otherwise `lo` bottoms out
            // at the floor and the cursor waits there for events to catch up.
            if (txBackfillCursor < TX_MIN_BLOCK) {
                txBackfillComplete = true;
                console.log('[transactions] backfill complete — event-derived transfer history now reaches genesis');
            }
        }

        // ── Honest status (the F-008 close test) ──
        // 'Synced' now means what it says: the live window is current AND the
        // genesis-ward walk has finished. Until then this reports Backfilling
        // (or Repairing/Degraded when the failure queue says so), the same
        // vocabulary the chain indexer adopted for F-004/F-050.
        const txFailCounts = db.countScanFailures('transactions', SCAN_MAX_ATTEMPTS);
        const txStatus = deriveIndexStatus({
            initialized: true,
            backfillComplete: txBackfillComplete,
            knownGapBlocks: 0,
            retryableFailures: txFailCounts.retrying,
            permanentFailures: txFailCounts.permanent
        });

        db.setSyncState('transactions', {
            lastSync: Date.now(),
            status: txStatus,
            latestScannedBlock: latestBlock,
            oldestScannedBlock,
            txBackfillCursor,
            txBackfillComplete,
            scannedBlocks: previousScannedBlocks + scan.scannedBlocks,
            scannerVersion: FINANCIAL_TX_SCANNER_VERSION,
            detail: describeIndexStatus({
                knownGapBlocks: 0,
                retryableFailures: txFailCounts.retrying,
                permanentFailures: txFailCounts.permanent
            }) || (txBackfillComplete ? undefined : `deriving historical transfers, next chunk ends at block ${txBackfillCursor}`)
        });
    } catch (err) {
        console.error("Transaction sync error:", err);
        db.setSyncState('transactions', { ...db.getSyncState('transactions'), status: 'Error', error: err.message });
        noteSyncError('transactions');
    } finally { isSyncingTx = false; }
}

// Audit F-141 — DELETED: `syncEvents()` lived here. See the tombstone above
// syncTransactions for why the pair is gone rather than merely uncalled. The
// specific hazard for this half: it decoded events with `record.event.data
// .toHuman()` and wrote `status: 'success'` for anything that was not
// system.ExtrinsicFailed, including the null/undecodable records that audit
// F-006 taught scanEventsAtBlock to reject. Restoring it would quietly
// reintroduce that mislabelling on top of the write-lock contention.

// --- STAKING REWARDS INDEXER ---
// Indexes claimed staking payouts by scanning blocks for staking.Rewarded
// (and legacy staking.Reward) events. Each crawl appends newly discovered
// rewards to a per-address local index, building a full history over time.

// Parse a staking reward event into { stash, amount } or null.
function parseRewardedEvent(record) {
    const event = record.event;
    if (event.section !== 'staking') return null;
    if (event.method !== 'Rewarded' && event.method !== 'Reward') return null;

    const data = event.data;
    const names = data.names || null;
    let stash = null;
    let amount = null;

    if (names && names.length === data.length) {
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            if (stash === null && (name === 'stash' || name === 'account' || name === 'who' || name === 'validatorStash')) {
                stash = data[i].toString();
            }
            if (name === 'amount' || name === 'value') amount = data[i];
        }
    }
    // Positional fallback for runtimes that emit unnamed event fields.
    if (stash === null && data.length >= 1) stash = data[0].toString();
    if (amount === null && data.length >= 2) amount = data[data.length - 1];
    if (stash === null || amount === null) return null;

    return { stash, amount: balanceToPDEX(amount) };
}

// Best-effort extraction of { era, validator } from a call, following
// utility.batch* and proxy.proxy wrappers around staking.payoutStakers.
function findPayoutInfo(call, depth = 0) {
    if (!call || depth > 4) return { era: null, validator: null };
    const section = call.section;
    const method = call.method;

    if (section === 'staking' && (method === 'payoutStakers' || method === 'payoutStakersByPage')) {
        const args = call.args || [];
        const validator = args[0] != null ? args[0].toString() : null;
        let era = null;
        if (args[1] != null) {
            const parsed = Number(args[1].toString());
            if (Number.isFinite(parsed)) era = parsed;
        }
        return { era, validator };
    }
    if (section === 'utility' && ['batch', 'batchAll', 'forceBatch'].includes(method)) {
        const inner = call.args && call.args[0];
        if (inner && inner.length) {
            // Descriptor per TOP-LEVEL item, positions preserved, so
            // attributeBatchRewards can map utility.ItemCompleted delimiters
            // back to the item that produced each Rewarded event (F-002).
            const items = Array.from(inner).map(sub => findPayoutInfo(sub, depth + 1));
            const firstPayout = items.find(i => i.era != null);
            if (firstPayout) {
                return {
                    // Fallbacks for the single-item case and for callers that
                    // don't do per-item attribution.
                    era: firstPayout.era,
                    validator: items.length === 1 ? firstPayout.validator : null,
                    // `items` is offered ONLY when every top-level item is a
                    // direct payoutStakers call. A nested batch or a proxy
                    // wrapper emits its own ItemCompleted events, so counting
                    // delimiters would file a reward under the wrong validator
                    // — see lib/reward-attribution.js. Withholding `items`
                    // makes the caller fall back to the conservative null.
                    items: isAttributableBatch(inner) ? items : undefined
                };
            }
        }
        return { era: null, validator: null };
    }
    if (section === 'proxy' && method === 'proxy' && call.args && call.args.length >= 3) {
        return findPayoutInfo(call.args[2], depth + 1);
    }
    return { era: null, validator: null };
}

function extractPayoutInfo(extrinsic) {
    if (!extrinsic || !extrinsic.method) return { era: null, validator: null };
    try { return findPayoutInfo(extrinsic.method); }
    catch (e) { return { era: null, validator: null }; }
}

// Scan a single block for reward events.
//
// Returns: { rewards: Array<RewardRow>, ok: boolean }
//   ok=true  — scan completed cleanly (rewards may be empty if no payouts
//              happened in this block, which is the common case)
//   ok=false — scan threw and we recorded the failure in scan_failures;
//              rewards is always [] in that case
// The two-field return lets the gap-fill phase distinguish a successful
// "no events" scan (clear the failure row) from another failure (leave the
// row so the attempts counter that recordScanFailure just bumped sticks).
async function scanBlockForRewards(blockNumber) {
    try {
        const blockHash = await getBlockHashCached(blockNumber);
        // Use the block's OWN runtime metadata for decoding — see getEventsAtBlock
        // for why. A null return means the block's events can't be decoded
        // even with historical metadata (typically because the archive node
        // has pruned that block's state); we skip the block silently in that
        // case rather than letting the library spew its bytes-dump error.
        const events = await getEventsAtBlock(blockHash);
        // Audit F-006 (round 2). This used to return ok:true — "a clean no-rewards
        // scan so the gap-fill phase doesn't keep retrying a permanently
        // un-decodable historical block". The reasoning is right for a pruned
        // node and wrong everywhere else: on an archive node a null here is a
        // transient decode failure, and calling it clean discards every payout
        // in the block and advances the watermark past it. A nominator's total
        // is quietly short and nothing records that a height was skipped.
        //
        // EVENTS_STRICT=0 keeps the original behaviour for genuinely pruned
        // nodes, which is the case the old comment was actually describing.
        if (!events) {
            if (!EVENTS_STRICT) return { rewards: [], ok: true };
            db.recordScanFailure('staking_rewards', blockNumber,
                'events could not be decoded at this height (F-006)');
            return { rewards: [], ok: false };
        }

        const hits = [];
        events.forEach((record, eventIndex) => {
            const parsed = parseRewardedEvent(record);
            if (parsed) hits.push({ record, parsed, eventIndex });
        });
        if (hits.length === 0) return { rewards: [], ok: true };

        // Only fetch the full block (for era/validator context) when the block
        // actually contains payouts — most blocks do not.
        const [signedBlock, timestamp] = await Promise.all([
            getBlockCached(blockHash),
            getBlockTimestampAt(blockHash)
        ]);
        // F-114: a reward row is what a nominator reconciles their earnings
        // against. Stamping it with wall-clock time because the timestamp read
        // failed puts a payout in the wrong tax year.
        if (timestamp === null) {
            db.recordScanFailure('staking_rewards', blockNumber,
                'block timestamp unavailable at this height (F-114)');
            return { rewards: [], ok: false };
        }
        const blockHashHex = blockHash.toHex();

        // Per-extrinsic caches. A block with a 30-call batch produces dozens of
        // Rewarded events from ONE extrinsic; decode and walk it once.
        const payoutInfoByExtrinsic = new Map();
        const attributionByExtrinsic = new Map();

        const payoutInfoFor = (exIndex) => {
            if (!payoutInfoByExtrinsic.has(exIndex)) {
                payoutInfoByExtrinsic.set(exIndex, extractPayoutInfo(signedBlock.block.extrinsics[exIndex]));
            }
            return payoutInfoByExtrinsic.get(exIndex);
        };

        // F-002: map each Rewarded event of a MULTI-item batch back to the
        // batch item that emitted it, using utility's ItemCompleted /
        // ItemFailed delimiters. Returns null when there is nothing to
        // disambiguate (single payout, or not a batch at all).
        const attributionFor = (exIndex) => {
            if (attributionByExtrinsic.has(exIndex)) return attributionByExtrinsic.get(exIndex);
            const info = payoutInfoFor(exIndex);
            let map = null;
            if (info && Array.isArray(info.items) && info.items.length > 1) {
                const sequence = [];
                events.forEach((rec, idx) => {
                    if (!rec.phase.isApplyExtrinsic) return;
                    if (rec.phase.asApplyExtrinsic.toNumber() !== exIndex) return;
                    if (isBatchDelimiter(rec.event.section, rec.event.method)) {
                        sequence.push({ kind: 'delimiter' });
                    } else if (parseRewardedEvent(rec)) {
                        sequence.push({ kind: 'reward', ref: idx });
                    }
                });
                map = attributeBatchRewards(info.items, sequence);
            }
            attributionByExtrinsic.set(exIndex, map);
            return map;
        };

        const rewards = hits.map(({ record, parsed, eventIndex }) => {
            let era = null;
            let validator = null;
            if (record.phase.isApplyExtrinsic) {
                const exIndex = record.phase.asApplyExtrinsic.toNumber();
                const info = payoutInfoFor(exIndex);
                era = info.era;
                validator = info.validator;
                const attributed = attributionFor(exIndex);
                const perItem = attributed && attributed.get(eventIndex);
                if (perItem) {
                    if (perItem.era != null) era = perItem.era;
                    if (perItem.validator) validator = perItem.validator;
                }
            }
            return {
                stash: parsed.stash,
                amount: parsed.amount,
                era,
                validator,
                block: blockNumber,
                blockHash: blockHashHex,
                eventIndex,
                timestamp
            };
        });
        return { rewards, ok: true };
    } catch (err) {
        const short = shortErrorMessage(err);
        // Transport failure ≠ bad block (see lib/rpc-errors.js).
        if (isRpcUnavailableError(err)) {
            console.warn(`Staking rewards scan deferred block ${blockNumber} (node unavailable, attempt not counted): ${short}`);
            return { rewards: [], ok: false, transient: true };
        }
        console.warn(`Staking rewards scan skipped block ${blockNumber}: ${short}`);
        db.recordScanFailure('staking_rewards', blockNumber, short);
        return { rewards: [], ok: false };
    }
}

// Scan a descending block range in concurrent batches.
async function scanStakingRewards({ startBlock, stopBlock, maxBlocks }) {
    const rewards = [];
    let scannedBlocks = 0;
    let oldestScannedBlock = startBlock;

    for (let nextBlock = startBlock; nextBlock >= stopBlock && scannedBlocks < maxBlocks;) {
        const blockNumbers = [];
        while (nextBlock >= stopBlock && blockNumbers.length < STAKING_REWARDS_SCAN_BATCH && scannedBlocks + blockNumbers.length < maxBlocks) {
            blockNumbers.push(nextBlock);
            nextBlock--;
        }
        if (blockNumbers.length === 0) break;

        const batchResults = await Promise.all(blockNumbers.map(scanBlockForRewards));
        scannedBlocks += blockNumbers.length;
        oldestScannedBlock = blockNumbers[blockNumbers.length - 1];
        for (const result of batchResults) {
            // scanBlockForRewards returns { rewards, ok } now (see its
            // docstring). Failures are already recorded in scan_failures
            // by the scanner's catch — we just collect the successful
            // rewards here.
            for (const reward of result.rewards) rewards.push(reward);
        }
    }
    return { rewards, scannedBlocks, oldestScannedBlock };
}

// Map a scanned reward into a SQLite row with normalized addresses.
function toRewardRow(reward) {
    let stash = reward.stash;
    let validator = reward.validator;
    try { stash = normalizeAddress(reward.stash); } catch (e) { }
    if (validator) { try { validator = normalizeAddress(validator); } catch (e) { } }
    return {
        // F-021 — same identity rule as transactions.
        id: rewardId(reward.blockHash, reward.block, reward.eventIndex),
        stash,
        amount: reward.amount,
        era: reward.era,
        validator: validator || null,
        block: reward.block,
        blockHash: reward.blockHash,
        eventIndex: reward.eventIndex,
        timestamp: reward.timestamp
    };
}

// Compute a stash's unpaid (unclaimed) rewards on demand via the staking
// derive and cache them in SQLite. Runs in the background, guarded per stash.
async function recomputeUnclaimed(stash) {
    if (computingUnclaimed.has(stash) || !globalApi) return;
    computingUnclaimed.add(stash);
    try {
        if (!globalApi.derive || !globalApi.derive.staking || !globalApi.derive.staking.stakerRewards) {
            db.replaceUnclaimed(stash, []);
            return;
        }
        const pending = await globalApi.derive.staking.stakerRewards(stash, false);
        // Same reconciliation rules the endpoint applies at read time
        // (lib/reward-dedup.js) so the cache and the response can't disagree.
        const claimedIndex = buildClaimedIndex(db.getClaimedRewardKeys(stash));
        const rows = [];
        for (const entry of pending) {
            const era = entry.era && entry.era.toNumber ? entry.era.toNumber() : Number(entry.era);
            const validators = entry.validators || {};
            for (const validatorId of Object.keys(validators)) {
                const info = validators[validatorId];
                const amount = balanceToPDEX(info.value);
                if (!(amount > 0)) continue;
                let validator = validatorId;
                try { validator = normalizeAddress(validatorId); } catch (e) { }
                // Skip anything already recorded as a claimed payout.
                if (claimedIndex.unattributedEras.has(era)) continue;
                if (claimedIndex.exact.has(claimedRewardKey(era, validator))) continue;
                rows.push({ era, validator, amount });
            }
        }
        db.replaceUnclaimed(stash, rows);
        console.log(`Unclaimed rewards computed for ${stash}: ${rows.length} pending entries.`);
    } catch (err) {
        console.warn(`Unclaimed rewards computation failed for ${stash}:`, err.message);
    } finally {
        computingUnclaimed.delete(stash);
    }
}

// --- Price sync providers --------------------------------------------------
// Every provider returns the same shape so the rest of the codebase doesn't
// need to know which upstream produced a given row: { price, marketCap,
// volume24h, pctChange24h }. price_history rows store exactly these fields
// plus the source tag. The chart builds up from a one-time CoinGecko backfill
// (everything before today) plus forward-going AscendEX + CMC polls (today
// onwards). When CMC re-lists PDEX post-mainnet, its rows will start flowing
// in alongside AscendEX without any code change.
async function fetchCmcQuote() {
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(CMC_SYMBOL)}&convert=USD`;
    const resp = await fetch(url, { headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, 'Accept': 'application/json' } });
    if (!resp.ok) throw new Error(`CoinMarketCap HTTP ${resp.status}`);
    const json = await resp.json();
    const entry = json && json.data && json.data[CMC_SYMBOL];
    const quote = entry ? (Array.isArray(entry) ? entry[0] : entry) : null;
    const usd = quote && quote.quote && quote.quote.USD;
    if (!usd || typeof usd.price !== 'number') throw new Error('CoinMarketCap response missing price');
    return {
        price: usd.price,
        marketCap: usd.market_cap ?? null,
        volume24h: usd.volume_24h ?? null,
        pctChange24h: usd.percent_change_24h ?? null,
    };
}

// CoinGecko simple/price — keyless public API that aggregates PDEX across its
// real markets. One call returns price + market cap + 24h volume + 24h change.
// A free "demo" key (COINGECKO_API_KEY) raises rate limits but isn't required
// at the explorer's 10-min cadence. USD is already fiat, no oracle needed.
async function fetchCoinGeckoQuote() {
    const params = new URLSearchParams({
        ids: COINGECKO_ID,
        vs_currencies: 'usd',
        include_market_cap: 'true',
        include_24hr_vol: 'true',
        include_24hr_change: 'true',
    });
    const url = `https://api.coingecko.com/api/v3/simple/price?${params.toString()}`;
    const headers = { Accept: 'application/json' };
    if (COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = COINGECKO_API_KEY;
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
    const json = await resp.json();
    const d = json && json[COINGECKO_ID];
    if (!d || typeof d.usd !== 'number' || !(d.usd > 0)) {
        throw new Error(`CoinGecko response missing a valid price for id '${COINGECKO_ID}'`);
    }
    return {
        price: d.usd,
        marketCap: Number.isFinite(d.usd_market_cap) ? d.usd_market_cap : null,
        volume24h: Number.isFinite(d.usd_24h_vol) ? d.usd_24h_vol : null,
        pctChange24h: Number.isFinite(d.usd_24h_change) ? d.usd_24h_change : null,
    };
}

// Per-provider deterministic offset (in ms) so when two providers' fetchers
// race to the same wall-clock millisecond, their rows don't collide on the
// price_history(timestamp) primary key. The offset is below visual resolution
// on any chart and avoids a destructive schema migration to a composite PK.
// Treat backfill rows as authoritative (offset 0) so daily-granularity
// CoinGecko timestamps sit cleanly at midnight UTC.
const PRICE_PROVIDER_TS_OFFSET = { 'defillama-backfill': 0, 'ascendex': 1, 'cmc': 2, 'coingecko': 3 };

// Poll one provider and append one row to price_history tagged with its
// source. Records per-provider sync state under `price:<provider>` so the
// UI can show "AscendEX healthy / CMC degraded" rather than collapsing both
// into a single status.
async function syncPriceProvider(name, fetchFn) {
    if (!isPriceProviderConfigured(name)) return;
    try {
        const quote = await fetchFn();
        db.insertPrice({
            timestamp: Date.now() + (PRICE_PROVIDER_TS_OFFSET[name] || 0),
            price: quote.price,
            marketCap: quote.marketCap,
            volume24h: quote.volume24h,
            pctChange24h: quote.pctChange24h,
            source: name,
        });
        db.setSyncState(`price:${name}`, { lastSync: Date.now(), status: 'Synced' });
    } catch (err) {
        console.warn(`Price sync error (${name}):`, err.message);
        db.setSyncState(`price:${name}`, { ...db.getSyncState(`price:${name}`), lastSync: Date.now(), status: 'Error', error: err.message });
    }
}

// Fans out to every configured provider in parallel. The single `isSyncingPrice`
// reentrancy guard still applies — if a previous tick is mid-flight, skip.
async function syncPrice() {
    if (isSyncingPrice) return;
    isSyncingPrice = true;
    try {
        const jobs = [];
        if (isPriceProviderEnabled('coingecko')) jobs.push(syncPriceProvider('coingecko', fetchCoinGeckoQuote));
        if (isPriceProviderEnabled('cmc'))       jobs.push(syncPriceProvider('cmc', fetchCmcQuote));
        await Promise.allSettled(jobs);
        // Roll-up state for the legacy /api/price-latest "status" string:
        // success if ANY enabled provider succeeded this tick, error if ALL failed.
        const anyOk = PRICE_PROVIDERS.some(p => db.getSyncState(`price:${p}`).status === 'Synced');
        db.setSyncState('price', { lastSync: Date.now(), status: anyOk ? 'Synced' : 'Error' });
    } finally {
        isSyncingPrice = false;
    }
}

// Historical price rows: the indexer only polls FORWARD. Rows older than the
// first poll on a given database were imported ad-hoc and carry the
// 'defillama-backfill' / 'ascendex-backfill' source tags.
//
// Audit F-025: this comment (and README + INSTALL) used to point at a
// standalone `backfill-price-history.mjs` "at the repo root". No such file
// exists — an operator following INSTALL got `Cannot find module`. A fresh
// deployment builds its chart from the first poll onward, so long ranges like
// /api/price-history?days=365 stay sparse for a while. Nothing else depends on
// those rows; if the sparse chart is worth fixing, the script has to be written
// first, and it needs adding to Dockerfile.backend's explicit COPY list.

// One crawl pass: index new blocks (forward) and walk a resumable chunk of
// older history (backfill). Runs once per interval and appends every time.
async function syncStakingRewards() {
    if (isSyncingStakingRewards || !isRpcReady() || inBackoff('staking_rewards')) return;
    isSyncingStakingRewards = true;
    try {
        const state = db.getSyncState('staking_rewards');
        const latestHeader = await globalApi.rpc.chain.getHeader();
        const head = latestHeader.number.toNumber();

        let initialized = !!state.initialized;
        // Audit F-009 (round 2) — same split as chain_index. `headSeen` is how
        // far forward we have reached; `latestScannedBlock` is derived at the
        // end of the tick and means "no known hole at or below here". Under
        // staking the stakes are specific: a skipped height is a missing
        // `Rewarded` event, so a watermark that jumps past it understates what
        // a nominator earned and there is nothing on the page to suggest the
        // number is incomplete.
        let headSeen = readHeadSeen(state);
        let oldestScannedBlock = Number(state.oldestScannedBlock) || 0;
        let backfillCursor = Number(state.backfillCursor) || 0;
        let backfillComplete = !!state.backfillComplete;

        // First run: anchor watermarks just BELOW the current head so the
        // forward pass actually scans it (audit F-048 — anchoring AT head
        // marked the head block scanned without ever fetching it, losing any
        // reward events in it permanently).
        if (!initialized) {
            initialized = true;
            headSeen = head - 1;
            oldestScannedBlock = head;
            backfillCursor = head - 1;
            backfillComplete = (head - 1) < STAKING_REWARDS_MIN_BLOCK;
        }

        // FORWARD PASS — index blocks produced since the previous crawl.
        if (head > headSeen) {
            if (head - headSeen > STAKING_REWARDS_FORWARD_MAX) {
                console.warn(`Staking rewards: forward gap ${head - headSeen} exceeds cap; scanning most recent ${STAKING_REWARDS_FORWARD_MAX} blocks.`);
            }
            const forward = await scanStakingRewards({
                startBlock: head,
                stopBlock: headSeen + 1,
                maxBlocks: STAKING_REWARDS_FORWARD_MAX
            });
            db.insertStakingRewards(forward.rewards.map(toRewardRow));
            // Audit F-009: the warning above told the log that blocks were
            // being dropped and then dropped them anyway. Round 1 recorded the
            // unattempted range but still moved the watermark to head; now only
            // `headSeen` moves, so the skip actually holds the claim back.
            const rewardLowestAttempted = Math.max(headSeen + 1, head - STAKING_REWARDS_FORWARD_MAX + 1);
            if (rewardLowestAttempted > headSeen + 1) {
                const skipFrom = headSeen + 1;
                const skipTo = rewardLowestAttempted - 1;
                recordSkippedRange('staking_rewards', skipFrom, skipTo, 'forward cap: not attempted this tick');
            }
            headSeen = head;
            db.setSyncState('staking_rewards', {
                initialized, headSeen, oldestScannedBlock, backfillCursor, backfillComplete,
                latestScannedBlock: contiguousWatermark({
                    headSeen,
                    lowestOutstandingFailure: db.getLowestScanFailure('staking_rewards'),
                    floor: oldestScannedBlock
                }),
                lastSync: Date.now(), status: 'Syncing'
            });
        }

        // BACKFILL PASS — walk one resumable chunk further down the chain.
        if (!backfillComplete) {
            if (backfillCursor >= STAKING_REWARDS_MIN_BLOCK) {
                const stopBlock = Math.max(backfillCursor - STAKING_REWARDS_BACKFILL_CHUNK + 1, STAKING_REWARDS_MIN_BLOCK);
                const backfill = await scanStakingRewards({
                    startBlock: backfillCursor,
                    stopBlock,
                    maxBlocks: STAKING_REWARDS_BACKFILL_CHUNK
                });
                db.insertStakingRewards(backfill.rewards.map(toRewardRow));
                oldestScannedBlock = Math.min(oldestScannedBlock || backfillCursor, backfill.oldestScannedBlock);
                backfillCursor = backfill.oldestScannedBlock - 1;
                if (backfillCursor < STAKING_REWARDS_MIN_BLOCK) backfillComplete = true;
            } else {
                backfillComplete = true;
            }
        }

        // GAP-FILL PASS — retry blocks that errored on a previous scan.
        // Pop the SCAN_GAP_FILL_BATCH oldest entries from scan_failures and
        // re-attempt each via the same per-block scanner. On success, the
        // failure row is cleared. On another failure, recordScanFailure
        // (called from the scanner's catch block) bumps the attempts counter
        // — once a row exceeds SCAN_MAX_ATTEMPTS it falls out of the
        // getScanFailures() query and stays in the table as a permanent skip
        // for the operator to investigate by hand.
        const failures = db.getScanFailures('staking_rewards', SCAN_GAP_FILL_BATCH, SCAN_MAX_ATTEMPTS);
        if (failures.length) {
            let recovered = 0;
            let stillFailing = 0;
            for (const f of failures) {
                const retry = await scanBlockForRewards(f.block);
                db.insertStakingRewards(retry.rewards.map(toRewardRow));
                if (retry.ok) {
                    // Successful re-scan (with or without rewards) — clear
                    // the failure row so future ticks don't re-attempt.
                    db.clearScanFailure('staking_rewards', f.block);
                    recovered++;
                } else {
                    // Scanner's catch already bumped the attempts counter
                    // via recordScanFailure — leave the row in place so
                    // the next tick picks it up again (or, after attempts
                    // exceeds the cap, leaves it for operator inspection).
                    stillFailing++;
                }
            }
            const stats = db.countScanFailures('staking_rewards', SCAN_MAX_ATTEMPTS);
            console.log(`[staking_rewards] gap-fill: ${recovered} recovered, ${stillFailing} still failing (${stats.retrying} retrying / ${stats.permanent} permanent in queue)`);
        }

        // Audit F-009 (round 2). This said `status: 'Synced'` unconditionally,
        // directly below a gap-fill pass that had just logged blocks it could
        // not recover — the audit's residual verbatim: "End-of-tick status can
        // still be 'Synced' with a skip queue". A nominator reading "Synced"
        // over a hole in their payout history is being told a wrong number is
        // complete.
        const rewardLowestFailure = db.getLowestScanFailure('staking_rewards');
        const latestScannedBlock = contiguousWatermark({
            headSeen, lowestOutstandingFailure: rewardLowestFailure, floor: oldestScannedBlock
        });
        const rewardFailCounts = db.countScanFailures('staking_rewards', SCAN_MAX_ATTEMPTS);
        const rewardStatus = deriveIndexStatus({
            initialized,
            backfillComplete,
            // As above: the COUNT of queued heights, not the span they sit in.
            knownGapBlocks: rewardFailCounts.total,
            retryableFailures: rewardFailCounts.retrying,
            permanentFailures: rewardFailCounts.permanent
        });
        db.setSyncState('staking_rewards', {
            initialized, headSeen, latestScannedBlock, oldestScannedBlock, backfillCursor, backfillComplete,
            lastSync: Date.now(),
            status: rewardStatus,
            retryableFailures: rewardFailCounts.retrying,
            permanentFailures: rewardFailCounts.permanent,
            caughtUp: isCaughtUp({ headSeen, head, lowestOutstandingFailure: rewardLowestFailure }),
            detail: describeIndexStatus({
                knownGapBlocks: rewardFailCounts.total,
                retryableFailures: rewardFailCounts.retrying,
                permanentFailures: rewardFailCounts.permanent
            }) || undefined
        });
        console.log(`Staking rewards indexer: reached ${oldestScannedBlock}-${headSeen} verified ${latestScannedBlock}, ${db.countStakingRewards()} payouts indexed, status=${rewardStatus}, backfill ${backfillComplete ? 'complete' : 'in progress'}.`);
    } catch (err) {
        console.error("Staking rewards sync error:", err);
        db.setSyncState('staking_rewards', { ...db.getSyncState('staking_rewards'), status: 'Error', error: err.message });
        noteSyncError('staking_rewards');
    } finally {
        isSyncingStakingRewards = false;
    }
}

// Connect to the chain in the BACKGROUND. This must never block `start()` or
// throw out of it — otherwise an unreachable node at boot (very common right
// after a host reboot, before networking/DNS settles) would either hang the
// process before app.listen() or crash it into a restart loop. WsProvider
// keeps retrying on its own; the 'connected' handler flips rpcConnected and
// the sync loops (which gate on isRpcReady) resume automatically.
//
// In cluster mode this is called from EVERY worker — detail endpoints
// (block/tx/account/validator) query the chain directly via globalApi, and
// cluster round-robins requests across workers, so each worker needs its
// own ApiPromise. Only the indexer worker should run the database write
// loops, though, so callers pass `{ kickSyncsOnConnect: false }` for
// HTTP-only workers. The post-connect sync kicks survive in this function
// (rather than living in startIndexerLoops) because they also fire on
// every RECONNECT — a transient WS drop on the indexer worker would
// otherwise wait up to one interval tick before catching up.
async function connectRpc({ kickSyncsOnConnect = true } = {}) {
    // Wipe cached chain reads. Their values are polkadot.js codec objects
    // bound to the registry/types of the api instance we're about to
    // (re)create — keeping them across a rebuild would risk type-mismatch
    // errors on decode. Identity cache is a plain string map and survives.
    clearRpcCaches();

    // Bump the generation. Event handlers below capture `myGen` in closure;
    // when any handler fires, it compares against the current `rpcGen` and
    // bails if it's stale (i.e., a later connectRpc() has run since). This
    // prevents zombie handlers from old WsProvider/ApiPromise instances —
    // which polkadot.js's auto-reconnect can keep firing for some time after
    // we've called disconnect() — from corrupting rpcDisconnectStartedAt or
    // rpcConnected. See module-scope comment on `rpcGen`.
    const myGen = ++rpcGen;
    const isStale = () => myGen !== rpcGen;

    const wsProvider = new WsProvider(RPC_ENDPOINTS.length > 1 ? RPC_ENDPOINTS : RPC_ENDPOINTS[0], RPC_AUTO_RECONNECT_MS);
    wsProvider.on('connected', () => {
        if (isStale()) return;
        rpcConnected = true;
        // Note in the log how long the outage was, if any. Useful in postmortem.
        if (rpcDisconnectStartedAt) {
            const outageSec = Math.round((Date.now() - rpcDisconnectStartedAt) / 1000);
            console.log(`[RPC] connected to Polkadex node (after ${outageSec}s outage)`);
        } else {
            console.log('[RPC] connected to Polkadex node');
        }
        rpcDisconnectStartedAt = null;
    });
    wsProvider.on('disconnected', () => {
        if (isStale()) return;
        rpcConnected = false;
        // Stamp the moment we first noticed disconnect. Watchdog reads this.
        // Don't overwrite if already stamped — we want continuous-disconnect duration.
        if (!rpcDisconnectStartedAt) rpcDisconnectStartedAt = Date.now();
        console.warn('[RPC] disconnected — auto-reconnect every ' + RPC_AUTO_RECONNECT_MS + ' ms');
    });
    wsProvider.on('error', (err) => {
        if (isStale()) return;
        console.warn('[RPC] provider error:', err && err.message ? err.message : err);
    });

    let newApi;
    try {
        // signedExtensions: same declaration as the frontend, for a different
        // reason. The backend never signs anything, but it DECODES signed
        // extrinsics (/api/decode, block indexing). @polkadot/api 10.13.1
        // doesn't know the runtime's CheckMetadataHash extension, so it skips
        // the Mode byte when reading an extrinsic's signed extra — every field
        // after it (era, nonce, tip) is then read from the wrong offset.
        // Declaring the shape keeps decoded output faithful to the chain,
        // which is the whole point of the forensic endpoints.
        newApi = await ApiPromise.create({
            provider: wsProvider,
            signedExtensions: {
                CheckMetadataHash: {
                    extrinsic: { mode: 'u8' },
                    payload: { metadataHash: 'Option<[u8;32]>' }
                }
            }
        });
    } catch (err) {
        // ApiPromise.create only rejects on hard errors (bad metadata, etc.);
        // transient connect failures are handled by WsProvider's retry loop.
        // Either way we must not crash — log and let the provider keep trying.
        console.error('[RPC] ApiPromise.create failed; provider will keep retrying:', err && err.message ? err.message : err);
        return;
    }
    // If a newer connectRpc() ran while we were awaiting ApiPromise.create,
    // discard this one rather than overwriting the newer globalApi. Note the
    // staleness check happens BEFORE we assign to globalApi — if we'd assigned
    // first and then checked, we would have already corrupted the global with
    // our stale value.
    if (isStale()) {
        try { await newApi.disconnect(); } catch (_) { /* best effort */ }
        return;
    }
    globalApi = newApi;
    // ApiPromise also emits these on top of WsProvider — useful when a single
    // request times out and the api lib decides to flag itself disconnected
    // before the underlying socket closes.
    globalApi.on('disconnected', () => {
        if (isStale()) return;
        rpcConnected = false;
        if (!rpcDisconnectStartedAt) rpcDisconnectStartedAt = Date.now();
        console.warn('[RPC] api disconnected');
    });
    globalApi.on('connected', () => {
        if (isStale()) return;
        rpcConnected = true;
        if (rpcDisconnectStartedAt) {
            const outageSec = Math.round((Date.now() - rpcDisconnectStartedAt) / 1000);
            console.log(`[RPC] api connected (after ${outageSec}s outage)`);
            rpcDisconnectStartedAt = null;
        } else {
            console.log('[RPC] api connected');
        }
    });
    globalApi.on('error', (err) => {
        if (isStale()) return;
        console.warn('[RPC] api error:', err && err.message ? err.message : err);
    });
    rpcConnected = globalApi.isConnected;
    if (rpcConnected) rpcDisconnectStartedAt = null;
    console.log('Connected to Polkadex RPC at ' + RPC_ENDPOINTS.join(', '));
    if (globalApi.registry && globalApi.registry.chainSS58 != null) {
        chainSS58 = globalApi.registry.chainSS58;
    }
    // Kick the syncs immediately on (re)connect instead of waiting for the
    // next interval tick. Pre-warm the network-info caches too so the home
    // page's "Network Information" panel is hot the moment the chain is up.
    // (The old syncBlocks/syncEvents calls are now subsumed by syncChainIndex,
    // which does one RPC fetch per block and yields both blocks AND events.)
    //
    // Suppressed on HTTP-only workers in cluster mode — they connect to RPC
    // so detail endpoints can serve queries, but they must NOT initiate
    // writes to SQLite. The indexer worker is the single writer.
    if (kickSyncsOnConnect) {
        syncChainIndex(); syncTransactions(); syncData(); syncHolders();
        syncStakingRewards(); syncCouncil(); syncTreasury(); syncDemocracy(); syncGovernance();
        refreshNetworkInfoInBackground();
        refreshTotalUnlockingInBackground();
    }
}

// Called by syncChainIndex whenever it observes the chain's latest head. The
// number-only comparison lets us treat any advance — even by one block — as
// proof the upstream is alive. Recording it from one canonical site keeps
// the dataflow simple: we don't have to instrument every getHeader() call.
function recordChainHead(headNum) {
    if (!Number.isFinite(headNum)) return;
    if (headNum > lastHeadValue) {
        lastHeadValue = headNum;
        lastHeadAdvanceAt = Date.now();
        // Persist to shared SQLite so HTTP-only workers can read freshness
        // state in /api/network-info. Only the indexer worker writes here;
        // every worker reads. The kv has very low write rate (once per new
        // block ≈ every 12s) so this is essentially free.
        try {
            db.setKv('chain_head_state', {
                value: headNum,
                lastAdvanceAt: lastHeadAdvanceAt
            });
        } catch (e) { /* best effort — never block the indexer on a kv write */ }
        // Clear stale state if we were previously stuck.
        if (chainStaleSince) {
            const dur = Math.round((Date.now() - chainStaleSince) / 1000);
            console.log(`[CHAIN-WATCHDOG] head advanced to #${headNum} — resuming normal operation (was stale for ${dur}s)`);
            chainStaleSince = null;
            chainStaleRebuildAttempted = false;
        }
    }
}

// Chain-head freshness watchdog. Catches the silent-stall failure mode where
// the WS stays connected but the upstream node stops producing/accepting
// blocks. Triggers one api rebuild attempt in case the stall is really a
// stuck polkadot.js api; after that, just logs periodically and leaves the
// existing 30-min process.exit backstop as the ultimate fallback.
//
// The api-rebuild attempt is fired exactly once per stale episode (gated by
// chainStaleRebuildAttempted). If the chain is genuinely paused (e.g., a
// long runtime upgrade), looping rebuilds would just thrash without helping.
async function chainHeadWatchdog() {
    // Skip if the connection-level watchdog already has a different problem
    // in flight — no point stacking interventions.
    if (rpcDisconnectStartedAt || rpcResetInFlight) return;
    if (!isRpcReady()) return;

    const sinceAdvance = Date.now() - lastHeadAdvanceAt;
    if (sinceAdvance < CHAIN_HEAD_STALE_MS) return;

    // Head is stale.
    if (!chainStaleSince) {
        chainStaleSince = Date.now();
        const minutesStale = Math.round(sinceAdvance / 60000);
        console.warn(`[CHAIN-WATCHDOG] chain head #${lastHeadValue} hasn't advanced in ${minutesStale} min — upstream node may have stalled`);
        // Email the `network.chainStalled` subscribers ONCE per episode. The
        // eventId is this episode's start timestamp, so the idempotency table
        // keeps it to one message however long the stall lasts. Fire-and-forget
        // — a mail failure must not stop the watchdog from rebuilding the api
        // below, which is the part that actually fixes anything.
        dispatchChainStalledEmail({ staleSince: chainStaleSince, lastBlock: lastHeadValue, minutesStale })
            .catch(err => console.warn('[email] chain-stalled dispatch failed:', err && err.message ? err.message : err));
    }

    // One-shot api rebuild attempt per stale episode. Delegate to
    // rebuildApiOnce so the timeout protection applies (otherwise this
    // shared the same hang-forever bug the rpcWatchdog had).
    if (!chainStaleRebuildAttempted) {
        chainStaleRebuildAttempted = true;
        console.warn(`[CHAIN-WATCHDOG] forcing api rebuild in case the api itself is stuck`);
        await rebuildApiOnce(`chain-watchdog: head stale`);
    }
}

// Resilience watchdog. Runs every RPC_WATCHDOG_INTERVAL_MS (default 30s) and
// checks rpcDisconnectStartedAt. Two escalation steps:
//
//   1. > RPC_RESET_AFTER_MS (default 5 min): the WsProvider's built-in retry
//      isn't getting us back. Tear down globalApi and call connectRpc() fresh,
//      which forces polkadot.js to discard any stale subscription handles,
//      cached metadata refs, etc., and re-establish from a clean slate.
//
//   2. > RPC_EXIT_AFTER_MS (default 30 min): even rebuilding the api hasn't
//      restored service. Exit the process.
//
//      IMPORTANT (audit F-144): what that exit achieves depends on the
//      topology. With WORKERS>1 the exiting process is a cluster WORKER —
//      `cluster.on('exit')` reforks it in place (with backoff, F-145) and the
//      container never restarts, so a genuinely wedged upstream is retried by
//      a fresh worker rather than by a fresh container. Only in single-process
//      mode (WORKERS<=1), where this process IS pid 1, does the Docker
//      `restart: unless-stopped`
//      policy spin up a fresh container. Last-resort backstop that should
//      essentially never fire — but when it does, it ensures the explorer
//      doesn't sit silently broken for hours waiting for human intervention.
//
// Both thresholds are env-tunable. To disable a layer entirely, set its value
// very high (e.g. RPC_EXIT_AFTER_MS=86400000 for 24h).
async function rpcWatchdog() {
    if (rpcResetInFlight) return; // a previous reset attempt is still running

    // SAFETY: detect the "missed event" case. polkadot.js fires `disconnected`
    // events to set rpcDisconnectStartedAt and `connected` events to clear it.
    // When the WS rapidly cycles (open→close→open→close — typical when CF LB
    // routes to a sick origin that accepts TCP but immediately drops the
    // upgrade), the `connected` events transiently clear the marker even
    // though we're not actually usable. The original watchdog then sees no
    // marker → returns → and we get stuck "between reconnects" with no
    // periodic rebuild firing. This safety arms the marker from observed
    // state whenever it's missing while isRpcReady() returns false.
    if (!isRpcReady() && !rpcDisconnectStartedAt) {
        rpcDisconnectStartedAt = Date.now();
        console.warn('[RPC-WATCHDOG] missed event — WS not ready but no disconnect marker; arming from now');
    }

    if (!rpcDisconnectStartedAt) return;
    const outageMs = Date.now() - rpcDisconnectStartedAt;
    const outageMin = Math.round(outageMs / 60000);

    if (outageMs >= RPC_EXIT_AFTER_MS) {
        // Audit F-144: this used to say "so Docker restarts the container"
        // unconditionally. Under WORKERS>1 that is false — exiting a worker
        // makes the cluster PRIMARY refork it and the container never restarts,
        // so an operator following the log waits for a restart that is not
        // coming, and greps `docker events` for nothing.
        const restartPath = WORKERS > 1
            ? 'the cluster primary will refork this worker'
            : 'Docker will restart the container';
        console.error(`[RPC-WATCHDOG] disconnected for ${outageMin} min, exceeds RPC_EXIT_AFTER_MS — exiting; ${restartPath}`);
        // Flush logs synchronously before exiting. process.exit doesn't wait
        // for stdout flush by default.
        process.stderr.write('', () => process.exit(1));
        // Belt-and-braces: if write callback never fires (shouldn't happen),
        // exit anyway after a short delay.
        setTimeout(() => process.exit(1), 500);
        return;
    }

    if (outageMs >= RPC_RESET_AFTER_MS) {
        console.warn(`[RPC-WATCHDOG] disconnected for ${outageMin} min, exceeds RPC_RESET_AFTER_MS — rebuilding ApiPromise from scratch`);
        // Delegate to the shared rebuildApiOnce so the timeout protection
        // (RPC_REBUILD_TIMEOUT_MS) applies here too. Without that, an
        // ApiPromise.create() hang during a partial-LB-outage window would
        // leave rpcResetInFlight=true forever and every subsequent watchdog
        // tick would silently early-return at the guard. That was the bug
        // causing "explorer doesn't recover after disconnect even though
        // both origins are reachable".
        await rebuildApiOnce(`watchdog: disconnected ${outageMin} min`);
    }
}

// ---- Per-worker init -------------------------------------------------------
// Every worker (or the single process in non-clustered mode) opens its own
// SQLite handle and its own RPC WebSocket. Only the HTTP workers bind a
// listener on PORT — a clustered indexer worker does not (audit F-156); see
// `serveHttp` below. node:cluster shares the listening socket across the
// workers that do listen, round-robin-balancing inbound connections. Each
// worker's globalApi/rpcConnected pair is process-local; the indexer worker is
// the sole BULK writer to SQLite, though not the only one — HTTP workers write
// sessions, posts, votes, subscriptions and rate-limit counters, which is what
// F-089 corrected the busy_timeout for.
// `clustered` tells initDb whether another process is going to apply the schema.
// It is NOT the same question as `indexer`: a single-process run with
// INDEXER_ROLE=off has no indexer AND no other worker, so it must do its own DDL
// immediately rather than wait SCHEMA_WAIT_MS for a migrator that will never
// exist (audit F-139).
function runWorker({ indexer, clustered = false }) {
    // Audit F-022: a failed initDb must be FATAL. The old code logged and
    // carried on — the worker still called app.listen, nginx saw a healthy
    // backend, every SQLite route threw, and chain writes silently stopped
    // while the site "looked up". Serving HTTP without a database is worse
    // than being down: compose (`restart: unless-stopped`) can only restart
    // a process that exits. Exit non-zero; if the DB path is truly wedged
    // (corrupt file, unwritable bind mount) the crash loop is visible in
    // `docker ps` instead of hidden behind a listening socket.
    try {
        // Only the indexer worker seeds the O(1) row counters — it's the sole
        // writer, and seeding does a one-time COUNT(*) we don't want N workers
        // each repeating on a 20 GB+ database at startup. Audit F-139 gives that
        // same worker the schema-migrator role: it applies the DDL, the other
        // workers wait for its marker instead of racing it for the write lock.
        // If the wait times out they apply the DDL themselves rather than fail —
        // an HTTP worker must never refuse to start because the indexer is slow.
        // Audit F-181 (round 2): F-022's fail-fast was an OVER-CORRECTION.
        //
        // Dying on a bad path or a corrupt file is right. Dying on SQLITE_BUSY
        // is not: the indexer takes the write lock for the hash-id migration,
        // another worker's 5s busy_timeout expires, this catch calls exit(1),
        // the primary reforks it with F-145's 30s backoff, and the replacement
        // hits the same lock. Indexing stops until a quiet window happens to
        // appear, while /api/blocks keeps serving yesterday's rows and every
        // health signal reads fine.
        //
        // Retry the contended failures; keep exiting on the structural ones.
        retryTransient(
            () => db.initDb(DATA_DIR, !!indexer, { awaitMigrator: !indexer && !!clustered }),
            {
                attempts: 8, baseDelayMs: 750, maxDelayMs: 10_000,
                onRetry: (err, attempt, delay) => console.warn(
                    `[db] init hit a transient lock (attempt ${attempt}/8), retrying in ${delay}ms:`,
                    err && err.message ? err.message : err)
            }
        );
    } catch (err) {
        // Structural, or transient that outlasted every retry. Either way the
        // supervisor gets a clean restart rather than a half-initialised worker.
        console.error('FATAL: database init failed at ' + DATA_DIR + ' — exiting so the supervisor restarts us:', err && err.message ? err.message : err);
        process.exit(1);
    }

    // Every worker opens its own chain WebSocket because the detail endpoints
    // (block/tx/account/validator/search) call into globalApi directly and
    // cluster round-robins those requests across all workers. Without this,
    // ~(N-1)/N of detail-page requests in an N-worker setup return 503
    // RPC_NOT_READY because the worker has no globalApi to query.
    //
    // `kickSyncsOnConnect` decides whether this worker, on (re)connect,
    // also kicks the chain-index / staking-rewards / governance write loops.
    // Only the indexer worker should — multiple workers writing the same
    // SQLite file would still be SAFE (WAL serializes writes) but would waste
    // RPC bandwidth and produce duplicate work.
    connectRpc({ kickSyncsOnConnect: !!indexer })
        .catch(err => console.error('[RPC] connect bootstrap error:', err && err.message ? err.message : err));

    // HTTP serving vs indexing isolation. node:sqlite is SYNCHRONOUS, so the
    // indexer's heavy passes (backfill scans, aggregate pre-warms, bulk inserts,
    // one-time index builds) block the event loop for their entire duration. If
    // the indexer worker also served user requests, any request cluster
    // round-robined to it during a heavy pass would stall — often long enough to
    // trip the nginx/Cloudflare gateway timeout (the 504s seen on data-heavy
    // pages like /treasury). So in clustered mode we keep the indexer OUT of the
    // HTTP rotation: the HTTP-only workers (each with its own globalApi for the
    // RPC-backed detail endpoints) serve every request and only ever do light
    // KV / indexed reads, while the indexer is free to block on its synchronous
    // work in isolation. Single-process mode (WORKERS<=1) has no other worker,
    // so it must still serve.
    const serveHttp = !indexer || WORKERS <= 1;
    if (serveHttp) {
        // Start the HTTP server FIRST so the API is reachable (serving cached
        // SQLite data, and so nginx's /api proxy gets 200s instead of 502s) even
        // while the chain RPC is still connecting in the background.
        app.listen(PORT, () => {
            const tag = indexer ? (WORKERS <= 1 ? 'http+indexer (standalone)' : 'http+indexer') : 'http-only';
            const wid = cluster.worker ? `worker ${cluster.worker.id}` : 'standalone';
            console.log(`Backend listening on port ${PORT} (${wid}, role=${tag})`);
        });
    } else {
        const wid = cluster.worker ? `worker ${cluster.worker.id}` : 'standalone';
        console.log(`Backend ${wid} is the dedicated indexer — not serving HTTP, so its synchronous indexing can't stall user requests.`);
    }

    // RPC resilience watchdog. Runs in every worker (not just the indexer) so
    // HTTP-only workers also recover their detail-endpoint RPC access after a
    // long upstream outage. Each worker's WsProvider is independent, so they
    // each maintain their own rpcDisconnectStartedAt and escalate separately.
    setInterval(rpcWatchdog, RPC_WATCHDOG_INTERVAL_MS);

    // Chain-head freshness watchdog. ONLY useful on the indexer worker — it's
    // the only worker that calls syncChainIndex and therefore the only one
    // that feeds recordChainHead(). HTTP-only workers never observe head, so
    // running the watchdog there would falsely fire after CHAIN_HEAD_STALE_MS
    // every time.
    if (indexer) setInterval(chainHeadWatchdog, CHAIN_HEAD_WATCHDOG_INTERVAL_MS);

    // Audit F-092: "exactly one indexer" was enforced only WITHIN a process
    // tree. Two containers (a stale one during a deploy, a manually started
    // second stack) both pointed at the same SQLite file would both run the
    // write loops and could restore an older watermark over a newer one —
    // silent index corruption. A DB-backed lease makes the invariant global to
    // the database, which is the thing actually being protected.
    if (indexer) startIndexerLoopsWhenLeaseAvailable();
}

// ---- Single-indexer lease (audit F-092) ------------------------------------
// A row in kv holding { owner, expiresAt }. Taking it requires it to be absent
// or expired; the holder renews. Deliberately simple: the failure this guards
// against is an OPERATOR one (two stacks on one DB), not a Byzantine one, and
// a lease that a dead process releases on its own is the property that matters.
const INDEXER_LEASE_TTL_MS = readPositiveInteger(process.env.INDEXER_LEASE_TTL_MS, 90_000);
const INDEXER_LEASE_RENEW_MS = readPositiveInteger(process.env.INDEXER_LEASE_RENEW_MS, 30_000);
const INDEXER_LEASE_OWNER = `${process.env.HOSTNAME || 'host'}:${process.pid}`;

// Take the lease when it becomes available, and KEEP TRYING.
//
// A batch review caught the first version of this failing in the most
// embarrassing possible way: it tried exactly once, at boot. The old
// process's lease is valid for up to TTL after it dies, and the owner id
// contains the pid — so on every ordinary restart the new process saw a live
// lease owned by "someone else", logged a line, and ran HTTP-only FOREVER.
// Indexing would have stopped silently at the next deploy. Three changes:
// release on shutdown, retry on an interval, and treat our own hostname as
// reclaimable (a container has one indexer; a new pid on the same host is the
// SAME logical indexer restarting).
function startIndexerLoopsWhenLeaseAvailable() {
    if (acquireIndexerLease()) {
        startIndexerLoops();
        setInterval(renewIndexerLease, INDEXER_LEASE_RENEW_MS).unref();
        return;
    }
    const waitMs = Math.min(INDEXER_LEASE_RENEW_MS, 15_000);
    console.warn(`[indexer] lease unavailable — retrying every ${Math.round(waitMs / 1000)}s. ` +
        'Indexing starts as soon as the current holder releases it or its TTL expires.');
    const retry = setInterval(() => {
        if (acquireIndexerLease()) {
            clearInterval(retry);
            console.log('[indexer] lease acquired on retry — starting indexer loops');
            startIndexerLoops();
            setInterval(renewIndexerLease, INDEXER_LEASE_RENEW_MS).unref();
        }
    }, waitMs);
    retry.unref();
}

// Release on the way out so a restart doesn't wait out the TTL.
function releaseIndexerLease() {
    try {
        const cur = db.getKv('indexer:lease');
        if (cur && cur.owner === INDEXER_LEASE_OWNER) {
            db.setKv('indexer:lease', { owner: null, expiresAt: 0, releasedBy: INDEXER_LEASE_OWNER, releasedAt: Date.now() });
        }
    } catch (e) { /* best effort — the TTL is the backstop */ }
}
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { releaseIndexerLease(); process.exit(0); });
}
process.on('exit', releaseIndexerLease);

function acquireIndexerLease() {
    try {
        const cur = db.getKv('indexer:lease');
        const now = Date.now();
        const host = o => String(o || '').split(':')[0];
        // A live lease blocks us UNLESS it belongs to this same host — that is
        // our own previous process, and one host runs one indexer, so a new pid
        // there is this indexer restarting rather than a competitor.
        if (cur && cur.owner
            && cur.owner !== INDEXER_LEASE_OWNER
            && host(cur.owner) !== host(INDEXER_LEASE_OWNER)
            && Number(cur.expiresAt) > now) {
            console.warn(`[indexer] lease held by ${cur.owner} until ${new Date(Number(cur.expiresAt)).toISOString()}`);
            return false;
        }
        if (cur && cur.owner && host(cur.owner) === host(INDEXER_LEASE_OWNER) && cur.owner !== INDEXER_LEASE_OWNER) {
            console.log(`[indexer] reclaiming the lease from our own previous process (${cur.owner})`);
        }
        db.setKv('indexer:lease', { owner: INDEXER_LEASE_OWNER, expiresAt: now + INDEXER_LEASE_TTL_MS });
        console.log(`[indexer] lease acquired by ${INDEXER_LEASE_OWNER}`);
        return true;
    } catch (err) {
        // A lease we cannot read must not stop indexing — that would trade a
        // rare operator mistake for a guaranteed outage.
        console.warn('[indexer] lease check failed, proceeding:', err && err.message ? err.message : err);
        return true;
    }
}

function renewIndexerLease() {
    try {
        const cur = db.getKv('indexer:lease');
        const host = o => String(o || '').split(':')[0];
        if (cur && cur.owner
            && cur.owner !== INDEXER_LEASE_OWNER
            && host(cur.owner) !== host(INDEXER_LEASE_OWNER)
            && Number(cur.expiresAt) > Date.now()) {
            // A DIFFERENT HOST took it while we were running: stop writing
            // rather than race. Exit; the refork comes back and (per
            // startIndexerLoopsWhenLeaseAvailable) retries until it can take
            // over — the first version exited into a permanent HTTP-only state.
            console.error(`[indexer] lease was taken over by ${cur.owner} — exiting so this worker restarts and waits for it`);
            setTimeout(() => process.exit(1), 100).unref();
            return;
        }
        db.setKv('indexer:lease', { owner: INDEXER_LEASE_OWNER, expiresAt: Date.now() + INDEXER_LEASE_TTL_MS });
    } catch (err) {
        console.warn('[indexer] lease renew failed:', err && err.message ? err.message : err);
    }
}

// ---- Indexer loops ---------------------------------------------------------
// Runs in exactly ONE process: either the cluster primary's designated indexer
// worker, or the standalone process when WORKERS=1. Multiple writers against
// the same SQLite file would serialize via WAL but waste RPC bandwidth and
// produce duplicate work, so we enforce the singleton at the cluster level.
//
// connectRpc() has already been started by runWorker() before this is
// invoked, so we don't open the WebSocket again here. The immediate sync
// kicks below all gate on isRpcReady() and become no-ops until the
// handshake completes; connectRpc's own post-connect kicks then catch up.
function startIndexerLoops() {
    // One-time repair of blocks that were abandoned because the NODE was
    // unavailable rather than because the block was undecodable. Those attempts
    // should never have counted (lib/rpc-errors.js), so give them their retry
    // lives back now that the scanners no longer make that mistake. Idempotent
    // and cheap: an indexed UPDATE that matches nothing on a healthy database.
    try {
        const rescued = db.requeueTransientScanFailures(SCAN_MAX_ATTEMPTS);
        if (rescued) console.log(`[indexer] requeued ${rescued} block(s) abandoned during RPC outages — they will be retried`);
    } catch (err) {
        console.warn('[indexer] transient-failure requeue skipped:', err && err.message ? err.message : err);
    }

    // F-075 housekeeping: reclaim rate-limit buckets nobody has touched in a
    // day. Indexer-only (single writer), and the sweep is a single indexed
    // DELETE. A review caught pruneRateLimits() being exported and never
    // called while both the schema comment and its own docstring claimed it
    // ran — so the table would have grown by one row per (bucket, IP) forever
    // on the production database.
    const sweepRateLimits = () => {
        try {
            const removed = db.pruneRateLimits();
            if (removed) console.log(`[indexer] pruned ${removed} stale rate-limit bucket(s)`);
        } catch (err) {
            console.warn('[indexer] rate-limit prune skipped:', err && err.message ? err.message : err);
        }
    };
    sweepRateLimits();
    setInterval(sweepRateLimits, 6 * 60 * 60 * 1000).unref();

    // Amnesty for scan failures that have exhausted their retry budget.
    //
    // The F-004 watermark is derived from the lowest OUTSTANDING failure, and
    // that deliberately includes permanent ones — a block the node cannot serve
    // is still a hole. Adversarial review found the consequence: nothing could
    // ever clear a permanent row, so one unreadable height froze the watermark
    // and the status at Degraded for the life of the database.
    //
    // Same cadence and the same reasoning as the F-046 in-memory amnesty: an
    // operator repointing RPC at an archive node makes yesterday's unreadable
    // block readable, and no signal inside this process can observe that. Small
    // batch, oldest first, so retrying the genuinely dead ones costs a handful
    // of RPC calls every six hours rather than a re-scan.
    const sweepExhaustedFailures = () => {
        try {
            const revived = db.requeueExhaustedScanFailures(SCAN_MAX_ATTEMPTS, SCAN_AMNESTY_MS);
            if (revived) console.log(`[indexer] amnesty: ${revived} exhausted block(s) returned to the retry queue`);
        } catch (err) {
            console.warn('[indexer] scan-failure amnesty skipped:', err && err.message ? err.message : err);
        }
    };
    setInterval(sweepExhaustedFailures, SCAN_AMNESTY_MS).unref();

    // Stagger initial kicks so the RPC node isn't slammed by every sync in the
    // same second of startup — that pile-up alone can spike load. The first
    // call still happens immediately so the home page has data quickly; the
    // rest are spread across the first ~10 seconds.
    syncChainIndex();
    syncTransactions();
    refreshNetworkInfoInBackground();
    refreshTotalUnlockingInBackground();
    setTimeout(syncData,         1500);
    setTimeout(syncHolders,      3000);
    setTimeout(syncStakingRewards, 4500);
    setTimeout(syncCouncil,      6000);
    setTimeout(syncTreasury,     7000);
    setTimeout(syncDemocracy,    8000);
    setTimeout(syncGovernance,   9000);
    setTimeout(syncPrice,        10000);

    // Recent-chain indexing — the combined blocks + events crawler. Cadence
    // controlled by CHAIN_INDEX_INTERVAL_MS (default 12s).
    setInterval(() => {
        syncChainIndex();
        syncTransactions();
    }, CHAIN_INDEX_INTERVAL_MS);
    // Network-milestone email checks (runtime upgrade, era boundary). Two
    // cheap reads — one in-memory, one storage — so a short cadence is fine,
    // and a short cadence is what makes "era 4218 has begun" arrive while it
    // is still news. The chain-stalled alert is not here: it fires from
    // chainHeadWatchdog at the moment an episode starts.
    setTimeout(dispatchNetworkEmails, 12_000);
    setInterval(dispatchNetworkEmails, NETWORK_EMAIL_CHECK_MS);
    // syncData refreshes the validator set, per-era commission history and the
    // scorecard inputs. It had NO interval — only a one-shot setTimeout at boot
    // and a re-kick on RPC reconnect — while every sibling sync above and below
    // this line has one. Everything it writes therefore froze at boot:
    //
    //   * `validators.commission`, which is line one of every row on
    //     /validators, went stale the moment a validator changed it;
    //   * `validator_history` stopped gaining eras, so the newest era we held
    //     drifted further behind the chain every day. A review caught what that
    //     does to the commission-history feature specifically: `raisedRecently`
    //     compares a FRESH activeEra (network_info does refresh) against a
    //     STALE last-change era, so the "RAISED RECENTLY" badge — the one thing
    //     that answers "they raised it the day after I nominated" — would stop
    //     firing about a week after each deploy and never fire again.
    //
    // Hourly: eras are ~24h on this chain, so this is comfortably often enough
    // to catch every era boundary while staying far cheaper than the per-era
    // RPC walk it performs.
    setInterval(syncData, VALIDATOR_SYNC_INTERVAL_MS);
    setInterval(syncHolders, THIRTY_MINUTES);
    setInterval(syncCouncil,   COUNCIL_REFRESH_MS);
    setInterval(syncTreasury,  TREASURY_REFRESH_MS);
    setInterval(syncDemocracy, DEMOCRACY_REFRESH_MS);
    setInterval(syncTransactions, THIRTY_SECONDS);
    // Pre-warm the network-info cache well inside its 5-minute TTL so the
    // home page panel is always a cache hit (never a cold recompute).
    setInterval(refreshNetworkInfoInBackground, NETWORK_INFO_REFRESH_MS);
    // Pre-warm analytics counts (blocks / events / transactions). Same
    // pattern as network_info — pure DB scans on the indexer worker, store
    // in KV, HTTP workers read cheaply. First run on a short delay so the
    // cache is warm by the time anyone hits /analytics for the first time.
    setTimeout(refreshAnalyticsCountsInBackground, 20_000);
    setInterval(refreshAnalyticsCountsInBackground, ANALYTICS_COUNTS_REFRESH_MS);
    // Pre-warm the analytics time-series (7/30/90/365d) so /api/analytics/timeseries
    // is a KV read instead of a live GROUP-BY on every page load.
    setTimeout(refreshAnalyticsTimeseriesInBackground, 22_000);
    setInterval(refreshAnalyticsTimeseriesInBackground, ANALYTICS_COUNTS_REFRESH_MS);
    // Refresh the totalUnlocking figure on its own slower cadence — it's the
    // expensive `staking.ledger.entries()` scan that the network-info compute
    // used to do every time.
    setInterval(refreshTotalUnlockingInBackground, TOTAL_UNLOCKING_TTL_MS);
    // Staking rewards indexer: continuously appends new payouts each era and
    // resumably backfills older history. Cadence: STAKING_REWARDS_INTERVAL_MS
    // (default 30s). Lower this and/or raise STAKING_REWARDS_BACKFILL_CHUNK to
    // make backfill complete sooner.
    setInterval(syncStakingRewards, STAKING_REWARDS_INTERVAL_MS);
    // Governance history indexer: forward pass for new blocks + resumable
    // backfill of treasury proposals and council motions toward genesis.
    // Cadence: GOVERNANCE_INDEXER_INTERVAL_MS (default 30s).
    setInterval(syncGovernance, GOVERNANCE_INDEXER_INTERVAL_MS);
    setInterval(syncPrice, PRICE_SYNC_INTERVAL);
}

// Surface anything that escapes a sync's try/catch so we never see a
// silent "WebSocket is not connected" trail again.

// Cooldown between forced api rebuilds triggered from process-level error
// handlers — without this, a stuck WS that fires many timeouts per second
// would thrash the reconnect path.
const STUCK_WS_REBUILD_COOLDOWN_MS = readPositiveInteger(
    process.env.STUCK_WS_REBUILD_COOLDOWN_MS, 30 * 1000);
let lastStuckWsRebuildAt = 0;

// "No response received from RPC endpoint in 60s" is polkadot.js's per-request
// timeout. It fires from a deferred setTimeout, escapes the call site as an
// uncaughtException, and indicates the WS is alive at TCP layer but the
// upstream isn't responding to JSON-RPC requests. The connection-level
// watchdog wouldn't catch this for 5+ minutes (it waits for chain-head-stale).
// We trigger an immediate api rebuild so a fresh WS connection can land on a
// different Cloudflare LB origin within seconds.
function isPolkadotWsRequestTimeout(err) {
    if (!err || !err.message) return false;
    // Two patterns from polkadot.js that both indicate the WS is wedged:
    //
    //   "No response received from RPC endpoint in 60s"
    //     - Per-request timeout. WS is TCP-connected but request is silently
    //       dropping. Force a rebuild so a new WS lands on a different LB origin.
    //
    //   "Connection was closed before it was established"
    //     - WsProvider tried to reconnect but the socket closed mid-handshake.
    //       Surfaces continuously every 2.5s while the provider auto-retries on
    //       a dead origin. Force-rebuild lets the next attempt re-roll through
    //       the LB to a healthy origin.
    return /No response received from RPC endpoint/.test(err.message)
        || /Connection was closed before it was established/.test(err.message);
}

// Hard ceiling on how long any single rebuild attempt may take. Without this,
// connectRpc()'s `await ApiPromise.create(...)` can hang indefinitely when the
// upstream (CF LB) returns malformed responses during a misconfiguration
// window. That leaves rpcResetInFlight=true forever, and every subsequent
// watchdog tick / uncaughtException handler early-returns at the guard,
// silently breaking auto-recovery for the lifetime of the process.
const RPC_REBUILD_TIMEOUT_MS = readPositiveInteger(
    process.env.RPC_REBUILD_TIMEOUT_MS, 30 * 1000);

async function rebuildApiOnce(reason) {
    if (rpcResetInFlight) return;
    if (Date.now() - lastStuckWsRebuildAt < STUCK_WS_REBUILD_COOLDOWN_MS) return;
    lastStuckWsRebuildAt = Date.now();
    rpcResetInFlight = true;
    console.warn(`[RPC] forcing api rebuild (reason: ${reason})`);
    // Wrap the whole rebuild in a timeout so the lock is released even when
    // connectRpc() hangs. Promise.race here means whichever resolves first
    // wins — if the timeout fires first, the dangling rebuild is left to its
    // own devices and we move on so subsequent rebuild attempts can fire.
    const rebuildWork = (async () => {
        try {
            if (globalApi) {
                try { await globalApi.disconnect(); } catch (_) { /* best effort */ }
                globalApi = null;
            }
            await connectRpc({ kickSyncsOnConnect: false });
        } catch (e) {
            console.warn('[RPC] rebuild attempt failed:', e && e.message ? e.message : e);
        }
    })();
    const timeout = new Promise((resolve) => setTimeout(() => {
        console.warn(`[RPC] rebuild attempt timed out after ${RPC_REBUILD_TIMEOUT_MS}ms — releasing lock for next attempt`);
        resolve();
    }, RPC_REBUILD_TIMEOUT_MS));
    try {
        await Promise.race([rebuildWork, timeout]);
    } finally {
        rpcResetInFlight = false;
    }
}

process.on('unhandledRejection', (err) => {
    console.error('Unhandled promise rejection:', err && err.stack ? err.stack : err);
    if (isPolkadotWsRequestTimeout(err)) {
        setImmediate(() => rebuildApiOnce('60s request timeout (rejection)'));
    }
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err && err.stack ? err.stack : err);
    // A wedged WebSocket is a KNOWN, recoverable condition — rebuild and keep
    // going, that path is well understood.
    if (isPolkadotWsRequestTimeout(err)) {
        setImmediate(() => rebuildApiOnce('60s request timeout (exception)'));
        return;
    }
    // Audit F-094: anything else used to be logged and then IGNORED. After an
    // unknown throw the process keeps serving with arbitrary invariants
    // broken — an indexer mid-transaction, a sync flag stuck true so that
    // crawler never runs again — and it looks healthy from outside. Node's own
    // guidance is that uncaughtException leaves the process in an undefined
    // state. Exit and let Docker's restart policy (and the cluster's refork)
    // give us a process whose state we can reason about. Same reasoning as
    // F-022's initDb fail-fast.
    console.error('[fatal] exiting after an unrecoverable uncaught exception — the supervisor will restart this process');
    setTimeout(() => process.exit(1), 100).unref();
});

// ---- Bootstrap: cluster primary vs worker ---------------------------------
// Topology:
//   Primary (this file, run as the container's entrypoint) forks N workers.
//     - Worker 1 runs the indexer ONLY (INDEXER_ROLE=on). When WORKERS > 1 it
//       does not app.listen: `const serveHttp = !indexer || WORKERS <= 1`.
//     - Workers 2..N run HTTP only.
//   Cluster automatically round-robins inbound connections across the HTTP
//   workers, so on a 4-core box THREE cores answer requests and the fourth is
//   spent on chain sync — sizing against a req/s target must use N-1, not N.
//   Audit F-156: this comment used to say worker 1 served HTTP too, which is
//   what the code did before the indexer was taken off the listen socket. It
//   was taken off deliberately: a backfill tick blocks its event loop for
//   seconds at a time, and while it was also an HTTP worker the OS kept handing
//   it a full share of requests, which then sat behind that stall. An operator
//   capacity-planning from the old comment would have over-counted by a core
//   and been puzzled by the latency spikes. SQLite with WAL mode
//   tolerates multi-process readers natively, and the single-writer
//   invariant is preserved because only the indexer worker mutates the DB.
//
//   Crash recovery: if any worker dies, the primary forks a replacement. If
//   the *indexer* worker was the one that died, the replacement inherits
//   the role so indexing resumes within a couple of seconds.
//
//   WORKERS env:
//     WORKERS=1   → no clustering, single process (legacy behavior, useful
//                   for local dev and `node --check`-style smoke tests).
//     WORKERS=N   → fork N workers (default = cpu count, clamped to ≤8).
//     WORKERS=0   → equivalent to WORKERS=1.
// One ceiling for both the env override and the CPU-derived default (F-177).
const WORKERS_MAX = readPositiveInteger(process.env.WORKERS_MAX, 8);
const WORKERS = (() => {
    const raw = process.env.WORKERS;
    if (raw === '1' || raw === '0') return 1;
    const n = parseInt(raw || '', 10);
    // Audit F-177: the env path capped at 16 while the default capped at 8,
    // for no stated reason — an operator setting WORKERS=16 got double what
    // the code's own comment called "overkill", each worker carrying its own
    // SQLite page cache and mmap window (see F-093). One ceiling.
    if (Number.isFinite(n) && n > 0) return Math.min(n, WORKERS_MAX);
    // Default: one worker per CPU, capped so we don't blow up on big-iron
    // hosts (the indexer + RPC connection scale with neither cores nor
    // workers, so more is overkill for the explorer's read load).
    return Math.min(cpus().length, WORKERS_MAX);
})();

function bootstrapCluster() {
    if (WORKERS <= 1) {
        // Single-process mode. Audit F-092's close test: "INDEXER_ROLE=off is
        // honoured when WORKERS<=1". It was not — this hardcoded
        // `indexer: true`, so an operator who deliberately started a
        // read-only/second instance with INDEXER_ROLE=off still got a full
        // writer against the same SQLite file, which is the two-writer
        // scenario the lease exists to prevent.
        const wantsIndexer = process.env.INDEXER_ROLE !== 'off';
        if (!wantsIndexer) console.log('[cluster] single-process mode with INDEXER_ROLE=off — serving HTTP only, no indexing');
        // clustered:false — this process is alone, so it owns the schema step
        // outright even when it is not the indexer (F-139).
        runWorker({ indexer: wantsIndexer, clustered: false });
        return;
    }

    if (cluster.isPrimary) {
        console.log(`[cluster] primary ${process.pid} forking ${WORKERS} worker(s); indexer pinned to worker 1`);

        // Worker.id → boolean: which forked worker holds the indexer role.
        // Tracked here so a crash + refork can transfer the role intact.
        const indexerWorkerIds = new Set();

        function forkOne(role) {
            const env = { ...process.env, INDEXER_ROLE: role === 'indexer' ? 'on' : 'off' };
            const w = cluster.fork(env);
            if (role === 'indexer') indexerWorkerIds.add(w.id);
            return w;
        }

        forkOne('indexer');
        for (let i = 1; i < WORKERS; i++) forkOne('http');

        // Audit F-145: refork was immediate and unconditional. A worker that
        // dies on startup — a bad migration, a missing module (this actually
        // happened: ERR_MODULE_NOT_FOUND on 2026-08-22), a corrupt DB — got
        // re-forked in a tight loop that pinned a core and buried the real
        // error under thousands of identical lines. Exponential backoff keeps
        // the restart behaviour while making the logs readable and leaving CPU
        // for whoever is debugging.
        let reforkDelayMs = 0;
        let lastExitAt = 0;
        const REFORK_MAX_MS = readPositiveInteger(process.env.REFORK_MAX_MS, 30_000);
        cluster.on('exit', (worker, code, signal) => {
            const wasIndexer = indexerWorkerIds.has(worker.id);
            indexerWorkerIds.delete(worker.id);
            const now = Date.now();
            // A worker that ran a healthy while is not crash-looping: reset.
            if (now - lastExitAt > 60_000) reforkDelayMs = 0;
            lastExitAt = now;
            console.warn(`[cluster] worker ${worker.id} (pid ${worker.process.pid}) exited` +
                ` (code=${code}, signal=${signal || 'none'}, was-indexer=${wasIndexer}) — restarting` +
                (reforkDelayMs ? ` in ${reforkDelayMs}ms` : ''));
            // Preserve the single-indexer invariant: if the indexer worker
            // died, the replacement takes over that role; otherwise we just
            // fork a new HTTP-only worker.
            const role = wasIndexer ? 'indexer' : 'http';
            if (reforkDelayMs === 0) {
                forkOne(role);
            } else {
                setTimeout(() => forkOne(role), reforkDelayMs).unref();
            }
            reforkDelayMs = Math.min(reforkDelayMs === 0 ? 1000 : reforkDelayMs * 2, REFORK_MAX_MS);
        });
    } else {
        // Inside a worker — INDEXER_ROLE was set by the primary above.
        runWorker({ indexer: process.env.INDEXER_ROLE === 'on', clustered: true });
    }
}

bootstrapCluster();
