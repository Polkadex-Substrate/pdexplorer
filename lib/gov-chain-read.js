// The chain reads behind the governance item pages (server.js govChain), as
// pure functions: a @polkadot/types codec in, plain data out. Split out of
// server.js so test/gov-chain-read.test.js can feed them REAL codecs built from
// runtime metadata (Substrate's, and the Polkadex 373 / 392 fixtures when
// present) under the installed @polkadot/api, rather than hand-made fakes.
//
// Imports only lib/discussion-lifecycle.js (itself import-free): the PDEX
// converter (toPdex) and the blake2-256 hasher (hashBytes) are passed in.

import { proposalHashOf } from './discussion-lifecycle.js';

// A Call codec for the item page: section, method and each argument's name,
// type and human-readable value (cut at maxLen characters).
export function describeCall(c, maxLen = 1000) {
    const meta = (c.meta && c.meta.args) || [];
    return {
        section: String(c.section), method: String(c.method),
        args: Array.from(c.args || []).map((a, i) => {
            let value;
            try { const h = a.toHuman(); value = typeof h === 'string' ? h : JSON.stringify(h); } catch (e) { try { value = String(a); } catch (_) { value = '[unprintable]'; } }
            if (value.length > maxLen) value = value.slice(0, maxLen) + '...(truncated)';
            return { name: meta[i] ? String(meta[i].name) : 'arg' + i, type: meta[i] ? String(meta[i].type) : null, value };
        })
    };
}

// democracy.referendumInfoOf(i): Option<ReferendumInfo>.
//   None                  -> { state: 'none' }
//   Ongoing(status)       -> { state: 'ongoing', end, threshold, delay, ayes, nays, turnout, bounded, proposalHash }
//   Finished { approved, end } -> { state: 'finished', approved, end }
// bounded is the codec itself (Bounded<Call> on current runtimes, a bare H256
// as `proposalHash` on old ones); lib/discussion-lifecycle.js takes it apart.
export function readReferendumInfo(opt, { toPdex, hashBytes } = {}) {
    if (!opt || opt.isNone) return { state: 'none' };
    const r = typeof opt.unwrap === 'function' ? opt.unwrap() : opt;
    if (r.isOngoing) {
        const s = r.asOngoing;
        const bounded = s.proposal || s.proposalHash || null;
        return {
            state: 'ongoing', end: s.end.toNumber(), threshold: s.threshold ? s.threshold.toString() : null,
            delay: s.delay ? s.delay.toNumber() : null,
            ayes: toPdex(s.tally.ayes), nays: toPdex(s.tally.nays), turnout: toPdex(s.tally.turnout),
            bounded, proposalHash: proposalHashOf(bounded, hashBytes)
        };
    }
    if (r.isFinished) { const f = r.asFinished; return { state: 'finished', approved: f.approved.isTrue, end: f.end.toNumber() }; }
    return { state: 'none' };
}

// democracy.depositOf(i): Option<(Vec<AccountId>, Balance)> on current
// runtimes, Option<(Balance, Vec<AccountId>)> on old ones.
export function readDepositOf(opt, { toPdex } = {}) {
    if (!opt || !opt.isSome) return null;
    const t = opt.unwrap();
    const listFirst = Array.isArray(t[0]) || (t[0] && typeof t[0].map === 'function' && !t[0].toBn);
    const list = listFirst ? t[0] : t[1];
    return { seconders: Array.from(list || []).map(a => String(a)), deposit: toPdex(listFirst ? t[1] : t[0]) };
}

// democracy.nextExternal(): Option<(Bounded<Call>, VoteThreshold)>.
export function readNextExternal(opt, { hashBytes } = {}) {
    if (!opt || !opt.isSome) return { absent: true };
    const ext = opt.unwrap();
    return { bounded: ext[0] || null, proposalHash: proposalHashOf(ext[0], hashBytes), threshold: ext[1] ? ext[1].toString() : null };
}

// democracy.publicProps(): Vec<(PropIndex, Bounded<Call>, AccountId)>; the
// entry for one index, or { absent: true }.
export function readPublicProp(list, index, { hashBytes } = {}) {
    for (const e of Array.from(list || [])) {
        if (Number(e[0].toString()) === Number(index)) return { bounded: e[1], proposalHash: proposalHashOf(e[1], hashBytes), proposer: String(e[e.length - 1]) };
    }
    return { absent: true };
}

// <collective>.voting(hash): Option<Votes { index, threshold, ayes, nays, end }>.
export function readCollectiveVoting(opt) {
    if (!opt || !opt.isSome) return null;
    const v = opt.unwrap();
    return { index: v.index.toNumber(), threshold: v.threshold.toNumber(), ayes: v.ayes.map(a => a.toString()), nays: v.nays.map(a => a.toString()), end: v.end.toNumber() };
}

// The preimage length from a preimage status, as its toJSON(), for the
// preimage.preimageFor((hash, len)) key. Two storage generations:
//   StatusFor (OldRequestStatus, the 373 runtime):
//     { unrequested: { deposit, len } } | { requested: { deposit, count, len: Option<u32> } }
//   RequestStatusFor (RequestStatus, pallet-preimage since polkadot-sdk 1.x,
//   the 392 runtime; new preimages are noted here, old ones move over lazily):
//     { unrequested: { ticket, len } } | { requested: { maybeTicket, count, maybeLen: Option<u32> } }
// null when the status is absent or carries no length.
export function preimageLen(statusJson) {
    const j = statusJson && typeof statusJson === 'object' ? statusJson : null;
    if (!j) return null;
    const v = j.unrequested || j.requested || j.Unrequested || j.Requested || null;
    if (!v || typeof v !== 'object') return null;
    for (const k of ['len', 'maybeLen', 'maybe_len']) {
        if (v[k] !== undefined && v[k] !== null) {
            const n = Number(v[k]);
            if (Number.isInteger(n) && n >= 0) return n;
        }
    }
    return null;
}

// The length of a noted preimage, reading RequestStatusFor first (where the
// 392 runtime notes new preimages) and then the deprecated StatusFor (where
// preimages noted before the upgrade stay until touched). pre is
// api.query.preimage. null when neither has it.
export async function notedPreimageLen(pre, hash) {
    if (!pre || !hash) return null;
    for (const item of ['requestStatusFor', 'statusFor']) {
        if (typeof pre[item] !== 'function') continue;
        const st = await pre[item](hash);
        if (st && st.isSome) {
            const len = preimageLen(st.unwrap().toJSON());
            if (len !== null) return len;
        }
    }
    return null;
}
