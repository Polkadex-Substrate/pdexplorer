// Cancel vote never stretches a larger earlier vote lock (issue #73, a
// follow-up to #69).
//
// Cancel vote is democracy.removeVote on a running referendum. The wallet
// prompt, or a multisig waiting for its other signers, can delay inclusion
// past the referendum's end. pallet-democracy (polkadot-stable2512-3):
//   - begin_block bakes a referendum in the block of its scheduled end and
//     stores Finished { end: now, approved }; nothing shortens it (an
//     emergency cancel removes the info, and removeVote then takes no lock);
//   - try_remove_vote on a finished referendum, for a Standard vote on the
//     winning side, accumulates (end + VoteLockingPeriod x lock_periods,
//     balance) into the prior while now is before that block;
//   - PriorLock::accumulate keeps the later block and the larger amount;
//   - democracy.unlock rejigs: a prior with now >= its block is cleared.
// The button leads with an unlock whenever a prior is on record, so a prior
// that ends by the referendum's end is cleared before the remove. One that
// runs past it merges with the vote's conviction lock into the larger amount
// until the later block; unless one of the two locks is at least as large
// AND lasts at least as long, that holds more PDEX for longer than either
// alone, in both directions: a larger prior ending first is held until the
// vote's date, and a smaller prior ending later holds the vote's amount until
// its own date. Refused before signing. The outcome is unknown, so either
// side may win. An unreadable VoteLockingPeriod could put the vote's date
// anywhere, so then only equal amounts are safe.
//
// Every amount, block and account here is made up (public repo).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lockActionSpec } from '../lib/lock-actions.js';
import { describeAccountLocks } from '../lib/balance-locks.js';
import { democracyChain } from './helpers/democracy-chain.js';

const PDEX = 10n ** 12n;
const s = (v) => v.toString();
const ME = 'esm9mgCefMrQ2EbGGyMNXGAFA3vnRGDid7GheURpcFRTjyokX';   // 0x11..11 at prefix 88
const same = (a, b) => String(a) === String(b);
const NOW = Date.UTC(2026, 0, 1);
const PERIOD = 1000;   // VoteLockingPeriod on this made-up chain
const PERIODS = { None: 0, Locked1x: 1, Locked2x: 2, Locked3x: 4, Locked4x: 8, Locked5x: 16, Locked6x: 32 };
const NO_PRIOR = { until: 0, amount: '0' };
const max = (a, b) => (a > b ? a : b);

const vote = (index, aye, conviction, amount) => ({ index, aye, conviction, balance: s(amount) });
const direct = (votes, referenda, prior = NO_PRIOR) => ({ delegating: false, lockingPeriod: PERIOD, votes, referenda, prior });
const lockOf = (dem) => dem.votes.reduce((a, v) => max(a, BigInt(v.balance)), BigInt(dem.prior.amount));
const snap = (dem, block) => ({
    address: ME, now: NOW, free: s(1000n * PDEX), reserved: '0', frozen: s(lockOf(dem)), ed: s(PDEX),
    block, blockMs: 6000, bondingDays: 28, eraMs: 86400000,
    locks: [{ id: 'democrac', amount: s(lockOf(dem)), reasons: 'All' }], freezes: [], holds: [], reserves: [],
    staking: { bonded: false, total: '0', active: '0', unlocking: '0', chunks: [], currentEra: null, activeEra: null, activeEraStart: null, spans: 0, controller: null, stash: null },
    democracy: dem, elections: null, identity: null, proxy: null, pallets: { vesting: false, ormlVesting: false }
});
// Every call the wallet would be asked to sign goes through here.
const txApi = (built = []) => ({ democracy: { unlock: (who) => { built.push('unlock'); return ['unlock', who]; }, removeVote: (i) => { built.push('removeVote'); return ['removeVote', i]; } },
    utility: { batchAll: (calls) => ({ batch: calls }) } });
const cancelSpec = (model, ref = 9) => lockActionSpec('democracy-cancel', model, ME, { connected: ME, isSame: same, ref });
// Drawn from `drawnDem` at `drawnAt`; signed against the chain as `chainDem` at `signAt`.
async function cancel(drawnDem, drawnAt, chainDem = drawnDem, signAt = drawnAt, { built = [], over = {}, period = PERIOD } = {}) {
    const spec = cancelSpec(describeAccountLocks(snap(drawnDem, drawnAt)));
    assert.equal(spec.error, undefined, spec.error);
    const chain = democracyChain(chainDem, signAt, { period });
    const t = await spec.buildTx({ ...chain, tx: txApi(built), ...over });
    return t.batch || [t];
}

// The pallet, written here from the rules above (not from the code under
// test): the prior after `calls` are included at block `at`, with referendum
// #`index` in state `info` by then.
function palletRun(dem, index, info, at, calls, period = PERIOD) {
    let prior = { until: Number(dem.prior.until), amount: BigInt(dem.prior.amount) };
    for (const [op, i] of calls) {
        if (op === 'unlock') { if (at >= prior.until) prior = { until: 0, amount: 0n }; continue; }
        assert.equal(op, 'removeVote');
        assert.equal(i, index);
        const v = dem.votes.find(x => x.index === i);
        if (info.finished && typeof v.aye === 'boolean' && v.aye === info.approved) {
            const unlockAt = info.end + period * PERIODS[v.conviction];
            if (at < unlockAt) prior = { until: Math.max(prior.until, unlockAt), amount: max(prior.amount, BigInt(v.balance)) };
        }
    }
    return prior;
}
// More PDEX for longer than either lock alone: the prior after inclusion
// (`after`) fits inside neither the earlier lock nor the vote's own
// conviction lock, compared in amount AND date. Catches both directions: a
// larger prior held past its end, and the vote's amount held to a later
// prior's end.
const covers = (lock, after) => after.amount <= lock.amount && after.until <= lock.until;
function overlocked(dem, index, info, after, period = PERIOD) {
    const v = dem.votes.find(x => x.index === index);
    const prior = { until: Number(dem.prior.until), amount: BigInt(dem.prior.amount) };
    const own = { until: info.end + period * PERIODS[v.conviction], amount: BigInt(v.balance) };
    return after.amount > 0n && !covers(prior, after) && !covers(own, after);
}
// Every way the referendum can stand at inclusion block `at`: running before
// its scheduled end, finished either way from it.
const outcomes = (end, at) => (at < end ? [{ ongoing: true, end }] : [{ finished: true, approved: true, end }, { finished: true, approved: false, end }]);
// What Cancel vote signed before this change: an unlock first when a prior is on record.
const oldBatch = (dem, index) => [...(BigInt(dem.prior.amount) > 0n ? [['unlock', ME]] : []), ['removeVote', index]];

// Issue #73: at block 1,001 a 500 PDEX prior runs until 1,100; referendum #9
// ends at 1,050, and this account voted 10 PDEX on it at 1x conviction.
// Should #9 end before inclusion with that side winning, the vote's own lock
// runs to 1,050 + 1,000 = 2,050, and the 500 PDEX would be held until then.
const DRAWN_AT = 1001;
const END = 1050;
const RUN9 = { 9: { ongoing: true, end: END } };
const PRIOR_500 = { until: 1100, amount: s(500n * PDEX) };
const AYE_1X = vote(9, true, 'Locked1x', 10n * PDEX);
const ISSUE = direct([AYE_1X], RUN9, PRIOR_500);
const REFUSED = 'Cancelling this vote now could keep more PDEX locked for longer. Referendum #9 ends at block 1,050; if it has ended by the time '
    + 'this transaction is included and your side wins, your earlier vote lock of 500 PDEX would stay until block 2,050 instead of block 1,100. '
    + 'Leave the vote in place; once the referendum ends, this panel shows when it can be removed.';
const isRefused = (msg) => (e) => { assert.equal(e.message, msg); return true; };

describe('issue #73: refused before signing when the referendum could end first and stretch a larger earlier lock', () => {
    test('as reported: 500 PDEX until 1,100, a 10 PDEX 1x vote on #9 ending at 1,050: refused with a plain message, nothing built', async () => {
        const built = [];
        await assert.rejects(cancel(ISSUE, DRAWN_AT, ISSUE, DRAWN_AT, { built }), isRefused(REFUSED));
        assert.deepEqual(built, []);
        // What it used to sign, included at 1,050 with #9 approved: 500 PDEX until 2,050.
        const won = { finished: true, approved: true, end: END };
        const after = palletRun(ISSUE, 9, won, END, oldBatch(ISSUE, 9));
        assert.deepEqual(after, { until: 2050, amount: 500n * PDEX });
        assert.equal(overlocked(ISSUE, 9, won, after), true);
    });
    test('a nay vote is refused too: the outcome is not known when it is signed', async () => {
        const nay = direct([vote(9, false, 'Locked1x', 10n * PDEX)], RUN9, PRIOR_500);
        await assert.rejects(cancel(nay, DRAWN_AT), isRefused(REFUSED));
        assert.deepEqual(palletRun(nay, 9, { finished: true, approved: false, end: END }, END + 5, oldBatch(nay, 9)), { until: 2050, amount: 500n * PDEX });
    });
    test('the stretch follows the conviction: 6x on 1,000-block periods reaches 1,050 + 32,000', async () => {
        const sixX = direct([vote(9, true, 'Locked6x', 10n * PDEX)], RUN9, PRIOR_500);
        await assert.rejects(cancel(sixX, DRAWN_AT), isRefused(REFUSED.replace('2,050', '33,050')));
    });
    test('a larger prior created after the panel was drawn (none then): the re-read before signing refuses', async () => {
        await assert.rejects(cancel(direct([AYE_1X], RUN9), DRAWN_AT, ISSUE, DRAWN_AT), isRefused(REFUSED));
    });
    test('signed later, still before the end (block 1,049): refused', async () => {
        await assert.rejects(cancel(ISSUE, DRAWN_AT, ISSUE, END - 1), isRefused(REFUSED));
    });
    test('VoteLockingPeriod cannot be read: assume the vote could outlast the prior, and refuse', async () => {
        await assert.rejects(cancel(ISSUE, DRAWN_AT, ISSUE, DRAWN_AT, { over: { consts: {} } }),
            isRefused(REFUSED.replace('until block 2,050 instead of block 1,100', 'until your vote\'s conviction lock ends instead of block 1,100')));
    });
});

// The mirror (Fable on #73): at block 1,001 a 100 PDEX prior runs until
// 5,000, and this account voted 600 PDEX at 1x on #9, ending at 1,050. Should
// #9 end before inclusion with that side winning, the vote's own lock would
// hold 600 PDEX until 2,050 and the prior 100 PDEX until 5,000; merged, 600
// PDEX until 5,000.
const PRIOR_100 = { until: 5000, amount: s(100n * PDEX) };
const AYE_600 = vote(9, true, 'Locked1x', 600n * PDEX);
const MIRROR = direct([AYE_600], RUN9, PRIOR_100);
const REFUSED_MIRROR = 'Cancelling this vote now could keep more PDEX locked for longer. Referendum #9 ends at block 1,050; if it has ended by the time '
    + 'this transaction is included and your side wins, the 600 PDEX of this vote would stay locked until block 5,000, when your earlier vote lock of 100 PDEX ends, '
    + 'instead of block 2,050. Leave the vote in place; once the referendum ends, this panel shows when it can be removed.';

describe('the mirror: a smaller earlier lock that ends later would hold the vote\'s amount until its own end', () => {
    test('as found: 100 PDEX until 5,000, a 600 PDEX 1x vote on #9 ending at 1,050: refused with a plain message, nothing built', async () => {
        const built = [];
        await assert.rejects(cancel(MIRROR, DRAWN_AT, MIRROR, DRAWN_AT, { built }), isRefused(REFUSED_MIRROR));
        assert.deepEqual(built, []);
        // What it used to sign, included at 1,050 with #9 approved: 600 PDEX until 5,000.
        const won = { finished: true, approved: true, end: END };
        const after = palletRun(MIRROR, 9, won, END, oldBatch(MIRROR, 9));
        assert.deepEqual(after, { until: 5000, amount: 600n * PDEX });
        assert.equal(overlocked(MIRROR, 9, won, after), true);
    });
    test('a nay vote is refused too', async () => {
        await assert.rejects(cancel(direct([vote(9, false, 'Locked1x', 600n * PDEX)], RUN9, PRIOR_100), DRAWN_AT), isRefused(REFUSED_MIRROR));
    });
    test('the vote\'s date follows the conviction: at 2x it would end at 3,050, still before 5,000', async () => {
        await assert.rejects(cancel(direct([vote(9, true, 'Locked2x', 600n * PDEX)], RUN9, PRIOR_100), DRAWN_AT), isRefused(REFUSED_MIRROR.replace('2,050', '3,050')));
    });
    test('a smaller prior created after the panel was drawn: the re-read before signing refuses', async () => {
        await assert.rejects(cancel(direct([AYE_600], RUN9), DRAWN_AT, MIRROR, DRAWN_AT), isRefused(REFUSED_MIRROR));
    });
    test('VoteLockingPeriod cannot be read: the vote\'s own date is unknown, so refuse', async () => {
        await assert.rejects(cancel(MIRROR, DRAWN_AT, MIRROR, DRAWN_AT, { over: { consts: {} } }), isRefused(
            'Cancelling this vote now could keep more PDEX locked for longer. Referendum #9 ends at block 1,050; if it has ended by the time '
            + 'this transaction is included and your side wins, the 600 PDEX of this vote could stay locked until block 5,000, when your earlier vote lock of 100 PDEX ends, '
            + 'even if its own conviction lock ends sooner. Leave the vote in place; once the referendum ends, this panel shows when it can be removed.'));
    });
});

// The cases that keep working, with the calls they sign.
const KEEP = [
    ['no conviction beside a larger running prior', direct([vote(9, true, 'None', 10n * PDEX)], RUN9, PRIOR_500), [['unlock', ME], ['removeVote', 9]]],
    ['a split vote beside a larger running prior', direct([vote(9, null, 'None', 10n * PDEX)], RUN9, PRIOR_500), [['unlock', ME], ['removeVote', 9]]],
    ['conviction with no prior', direct([vote(9, true, 'Locked6x', 10n * PDEX)], RUN9), [['removeVote', 9]]],
    ['conviction, a prior of the same amount', direct([AYE_1X], RUN9, { until: 1100, amount: s(10n * PDEX) }), [['unlock', ME], ['removeVote', 9]]],
    ['conviction, a smaller prior', direct([vote(9, true, 'Locked1x', 600n * PDEX)], RUN9, PRIOR_500), [['unlock', ME], ['removeVote', 9]]],
    ['conviction, a larger prior ending at the referendum\'s end (the leading unlock clears it)', direct([AYE_1X], RUN9, { until: END, amount: s(500n * PDEX) }), [['unlock', ME], ['removeVote', 9]]],
    ['conviction, a larger prior ending before the referendum', direct([AYE_1X], RUN9, { until: 1020, amount: s(500n * PDEX) }), [['unlock', ME], ['removeVote', 9]]],
    ['conviction, a larger prior lasting exactly as long as the vote could', direct([AYE_1X], RUN9, { until: 2050, amount: s(500n * PDEX) }), [['unlock', ME], ['removeVote', 9]]],
    ['conviction, a larger prior lasting longer than the vote could', direct([AYE_1X], RUN9, { until: 3000, amount: s(500n * PDEX) }), [['unlock', ME], ['removeVote', 9]]],
    ['conviction, a larger prior already over', direct([AYE_1X], RUN9, { until: 900, amount: s(500n * PDEX) }), [['unlock', ME], ['removeVote', 9]]],
    ['conviction, a smaller prior ending when the vote could', direct([AYE_600], RUN9, { until: 2050, amount: s(100n * PDEX) }), [['unlock', ME], ['removeVote', 9]]],
    ['conviction, a smaller prior ending at the referendum\'s end', direct([AYE_600], RUN9, { until: END, amount: s(100n * PDEX) }), [['unlock', ME], ['removeVote', 9]]],
    ['conviction, a prior of the same amount ending later', direct([AYE_600], RUN9, { until: 5000, amount: s(600n * PDEX) }), [['unlock', ME], ['removeVote', 9]]]
];

describe('votes without conviction, and accounts without such a prior, keep working', () => {
    for (const [what, dem, calls] of KEEP) {
        test(`${what}: the same calls as before`, async () => {
            assert.deepEqual(await cancel(dem, DRAWN_AT), calls);
            assert.deepEqual(calls, oldBatch(dem, 9));
        });
    }
    test('VoteLockingPeriod cannot be read, a prior of the same amount ending later: built, whatever the vote\'s date', async () => {
        const dem = direct([AYE_600], RUN9, { until: 5000, amount: s(600n * PDEX) });
        assert.deepEqual(await cancel(dem, DRAWN_AT, dem, DRAWN_AT, { over: { consts: {} } }), [['unlock', ME], ['removeVote', 9]]);
    });
});

describe('the referendum ends between building and inclusion, multisig execution included', () => {
    // A multisig wallet builds the call once, when the first signer approves;
    // the last approval executes that same call, however many blocks later.
    const LATER = [DRAWN_AT, END - 1, END, END + 1, 1099, 1100, 1101, 2049, 2050, 5000, 40_000];
    test('refused at the first approval: no call to approve, so nothing can execute after the end', async () => {
        const built = [];
        const spec = cancelSpec(describeAccountLocks(snap(ISSUE, DRAWN_AT)));
        const chain = democracyChain(ISSUE, DRAWN_AT, { period: PERIOD });
        await assert.rejects(spec.buildTx({ ...chain, tx: txApi(built) }), isRefused(REFUSED));
        assert.deepEqual(built, []);
        assert.ok(chain.reads.some(r => r[0] === 'votingOf'), 'the prior was read again before refusing');
    });
    for (const [what, dem] of KEEP) {
        test(`${what}: built at 1,001, executed at any later block after either outcome, no lock is held larger or longer than either alone`, async () => {
            const calls = await cancel(dem, DRAWN_AT);
            for (const at of LATER) {
                for (const info of outcomes(END, at)) {
                    assert.equal(overlocked(dem, 9, info, palletRun(dem, 9, info, at, calls)), false, `${JSON.stringify(info)} at ${at}`);
                }
            }
        });
    }
});

describe('property: refused exactly when signing could hold more PDEX for longer than either lock', () => {
    // Random vote, prior and timing: the panel drawn at `now`, signed at any
    // block before the referendum's end, included at any later block with
    // either outcome. No batch built ever leaves a lock larger, or longer,
    // than both the earlier lock and the vote's own conviction lock; every
    // refusal had a harmful inclusion.
    let x = 73;
    const r = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
    const pick = (xs) => xs[Math.floor(r() * xs.length)];
    const now = 10_000;
    const randomCase = () => {
        const end = now + 1 + Math.floor(r() * 3 * PERIOD);
        // Amounts from a small set too, so equal amounts come up.
        const amount = () => (r() < 0.3 ? pick([100n, 600n]) : BigInt(1 + Math.floor(r() * 900))) * PDEX;
        const v = vote(9, pick([true, false, null]), pick(Object.keys(PERIODS)), amount());
        const prior = r() < 0.2 ? NO_PRIOR : { until: Math.max(1, now + Math.floor((r() - 0.2) * 40 * PERIOD)), amount: s(amount()) };
        const signAt = now + Math.floor(r() * (end - now));
        return { end, v, prior, signAt, dem: direct([v], { 9: { ongoing: true, end } }, prior) };
    };
    const blocksFor = ({ end, v, prior, signAt }, period) => {
        const unlockAt = end + period * PERIODS[v.conviction];
        return [signAt, end - 1, end, end + 1, Number(prior.until) - 1, Number(prior.until), Number(prior.until) + 1, unlockAt - 1, unlockAt, unlockAt + 1]
            .filter(b => b >= signAt);
    };
    const harmful = (c, calls, period = PERIOD) => blocksFor(c, period).some(at => outcomes(c.end, at)
        .some(info => overlocked(c.dem, 9, info, palletRun(c.dem, 9, info, at, calls, period), period)));

    test('VoteLockingPeriod known: built never overlocks, in either dimension; refused only when the old batch could', async () => {
        let built = 0, refused = 0;
        for (let k = 0; k < 2000; k++) {
            const c = randomCase();
            let calls = null;
            try { calls = await cancel(c.dem, now, c.dem, c.signAt); } catch (e) {
                assert.match(e.message, /^Cancelling this vote now could keep more PDEX locked for longer\./, `case ${k}`);
                refused++;
                assert.equal(harmful(c, oldBatch(c.dem, 9)), true, `case ${k}: refused, yet signing could not have overlocked: ${JSON.stringify(c)}`);
                continue;
            }
            built++;
            assert.equal(harmful(c, calls), false, `case ${k}: built, and it overlocks: ${JSON.stringify({ ...c, calls })}`);
        }
        assert.ok(built > 600 && refused > 300, `enough of both (${built} built, ${refused} refused)`);
    });
    test('VoteLockingPeriod unreadable: whatever the real period, a batch built never overlocks', async () => {
        let built = 0, refused = 0;
        for (let k = 0; k < 600; k++) {
            const c = randomCase();
            let calls = null;
            try { calls = await cancel(c.dem, now, c.dem, c.signAt, { over: { consts: {} } }); } catch (e) {
                assert.match(e.message, /^Cancelling this vote now could keep more PDEX locked for longer\./, `case ${k}`);
                refused++;
                continue;
            }
            built++;
            for (const period of [1, 7, PERIOD, 50 * PERIOD]) {
                assert.equal(harmful(c, calls, period), false, `case ${k}, real period ${period}: built, and it overlocks: ${JSON.stringify({ ...c, calls })}`);
            }
        }
        assert.ok(built > 200 && refused > 100, `enough of both (${built} built, ${refused} refused)`);
    });
});

describe('the help page says when Cancel vote is refused, both ways', () => {
    test('a larger earlier lock ending first, and a smaller one ending later; neither as a "larger prior" only', async () => {
        const { HELP_TOPICS } = await import('../lib/help-topics.js');
        const body = HELP_TOPICS.find(t => t.slug === 'locked-balance').body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
        assert.match(body, /Cancel vote on referendum is refused before signing when an earlier vote lock runs past the referendum's end and neither it nor your vote's conviction lock is at least as large and at least as long as the other/);
        assert.match(body, /a larger earlier lock would stay until your vote's later date, or your vote's amount until the earlier lock's later date/);
    });
});
