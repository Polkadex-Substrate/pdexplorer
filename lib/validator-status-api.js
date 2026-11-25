// Three read-only routes for the Validate page (design section 6):
//
//   GET /api/validator/params           live governance values and the key
//                                       layout; cached 60 s, Medium tier; an
//                                       RPC blip serves the last good value
//                                       (stale: true), as getMinNominatorBondCached
//   GET /api/validator/:address/status  lib/validator-status.js's model; kept
//                                       30 s per address in memory, Short tier;
//                                       rate limited per IP, concurrent reads
//                                       of one address share one node read.
//                                       ?fresh=1 (R5, after an action) bypasses
//                                       the 30 s memo, no-store, and refills it;
//                                       a fresh read within FRESH_REUSE_MS of the
//                                       stash's last node read is served from it.
//                                       Every body carries freshness.chainHead:
//                                       the node head read BEFORE the state (a
//                                       lower bound), null when it cannot be read
//   GET /api/session-keys/check?keys=0x..&for=ADDRESS
//                                       per-key KeyOwner / QueuedKeys result;
//                                       no-store, rate limited per IP
//
// The keys check only ever receives public keys. Input is refused unless it is
// hex of the live layout's length; a secret phrase is refused by the same rule
// before anything is read. Nothing here logs the query string (serverError gets
// req.path, which has none).
//
// The routes exist with FEATURE_FLAGS.validate off: they are read-only.
// server.js registers them BEFORE /api/validator/:address, or "params" would be
// taken for an address.
//
// No imports of server state: server.js passes the api getter, the gates, the
// cache helpers, the incident lookup and the identity lookup.

import { readValidatorStatus, readValidatorParams, readKeyOwners } from './validator-status-chain.js';
import { validatorStatusModel } from './validator-status.js';
import { parseSessionKeys, classifyKeyOwners, keyCheckSummary, layoutMismatchText, MAX_INPUT_CHARS } from './session-keys.js';
import { checkWindow, perWorkerLimit } from './rate-limit.js';

export const VALIDATOR_PARAMS_ROUTE = '/api/validator/params';
export const VALIDATOR_STATUS_ROUTE = '/api/validator/:address/status';
export const SESSION_KEYS_CHECK_ROUTE = '/api/session-keys/check';
export const PARAMS_TTL_MS = 60_000;
export const STATUS_TTL_MS = 30_000;
// R5: a ?fresh=1 read within this long of the stash's last node read is served from that read.
export const FRESH_REUSE_MS = 2_000;
const STATUS_MEMO_MAX = 500;

// Per-process sliding window, divided across the cluster's workers (the same
// trade as the developer API limiter, lib/rate-limit.js).
export function createKeyCheckLimiter({ perMinute = 30, workers = 1, now = () => Date.now() } = {}) {
    const limit = perWorkerLimit(perMinute, workers);
    const hits = new Map();
    return function allowed(ip) {
        const key = String(ip || 'unknown');
        const r = checkWindow(hits.get(key), { now: now(), windowMs: 60_000, limit });
        if (r.kept.length) hits.set(key, r.kept); else hits.delete(key);
        if (hits.size > 10_000) hits.delete(hits.keys().next().value);
        return r.allowed;
    };
}

const noStore = (res) => res.set('Cache-Control', 'no-store');

// The node's best block, for freshness: a bounded read, null when unknown (never caught up).
async function readHead(api) {
    let timer = null;
    try {
        const h = await Promise.race([api.rpc.chain.getHeader(), new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500); })]);
        const n = h && h.number ? Number(h.number.toNumber()) : NaN;
        return Number.isFinite(n) && n > 0 ? n : null;
    } catch (e) { return null; } finally { if (timer) clearTimeout(timer); }
}

export function registerValidatorRoutes(app, { api, ready, gate, parseAddress, cacheShort, cacheMedium, serverError, incidents = null, nameOf = null, rateOk = () => true, statusRateOk = () => true, now = () => Date.now(), head = null }) {
    let last = null, lastAt = 0, inflight = null;
    // Fresh params, or the last good ones through a failure.
    async function params() {
        if (last && now() - lastAt < PARAMS_TTL_MS) return last;
        if (!inflight) {
            inflight = readValidatorParams(api()).then((p) => { last = p; lastAt = now(); return p; }).finally(() => { inflight = null; });
        }
        try { return await inflight; } catch (e) { if (last) return { ...last, stale: true }; throw e; }
    }

    const memo = new Map();   // address -> { at, body }
    const reading = new Map();   // address -> the read in flight, shared by concurrent requests

    app.get(VALIDATOR_PARAMS_ROUTE, async (req, res) => {
        try {
            if (!last && !ready(res)) return;
            const p = await params();
            cacheMedium(res);
            res.json(p);
        } catch (err) { serverError(res, err, req.path); }
    });

    app.get(VALIDATOR_STATUS_ROUTE, async (req, res) => {
        const g = gate(req, res);
        if (!g) return;
        if (!statusRateOk(req)) { noStore(res); return res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many lookups from this address. Wait a minute and try again.' }); }
        const fresh = req.query && req.query.fresh === '1';
        const hit = memo.get(g.address);
        if (hit && now() - hit.at < (fresh ? FRESH_REUSE_MS : STATUS_TTL_MS)) { if (fresh) noStore(res); else cacheShort(res); return res.json(hit.body); }
        if (!ready(res)) return;
        try {
            let read = reading.get(g.address);
            if (!read) {
                const at = now();
                // The head first: the state read after it is at least that block (freshness, R5).
                read = Promise.resolve(typeof head === 'function' ? Promise.resolve().then(head).catch(() => null) : readHead(api()))
                    .then((h) => Promise.all([readValidatorStatus(api(), g.address, { incidents, nameOf }), params().catch(() => ({})), h]))
                    .then(([snap, p, h]) => {
                        const chainHead = Number.isFinite(Number(h)) && Number(h) > 0 && h !== null ? Number(h) : null;
                        const body = { ...validatorStatusModel(snap, p), address: g.address, freshness: { v: 1, chainHead } };
                        memo.delete(g.address);
                        memo.set(g.address, { at, body });
                        if (memo.size > STATUS_MEMO_MAX) memo.delete(memo.keys().next().value);
                        return body;
                    })
                    .finally(() => { reading.delete(g.address); });
                reading.set(g.address, read);
            }
            const body = await read;
            if (fresh) noStore(res); else cacheShort(res);
            res.json(body);
        } catch (err) { serverError(res, err, req.path); }
    });

    app.get(SESSION_KEYS_CHECK_ROUTE, async (req, res) => {
        noStore(res);
        if (!rateOk(req)) return res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many checks from this address. Wait a minute and try again.' });
        const raw = typeof req.query.keys === 'string' ? req.query.keys : '';
        const forRaw = typeof req.query.for === 'string' ? req.query.for.trim() : '';
        let stash = '';
        if (forRaw) {
            stash = parseAddress(forRaw) || '';
            if (!stash) return res.status(400).json({ code: 'BAD_ADDRESS', error: 'Invalid Polkadex address.' });
        }
        // Cheap refusals first, before the node is asked anything.
        const pre = parseSessionKeys(raw.slice(0, MAX_INPUT_CHARS + 1), { layout: [] });
        if (!pre.ok && pre.code !== 'length' && pre.code !== 'single') return res.status(400).json({ code: pre.code, error: pre.message });
        if (raw.length > MAX_INPUT_CHARS) return res.status(400).json({ code: 'length', error: 'This is longer than a session keys line. Run author_rotateKeys on a node that is fully synced.' });
        if (!ready(res)) return;
        try {
            const p = await params();
            if (!p.layout || !p.layout.ok) return res.status(409).json({ code: 'LAYOUT_MISMATCH', error: layoutMismatchText(p.specVersion), reason: p.layout ? p.layout.reason : '' });
            const parsed = parseSessionKeys(raw, { layout: p.layout.layout, specVersion: p.specVersion });
            if (!parsed.ok) return res.status(400).json({ code: parsed.code, error: parsed.message });
            const chain = await readKeyOwners(api(), parsed.keys, stash);
            const result = classifyKeyOwners(parsed.keys, { ...chain, stash });
            res.json({ ok: true, for: stash || null, specVersion: p.specVersion, bytes: parsed.bytes, warnings: parsed.warnings,
                conflict: result.conflict, sameAsNext: result.sameAsNext, rows: result.rows, summary: keyCheckSummary(result, parsed.keys) });
        } catch (err) { serverError(res, err, req.path); }
    });
}
