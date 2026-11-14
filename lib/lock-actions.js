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
//     PriorLock::accumulate keeps the max block AND the max amount, so a
//     remove whose merge would hold more PDEX for longer than either lock
//     alone is kept out of the batch (lib/democracy-lock-projection.js);
//   - democracy.unlock(target) clears an expired prior (rejig) and sets the
//     lock to max(recorded votes, prior);
//   - democracy.undelegate: accumulates (now + periods x VoteLockingPeriod,
//     delegated balance) into the prior;
//   - elections.removeVoter: releases the "phrelect" lock and the deposit;
//   - pallet-balances: frozen is the largest lock or freeze and a hold counts
//     toward it, so a lower vote lock adds only the reducible balance change.

import { lockIdText, toBig, balanceBreakdown } from './balance-locks.js';
import { projectDemocracyLocks } from './democracy-lock-projection.js';

const max = (a, b) => (a > b ? a : b);
const min = (a, b) => (a < b ? a : b);
const sat = (a, b) => (a > b ? a - b : 0n);
const largest = (xs) => (xs || []).reduce((a, x) => max(a, toBig(x.amount)), 0n);
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
    const proj = projectDemocracyLocks(dem, { now: block, period: Number(dem.lockingPeriod) || 0 });
    const eta = (b) => etaOf(b, at);
    if (proj.mode === 'delegating') {
        const u = proj.undelegate;
        return { mode: 'delegating', remove: [], cancel: [], unlock: false, rejigFirst: false,
            lockNow: (at.lockAmount != null ? toBig(at.lockAmount) : proj.current.amount).toString(),
            undelegate: { target: dem.target, conviction: dem.conviction, lockUntil: u.until, lockUntilEta: eta(u.until),
                lockAmount: u.amount.toString(), freeAtOnce: u.until <= block, byPrior: u.byPrior, rejigFirst: u.rejigFirst,
                betterAfter: u.betterAfter, betterAfterEta: u.betterAfter ? eta(u.betterAfter) : null } };
    }
    const remove = [], cancel = [], waitFor = [];
    for (const v of proj.votes) {
        if (v.state === 'ongoing') { cancel.push({ index: v.index, end: v.end, eta: eta(v.end) }); waitFor.push(v.index); }
        else if (v.state === 'unknown') waitFor.push(v.index);   // no referendum info read: offer nothing for it
        else if (v.safe) remove.push({ index: v.index, state: v.state, lockUntil: v.lockUntil });
    }
    // The lock as the pallet last set it: every recorded vote and the prior.
    const lockNow = at.lockAmount != null && toBig(at.lockAmount) > 0n ? toBig(at.lockAmount) : proj.current.amount;
    const b = proj.batch;
    const lockAfter = b.lock;
    const lockedUntil = b.prior.until > block ? b.prior.until : null;
    const prior = proj.current.prior.until > block && proj.current.prior.amount > 0n
        ? { amount: proj.current.prior.amount.toString(), until: proj.current.prior.until, eta: eta(proj.current.prior.until) } : null;
    return {
        mode: 'direct', remove, cancel, waitFor, rejigFirst: b.rejigFirst,
        unlock: lockAfter < lockNow,
        lockNow: lockNow.toString(), lockAfter: lockAfter.toString(),
        freed: (lockNow > lockAfter ? lockNow - lockAfter : 0n).toString(),
        // Only the prior stays under conviction; a running vote is the cancel line's.
        lockedUntil, lockedUntilAmount: lockedUntil ? b.prior.amount.toString() : '0', lockedUntilEta: lockedUntil ? eta(lockedUntil) : null,
        // The batch merges a vote into the prior (the lock after it is not the one now).
        merges: remove.some(r => r.lockUntil != null),
        // The prior as it stands, and the votes kept out of the batch (removing
        // them now would hold the larger amount until the later date).
        prior,
        held: proj.held.map(h => ({ index: h.index, amount: h.amount.toString(), until: h.until, eta: eta(h.until), wait: h.wait,
            waitUntil: h.waitUntil, waitEta: eta(h.waitUntil), frees: h.frees.toString(),
            mergedAmount: h.mergedAmount.toString(), mergedUntil: h.mergedUntil, mergedEta: eta(h.mergedUntil) }))
    };
}

// What lowering lock `id` to `to` adds to Transferable (balanceBreakdown with
// frozen before and after), and the part of the cleared lock that stays staked.
// heldBy: the largest other lock or freeze (not staking) that keeps part of
// the cleared amount locked, so staking is not blamed for it.
export function unlockGain(snap, id, to) {
    const own = (l) => lockIdText(l.id) === id;
    const before = toBig(snap.frozen);
    const target = toBig(to);
    const after = min(before, max(target, largest([...(snap.locks || []).filter(l => !own(l)), ...(snap.freezes || [])])));
    const transferable = (frozen) => balanceBreakdown({ ...snap, frozen }).transferable;
    const gain = sat(transferable(after), transferable(before));
    const ownAmount = largest((snap.locks || []).filter(own));
    const cleared = sat(ownAmount, target);
    const stuck = sat(cleared, gain);
    const others = [...(snap.locks || []).filter(l => !own(l) && lockIdText(l.id) !== 'staking '), ...(snap.freezes || [])]
        .reduce((a, l) => (toBig(l.amount) > toBig(a && a.amount) ? l : a), null);
    const byOther = others ? min(stuck, sat(min(toBig(others.amount), ownAmount), target)) : 0n;
    const stake = snap.staking && snap.staking.bonded ? toBig(snap.staking.total) : 0n;
    return { spendable: gain.toString(), staysStaked: min(sat(stuck, byOther), stake).toString(),
        heldBy: byOther > 0n ? { id: lockIdText(others.id), amount: toBig(others.amount).toString() } : null };
}

export function lockActions(snap = {}) {
    const locks = snap.locks || [];
    const lockOf = (id) => largest(locks.filter(l => lockIdText(l.id) === id));
    const st = snap.staking || {};
    let withdraw = null;
    if (st.bonded && Array.isArray(st.chunks) && st.chunks.length) {
        const sched = unbondingSchedule({ chunks: st.chunks, currentEra: st.currentEra, activeEra: st.activeEra, activeEraStart: st.activeEraStart, eraMs: snap.eraMs, now: snap.now });
        const signer = st.controller || snap.address || null;
        withdraw = { ...sched, spans: Number(st.spans) || 0, controller: st.controller || null, stash: st.stash || snap.address || null, signer,
            controllerDiffers: !!(st.controller && snap.address && String(st.controller) !== String(snap.address)) };
    }
    const demLock = lockOf('democrac');
    const at = { block: snap.block, blockMs: snap.blockMs, now: snap.now, lockAmount: demLock > 0n ? demLock.toString() : null };
    const dem = snap.democracy && (demLock > 0n || (snap.democracy.votes || []).length || snap.democracy.delegating)
        ? democracyActions(snap.democracy, at)
        : null;
    // A cancelled vote: what the next unlock frees, from the same plan without that vote.
    const afterCancel = (c) => unlockGain(snap, 'democrac', democracyActions({ ...snap.democracy, votes: (snap.democracy.votes || []).filter(v => v.index !== c.index) }, at).lockAfter);
    const democracy = dem && dem.mode === 'direct'
        ? { ...dem, ...unlockGain(snap, 'democrac', dem.lockAfter), cancel: dem.cancel.map(c => ({ ...c, ...afterCancel(c) })) }
        : dem;
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
        const label = !d.remove.length ? 'Unlock' : d.unlock ? 'Remove votes and unlock' : 'Remove finished votes';
        return { key: 'democracy.unlock', label, params: { n: d.remove.length, unlock: !!d.unlock, freed: d.unlock ? d.freed : null,
            spendable: d.unlock ? d.spendable : null, staked: d.unlock ? d.staysStaked : null },
            buildTx: (api) => {
                const calls = [];
                const unlock = () => call(api, 'democracy', 'unlock')(address);
                // Always, even with no final unlock: removeVote's
                // PriorLock::accumulate would carry the expired larger prior
                // forward to the new block.
                if (d.rejigFirst) calls.push(unlock());
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
        return { key: 'democracy.removeVote', label: `Cancel vote on referendum #${c.index}`, params: { ref: c.index, spendable: c.spendable, staked: c.staysStaked },
            buildTx: (api) => call(api, 'democracy', 'removeVote')(c.index) };
    }
    if (kind === 'democracy-undelegate') {
        const d = a.democracy;
        if (!d || d.mode !== 'delegating') return { error: 'This account is not delegating its votes.' };
        if (!own) return { error: needOwn };
        return { key: 'democracy.undelegate', label: 'Undelegate', params: { target: d.undelegate && d.undelegate.target },
            // An ended prior larger than the delegation: unlock first, or
            // undelegate's accumulate carries it to the new date.
            buildTx: (api) => (d.undelegate && d.undelegate.rejigFirst
                ? batchAll(api, [call(api, 'democracy', 'unlock')(address), call(api, 'democracy', 'undelegate')()])
                : call(api, 'democracy', 'undelegate')()) };
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
