// The chain reads behind the validator status, the live parameters and the
// session keys check. Import-free apart from the pure modules; the api is
// passed in. Tested in test/validator-status.test.js against a hand-built api
// and real spec 393 codecs.
//
// Sources (spec 393; polkadot-sdk polkadot-stable2512-3):
//   Staking.Bonded(stash)               controller (the stash itself unless legacy)
//   Staking.Ledger(controller)          total, active
//   Staking.Validators(stash)           prefs; a ValueQuery, so "asking to
//                                       validate" is .size() > 0
//   Staking.ErasStakersOverview         exposure for the active era (and the
//                                       planned one when CurrentEra > ActiveEra)
//   Staking.ErasRewardPoints, ErasValidatorReward  points, rank, last era reward
//   Staking.ErasStartSessionIndex       when the era began, for the countdown
//   Staking.SlashingSpans               last nonzero slash
//   Staking.MinValidatorBond, MinCommission, MaxValidatorsCount (OptionQuery),
//   CounterForValidators, ValidatorCount, ChillThreshold: governance values
//   Session.NextKeys(stash), QueuedKeys, Validators, CurrentIndex,
//   DisabledValidators, KeyOwner((KeyTypeId, key))
//   ImOnline.Keys[index], ReceivedHeartbeats, AuthoredBlocks
//   Babe EpochIndex, GenesisSlot, CurrentSlot + EpochDuration: session progress
//   Proxy.Proxies(stash), Identity.IdentityOf(stash)
//   ElectionProviderMultiPhase.CurrentPhase
// A read that fails is unknown (null), never a negative answer.

import { layoutFromRegistry, checkLayout, EXPECTED_LAYOUT } from './session-keys.js';
import { INCIDENT_WINDOW_BLOCKS } from './nomination-status-chain.js';

const fn = (obj, name) => (obj && typeof obj[name] === 'function' ? obj[name] : null);
const soft = (p) => Promise.resolve(p).then((v) => v, () => null);
const FAILED = Symbol('failed');
const softOr = (p) => Promise.resolve(p).then((v) => v, () => FAILED);
const some = (o) => (o && typeof o.isSome === 'boolean' ? (o.isSome ? o.unwrap() : null) : (o == null ? null : o));
const num = (x) => { if (x == null) return null; const v = Number(typeof x.toNumber === 'function' ? x.toNumber() : x.toString()); return Number.isFinite(v) ? v : null; };
const bigStr = (x) => { if (x == null) return null; try { return (typeof x.toBigInt === 'function' ? x.toBigInt() : BigInt(x.toString())).toString(); } catch (e) { return null; } };
const bool = (x) => { if (x == null) return false; if (typeof x === 'boolean') return x; if (typeof x.isTrue === 'boolean') return x.isTrue; return !!(typeof x.valueOf === 'function' ? x.valueOf() : x); };
const hex = (x) => (x == null ? null : String(typeof x.toHex === 'function' ? x.toHex() : x).toLowerCase());
const camel = (s) => s.replace(/_([a-z])/g, (m, c) => c.toUpperCase());

// A SessionKeys codec (or its JSON) as { snake_name: hex }.
export function keysToMap(codec, layout = EXPECTED_LAYOUT) {
    if (!codec) return null;
    const j = typeof codec.toJSON === 'function' ? codec.toJSON() : codec;
    if (!j || typeof j !== 'object') return null;
    const out = {};
    for (const k of layout) {
        const v = j[k.name] ?? j[camel(k.name)];
        if (v != null) out[k.name] = String(v).toLowerCase();
    }
    return out;
}

function sessionProgress(babe, epochDuration) {
    if (!babe || !(epochDuration > 0)) return null;
    const [idx, genesis, slot] = babe.map(num);
    if (idx == null || genesis == null || slot == null) return null;
    const p = (slot - (genesis + idx * epochDuration)) / epochDuration;
    return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : null;
}

async function common(api) {
    const q = api.query, b = q.babe || {};
    const [act, cur, sessionIdx, babe] = await Promise.all([
        q.staking.activeEra(), fn(q.staking, 'currentEra') ? soft(q.staking.currentEra()) : null,
        fn(q.session, 'currentIndex') ? soft(q.session.currentIndex()) : null,
        fn(b, 'epochIndex') && fn(b, 'genesisSlot') && fn(b, 'currentSlot') ? soft(Promise.all([b.epochIndex(), b.genesisSlot(), b.currentSlot()])) : null
    ]);
    const c = api.consts || {};
    const epochDuration = num(c.babe && c.babe.epochDuration);
    const a = some(act);
    return {
        activeEra: a ? num(a.index) : null, currentEra: num(some(cur)), sessionIndex: num(sessionIdx),
        sessionProgress: sessionProgress(babe, epochDuration), epochDuration,
        blockTimeMs: num(c.babe && c.babe.expectedBlockTime), sessionsPerEra: num(c.staking && c.staking.sessionsPerEra),
        bondingDuration: num(c.staking && c.staking.bondingDuration)
    };
}

function rankOf(pointsCodec, address) {
    if (!pointsCodec || !pointsCodec.individual) return null;
    const entries = Array.from(typeof pointsCodec.individual.entries === 'function' ? pointsCodec.individual.entries() : []).map(([k, v]) => [String(k), num(v) || 0]);
    const mine = entries.find(([k]) => k === String(address));
    if (!mine) return null;
    return { points: mine[1], rank: 1 + entries.filter(([, v]) => v > mine[1]).length, of: entries.length, total: num(pointsCodec.total) };
}

async function readIdentity(api, address, nameOf) {
    const q = api.query.identity;
    const [name, reg] = await Promise.all([nameOf ? soft(nameOf(address)) : null, q && fn(q, 'identityOf') ? soft(q.identityOf(address)) : null]);
    let judgements = [];
    const r = some(reg);
    const regn = Array.isArray(r) ? r[0] : r;
    if (regn && regn.judgements) judgements = Array.from(regn.judgements).map(j => String(Array.isArray(j) ? j[1] : j && j[1] != null ? j[1] : j)).filter(x => x && x !== 'Unknown');
    if (!name || name === 'Unknown') return judgements.length ? { name: null, judgements } : null;
    return { name: String(name), judgements };
}

export async function readValidatorStatus(api, address, { incidents = null, nameOf = null } = {}) {
    const q = api.query;
    const stash = String(address);
    const base = await common(api);
    const bondedTo = some(await q.staking.bonded(stash));
    const identity = await readIdentity(api, stash, nameOf);
    const empty = { address: stash, ...base, bonded: false, controller: null, ledger: null, intent: false, prefs: null, nextKeys: null, queuedKeys: null,
        inQueued: false, inSession: false, sessionValidatorIndex: -1, sessionValidatorCount: null, activeImOnlineKey: null, disabled: false,
        imOnline: !!q.imOnline, heartbeat: null, blocks: null, exposure: null, nextExposure: null, points: null, lastEra: null,
        lastSlashEra: null, incidents: [], identity, proxies: [] };
    if (!bondedTo) {
        // An unbonded account can still sit in the session set until the era ends; check it.
        const sessionVals = fn(q.session, 'validators') ? Array.from((await soft(q.session.validators())) || []).map(String) : [];
        if (!sessionVals.includes(stash)) return empty;
    }
    const controller = bondedTo ? String(bondedTo) : null;
    const st = q.staking, se = q.session, im = q.imOnline;
    const size = fn(st.validators, 'size');
    const era = base.activeEra;
    const [ledger, prefs, sz, nextKeys, queued, sessionVals, disabled, overview, nextOverview, ptsNow, ptsLast, lastReward, eraStart, spans, proxies, number] = await Promise.all([
        controller ? soft(st.ledger(controller)) : null,
        soft(st.validators(stash)),
        size ? soft(st.validators.size(stash)) : null,
        fn(se, 'nextKeys') ? soft(se.nextKeys(stash)) : null,
        fn(se, 'queuedKeys') ? soft(se.queuedKeys()) : null,
        fn(se, 'validators') ? soft(se.validators()) : null,
        fn(se, 'disabledValidators') ? soft(se.disabledValidators()) : null,
        era != null && fn(st, 'erasStakersOverview') ? soft(st.erasStakersOverview(era, stash)) : null,
        era != null && base.currentEra != null && base.currentEra > era && fn(st, 'erasStakersOverview') ? soft(st.erasStakersOverview(base.currentEra, stash)) : null,
        era != null && fn(st, 'erasRewardPoints') ? soft(st.erasRewardPoints(era)) : null,
        era != null && era > 0 && fn(st, 'erasRewardPoints') ? soft(st.erasRewardPoints(era - 1)) : null,
        era != null && era > 0 && fn(st, 'erasValidatorReward') ? soft(st.erasValidatorReward(era - 1)) : null,
        era != null && fn(st, 'erasStartSessionIndex') ? soft(st.erasStartSessionIndex(era)) : null,
        fn(st, 'slashingSpans') ? soft(st.slashingSpans(stash)) : null,
        q.proxy && fn(q.proxy, 'proxies') ? soft(q.proxy.proxies(stash)) : null,
        q.system && fn(q.system, 'number') ? soft(q.system.number()) : null
    ]);
    const session = Array.from(sessionVals || []).map(String);
    const idx = session.indexOf(stash);
    const disabledIdx = new Set(Array.from(disabled || []).map(d => num(Array.isArray(d) ? d[0] : d)));
    const sIndex = base.sessionIndex;
    const imOk = im && fn(im, 'receivedHeartbeats') && fn(im, 'authoredBlocks') && sIndex != null && idx >= 0;
    const [imKeys, hb, blocks] = await Promise.all([
        im && fn(im, 'keys') && idx >= 0 ? soft(im.keys()) : null,
        imOk ? softOr(im.receivedHeartbeats(sIndex, idx)) : null,
        imOk ? softOr(im.authoredBlocks(sIndex, stash)) : null
    ]);
    const queuedList = Array.from(queued || []).map(([acc, k]) => ({ account: String(acc), keys: keysToMap(k) }));
    const mineQueued = queuedList.find(e => e.account === stash);
    const led = some(ledger);
    const ov = some(overview), nov = some(nextOverview);
    const exposure = ov ? { total: bigStr(ov.total), own: bigStr(ov.own), nominatorCount: num(ov.nominatorCount), pageCount: num(ov.pageCount) } : null;
    const lastPts = rankOf(ptsLast, stash);
    const reward = some(lastReward);
    let lastEra = null;
    if (lastPts) {
        let r = null;
        try { if (reward != null && lastPts.total) r = ((BigInt(bigStr(reward)) * BigInt(lastPts.points)) / BigInt(lastPts.total)).toString(); } catch (e) { r = null; }
        lastEra = { points: lastPts.points, reward: r };
    }
    const nowPts = rankOf(ptsNow, stash);
    const sp = some(spans);
    const proxyList = proxies ? Array.from(Array.isArray(proxies) ? proxies[0] || [] : (proxies[0] || [])).map(p => ({ delegate: String(p.delegate), type: String(p.proxyType) })) : [];
    const block = num(number);
    let inc = [];
    try { inc = incidents ? (await incidents(stash, block == null ? 0 : Math.max(0, block - INCIDENT_WINDOW_BLOCKS))) || [] : []; } catch (e) { inc = []; }
    const intent = size ? (num(sz) || 0) > 0 : null;
    const hbv = hb === FAILED ? null : some(hb);
    return {
        ...empty,
        bonded: !!bondedTo, controller,
        ledger: led ? { total: bigStr(led.total), active: bigStr(led.active) } : null,
        intent, prefs: intent ? { commission: num(prefs && prefs.commission) ?? 0, blocked: bool(prefs && prefs.blocked) } : null,
        nextKeys: keysToMap(some(nextKeys)), queuedKeys: mineQueued ? mineQueued.keys : null, inQueued: !!mineQueued,
        inSession: idx >= 0, sessionValidatorIndex: idx, sessionValidatorCount: session.length,
        activeImOnlineKey: imKeys && idx >= 0 ? hex(Array.from(imKeys)[idx]) : null,
        disabled: idx >= 0 && disabledIdx.has(idx),
        heartbeat: imOk && hb !== FAILED ? (hbv == null ? false : bool(hbv)) : null,
        blocks: imOk && blocks !== FAILED ? (num(blocks) ?? 0) : null,
        exposure, nextExposure: nov ? { total: bigStr(nov.total) } : null,
        points: nowPts ? { points: nowPts.points, rank: nowPts.rank, of: nowPts.of } : null, lastEra,
        eraStartSession: num(some(eraStart)),
        lastSlashEra: sp ? num(sp.lastNonzeroSlash) : null,
        incidents: Array.isArray(inc) ? inc : [], proxies: proxyList
    };
}

function median(values) {
    const v = values.filter(x => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : Math.floor((v[m - 1] + v[m]) / 2);
}

// GET /api/validator/params. Bounded: the two .entries() reads are one era's
// exposures and prefs, at most MaxValidatorSet rows; the route caches 60 s.
export async function readValidatorParams(api) {
    const q = api.query, st = q.staking;
    const base = await common(api);
    const era = base.activeEra;
    const [minBond, minComm, maxCount, counter, count, chill, overviews, prefs, phase] = await Promise.all([
        st.minValidatorBond(), st.minCommission(),
        fn(st, 'maxValidatorsCount') ? st.maxValidatorsCount() : null,
        fn(st, 'counterForValidators') ? soft(st.counterForValidators()) : null,
        fn(st, 'validatorCount') ? soft(st.validatorCount()) : null,
        fn(st, 'chillThreshold') ? soft(st.chillThreshold()) : null,
        era != null && st.erasStakersOverview && fn(st.erasStakersOverview, 'entries') ? soft(st.erasStakersOverview.entries(era)) : null,
        era != null && st.erasValidatorPrefs && fn(st.erasValidatorPrefs, 'entries') ? soft(st.erasValidatorPrefs.entries(era)) : null,
        q.electionProviderMultiPhase && fn(q.electionProviderMultiPhase, 'currentPhase') ? soft(q.electionProviderMultiPhase.currentPhase()) : null
    ]);
    const totals = Array.from(overviews || []).map(([, v]) => { const o = some(v); return o ? bigStr(o.total) : null; }).filter(x => x != null).map(BigInt);
    const lowest = totals.length ? totals.reduce((a, b) => (b < a ? b : a)).toString() : null;
    const ch = some(chill);
    const specVersion = num(api.runtimeVersion && api.runtimeVersion.specVersion);
    return {
        specVersion,
        layout: checkLayout(layoutFromRegistry(api.registry)),
        minValidatorBond: bigStr(minBond), minCommission: num(minComm),
        maxValidatorsCount: num(some(maxCount)),
        counterForValidators: num(counter), validatorCount: num(count),
        chillThreshold: ch == null ? null : num(ch),
        lowestElectedTotal: lowest, electedCount: totals.length,
        medianCommission: median(Array.from(prefs || []).map(([, v]) => num(v && v.commission))),
        electionPhase: phase == null ? null : String(phase.type || phase.toString()),
        ...base
    };
}

// The session keys check: KeyOwner for each key, all of QueuedKeys, the
// stash's NextKeys. keys: parseSessionKeys(..).keys.
export async function readKeyOwners(api, keys, stash = '') {
    const se = api.query.session;
    const typeBytes = (t) => Uint8Array.from(Array.from(t).map(c => c.charCodeAt(0)));
    const [owners, queued, next] = await Promise.all([
        Promise.all(keys.map(k => se.keyOwner([typeBytes(k.typeId), k.hex]).then(o => { const v = some(o); return v ? String(v) : null; }))),
        fn(se, 'queuedKeys') ? se.queuedKeys() : [],
        stash && fn(se, 'nextKeys') ? se.nextKeys(stash) : null
    ]);
    return {
        owners,
        queued: Array.from(queued || []).map(([acc, k]) => ({ account: String(acc), keys: keysToMap(k) })),
        nextKeys: keysToMap(some(next))
    };
}
