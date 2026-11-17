// Remove votes and unlock never sends a plan worked out before the account's
// votes or locks changed (issue #69). Two rules:
//   - lib/democracy-lock-projection.js: the batch removes only votes whose
//     removal cannot accumulate (the losing side, no conviction, a cancelled
//     referendum, or a conviction lock already over). Block height only rises,
//     so that still holds at inclusion, however long the wallet or a multisig
//     approval takes. A winning vote still under conviction waits for its end.
//   - lib/lock-actions.js: just before signing, the button reads votingOf,
//     each referendum in it and the block again, works the plan out again,
//     and refuses when the removals, the unlock or the lock it leaves differ.
//
// pallet-democracy: try_remove_vote accumulates (end + VoteLockingPeriod x
// lock_periods, balance) into the prior only for a finished referendum, a
// vote on the winning side, and while now is before that block;
// PriorLock::accumulate keeps the later block and the larger amount apart.
//
// Every amount, block and account here is made up (public repo).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lockActionSpec } from '../lib/lock-actions.js';
import { accumulate, projectDemocracyLocks } from '../lib/democracy-lock-projection.js';
import { describeAccountLocks } from '../lib/balance-locks.js';
import { renderBalanceLocks } from '../lib/balance-locks-view.js';
import { democracyChain } from './helpers/democracy-chain.js';

const PDEX = 10n ** 12n;
const s = (v) => v.toString();
const ME = 'esm9mgCefMrQ2EbGGyMNXGAFA3vnRGDid7GheURpcFRTjyokX';   // 0x11..11 at prefix 88
const OTHER = 'esmY9ZU5xPLb8urxWNBq89tPvEAG3CZm4KboeysfVgQuEw1io'; // 0x22..22 at prefix 88
const same = (a, b) => String(a) === String(b);
const NOW = Date.UTC(2026, 0, 1);
const PERIOD = 1000;   // VoteLockingPeriod on this made-up chain
const PERIODS = { None: 0, Locked1x: 1, Locked2x: 2, Locked3x: 4, Locked4x: 8, Locked5x: 16, Locked6x: 32 };
const NO_PRIOR = { until: 0, amount: '0' };
const STALE = (e) => e.message === 'Your votes or locks changed since this page loaded. Reload to see the safe options.';
// The account is as it was; only blocks went by, and a lock or a referendum ended.
const MOVED_ON = (e) => e.message === 'Time has moved on since this page loaded: a vote lock or a referendum has ended, so what can be removed or unlocked is different now. Reload to see the safe options.';
const PERIOD_UNREAD = (e) => e.message === 'The vote lock period could not be read from the chain just now, so these removals cannot be checked. Reload and try again.';

const vote = (index, aye, conviction, amount) => ({ index, aye, conviction, balance: s(amount) });
const direct = (votes, referenda, prior = NO_PRIOR) => ({ delegating: false, lockingPeriod: PERIOD, votes, referenda, prior });
// The account as the panel reads it at `block`, with the democracy lock the pallet last set.
const snap = (dem, block, lockAmount) => ({
    address: ME, now: NOW, free: s(1000n * PDEX), reserved: '0', frozen: s(lockAmount), ed: s(PDEX),
    block, blockMs: 6000, bondingDays: 28, eraMs: 86400000,
    locks: [{ id: 'democrac', amount: s(lockAmount), reasons: 'All' }], freezes: [], holds: [], reserves: [],
    staking: { bonded: false, total: '0', active: '0', unlocking: '0', chunks: [], currentEra: null, activeEra: null, activeEraStart: null, spans: 0, controller: null, stash: null },
    democracy: dem, elections: null, identity: null, proxy: null, pallets: { vesting: false, ormlVesting: false }
});
const chainAt = (dem, block) => democracyChain(dem, block, { period: PERIOD });
const tx = { democracy: { unlock: (who) => ['unlock', who], removeVote: (i) => ['removeVote', i] }, utility: { batchAll: (calls) => ({ batch: calls }) } };
const spec = (model) => lockActionSpec('democracy-unlock', model, ME, { connected: ME, isSame: same });
const sign = async (model, chain) => ((t) => t.batch || [t])(await spec(model).buildTx({ ...chain, tx }));
// The same, listing every call the wallet would be asked to sign as it is built.
const signWith = async (model, chain, built) => ((t) => t.batch || [t])(await spec(model).buildTx({ ...chain,
    tx: { ...tx, democracy: { unlock: (w) => { built.push('unlock'); return tx.democracy.unlock(w); }, removeVote: (i) => { built.push('removeVote'); return tx.democracy.removeVote(i); } } } }));
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// The pallet rule, written from try_remove_vote (not from the code under test).
const accumulatesAt = (v, info, at) => !!(info && info.finished && v.aye === info.approved && at < info.end + PERIOD * PERIODS[v.conviction]);

// Issue #69: at block 1,001 no prior, and a winning 10 PDEX Locked1x vote on
// #7 that ended at 1,000, so its own lock runs to 2,000. Here also a losing
// 40 PDEX vote on #3. After drawing, another operation creates a 500 PDEX
// prior until 1,100.
const DRAWN_AT = 1001;
const REFS = { 3: { finished: true, approved: true, end: 900 }, 7: { finished: true, approved: true, end: 1000 } };
const LOST3 = vote(3, false, 'Locked2x', 40n * PDEX);
const WON7 = vote(7, true, 'Locked1x', 10n * PDEX);
const TWO = direct([LOST3, WON7], REFS);
const PRIOR_500 = { until: 1100, amount: s(500n * PDEX) };
const drawn = describeAccountLocks(snap(TWO, DRAWN_AT, 40n * PDEX));

describe('a winning vote still under conviction is never in the batch', () => {
    test('issue #69: only #7 recorded: no button, and #7 is shown with its end', () => {
        const m = describeAccountLocks(snap(direct([WON7], REFS), DRAWN_AT, 10n * PDEX));
        assert.deepEqual(m.actions.democracy.remove, []);
        assert.match(spec(m).error, /^Nothing to remove or unlock right now\.$/);
        const h = renderBalanceLocks(m, { canSign: true });
        assert.doesNotMatch(h, /data-lock-action="democracy-unlock"/);
        assert.match(text(h), /Vote on referendum #7: 10 PDEX until block 2,000 \(about \d{4}-\d{2}-\d{2}\)\./);
        assert.match(text(h), /Remove the vote on referendum #7 after block 2,000 \(about \d{4}-\d{2}-\d{2}\), when its own lock ends\./);
    });
    test('with the losing vote too: the batch removes #3 and unlocks down to #7\'s 10 PDEX; #7 waits for block 2,000', () => {
        const d = drawn.actions.democracy;
        assert.deepEqual(d.remove.map(r => r.index), [3]);
        assert.deepEqual(d.held.map(h => [h.index, h.until]), [[7, 2000]]);
        assert.equal(d.lockAfter, s(10n * PDEX));
        assert.equal(d.unlock, true);
        // The row names what the batch leaves, #7's 10 PDEX, not the whole 40 PDEX lock.
        assert.match(drawn.items.find(i => i.id === 'democrac').unlock, /^10 PDEX stays locked until block 2000 \([^)]*\); the rest can be unlocked now: press Remove votes and unlock \(/);
    });
    test('an earlier lock over, #7 still running: Unlock alone, and the row says to press Unlock', () => {
        const m = describeAccountLocks(snap(direct([WON7], REFS, { until: 1200, amount: s(500n * PDEX) }), 1201, 500n * PDEX));
        assert.deepEqual(m.actions.democracy.remove, []);
        assert.equal(spec(m).label, 'Unlock');
        assert.match(m.items.find(i => i.id === 'democrac').unlock, /^10 PDEX stays locked until block 2000 \([^)]*\); the rest can be unlocked now: press Unlock \(democracy\.unlock for your address\)\.$/);
    });
    test('beside a running earlier lock, the row lists both and says when each vote can go', () => {
        const m = describeAccountLocks(snap(direct([WON7], REFS, PRIOR_500), DRAWN_AT, 500n * PDEX));
        assert.equal(m.items.find(i => i.id === 'democrac').unlock, 'Separate vote locks: 500 PDEX until block 1100 (under a day) from an earlier vote; '
            + '10 PDEX until block 2000 (under a day) for referendum #7. Remove each vote after its own lock ends; removing it earlier frees nothing.');
    });
    test('from block 2,000 its removal adds nothing, so it is offered', () => {
        const d = describeAccountLocks(snap(TWO, 2000, 40n * PDEX)).actions.democracy;
        assert.deepEqual(d.remove.map(r => r.index), [3, 7]);
        assert.deepEqual(d.held, []);
    });
});

describe('just before signing, the button reads the chain again', () => {
    test('issue #69 as reported: a panel that still offers removeVote(7), and a 500 PDEX prior created since: refused, nothing built', async () => {
        // The plan the panel drew for this account at block 1,001 before this
        // change, when a vote covering every other lock could be removed.
        const offered7 = { actions: { democracy: { mode: 'direct', remove: [{ index: 7, state: 'finished', lockUntil: 2000 }], cancel: [], unlock: false,
            rejigFirst: false, lockNow: s(10n * PDEX), lockAfter: s(10n * PDEX), freed: '0', lockedUntil: 2000, lockedUntilAmount: s(10n * PDEX) } } };
        const chain = chainAt(direct([WON7], REFS, PRIOR_500), DRAWN_AT);
        await assert.rejects(sign(offered7, chain), STALE);
        assert.deepEqual(chain.reads.map(r => r[0]).sort(), ['number', 'referendumInfoOf', 'votingOf']);
        // Built anyway, removeVote(7) would have kept 500 PDEX locked until block 2,000.
        assert.deepEqual(accumulate({ until: 1100, amount: 500n * PDEX }, 2000, 10n * PDEX), { until: 2000, amount: 500n * PDEX });
    });
    test('it reads votingOf for this account, each referendum in it, and the block', async () => {
        const chain = chainAt(TWO, DRAWN_AT);
        await sign(drawn, chain);
        assert.deepEqual(chain.reads.filter(r => r[0] !== 'number'), [['votingOf', ME], ['referendumInfoOf', 3], ['referendumInfoOf', 7]]);
        assert.ok(chain.reads.some(r => r[0] === 'number'));
    });
});

describe('an account change is told apart from the block moving on', () => {
    test('nothing changed, 50 blocks later: the calls the panel showed', async () => {
        assert.deepEqual(await sign(drawn, chainAt(TWO, DRAWN_AT + 50)), [['removeVote', 3], ['unlock', ME]]);
    });
    test('the same block, the account changed: refused', async () => {
        const changed = {
            'a 500 PDEX prior created by another removal': direct([LOST3, WON7], REFS, PRIOR_500),
            'the losing vote removed from another app': direct([WON7], REFS),
            'a new 30 PDEX vote on a running referendum': direct([LOST3, WON7, vote(9, true, 'None', 30n * PDEX)], { ...REFS, 9: { ongoing: true, end: 5000 } }),
            'the votes delegated': { delegating: true, target: OTHER, conviction: 'Locked1x', balance: s(40n * PDEX), lockingPeriod: PERIOD, prior: NO_PRIOR }
        };
        for (const [what, dem] of Object.entries(changed)) {
            await assert.rejects(sign(drawn, chainAt(dem, DRAWN_AT)), STALE, what);
        }
    });
    test('a running prior made longer or larger, the same removes and unlock: refused', async () => {
        // Drawn with a 20 PDEX prior until 1,100 and a running 35 PDEX vote: remove #3, unlock down to 35 PDEX.
        const withPrior = (prior) => direct([LOST3, WON7, vote(9, true, 'None', 35n * PDEX)], { ...REFS, 9: { ongoing: true, end: 5000 } }, prior);
        const PRIOR_20 = { until: 1100, amount: s(20n * PDEX) };
        const model = describeAccountLocks(snap(withPrior(PRIOR_20), DRAWN_AT, 40n * PDEX));
        assert.deepEqual(await sign(model, chainAt(withPrior(PRIOR_20), DRAWN_AT)), [['unlock', ME], ['removeVote', 3], ['unlock', ME]]);
        for (const prior of [{ until: 1500, amount: s(20n * PDEX) }, { until: 1100, amount: s(25n * PDEX) }]) {
            await assert.rejects(sign(model, chainAt(withPrior(prior), DRAWN_AT)), STALE, `prior until ${prior.until}, ${prior.amount}`);
        }
    });
    test('both, 50 blocks later with the 500 PDEX prior: refused', async () => {
        await assert.rejects(sign(drawn, chainAt(direct([LOST3, WON7], REFS, PRIOR_500), DRAWN_AT + 50)), STALE);
    });
    test('the block alone changes the plan only when a lock ends in between: past 2,000 #7 can go too, so it asks for a reload, saying time moved on', async () => {
        const built = [];
        await assert.rejects(signWith(drawn, chainAt(TWO, 2001), built), MOVED_ON);
        assert.deepEqual(built, []);
    });
    test('the account as drawn, a running referendum finished since: time moved on, not "your votes or locks changed"', async () => {
        // Drawn with #9 running; it ends at 1,010, the losing side, so #9 can be removed too.
        const running = direct([LOST3, WON7, vote(9, false, 'Locked1x', 35n * PDEX)], { ...REFS, 9: { ongoing: true, end: 1010 } });
        const model = describeAccountLocks(snap(running, DRAWN_AT, 40n * PDEX));
        const ended = direct(running.votes, { ...REFS, 9: { finished: true, approved: true, end: 1010 } });
        await assert.rejects(sign(model, chainAt(ended, 1011)), MOVED_ON);
    });
    test('the account changed AND blocks went by: still "your votes or locks changed"', async () => {
        await assert.rejects(sign(drawn, chainAt(direct([LOST3, WON7], REFS, PRIOR_500), 2001)), STALE);
        await assert.rejects(sign(drawn, chainAt(direct([WON7], REFS), 2001)), STALE);
    });
});

describe('delayed signing and multisig execution', () => {
    test('built at block 1,001 when the first signer approves, executed at 1,099 after the 500 PDEX prior appeared: no remove in it accumulates', async () => {
        const calls = await sign(drawn, chainAt(TWO, DRAWN_AT));
        assert.deepEqual(calls, [['removeVote', 3], ['unlock', ME]]);
        for (const at of [DRAWN_AT, 1099, 1100, 2000, 5000]) {
            for (const [op, i] of calls) if (op === 'removeVote') assert.equal(accumulatesAt(TWO.votes.find(v => v.index === i), REFS[i], at), false, `removeVote(${i}) at ${at}`);
        }
    });
    test('property: random accounts, built when drawn, included up to three periods later: no remove in the batch ever accumulates', async () => {
        let x = 69;
        const r = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
        const pick = (xs) => xs[Math.floor(r() * xs.length)];
        const now = 10_000;
        let built = 0, removes = 0;
        for (let k = 0; k < 400; k++) {
            const votes = [], referenda = {};
            for (let i = 1; i <= 1 + Math.floor(r() * 4); i++) {
                votes.push(vote(i, pick([true, false, null]), pick(Object.keys(PERIODS)), BigInt(1 + Math.floor(r() * 900)) * PDEX));
                const state = pick(['finished', 'finished', 'finished', 'ongoing', 'cancelled']);
                if (state === 'finished') referenda[i] = { finished: true, approved: r() < 0.6, end: now - Math.floor(r() * 3 * PERIOD) };
                if (state === 'ongoing') referenda[i] = { ongoing: true, end: now + 500 };
                if (state === 'cancelled') referenda[i] = { cancelled: true };
            }
            const prior = r() < 0.3 ? NO_PRIOR : { until: now + Math.floor((r() - 0.3) * 4 * PERIOD), amount: s(BigInt(1 + Math.floor(r() * 900)) * PDEX) };
            const dem = direct(votes, referenda, prior);
            const lockNow = votes.reduce((a, v) => (BigInt(v.balance) > a ? BigInt(v.balance) : a), BigInt(prior.amount));
            const model = describeAccountLocks(snap(dem, now, lockNow));
            if (spec(model).error) continue;
            const calls = await sign(model, chainAt(dem, now));
            built++;
            for (const at of [now, now + 1, now + pick([50, PERIOD, 2 * PERIOD, 3 * PERIOD])]) {
                for (const [op, i] of calls) {
                    if (op !== 'removeVote') continue;
                    removes++;
                    assert.equal(accumulatesAt(votes.find(v => v.index === i), referenda[i], at), false, `case ${k}: removeVote(${i}) accumulates at ${at}`);
                }
            }
        }
        assert.ok(built > 150 && removes > 300, `enough batches (${built}) and removes (${removes})`);
    });
});

describe('safe removals and Unlock alone keep working, read again first', () => {
    const cases = [
        ['the losing side', direct([LOST3], REFS), 40n, [['removeVote', 3], ['unlock', ME]]],
        ['no conviction on the winning side', direct([vote(2, true, 'None', 40n * PDEX)], { 2: { finished: true, approved: true, end: 1000 } }), 40n, [['removeVote', 2], ['unlock', ME]]],
        ['a conviction lock already over', direct([vote(1, true, 'Locked1x', 40n * PDEX)], { 1: { finished: true, approved: true, end: 1 } }), 40n, [['removeVote', 1], ['unlock', ME]]],
        ['a cancelled referendum', direct([vote(5, true, 'Locked6x', 40n * PDEX)], { 5: { cancelled: true } }), 40n, [['removeVote', 5], ['unlock', ME]]],
        ['Unlock alone, after the prior ended', direct([], {}, { until: 900, amount: s(40n * PDEX) }), 40n, [['unlock', ME]]],
        ['a running prior: unlock first, then the remove, then unlock', direct([vote(3, false, 'None', 600n * PDEX)], REFS, PRIOR_500), 600n, [['unlock', ME], ['removeVote', 3], ['unlock', ME]]]
    ];
    for (const [what, dem, lockAmount, calls] of cases) {
        test(`${what}: the same calls 10 blocks later`, async () => {
            const model = describeAccountLocks(snap(dem, DRAWN_AT, lockAmount * PDEX));
            assert.deepEqual(await sign(model, chainAt(dem, DRAWN_AT + 10)), calls);
        });
    }
});

// Issue #69 (Fable): VoteLockingPeriod missing or unreadable used to count as
// 0 blocks, so a winning vote under conviction looked over at its
// referendum's end and its removal was built. Unknown now counts as
// unbounded: such a vote is never in the batch, and nothing claims a date.
describe('VoteLockingPeriod cannot be read: a winning vote under conviction is never removed', () => {
    const SIX7 = vote(7, true, 'Locked6x', 10n * PDEX);
    for (const [what, lockingPeriod] of [['missing', undefined], ['read as 0', 0], ['not a number', 'n/a']]) {
        test(`${what}: the projection holds the 6x vote; nothing to remove, no button`, () => {
            const dem = { ...direct([SIX7], REFS), lockingPeriod };
            const p = projectDemocracyLocks(dem, { now: 5000 });
            assert.deepEqual(p.votes.map(v => [v.index, v.safe, v.accumulates]), [[7, false, true]]);
            assert.deepEqual(p.batch.remove, []);
            const m = describeAccountLocks(snap(dem, 5000, 10n * PDEX));
            assert.deepEqual(m.actions.democracy.remove, []);
            assert.match(spec(m).error, /^Nothing to remove or unlock right now\.$/);
        });
    }
    test('the losing vote beside it is still removed; the 6x vote waits', () => {
        const m = describeAccountLocks(snap({ ...direct([LOST3, SIX7], REFS), lockingPeriod: undefined }, 5000, 40n * PDEX));
        assert.deepEqual(m.actions.democracy.remove.map(r => r.index), [3]);
        assert.deepEqual(m.actions.democracy.held.map(h => [h.index, h.until]), [[7, null]]);
        assert.equal(m.actions.democracy.lockAfter, s(10n * PDEX));
    });
    test('the panel says the vote waits for its conviction lock, with no made-up block, and no "lock period is over"', () => {
        const m = describeAccountLocks(snap({ ...direct([SIX7], REFS, PRIOR_500), lockingPeriod: undefined }, DRAWN_AT, 500n * PDEX));
        const h = text(renderBalanceLocks(m, { canSign: true }));
        assert.match(h, /Vote on referendum #7: 10 PDEX until its conviction lock ends\./);
        assert.match(h, /Remove the vote on referendum #7 once its own conviction lock ends; the lock period could not be read, so reload to see the date\./);
        const row = m.items.find(i => i.id === 'democrac');
        assert.match(row.unlock, /10 PDEX until its conviction lock ends for referendum #7/);
        const alone = describeAccountLocks(snap({ ...direct([SIX7], REFS), lockingPeriod: undefined }, 5000, 10n * PDEX)).items.find(i => i.id === 'democrac');
        assert.doesNotMatch(alone.unlock, /lock period is over/);
        assert.match(alone.unlock, /^10 PDEX stays locked until its conviction lock ends \(the lock period could not be read; reload to see the date\)\./);
        assert.deepEqual(alone.refs.map(r => r.text), ['#7: ended; locked until its conviction lock ends']);
        for (const t of [h, row.unlock, alone.unlock, JSON.stringify(alone.refs)]) assert.doesNotMatch(t, /Infinity|NaN|\u221e|block null|block undefined/);
    });
    test('delegating at 6x: Undelegate is not said to free the PDEX at once, and no block is made up', () => {
        const dem = { delegating: true, target: OTHER, conviction: 'Locked6x', balance: s(40n * PDEX), lockingPeriod: undefined, prior: NO_PRIOR };
        const m = describeAccountLocks(snap(dem, 5000, 40n * PDEX));
        const u = m.actions.democracy.undelegate;
        assert.equal(u.freeAtOnce, false);
        assert.equal(u.lockUntil, null);
        const h = text(renderBalanceLocks(m, { canSign: true }));
        assert.match(h, /Undelegating keeps 40 PDEX locked until its conviction lock ends; then unlock it here\./);
        assert.doesNotMatch(h, /Infinity|NaN|\u221e|block null|Unlock frees/);
        // No conviction: nothing to wait for, period or not.
        const none = describeAccountLocks(snap({ ...dem, conviction: 'None' }, 5000, 40n * PDEX)).actions.democracy.undelegate;
        assert.equal(none.freeAtOnce, true);
        assert.equal(none.lockUntil, 5000);
    });
    test('drawn with the period read, signed when it cannot be: refused before anything is built', async () => {
        // At 2,001 #7's 1x lock (to 2,000) is over, so the panel offers its removal.
        const m = describeAccountLocks(snap(direct([WON7], REFS), 2001, 10n * PDEX));
        assert.deepEqual(m.actions.democracy.remove.map(r => r.index), [7]);
        for (const consts of [{}, { democracy: {} }, { democracy: { voteLockingPeriod: 0 } }]) {
            const built = [];
            await assert.rejects(signWith(m, { ...chainAt(direct([WON7], REFS), 2001), consts }, built), PERIOD_UNREAD, JSON.stringify(consts));
            assert.deepEqual(built, []);
        }
        // Read, the same chain signs as offered.
        assert.deepEqual(await sign(m, chainAt(direct([WON7], REFS), 2001)), [['removeVote', 7], ['unlock', ME]]);
    });
});
