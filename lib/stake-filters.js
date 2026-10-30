// Filters, sort and the Suggested filters preset for the stake picker.
//
// Pure and import-free: runs in Node tests and in the browser. The data is a
// validator row from /api/staking/validator-choice (see
// lib/stake-choice-sync.js), or the thinner /api/validators row when that
// endpoint is still initializing; every predicate below treats a missing field
// as "unknown" and fails closed only where passing would mislead (a filter the
// user switched on must not let through a validator it cannot check).

import { DEFAULT_APR_WINDOW, APR_WINDOWS } from './stake-apr.js';

export const STORAGE_KEY = 'pdex_stake_filters_v1';
export const SLASH_LOOKBACK_ERAS = 84;
export const EXPOSURE_PAGE_SIZE = 256;
// The 392 nominations quota (MAX_QUOTA_NOMINATIONS), used only when the chain
// value is unavailable; lib/stake-choice-sync.js reads the real one.
export const FALLBACK_MAX_NOMINATIONS = 16;

export const SORTS = {
    apr:         { label: 'Highest APR' },
    commission:  { label: 'Lowest commission' },
    totalStake:  { label: 'Most total stake' },
    selfStake:   { label: 'Most self-stake' },
    reliability: { label: 'Most reliable' },
    name:        { label: 'Name A to Z' }
};

// What a first-time visitor sees: the whole active set minus the three things
// almost nobody wants (100% commission, nominations blocked, a recent slash),
// highest past APR first.
export const DEFAULT_FILTERS = Object.freeze({
    status: 'active',          // 'active' | 'waiting' | 'all'
    maxCommission: 99,         // percent, inclusive; 100 = no limit
    noRecentRaise: false,
    identity: 'any',           // 'any' | 'has' | 'verified'
    notBlocked: true,
    reliability: '',           // '' | 'nomiss' | '90' | '100'
    singlePage: false,
    minSelfStake: 0,           // PDEX
    noSlash: true,
    spread: false,
    aprWindow: DEFAULT_APR_WINDOW,
    sort: 'apr'
});

// "Suggested filters" (key `recommended`, kept so saved state and the
// data-preset hook do not change): a starting point the user can then adjust. Active, commission
// at most 10%, no recent or pending raise, an on-chain identity, reliable in
// 90% of eras, room on one payout page, not slashed, not blocking, one pick per
// identity, sorted by past APR over 28 eras.
export const RECOMMENDED_PRESET = Object.freeze({
    status: 'active',
    maxCommission: 10,
    noRecentRaise: true,
    identity: 'has',
    notBlocked: true,
    reliability: '90',
    singlePage: true,
    minSelfStake: 0,
    noSlash: true,
    spread: true,
    aprWindow: 28,
    sort: 'apr'
});

// Plain-language "why this matters" lines, one per filter, for the tooltips.
export const WHY = {
    status: 'Only validators in the active set earn rewards this era. Waiting ones may be elected later, but pay nothing until they are.',
    maxCommission: 'Commission is the cut a validator keeps before sharing rewards. Lower commission leaves more for you.',
    noRecentRaise: 'Some validators lower commission to attract nominators, then raise it. A recent or pending raise is a warning sign.',
    identity: 'An on-chain identity links a validator to a public name. A verified identity has been checked by a registrar.',
    notBlocked: 'A validator can block new nominations. Picking one that blocks them means your nomination will not count.',
    reliability: 'Era points measure blocks produced. A validator far below the median, or with zero points, earned less for its nominators.',
    singlePage: 'Every backer is paid, but more than 256 backers splits payouts into pages and each page needs its own payout claim.',
    minSelfStake: 'Self-stake is the validator\'s own PDEX at risk. More of it means the operator has more to lose from a slash.',
    noSlash: 'A slash is a penalty for misbehaviour that also takes from nominators. A recent one can be a sign of operational trouble.',
    spread: 'Validators under the same on-chain identity are run by the same registered party. Spreading picks lowers the chance that one problem hits all of them.',
    aprWindow: 'APR is measured from rewards actually paid in past eras. A longer window is steadier; a shorter one reacts faster.',
    sort: 'Changes the order only. Past APR is history, not a guarantee.'
};

const STATUS = new Set(['active', 'waiting', 'all']);
const IDENTITY = new Set(['any', 'has', 'verified']);
const RELIABILITY = new Set(['', 'nomiss', '90', '100']);

function num(v, lo, hi, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(Math.max(n, lo), hi);
}

// Whatever came out of localStorage (or a preset) back to a valid state.
export function sanitizeFilters(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const d = DEFAULT_FILTERS;
    return {
        status: STATUS.has(r.status) ? r.status : d.status,
        maxCommission: num(r.maxCommission, 0, 100, d.maxCommission),
        noRecentRaise: typeof r.noRecentRaise === 'boolean' ? r.noRecentRaise : d.noRecentRaise,
        identity: IDENTITY.has(r.identity) ? r.identity : d.identity,
        notBlocked: typeof r.notBlocked === 'boolean' ? r.notBlocked : d.notBlocked,
        reliability: RELIABILITY.has(String(r.reliability ?? '')) ? String(r.reliability ?? '') : d.reliability,
        singlePage: typeof r.singlePage === 'boolean' ? r.singlePage : d.singlePage,
        minSelfStake: num(r.minSelfStake, 0, 1e12, d.minSelfStake),
        noSlash: typeof r.noSlash === 'boolean' ? r.noSlash : d.noSlash,
        spread: typeof r.spread === 'boolean' ? r.spread : d.spread,
        aprWindow: APR_WINDOWS.includes(Number(r.aprWindow)) ? Number(r.aprWindow) : d.aprWindow,
        sort: Object.prototype.hasOwnProperty.call(SORTS, r.sort) ? r.sort : d.sort
    };
}

// localStorage is optional: private mode, a full quota or a disabled store all
// throw, and none of them may break the picker.
export function loadFilters(storage) {
    try {
        const raw = storage && storage.getItem(STORAGE_KEY);
        return sanitizeFilters(raw ? JSON.parse(raw) : null);
    } catch (e) {
        return sanitizeFilters(null);
    }
}
export function saveFilters(storage, state) {
    try {
        if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(sanitizeFilters(state)));
        return true;
    } catch (e) {
        return false;
    }
}

export function perfFor(v, window) {
    return v && v.perf ? v.perf[String(window)] || null : null;
}

// The on-chain identity a validator sits under: its superOf parent, or itself
// when it holds the identity directly. Null without an identity, so anonymous
// validators are never grouped together.
export function identityGroup(v) {
    const id = v && v.identity;
    if (!id || !id.hasIdentity) return null;
    return id.parent || v.address;
}

export function selectedGroups(selectedAddresses, byAddress) {
    const groups = new Map();
    for (const a of selectedAddresses || []) {
        const g = identityGroup(byAddress.get ? byAddress.get(a) : byAddress[a]);
        if (!g) continue;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(a);
    }
    return groups;
}

// Each predicate: (v, state, ctx) => boolean. ctx = { activeEra, pageSize, selected: Set, groups: Map }.
export const PREDICATES = {
    status: (v, s) => s.status === 'all' || (s.status === 'active' ? !!v.active : !v.active),
    maxCommission: (v, s) => {
        if (s.maxCommission >= 100) return true;
        const c = Number(v.commission);
        return v.commission != null && Number.isFinite(c) && c <= s.maxCommission;
    },
    noRecentRaise: (v, s) => !s.noRecentRaise
        || !(v.commissionHistory && (v.commissionHistory.raisedRecently || v.commissionHistory.pendingRaise)),
    identity: (v, s) => s.identity === 'any'
        || (s.identity === 'has' ? !!(v.identity && v.identity.hasIdentity) : !!(v.identity && v.identity.verified)),
    notBlocked: (v, s) => !s.notBlocked || !v.blocked,
    reliability: (v, s) => {
        if (!s.reliability) return true;
        const p = perfFor(v, s.aprWindow);
        if (!p || !p.electedEras) return false;
        if (s.reliability === 'nomiss') return p.missedEras === 0;
        return p.reliability != null && p.reliability >= Number(s.reliability) - 1e-9;
    },
    singlePage: (v, s, ctx) => {
        if (!s.singlePage) return true;
        // The chain's own page count when the validator is elected; a page
        // holds up to `size` backers, so exactly `size` is still one page.
        if (v.exposurePages != null && Number.isFinite(Number(v.exposurePages))) return Number(v.exposurePages) <= 1;
        const size = (ctx && ctx.pageSize) || EXPOSURE_PAGE_SIZE;
        const n = v.exposureNominators != null ? v.exposureNominators : v.backers;
        return n != null && Number(n) <= size;
    },
    minSelfStake: (v, s) => !(s.minSelfStake > 0) || (v.selfStake != null && Number(v.selfStake) >= s.minSelfStake),
    noSlash: (v, s, ctx) => {
        if (!s.noSlash) return true;
        const eras = Array.isArray(v.slashEras) ? v.slashEras : [];
        const from = ctx && ctx.activeEra ? ctx.activeEra - SLASH_LOOKBACK_ERAS : -Infinity;
        return !eras.some(e => Number(e) >= from);
    },
    spread: (v, s, ctx) => {
        if (!s.spread || !ctx || !ctx.groups) return true;
        if (ctx.selected && ctx.selected.has(v.address)) return true;
        const g = identityGroup(v);
        return !g || !ctx.groups.has(g);
    }
};
export const FILTER_KEYS = Object.keys(PREDICATES);

export function matchesSearch(v, search) {
    const f = String(search || '').trim().toLowerCase();
    if (!f) return true;
    return String(v.name || '').toLowerCase().includes(f) || String(v.address || '').toLowerCase().includes(f);
}

function passes(v, state, ctx, skip) {
    for (const k of FILTER_KEYS) {
        if (k === skip) continue;
        if (!PREDICATES[k](v, state, ctx)) return false;
    }
    return matchesSearch(v, ctx && ctx.search);
}

export function applyFilters(validators, state, ctx = {}) {
    const s = sanitizeFilters(state);
    return (validators || []).filter(v => passes(v, s, ctx, null));
}

// Counts for the UI:
//   shown        validators passing every filter
//   total        all validators
//   hiddenBy[k]  how many more would show if filter k alone were switched off
//   status       { active, waiting, all } with every other filter applied
export function filterCounts(validators, state, ctx = {}) {
    const s = sanitizeFilters(state);
    const list = validators || [];
    const shown = list.filter(v => passes(v, s, ctx, null)).length;
    const hiddenBy = {};
    for (const k of FILTER_KEYS) {
        hiddenBy[k] = list.filter(v => passes(v, s, ctx, k)).length - shown;
    }
    const others = list.filter(v => passes(v, s, ctx, 'status'));
    const active = others.filter(v => v.active).length;
    return { shown, total: list.length, hiddenBy, status: { active, waiting: others.length - active, all: others.length } };
}

// Sort key per option; null sorts last whichever way. `dir` 1 ascending, -1 descending.
const SORT_KEYS = {
    apr: { dir: -1, key: (v, s) => { const p = perfFor(v, s.aprWindow); return p && p.status === 'ok' ? p.apr : null; },
        // Among validators without a number, 'new' above 'none'.
        tie: (v, s) => { const p = perfFor(v, s.aprWindow); return p && p.status === 'new' ? 0 : 1; } },
    commission: { dir: 1, key: v => (v.commission == null ? null : Number(v.commission)) },
    totalStake: { dir: -1, key: v => (v.totalStake == null ? null : Number(v.totalStake)) },
    selfStake: { dir: -1, key: v => (v.selfStake == null ? null : Number(v.selfStake)) },
    reliability: { dir: -1, key: (v, s) => { const p = perfFor(v, s.aprWindow); return p && p.reliability != null ? p.reliability : null; } },
    name: { dir: 1, key: v => String(v.name && v.name !== 'Unknown' ? v.name : v.address || '').toLowerCase() }
};

// Stable: equal keys keep their incoming order, so a re-sort never shuffles
// rows the user is looking at.
export function sortValidators(validators, state) {
    const s = sanitizeFilters(state);
    const spec = SORT_KEYS[s.sort];
    return (validators || []).map((v, i) => ({ v, i })).sort((a, b) => {
        const ka = spec.key(a.v, s), kb = spec.key(b.v, s);
        const na = ka == null || (typeof ka === 'number' && !Number.isFinite(ka));
        const nb = kb == null || (typeof kb === 'number' && !Number.isFinite(kb));
        if (na !== nb) return na ? 1 : -1;
        if (na && nb) {
            if (spec.tie) { const d = spec.tie(a.v, s) - spec.tie(b.v, s); if (d) return d; }
            return a.i - b.i;
        }
        if (ka < kb) return -1 * spec.dir;
        if (ka > kb) return 1 * spec.dir;
        return a.i - b.i;
    }).map(x => x.v);
}
