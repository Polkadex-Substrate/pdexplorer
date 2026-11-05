// The one-click releases offered in the balance breakdown: withdraw unbonded
// PDEX, remove finished democracy votes and unlock, undelegate, remove a
// council vote, and remove a leftover staking lock. Pure: lockActions reads
// the snapshot lib/balance-locks-chain.js builds, lockActionSpec says what a
// button signs and who may sign it. lib/balance-locks-view.js renders the
// buttons and runs them through script.js's submitSignedTx (wallet lookup,
// fee preflight, lib/tx-submit.js watchdog). Tested in
// test/lock-actions.test.js.
//
// Only what succeeds now is offered; everything else gets the block or date
// it becomes possible. The pallet rules this follows (spec 392:
// pallet-staking 45.1.0, pallet-democracy, pallet-elections-phragmen):
//   - staking.withdrawUnbonded(num_slashing_spans), signed by the controller,
//     frees chunks with era <= CurrentEra; num_slashing_spans is
//     SlashingSpans(stash).prior.length + 1, or 0 with no record;
//   - staking.migrateCurrency(stash): any signed account; for a stash with
//     no ledger it removes the "staking " lock and refunds the fee. No event
//     then, so success is the lock being gone from balances.locks;
//   - democracy.removeVote(index): finished, ongoing or cancelled referenda;
//     a winning vote with conviction becomes a prior lock until
//     end + periods x VoteLockingPeriod (if that is still ahead), and
//     PriorLock::accumulate keeps the max block AND the max amount;
//   - democracy.unlock(target) clears an expired prior (rejig) and sets the
//     lock to max(recorded votes, prior);
//   - democracy.undelegate: prior lock until now + periods x VoteLockingPeriod;
//   - elections.removeVoter: releases the "phrelect" lock and the deposit.

import { lockIdText, toBig } from './balance-locks.js';

const LOCK_PERIODS = { None: 0, Locked1x: 1, Locked2x: 2, Locked3x: 4, Locked4x: 8, Locked5x: 16, Locked6x: 32 };
const max = (a, b) => (a > b ? a : b);
const n = (x) => { if (x == null || x === '') return null; const v = Number(x); return Number.isFinite(v) ? v : null; };
const short = (a) => { const s = String(a || ''); return s.length > 16 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s; };

export function slashingSpanCount(spans) {
    let s = spans;
    if (s && typeof s.isSome === 'boolean') s = s.isSome ? s.unwrap() : null;
    if (!s || s.prior == null) return 0;
    const len = typeof s.prior.length === 'number' ? s.prior.length : Array.from(s.prior).length;
    return len + 1;
}

// chunks: [{ value, era }]. A chunk is withdrawable once CurrentEra (else
// ActiveEra) reaches its era. The date is when ActiveEra reaches it:
// activeEraStart + (era - activeEra) x eraMs, or eras from now without a start.
export function unbondingSchedule({ chunks = [], currentEra = null, activeEra = null, activeEraStart = null, eraMs = 0, now = Date.now() } = {}) {
    const eraNow = n(currentEra) ?? n(activeEra);
    let withdrawable = 0n, readyCount = 0;
    const pending = [];
    for (const c of chunks) {
        const era = Number(c.era), value = toBig(c.value);
        if (eraNow != null && era <= eraNow) { withdrawable += value; readyCount++; continue; }
        const erasLeft = eraNow == null ? null : era - eraNow;
        let eta = null;
        if (Number(eraMs) > 0) {
            if (n(activeEra) != null && n(activeEraStart) != null) eta = Number(activeEraStart) + (era - Number(activeEra)) * Number(eraMs);
            else if (erasLeft != null) eta = Number(now) + erasLeft * Number(eraMs);
        }
        pending.push({ value: value.toString(), era, erasLeft, eta });
    }
    pending.sort((a, b) => a.era - b.era);
    return { withdrawable: withdrawable.toString(), readyCount, pending };
}

const etaOf = (block, at) => (at && n(at.blockMs) && n(at.block) != null ? Number(at.now) + (Number(block) - Number(at.block)) * Number(at.blockMs) : null);

export function democracyActions(dem, at = {}) {
    if (!dem) return null;
    const block = Number(at.block) || 0;
    const period = Number(dem.lockingPeriod) || 0;
    const prior = { until: Number(dem.prior && dem.prior.until) || 0, amount: toBig(dem.prior && dem.prior.amount) };
    if (dem.delegating) {
        const periods = LOCK_PERIODS[dem.conviction] || 0;
        const lockUntil = block + periods * period;
        return { mode: 'delegating', remove: [], cancel: [], unlock: false, rejigFirst: false,
            lockNow: (at.lockAmount != null ? toBig(at.lockAmount) : max(toBig(dem.balance), prior.amount)).toString(),
            undelegate: { target: dem.target, conviction: dem.conviction, lockUntil, lockUntilEta: etaOf(lockUntil, at) } };
    }
    const refs = dem.referenda || {};
    const remove = [], cancel = [], waitFor = [];
    let ongoingMax = 0n, votesMax = 0n;
    const added = [];
    for (const v of dem.votes || []) {
        const bal = toBig(v.balance);
        votesMax = max(votesMax, bal);
        const info = refs[v.index] || null;
        if (info && info.ongoing) {
            cancel.push({ index: v.index, end: info.end, eta: etaOf(info.end, at) });
            waitFor.push(v.index);
            ongoingMax = max(ongoingMax, bal);
        } else if (info && info.finished) {
            const won = typeof v.aye === 'boolean' && v.aye === !!info.approved;
            const until = won ? Number(info.end) + (LOCK_PERIODS[v.conviction] || 0) * period : 0;
            const lockUntil = until > block ? until : null;
            if (lockUntil) added.push({ until, amount: bal });
            remove.push({ index: v.index, state: 'finished', lockUntil });
        } else if (info && info.cancelled) {
            remove.push({ index: v.index, state: 'cancelled', lockUntil: null });
        } else {
            // No referendum info read: treat as still counting, offer nothing for it.
            waitFor.push(v.index);
            ongoingMax = max(ongoingMax, bal);
        }
    }
    // The lock as the pallet last set it: every recorded vote and the prior.
    const lockNow = at.lockAmount != null && toBig(at.lockAmount) > 0n ? toBig(at.lockAmount) : max(votesMax, prior.amount);
    // An expired prior with a larger amount would be carried along by
    // accumulate; an unlock before the removes clears it first.
    const rejigFirst = remove.length > 0 && added.length > 0 && prior.until > 0 && prior.until <= block;
    let p = rejigFirst ? { until: 0, amount: 0n } : { ...prior };
    for (const a of added) p = { until: Math.max(p.until, a.until), amount: max(p.amount, a.amount) };
    if (p.until <= block) p = { until: 0, amount: 0n };
    const lockAfter = max(ongoingMax, p.amount);
    const lockedUntil = p.until > block ? p.until : null;
    return {
        mode: 'direct', remove, cancel, waitFor, rejigFirst,
        unlock: lockAfter < lockNow,
        lockNow: lockNow.toString(), lockAfter: lockAfter.toString(),
        freed: (lockNow > lockAfter ? lockNow - lockAfter : 0n).toString(),
        lockedUntil, lockedUntilEta: lockedUntil ? etaOf(lockedUntil, at) : null
    };
}

export function lockActions(snap = {}) {
    const locks = snap.locks || [];
    const lockOf = (id) => locks.filter(l => lockIdText(l.id) === id).reduce((a, l) => max(a, toBig(l.amount)), 0n);
    const st = snap.staking || {};
    let withdraw = null;
    if (st.bonded && Array.isArray(st.chunks) && st.chunks.length) {
        const sched = unbondingSchedule({ chunks: st.chunks, currentEra: st.currentEra, activeEra: st.activeEra, activeEraStart: st.activeEraStart, eraMs: snap.eraMs, now: snap.now });
        const signer = st.controller || snap.address || null;
        withdraw = { ...sched, spans: Number(st.spans) || 0, controller: st.controller || null, stash: st.stash || snap.address || null, signer,
            controllerDiffers: !!(st.controller && snap.address && String(st.controller) !== String(snap.address)) };
    }
    const demLock = lockOf('democrac');
    const democracy = snap.democracy && (demLock > 0n || (snap.democracy.votes || []).length || snap.democracy.delegating)
        ? democracyActions(snap.democracy, { block: snap.block, blockMs: snap.blockMs, now: snap.now, lockAmount: demLock > 0n ? demLock.toString() : null })
        : null;
    const v = snap.elections && snap.elections.voter;
    const elections = v ? { votes: Number(v.votes) || 0, stake: toBig(v.stake).toString(), deposit: toBig(v.deposit).toString() } : null;
    const stakingLock = lockOf('staking ');
    const orphan = stakingLock > 0n && !st.bonded && snap.address ? { stash: snap.address, amount: stakingLock.toString() } : null;
    return { withdraw, democracy, elections, orphan };
}

// After migrateCurrency: the "staking " lock is no longer in balances.locks.
export function lockRemoved(locks) {
    return !Array.from(locks || []).some(l => lockIdText(l && l.id) === 'staking ');
}

function batchAll(api, calls) {
    if (calls.length === 1) return calls[0];
    if (!(api.tx.utility && typeof api.tx.utility.batchAll === 'function')) throw new Error('This runtime has no utility.batchAll; do the steps one at a time from your wallet app.');
    return api.tx.utility.batchAll(calls);
}
const call = (api, section, method) => {
    const f = api.tx[section] && api.tx[section][method];
    if (typeof f !== 'function') throw new Error(`This runtime has no ${section}.${method}.`);
    return f;
};
const ELECTIONS = ['elections', 'phragmenElection', 'electionsPhragmen'];

// What a button signs. { error } when it cannot be offered to this wallet;
// else { key, label, params, buildTx(api), verify?(api), check?(api) }.
export function lockActionSpec(kind, model, address, { connected = null, isSame = (a, b) => String(a) === String(b), ref = null } = {}) {
    const a = (model && model.actions) || {};
    const own = connected && isSame(connected, address);
    const needOwn = 'Connect this account\'s wallet to do this.';
    if (kind === 'withdraw') {
        const w = a.withdraw;
        if (!w || toBig(w.withdrawable) <= 0n) return { error: 'Nothing has finished unbonding yet.' };
        if (!connected || !isSame(connected, w.signer)) {
            return { error: w.controllerDiffers
                ? `This stash's controller is a different account (${short(w.signer)}). Connect the controller account to withdraw; the runtime only accepts withdrawUnbonded from it.`
                : 'Connect this account\'s wallet to withdraw.' };
        }
        return { key: 'staking.withdraw', label: 'Withdraw unbonded', params: {},
            buildTx: (api) => call(api, 'staking', 'withdrawUnbonded')(w.spans) };
    }
    if (kind === 'democracy-unlock') {
        const d = a.democracy;
        if (!d || d.mode !== 'direct' || (!d.remove.length && !d.unlock)) return { error: 'Nothing to remove or unlock right now.' };
        if (!own) return { error: needOwn };
        return { key: 'democracy.unlock', label: 'Remove votes and unlock', params: { n: d.remove.length, freed: d.unlock ? d.freed : null },
            buildTx: (api) => {
                const calls = [];
                const unlock = () => call(api, 'democracy', 'unlock')(address);
                if (d.rejigFirst && d.unlock) calls.push(unlock());
                for (const r of d.remove) calls.push(call(api, 'democracy', 'removeVote')(r.index));
                if (d.unlock) calls.push(unlock());
                return batchAll(api, calls);
            } };
    }
    if (kind === 'democracy-cancel') {
        const d = a.democracy;
        const c = d && (d.cancel || []).find(x => Number(x.index) === Number(ref));
        if (!c) return { error: 'That vote is not one that can be cancelled here.' };
        if (!own) return { error: needOwn };
        return { key: 'democracy.removeVote', label: `Cancel vote on referendum #${c.index}`, params: { ref: c.index },
            buildTx: (api) => call(api, 'democracy', 'removeVote')(c.index) };
    }
    if (kind === 'democracy-undelegate') {
        const d = a.democracy;
        if (!d || d.mode !== 'delegating') return { error: 'This account is not delegating its votes.' };
        if (!own) return { error: needOwn };
        return { key: 'democracy.undelegate', label: 'Undelegate', params: { target: d.undelegate && d.undelegate.target },
            buildTx: (api) => call(api, 'democracy', 'undelegate')() };
    }
    if (kind === 'elections-remove') {
        if (!a.elections) return { error: 'This account has no council vote.' };
        if (!own) return { error: needOwn };
        return { key: 'elections.removeVoter', label: 'Remove council vote', params: {},
            buildTx: (api) => {
                const sec = ELECTIONS.find(s => api.tx[s] && typeof api.tx[s].removeVoter === 'function');
                if (!sec) throw new Error('This runtime has no elections.removeVoter.');
                return api.tx[sec].removeVoter();
            } };
    }
    if (kind === 'migrate-currency') {
        const o = a.orphan;
        if (!o) return { error: 'This account has no leftover staking lock.' };
        if (!connected) return { error: 'Connect a wallet first. Any account can submit this, not only the one with the lock.' };
        const read = async (api) => lockRemoved(await api.query.balances.locks(o.stash));
        return { key: 'staking.migrateCurrency', label: 'Remove leftover staking lock', params: { stash: o.stash },
            buildTx: (api) => call(api, 'staking', 'migrateCurrency')(o.stash),
            verify: async (api) => ((await read(api)) ? 'applied' : null),
            check: async (api) => ((await read(api))
                ? { ok: true, text: 'The leftover staking lock is gone. The PDEX it held is transferable again.' }
                : { ok: false, text: 'The transaction was included, but the staking lock is still there. Refresh in a minute; if it stays, contact the Polkadex team.' }) };
    }
    return { error: 'This action is not available here.' };
}
