// What each democracy action would leave locked, before the user signs it.
// Pure: takes the VotingOf snapshot lib/balance-locks-chain.js reads (direct
// votes with their referendum status, the prior lock, or a delegation) and
// the current block; lib/lock-actions.js turns the result into the panel's
// actions and the batch the button signs. Tested in
// test/democracy-overlock.test.js and test/stale-unlock-plan.test.js.
//
// pallet-democracy (polkadot-stable2512-3):
//   - PriorLock::accumulate(until, amount) keeps the LATER date and the
//     LARGER amount, so merging two locks can hold the larger amount until
//     the later date, longer than either would alone;
//   - removeVote on a finished referendum accumulates (end + periods x
//     VoteLockingPeriod, balance) for a Standard vote on the winning side
//     while that date is still ahead; losing side, None conviction, an
//     expired date, a cancelled or a running referendum add nothing;
//   - unlock: rejig clears the prior once now >= its date, then the lock is
//     max(every recorded vote's balance, the prior amount); it is the only
//     call that rejigs, so batches lead with it whenever a prior is on record;
//   - undelegate accumulates (now + periods x VoteLockingPeriod, balance).
// A remove is offered only when it cannot accumulate: the losing side, no
// conviction, a cancelled referendum, or a conviction lock already over.
// VoteLockingPeriod missing or unreadable counts as unbounded, never as 0:
// a conviction lock is then never taken to be over (issue #69).
// Block height only rises, so it cannot at inclusion either, however long the
// wallet or a multisig approval takes. A winning vote still under conviction
// waits for its own end; removing it earlier frees nothing.

export const LOCK_PERIODS = { None: 0, Locked1x: 1, Locked2x: 2, Locked3x: 4, Locked4x: 8, Locked5x: 16, Locked6x: 32 };
const ZERO = Object.freeze({ until: 0, amount: 0n });
const big = (x) => { try { return BigInt(String(x == null ? '0' : x).replace(/,/g, '')); } catch (_) { return 0n; } };
const max = (a, b) => (a > b ? a : b);
const sat = (a, b) => (a > b ? a - b : 0n);

export function accumulate(p, until, amount) {
    return { until: Math.max(Number(p.until) || 0, Number(until) || 0), amount: max(big(p.amount), big(amount)) };
}
const rejig = (p, now) => (p.until <= now ? ZERO : p);
// VoteLockingPeriod in blocks, or Infinity when missing, unreadable or not positive.
export function lockPeriodOf(period) {
    const n = Number(period == null ? NaN : String(period).replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : Infinity;
}
// The block a conviction lock of `periods` started at `from` ends (Infinity when the period is unknown).
const lockEnd = (from, periods, per) => (periods ? from + periods * per : from);
const priorOf = (dem) => ({ until: Number(dem.prior && dem.prior.until) || 0, amount: big(dem.prior && dem.prior.amount) });

function delegating(dem, now, period) {
    const prior = priorOf(dem);
    const balance = big(dem.balance);
    const own = { until: lockEnd(now, LOCK_PERIODS[dem.conviction] || 0, period), amount: balance };
    // try_undelegate accumulates without a rejig, so a prior that has ended
    // by INCLUSION (not by now, when the panel is drawn) would be carried to
    // the new date. Any prior on record gets a leading unlock (rejig works
    // while delegating too; with a running prior it changes nothing).
    const rejigFirst = prior.amount > 0n;
    const base = prior.until > now ? prior : ZERO;
    const after = accumulate(base, own.until, own.amount);
    const live = base.until > now ? base : ZERO;
    // The earlier lock sets the date or the amount; and neither lock covers the other.
    const byPrior = live.amount > 0n && (live.until > own.until || live.amount > own.amount);
    // Waiting for the earlier lock to end holds less only when it is the
    // larger one and ends first; a smaller, later one would push the
    // delegated amount out to its date plus the conviction period.
    const waitHelps = live.amount > own.amount && live.until < own.until;
    return {
        mode: 'delegating', current: { amount: max(balance, prior.amount), prior },
        undelegate: { rejigFirst, until: after.until, amount: after.amount, ownUntil: own.until, byPrior,
            // Undelegating once the earlier lock has ended keeps only the delegated balance.
            betterAfter: waitHelps ? live.until : null }
    };
}

// Cancel vote (issue #73): removeVote on a running referendum may be included
// only after it ends (the wallet, a multisig's other signers). Worst case: it
// ends at its scheduled end, the earliest it can, and the vote's side wins;
// try_remove_vote then accumulates the vote's own lock (end + periods x
// period, balance) into the prior: the larger amount until the later block.
// The batch leads with an unlock whenever a prior is on record, so a prior
// ending by `end` is cleared first. One running past `end` is safe only when
// one of the two locks is at least as large AND lasts at least as long; else
// the merge holds more PDEX for longer than either: a larger prior until the
// vote's later block ({ held: 'prior' }), or the vote's amount until the
// prior's later block ({ held: 'vote' }). With the period unknown the vote's
// block could be anywhere, so only equal amounts are safe. Returns
// { held, amount, until, stretchedTo, priorAmount } (until or stretchedTo
// Infinity when unknown), else null. Tested in test/cancel-vote-prior.test.js.
export function cancelStretchesPrior(v, end, prior, period) {
    const periods = LOCK_PERIODS[v && v.conviction] || 0;
    const p = priorOf({ prior });
    const e = Number(end);
    if (!periods || !(p.amount > 0n) || !(p.until > e)) return null;
    const per = lockPeriodOf(period);
    const own = { until: lockEnd(e, periods, per), amount: big(v.balance) };
    const covers = (a, b) => a.until >= b.until && a.amount >= b.amount;
    if (Number.isFinite(per) ? covers(p, own) || covers(own, p) : p.amount === own.amount) return null;
    return p.amount > own.amount
        ? { held: 'prior', amount: p.amount, until: p.until, stretchedTo: own.until, priorAmount: p.amount }
        : { held: 'vote', amount: own.amount, until: own.until, stretchedTo: p.until, priorAmount: p.amount };
}

export function projectDemocracyLocks(dem, { now = 0, period = null } = {}) {
    if (!dem) return null;
    now = Number(now) || 0;
    const per = lockPeriodOf(period != null ? period : dem.lockingPeriod);
    if (dem.delegating) return delegating(dem, now, per);
    const prior = priorOf(dem);
    const refs = dem.referenda || {};
    const votes = (dem.votes || []).map((v) => {
        const info = refs[v.index] || null;
        const amount = big(v.balance);
        const state = info && info.ongoing ? 'ongoing' : info && info.finished ? 'finished' : info && info.cancelled ? 'cancelled' : 'unknown';
        let lockUntil = null;
        if (state === 'finished' && typeof v.aye === 'boolean' && v.aye === !!info.approved) {
            const at = lockEnd(Number(info.end), LOCK_PERIODS[v.conviction] || 0, per);
            if (at > now) lockUntil = at;
        }
        const removable = state === 'finished' || state === 'cancelled';
        return { index: v.index, state, amount, end: info && info.end != null ? Number(info.end) : null, lockUntil,
            accumulates: lockUntil != null, removable, safe: removable && lockUntil == null };
    });
    const remove = votes.filter(x => x.safe).map(x => x.index);
    // try_remove_vote accumulates without a rejig: every batch with a remove
    // starts with an unlock whenever a prior is on record, whatever its date,
    // so a prior that ends between drawing and inclusion is cleared first.
    const rejigFirst = remove.length > 0 && prior.amount > 0n;
    // The removes add nothing to the prior: what stays is the prior while it
    // runs and every vote still recorded.
    const after = rejig(prior, now);
    const lock = votes.filter(x => !x.safe).reduce((a, x) => max(a, x.amount), after.amount);
    const current = votes.reduce((a, x) => max(a, x.amount), prior.amount);
    return {
        mode: 'direct', current: { amount: current, prior }, votes,
        batch: { rejigFirst, remove, unlock: lock < current, prior: after, lock, frees: sat(current, lock) },
        // Winning votes still under conviction, each with its own end.
        held: votes.filter(x => x.accumulates).map(x => ({ index: x.index, amount: x.amount, until: x.lockUntil }))
    };
}
