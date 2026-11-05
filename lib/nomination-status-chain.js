// The chain reads behind GET /api/account/:address/staking-status: the
// account's nominations and, for each nominated validator, what
// lib/nomination-status.js classifies. One request per account; the
// per-validator reads run in parallel (at most 16 targets on spec 392).
// Tested in test/nomination-status.test.js, against a hand-built api and
// real spec 392 codecs.
//
// Sources (all present on spec 392, checked against the metadata fixture):
//   Staking.Nominators            targets, submittedIn
//   Staking.Validators            prefs (commission, blocked); it is a
//                                 ValueQuery, so "is a validator" is the
//                                 entry's .size() > 0, never the default prefs
//   Staking.ErasStakersOverview   elected for the active era
//   Staking.SlashingSpans         lastNonzeroSlash
//   Session.Validators            the session set; its index is imOnline's
//                                 authority index
//   Session.DisabledValidators    [(index, severity)] (older runtimes: [index])
//   ImOnline.ReceivedHeartbeats   (session, authority index) -> heartbeat
//   ImOnline.AuthoredBlocks       (session, validator) -> blocks this session
//   Babe EpochIndex, GenesisSlot, CurrentSlot + EpochDuration: how far the
//                                 session is (a session is one epoch)
// incidents(address, sinceBlock) is the optional index lookup (db.js
// getValidatorIncidents); nameOf(address) the optional identity lookup.

const fn = (obj, name) => (obj && typeof obj[name] === 'function' ? obj[name] : null);
const soft = (p) => Promise.resolve(p).then((v) => v, () => null);
const some = (o) => (o && typeof o.isSome === 'boolean' ? (o.isSome ? o.unwrap() : null) : (o == null ? null : o));
const num = (x) => { if (x == null) return null; const v = Number(typeof x.toNumber === 'function' ? x.toNumber() : x.toString()); return Number.isFinite(v) ? v : null; };
const bool = (x) => { if (x == null) return false; if (typeof x === 'boolean') return x; if (typeof x.isTrue === 'boolean') return x.isTrue; return !!(typeof x.valueOf === 'function' ? x.valueOf() : x); };
export const INCIDENT_WINDOW_BLOCKS = 7 * 7200;   // about a week of 12 s blocks

function sessionProgress(babe, epochDuration) {
    if (!babe || !(epochDuration > 0)) return null;
    const [idx, genesis, slot] = babe.map(num);
    if (idx == null || genesis == null || slot == null) return null;
    const p = (slot - (genesis + idx * epochDuration)) / epochDuration;
    return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : null;
}

export async function readNominationStatus(api, address, { incidents = null, nameOf = null } = {}) {
    const q = api.query, c = api.consts || {};
    const nom = some(await q.staking.nominators(address));
    if (!nom) return { address: String(address), nominating: false, targets: [] };
    const targets = Array.from(nom.targets || []).map(String);
    const b = q.babe || {};
    const [act, cur, number, sessionVals, sessionIdx, disabled, babe] = await Promise.all([
        q.staking.activeEra(), fn(q.staking, 'currentEra') ? soft(q.staking.currentEra()) : null,
        fn(q.system, 'number') ? soft(q.system.number()) : null,
        fn(q.session, 'validators') ? soft(q.session.validators()) : null,
        fn(q.session, 'currentIndex') ? soft(q.session.currentIndex()) : null,
        fn(q.session, 'disabledValidators') ? soft(q.session.disabledValidators()) : null,
        fn(b, 'epochIndex') && fn(b, 'genesisSlot') && fn(b, 'currentSlot') ? soft(Promise.all([b.epochIndex(), b.genesisSlot(), b.currentSlot()])) : null
    ]);
    const a = some(act);
    const activeEra = a ? num(a.index) : null;
    const session = Array.from(sessionVals || []).map(String);
    const sIndex = num(sessionIdx);
    const disabledIdx = new Set(Array.from(disabled || []).map(d => num(Array.isArray(d) ? d[0] : d)));
    const im = q.imOnline && fn(q.imOnline, 'receivedHeartbeats') && fn(q.imOnline, 'authoredBlocks') && sIndex != null ? q.imOnline : null;
    const block = num(number);
    const since = block == null ? 0 : Math.max(0, block - INCIDENT_WINDOW_BLOCKS);
    const size = fn(q.staking.validators, 'size');

    const rows = await Promise.all(targets.map(async (t) => {
        const idx = session.indexOf(t);
        const [prefs, sz, overview, spans, hb, blocks, name] = await Promise.all([
            q.staking.validators(t),
            size ? q.staking.validators.size(t) : null,
            activeEra != null && fn(q.staking, 'erasStakersOverview') ? q.staking.erasStakersOverview(activeEra, t) : null,
            fn(q.staking, 'slashingSpans') ? soft(q.staking.slashingSpans(t)) : null,
            im && idx >= 0 ? soft(im.receivedHeartbeats(sIndex, idx)) : null,
            im && idx >= 0 ? soft(im.authoredBlocks(sIndex, t)) : null,
            nameOf ? soft(nameOf(t)) : null
        ]);
        let inc = [];
        try { inc = incidents ? (await incidents(t, since)) || [] : []; } catch (_) { inc = []; }
        const sp = some(spans);
        const hbv = some(hb);
        return {
            address: t, name: name ? String(name) : null,
            intent: size ? (num(sz) || 0) > 0 : null,
            commission: num(prefs && prefs.commission) ?? 0, blocked: bool(prefs && prefs.blocked),
            elected: !!some(overview), inSession: idx >= 0,
            heartbeat: im && idx >= 0 ? (hbv == null ? false : bool(hbv)) : null,
            blocks: im && idx >= 0 ? (num(blocks) ?? 0) : null,
            disabled: idx >= 0 && disabledIdx.has(idx),
            lastSlashEra: sp ? num(sp.lastNonzeroSlash) : null,
            incidents: Array.isArray(inc) ? inc : []
        };
    }));
    const epochDuration = num(c.babe && c.babe.epochDuration);
    return {
        address: String(address), nominating: true, submittedIn: num(nom.submittedIn), activeEra, currentEra: num(some(cur)),
        sessionIndex: sIndex, sessionProgress: sessionProgress(babe, epochDuration), validatorCount: session.length,
        imOnline: !!q.imOnline && !!im, bondingDuration: num(c.staking && c.staking.bondingDuration), block, targets: rows
    };
}
