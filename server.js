import express from 'express';
import cors from 'cors';
import cluster from 'node:cluster';
import { cpus } from 'node:os';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { decodeAddress, encodeAddress, signatureVerify, randomAsHex } from '@polkadot/util-crypto';
import { u8aWrapBytes, stringToU8a, u8aConcat } from '@polkadot/util';
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
const TX_SCAN_BATCH_SIZE = readPositiveInteger(process.env.TX_SCAN_BATCH_SIZE, 25);
const FINANCIAL_TX_SCANNER_VERSION = 2;
const VALIDATOR_HISTORY_ERAS = readPositiveInteger(process.env.VALIDATOR_HISTORY_ERAS, 30);
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
        res.status(503).json({
            error: 'Live blockchain data is not available right now — the explorer is still connecting to the Polkadex node. Please refresh in a few seconds.',
            code: 'RPC_NOT_READY'
        });
        return false;
    }
    return true;
}

let isSyncing = false;
let isSyncingHolders = false;
let isSyncingTx = false;
let isSyncingBlocks = false;
let isSyncingEvents = false;
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

function formatPDEX(balance) { return Number(balance) / 10 ** 12; }

// Convert a chain Balance codec to a PDEX number safely for large u128 values.
function balanceToPDEX(balance) {
    try { return Number(BigInt(balance.toString())) / 10 ** 12; }
    catch (e) { return Number(balance) / 10 ** 12; }
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

function formatIdentityName(rawStr) {
    if (!rawStr) return "Unknown";
    if (rawStr.startsWith('0x')) {
        try { return Buffer.from(rawStr.slice(2), 'hex').toString('utf8'); } catch (e) { return rawStr; }
    }
    return rawStr;
}

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

    const onChainName = await getOnChainIdentity(api, address);
    if (onChainName !== "Unknown") {
        identityCache.set(cacheKey, onChainName);
        return onChainName;
    }

    const fallbackName = DISPLAY_NAME_OVERRIDES.get(cacheKey) || "Unknown";
    if (!hasOverride) identityCache.set(cacheKey, fallbackName);
    return fallbackName;
}

async function getOnChainIdentity(api, address) {
    const cacheKey = address.toString();
    let name = "Unknown";
    // Defensive null-check: the watchdog briefly nulls globalApi between
    // disconnect and reconnect, and identity lookups can be in flight from
    // any of the HTTP handlers. Catching this here keeps the reconnect
    // window silent in logs and returns "Unknown" without falsely caching it.
    if (!api || !api.query || !api.query.identity) return name;
    try {
        const superOf = await api.query.identity.superOf(address);
        if (superOf.isSome) {
            const [parentAddress, data] = superOf.unwrap();
            const parentIdentity = await api.query.identity.identityOf(parentAddress);
            let parentName = "Unknown";
            const pHuman = parentIdentity.toHuman();
            if (pHuman && pHuman.info && pHuman.info.display && pHuman.info.display.Raw) parentName = formatIdentityName(pHuman.info.display.Raw);
            else if (pHuman && Array.isArray(pHuman) && pHuman[0] && pHuman[0].info) parentName = formatIdentityName(pHuman[0].info.display.Raw);

            const subDataHuman = data.toHuman();
            const subName = subDataHuman ? formatIdentityName(subDataHuman.Raw) : "Unknown";
            name = `${parentName} / ${subName}`;
        } else {
            const identity = await api.query.identity.identityOf(address);
            const human = identity.toHuman();
            if (human && human.info && human.info.display && human.info.display.Raw) name = formatIdentityName(human.info.display.Raw);
            else if (human && Array.isArray(human) && human[0] && human[0].info) name = formatIdentityName(human[0].info.display.Raw);
        }
    } catch (e) {
        console.warn(`Identity lookup failed for ${cacheKey}:`, e.message);
    }
    return name;
}

function getBlockTimestamp(signedBlock) {
    let timestamp = Date.now();
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

function getExtrinsicAmountSummary(ex) {
    const method = getExtrinsicMethod(ex);
    const args = ex.method.args;
    let to = method;
    let numericAmount = 0;
    let amount = '-';

    if (ex.method.section === 'balances') {
        if (['transfer', 'transferAllowDeath', 'transferKeepAlive'].includes(ex.method.method) && args.length >= 2) {
            to = args[0].toString();
            numericAmount = formatPDEX(args[1]);
            amount = `${numericAmount.toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX`;
        } else if (ex.method.method === 'forceTransfer' && args.length >= 3) {
            to = args[1].toString();
            numericAmount = formatPDEX(args[2]);
            amount = `${numericAmount.toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX`;
        } else if (ex.method.method === 'transferAll' && args.length >= 1) {
            to = args[0].toString();
            amount = 'All';
        }
    }

    return { method, to, amount, numericAmount };
}

function buildFinancialTransaction(ex, index, blockNumber, timestamp, events) {
    const summary = getExtrinsicAmountSummary(ex);
    if (summary.amount === '-') return null;
    return {
        hash: ex.hash.toHex(),
        from: ex.isSigned ? ex.signer.toString() : "System",
        to: summary.to,
        block: blockNumber,
        method: summary.method,
        amount: summary.amount,
        numericAmount: summary.numericAmount,
        value: '-',
        status: getExtrinsicStatus(events, index),
        timestamp
    };
}

async function getBlockTimestampAt(blockHash) {
    try {
        return Number(await globalApi.query.timestamp.now.at(blockHash));
    } catch (err) {
        return Date.now();
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

    const from = event.data[0].toString();
    const to = event.data[1].toString();
    const numericAmount = formatPDEX(event.data[2]);
    return {
        hash: `event-${blockNumber}-${eventIndex}`,
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
        if (!events) return { blockNumber, transactions: [], ok: true };
        const blockTransactions = [];
        events.forEach((record, eventIndex) => {
            const tx = buildFinancialTransactionFromEvent(record, eventIndex, blockNumber, blockHash, timestamp);
            if (tx) blockTransactions.push(tx);
        });
        return { blockNumber, transactions: blockTransactions, ok: true };
    } catch (err) {
        const short = shortErrorMessage(err);
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
    progressInterval = 100
}) {
    const transactions = [];
    let scannedBlocks = 0;
    let lastScannedBlock = startBlock;

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
        for (const result of batchResults.sort((a, b) => b.blockNumber - a.blockNumber)) {
            for (const tx of result.transactions) {
                if (transactions.length >= limit) break;
                transactions.push(tx);
            }
            if (transactions.length >= limit) break;
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
        nextBeforeBlock: scannedBlocks > 0 ? Math.max(lastScannedBlock, 0) : Math.max(startBlock, 0),
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
    const firstEra = Math.max(activeEra - VALIDATOR_HISTORY_ERAS + 1, 0);
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
        const rows = (perAddress[address] || []).slice().sort((a, b) => a.era - b.era);
        db.replaceValidatorTriggers(address, getCommissionTriggers(rows));
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

    const triggers = getCommissionTriggers(history);
    db.upsertValidatorHistory(history.map(h => ({ era: h.era, address, commission: h.commission, stake: h.stake, apy: h.apy })));
    db.replaceValidatorTriggers(address, triggers);

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

// Per-IP rate limit for the developer endpoints. Mirrors the email-signup
// limiter's approach (sliding window in memory, per worker).
const DEV_API_RATE_LIMIT_PER_MIN = readPositiveInteger(process.env.DEV_API_RATE_LIMIT_PER_MIN, 60);
const devApiHits = new Map(); // ip -> [timestamps]

function devApiRateOk(ip) {
    const cutoff = Date.now() - 60 * 1000;
    const arr = (devApiHits.get(ip) || []).filter(t => t > cutoff);
    if (arr.length >= DEV_API_RATE_LIMIT_PER_MIN) {
        devApiHits.set(ip, arr);
        return false;
    }
    arr.push(Date.now());
    devApiHits.set(ip, arr);
    return true;
}
// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
    const cutoff = Date.now() - 60 * 1000;
    for (const [ip, arr] of devApiHits) {
        const live = arr.filter(t => t > cutoff);
        if (live.length) devApiHits.set(ip, live); else devApiHits.delete(ip);
    }
}, 5 * 60 * 1000).unref();

function clientIp(req) {
    return (req.headers['x-forwarded-for'] || req.ip || 'unknown').toString().split(',')[0].trim();
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

const DEV_API_TIMEOUT_MS = readPositiveInteger(process.env.DEV_API_TIMEOUT_MS, 20000);

// Chain queries can hang when the node is unhealthy; never let one pin a
// worker (these are synchronous-ish awaits on a shared event loop).
function withTimeout(promise, ms = DEV_API_TIMEOUT_MS, label = 'query') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref())
    ]);
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
        res.status(500).json({ error: err.message });
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
function archiveHint(err, at) {
    const msg = String(err && err.message || err);
    if (/state already discarded|unknown block|not available|pruned/i.test(msg) && at) {
        return `${msg} — block ${at.block} is outside this node's pruning window. Historical state queries require an ARCHIVE node; point POLKADEX_WS at one.`;
    }
    return msg;
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
            const all = await withTimeout(entry.entries(), DEV_API_TIMEOUT_MS, 'entries');
            const truncated = all.length > DEV_API_MAX_ENTRIES;
            const rows = all.slice(0, DEV_API_MAX_ENTRIES).map(([k, v]) => ({
                key: k.toHuman(),
                keyHex: k.toHex(),
                value: serialiseCodec(v)
            }));
            cacheShort(res);
            return res.json({
                pallet, item, at, storage: desc,
                entriesTotal: all.length, truncated,
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

        const value = await withTimeout(entry(...args), DEV_API_TIMEOUT_MS, 'storage read');
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
        res.status(500).json({ error: archiveHint(err, at) });
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
        res.status(500).json({ error: archiveHint(err, at) });
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
        res.status(500).json({ error: archiveHint(err, at) });
    }
});

// ---- POST /api/rpc/call -----------------------------------------------------
// polkadot.js's "RPC calls" tab, restricted to an explicit allowlist of
// READ-ONLY methods. Everything that submits, signs, mutates or touches the
// node's keystore/offchain storage (author_*, offchain_*, system_addReservedPeer,
// ...) is absent by construction — an allowlist, never a denylist, so a new
// upstream RPC method can't quietly become reachable.
const RPC_ALLOWLIST = new Set([
    'chain_getBlock', 'chain_getBlockHash', 'chain_getFinalizedHead', 'chain_getHeader',
    'state_getRuntimeVersion', 'state_getStorage', 'state_getKeysPaged', 'state_queryStorageAt', 'state_getStorageHash', 'state_getStorageSize',
    'system_chain', 'system_chainType', 'system_health', 'system_name', 'system_properties', 'system_version', 'system_syncState',
    'payment_queryInfo'
]);

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

        const [section, ...rest] = method.split('_');
        const fn = rest.join('_').replace(/_(.)/g, (_, c) => c.toUpperCase());
        const target = globalApi.rpc[section] && globalApi.rpc[section][fn];
        if (!target) return res.status(400).json({ error: `RPC method "${method}" is not available on this node.` });

        const value = await withTimeout(target(...params), DEV_API_TIMEOUT_MS, method);
        res.set('Cache-Control', 'no-store');
        res.json({ method, params, ...serialiseCodec(value) });
    } catch (err) {
        res.set('Cache-Control', 'no-store');
        res.status(500).json({ error: err.message });
    }
});

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

        const signedBlock = await withTimeout(globalApi.rpc.chain.getBlock(blockHash), DEV_API_TIMEOUT_MS, 'getBlock');
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

        const out = [];
        const extrinsics = signedBlock.block.extrinsics || [];
        for (let i = 0; i < extrinsics.length; i++) {
            if (wantIndex !== null && i !== wantIndex) continue;
            const ex = extrinsics[i];
            const call = ex.method;
            const section = call.section, method = call.method;
            if (wantSection && norm(section) !== wantSection) continue;
            if (wantMethod && norm(method) !== wantMethod) continue;

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
            extrinsics: out
        };
        // A filter that matches nothing returns [], which reads identically to
        // "that call is not in this block". For an audit tool those are very
        // different statements, so when a filter eliminated everything, list
        // what the block actually contains.
        if (!out.length && (wantSection || wantMethod || wantIndex !== null)) {
            body.note = 'No extrinsic in this block matched the filter. Section/method matching ignores case and underscores, so submit_snapshot and submitSnapshot are equivalent.';
            body.present = extrinsics.map((ex, i) => `${i}: ${ex.method.section}.${ex.method.method}`);
        }
        res.json(body);
    } catch (err) {
        res.set('Cache-Control', 'no-store');
        res.status(500).json({ error: archiveHint(err, { block: req.params.block }) });
    }
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
// We only set Cache-Control on the success path (before res.json with 200).
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
        //   /api/             — JSON endpoints, not human-readable.
        'Allow: /wallet',
        'Disallow: /wallet/',
        'Disallow: /watchlist',
        'Disallow: /search',
        'Disallow: /api/',
        // Reference + content surfaces — explicitly allowed so the wildcard
        // root Allow can't be mis-parsed by older or stricter crawlers.
        'Allow: /help',
        'Allow: /help/',
        'Allow: /developers',
        'Allow: /chain-state',
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

<h2>Start here — use the JSON API, not the HTML</h2>
<p>This explorer is a client-rendered single-page app: HTML pages are a shell that JavaScript fills in inside the browser. A non-browser client that fetches an HTML page will <strong>not</strong> see the data. Don't scrape the HTML — call the JSON API below, which returns plain JSON. Every figure on the site comes from an <code>/api/*</code> endpoint. (This developer page is the exception: it is server-rendered on purpose.)</p>
<table>
<thead><tr><th>Behavior</th><th>What to do</th></tr></thead>
<tbody>
<tr><td>HTML pages sit behind Cloudflare, which may challenge or block clients that look like abusive bots. A naive server-side fetch of an HTML page can come back empty or challenged.</td><td>Request the <code>/api/*</code> JSON endpoints instead — the supported path for automated clients. Send a descriptive <code>User-Agent</code> and respect the <code>Cache-Control</code> headers.</td></tr>
<tr><td>The API is open to non-browser clients at the origin. CORS is a browser-only mechanism, so a caller that sends no <code>Origin</code> header (native app, server, script, AI agent) is always allowed by the app.</td><td>Call the API directly from servers and native apps. Only browser callers from other web origins need to be added to <code>ALLOWED_ORIGINS</code>.</td></tr>
</tbody>
</table>

<h2>Chain data (read-only, public)</h2>
<ul class="endpoints">
<li><code>GET /api/blocks</code> — most recent blocks</li>
<li><code>GET /api/block/:number</code> — single block with extrinsics + events</li>
<li><code>GET /api/events</code> — most recent on-chain events</li>
<li><code>GET /api/transactions</code> — most recent transactions</li>
<li><code>GET /api/transactions/older?before=&lt;n&gt;</code> — pagination further back</li>
<li><code>GET /api/extrinsic/:block/:txHash</code> — single-extrinsic detail</li>
<li><code>GET /api/validators</code> — full validator set with stake + commission</li>
<li><code>GET /api/validator/:address</code> — per-validator era history</li>
<li><code>GET /api/holders</code> — top-balance accounts</li>
<li><code>GET /api/account/:address</code> — account-level summary</li>
<li><code>GET /api/network-info</code> — network metrics (schema below)</li>
<li><code>GET /api/search/:query</code> — block / extrinsic / account lookup</li>
<li><code>GET /api/staking-rewards/:address</code> — per-address reward history</li>
<li><code>GET /api/staking-rewards-status</code> — reward-backfill progress</li>
<li><code>GET /api/wallet/:address</code> — wallet dashboard payload (balances, staking incl. <code>activeStakedPlanck</code> u128 string, unpaid rewards, recent activity)</li>
</ul>

<h2>Chain inspection (read-only, polkadot.js-style)</h2>
<p>Generic access to runtime metadata, storage and constants at <strong>any block</strong>, so on-chain claims can be verified independently. Backed by an archive node, so historical queries work.</p>
<ul class="endpoints">
<li><code>GET /api/rpc/metadata</code> — every pallet with its storage items (key arity + types), constants, calls, events, errors</li>
<li><code>GET /api/state/:pallet/:item</code> — read any storage item. <code>?args=</code> keys, <code>?at=</code> block number/hash, <code>?entries=1</code> to list a map (capped)</li>
<li><code>GET /api/consts/:pallet/:item</code> — runtime constants; <code>?at=</code> supported</li>
<li><code>GET /api/runtime</code> — runtime spec/impl version; <code>?at=</code> supported</li>
<li><code>GET /api/decode/:block</code> — every extrinsic decoded argument by argument (name, type, human, JSON, raw hex). Filters <code>?section=</code> <code>?method=</code> <code>?index=</code>; matching ignores case and underscores</li>
<li><code>POST /api/rpc/call</code> — allowlisted read-only RPC methods</li>
</ul>
<p><strong>Read-only by construction</strong> — only <code>api.query</code>, <code>api.consts</code> and allowlisted read RPCs are reachable; nothing here can submit an extrinsic.</p>
<p><strong>Send storage keys as strings.</strong> A u64 key like <code>9223372036854775808</code> (2&#8311;&#179;) exceeds JavaScript's <code>MAX_SAFE_INTEGER</code>; a client that parses it as a number queries <code>9223372036854776000</code> instead — a different key whose empty result reads like confirmation. Responses echo <code>args</code> back so you can check.</p>
<p><strong>Verify against <code>hex</code>, not <code>human</code>.</strong> <code>toHuman()</code> abbreviates hashes (an all-zero H256 shows as <code>0x0000…0000</code>) and group-separates integers, so every response carries human, JSON and hex together, plus a <code>count</code> for Vec results.</p>
<p>There is an interactive UI for this at <a href="${SITE_URL}/chain-state">/chain-state</a>, with shareable deep links (<code>?pallet=&amp;item=&amp;args=&amp;at=</code>).</p>
<pre><code>curl '${SITE_URL}/api/decode/12250870?method=submit_snapshot'
curl '${SITE_URL}/api/state/ocex/validatorSetId?at=12250870'
curl '${SITE_URL}/api/state/ocex/authorities?args=6280&amp;at=12250870'</code></pre>

<h2>Price feed, governance &amp; email</h2>
<ul class="endpoints">
<li><code>GET /api/price-latest</code> — current PDEX price, last-sync, and a <code>bySource</code> map (one entry per configured provider; <code>coingecko</code> live by default)</li>
<li><code>GET /api/price-history?days=N</code> — daily price series (N capped at 4000); each row tagged with its <code>source</code></li>
<li><code>GET /api/council</code> — council members, motions, runners-up</li>
<li><code>GET /api/treasury</code> — treasury balance + proposals (open + historical)</li>
<li><code>GET /api/democracy</code> — referenda + public proposals</li>
<li><code>GET /api/governance/latest</code> — most-recent OPEN referendum / proposal</li>
<li><code>GET /api/governance/calendar</code> — unified governance timeline</li>
<li><code>GET /api/discussions</code>, <code>GET /api/discussions/:id</code> — governance discussion threads</li>
<li><code>POST /api/email/subscribe</code>, <code>GET /api/email/confirm</code>, <code>GET /api/email/unsubscribe</code>, <code>GET|POST /api/email/preferences</code> — email alerts</li>
</ul>
<p>Price providers are pluggable via the <code>PRICE_PROVIDERS</code> env var (csv; default <code>coingecko</code>, a keyless public API).</p>

<h2>Schema — GET /api/network-info</h2>
<pre><code>{
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
<p><strong>AVG APY</strong> is returned directly (<code>avgApy</code>, and the <code>avg_apy</code> alias), derived as <code>avgApy = 23.09 &times; (1 &minus; avgValidatorCommission / 100)</code>, where 23.09% is the chain's nominal maximum APY at its target staking ratio.</p>

<h2>Errors &amp; addresses</h2>
<p>Failures return a 4xx/5xx status with <code>{ "error": "&lt;message&gt;" }</code>. Endpoints that depend on the chain RPC return <strong>503</strong> with <code>{ "error": "rpc not connected" }</code> during RPC outages — treat 503 as "retry with backoff", not permanent. Paths that take an <code>:address</code> expect Polkadex SS58 (prefix 88, addresses start with <code>e&hellip;</code>); the server normalizes via <code>toPolkadexAddress()</code>, so prefix-42/0 forms usually resolve too.</p>

<h2>Caching tiers</h2>
<p>Hot endpoints carry <code>Cache-Control</code> in three tiers — don't poll faster than <code>max-age</code>: <strong>short</strong> (blocks/transactions/events: max-age=5), <strong>medium</strong> (wallet/validators/network-info/price-latest: max-age=30), <strong>long</strong> (price-history/staking-rewards/holders: max-age=300).</p>

<h2>Quick examples</h2>
<pre><code>curl ${SITE_URL}/api/network-info
curl ${SITE_URL}/api/price-latest
curl '${SITE_URL}/api/price-history?days=30'</code></pre>
</main>

<footer>
<a href="${SITE_URL}/">Explorer</a>
<a href="${SITE_URL}/llms.txt">llms.txt</a>
<a href="${SITE_URL}/help">Help center</a>
<a href="https://github.com/Polkadex-Substrate" rel="noopener">GitHub</a>
<div style="margin-top:10px">Found a bug or a missing endpoint? Open an issue on GitHub or reach the team via <a href="https://polkadex.ee" rel="noopener">polkadex.ee</a>.</div>
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
app.get('/api/diag/rpc-cache', (req, res) => {
    res.set('Cache-Control', 'no-store');
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
    res.set('Cache-Control', 'no-store');
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
    res.set('Cache-Control', 'no-store');
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
    try { cacheMedium(res); res.json(db.getValidators()); }
    catch (err) { res.status(500).json({ validators: [], status: 'Error', error: err.message }); }
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
        res.json({ ...cacheData, status: 'Error', error: err.message });
    }
});
app.get('/api/holders', async (req, res) => {
    try {
        const cacheData = db.getHolders();
        cacheData.holders = await applyDisplayNameOverridesToHolders(cacheData.holders);
        cacheMedium(res);
        res.json(cacheData);
    } catch (err) { res.status(500).json({ holders: [], status: 'Error', error: err.message }); }
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
            oldestScannedBlock: state.oldestScannedBlock || 0
        });
    } catch (err) { res.status(500).json({ transactions: [], status: 'Error', error: err.message }); }
});
app.get('/api/transactions/older', async (req, res) => {
    if (!requireRpc(res)) return;
    const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 100);
    const maxBlocks = Math.min(readPositiveInteger(req.query.maxBlocks, TX_OLDER_SCAN_BLOCKS), 100000);
    try {
        const latestHeader = await globalApi.rpc.chain.getHeader();
        const latestBlock = latestHeader.number.toNumber();
        const beforeBlock = Math.min(parseInt(req.query.beforeBlock || latestBlock + 1, 10) || latestBlock + 1, latestBlock + 1);
        const scan = await scanFinancialTransactions({
            startBlock: Math.max(beforeBlock - 1, 0),
            limit,
            maxBlocks
        });

        res.json({
            transactions: scan.transactions,
            nextBeforeBlock: scan.nextBeforeBlock,
            scannedBlocks: scan.scannedBlocks,
            status: 'Synced'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/blocks', (req, res) => {
    try {
        const state = db.getSyncState('blocks');
        cacheShort(res);
        res.json({ blocks: db.getRecentBlocks(200), lastSync: state.lastSync || 0, status: state.status || 'Initializing' });
    } catch (err) { res.status(500).json({ blocks: [], status: 'Error', error: err.message }); }
});
app.get('/api/events', (req, res) => {
    try {
        const state = db.getSyncState('events');
        cacheShort(res);
        res.json({ events: db.getRecentEvents(500), lastSync: state.lastSync || 0, status: state.status || 'Initializing' });
    } catch (err) { res.status(500).json({ events: [], status: 'Error', error: err.message }); }
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
    } catch (err) { res.status(500).json({ error: err.message }); }
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
    } catch (err) { res.status(500).json({ error: err.message }); }
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
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/validator/:address', async (req, res) => {
    if (!requireRpc(res)) return;
    try {
        const address = req.params.address.trim();

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
    } catch (err) { res.status(500).json({ error: err.message }); }
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
            const free = Number(accountInfo.data.free) / 10 ** 12;
            const reserved = Number(accountInfo.data.reserved) / 10 ** 12;
            if (free > 0 || reserved > 0 || name !== "Unknown") return res.json({ type: 'account', data: { address: q, name: name, balance: free + reserved, free: free, reserved: reserved } });
        } catch (e) { }
        res.status(404).json({ error: 'No exact deep network match found.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/account/:address', async (req, res) => {
    const address = req.params.address.trim();
    if (!requireRpc(res)) return;
    try {
        const accountInfo = await globalApi.query.system.account(address);
        const name = await getIdentity(globalApi, address);
        const free = Number(accountInfo.data.free) / 10 ** 12;
        const reserved = Number(accountInfo.data.reserved) / 10 ** 12;

        let txs = [], evs = [], rank = "0";
        try {
            const holderRank = db.getHolderRank(address);
            if (holderRank) rank = holderRank.toString();
            txs = db.getTransactionsByAddress(address, 200);
            evs = db.getEventsByAddress(address, 200);
        } catch (e) { }

        res.json({ account: address, display: name, balanceTotal: free + reserved, balanceFree: free, balanceFrozen: reserved, roles: "User", rank: rank, transactions: txs, events: evs, status: 'Synced' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- STAKING REWARDS ENDPOINTS ---
app.get('/api/staking-rewards-status', (req, res) => {
    try {
        const s = db.getSyncState('staking_rewards');
        cacheMedium(res);
        res.json({
            latestScannedBlock: s.latestScannedBlock || 0,
            oldestScannedBlock: s.oldestScannedBlock || 0,
            backfillComplete: !!s.backfillComplete,
            addressesIndexed: db.countStakingRewardStashes(),
            totalRewardsIndexed: db.countStakingRewards(),
            lastSync: s.lastSync || 0,
            status: s.status || 'Initializing'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        const unclaimed = db.getUnclaimed(address).map(r => ({
            era: r.era, amount: r.amount, validator: r.validator || null, block: null,
            blockHash: null, eventIndex: null, timestamp: null, status: 'unclaimed'
        }));

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

        const claimedTotal = claimed.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
        const unclaimedTotal = unclaimed.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
        const eraSet = new Set([...claimed, ...unclaimed].filter(r => r.era != null).map(r => r.era));
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
                claimedTotal,
                claimedCount: claimed.length,
                unclaimedTotal,
                unclaimedCount: unclaimed.length,
                totalAmount: claimedTotal + unclaimedTotal,
                eraCount: eraSet.size,
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
        res.status(500).json({ error: err.message });
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
    } catch (err) { res.status(500).json({ error: err.message }); }
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
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- WALLET DASHBOARD ENDPOINT ---
// Summarize the governance crawler progress for the frontend.
function governanceHistoryMeta() {
    const s = db.getSyncState('governance');
    return {
        status: s.status || 'Initializing',
        backfillComplete: !!s.backfillComplete,
        oldestScannedBlock: Number(s.oldestScannedBlock) || 0,
        latestScannedBlock: Number(s.latestScannedBlock) || 0,
        lastSync: s.lastSync || 0
    };
}

app.get('/api/council', (req, res) => {
    try {
        const data = db.getKv('council') || { members: [], runnersUp: [], candidates: [], motions: [], blocksRemaining: 0, termDuration: 0, desiredMembers: 0, desiredRunnersUp: 0, collectivePallet: null };
        data.motionHistory = db.getCouncilMotions();
        data.history = governanceHistoryMeta();
        cacheLong(res);
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
        // can't do anything actionable about them. We treat "ongoing" and
        // "started" as open; everything else is closed.
        const isReferendumOpen = (r) =>
            r && (r.status === 'ongoing' || r.status === 'started');
        const openReferenda = referenda.filter(isReferendumOpen);
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
            const isActive = r.status === 'ongoing' || r.status === 'started';
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
            const isActive = p.status === 'proposed' || !p.status;
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
            const isActive = m.status === 'proposed' || !m.status;
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
const lastPostAt = new Map();

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

app.post('/api/auth/challenge', (req, res) => {
    const raw = (req.body && req.body.address || '').trim();
    if (!isValidAddress(raw)) return res.status(400).json({ error: 'Invalid wallet address.' });
    let address;
    try { address = normalizeAddress(raw); } catch (e) { return res.status(400).json({ error: 'Invalid wallet address.' }); }
    const nonce = randomAsHex(16);
    db.setChallenge(address, nonce);
    res.json({ address, message: challengeMessage(address, nonce) });
});

app.post('/api/auth/verify', (req, res) => {
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
    if (!valid) return res.status(401).json({ error: 'Signature verification failed.' });
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
const emailSignupAttempts = new Map(); // ip -> [{ts}, ...]

function emailSignupRateOk(ip) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const arr = (emailSignupAttempts.get(ip) || []).filter(t => t > cutoff);
    if (arr.length >= EMAIL_SIGNUP_RATE_LIMIT_PER_HOUR) {
        emailSignupAttempts.set(ip, arr);
        return false;
    }
    arr.push(Date.now());
    emailSignupAttempts.set(ip, arr);
    return true;
}

// Deep-merge user-submitted partial prefs into DEFAULT_EMAIL_PREFS so unknown
// keys are dropped and required structure stays intact. Defends against the
// frontend ever sending a malformed payload.
function normalizePrefs(input) {
    const out = JSON.parse(JSON.stringify(DEFAULT_EMAIL_PREFS));
    if (!input || typeof input !== 'object') return out;
    for (const cat of ['governance', 'network']) {
        if (input[cat] && typeof input[cat] === 'object') {
            for (const k of Object.keys(out[cat])) {
                if (typeof input[cat][k] === 'boolean') out[cat][k] = input[cat][k];
            }
        }
    }
    if (input.account && typeof input.account === 'object') {
        if (typeof input.account.walletAddress === 'string') {
            try { out.account.walletAddress = normalizeAddress(input.account.walletAddress); }
            catch (_) { out.account.walletAddress = null; }
        }
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
function siteOrigin(req) {
    if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
    return `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

// HTML-escape for token values that go into URLs and templates.
function htmlEscape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
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
    const ip = (req.headers['x-forwarded-for'] || req.ip || 'unknown').toString().split(',')[0].trim();
    if (!emailSignupRateOk(ip)) {
        return res.status(429).json({ error: 'Too many signup attempts. Please wait an hour.' });
    }
    const email = String((req.body && req.body.email) || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const prefs = normalizePrefs(req.body && req.body.prefs);
    const source = (req.body && req.body.source) || null;

    // Optional wallet-signature path. If the request includes a Bearer token
    // from /api/auth/verify, look up the session and pin the subscription to
    // that address so account-specific events can be wired later. Otherwise
    // walletAddress stays null and the subscriber is email-only.
    let walletAddress = null;
    const header = req.headers['authorization'] || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (bearer) {
        const sess = db.getSession(bearer);
        if (sess && sess.address) walletAddress = sess.address;
    }
    if (walletAddress) prefs.account.walletAddress = walletAddress;

    const confirmationToken = randomAsHex(24);
    const unsubscribeToken  = randomAsHex(24);
    const { created, subscriber } = db.createEmailSubscriberIfMissing({
        email, confirmationToken, unsubscribeToken, eventPrefs: prefs, source, walletAddress
    });

    // Already-confirmed row: short-circuit, no email.
    if (!created && subscriber && subscriber.confirmedAt) {
        return res.json({ status: 'already-confirmed', email: subscriber.email });
    }

    // For existing-but-not-confirmed rows we reuse the original tokens (the
    // confirmation link the user got earlier still works); we just resend
    // the email so they get a fresh link in their inbox.
    const effective = subscriber;
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

// GET /api/email/confirm?token=...
// Renders a friendly HTML page (so the link works directly from email clients).
app.get('/api/email/confirm', (req, res) => {
    const token = String(req.query.token || '').trim();
    const subscriber = db.confirmEmailSubscriber(token);
    res.set('Cache-Control', 'no-store');
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
               <p>You can <a href="/email/preferences?token=${encodeURIComponent(subscriber.unsubscribeToken)}">manage your preferences</a> or <a href="/api/email/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribeToken)}">unsubscribe</a> at any time.</p>`,
        isError: false
    }));
});

// GET /api/email/unsubscribe?token=...
app.get('/api/email/unsubscribe', (req, res) => {
    const token = String(req.query.token || '').trim();
    const subscriber = db.unsubscribeEmailSubscriber(token);
    res.set('Cache-Control', 'no-store');
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
    const token = String((req.body && req.body.token) || '').trim();
    const prefs = normalizePrefs(req.body && req.body.prefs);
    const subscriber = db.setEmailSubscriberPrefs(token, prefs);
    if (!subscriber) return res.status(404).json({ error: 'Subscription not found.' });
    res.json({ status: 'ok', prefs: subscriber.eventPrefs });
});

// GET /api/email/preferences?token=... — read current prefs for the modal.
app.get('/api/email/preferences', (req, res) => {
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
    res.set('Cache-Control', 'no-store');
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
const lastLabelWriteAt = new Map();          // signer -> timestamp; spam guard

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
        if (!viewer) cacheMedium(res);
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
        res.status(500).json({ error: err.message });
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

        // Spam guard — applies to suggestions on ANY address by the same
        // signer. Cleared by the next legitimate post; not persisted to
        // disk (memory-only per worker is fine — see also POST_COOLDOWN_MS
        // for the discussion board).
        const lastPost = lastLabelWriteAt.get(signer);
        if (lastPost && Date.now() - lastPost < LABEL_POST_COOLDOWN_MS) {
            const wait = Math.ceil((LABEL_POST_COOLDOWN_MS - (Date.now() - lastPost)) / 1000);
            return res.status(429).json({ error: `Please wait ${wait}s before submitting another label.` });
        }

        const label = String(req.body && req.body.label || '').trim();
        if (label.length < MIN_LABEL_LENGTH || label.length > MAX_LABEL_LENGTH) {
            return res.status(400).json({ error: `Label must be ${MIN_LABEL_LENGTH}–${MAX_LABEL_LENGTH} characters.` });
        }
        // Reject ASCII control chars and angle brackets — both for log-injection
        // hygiene and so the UI never has to escape user input it received as
        // "trusted".
        if (/[\x00-\x1f<>]/.test(label)) {
            return res.status(400).json({ error: 'Label contains disallowed characters.' });
        }

        db.upsertAddressLabel({ address, signer, label });
        lastLabelWriteAt.set(signer, Date.now());
        // Mirror the post-condition the GET endpoint returns so the client
        // can do an optimistic update without a re-fetch.
        res.json({ address, label, signer, isSelf: signer === address, ok: true });
    } catch (err) {
        console.error('API Error POST /api/labels/:address:', err);
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

// Vote on a label. Body: { vote: 1 | -1 | 0 }. 0 clears an existing vote.
// Voting on one's own row is harmless but a no-op for display ranking
// (self-labels skip the score check), so we don't reject it.
app.post('/api/labels/:address/:signer/vote', express.json({ limit: '1kb' }), (req, res) => {
    try {
        const voter = getAuthAddress(req);
        if (!voter) return res.status(401).json({ error: 'Sign in with your wallet first.' });
        const labelAddress = normalizeAddress((req.params.address || '').trim());
        const labelSigner  = normalizeAddress((req.params.signer  || '').trim());
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
        res.status(500).json({ error: err.message });
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
        const labelAddress = normalizeAddress((req.params.address || '').trim());
        const labelSigner  = normalizeAddress((req.params.signer  || '').trim());
        if (reporter === labelSigner) {
            return res.status(400).json({ error: 'You can\'t report your own label.' });
        }
        const reason = String(req.body && req.body.reason || '').trim();
        db.reportLabel({ labelAddress, labelSigner, reporter, reason });
        res.json({ ok: true });
    } catch (err) {
        console.error('API Error POST /api/labels/:address/:signer/report:', err);
        res.status(500).json({ error: err.message });
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
        const labelAddress = normalizeAddress((req.params.address || '').trim());
        const labelSigner  = normalizeAddress((req.params.signer  || '').trim());
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
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/discussions', (req, res) => {
    try {
        const kind = (req.query.kind === 'proposal' || req.query.kind === 'motion') ? req.query.kind : null;
        cacheMedium(res);
        res.json({ threads: db.getThreads(kind) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ANALYTICS ENDPOINTS ---
// Daily time-series aggregates derived from the existing chain index, plus
// a point-in-time snapshot of staking metrics from the network-info cache.
// Lives behind the same medium-cache TTL as other slow-moving lists so
// Cloudflare absorbs the bulk of traffic.
app.get('/api/analytics/timeseries', (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
        cacheMedium(res);
        // Standard UI ranges are pre-warmed into KV by the indexer — serve those
        // instantly. Any non-standard window falls back to a live aggregate
        // (rare; the UI only ever asks for 7/30/90/365).
        const cached = db.getKv('analytics_ts_' + days);
        if (cached && cached.series) return res.json(cached);
        const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
        res.json({ days, since: sinceTs, series: db.getDailyAnalytics(sinceTs), computedAt: Date.now() });
    } catch (err) {
        console.error('API Error /api/analytics/timeseries:', err);
        res.status(500).json({ error: err.message });
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
        cacheMedium(res);
        res.json({
            indexedBlocks:       counts.indexedBlocks ?? 0,
            indexedEvents:       counts.indexedEvents ?? 0,
            indexedTransactions: counts.indexedTransactions ?? 0,
            indexedReferenda:    counts.indexedReferenda ?? 0,
            indexedThreads:      counts.indexedThreads ?? 0,
            countsAt:            counts.computedAt ?? 0,
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
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/discussions/:id', (req, res) => {
    try {
        const thread = db.getThread(req.params.id);
        if (!thread) return res.status(404).json({ error: 'Discussion thread not found.' });
        res.json({ thread, posts: db.getPosts(thread.id) });
    } catch (err) { res.status(500).json({ error: err.message }); }
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

        const now = Date.now();
        if (now - (lastPostAt.get(address) || 0) < POST_COOLDOWN_MS) {
            return res.status(429).json({ error: 'You are posting too quickly — please wait a moment.' });
        }
        lastPostAt.set(address, now);

        let authorName = 'Unknown';
        try { authorName = await getIdentity(globalApi, address); } catch (e) { }
        db.createPost({ threadId: thread.id, author: address, authorName, content });
        res.json({ thread: db.getThread(thread.id), posts: db.getPosts(thread.id) });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
        const claimedTotal = claimed.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        const unclaimed = db.getUnclaimed(address);
        const unpaidTotal = unclaimed.reduce((s, r) => s + (Number(r.amount) || 0), 0);
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
            recentTransactions: db.getTransactionsByAddress(address, 10),
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
        res.status(500).json({ error: err.message });
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
        reconcileMotionThreads(motions);

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
        let latestScannedBlock = Number(state.latestScannedBlock) || 0;
        let oldestScannedBlock = Number(state.oldestScannedBlock) || 0;
        let backfillCursor = Number(state.backfillCursor) || 0;
        let backfillComplete = !!state.backfillComplete;

        if (!initialized) {
            initialized = true;
            latestScannedBlock = head;
            oldestScannedBlock = head;
            backfillCursor = head - 1;
            backfillComplete = (head - 1) < GOV_MIN_BLOCK;
        }

        // FORWARD PASS — blocks produced since the previous crawl.
        if (head > latestScannedBlock) {
            const fwd = await scanGovernanceRange({
                startBlock: head,
                stopBlock: latestScannedBlock + 1,
                maxBlocks: GOV_FORWARD_MAX,
                collectiveName
            });
            await applyGovernanceRecords(fwd.treasury, fwd.motions);
            latestScannedBlock = head;
            db.setSyncState('governance', { initialized, latestScannedBlock, oldestScannedBlock, backfillCursor, backfillComplete, lastSync: Date.now(), status: 'Backfilling' });
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

        db.setSyncState('governance', {
            initialized, latestScannedBlock, oldestScannedBlock, backfillCursor, backfillComplete,
            lastSync: Date.now(), status: backfillComplete ? 'Synced' : 'Backfilling'
        });
        console.log(`Governance indexer: blocks ${oldestScannedBlock}-${latestScannedBlock}, ${db.countTreasuryProposals()} treasury proposals, ${db.countCouncilMotions()} motions, backfill ${backfillComplete ? 'complete' : 'in progress'}.`);
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

async function dispatchToSubscribers({ eventKind, eventId, prefMatches, makeEmail }) {
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
                headers: { 'List-Unsubscribe': `<${tmpl.unsubscribeUrl}>` }
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
            console.warn(`[email] send to ${s.email} failed (${eventKind}/${eventId}):`, err && err.message ? err.message : err);
        }
    }
    if (sentCount > 0) {
        console.log(`[email] dispatched ${sentCount} ${eventKind} emails for ${eventId}`);
    }
}

// Build a versioned canonical site URL for use in email links. SITE_URL env
// is the authority; if missing we use the public domain since these mails
// are user-facing and need stable absolute URLs.
function emailSiteOrigin() {
    return (process.env.SITE_URL || 'https://explorer.polkadex.ee').replace(/\/+$/, '');
}

// Common email layout — keeps brand consistent across event types.
function emailLayout({ title, intro, ctaText, ctaHref, details, unsubscribeUrl }) {
    const origin = emailSiteOrigin();
    const text =
`${title}

${intro}

${details ? details + '\n\n' : ''}${ctaText}: ${ctaHref}

— Polkadex Mainnet Explorer
${origin}

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

async function dispatchGovernanceEmails({ referenda, publicProposals }) {
    // 1. New OPEN referenda — one email per ongoing referendum, idempotent
    //    by (event_kind='gov.new-ref', event_id=refIndex).
    for (const r of (referenda || [])) {
        if (r.status !== 'ongoing' && r.status !== 'started') continue;
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
            if (r.status !== 'ongoing' && r.status !== 'started') continue;
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

            validatorData.push({ address: addrStr, name: name, totalStake: formatPDEX(totalStake), commission: commissionPct, realApy: currentApy, avg30DayApy: currentApy });
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
        const balances = entries.map(([key, data]) => ({ address: key.args[0].toString(), free: Number(data.data.free) / 10 ** 12, reserved: Number(data.data.reserved) / 10 ** 12 }))
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
    const allEvents = (await getEventsAtBlock(hash)) || [];
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
    return { block, events };
}

// Scan an inclusive numeric range, processing blocks in parallel batches.
// Returns { blocks, events, attempts, succeeded, failedNumbers }.
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
    let succeeded = 0;

    for (let i = 0; i < numbers.length; i += BLOCKS_FETCH_CONCURRENCY) {
        const chunk = numbers.slice(i, i + BLOCKS_FETCH_CONCURRENCY);
        const results = await Promise.all(chunk.map(n => scanSingleBlock(n).catch(err => {
            console.warn(`[chain-index] block ${n} fetch failed: ${err && err.message ? err.message : err}`);
            return { __error: true, n };
        })));
        for (let j = 0; j < results.length; j++) {
            const r = results[j];
            if (r && !r.__error) {
                blocks.push(r.block);
                for (const e of r.events) events.push(e);
                succeeded++;
            } else {
                failedNumbers.push(chunk[j]);
            }
        }
    }
    return { blocks, events, attempts: numbers.length, succeeded, failedNumbers };
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
        let latestScannedBlock = Number(state.latestScannedBlock) || 0;
        let oldestScannedBlock = Number(state.oldestScannedBlock) || 0;
        let backfillCursor = Number(state.backfillCursor) || 0;
        let backfillComplete = !!state.backfillComplete;

        // First run: anchor watermarks to the current head; backfill will then
        // walk everything below it toward genesis on subsequent ticks.
        if (!initialized) {
            initialized = true;
            latestScannedBlock = head;
            oldestScannedBlock = head;
            backfillCursor = head - 1;
            backfillComplete = (head - 1) < BLOCKS_MIN_BLOCK;
        }

        // Set when a fetch fails this tick, so the gap-fill pass runs
        // immediately instead of waiting for its throttled cadence.
        let tickHadFailures = false;

        // 1) FORWARD PASS — index everything new since the last tick.
        if (head > latestScannedBlock) {
            if (head - latestScannedBlock > BLOCKS_FORWARD_MAX) {
                console.warn(`[chain-index] forward gap ${head - latestScannedBlock} exceeds cap; scanning newest ${BLOCKS_FORWARD_MAX} this tick — remainder will be picked up by gap-fill.`);
            }
            const forward = await scanChainRange(latestScannedBlock + 1, head, BLOCKS_FORWARD_MAX);
            if (forward.blocks.length) db.insertBlocks(forward.blocks);
            if (forward.events.length) db.insertEvents(forward.events);
            if (forward.failedNumbers && forward.failedNumbers.length) tickHadFailures = true;
            // Advance the watermark to head even if individual blocks failed —
            // the gap-fill pass will pick those up by name on subsequent ticks.
            latestScannedBlock = head;
            if (oldestScannedBlock === 0) oldestScannedBlock = head;
            db.setSyncState('chain_index', { initialized, latestScannedBlock, oldestScannedBlock, backfillCursor, backfillComplete, lastSync: Date.now(), status: 'Syncing' });
        }

        // 2) BACKFILL PASS — extend coverage one chunk toward genesis.
        if (!backfillComplete && backfillCursor >= BLOCKS_MIN_BLOCK) {
            const stop = Math.max(backfillCursor - BLOCKS_BACKFILL_CHUNK + 1, BLOCKS_MIN_BLOCK);
            const back = await scanChainRange(stop, backfillCursor, BLOCKS_BACKFILL_CHUNK);
            if (back.blocks.length) db.insertBlocks(back.blocks);
            if (back.events.length) db.insertEvents(back.events);
            if (back.failedNumbers && back.failedNumbers.length) tickHadFailures = true;
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
        if (doScan) {
            const sinceBlock = fullScan ? null : Math.max(BLOCKS_MIN_BLOCK, head - CHAIN_GAP_SCAN_WINDOW);
            gaps = db.getBlockGaps(1, sinceBlock);
            lastRecentGapScanAt = nowTs;
            if (fullScan) lastFullGapScanAt = nowTs;
            if (gaps.length) {
                const g = gaps[0];
                const chunkEnd = g.gapEnd;
                const chunkStart = Math.max(g.gapStart, g.gapEnd - BLOCKS_GAP_FILL_CHUNK + 1);
                const fill = await scanChainRange(chunkStart, chunkEnd, BLOCKS_GAP_FILL_CHUNK);
                if (fill.blocks.length) db.insertBlocks(fill.blocks);
                if (fill.events.length) db.insertEvents(fill.events);
                console.log(`[chain-index] gap-fill ${chunkStart}-${chunkEnd} (gap of ${g.gapSize}): ${fill.succeeded}/${fill.attempts} repaired`);
            }
        }

        db.setSyncState('chain_index', { initialized, latestScannedBlock, oldestScannedBlock, backfillCursor, backfillComplete, lastSync: Date.now(), status: 'Synced' });
        if (gaps.length || !backfillComplete) {
            console.log(`[chain-index] head=${head} indexed=${oldestScannedBlock}-${latestScannedBlock} (${db.countBlocks()} blocks), backfill=${backfillComplete ? 'complete' : 'in progress'}, known gaps=${gaps.length}`);
        }
    } catch (err) {
        logSyncError('Chain index sync', err);
        db.setSyncState('chain_index', { ...db.getSyncState('chain_index'), status: 'Error', error: err && err.message ? err.message : String(err) });
        noteSyncError('chain_index');
    } finally {
        isSyncingChain = false;
    }
}

async function syncBlocks() {
    if (isSyncingBlocks || !isRpcReady()) return;
    isSyncingBlocks = true;
    try {
        let currentHash = await globalApi.rpc.chain.getBlockHash();
        let blocksSearched = 0;
        const newBlocks = [];

        while (blocksSearched < 50) {
            try {
                const derivedBlock = await globalApi.derive.chain.getBlock(currentHash);
                if (!derivedBlock) break;
                const blockNumber = derivedBlock.block.header.number.toNumber();
                if (db.hasBlock(blockNumber)) break;
                const timestamp = getBlockTimestamp(derivedBlock);
                const authorAddr = derivedBlock.author ? derivedBlock.author.toString() : "System";
                newBlocks.push({ number: blockNumber, hash: derivedBlock.block.header.hash.toHex(), authorAddress: authorAddr, authorName: await getIdentity(globalApi, authorAddr), extrinsicsCount: derivedBlock.block.extrinsics.length, eventsCount: derivedBlock.events ? derivedBlock.events.length : 0, timestamp: timestamp });
                currentHash = derivedBlock.block.header.parentHash;
            } catch (e) {
                console.warn("Block crawler stopped early:", e.message);
                break;
            }
            blocksSearched++;
        }
        db.insertBlocks(newBlocks);
        db.setSyncState('blocks', { lastSync: Date.now(), status: 'Synced' });
    } catch (err) {
        logSyncError('Block sync', err);
        db.setSyncState('blocks', { ...db.getSyncState('blocks'), status: 'Error', error: err.message });
    } finally { isSyncingBlocks = false; }
}

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

        db.setSyncState('transactions', {
            lastSync: Date.now(),
            status: 'Synced',
            latestScannedBlock: latestBlock,
            oldestScannedBlock: needsInitialCrawl ? scan.oldestScannedBlock : (Number(state.oldestScannedBlock) || latestScannedBlock),
            scannedBlocks: previousScannedBlocks + scan.scannedBlocks,
            scannerVersion: FINANCIAL_TX_SCANNER_VERSION
        });
    } catch (err) {
        console.error("Transaction sync error:", err);
        db.setSyncState('transactions', { ...db.getSyncState('transactions'), status: 'Error', error: err.message });
        noteSyncError('transactions');
    } finally { isSyncingTx = false; }
}

async function syncEvents() {
    if (isSyncingEvents || !isRpcReady()) return;
    isSyncingEvents = true;
    try {
        let currentHash = await globalApi.rpc.chain.getBlockHash();
        let blocksSearched = 0;
        const newEvents = [];

        while (blocksSearched < 50) {
            try {
                const signedBlock = await getBlockCached(currentHash);
                // Block-bound metadata — events from this historical block
                // need its own runtime to decode (see getEventsAtBlock).
                const allEvents = await getEventsAtBlock(currentHash);
                if (!allEvents) { blocksSearched++; currentHash = signedBlock.block.header.parentHash; continue; }
                const blockNumber = signedBlock.block.header.number.toNumber();
                const timestamp = getBlockTimestamp(signedBlock);
                const blockHash = signedBlock.block.header.hash.toHex();

                for (let eventIndex = 0; eventIndex < allEvents.length; eventIndex++) {
                    const record = allEvents[eventIndex];
                    const eventId = `${blockHash}-${eventIndex}`;

                    const extrinsicIndex = record.phase.isApplyExtrinsic ? record.phase.asApplyExtrinsic.toNumber() : null;
                    const extrinsic = extrinsicIndex !== null ? signedBlock.block.extrinsics[extrinsicIndex] : null;
                    const signerAddress = extrinsic && extrinsic.isSigned ? extrinsic.signer.toString() : "System";
                    const txHash = extrinsic ? extrinsic.hash.toHex() : "";
                    const status = record.event.section === 'system' && record.event.method === 'ExtrinsicFailed' ? 'failed' : 'success';
                    const signerName = signerAddress !== "System" ? await getIdentity(globalApi, signerAddress) : "System";

                    newEvents.push({
                        hash: eventId,
                        txHash,
                        blockHash,
                        block: blockNumber,
                        eventIndex,
                        extrinsicIndex,
                        section: record.event.section,
                        method: record.event.method,
                        data: record.event.data.toHuman(),
                        signerAddress,
                        signerName,
                        timestamp,
                        status
                    });
                    }
                currentHash = signedBlock.block.header.parentHash;
            } catch (e) {
                console.warn("Event crawler stopped early:", e.message);
                break;
            }
            blocksSearched++;
        }
        db.insertEvents(newEvents);
        db.setSyncState('events', { lastSync: Date.now(), status: 'Synced' });
    } catch (err) {
        console.error("Event sync error:", err);
        db.setSyncState('events', { ...db.getSyncState('events'), status: 'Error', error: err.message });
    } finally { isSyncingEvents = false; }
}

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
            for (const sub of inner) {
                const result = findPayoutInfo(sub, depth + 1);
                // A batch can pay several validators in one era; only trust the
                // validator field when the batch holds a single call.
                if (result.era != null) {
                    return { era: result.era, validator: inner.length === 1 ? result.validator : null };
                }
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
        // No events decodable for this block — treat as a clean "no rewards"
        // scan so the gap-fill phase doesn't keep retrying a permanently-
        // un-decodable historical block.
        if (!events) return { rewards: [], ok: true };

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
        const blockHashHex = blockHash.toHex();

        const rewards = hits.map(({ record, parsed, eventIndex }) => {
            let era = null;
            let validator = null;
            if (record.phase.isApplyExtrinsic) {
                const exIndex = record.phase.asApplyExtrinsic.toNumber();
                const info = extractPayoutInfo(signedBlock.block.extrinsics[exIndex]);
                era = info.era;
                validator = info.validator;
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
        id: `${reward.block}-${reward.eventIndex}`,
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
        const claimedKeys = new Set(db.getClaimedRewardKeys(stash).map(k => `${k.era}|${k.validator || ''}`));
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
                // Skip anything already recorded as a claimed payout (defensive).
                if (claimedKeys.has(`${era}|${validator}`)) continue;
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

// Historical backfill lives in the standalone script
// `backfill-price-history.mjs` at the repo root — run it once against the
// SQLite DB to populate price_history with daily DefiLlama data going back
// to PDEX's first trading day (Dec 21, 2022). The indexer process itself
// only handles forward-going polling.

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
        let latestScannedBlock = Number(state.latestScannedBlock) || 0;
        let oldestScannedBlock = Number(state.oldestScannedBlock) || 0;
        let backfillCursor = Number(state.backfillCursor) || 0;
        let backfillComplete = !!state.backfillComplete;

        // First run: anchor watermarks to the current head; the resumable
        // backfill pass then walks everything below it.
        if (!initialized) {
            initialized = true;
            latestScannedBlock = head;
            oldestScannedBlock = head;
            backfillCursor = head - 1;
            backfillComplete = (head - 1) < STAKING_REWARDS_MIN_BLOCK;
        }

        // FORWARD PASS — index blocks produced since the previous crawl.
        if (head > latestScannedBlock) {
            if (head - latestScannedBlock > STAKING_REWARDS_FORWARD_MAX) {
                console.warn(`Staking rewards: forward gap ${head - latestScannedBlock} exceeds cap; scanning most recent ${STAKING_REWARDS_FORWARD_MAX} blocks.`);
            }
            const forward = await scanStakingRewards({
                startBlock: head,
                stopBlock: latestScannedBlock + 1,
                maxBlocks: STAKING_REWARDS_FORWARD_MAX
            });
            db.insertStakingRewards(forward.rewards.map(toRewardRow));
            latestScannedBlock = head;
            db.setSyncState('staking_rewards', { initialized, latestScannedBlock, oldestScannedBlock, backfillCursor, backfillComplete, lastSync: Date.now(), status: 'Syncing' });
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

        db.setSyncState('staking_rewards', { initialized, latestScannedBlock, oldestScannedBlock, backfillCursor, backfillComplete, lastSync: Date.now(), status: 'Synced' });
        console.log(`Staking rewards indexer: blocks ${oldestScannedBlock}-${latestScannedBlock}, ${db.countStakingRewards()} payouts indexed, backfill ${backfillComplete ? 'complete' : 'in progress'}.`);
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
        newApi = await ApiPromise.create({ provider: wsProvider });
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
        console.warn(`[CHAIN-WATCHDOG] chain head #${lastHeadValue} hasn't advanced in ${Math.round(sinceAdvance / 60000)} min — upstream node may have stalled`);
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
//      restored service. Exit the process; the Docker `restart: unless-stopped`
//      policy will spin up a fresh container. Last-resort backstop that should
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
        console.error(`[RPC-WATCHDOG] disconnected for ${outageMin} min, exceeds RPC_EXIT_AFTER_MS — exiting so Docker restarts the container`);
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
// SQLite handle, opens its own RPC WebSocket, and binds an HTTP listener on
// PORT. node:cluster shares the listening socket across workers, round-robin-
// balancing inbound connections. Each worker's globalApi/rpcConnected pair is
// process-local; the indexer worker is additionally the sole writer to SQLite
// (single-writer invariant under WAL).
function runWorker({ indexer }) {
    // DB init can throw (corrupt SQLite / unwritable bind mount after an
    // unclean reboot). Catch it so the process doesn't exit-loop under
    // `restart: unless-stopped`; the operator can then exec in and inspect.
    try {
        // Only the indexer worker seeds the O(1) row counters — it's the sole
        // writer, and seeding does a one-time COUNT(*) we don't want N workers
        // each repeating on a 20 GB+ database at startup.
        db.initDb(DATA_DIR, !!indexer);
    } catch (err) {
        console.error('FATAL: database init failed at ' + DATA_DIR + ' — serving may be degraded:', err && err.message ? err.message : err);
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

    if (indexer) startIndexerLoops();
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
    if (isPolkadotWsRequestTimeout(err)) {
        setImmediate(() => rebuildApiOnce('60s request timeout (exception)'));
    }
});

// ---- Bootstrap: cluster primary vs worker ---------------------------------
// Topology:
//   Primary (this file, run as the container's entrypoint) forks N workers.
//     - Worker 1 runs HTTP + indexer (INDEXER_ROLE=on).
//     - Workers 2..N run HTTP only.
//   Cluster automatically round-robins inbound connections across workers,
//   so all four cores get used for request serving. SQLite with WAL mode
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
const WORKERS = (() => {
    const raw = process.env.WORKERS;
    if (raw === '1' || raw === '0') return 1;
    const n = parseInt(raw || '', 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 16);
    // Default: one worker per CPU, capped at 8 so we don't blow up on
    // big-iron hosts (the indexer + RPC connection scale with neither cores
    // nor workers, so >8 is overkill for the explorer's read load).
    return Math.min(cpus().length, 8);
})();

function bootstrapCluster() {
    if (WORKERS <= 1) {
        // Single-process mode: behaves exactly like the pre-cluster code.
        runWorker({ indexer: true });
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

        cluster.on('exit', (worker, code, signal) => {
            const wasIndexer = indexerWorkerIds.has(worker.id);
            indexerWorkerIds.delete(worker.id);
            console.warn(`[cluster] worker ${worker.id} (pid ${worker.process.pid}) exited` +
                ` (code=${code}, signal=${signal || 'none'}, was-indexer=${wasIndexer}) — restarting`);
            // Preserve the single-indexer invariant: if the indexer worker
            // died, the replacement takes over that role; otherwise we just
            // fork a new HTTP-only worker.
            forkOne(wasIndexer ? 'indexer' : 'http');
        });
    } else {
        // Inside a worker — INDEXER_ROLE was set by the primary above.
        runWorker({ indexer: process.env.INDEXER_ROLE === 'on' });
    }
}

bootstrapCluster();
