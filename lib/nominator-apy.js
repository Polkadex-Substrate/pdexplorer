// Stake-aware "Est. APY": what a nominator behind ONE validator earns per PDEX.
//
// THE BUG THIS REPLACES
//
// The validators list and the validator page showed estimatedApy(commission)
// from lib/apy.js: the chain's nominal maximum (MAX_APY_BASE, 23.09) times
// (1 - commission). That takes no account of the validator's stake. On this
// runtime each active validator earns about the same per era whatever its
// stake (era reward x its points / all points), and that is shared across its
// whole exposure, so the return per PDEX falls as the stake grows. A validator
// with 392k staked at 5% showed 21.94%, the same as an average 34.5k one,
// while its nominators were paid about 1.9% a year. The number pushed people
// towards the validators that pay least.
//
// THE NUMBER NOW
//
// 1. Past eras (preferred). The realized APR the stake picker already uses
//    (lib/stake-apr.js validatorPerformance, DEFAULT_APR_WINDOW = 28 eras):
//      perEra = eraReward x points / totalPoints x (1 - commission that era) / exposureTotal
//      apy    = mean(perEra) x erasPerYear x 100
//    erasPerYear comes from the runtime era length (snapshot.erasPerYear).
//    SIMPLE, NOT COMPOUNDED: the label says APY, the math is a simple annual
//    rate, the same convention as the picker's APR and as the old figure
//    (23.09 x (1 - c) is not compounded either).
// 2. Current stake (fallback, too few eras of history, or not in the snapshot):
//    the same formula with today's values,
//      rewardPerValidator x (1 - current commission) / current total stake x erasPerYear x 100
//    where rewardPerValidator is the mean era reward per active validator over
//    the same window.
// 3. Otherwise null, which every view renders as the dash. Never the
//    commission-only figure.
//
// Precision: stored amounts are PDEX doubles (formatPDEX converts planck with
// BigInt before they are stored), not planck integers; this only divides
// them, so a double's 15 to 16 significant digits are far more than a
// percentage with two decimals needs, and 1e30 PDEX does not overflow.
//
// Pure and import-free apart from lib/stake-apr.js (itself pure), so it runs
// in Node tests, on the server and in the browser alike.

import { DEFAULT_APR_WINDOW, DAYS_PER_YEAR, windowEras, indexSummaries, eraReturnPerUnit } from './stake-apr.js';

export const NOMINATOR_APY_FIELD = 'estimatedNominatorApy';
export const NOMINATOR_APY_METHOD_FIELD = 'estimatedNominatorApyMethod';
export const NOMINATOR_APY_ERAS_FIELD = 'estimatedNominatorApyEras';
export const METHOD_PAST_ERAS = 'past-eras';
export const METHOD_CURRENT_STAKE = 'current-stake';

// A finite number, or null for absent input. Number(null), Number('') and
// Number([]) are all 0, which would read a missing value as a real zero.
function num(v) {
    if (v === null || v === undefined || typeof v === 'boolean' || Array.isArray(v)) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function erasPerYearOr(v) {
    const n = num(v);
    return n != null && n > 0 ? n : DAYS_PER_YEAR;
}

// Mean era reward per active (elected) validator over the window, in PDEX, or
// null when no usable era is held.
export function rewardPerActiveValidator(summaries, { activeEra, window = DEFAULT_APR_WINDOW } = {}) {
    const byEra = indexSummaries(summaries);
    let sum = 0;
    let n = 0;
    for (const e of windowEras(activeEra, window)) {
        const s = byEra.get(e);
        const reward = num(s && s.reward);
        if (!s || !s.validators || reward == null || reward < 0) continue;
        const elected = Object.values(s.validators).filter(r => (num(r && r.stake) || 0) > 0).length;
        if (!elected) continue;
        sum += reward / elected;
        n++;
    }
    return n ? sum / n : null;
}

// The fallback formula with current values. Null for anything unusable: an
// unknown commission must not read as 0% (the full rate), and a zero or
// unknown stake has no per-PDEX return.
export function currentStakeApy({ rewardPerValidator, commission, totalStake, erasPerYear } = {}) {
    const r = num(rewardPerValidator);
    const c = num(commission);
    const s = num(totalStake);
    if (r == null || r < 0 || c == null || c < 0 || c > 100 || s == null || s <= 0) return null;
    return (r * (1 - c / 100) / s) * erasPerYearOr(erasPerYear) * 100;
}

// { value, method, eras }: past eras when the window has enough of them
// (perf.status 'ok'), else the current-stake formula, else nothing.
export function nominatorApy({ perf, commission, totalStake, rewardPerValidator, erasPerYear } = {}) {
    if (perf && perf.status === 'ok' && Number.isFinite(perf.apr)) {
        return { value: perf.apr, method: METHOD_PAST_ERAS, eras: Number(perf.erasUsed) || 0 };
    }
    const value = currentStakeApy({ rewardPerValidator, commission, totalStake, erasPerYear });
    return value == null ? { value: null, method: null, eras: 0 } : { value, method: METHOD_CURRENT_STAKE, eras: 0 };
}

export function nominatorApyFields(result) {
    const r = result || {};
    return {
        [NOMINATOR_APY_FIELD]: r.value ?? null,
        [NOMINATOR_APY_METHOD_FIELD]: r.method ?? null,
        [NOMINATOR_APY_ERAS_FIELD]: r.eras || 0
    };
}

// Address -> snapshot entry, built once per snapshot object.
const indexCache = new WeakMap();
function snapshotIndex(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.validators)) return new Map();
    if (indexCache.has(snapshot)) return indexCache.get(snapshot);
    const m = new Map();
    for (const v of snapshot.validators) if (v && v.address) m.set(v.address, v);
    indexCache.set(snapshot, m);
    return m;
}

// One validator from the stake-picker snapshot (KV 'validator_choice', built by
// the indexer). `given` supplies commission and stake for a validator the
// snapshot does not hold; the snapshot's own values win when it does.
export function nominatorApyForAddress(snapshot, address, given = {}, { window = DEFAULT_APR_WINDOW } = {}) {
    const entry = snapshotIndex(snapshot).get(address);
    const perf = entry && entry.perf ? entry.perf[String(window)] : undefined;
    return nominatorApy({
        perf,
        commission: entry ? entry.commission : given.commission,
        totalStake: entry && entry.totalStake != null ? entry.totalStake : given.totalStake,
        rewardPerValidator: snapshot ? snapshot.rewardPerValidator : null,
        erasPerYear: snapshot ? snapshot.erasPerYear : null
    });
}

// /api/validators rows, each with the three fields added. Input not mutated.
export function withNominatorApy(rows, snapshot) {
    return (rows || []).map(row => ({
        ...row,
        ...nominatorApyFields(nominatorApyForAddress(snapshot, row && row.address, { commission: row && row.commission, totalStake: row && row.totalStake }))
    }));
}

// One era's return for one validator, annualised the same way, or null.
export function perEraNominatorApy(summary, address, erasPerYear) {
    const r = eraReturnPerUnit(summary, address);
    return r == null ? null : r * erasPerYearOr(erasPerYear) * 100;
}

// Validator-page history rows with `nominatorApy` added (null where the era is
// not held or the validator was not elected). `apy` keeps its old meaning.
export function withPerEraNominatorApy(history, summaries, address, erasPerYear) {
    const byEra = indexSummaries(summaries);
    return (history || []).map(h => ({ ...h, nominatorApy: perEraNominatorApy(byEra.get(Number(h && h.era)), address, erasPerYear) }));
}

// List sort. Direction-aware so a missing estimate sorts LAST both ways (a
// plain comparator reversed for descending would put them first), and ties
// break by address so the order is stable.
export function compareNominatorApy(a, b, dir = 'asc') {
    const va = num(a && a[NOMINATOR_APY_FIELD]);
    const vb = num(b && b[NOMINATOR_APY_FIELD]);
    if (va == null || vb == null) {
        if (va != null) return -1;
        if (vb != null) return 1;
    } else if (va !== vb) {
        return dir === 'desc' ? vb - va : va - vb;
    }
    return String((a && a.address) || '').localeCompare(String((b && b.address) || ''));
}

// '1.93%', or null for "no estimate" (the caller renders its dash).
export function formatNominatorApy(value) {
    const v = num(value);
    return v == null ? null : `${v.toFixed(2)}%`;
}

// Small print under the validator page figure: where the number came from.
export function nominatorApyCaption(scorecard) {
    const s = scorecard || {};
    if (num(s[NOMINATOR_APY_FIELD]) == null) return 'not enough data yet';
    if (s[NOMINATOR_APY_METHOD_FIELD] === METHOD_PAST_ERAS) return `past ${Number(s[NOMINATOR_APY_ERAS_FIELD]) || DEFAULT_APR_WINDOW} eras, after commission, per PDEX staked`;
    return 'from current stake and commission';
}
