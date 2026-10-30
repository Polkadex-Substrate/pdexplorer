// Realized nominator APR per validator, from on-chain era rewards.
//
// The CEO request: let nominators sort the stake picker by "highest APR on an
// annual basis". The only APR the explorer had was `estimatedApyAtCurrentCommission`
// (lib/apy.js), which is the chain's nominal maximum discounted by TODAY's
// commission. It is the same number for every validator charging the same
// commission, so it cannot rank anything. This module computes what a nominator
// behind each validator was actually paid, per unit of stake, over a trailing
// window of completed eras.
//
// For one completed era e and validator v (all on-chain, see lib/stake-choice-sync.js):
//
//   validatorReward(e, v) = erasValidatorReward(e) * points(e, v) / totalPoints(e)
//   perUnit(e, v)         = validatorReward(e, v) * (1 - commission(e, v)) / exposureTotal(e, v)
//
// and over the window
//
//   APR(v) = mean(perUnit(e, v) for the eras v was elected in) * erasPerYear * 100
//
// with erasPerYear = 365.25 days / the runtime era length
// (sessionsPerEra * babe.epochDuration * babe.expectedBlockTime).
//
// Why per unit of stake divided by the WHOLE exposure. In paged staking
// (pallet-staking 45, spec 392) payout for one era works like this: the
// validator's commission comes off the top, and what is left is split
// pro rata across the entire exposure (own stake plus every nominator, on
// every page). Each nominator gets value / exposure.total of the leftover, so
// the per-unit rate is the same for the validator's own stake and for every
// backer, whichever exposure page they are on. MaxExposurePageSize is 256 on
// 392; it decides how many payout calls are needed (one per page), not who is
// paid. The election's MaxBackersPerWinner is 40,000, so no backer is dropped
// from the exposure in practice. "Oversubscribed" in the old sense (backers
// beyond MaxNominatorRewardedPerValidator earning nothing) does not exist on
// this runtime; the extra cost of a big validator is extra payout pages that
// someone has to claim within HistoryDepth (84 eras).
//
// What this is NOT: a promise. It is the mean of past eras, simple (not
// compounded), and assumes every page was claimed. The UI says so next to the
// number ("Past rewards, not a guarantee").
//
// Pure and import-free so it runs in Node tests, on the server and in the
// browser alike.

export const APR_WINDOWS = [7, 28, 84];
export const DEFAULT_APR_WINDOW = 28;
export const DAYS_PER_YEAR = 365.25;
const DAY_MS = 86_400_000;

// Fewer elected eras than this inside the window and we show "new" instead of
// a number. A quarter of the window, never fewer than 3: three eras is the
// least that averages out one lucky or unlucky era of block authorship.
export function minErasFor(window) {
    const w = Number(window) || DEFAULT_APR_WINDOW;
    return Math.max(3, Math.ceil(w / 4));
}

// Eras per year from the runtime era length in ms. Falls back to one era per
// day (the Polkadex mainnet value: 6 sessions of 4 hours) when unknown.
export function erasPerYearFromMs(eraDurationMs) {
    const ms = Number(eraDurationMs);
    if (!Number.isFinite(ms) || ms <= 0) return DAYS_PER_YEAR;
    return (DAYS_PER_YEAR * DAY_MS) / ms;
}

function finite(n) {
    if (n == null || n === '') return null;
    const x = Number(n);
    return Number.isFinite(x) ? x : null;
}

// Clamp a commission percentage to [0, 100]. Anything unusable reads as 100
// (no payout to nominators) rather than 0, so bad data can never inflate APR.
function commissionFraction(pct) {
    const c = finite(pct);
    if (c == null) return 1;
    return Math.min(Math.max(c, 0), 100) / 100;
}

// Return per unit of stake for one era, or null when the era cannot be used.
//   summary: { era, reward, totalPoints, validators: { [addr]: { points, stake, commission } } }
export function eraReturnPerUnit(summary, address) {
    if (!summary || !summary.validators) return null;
    const row = summary.validators[address];
    if (!row) return null;
    const reward = finite(summary.reward);
    const total = finite(summary.totalPoints);
    const stake = finite(row.stake);
    const points = finite(row.points) || 0;
    if (reward == null || reward < 0 || total == null || total <= 0) return null;
    if (stake == null || stake <= 0) return null;
    const validatorReward = reward * (points / total);
    return (validatorReward * (1 - commissionFraction(row.commission))) / stake;
}

// Median era points among the validators elected in an era (stake > 0).
export function eraMedianPoints(summary) {
    if (!summary || !summary.validators) return 0;
    const pts = Object.values(summary.validators)
        .filter(r => (finite(r && r.stake) || 0) > 0)
        .map(r => finite(r.points) || 0)
        .sort((a, b) => a - b);
    if (!pts.length) return 0;
    const mid = Math.floor(pts.length / 2);
    return pts.length % 2 ? pts[mid] : (pts[mid - 1] + pts[mid]) / 2;
}

// The completed eras of a window: [activeEra - window, activeEra - 1]. The
// active era is never included; its reward is not set until it ends.
export function windowEras(activeEra, window) {
    const a = Number(activeEra);
    const w = Number(window);
    if (!Number.isInteger(a) || !Number.isInteger(w) || w <= 0 || a <= 0) return [];
    const out = [];
    for (let e = Math.max(a - w, 0); e <= a - 1; e++) out.push(e);
    return out;
}

// Index summaries by era once, so a call per validator is cheap.
export function indexSummaries(summaries) {
    const byEra = new Map();
    for (const s of summaries || []) {
        if (s && Number.isInteger(Number(s.era))) byEra.set(Number(s.era), s);
    }
    return byEra;
}

// Performance of one validator over one window.
//
// Returns:
//   apr          percent per year, or null when status is not 'ok'
//   status       'ok' | 'new' (elected, but fewer than minErasFor eras) | 'none' (never elected in the window)
//   erasUsed     eras that fed the APR
//   electedEras  eras in the window the validator was in the active set
//   erasInWindow eras of the window the explorer holds a summary for
//   reliability  percent of elected eras with points >= half the era median, or null
//   missedEras   elected eras with zero points
export function validatorPerformance(byEra, address, { activeEra, window = DEFAULT_APR_WINDOW, erasPerYear = DAYS_PER_YEAR } = {}) {
    const map = byEra instanceof Map ? byEra : indexSummaries(byEra);
    const eras = windowEras(activeEra, window);
    let erasInWindow = 0;
    let electedEras = 0;
    let good = 0;
    let missed = 0;
    const returns = [];
    for (const e of eras) {
        const s = map.get(e);
        if (!s) continue;
        erasInWindow++;
        const row = s.validators && s.validators[address];
        if (!row || !((finite(row.stake) || 0) > 0)) continue;
        electedEras++;
        const pts = finite(row.points) || 0;
        if (pts === 0) missed++;
        const median = eraMedianPoints(s);
        if (pts >= median / 2) good++;
        const r = eraReturnPerUnit(s, address);
        if (r != null) returns.push(r);
    }
    const reliability = electedEras ? (good / electedEras) * 100 : null;
    const minEras = minErasFor(window);
    let status;
    if (!electedEras) status = 'none';
    else if (returns.length < minEras) status = 'new';
    else status = 'ok';
    let apr = null;
    if (status === 'ok') {
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        apr = mean * (Number(erasPerYear) || DAYS_PER_YEAR) * 100;
    }
    return { apr, status, erasUsed: returns.length, electedEras, erasInWindow, reliability, missedEras: missed };
}

// Every window for every address, in the compact shape the API serves:
//   { [address]: { '7': perf, '28': perf, '84': perf } }
export function performanceForAll(summaries, addresses, { activeEra, erasPerYear, windows = APR_WINDOWS } = {}) {
    const byEra = indexSummaries(summaries);
    const out = Object.create(null);
    for (const addr of addresses || []) {
        const per = {};
        for (const w of windows) per[String(w)] = validatorPerformance(byEra, addr, { activeEra, window: w, erasPerYear });
        out[addr] = per;
    }
    return out;
}

// Display text for the APR cell. Never a fabricated number: 'new' and 'none'
// render as words, and a real value carries two decimals.
export function aprLabel(perf) {
    if (!perf) return 'n/a';
    if (perf.status === 'ok' && Number.isFinite(perf.apr)) return `${perf.apr.toFixed(2)}%`;
    if (perf.status === 'new') return 'new';
    return 'n/a';
}
