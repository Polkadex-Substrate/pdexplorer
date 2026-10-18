// Live democracy state, straight from chain storage (browser side).
//
// The Democracy page showed the backend snapshot from page entry until a
// reload: a vote, a new referendum or one ending was invisible while the page
// was open. While the page is open this module keeps storage subscriptions on
// the browser's own node connection:
//
//   democracy.referendumCount / lowestUnbaked   which referenda can be open
//   democracy.referendumInfoOf.multi(indexes)   status and tally of those
//   democracy.publicProps                       the public proposal queue
//   democracy.depositOf.multi(indexes)          seconds of listed proposals
//   democracy.votingOf(account)                 the connected account's votes
//
// The referendum subscription is replaced whenever the watched set changes:
// lowestUnbaked..referendumCount, plus any index REST lists as open, plus any
// the feed itself last saw Ongoing (so a referendum is watched until its end
// is seen, even when lowestUnbaked moves past it first). Every storage item is
// checked before use; a runtime without one simply has less live data. It
// never subscribes to system.events. stop() releases everything, including
// subscriptions whose promise resolves after stop().
//
// No DOM and no imports: test/democracy-live.test.js drives it with a fake.

export const MAX_WATCHED_REFERENDA = 64;

const num = (x) => (x && typeof x.toNumber === 'function' ? x.toNumber() : Number(x));
const isFn = (f) => typeof f === 'function';
const isIndex = (i) => Number.isInteger(i) && i >= 0;

// Balance (codec, decimal or hex string) to a PDEX number, 12 decimals, the
// same rounding as the server's formatPDEX.
export function planckToPdex(x) {
    if (x === null || x === undefined) return 0;
    try {
        const p = BigInt(String(x));
        return Number(p / 1000000000000n) + Number(p % 1000000000000n) / 1e12;
    } catch (_) {
        const n = Number(x);
        return Number.isFinite(n) ? n / 1e12 : 0;
    }
}

export function resolveDemocracy(api) {
    const d = api && api.query && api.query.democracy;
    if (!d || !isFn(d.referendumCount) || !d.referendumInfoOf || !isFn(d.referendumInfoOf.multi)) return null;
    return d;
}

const clip = (v) => { if (v === null || v === undefined) return null; const s = String(v); return s.slice(0, 66); };

// Option<ReferendumInfo> to the row shape /api/democracy uses, or null. A
// finished referendum no longer carries its tally on chain, so the last one
// seen (prev) is kept.
export function decodeReferendum(index, opt, prev) {
    if (!opt || opt.isNone || !opt.isSome) return null;
    const r = opt.unwrap();
    if (r.isOngoing) {
        const s = r.asOngoing;
        const t = s.tally || {};
        return { refIndex: index, status: 'Ongoing', endBlock: num(s.end),
            ayes: planckToPdex(t.ayes), nays: planckToPdex(t.nays), turnout: planckToPdex(t.turnout), tallyKnown: 1,
            threshold: s.threshold ? String(s.threshold) : null, proposal: clip(s.proposal || s.proposalHash) };
    }
    if (r.isFinished) {
        const f = r.asFinished;
        const p = prev || {};
        return { refIndex: index, status: f.approved && f.approved.isTrue ? 'Passed' : 'NotPassed', endBlock: num(f.end),
            ayes: p.tallyKnown ? p.ayes : null, nays: p.tallyKnown ? p.nays : null, turnout: p.tallyKnown ? p.turnout : null,
            tallyKnown: p.tallyKnown ? 1 : 0 };
    }
    return null;
}

// Option<(Vec<AccountId>, Balance)>, or the older (Balance, Vec<AccountId>).
export function decodeDeposit(opt) {
    if (!opt || !opt.isSome) return null;
    const t = opt.unwrap();
    const a = t[0], b = t[1];
    const list = Array.isArray(a) ? a : b;
    const balance = Array.isArray(a) ? b : a;
    return { seconds: Array.isArray(list) ? list.length : 0, deposit: planckToPdex(balance) };
}

function accountVote(v) {
    if (v && v.isStandard) {
        const s = v.asStandard;
        return { aye: !!(s.vote && s.vote.isAye), conviction: s.vote && s.vote.conviction ? String(s.vote.conviction) : null, balance: planckToPdex(s.balance) };
    }
    if (v && (v.isSplit || v.isSplitAbstain)) {
        const s = v.isSplit ? v.asSplit : v.asSplitAbstain;
        const ayeBalance = planckToPdex(s.aye), nayBalance = planckToPdex(s.nay);
        return { split: true, aye: null, ayeBalance, nayBalance, balance: ayeBalance + nayBalance };
    }
    return null;
}

// Voting (Direct { votes } | Delegating) to { delegating, votes: { ref: vote } }.
export function decodeVoting(v) {
    if (!v) return null;
    if (v.isDelegating) return { delegating: true, votes: {} };
    const votes = {};
    if (v.isDirect) {
        for (const pair of Array.from(v.asDirect.votes || [])) {
            const i = num(pair[0]);
            const vote = accountVote(pair[1]);
            if (isIndex(i) && vote) votes[i] = vote;
        }
    }
    return { delegating: false, votes };
}

// The referendum indexes to watch, sorted, newest MAX_WATCHED_REFERENDA kept.
export function watchedReferenda({ count, lowestUnbaked, known, held, restCount }) {
    const set = new Set();
    const add = (i) => { if (isIndex(i)) set.add(i); };
    const c = Number(count);
    if (Number.isInteger(c) && c > 0) {
        const from = lowestUnbaked === null || lowestUnbaked === undefined ? Number(restCount) || 0 : Number(lowestUnbaked);
        for (let i = Math.max(0, c - MAX_WATCHED_REFERENDA, Number.isInteger(from) ? from : 0); i < c; i++) add(i);
    }
    for (const i of Array.isArray(known) ? known : []) add(i);
    for (const i of Array.isArray(held) ? held : []) add(i);
    return Array.from(set).sort((x, y) => x - y).slice(-MAX_WATCHED_REFERENDA);
}

const sameList = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * opts.onUpdate(kind, state)  kind: 'refs' | 'props' | 'deposits' | 'voting' | 'count'
 * opts.knownOpen()  -> referendum indexes the REST data has as Ongoing
 * opts.restCount()  -> REST referendumCount (only used without lowestUnbaked)
 * opts.account      -> address whose votingOf to watch, or null
 * opts.toAddress    -> display normalisation for proposer addresses
 * Returns { state, stop() }.
 */
export function startDemocracyLive(api, opts = {}) {
    const onUpdate = isFn(opts.onUpdate) ? opts.onUpdate : () => {};
    const onError = isFn(opts.onError) ? opts.onError : () => {};
    const knownOpen = isFn(opts.knownOpen) ? opts.knownOpen : () => [];
    const restCount = isFn(opts.restCount) ? opts.restCount : () => 0;
    const toAddress = isFn(opts.toAddress) ? opts.toAddress : (a) => a;
    const dem = resolveDemocracy(api);
    const state = { available: !!dem, count: null, lowestUnbaked: null, watched: [], refs: {}, props: null, deposits: {}, voting: null, account: opts.account || null };
    const stoppers = [];
    let stopped = false;
    if (!dem) return { state, stop() { stopped = true; } };

    // Keep an unsubscribe function, or call it at once if we already stopped
    // (or the slot it belonged to was replaced meanwhile).
    const hold = (p, slot, onFail) => Promise.resolve(p).then(u => {
        if (!isFn(u)) return;
        if (stopped || (slot && slot.dead)) u(); else if (slot) slot.unsub = u; else stoppers.push(u);
    }).catch(onFail || onError);
    const subscribe = (fn, slot, onFail) => { try { hold(fn(), slot, onFail); } catch (e) { (onFail || onError)(e); } };
    const replaceable = () => {
        let cur = null;
        const drop = () => { if (cur) { cur.dead = true; if (cur.unsub) { try { cur.unsub(); } catch (e) { onError(e); } } cur = null; } };
        stoppers.push(drop);
        return { drop, next: () => { drop(); cur = { unsub: null, dead: false }; return cur; } };
    };

    // Referenda.
    const info = replaceable();
    // Without lowestUnbaked (missing, or its subscription failed) the watched
    // set is REST's open referenda plus every index REST has not seen.
    let hasLowest = isFn(dem.lowestUnbaked);
    const asIndex = (x) => (typeof x === 'number' ? x : (typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : -1));
    const known = () => { try { return Array.from(knownOpen() || []).map(asIndex).filter(isIndex); } catch (_) { return []; } };
    const resync = () => {
        if (stopped || state.count === null || (hasLowest && state.lowestUnbaked === null)) return;
        const held = Object.values(state.refs).filter(r => r.status === 'Ongoing').map(r => r.refIndex);
        const watched = watchedReferenda({ count: state.count, lowestUnbaked: hasLowest ? state.lowestUnbaked : null, known: known(), held, restCount: restCount() });
        if (sameList(watched, state.watched)) return;
        state.watched = watched;
        if (!watched.length) { info.drop(); onUpdate('refs', state); return; }
        const slot = info.next();
        const knownSet = new Set(known());
        subscribe(() => dem.referendumInfoOf.multi(watched, (list) => {
            if (stopped || slot.dead) return;
            Array.from(list || []).forEach((opt, k) => {
                const i = watched[k];
                const prev = state.refs[i];
                const rec = decodeReferendum(i, opt, prev);
                if (rec) state.refs[i] = rec;
                else if (prev ? prev.status === 'Ongoing' : knownSet.has(i)) {
                    // Gone from storage while open: cancelled or removed.
                    state.refs[i] = { ...(prev || { refIndex: i, tallyKnown: 0 }), status: 'NotPassed', cancelled: true };
                }
            });
            onUpdate('refs', state);
            resync();
        }), slot);
    };
    subscribe(() => dem.referendumCount((c) => {
        if (stopped) return;
        const n = num(c);
        if (n === state.count) return;
        state.count = n;
        onUpdate('count', state);
        resync();
    }));
    if (hasLowest) subscribe(() => dem.lowestUnbaked((c) => {
        if (stopped) return;
        state.lowestUnbaked = num(c);
        resync();
    }), null, (e) => { onError(e); hasLowest = false; resync(); });

    // Public proposals and their seconds.
    if (isFn(dem.publicProps)) {
        const deposits = replaceable();
        subscribe(() => dem.publicProps((list) => {
            if (stopped) return;
            const props = [];
            for (const e of Array.from(list || [])) {
                const index = num(e[0]);
                if (!isIndex(index)) continue;
                const who = e[e.length - 1];
                props.push({ index, proposer: who ? toAddress(String(who)) : null, proposal: e.length > 2 ? clip(e[1]) : null });
            }
            const before = state.props ? state.props.map(p => p.index) : null;
            const indexes = props.map(p => p.index);
            state.props = props;
            for (const k of Object.keys(state.deposits)) if (!indexes.includes(Number(k))) delete state.deposits[k];
            onUpdate('props', state);
            if (sameList(before, indexes)) return;
            if (!indexes.length || !dem.depositOf || !isFn(dem.depositOf.multi)) { deposits.drop(); return; }
            const slot = deposits.next();
            subscribe(() => dem.depositOf.multi(indexes, (list) => {
                if (stopped || slot.dead) return;
                Array.from(list || []).forEach((o, k) => { const d = decodeDeposit(o); if (d) state.deposits[indexes[k]] = d; });
                onUpdate('deposits', state);
            }), slot);
        }));
    }

    // The connected account's own votes.
    if (state.account && isFn(dem.votingOf)) {
        subscribe(() => dem.votingOf(state.account, (v) => {
            if (stopped) return;
            state.voting = decodeVoting(v);
            onUpdate('voting', state);
        }));
    }

    return {
        state,
        stop() {
            if (stopped) return;
            stopped = true;
            for (const u of stoppers.splice(0)) { try { u(); } catch (e) { onError(e); } }
        }
    };
}
