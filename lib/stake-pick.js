// The automatic validator choice for the Stake PDEX card (design
// 2026-11-22-stake-card-simple-and-advanced.md, section 4; CEO decisions
// 2026-11-23: eight picks, no automatic re-pick for an existing staker).
//
// Pure: the only import is lib/stake-filters.js, so the gates G1 and G3 to G7
// are the same predicates "Suggested filters" uses in the picker, and the two
// cannot disagree. The return figure is the realized one from lib/stake-apr.js
// (perf[window], rewards actually paid per PDEX); the commission-only estimate
// in lib/apy.js is never read here (money rule M10).
//
// The gates, in order. A validator is eligible only if:
//   G1 it is in the active set this era
//   G2 it has a realized return for the window: status 'ok' (7 or more counted
//      eras for 28), finite and above zero
//   G3 it accepts new stake (not blocked)
//   G4 its commission is known, at most 10%, with no recent or pending raise
//   G5 it was not slashed in the last 84 eras
//   G6 it scored at least half the median points in 90% of its elected eras
//   G7 its stakers fit one payout page
//   G8 its return is at least lowRatio (75%) of the median return of the
//      validators passing G1 to G7
// No gate is ever relaxed to reach the count (rule M1): fewer picks, or none,
// is the correct result.

import { RECOMMENDED_PRESET, PREDICATES, applyFilters, identityGroup, perfFor } from './stake-filters.js';

export const PICK_COUNT = 8;
export const PICK_WINDOW = 28;
export const LOW_RETURN_RATIO = 0.75;
export const GATES = Object.freeze(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);

// The removal reasons a review gives (copy SC-164, in this order of checking).
export const UNHEALTHY = Object.freeze(['inactive', 'commission100', 'blocked', 'no-history', 'low-return', 'slashed']);

// The Suggested filters with identity 'any' and spread off: identity is a
// tie-break (requiring it can empty the pool), and the spread is applied by
// the rule itself, one per identity group, in rank order.
function gateState(window) {
    return { ...RECOMMENDED_PRESET, identity: 'any', spread: false, aprWindow: window, status: 'active' };
}

// Which stake-filters predicate stands for which gate.
const GATE_PREDICATES = [
    ['G1', ['status']],
    ['G3', ['notBlocked']],
    ['G4', ['maxCommission', 'noRecentRaise']],
    ['G5', ['noSlash']],
    ['G6', ['reliability']],
    ['G7', ['singlePage']]
];

function realized(v, window) {
    const p = perfFor(v, window);
    if (!p || p.status !== 'ok') return null;
    const apr = p.apr;
    return typeof apr === 'number' && Number.isFinite(apr) && apr > 0 ? apr : null;
}

// The first gate a validator fails, G1 to G7 (G8 needs the pool), or null.
function firstFailed(v, state, ctx, window) {
    for (const [gate, keys] of GATE_PREDICATES) {
        if (gate === 'G3' && realized(v, window) == null) return 'G2';
        if (keys.some(k => !PREDICATES[k](v, state, ctx))) return gate;
    }
    return null;
}

export function medianOf(values) {
    const s = values.filter(x => typeof x === 'number' && Number.isFinite(x)).slice().sort((a, b) => a - b);
    if (!s.length) return null;
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const IDENTITY_RANK = (v) => (v.identity && v.identity.verified ? 0 : v.identity && v.identity.hasIdentity ? 1 : 2);
const twoDp = (x) => Math.round(x * 100);
const numOr = (x, d) => (x == null || !Number.isFinite(Number(x)) ? d : Number(x));

// Rank: return at two decimals (what the user sees), highest first; then lower
// commission; then identity verified, has identity, none; then higher
// self-stake; then address ascending. Fully deterministic.
function compareRank(window) {
    return (a, b) => {
        const ra = twoDp(realized(a, window)), rb = twoDp(realized(b, window));
        if (ra !== rb) return rb - ra;
        const ca = numOr(a.commission, Infinity), cb = numOr(b.commission, Infinity);
        if (ca !== cb) return ca - cb;
        const ia = IDENTITY_RANK(a), ib = IDENTITY_RANK(b);
        if (ia !== ib) return ia - ib;
        const sa = numOr(a.selfStake, -Infinity), sb = numOr(b.selfStake, -Infinity);
        if (sa !== sb) return sb - sa;
        const xa = String(a.address), xb = String(b.address);
        return xa < xb ? -1 : xa > xb ? 1 : 0;
    };
}

const pickRow = (v, window, kept) => ({ address: v.address, name: v.name == null ? null : v.name, apr: realized(v, window), commission: v.commission == null ? null : Number(v.commission), kept });

// One validator's health for a review, or a kept validator's place in a pick:
// 'ok' or the first UNHEALTHY reason.
function healthOf(v, { median, activeEra, window, lowRatio }) {
    if (!v || !v.active) return 'inactive';
    if (Number(v.commission) >= 100) return 'commission100';
    if (v.blocked) return 'blocked';
    const apr = realized(v, window);
    if (apr == null) return 'no-history';
    if (median != null && apr + 1e-9 < lowRatio * median) return 'low-return';
    if (!PREDICATES.noSlash(v, { noSlash: true }, { activeEra })) return 'slashed';
    return 'ok';
}

function byAddressOf(validators) {
    const m = new Map();
    for (const v of validators || []) if (v && v.address != null) m.set(String(v.address), v);
    return m;
}

// validators: snapshot rows (/api/staking/validator-choice). meta: { activeEra,
// pageSize, full }. opts: { count, quota, window, keep, lowRatio }.
// keep: addresses already chosen that stay (an existing staker's healthy
// validators); they come first, take their identity groups, and the rest is
// filled by rank. A kept validator that is not healthy (healthOf) is dropped.
export function pickValidators(validators, meta = {}, opts = {}) {
    const window = opts.window || PICK_WINDOW;
    const lowRatio = opts.lowRatio == null ? LOW_RETURN_RATIO : Number(opts.lowRatio);
    const count = opts.count == null ? PICK_COUNT : Number(opts.count);
    const quota = opts.quota == null || !(Number(opts.quota) > 0) ? Infinity : Number(opts.quota);
    const want = Math.max(0, Math.min(count, quota));
    const rejected = Object.fromEntries(GATES.map(g => [g, 0]));
    const list = Array.isArray(validators) ? validators : [];
    if (!meta || meta.full !== true) return { status: 'no-data', picks: [], median: null, pool: 0, rejected };

    const ctx = { activeEra: meta.activeEra, pageSize: meta.pageSize };
    const state = gateState(window);
    // G1, G3 to G7 through applyFilters (the picker's own path), then G2.
    const passFilters = new Set(applyFilters(list, state, ctx));
    const g17 = [];
    for (const v of list) {
        const fail = firstFailed(v, state, ctx, window);
        // Both must agree: the gate list here and the Suggested filters path.
        if (!fail && passFilters.has(v)) g17.push(v);
        else rejected[fail || 'G1']++;
    }
    const median = medianOf(g17.map(v => realized(v, window)));
    const pool = [];
    for (const v of g17) {
        if (median != null && realized(v, window) + 1e-9 < lowRatio * median) rejected.G8++;
        else pool.push(v);
    }
    const ranked = pool.slice().sort(compareRank(window));

    const byAddress = byAddressOf(list);
    const picks = [];
    const taken = new Set();
    const groups = new Set();
    for (const a of Array.isArray(opts.keep) ? opts.keep : []) {
        const v = byAddress.get(String(a));
        if (!v || taken.has(v.address)) continue;
        if (healthOf(v, { median, activeEra: meta.activeEra, window, lowRatio }) !== 'ok') continue;
        picks.push(pickRow(v, window, true));
        taken.add(v.address);
        groups.add(identityGroup(v) || 'self:' + v.address);
    }
    for (const v of ranked) {
        if (picks.length >= want) break;
        if (taken.has(v.address)) continue;
        const g = identityGroup(v) || 'self:' + v.address;
        if (groups.has(g)) continue;
        picks.push(pickRow(v, window, false));
        taken.add(v.address);
        groups.add(g);
    }
    const status = !picks.length ? 'none' : picks.length < want ? 'short' : 'ok';
    return { status, picks, median, pool: pool.length, rejected };
}

// An existing staker's validators, one row each: 'ok' or why it is not
// earning for them (UNHEALTHY). keep: the healthy ones, in their order.
export function reviewNominations(current, byAddress, { median = null, activeEra = null, window = PICK_WINDOW, lowRatio = LOW_RETURN_RATIO } = {}) {
    const get = (a) => (byAddress && typeof byAddress.get === 'function' ? byAddress.get(String(a)) : byAddress ? byAddress[a] : null);
    const rows = (current || []).map(a => {
        const v = get(a);
        return { address: String(a), state: healthOf(v, { median, activeEra, window, lowRatio }), apr: v ? realized(v, window) : null };
    });
    return { rows, unhealthy: rows.filter(r => r.state !== 'ok').length, keep: rows.filter(r => r.state === 'ok').map(r => r.address) };
}

// What the simple view offers an existing staker (decision Q2): nothing when
// every validator earns; otherwise a replacement that keeps every healthy one
// and fills the rest by the rule, as Kept, Removed (with the reason) and Added.
// It is only an offer: the caller signs nothing until the user confirms.
export function proposeReplacement(current, validators, meta = {}, opts = {}) {
    const window = opts.window || PICK_WINDOW;
    const lowRatio = opts.lowRatio == null ? LOW_RETURN_RATIO : Number(opts.lowRatio);
    if (!meta || meta.full !== true) return { offer: false, status: 'no-data', kept: [], removed: [], added: [], targets: (current || []).map(String) };
    const base = pickValidators(validators, meta, { ...opts, keep: [] });
    const review = reviewNominations(current, byAddressOf(validators), { median: base.median, activeEra: meta.activeEra, window, lowRatio });
    if (!review.unhealthy) return { offer: false, status: 'ok', review, kept: review.keep, removed: [], added: [], targets: review.keep.slice() };
    const count = Math.max(opts.count == null ? PICK_COUNT : Number(opts.count), review.keep.length);
    const pick = pickValidators(validators, meta, { ...opts, count, keep: review.keep });
    const kept = pick.picks.filter(p => p.kept).map(p => p.address);
    const added = pick.picks.filter(p => !p.kept).map(p => p.address);
    const removed = review.rows.filter(r => r.state !== 'ok').map(r => ({ address: r.address, reason: r.state }));
    return { offer: true, status: pick.status, review, kept, removed, added, targets: kept.concat(added) };
}

// The past return range of a set of validators: only active ones with a
// realized figure count. { none: 'no-data' } when none is known at all,
// { none: 'no-history' } when none has history yet.
export function returnEstimate(addresses, byAddress, window = PICK_WINDOW) {
    const get = (a) => (byAddress && typeof byAddress.get === 'function' ? byAddress.get(String(a)) : byAddress ? byAddress[a] : null);
    const found = (addresses || []).map(get).filter(Boolean);
    if (!found.length) return { none: 'no-data' };
    const aprs = found.filter(v => v.active).map(v => realized(v, window)).filter(x => x != null);
    if (!aprs.length) return { none: 'no-history' };
    return { low: Math.min(...aprs), high: Math.max(...aprs), counted: aprs.length, missing: (addresses || []).length - aprs.length };
}
