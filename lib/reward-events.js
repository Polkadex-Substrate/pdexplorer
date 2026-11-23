// The unpaid list in the forward pass (design section 5, row rewards.unpaid; sprint R2). When the block
// indexer sees staking.Rewarded, the unclaimed-cache pair (stash, era, validator) it pays is known to be paid
// and can leave the cache at once, instead of after the 60 s rewards scan plus the cache's 20 minute TTL.
//
// Era and validator are attributed EXACTLY as syncStakingRewards attributes them (server.js
// scanBlockForRewards): the payout extrinsic's call through the server's extractPayoutInfo (bare
// payoutStakers, proxy.proxy, a batch), and for a multi-item batch of direct payouts the utility
// ItemCompleted / ItemFailed delimiters (lib/reward-attribution.js). A reward that cannot be attributed to
// one pair is never guessed: its stash goes to `stale` (with the era when the call names one), and the
// caller marks that stash's cache stale so the next read recomputes it from chain state.
//
// Keys are normalised as lib/reward-dedup.js claimedRewardKey does (Number(era), the canonical address), so
// a deletion matches the cached row exactly. Bounded: at most `max` rewards per block are read.
// The only imports are the two import-free leaves the indexer already uses.

import { isBatchDelimiter, attributeBatchRewards } from './reward-attribution.js';
import { claimedRewardKey } from './reward-dedup.js';

// A 30-call payout batch pays at most 30 pages; far more than that in one block is not a payout this list
// can act on in one step. The rest are left to the 60 s scan, as before R2.
export const REWARD_NOTES_MAX_PER_BLOCK = 2048;

// records: the block's event records; parse(record) -> { stash } | null (server.js parseRewardedEvent);
// payoutInfo(extrinsicIndex) -> { era, validator, items? } (server.js extractPayoutInfo);
// normalize(address) -> the canonical address (throws when it does not decode).
export function rewardNotesForBlock(records, { parse, payoutInfo, normalize = (a) => a, max = REWARD_NOTES_MAX_PER_BLOCK } = {}) {
    const list = Array.isArray(records) ? records : [];
    const norm = (a) => { if (a == null) return null; try { const s = normalize(String(a)); return s ? String(s) : null; } catch (e) { return null; } };
    const exOf = (r) => { try { return r && r.phase && r.phase.isApplyExtrinsic ? r.phase.asApplyExtrinsic.toNumber() : null; } catch (e) { return null; } };
    const hits = [];
    list.forEach((record, index) => {
        let p = null;
        try { p = parse(record); } catch (e) { p = null; }
        if (p && p.stash != null) hits.push({ record, index, stash: p.stash });
    });
    const hitIndex = new Set(hits.map(h => h.index));
    const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : REWARD_NOTES_MAX_PER_BLOCK;
    const truncated = hits.length > cap;
    const used = hits.slice(0, cap);

    const infoByEx = new Map(), attributionByEx = new Map();
    const infoFor = (ex) => {
        if (!infoByEx.has(ex)) { let info = null; try { info = payoutInfo(ex); } catch (e) { info = null; } infoByEx.set(ex, info || { era: null, validator: null }); }
        return infoByEx.get(ex);
    };
    const attributionFor = (ex) => {
        if (attributionByEx.has(ex)) return attributionByEx.get(ex);
        const info = infoFor(ex);
        let map = null;
        if (info && Array.isArray(info.items) && info.items.length > 1) {
            const sequence = [];
            list.forEach((r, idx) => {
                if (exOf(r) !== ex) return;
                const e = r.event || {};
                if (isBatchDelimiter(String(e.section), String(e.method))) sequence.push({ kind: 'delimiter' });
                else if (hitIndex.has(idx)) sequence.push({ kind: 'reward', ref: idx });
            });
            map = attributeBatchRewards(info.items, sequence);
        }
        attributionByEx.set(ex, map);
        return map;
    };

    const pairs = [], stale = [];
    const seenPairs = new Set(), seenStale = new Set();
    for (const hit of used) {
        const stash = norm(hit.stash);
        if (!stash) continue;
        let era = null, validator = null;
        const ex = exOf(hit.record);
        if (ex !== null) {
            const info = infoFor(ex);
            era = info.era; validator = info.validator;
            const per = attributionFor(ex);
            const item = per && per.get(hit.index);
            if (item) { if (item.era != null) era = item.era; if (item.validator) validator = item.validator; }
        }
        const e = era == null ? NaN : Number(era);
        const v = validator ? norm(validator) : null;
        if (Number.isFinite(e) && v) {
            const id = `${stash}|${claimedRewardKey(e, v)}`;
            if (!seenPairs.has(id)) { seenPairs.add(id); pairs.push({ stash, era: e, validator: v }); }
        } else {
            const eraOrNull = Number.isFinite(e) ? e : null;
            const id = `${stash}|${eraOrNull}`;
            if (!seenStale.has(id)) { seenStale.add(id); stale.push({ stash, era: eraOrNull }); }
        }
    }
    return { pairs, stale, seen: used.length, truncated };
}

// The stash of a staking.Rewarded row as the events table stores it (toHuman: named object or positional
// array), for the reorg repair: the fork's rewarded stashes are marked stale.
export function storedRewardStash(data) {
    if (Array.isArray(data)) return data.length && data[0] != null && typeof data[0] !== 'object' ? String(data[0]) : null;
    if (!data || typeof data !== 'object') return null;
    for (const k of ['stash', 'account', 'who', 'validatorStash']) if (data[k] != null && typeof data[k] !== 'object') return String(data[k]);
    return null;
}
