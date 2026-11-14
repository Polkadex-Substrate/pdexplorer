// What each democracy action would leave locked, before the user signs it.
// Pure: takes the VotingOf snapshot lib/balance-locks-chain.js reads (direct
// votes with their referendum status, the prior lock, or a delegation) and
// the current block; lib/lock-actions.js turns the result into the panel's
// actions and the batch the button signs. Tested in
// test/democracy-overlock.test.js.
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
//     max(every recorded vote's balance, the prior amount);
//   - undelegate accumulates (now + periods x VoteLockingPeriod, balance).
// A remove is offered only when the merge is covered by one of the locks it
// joins in both amount and date (one dominates the other); otherwise the
// vote waits, with the block from which removing it is harmless.

export const LOCK_PERIODS = { None: 0, Locked1x: 1, Locked2x: 2, Locked3x: 4, Locked4x: 8, Locked5x: 16, Locked6x: 32 };
const ZERO = Object.freeze({ until: 0, amount: 0n });
const big = (x) => { try { return BigInt(String(x == null ? '0' : x).replace(/,/g, '')); } catch (_) { return 0n; } };
const max = (a, b) => (a > b ? a : b);
const sat = (a, b) => (a > b ? a - b : 0n);

export function accumulate(p, until, amount) {
    return { until: Math.max(Number(p.until) || 0, Number(until) || 0), amount: max(big(p.amount), big(amount)) };
}
const rejig = (p, now) => (p.until <= now ? ZERO : p);
// a covers b: at least as much PDEX, at least as long.
const covers = (a, b) => a.until >= b.until && a.amount >= b.amount;
const priorOf = (dem) => ({ until: Number(dem.prior && dem.prior.until) || 0, amount: big(dem.prior && dem.prior.amount) });

function delegating(dem, now, period) {
    const prior = priorOf(dem);
    const balance = big(dem.balance);
    const own = { until: now + (LOCK_PERIODS[dem.conviction] || 0) * period, amount: balance };
    // An ended prior with a larger amount would be carried to the new date
    // (with no conviction, to the inclusion block); an unlock first clears it
    // (rejig works while delegating too).
    const rejigFirst = prior.amount > balance && prior.until <= now;
    const base = rejigFirst ? ZERO : prior;
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

export function projectDemocracyLocks(dem, { now = 0, period = null } = {}) {
    if (!dem) return null;
    now = Number(now) || 0;
    const per = Number(period != null ? period : dem.lockingPeriod) || 0;
    if (dem.delegating) return delegating(dem, now, per);
    const prior = priorOf(dem);
    const refs = dem.referenda || {};
    const votes = (dem.votes || []).map((v) => {
        const info = refs[v.index] || null;
        const amount = big(v.balance);
        const state = info && info.ongoing ? 'ongoing' : info && info.finished ? 'finished' : info && info.cancelled ? 'cancelled' : 'unknown';
        let lockUntil = null;
        if (state === 'finished' && typeof v.aye === 'boolean' && v.aye === !!info.approved) {
            const at = Number(info.end) + (LOCK_PERIODS[v.conviction] || 0) * per;
            if (at > now) lockUntil = at;
        }
        return { index: v.index, state, amount, end: info && info.end != null ? Number(info.end) : null, lockUntil,
            accumulates: lockUntil != null, removable: state === 'finished' || state === 'cancelled' };
    });
    const acc = votes.filter(v => v.accumulates).map(v => ({ v, lock: { until: v.lockUntil, amount: v.amount } }));
    // An ended prior is cleared by a leading unlock before anything accumulates into it.
    const base = prior.until > now ? prior : ZERO;
    for (const x of votes) x.ifRemoved = x.accumulates ? accumulate(base, x.lockUntil, x.amount) : null;
    // The lock the batch keeps: the prior, or a vote covering it, whichever covers the most votes.
    let anchor = base, chosen = acc.filter(x => covers(base, x.lock));
    for (const c of acc) {
        if (!covers(c.lock, base)) continue;
        const set = acc.filter(x => covers(c.lock, x.lock));
        if (set.length > chosen.length) { anchor = c.lock; chosen = set; }
    }
    const safe = new Set(chosen.map(x => x.v.index));
    for (const x of votes) x.safe = x.removable && (!x.accumulates || safe.has(x.index));
    const remove = votes.filter(x => x.safe).map(x => x.index);
    const rejigFirst = chosen.length > 0 && prior.amount > 0n && prior.until <= now;
    let after = rejigFirst ? ZERO : prior;
    for (const x of chosen) after = accumulate(after, x.lock.until, x.lock.amount);
    after = rejig(after, now);
    const left = votes.filter(x => !x.safe);
    const leftMax = left.reduce((a, x) => max(a, x.amount), 0n);
    const current = votes.reduce((a, x) => max(a, x.amount), prior.amount);
    const lock = max(leftMax, after.amount);
    // Votes kept back: wait for whichever lock ends first.
    // Where the kept lock ends first, the votes still not safe then (two that
    // do not nest) wait for the next lock: the same projection from that block.
    const later = left.some(x => x.accumulates && anchor.until <= x.lockUntil)
        ? projectDemocracyLocks({ ...dem, prior: { until: after.until, amount: after.amount }, votes: (dem.votes || []).filter(v => left.some(x => x.index === v.index)) }, { now: anchor.until, period: per })
        : null;
    const held = left.filter(x => x.accumulates).map((x) => {
        const merged = accumulate(anchor, x.lockUntil, x.amount);
        if (anchor.until <= x.lockUntil) {
            const next = later.held.find(h => h.index === x.index);
            if (next) return { ...next, frees: 0n, mergedUntil: merged.until, mergedAmount: merged.amount };
            // The kept prior ends first: Unlock then clears it down to the recorded votes.
            return { index: x.index, amount: x.amount, until: x.lockUntil, wait: 'prior', waitUntil: anchor.until,
                frees: sat(lock, leftMax), mergedUntil: merged.until, mergedAmount: merged.amount };
        }
        return { index: x.index, amount: x.amount, until: x.lockUntil, wait: 'vote', waitUntil: x.lockUntil,
            frees: 0n, mergedUntil: merged.until, mergedAmount: merged.amount };
    });
    return {
        mode: 'direct', current: { amount: current, prior }, votes,
        batch: { rejigFirst, remove, unlock: lock < current, prior: after, lock, frees: sat(current, lock) },
        held
    };
}
