// Chain reads behind the stake picker's filters (indexer worker only).
//
// Two jobs, both cheap:
//
//   1. readEraSummary: one completed era, four storage reads, all era-level
//      (not per validator): erasValidatorReward, erasRewardPoints, and the
//      entries of erasStakersOverview and erasValidatorPrefs for that era. A
//      completed era never changes, so the caller stores it once and only ever
//      fetches eras it does not hold. First fill is HistoryDepth (84) eras;
//      after that, one era a day.
//
//   2. buildChoiceSnapshot: the current state of every validator CANDIDATE,
//      active and waiting (staking.validators is the full candidate list;
//      /api/validators only has the active set): commission, blocked flag,
//      current exposure, self-stake, backers, on-chain identity facts and
//      recent slashes, plus the realized APR from lib/stake-apr.js.
//
// The api handle and the two number converters are passed in, so the tests
// can run this against plain fakes without a node. Nothing here writes; the
// caller (server.js syncData) persists the results.

import { performanceForAll, erasPerYearFromMs, APR_WINDOWS } from './stake-apr.js';
import { FALLBACK_MAX_NOMINATIONS } from './stake-filters.js';

// Fallbacks, all checked against the 392 runtime source
// (runtimes/mainnet/src/lib.rs): MAX_QUOTA_NOMINATIONS = 16,
// MaxExposurePageSize = 256, HistoryDepth = 84. The nominations limit is not a
// pallet constant on 392 (there is no staking.maxNominations); it is the
// runtime API StakingApi.nominations_quota, see readNominationsQuota.
export { FALLBACK_MAX_NOMINATIONS };
export const FALLBACK_EXPOSURE_PAGE_SIZE = 256;
export const FALLBACK_HISTORY_DEPTH = 84;

function toNum(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v.toNumber === 'function') { try { return v.toNumber(); } catch (e) { /* too big */ } }
    const n = Number(String(v));
    return Number.isFinite(n) ? n : 0;
}

function unwrapOption(o) {
    if (o == null) return null;
    if (typeof o.isSome === 'boolean') return o.isSome ? o.unwrap() : null;
    if (typeof o.isNone === 'boolean') return o.isNone ? null : (o.unwrap ? o.unwrap() : o);
    return o;
}

function keyArg(key, i) {
    const args = key && key.args ? key.args : [];
    return args[i] != null ? String(args[i].toString()) : null;
}

export function readConst(api, pallet, name, fallback) {
    try {
        const c = api && api.consts && api.consts[pallet] && api.consts[pallet][name];
        const n = c == null ? NaN : Number(c.toString());
        return Number.isFinite(n) && n > 0 ? n : fallback;
    } catch (e) { return fallback; }
}

// Runtime era length in ms, the same derivation /api/wallet uses.
export function eraDurationMs(api) {
    const spe = readConst(api, 'staking', 'sessionsPerEra', 0);
    const epoch = readConst(api, 'babe', 'epochDuration', 0);
    const block = readConst(api, 'babe', 'expectedBlockTime', 0);
    return spe && epoch && block ? spe * epoch * block : 0;
}

// How many validators one nominator may name, from the runtime API
// StakingApi.nominations_quota(balance: u128) -> u32 (polkadot-js:
// api.call.stakingApi.nominationsQuota). The quota may depend on the bonded
// balance; the picker has no balance at snapshot time, so it asks for the
// smallest bond a nominator can hold (staking.minNominatorBond, 0 if unread),
// the least any nominator is allowed. On 392 the quota is fixed at 16
// whatever the balance. Falls back to 16, with a warning, only when the API is
// missing or fails.
export async function readNominationsQuota(api, { warn = (m) => console.warn(m) } = {}) {
    const fn = api && api.call && api.call.stakingApi && api.call.stakingApi.nominationsQuota;
    if (typeof fn !== 'function') {
        warn(`[stake-choice] stakingApi.nominationsQuota is not available; using ${FALLBACK_MAX_NOMINATIONS}`);
        return FALLBACK_MAX_NOMINATIONS;
    }
    try {
        let balance = 0;
        const q = api.query && api.query.staking;
        if (q && typeof q.minNominatorBond === 'function') {
            try { const b = await q.minNominatorBond(); if (b != null) balance = b; } catch (e) { /* keep 0 */ }
        }
        const n = toNum(await fn(balance));
        if (Number.isInteger(n) && n > 0) return n;
        warn(`[stake-choice] stakingApi.nominationsQuota returned ${n}; using ${FALLBACK_MAX_NOMINATIONS}`);
    } catch (e) {
        warn(`[stake-choice] stakingApi.nominationsQuota failed (${e && e.message ? e.message : e}); using ${FALLBACK_MAX_NOMINATIONS}`);
    }
    return FALLBACK_MAX_NOMINATIONS;
}

// Exposure overview for every validator elected in `era`.
// Returns { [address]: { total, own, nominatorCount, pageCount } } in PDEX.
export async function readEraExposures(api, era, { formatPDEX, pageSize = FALLBACK_EXPOSURE_PAGE_SIZE }) {
    const q = api.query.staking;
    const out = Object.create(null);
    if (q.erasStakersOverview && q.erasStakersOverview.entries) {
        for (const [key, opt] of await q.erasStakersOverview.entries(era)) {
            const meta = unwrapOption(opt);
            const addr = keyArg(key, 1);
            if (!meta || !addr) continue;
            out[addr] = {
                total: formatPDEX(meta.total),
                own: formatPDEX(meta.own),
                nominatorCount: toNum(meta.nominatorCount),
                pageCount: toNum(meta.pageCount)
            };
        }
        return out;
    }
    // Pre-paged runtimes: one full Exposure per validator.
    if (q.erasStakers && q.erasStakers.entries) {
        for (const [key, exp] of await q.erasStakers.entries(era)) {
            const addr = keyArg(key, 1);
            if (!exp || !addr) continue;
            const n = Array.isArray(exp.others) ? exp.others.length : toNum(exp.others && exp.others.length);
            out[addr] = {
                total: formatPDEX(exp.total),
                own: formatPDEX(exp.own),
                nominatorCount: n,
                pageCount: Math.max(1, Math.ceil(n / pageSize))
            };
        }
    }
    return out;
}

// One completed era. Returns null when the era's reward is not set yet (the
// active era, or a node that has not finished the era-end hook), so the caller
// retries it next time rather than storing a hole.
//   { era, reward, totalPoints, validators: { [addr]: { points, stake, commission } } }
export async function readEraSummary(api, era, { formatPDEX, commissionPercent }) {
    const q = api.query.staking;
    const rewardOpt = await q.erasValidatorReward(era);
    const rewardRaw = unwrapOption(rewardOpt);
    if (rewardRaw == null) return null;
    const [pointsRaw, exposures, prefsEntries] = await Promise.all([
        q.erasRewardPoints(era),
        readEraExposures(api, era, { formatPDEX }),
        q.erasValidatorPrefs && q.erasValidatorPrefs.entries ? q.erasValidatorPrefs.entries(era) : []
    ]);
    const commissions = Object.create(null);
    for (const [key, prefs] of prefsEntries) {
        const addr = keyArg(key, 1);
        if (addr) commissions[addr] = commissionPercent(prefs);
    }
    const individual = Object.create(null);
    const ind = pointsRaw && pointsRaw.individual;
    if (ind && typeof ind.entries === 'function') {
        for (const [acc, pts] of ind.entries()) individual[String(acc.toString())] = toNum(pts);
    } else if (ind && typeof ind === 'object') {
        for (const [acc, pts] of Object.entries(ind)) individual[acc] = toNum(pts);
    }
    const validators = {};
    for (const [addr, exp] of Object.entries(exposures)) {
        validators[addr] = {
            points: individual[addr] || 0,
            stake: exp.total,
            commission: commissions[addr] != null ? commissions[addr] : null
        };
    }
    return {
        era: Number(era),
        reward: formatPDEX(rewardRaw),
        totalPoints: toNum(pointsRaw && pointsRaw.total),
        validators
    };
}

// Which completed eras of the history window are not stored yet.
export function missingEras(activeEra, historyDepth, haveEras) {
    const have = new Set((haveEras || []).map(Number));
    const out = [];
    const first = Math.max(Number(activeEra) - Number(historyDepth), 0);
    for (let e = Number(activeEra) - 1; e >= first; e--) if (!have.has(e)) out.push(e);
    return out;
}

// Name of a Judgement value in either .toHuman() form: 'Reasonable' or { FeePaid: '..' }.
function judgementName(j) {
    if (j == null) return '';
    if (typeof j === 'string') return j;
    if (typeof j === 'object') return Object.keys(j)[0] || '';
    return String(j);
}

// Is any judgement on this identity a positive one? Reasonable and KnownGood
// are the two a registrar gives after checking; FeePaid is only a request.
export function isVerifiedJudgements(judgements) {
    if (!Array.isArray(judgements)) return false;
    return judgements.some(pair => {
        const j = Array.isArray(pair) ? pair[1] : pair;
        const name = judgementName(j).toLowerCase();
        return name === 'reasonable' || name === 'knowngood';
    });
}

// identityOf has two storage shapes (see lib/identity.js): Registration, or a
// (Registration, Option<Username>) tuple. Returns the Registration or null.
export function registrationFromHuman(human) {
    if (!human) return null;
    if (Array.isArray(human)) return human[0] && typeof human[0] === 'object' ? human[0] : null;
    return typeof human === 'object' ? human : null;
}

// On-chain identity facts for one validator. Only the chain is consulted:
// `parent` is the identity.superOf parent when this account is a sub-identity.
// Nothing is inferred about who runs a validator beyond what the chain says.
export async function readIdentityFacts(api, address) {
    const empty = { hasIdentity: false, verified: false, parent: null };
    const idq = api && api.query && api.query.identity;
    if (!idq || !idq.identityOf) return empty;
    try {
        let parent = null;
        if (idq.superOf) {
            const sup = unwrapOption(await idq.superOf(address));
            // (AccountId, Data): a Tuple codec is array-like, element 0 is the parent.
            if (sup) parent = String((sup[0] != null ? sup[0] : sup).toString());
        }
        const opt = await idq.identityOf(parent || address);
        const raw = unwrapOption(opt);
        if (!raw) return { ...empty, parent };
        const human = raw.toHuman ? raw.toHuman() : raw;
        const reg = registrationFromHuman(human);
        return { hasIdentity: !!reg, verified: !!(reg && isVerifiedJudgements(reg.judgements)), parent };
    } catch (e) {
        return empty;
    }
}

// A bool that may be a JS boolean or a polkadot-js bool codec.
export function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (v && typeof v.isTrue === 'boolean') return v.isTrue;
    if (v && typeof v.toJSON === 'function') return v.toJSON() === true;
    return false;
}

async function inChunks(items, size, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
    }
    return out;
}

// Bonded self-stake (ledger.active) per stash.
async function readSelfStakes(api, addresses, formatPDEX) {
    const q = api.query.staking;
    const out = Object.create(null);
    await inChunks(addresses, 25, async (addr) => {
        try {
            const ctrl = unwrapOption(await q.bonded(addr));
            const ledger = unwrapOption(await q.ledger(ctrl ? ctrl.toString() : addr));
            out[addr] = ledger ? formatPDEX(ledger.active) : 0;
        } catch (e) { out[addr] = null; }
    });
    return out;
}

// How many nominators name each validator in their current targets. This is
// intent for the NEXT election; the exposure count is who backs it this era.
async function readBackers(api) {
    const counts = Object.create(null);
    const q = api.query.staking;
    if (!q.nominators || !q.nominators.entries) return counts;
    for (const [, opt] of await q.nominators.entries()) {
        const nom = unwrapOption(opt);
        const targets = nom && nom.targets ? nom.targets : [];
        for (const t of targets) {
            const a = String(t.toString());
            counts[a] = (counts[a] || 0) + 1;
        }
    }
    return counts;
}

// Eras each validator was slashed in, from validatorSlashInEra (kept by the
// chain for the bonding/history window).
async function readSlashEras(api) {
    const out = Object.create(null);
    const q = api.query.staking;
    if (!q.validatorSlashInEra || !q.validatorSlashInEra.entries) return out;
    for (const [key] of await q.validatorSlashInEra.entries()) {
        const era = Number(keyArg(key, 0));
        const addr = keyArg(key, 1);
        if (!addr || !Number.isFinite(era)) continue;
        (out[addr] || (out[addr] = [])).push(era);
    }
    for (const a of Object.keys(out)) out[a].sort((x, y) => y - x);
    return out;
}

// The full snapshot the picker reads. `summaries` are stored era summaries;
// `getName` is the server's cached display-name lookup.
export async function buildChoiceSnapshot({ api, activeEra, summaries, formatPDEX, commissionPercent, getName, now = Date.now(), warn }) {
    const q = api.query.staking;
    const pageSize = readConst(api, 'staking', 'maxExposurePageSize', FALLBACK_EXPOSURE_PAGE_SIZE);
    const maxNominations = await readNominationsQuota(api, warn ? { warn } : undefined);
    const historyDepth = readConst(api, 'staking', 'historyDepth', FALLBACK_HISTORY_DEPTH);
    const eraMs = eraDurationMs(api);
    const erasPerYear = erasPerYearFromMs(eraMs);

    const [candidateEntries, sessionVals, exposures, backers, slashEras] = await Promise.all([
        q.validators.entries(),
        api.query.session.validators(),
        readEraExposures(api, activeEra, { formatPDEX, pageSize }),
        readBackers(api),
        readSlashEras(api)
    ]);
    const active = new Set([...sessionVals].map(a => String(a.toString())));
    const candidates = [];
    for (const [key, prefs] of candidateEntries) {
        const addr = keyArg(key, 0);
        if (addr) candidates.push({ address: addr, prefs });
    }
    // Validators in the session set but already chilled still back blocks this
    // era; keep them so the active count matches the chain.
    for (const a of active) if (!candidates.some(c => c.address === a)) candidates.push({ address: a, prefs: null });

    const addresses = candidates.map(c => c.address);
    const [selfStakes, identities, names] = await Promise.all([
        readSelfStakes(api, addresses, formatPDEX),
        inChunks(addresses, 20, a => readIdentityFacts(api, a)),
        inChunks(addresses, 20, a => Promise.resolve().then(() => getName(a)).catch(() => 'Unknown'))
    ]);
    const perf = performanceForAll(summaries, addresses, { activeEra, erasPerYear });

    const validators = candidates.map((c, i) => {
        const exp = exposures[c.address] || null;
        const blocked = !!(c.prefs && toBool(c.prefs.blocked));
        return {
            address: c.address,
            name: names[i] || 'Unknown',
            active: active.has(c.address),
            commission: c.prefs ? commissionPercent(c.prefs) : null,
            blocked,
            totalStake: exp ? exp.total : null,
            selfStake: selfStakes[c.address],
            exposureNominators: exp ? exp.nominatorCount : null,
            exposurePages: exp ? exp.pageCount : null,
            backers: backers[c.address] || 0,
            identity: identities[i],
            slashEras: slashEras[c.address] || [],
            perf: perf[c.address]
        };
    });

    return {
        generatedAt: now,
        activeEra,
        eraDurationMs: eraMs,
        erasPerYear,
        windows: APR_WINDOWS,
        erasHeld: (summaries || []).length,
        maxNominations,
        exposurePageSize: pageSize,
        historyDepth,
        validators
    };
}
