// The freshness field (design cto-team/plans/2026-11-22-post-action-refresh-design.md, sections 0, 2.2, 2.3,
// 2.5 and 5; sprint R2). Import-free, no DOM, used by the server and the page.
//
// Server: buildFreshness() turns the indexers' sync state into
//   { v: 1, chainHead, indexed: { chain, rewards, tx }, since: { chain, rewards, tx },
//     kv: { council, democracy, treasury }, pending: [domain], intervalMs: { chain, rewards, tx } }
//   chainHead  the route's node best block, read BEFORE its state queries (a lower bound of what it read)
//   indexed.X  the highest block up to which indexer X has every block, with no hole, counted from since.X
//              (chain = chain_index, rewards = staking_rewards, tx = transactions). The window keeps an old
//              permanent hole (a pruned height far back) from pinning a live domain for ever; a reader asks
//              about a block it just saw included, which is always inside it.
//   kv.X       governance snapshots (R4): the snapshot's atBlock (the head its sync read before its queries),
//              lowered by the route to the governance history index where it serves that index (kvMark)
//   pending    domains whose copy in THIS response is known to be behind its watermark (the unpaid list
//              while the stash's unclaimed cache is being recomputed or was marked stale)
//   intervalMs the indexers' tick intervals as configured (Q6: production may override the defaults)
// Every unknown value is null, never 0 or NaN: null is never caught up.
//
// Page: caughtUp(domain, freshness, block) reads SOURCE[domain] (where the domain's server copy comes from).

export const SOURCE = Object.freeze({ balance: 'chain', 'staking.ledger': 'chain', 'staking.nominations': 'chain',
    locks: 'chain', proxies: 'chain', 'multisig.pending': 'chain', 'treasury.spends': 'chain',
    'rewards.unpaid': 'indexed.chain', identity: 'indexed.chain', 'rewards.claimed': 'indexed.rewards',
    'tx.recent': 'indexed.tx', 'council.motions': 'kv.council', 'council.elections': 'kv.council',
    democracy: 'kv.democracy', 'treasury.overview': 'kv.treasury', 'validator.status': 'memo',
    discussion: 'response', labels: 'response', alerts: 'response', watchlist: 'local',
    'technicalCommittee.motions': 'kv.technicalCommittee' });

// About a day of blocks: far wider than any poll (three minutes), narrow enough to skip an old hole.
export const FRESHNESS_WINDOW_BLOCKS = 7200;
// Design 2.5: first attempt at inclusion, then 2, 4, 8, 16, 30, 30... seconds.
export const POLL_BACKOFF_MS = Object.freeze([2000, 4000, 8000, 16000, 30000]);
// Design 2.5 and UX section 9 ("longest quiet wait before could-not-refresh").
export const POLL_DEADLINE_MS = Object.freeze({ chain: 60_000, indexed: 180_000, kv: 180_000, memo: 180_000 });

const INDEXERS = Object.freeze({ chain: 'chain_index', rewards: 'staking_rewards', tx: 'transactions' });
const INTERVAL_OF = Object.freeze({ chain: 'chain', rewards: 'rewards', tx: 'tx' });

const posInt = (v) => { if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// The lowest height owed by a skip tail (lib/skip-tail.js { ranges: [{ lo, hi }] }) at or above `from`.
export function lowestTailFrom(tail, from) {
    const ranges = tail && Array.isArray(tail.ranges) ? tail.ranges : [];
    let best = null;
    for (const r of ranges) {
        if (!r) continue;
        const lo = Number(r.lo), hi = Number(r.hi);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < from) continue;
        const h = Math.max(lo, from);
        if (best === null || h < best) best = h;
    }
    return best;
}

function windowed(state, lowestHole, indexer, window) {
    const s = state && typeof state === 'object' ? state : {};
    const top = posInt(s.headSeen) ?? posInt(s.latestScannedBlock);
    if (top === null) return { mark: null, since: null };
    const since = Math.max(1, top - window + 1);
    let hole = null;
    try { hole = posInt(lowestHole(indexer, since)); } catch (e) { return { mark: null, since: null }; }
    const mark = hole !== null && hole >= since && hole <= top ? hole - 1 : top;
    return { mark, since };
}

export function buildFreshness({ syncState, lowestHole = () => null, chainHead = null, pending = [], intervalMs = {}, window = FRESHNESS_WINDOW_BLOCKS, kv = {} } = {}) {
    const indexed = {}, since = {};
    for (const [key, name] of Object.entries(INDEXERS)) {
        let state = null;
        try { state = syncState(name); } catch (e) { state = null; }
        const w = state ? windowed(state, lowestHole, name, posInt(window) || FRESHNESS_WINDOW_BLOCKS) : { mark: null, since: null };
        indexed[key] = w.mark;
        since[key] = w.since;
    }
    const iv = intervalMs && typeof intervalMs === 'object' ? intervalMs : {};
    const k = kv && typeof kv === 'object' ? kv : {};
    return {
        v: 1,
        chainHead: posInt(chainHead),
        indexed, since,
        kv: { council: posInt(k.council), democracy: posInt(k.democracy), treasury: posInt(k.treasury), technicalCommittee: posInt(k.technicalCommittee) },
        pending: Array.isArray(pending) ? pending.filter(d => typeof d === 'string') : [],
        intervalMs: { chain: posInt(iv.chain), rewards: posInt(iv.rewards), tx: posInt(iv.tx) }
    };
}

// R4: a route serving a governance snapshot AND the governance history index is only as fresh as the lower
// of the two. Either unknown is unknown.
export function kvMark(atBlock, historyMark) {
    const a = posInt(atBlock), h = posInt(historyMark);
    return a === null || h === null ? null : Math.min(a, h);
}

// Has the server copy of `domain` reached `block`? Unknown is no.
export function caughtUp(domain, freshness, block) {
    const b = Number(block);
    if (block === null || block === undefined || !Number.isFinite(b)) return false;
    const src = SOURCE[domain];
    if (!src) return false;
    if (src === 'response' || src === 'local') return true;
    const f = freshness;
    if (!f || typeof f !== 'object') return false;
    if (Array.isArray(f.pending) && f.pending.includes(domain)) return false;
    if (src === 'chain' || src === 'memo') return finite(f.chainHead) && f.chainHead >= b;
    const [kind, key] = src.split('.');
    const group = kind === 'indexed' ? f.indexed : f.kv;
    if (!group || typeof group !== 'object' || !finite(group[key]) || group[key] < b) return false;
    if (kind === 'indexed' && f.since && typeof f.since === 'object' && f.since[key] != null) {
        return finite(f.since[key]) && b >= f.since[key];
    }
    return true;
}

// How long a poll for `domain` may wait before could-not-refresh. 0: never polled (the response is the truth).
// An indexer configured slower than its default (Q6) stretches the wait to two of its ticks; it never shortens it.
export function pollDeadlineMs(domain, freshness) {
    const src = SOURCE[domain];
    if (!src || src === 'response' || src === 'local') return 0;
    const kind = src.split('.')[0];
    const base = POLL_DEADLINE_MS[kind] || 0;
    if (kind !== 'indexed') return base;
    const iv = freshness && freshness.intervalMs && typeof freshness.intervalMs === 'object' ? posInt(freshness.intervalMs[INTERVAL_OF[src.split('.')[1]]]) : null;
    return iv ? Math.max(base, 2 * iv) : base;
}

// Two responses that differ only in freshness draw the same page.
export function samePayload(a, b) {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const strip = (o) => { const { freshness, ...rest } = o; return rest; };
    try { return JSON.stringify(strip(a)) === JSON.stringify(strip(b)); } catch (e) { return false; }
}
