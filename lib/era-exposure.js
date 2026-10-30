// Per-era validator exposure (total stake, own stake, backers), read the same
// way on every runtime the explorer has to understand.
//
// WHY THIS FILE EXISTS
//
// Spec 392 (pallet-staking 45.x) writes exposures ONLY to the paged storage:
//   staking.erasStakersOverview(era, validator) -> Option<{ total, own, nominatorCount, pageCount }>
//   staking.erasStakersPaged(era, validator, page) -> Option<{ pageTotal, others }>
// The legacy staking.erasStakers / erasStakersClipped items are still in the
// 392 metadata, but they are ValueQuery maps that are no longer written, so a
// read of a post-upgrade era returns a default exposure of 0 rather than an
// error. Spec 373 has only the legacy items.
//
// The old reader picked ONE store by asking "does the runtime HAVE the
// overview item?". On 392 the answer is yes for every era, so any era whose
// exposure was written before the upgrade (the era that was active when 392
// was enacted, and every older era inside HistoryDepth) read None from the
// overview and came back as 0 total stake, without ever looking at the legacy
// store where the data actually is. The network-info path went the other way
// and read erasStakers unconditionally, which goes to 0 on the first era
// elected after the upgrade. Both were silent: 0 is a valid-looking number.
//
// The rule here: overview first; if it has no entry for (era, validator), the
// legacy map; if neither has anything, an explicit 'none'. Callers can tell a
// validator that was not elected in an era ('none') from one with real stake.
//
// No imports on purpose, so the tests can drive it with real codecs built
// from the fixture metadata or with plain mocks.

export const EXPOSURE_NONE = Object.freeze({ total: 0, own: 0, nominatorCount: 0, pageCount: 0, source: 'none' });

// Compact<u128> -> the inner value; anything else unchanged.
function unwrapCompact(v) {
    if (v && typeof v.unwrap === 'function' && !('isSome' in v)) return v.unwrap();
    return v;
}

function toInt(v) {
    if (v == null) return 0;
    try { const n = Number(typeof v.toString === 'function' ? v.toString() : v); return Number.isFinite(n) ? n : 0; }
    catch (_) { return 0; }
}

// True for a zero (or absent) balance, whatever shape it arrives in: a
// polkadot.js BN/Compact, a bigint, a number or a decimal string.
export function isZeroBalance(v) {
    v = unwrapCompact(v);
    if (v == null) return true;
    if (typeof v.isZero === 'function') return v.isZero();
    try { return BigInt(v.toString()) === 0n; } catch (_) { return !(Number(v) > 0); }
}

function othersArray(others) {
    if (!others) return [];
    if (Array.isArray(others)) return others;
    if (typeof others.toArray === 'function') return others.toArray();
    return Array.from(others);
}

function fromOverview(meta) {
    return {
        total: unwrapCompact(meta.total),
        own: unwrapCompact(meta.own),
        nominatorCount: toInt(meta.nominatorCount),
        pageCount: toInt(meta.pageCount),
        source: 'overview'
    };
}

function fromLegacy(exp) {
    const others = othersArray(exp.others);
    return {
        total: unwrapCompact(exp.total),
        own: unwrapCompact(exp.own),
        nominatorCount: others.length,
        pageCount: others.length ? 1 : 0,
        source: 'legacy',
        others
    };
}

function legacyIsEmpty(exp) {
    return !exp || (isZeroBalance(exp.total) && othersArray(exp.others).length === 0);
}

/**
 * Exposure summary for one validator in one era.
 *
 * `memo` (optional Map, one per scan): once an era is seen to live in legacy
 * storage only, later validators of that era go to the legacy map first, so a
 * history scan over pre-upgrade eras costs one read per validator rather than
 * two. A validator missing from the legacy map in such an era still gets the
 * overview checked, so the shortcut can never turn a real exposure into 0.
 *
 * Returns { total, own, nominatorCount, pageCount, source } where total/own
 * are raw balances (pass them to formatPDEX) and source is 'overview',
 * 'legacy' or 'none'.
 */
export async function readEraExposureOverview(api, era, address, memo = null) {
    const q = (api && api.query && api.query.staking) || {};
    const hasOverview = !!q.erasStakersOverview;
    const hasLegacy = !!q.erasStakers;
    const legacyFirst = hasOverview && memo && memo.get(era) === 'legacy';

    if (hasOverview && !legacyFirst) {
        const opt = await q.erasStakersOverview(era, address);
        if (opt && opt.isSome) return fromOverview(opt.unwrap());
    }
    if (hasLegacy) {
        const exp = await q.erasStakers(era, address);
        if (!legacyIsEmpty(exp)) {
            if (memo && hasOverview) memo.set(era, 'legacy');
            return fromLegacy(exp);
        }
    }
    if (legacyFirst) {
        const opt = await q.erasStakersOverview(era, address);
        if (opt && opt.isSome) return fromOverview(opt.unwrap());
    }
    return { ...EXPOSURE_NONE };
}

/** Total stake (raw balance) for one validator in one era; 0 when not elected. */
export async function readEraValidatorStake(api, era, address, memo = null) {
    return (await readEraExposureOverview(api, era, address, memo)).total;
}

/**
 * Every nominator (as an address string) backing `address` in `era`.
 * Pass the overview already read for this (era, address) to avoid a re-read.
 * Paged runtimes: walks erasStakersPaged pages 0..pageCount-1.
 */
export async function readEraExposureNominators(api, era, address, overview = null) {
    const ov = overview || await readEraExposureOverview(api, era, address);
    if (ov.source === 'legacy') return othersArray(ov.others).map(o => o.who.toString());
    if (ov.source !== 'overview') return [];
    const q = (api && api.query && api.query.staking) || {};
    if (!q.erasStakersPaged) return [];
    const pages = await Promise.all(
        Array.from({ length: ov.pageCount }, (_, page) => q.erasStakersPaged(era, address, page)));
    const out = [];
    for (const opt of pages) {
        if (!opt || !opt.isSome) continue;
        for (const o of othersArray(opt.unwrap().others)) out.push(o.who.toString());
    }
    return out;
}

/**
 * The loud-failure guard. `stakes` are the per-validator totals (PDEX numbers)
 * the explorer is about to publish; `activeCount` is how many active validators
 * the chain says there are. Every one of them at 0 is not a state the chain
 * can be in (an elected validator has at least its own bond), so it means the
 * exposure read is broken, and must not be served as if it were data.
 */
export function assessStakeHealth(stakes, activeCount, era = null) {
    const list = Array.isArray(stakes) ? stakes : [];
    const active = Number(activeCount) || 0;
    const allZero = active > 0 && list.length > 0 && list.every(s => !(Number(s) > 0));
    return {
        ok: !allZero,
        allZero,
        message: allZero
            ? `all ${list.length} of ${active} active validators report 0 total stake` +
              (era != null ? ` for era ${era}` : '') +
              '; the exposure read is broken (check erasStakersOverview / erasStakers on this runtime)'
            : null
    };
}

function keyArg(key, i) {
    const args = key && key.args;
    const a = args ? args[i] : undefined;
    return a == null ? null : a;
}

/**
 * Every validator's exposure for one era, keyed by validator address, read
 * with the same store rule as readEraExposureOverview but across the whole era
 * (one entries() scan per store instead of one read per validator). Used where
 * the caller does not know in advance which validators matter, e.g. "which
 * validators did this stash back in era N".
 *
 *   paged eras (written by 392): erasStakersOverview + erasStakersPaged pages
 *   legacy eras (written by 373, including those still inside HistoryDepth on
 *   392): erasStakersClipped when the runtime has it, else erasStakers.
 *   Clipped is what payout_stakers pays from for a legacy era on both 373 and
 *   392 (pallet-staking get_paged_exposure falls back to ErasStakersClipped
 *   for page 0 when there is no overview), so a nominator clipped out of it
 *   is correctly owed nothing.
 *
 * A validator present in the overview is never overridden by legacy data.
 *
 * Returns Map<address, { total, own, source, pages: [{ page, pageTotal, others }] }>
 * where others are [{ who: string, value }] and balances are raw. `normalize`
 * (optional) canonicalises addresses; the default is toString().
 */
export async function readEraExposureIndex(api, era, normalize = null) {
    const q = (api && api.query && api.query.staking) || {};
    const norm = (a) => {
        const s = a == null ? '' : a.toString();
        if (!normalize) return s;
        try { return normalize(s); } catch (_) { return s; }
    };
    const out = new Map();

    if (q.erasStakersOverview && typeof q.erasStakersOverview.entries === 'function') {
        for (const [key, opt] of await q.erasStakersOverview.entries(era)) {
            if (!opt || !opt.isSome) continue;
            const ov = fromOverview(opt.unwrap());
            out.set(norm(keyArg(key, 1)), { total: ov.total, own: ov.own, source: 'overview', pageCount: ov.pageCount, pages: [] });
        }
        if (out.size && q.erasStakersPaged && typeof q.erasStakersPaged.entries === 'function') {
            for (const [key, opt] of await q.erasStakersPaged.entries(era)) {
                if (!opt || !opt.isSome) continue;
                const entry = out.get(norm(keyArg(key, 1)));
                if (!entry) continue;
                const pg = opt.unwrap();
                entry.pages.push({
                    page: toInt(keyArg(key, 2)),
                    pageTotal: unwrapCompact(pg.pageTotal),
                    others: othersArray(pg.others).map(o => ({ who: norm(o.who), value: unwrapCompact(o.value) }))
                });
            }
            for (const e of out.values()) e.pages.sort((a, b) => a.page - b.page);
        }
    }

    const legacyItem = q.erasStakersClipped || q.erasStakers;
    if (legacyItem && typeof legacyItem.entries === 'function') {
        for (const [key, exp] of await legacyItem.entries(era)) {
            if (legacyIsEmpty(exp)) continue;
            const who = norm(keyArg(key, 1));
            if (out.has(who)) continue;
            const others = othersArray(exp.others).map(o => ({ who: norm(o.who), value: unwrapCompact(o.value) }));
            out.set(who, {
                total: unwrapCompact(exp.total), own: unwrapCompact(exp.own), source: 'legacy', pageCount: 1,
                pages: [{ page: 0, pageTotal: unwrapCompact(exp.total), others }]
            });
        }
    }
    return out;
}
