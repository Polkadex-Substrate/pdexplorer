// Unpaid (unclaimed) staking rewards for one stash, computed from chain state.
//
// WHY THIS FILE EXISTS
//
// recomputeUnclaimed used api.derive.staking.stakerRewards from
// @polkadot/api-derive 17.0.2. Its exposure source, _eraExposure, reads ONLY
// erasStakersPaged whenever the runtime has that item. On spec 392 every era
// elected before the upgrade (still claimable inside HistoryDepth) lives in
// the legacy stores, so the derive saw no exposure for those eras and the
// stash's unpaid pre-392 rewards silently dropped out of the explorer's
// "unclaimed" list. Chain payouts were never affected; the display was.
//
// The rule here is the one lib/era-exposure.js applies everywhere else:
// paged (overview + pages) first, legacy for an era with no paged data.
// Claimed state per (era, validator):
//   392: staking.claimedRewards(era, validator) lists the paid pages, and the
//        validator ledger's legacyClaimedRewards lists eras paid in full
//        before the upgrade
//   373: the validator ledger's claimedRewards lists eras paid in full
//
// The only import is lib/era-exposure.js (itself import-free), so the tests
// can drive this with real codecs built from the fixture metadata or with
// plain mocks.

import { readEraExposureIndex, isZeroBalance } from './era-exposure.js';

const BILLION = 1_000_000_000n;

function big(v) {
    if (v == null) return 0n;
    if (typeof v === 'bigint') return v;
    if (v && typeof v.unwrap === 'function' && !('isSome' in v)) v = v.unwrap();
    try { return BigInt(v.toString()); } catch (_) { return 0n; }
}

function toNum(v) {
    if (v == null) return null;
    const n = Number(typeof v.toString === 'function' ? v.toString() : v);
    return Number.isFinite(n) ? n : null;
}

function eraList(v) {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : (typeof v.toArray === 'function' ? v.toArray() : Array.from(v));
    return arr.map(toNum).filter(n => n != null);
}

// Eras the ledger records as fully paid. 392 renamed the field to
// legacyClaimedRewards (it is no longer written); 373 calls it claimedRewards.
export function ledgerClaimedEras(ledger) {
    if (!ledger) return [];
    if (ledger.isSome !== undefined) {
        if (!ledger.isSome) return [];
        ledger = ledger.unwrap();
    }
    return eraList(ledger.legacyClaimedRewards || ledger.claimedRewards);
}

/**
 * The pure part: what `stash` is owed in one era from the exposure index of
 * that era, the era's reward data and the claimed pages per validator.
 *
 *   index        Map from readEraExposureIndex
 *   eraReward    raw total validator payout for the era (bigint-able)
 *   points       { total, individual: Map|object validator -> points }
 *   commissionOf validator -> Perbill parts (bigint-able, 0..1e9)
 *   isPageClaimed (validator, page, source) -> boolean
 *
 * Returns [{ validator, amount (raw bigint) }], one per validator still owing
 * the stash something. Same arithmetic as pallet-staking payout_stakers:
 * validator part = eraReward * points / totalPoints; commission taken first;
 * the rest split by stake over the exposure total.
 */
export function stashEraPayouts(index, stash, { eraReward, points, commissionOf, isPageClaimed }) {
    const out = [];
    const reward = big(eraReward);
    const totalPoints = big(points && points.total);
    if (reward === 0n || totalPoints === 0n || !index) return out;
    const individual = (points && points.individual) || {};
    const pointsOf = (v) => big(individual instanceof Map ? individual.get(v) : individual[v]);

    for (const [validator, exp] of index) {
        const total = big(exp.total);
        if (total === 0n) continue;
        const isSelf = validator === stash;
        let staked = 0n;
        let pagesOwed = [];
        if (isSelf) {
            staked = big(exp.own);
            pagesOwed = exp.pages.length ? exp.pages : [{ page: 0, pageTotal: exp.total, others: [] }];
        } else {
            for (const pg of exp.pages) {
                const me = pg.others.find(o => o.who === stash);
                if (me) { staked = big(me.value); pagesOwed = [pg]; break; }
            }
            if (!pagesOwed.length) continue;
        }
        const unpaid = pagesOwed.filter(pg => !isPageClaimed(validator, pg.page, exp.source));
        if (!unpaid.length) continue;

        const valPoints = pointsOf(validator);
        if (valPoints === 0n) continue;
        const avail = reward * valPoints / totalPoints;
        const commission = big(commissionOf(validator));
        const valCut = commission * avail / BILLION;
        let amount = (avail - valCut) * staked / total;
        if (isSelf) {
            amount += valCut;
            // The validator's own share and commission are paid page by page,
            // in proportion to each page's stake. Owe only the unpaid pages.
            if (unpaid.length < pagesOwed.length) {
                const all = pagesOwed.reduce((s, pg) => s + big(pg.pageTotal), 0n);
                const left = unpaid.reduce((s, pg) => s + big(pg.pageTotal), 0n);
                amount = all > 0n ? amount * left / all : amount;
            }
        }
        if (amount > 0n) out.push({ validator, amount });
    }
    return out;
}

function pointsFromCodec(p) {
    if (!p) return { total: 0n, individual: new Map() };
    const individual = new Map();
    const ind = p.individual;
    if (ind && typeof ind.entries === 'function') {
        for (const [k, v] of ind.entries()) individual.set(k.toString(), v);
    } else if (ind && typeof ind === 'object') {
        for (const k of Object.keys(ind)) individual.set(k, ind[k]);
    }
    return { total: p.total, individual };
}

/**
 * Unpaid rewards for `stash` over `eras` (oldest to newest, completed eras).
 *
 * opts:
 *   normalize    address canonicaliser applied to every account read
 *   indexCache   Map era -> exposure index; completed eras are immutable, so
 *                one index serves every stash (the derive cached the same way)
 *
 * Returns { rows: [{ era, validator, amount (raw bigint) }], emptyEras: [] }.
 * emptyEras are eras whose exposure read came back with no validators at all,
 * which no elected era can have: the read failed, the caller must not treat
 * the era as "nothing owed".
 */
export async function computeStashUnclaimed(api, stash, eras, { normalize = null, indexCache = null } = {}) {
    const q = (api && api.query && api.query.staking) || {};
    const rows = [];
    const emptyEras = [];
    const ledgerEras = new Map();
    const norm = (a) => {
        const s = a == null ? '' : a.toString();
        if (!normalize) return s;
        try { return normalize(s); } catch (_) { return s; }
    };
    const me = norm(stash);

    async function claimedErasOf(validator) {
        if (ledgerEras.has(validator)) return ledgerEras.get(validator);
        let eras = [];
        try {
            let controller = validator;
            if (q.bonded) {
                const c = await q.bonded(validator);
                if (c && c.isSome) controller = c.unwrap().toString();
            }
            if (q.ledger) eras = ledgerClaimedEras(await q.ledger(controller));
        } catch (_) { eras = []; }
        const set = new Set(eras);
        ledgerEras.set(validator, set);
        return set;
    }

    for (const era of eras) {
        let index = indexCache ? indexCache.get(era) : null;
        if (!index) {
            index = await readEraExposureIndex(api, era, normalize);
            if (indexCache && index.size) indexCache.set(era, index);
        }
        if (!index.size) { emptyEras.push(era); continue; }

        // Only the validators the stash appears in matter; skip the era
        // without further reads when there are none.
        const mine = new Map();
        for (const [v, exp] of index) {
            if (v === me || exp.pages.some(pg => pg.others.some(o => o.who === me))) mine.set(v, exp);
        }
        if (!mine.size) continue;

        const rewardOpt = q.erasValidatorReward ? await q.erasValidatorReward(era) : null;
        if (!rewardOpt || (rewardOpt.isSome !== undefined && !rewardOpt.isSome)) continue;
        const eraReward = rewardOpt.isSome !== undefined ? rewardOpt.unwrap() : rewardOpt;
        if (isZeroBalance(eraReward)) continue;
        const points = pointsFromCodec(q.erasRewardPoints ? await q.erasRewardPoints(era) : null);
        // Points are keyed by the chain's own address format.
        const pointsNorm = new Map();
        for (const [k, v] of points.individual) pointsNorm.set(norm(k), v);

        const commission = new Map();
        const claimedPages = new Map();
        const legacyPaid = new Map();
        for (const v of mine.keys()) {
            const prefs = q.erasValidatorPrefs ? await q.erasValidatorPrefs(era, v) : null;
            commission.set(v, prefs && prefs.commission != null ? prefs.commission : 0);
            claimedPages.set(v, q.claimedRewards ? new Set(eraList(await q.claimedRewards(era, v))) : new Set());
            legacyPaid.set(v, (await claimedErasOf(v)).has(era));
        }

        const owed = stashEraPayouts(mine, me, {
            eraReward,
            points: { total: points.total, individual: pointsNorm },
            commissionOf: (v) => commission.get(v),
            isPageClaimed: (v, page) => legacyPaid.get(v) || claimedPages.get(v).has(page)
        });
        for (const o of owed) rows.push({ era, validator: o.validator, amount: o.amount });
    }
    return { rows, emptyEras };
}

/**
 * The cache write rule. `existing` are the stored unclaimed rows, `computed`
 * the fresh result. An era whose read came back empty keeps whatever was
 * stored for it; when EVERY era read empty the caller must not write at all
 * (returns null), so one broken read cannot wipe a stash's unpaid list.
 */
export function mergeUnclaimed(existing, computed, emptyEras, erasScanned) {
    const empty = new Set(emptyEras || []);
    if (erasScanned > 0 && empty.size >= erasScanned) return null;
    const kept = (existing || []).filter(r => empty.has(Number(r.era)));
    return kept.concat(computed || []);
}
