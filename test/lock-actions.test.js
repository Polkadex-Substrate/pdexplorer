// One-click releases for locked PDEX (CEO request, Nov 2026: "withdraw
// unbonded staking tokens, and unlocked voting tokens"; Lead: the leftover
// staking lock).
//
//   lib/lock-actions.js          pure: which release succeeds now, when the
//                                rest becomes possible, and the call each
//                                button signs
//   lib/balance-locks-chain.js   the extra reads (unlock chunks, eras,
//                                slashing spans, controller)
//   lib/balance-locks-view.js    the buttons in the breakdown panel and the
//                                click path through submitSignedTx
//
// Pallet facts the logic follows (pallet-staking 45.1.0, pallet-democracy and
// pallet-elections-phragmen in polkadot-stable2512, the spec 392 runtime):
//   - withdraw_unbonded(num_slashing_spans) is signed by the controller and
//     frees every chunk with era <= CurrentEra (consolidate_unlocked takes
//     CurrentEra, not ActiveEra); num_slashing_spans must be at least
//     SlashingSpans(stash).prior.len() + 1 when spans exist, else 0;
//   - migrate_currency(stash) is callable by any signed account, removes the
//     "staking " lock and returns Ok with the fee refunded (Pays::No) when the
//     stash has no ledger; there is no event in that case, so success is
//     checked by re-reading balances.locks;
//   - democracy.remove_vote(index) succeeds for an ongoing, finished or
//     cancelled referendum; a finished one won with conviction moves the vote
//     into the prior lock (until end + periods x VoteLockingPeriod, periods
//     1,2,4,8,16,32 for Locked1x..6x) when that is still in the future;
//     PriorLock::accumulate keeps the max of both the block and the amount;
//   - democracy.unlock(target) sets the lock to max(votes still recorded,
//     prior if not yet expired) and never fails;
//   - democracy.undelegate puts the delegated balance into the prior lock
//     until now + periods x VoteLockingPeriod;
//   - elections.remove_voter releases the "phrelect" lock and the deposit.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
    slashingSpanCount, unbondingSchedule, democracyActions, lockActions, lockRemoved, lockActionSpec
} from '../lib/lock-actions.js';
import { describeAccountLocks } from '../lib/balance-locks.js';
import { readAccountLocks } from '../lib/balance-locks-chain.js';
import { registerBalanceLocksRoute } from '../lib/balance-locks-api.js';
import { renderBalanceLocks, runLockAction } from '../lib/balance-locks-view.js';
import { successCopy, PENDING_TITLE, ERROR_COPY, ACTION_KEYS } from '../lib/tx-status.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';

const PDEX = 10n ** 12n;
const s = (v) => v.toString();
const DAY = 86400000;
const BLOCK_MS = 12000;
const PERIOD = 216000;          // democracy VoteLockingPeriod on spec 392 (30 days of 12 s blocks)
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const BLOCK = 1_000_000;

// Made-up accounts (public repo): 0x11..11 and 0x22..22 at prefix 88.
const ME = 'esm9mgCefMrQ2EbGGyMNXGAFA3vnRGDid7GheURpcFRTjyokX';
const OTHER = 'esmY9ZU5xPLb8urxWNBq89tPvEAG3CZm4KboeysfVgQuEw1io';

function snap(over = {}) {
    return {
        address: ME, now: NOW,
        free: s(100n * PDEX), reserved: '0', frozen: '0', ed: s(PDEX),
        block: BLOCK, blockMs: BLOCK_MS, bondingDays: 28, eraMs: DAY,
        locks: [], freezes: [], holds: [], reserves: [],
        staking: { bonded: false, total: '0', active: '0', unlocking: '0', chunks: [], currentEra: null, activeEra: null, activeEraStart: null, spans: 0, controller: null, stash: null },
        democracy: null, elections: null, identity: null, proxy: null,
        pallets: { vesting: false, ormlVesting: false },
        ...over
    };
}
const lock = (id, amount) => ({ id, amount: s(amount), reasons: 'All' });

describe('slashingSpanCount: the num_slashing_spans withdrawUnbonded needs', () => {
    test('no spans record: 0', () => {
        assert.equal(slashingSpanCount(null), 0);
        assert.equal(slashingSpanCount({ isSome: false, isNone: true }), 0);
    });
    test('a record counts the current span plus every prior one', () => {
        assert.equal(slashingSpanCount({ prior: [] }), 1);
        assert.equal(slashingSpanCount({ spanIndex: 3, prior: [4, 9] }), 3);
        assert.equal(slashingSpanCount({ isSome: true, unwrap: () => ({ prior: [1, 2, 3] }) }), 4);
    });
});

describe('unbondingSchedule: withdrawable now vs still unbonding, with a date', () => {
    const chunks = [{ value: s(10n * PDEX), era: 100 }, { value: s(7n * PDEX), era: 110 }, { value: s(5n * PDEX), era: 105 }];
    const start = NOW - 3600000;
    test('chunks with era <= CurrentEra are withdrawable; the rest are listed by era with erasLeft and an estimated date', () => {
        const r = unbondingSchedule({ chunks, currentEra: 105, activeEra: 104, activeEraStart: start, eraMs: DAY, now: NOW });
        assert.equal(r.withdrawable, s(15n * PDEX));
        assert.equal(r.readyCount, 2);
        assert.deepEqual(r.pending, [{ value: s(7n * PDEX), era: 110, erasLeft: 5, eta: start + 6 * DAY }]);
    });
    test('CurrentEra decides, not ActiveEra: a chunk at CurrentEra is withdrawable while ActiveEra is one behind', () => {
        const r = unbondingSchedule({ chunks: [{ value: s(PDEX), era: 105 }], currentEra: 105, activeEra: 104, activeEraStart: start, eraMs: DAY, now: NOW });
        assert.equal(r.withdrawable, s(PDEX));
    });
    test('no CurrentEra: falls back to ActiveEra', () => {
        const r = unbondingSchedule({ chunks, currentEra: null, activeEra: 105, activeEraStart: start, eraMs: DAY, now: NOW });
        assert.equal(r.withdrawable, s(15n * PDEX));
    });
    test('no era start: the date counts whole eras from now', () => {
        const r = unbondingSchedule({ chunks, currentEra: 105, activeEra: null, activeEraStart: null, eraMs: DAY, now: NOW });
        assert.equal(r.pending[0].eta, NOW + 5 * DAY);
    });
    test('no era length: no date rather than a wrong one', () => {
        const r = unbondingSchedule({ chunks, currentEra: 105, activeEra: 104, activeEraStart: start, eraMs: 0, now: NOW });
        assert.equal(r.pending[0].eta, null);
    });
    test('nothing matured: withdrawable 0', () => {
        const r = unbondingSchedule({ chunks, currentEra: 99, activeEra: 99, activeEraStart: start, eraMs: DAY, now: NOW });
        assert.equal(r.withdrawable, '0');
        assert.equal(r.pending.length, 3);
        assert.deepEqual(r.pending.map(c => c.era), [100, 105, 110]);
    });
});

describe('democracyActions: what removeVote and unlock release now, and when the rest can go', () => {
    const vote = (index, aye, conviction, amount) => ({ index, aye, conviction, balance: s(amount) });
    const dem = (votes, referenda, prior = { until: 0, amount: '0' }) => ({ delegating: false, votes, referenda, prior, lockingPeriod: PERIOD });
    const at = { block: BLOCK, blockMs: BLOCK_MS, now: NOW };

    test('finished, voted on the losing side: remove it and unlock everything now', () => {
        const a = democracyActions(dem([vote(4, false, 'Locked3x', 40n * PDEX)], { 4: { finished: true, approved: true, end: 900_000 } }), { ...at, lockAmount: s(40n * PDEX) });
        assert.equal(a.mode, 'direct');
        assert.deepEqual(a.remove.map(r => r.index), [4]);
        assert.equal(a.unlock, true);
        assert.equal(a.lockAfter, '0');
        assert.equal(a.freed, s(40n * PDEX));
        assert.equal(a.lockedUntil, null);
    });
    for (const [conv, periods] of [['None', 0], ['Locked1x', 1], ['Locked2x', 2], ['Locked3x', 4], ['Locked4x', 8], ['Locked5x', 16], ['Locked6x', 32]]) {
        test(`conviction ${conv} on the winning side locks for ${periods} x VoteLockingPeriod after the end`, () => {
            const end = 990_000;
            const a = democracyActions(dem([vote(4, true, conv, 40n * PDEX)], { 4: { finished: true, approved: true, end } }), { ...at, lockAmount: s(40n * PDEX) });
            const until = end + periods * PERIOD;
            assert.equal(a.remove[0].lockUntil, until > BLOCK ? until : null);
            if (until > BLOCK) {
                assert.equal(a.unlock, false, 'the prior lock keeps all 40 PDEX, so unlock frees nothing yet');
                assert.equal(a.lockAfter, s(40n * PDEX));
                assert.equal(a.lockedUntil, until);
                assert.equal(a.lockedUntilEta, NOW + (until - BLOCK) * BLOCK_MS);
            } else {
                assert.equal(a.unlock, true);
                assert.equal(a.lockAfter, '0');
            }
        });
    }
    test('a nay that won (referendum rejected) is locked with its conviction too', () => {
        const a = democracyActions(dem([vote(5, false, 'Locked1x', 10n * PDEX)], { 5: { finished: true, approved: false, end: 950_000 } }), { ...at, lockAmount: s(10n * PDEX) });
        assert.equal(a.remove[0].lockUntil, 950_000 + PERIOD);
    });
    test('an ongoing referendum: offered as "cancel" with its end, and its balance stays locked after the others go', () => {
        const a = democracyActions(dem([vote(4, false, 'None', 40n * PDEX), vote(9, true, 'Locked1x', 15n * PDEX)],
            { 4: { finished: true, approved: true, end: 900_000 }, 9: { ongoing: true, end: 1_050_000 } }), { ...at, lockAmount: s(40n * PDEX) });
        assert.deepEqual(a.remove.map(r => r.index), [4]);
        assert.deepEqual(a.cancel, [{ index: 9, end: 1_050_000, eta: NOW + 50_000 * BLOCK_MS }]);
        assert.equal(a.unlock, true, 'removing #4 drops the lock from 40 to 15');
        assert.equal(a.lockAfter, s(15n * PDEX));
        assert.equal(a.freed, s(25n * PDEX));
        assert.deepEqual(a.waitFor, [9]);
    });
    test('a cancelled referendum (no ReferendumInfoOf) is removable with no lock', () => {
        const a = democracyActions(dem([vote(3, true, 'Locked6x', 20n * PDEX)], { 3: { cancelled: true } }), { ...at, lockAmount: s(20n * PDEX) });
        assert.deepEqual(a.remove, [{ index: 3, state: 'cancelled', lockUntil: null }]);
        assert.equal(a.unlock, true);
        assert.equal(a.lockAfter, '0');
    });
    test('only an expired prior lock: just unlock', () => {
        const a = democracyActions(dem([], {}, { until: 500_000, amount: s(30n * PDEX) }), { ...at, lockAmount: s(30n * PDEX) });
        assert.deepEqual(a.remove, []);
        assert.equal(a.unlock, true);
        assert.equal(a.freed, s(30n * PDEX));
        assert.equal(a.rejigFirst, false, 'nothing to remove, so one unlock is enough');
    });
    test('a prior lock still running: no unlock, the date it ends', () => {
        const a = democracyActions(dem([], {}, { until: 1_200_000, amount: s(30n * PDEX) }), { ...at, lockAmount: s(30n * PDEX) });
        assert.equal(a.unlock, false);
        assert.equal(a.lockedUntil, 1_200_000);
    });
    test('PriorLock::accumulate keeps the larger amount: an expired 50 PDEX prior is cleared first (unlock, removes, unlock)', () => {
        const a = democracyActions(dem([vote(4, true, 'Locked1x', 10n * PDEX)], { 4: { finished: true, approved: true, end: 900_000 } }, { until: 500_000, amount: s(50n * PDEX) }),
            { ...at, lockAmount: s(50n * PDEX) });
        assert.equal(a.rejigFirst, true);
        assert.equal(a.lockAfter, s(10n * PDEX), 'with the expired prior cleared first, only the new 10 PDEX prior remains');
        assert.equal(a.lockedUntil, 900_000 + PERIOD);
        assert.equal(a.unlock, true);
    });
    test('the lock amount defaults to the largest vote or prior when the balances lock is not given', () => {
        const a = democracyActions(dem([vote(4, false, 'None', 12n * PDEX)], { 4: { finished: true, approved: true, end: 900_000 } }), at);
        assert.equal(a.lockNow, s(12n * PDEX));
        assert.equal(a.freed, s(12n * PDEX));
    });
    test('delegating: undelegate is the only step; the delegated PDEX stays locked for the conviction period after it', () => {
        const d = { delegating: true, target: OTHER, conviction: 'Locked2x', balance: s(30n * PDEX), prior: { until: 0, amount: '0' }, lockingPeriod: PERIOD };
        const a = democracyActions(d, { ...at, lockAmount: s(30n * PDEX) });
        assert.equal(a.mode, 'delegating');
        assert.equal(a.unlock, false);
        assert.deepEqual(a.undelegate, { target: OTHER, conviction: 'Locked2x', lockUntil: BLOCK + 2 * PERIOD, lockUntilEta: NOW + 2 * PERIOD * BLOCK_MS });
    });
    test('delegating with no conviction: unlockable right after undelegating', () => {
        const d = { delegating: true, target: OTHER, conviction: 'None', balance: s(30n * PDEX), prior: { until: 0, amount: '0' }, lockingPeriod: PERIOD };
        assert.equal(democracyActions(d, at).undelegate.lockUntil, BLOCK);
    });
    test('no democracy data: null', () => assert.equal(democracyActions(null, at), null));
});

describe('lockActions: the releases a snapshot allows', () => {
    test('orphan: a "staking " lock with no bond offers migrateCurrency for this stash', () => {
        const a = lockActions(snap({ locks: [lock('staking ', 60n * PDEX)] }));
        assert.deepEqual(a.orphan, { stash: ME, amount: s(60n * PDEX) });
    });
    test('a bonded account is not an orphan', () => {
        const a = lockActions(snap({ locks: [lock('staking ', 60n * PDEX)], staking: { ...snap().staking, bonded: true, total: s(60n * PDEX), active: s(60n * PDEX) } }));
        assert.equal(a.orphan, null);
    });
    test('withdraw: matured chunks, the spans count and who must sign', () => {
        const st = { bonded: true, total: s(30n * PDEX), active: s(10n * PDEX), unlocking: s(20n * PDEX),
            chunks: [{ value: s(15n * PDEX), era: 100 }, { value: s(5n * PDEX), era: 120 }], currentEra: 101, activeEra: 101, activeEraStart: NOW - 1000, spans: 2, controller: ME, stash: ME };
        const a = lockActions(snap({ staking: st }));
        assert.equal(a.withdraw.withdrawable, s(15n * PDEX));
        assert.equal(a.withdraw.spans, 2);
        assert.equal(a.withdraw.signer, ME);
        assert.equal(a.withdraw.controllerDiffers, false);
        assert.equal(a.withdraw.pending[0].era, 120);
    });
    test('withdraw: a separate controller is named', () => {
        const st = { bonded: true, total: s(5n * PDEX), active: '0', unlocking: s(5n * PDEX), chunks: [{ value: s(5n * PDEX), era: 1 }], currentEra: 2, activeEra: 2, activeEraStart: NOW, spans: 0, controller: OTHER, stash: ME };
        const a = lockActions(snap({ staking: st }));
        assert.equal(a.withdraw.signer, OTHER);
        assert.equal(a.withdraw.controllerDiffers, true);
    });
    test('no unbonding chunks: no withdraw section', () => {
        const a = lockActions(snap({ staking: { ...snap().staking, bonded: true, total: s(PDEX), active: s(PDEX) } }));
        assert.equal(a.withdraw, null);
    });
    test('a council voter can remove the vote (lock and deposit)', () => {
        const a = lockActions(snap({ elections: { voter: { votes: 2, stake: s(9n * PDEX), deposit: s(PDEX) }, candidacy: null } }));
        assert.deepEqual(a.elections, { votes: 2, stake: s(9n * PDEX), deposit: s(PDEX) });
    });
    test('democracy uses the "democrac" lock amount', () => {
        const a = lockActions(snap({ locks: [lock('democrac', 40n * PDEX)],
            democracy: { delegating: false, votes: [{ index: 4, aye: false, conviction: 'None', balance: s(40n * PDEX) }], referenda: { 4: { finished: true, approved: true, end: 1 } }, prior: { until: 0, amount: '0' }, lockingPeriod: PERIOD } }));
        assert.equal(a.democracy.lockNow, s(40n * PDEX));
        assert.equal(a.democracy.unlock, true);
    });
    test('describeAccountLocks carries the actions, and the orphan row now says anyone can remove it, fee refunded', () => {
        const m = describeAccountLocks(snap({ locks: [lock('staking ', 60n * PDEX)], frozen: s(60n * PDEX) }));
        assert.deepEqual(m.actions.orphan, { stash: ME, amount: s(60n * PDEX) });
        const r = m.items.find(i => i.id === 'staking ');
        assert.equal(r.status, 'orphan');
        assert.match(r.unlock, /migrateCurrency/);
        assert.match(r.unlock, /[Aa]ny account/);
        assert.match(r.unlock, /refunded/);
        assert.doesNotMatch(r.unlock, /preparing a fix/);
    });
});

describe('lockRemoved: the post-inclusion check for migrateCurrency (no event when unbonded)', () => {
    const raw = (id) => ({ id: { toU8a: () => new Uint8Array(Buffer.from(id)) }, amount: 1 });
    test('locks without "staking ": removed', () => assert.equal(lockRemoved([raw('democrac')]), true));
    test('locks still holding "staking ": not removed', () => assert.equal(lockRemoved([raw('democrac'), raw('staking ')]), false));
    test('plain ids and an empty list', () => {
        assert.equal(lockRemoved([{ id: 'staking ' }]), false);
        assert.equal(lockRemoved([]), true);
    });
});

// A fake api.tx that records the calls each button would sign.
function fakeTxApi({ noMigrate = false, noBatch = false, locksAfter = [] } = {}) {
    const c = (name) => (...args) => ({ call: name, args });
    const tx = {
        staking: { withdrawUnbonded: c('staking.withdrawUnbonded'), ...(noMigrate ? {} : { migrateCurrency: c('staking.migrateCurrency') }) },
        democracy: { removeVote: c('democracy.removeVote'), unlock: c('democracy.unlock'), undelegate: c('democracy.undelegate') },
        elections: { removeVoter: c('elections.removeVoter') },
        utility: noBatch ? {} : { batchAll: c('utility.batchAll') }
    };
    const query = { balances: { locks: async () => locksAfter } };
    return { tx, query };
}
const same = (a, b) => String(a) === String(b);

describe('lockActionSpec: the call each button signs, and who may sign it', () => {
    const withdrawModel = (over = {}) => ({ actions: { withdraw: { withdrawable: s(15n * PDEX), readyCount: 1, pending: [], spans: 3, signer: ME, controller: ME, controllerDiffers: false, ...over } } });
    test('withdraw: staking.withdrawUnbonded(spans), signed by the controller', async () => {
        const spec = lockActionSpec('withdraw', withdrawModel(), ME, { connected: ME, isSame: same });
        assert.equal(spec.error, undefined);
        assert.equal(spec.key, 'staking.withdraw');
        assert.deepEqual(await spec.buildTx(fakeTxApi()), { call: 'staking.withdrawUnbonded', args: [3] });
    });
    test('withdraw: another account connected and a separate controller: names the controller', () => {
        const spec = lockActionSpec('withdraw', withdrawModel({ signer: OTHER, controller: OTHER, controllerDiffers: true }), ME, { connected: ME, isSame: same });
        assert.match(spec.error, /controller/);
        assert.match(spec.error, new RegExp(OTHER.slice(0, 8)));
    });
    test('withdraw: not connected as this account', () => {
        const spec = lockActionSpec('withdraw', withdrawModel(), ME, { connected: OTHER, isSame: same });
        assert.match(spec.error, /[Cc]onnect/);
    });
    const demModel = (d) => ({ actions: { democracy: { mode: 'direct', remove: [], cancel: [], unlock: false, rejigFirst: false, lockNow: '0', lockAfter: '0', freed: '0', ...d } } });
    test('democracy: remove every finished vote, then unlock, in one batchAll', async () => {
        const spec = lockActionSpec('democracy-unlock', demModel({ remove: [{ index: 4 }, { index: 7 }], unlock: true, freed: s(5n * PDEX) }), ME, { connected: ME, isSame: same });
        assert.equal(spec.key, 'democracy.unlock');
        const t = await spec.buildTx(fakeTxApi());
        assert.equal(t.call, 'utility.batchAll');
        assert.deepEqual(t.args[0], [
            { call: 'democracy.removeVote', args: [4] }, { call: 'democracy.removeVote', args: [7] }, { call: 'democracy.unlock', args: [ME] }]);
    });
    test('democracy: only an unlock is a single call', async () => {
        const spec = lockActionSpec('democracy-unlock', demModel({ unlock: true }), ME, { connected: ME, isSame: same });
        assert.deepEqual(await spec.buildTx(fakeTxApi()), { call: 'democracy.unlock', args: [ME] });
    });
    test('democracy: an expired prior is cleared before the removes (unlock, removes, unlock)', async () => {
        const spec = lockActionSpec('democracy-unlock', demModel({ remove: [{ index: 4 }], unlock: true, rejigFirst: true }), ME, { connected: ME, isSame: same });
        const t = await spec.buildTx(fakeTxApi());
        assert.deepEqual(t.args[0].map(x => x.call), ['democracy.unlock', 'democracy.removeVote', 'democracy.unlock']);
    });
    test('democracy: removes without an unlock (the lock stays) still record the removals', async () => {
        const spec = lockActionSpec('democracy-unlock', demModel({ remove: [{ index: 4 }], unlock: false }), ME, { connected: ME, isSame: same });
        assert.deepEqual(await spec.buildTx(fakeTxApi()), { call: 'democracy.removeVote', args: [4] });
    });
    test('democracy: nothing to do is an error, not an empty batch', () => {
        assert.match(lockActionSpec('democracy-unlock', demModel({}), ME, { connected: ME, isSame: same }).error, /[Nn]othing/);
    });
    test('democracy: no batchAll on the runtime and more than one call: the build refuses', async () => {
        const spec = lockActionSpec('democracy-unlock', demModel({ remove: [{ index: 4 }], unlock: true }), ME, { connected: ME, isSame: same });
        await assert.rejects(async () => spec.buildTx(fakeTxApi({ noBatch: true })), /batchAll/);
    });
    test('democracy: cancel one ongoing vote', async () => {
        const spec = lockActionSpec('democracy-cancel', demModel({ cancel: [{ index: 9, end: 2 }] }), ME, { connected: ME, isSame: same, ref: 9 });
        assert.equal(spec.key, 'democracy.removeVote');
        assert.deepEqual(await spec.buildTx(fakeTxApi()), { call: 'democracy.removeVote', args: [9] });
    });
    test('democracy: cancel refuses a referendum it did not offer', () => {
        assert.ok(lockActionSpec('democracy-cancel', demModel({ cancel: [{ index: 9, end: 2 }] }), ME, { connected: ME, isSame: same, ref: 10 }).error);
    });
    test('democracy: undelegate', async () => {
        const spec = lockActionSpec('democracy-undelegate', demModel({ mode: 'delegating', undelegate: { target: OTHER, lockUntil: 1 } }), ME, { connected: ME, isSame: same });
        assert.equal(spec.key, 'democracy.undelegate');
        assert.deepEqual(await spec.buildTx(fakeTxApi()), { call: 'democracy.undelegate', args: [] });
    });
    test('democracy and elections need this account connected', () => {
        assert.match(lockActionSpec('democracy-unlock', demModel({ unlock: true }), ME, { connected: OTHER, isSame: same }).error, /[Cc]onnect/);
        assert.match(lockActionSpec('elections-remove', { actions: { elections: { votes: 1 } } }, ME, { connected: null, isSame: same }).error, /[Cc]onnect/);
    });
    test('elections: removeVoter', async () => {
        const spec = lockActionSpec('elections-remove', { actions: { elections: { votes: 1, stake: '1', deposit: '1' } } }, ME, { connected: ME, isSame: same });
        assert.equal(spec.key, 'elections.removeVoter');
        assert.deepEqual(await spec.buildTx(fakeTxApi()), { call: 'elections.removeVoter', args: [] });
    });
    const orphanModel = { actions: { orphan: { stash: ME, amount: s(60n * PDEX) } } };
    test('migrateCurrency: any connected account may submit it for this stash', async () => {
        const spec = lockActionSpec('migrate-currency', orphanModel, ME, { connected: OTHER, isSame: same });
        assert.equal(spec.error, undefined);
        assert.equal(spec.key, 'staking.migrateCurrency');
        assert.deepEqual(await spec.buildTx(fakeTxApi()), { call: 'staking.migrateCurrency', args: [ME] });
    });
    test('migrateCurrency: no wallet connected: says any account will do', () => {
        const spec = lockActionSpec('migrate-currency', orphanModel, ME, { connected: null, isSame: same });
        assert.match(spec.error, /[Cc]onnect/);
        assert.match(spec.error, /any/i);
    });
    test('migrateCurrency: verify and check re-read balances.locks of the stash', async () => {
        const spec = lockActionSpec('migrate-currency', orphanModel, ME, { connected: OTHER, isSame: same });
        const still = [{ id: { toU8a: () => new Uint8Array(Buffer.from('staking ')) } }];
        assert.equal(await spec.verify(fakeTxApi({ locksAfter: still })), null);
        assert.equal(await spec.verify(fakeTxApi({ locksAfter: [] })), 'applied');
        assert.deepEqual(await spec.check(fakeTxApi({ locksAfter: [] })), { ok: true, text: 'The leftover staking lock is gone. The PDEX it held is transferable again.' });
        const r = await spec.check(fakeTxApi({ locksAfter: still }));
        assert.equal(r.ok, false);
        assert.match(r.text, /still/);
    });
    test('migrateCurrency: a runtime without the call refuses at build time', async () => {
        const spec = lockActionSpec('migrate-currency', orphanModel, ME, { connected: OTHER, isSame: same });
        await assert.rejects(async () => spec.buildTx(fakeTxApi({ noMigrate: true })), /migrateCurrency/);
    });
    test('an action the model does not offer is an error', () => {
        assert.ok(lockActionSpec('withdraw', { actions: {} }, ME, { connected: ME, isSame: same }).error);
        assert.ok(lockActionSpec('nope', { actions: {} }, ME, { connected: ME, isSame: same }).error);
    });
});

describe('runLockAction: the click path (submitSignedTx, then the chain check)', () => {
    const orphanModel = { actions: { orphan: { stash: ME, amount: s(60n * PDEX) } } };
    const msgEl = () => ({ textContent: '', className: '' });
    test('passes the spec to submit, with the button, key and verify', async () => {
        const calls = [];
        const button = { textContent: 'Remove leftover staking lock' };
        await runLockAction('migrate-currency', { model: orphanModel, address: ME, button, msg: msgEl(),
            deps: { submit: async (o) => { calls.push(o); }, connected: () => OTHER, isSame: same, api: () => fakeTxApi() } });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].action.key, 'staking.migrateCurrency');
        assert.equal(calls[0].button, button);
        assert.equal(typeof calls[0].verify, 'function');
        assert.equal(typeof calls[0].buildTx, 'function');
    });
    test('after inclusion it re-reads the locks: success says so and refreshes', async () => {
        const msg = msgEl(); let refreshed = 0;
        await runLockAction('migrate-currency', { model: orphanModel, address: ME, button: {}, msg,
            deps: { submit: async (o) => { await o.onSuccess(); }, connected: () => OTHER, isSame: same, api: () => fakeTxApi({ locksAfter: [] }), refresh: () => { refreshed++; } } });
        assert.match(msg.textContent, /gone/);
        assert.equal(refreshed, 1);
    });
    test('after inclusion with the lock still there: says so, not success', async () => {
        const msg = msgEl();
        const still = [{ id: 'staking ' }];
        await runLockAction('migrate-currency', { model: orphanModel, address: ME, button: {}, msg,
            deps: { submit: async (o) => { await o.onSuccess(); }, connected: () => OTHER, isSame: same, api: () => fakeTxApi({ locksAfter: still }) } });
        assert.match(msg.textContent, /still/);
        assert.match(msg.className, /error/);
    });
    test('a dispatch error is shown as the chain said it', async () => {
        const msg = msgEl();
        await runLockAction('migrate-currency', { model: orphanModel, address: ME, button: {}, msg,
            deps: { submit: async (o) => { o.onError(ERROR_COPY['staking.AlreadyMigrated']); }, connected: () => OTHER, isSame: same, api: () => fakeTxApi() } });
        assert.equal(msg.textContent, ERROR_COPY['staking.AlreadyMigrated']);
    });
    test('a refused spec never reaches submit', async () => {
        const msg = msgEl(); let submitted = 0;
        await runLockAction('migrate-currency', { model: orphanModel, address: ME, button: {}, msg,
            deps: { submit: async () => { submitted++; }, connected: () => null, isSame: same, api: () => fakeTxApi() } });
        assert.equal(submitted, 0);
        assert.match(msg.textContent, /[Cc]onnect/);
    });
});

describe('renderBalanceLocks: the release buttons', () => {
    const base = (over) => describeAccountLocks(snap(over));
    test('orphan: the button is on the public page too, labelled for anyone, fee refunded', () => {
        const html = renderBalanceLocks(base({ locks: [lock('staking ', 60n * PDEX)], frozen: s(60n * PDEX) }), { canSign: false });
        assert.match(html, /data-lock-action="migrate-currency"/);
        assert.match(html, /Remove leftover staking lock/);
        assert.match(html, /[Aa]nyone can submit this; the fee is refunded/);
    });
    const st = { bonded: true, total: s(30n * PDEX), active: s(10n * PDEX), unlocking: s(20n * PDEX),
        chunks: [{ value: s(15n * PDEX), era: 100 }, { value: s(5n * PDEX), era: 104 }], currentEra: 101, activeEra: 101, activeEraStart: Date.UTC(2026, 10, 5), spans: 0, controller: ME, stash: ME };
    test('withdraw: "Ready to withdraw" with the button for the owner, and the chunks still unbonding with a date', () => {
        const html = renderBalanceLocks(base({ staking: st, locks: [lock('staking ', 30n * PDEX)] }), { canSign: true });
        assert.match(html, /Ready to withdraw: 15 PDEX/);
        assert.match(html, /data-lock-action="withdraw"/);
        assert.match(html, /5 PDEX/);
        assert.match(html, /2026-11-08/, 'era 104 starts three eras after 2026-11-05');
    });
    test('withdraw: visitors see the amounts but no button', () => {
        const html = renderBalanceLocks(base({ staking: st, locks: [lock('staking ', 30n * PDEX)] }), { canSign: false });
        assert.match(html, /Ready to withdraw: 15 PDEX/);
        assert.doesNotMatch(html, /data-lock-action="withdraw"/);
    });
    test('democracy: "Remove votes and unlock" for the owner, cancel buttons for running referenda', () => {
        const html = renderBalanceLocks(base({ locks: [lock('democrac', 40n * PDEX)], frozen: s(40n * PDEX),
            democracy: { delegating: false, lockingPeriod: PERIOD, prior: { until: 0, amount: '0' },
                votes: [{ index: 4, aye: false, conviction: 'None', balance: s(40n * PDEX) }, { index: 9, aye: true, conviction: 'None', balance: s(10n * PDEX) }],
                referenda: { 4: { finished: true, approved: true, end: 900_000 }, 9: { ongoing: true, end: 1_100_000 } } } }), { canSign: true });
        assert.match(html, /data-lock-action="democracy-unlock"/);
        assert.match(html, /data-lock-action="democracy-cancel" data-ref="9"/);
        assert.match(html, /30 PDEX/, 'frees 40 - 10');
    });
    test('democracy: a running prior lock shows the date instead of a button', () => {
        const html = renderBalanceLocks(base({ locks: [lock('democrac', 40n * PDEX)], frozen: s(40n * PDEX),
            democracy: { delegating: false, lockingPeriod: PERIOD, prior: { until: BLOCK + 7200, amount: s(40n * PDEX) }, votes: [], referenda: {} } }), { canSign: true });
        assert.doesNotMatch(html, /data-lock-action="democracy-unlock"/);
        assert.match(html, /2026-11-06/);
    });
    test('council vote: "Remove council vote" for the owner', () => {
        const html = renderBalanceLocks(base({ locks: [lock('phrelect', 9n * PDEX)], elections: { voter: { votes: 2, stake: s(9n * PDEX), deposit: s(PDEX) }, candidacy: null } }), { canSign: true });
        assert.match(html, /data-lock-action="elections-remove"/);
        assert.match(html, /Remove council vote/);
    });
    test('delegating: an Undelegate button', () => {
        const html = renderBalanceLocks(base({ locks: [lock('democrac', 30n * PDEX)],
            democracy: { delegating: true, target: OTHER, conviction: 'Locked1x', balance: s(30n * PDEX), prior: { until: 0, amount: '0' }, lockingPeriod: PERIOD } }), { canSign: true });
        assert.match(html, /data-lock-action="democracy-undelegate"/);
    });
    test('a status line for the result of an action', () => {
        assert.match(renderBalanceLocks(base({}), { canSign: true }), /class="lock-actions-msg"[^>]*role="status"/);
    });
});

describe('readAccountLocks: the reads the buttons need', () => {
    const num = (n) => ({ toString: () => String(n), toNumber: () => Number(n) });
    const opt = (v) => ({ isSome: v != null, isNone: v == null, unwrap: () => v });
    function api({ ledger = null, controller = null, spans = null } = {}) {
        return {
            consts: { balances: { existentialDeposit: num(PDEX) }, staking: { bondingDuration: num(28), sessionsPerEra: num(6) },
                babe: { epochDuration: num(1200), expectedBlockTime: num(BLOCK_MS) }, democracy: { voteLockingPeriod: num(PERIOD) } },
            tx: {},
            query: {
                system: { account: async () => ({ data: { free: num(100n * PDEX), reserved: num(0), frozen: num(30n * PDEX) } }), number: async () => num(BLOCK) },
                balances: { locks: async () => [], freezes: async () => [], holds: async () => [], reserves: async () => [] },
                staking: {
                    bonded: async () => opt(controller), ledger: async () => opt(ledger),
                    currentEra: async () => opt(num(101)), activeEra: async () => opt({ index: num(100), start: opt(num(NOW - 3600000)) }),
                    slashingSpans: async () => opt(spans)
                }
            }
        };
    }
    test('chunks with their eras, CurrentEra, ActiveEra and its start, the era length, the spans count, controller and stash', async () => {
        const ledger = { stash: ME, total: num(30n * PDEX), active: num(10n * PDEX), unlocking: [{ value: num(20n * PDEX), era: num(105) }] };
        const snapshot = await readAccountLocks(api({ ledger, controller: ME, spans: { prior: [7] } }), ME);
        assert.deepEqual(snapshot.staking.chunks, [{ value: s(20n * PDEX), era: 105 }]);
        assert.equal(snapshot.staking.currentEra, 101);
        assert.equal(snapshot.staking.activeEra, 100);
        assert.equal(snapshot.staking.activeEraStart, NOW - 3600000);
        assert.equal(snapshot.staking.spans, 2);
        assert.equal(snapshot.staking.controller, ME);
        assert.equal(snapshot.staking.stash, ME);
        assert.equal(snapshot.eraMs, 6 * 1200 * BLOCK_MS);
        assert.equal(snapshot.address, ME);
        assert.equal(typeof snapshot.now, 'number');
    });
    test('not bonded: no era or spans reads are needed, and none fail the request', async () => {
        const a = api();
        a.query.staking.slashingSpans = async () => { throw new Error('should not matter'); };
        const snapshot = await readAccountLocks(a, ME);
        assert.deepEqual(snapshot.staking.chunks, []);
        assert.equal(snapshot.staking.spans, 0);
    });
    test('a referendum with no ReferendumInfoOf reads as cancelled', async () => {
        const a = api();
        a.query.democracy = {
            votingOf: async () => ({ isDirect: true, isDelegating: false, asDirect: { votes: [[num(3), { isStandard: true, asStandard: { vote: { isAye: true, conviction: { type: 'Locked1x' } }, balance: num(5n * PDEX) } }]], prior: [num(0), num(0)] } }),
            referendumInfoOf: async () => opt(null)
        };
        const snapshot = await readAccountLocks(a, ME);
        assert.deepEqual(snapshot.democracy.referenda[3], { cancelled: true });
    });
});

describe('GET /api/account/:address/locks carries the actions', () => {
    let server, base;
    before(async () => {
        const num = (n) => ({ toString: () => String(n), toNumber: () => Number(n) });
        const opt = (v) => ({ isSome: v != null, isNone: v == null, unwrap: () => v });
        const api = {
            consts: { balances: { existentialDeposit: num(PDEX) }, staking: { bondingDuration: num(28), sessionsPerEra: num(6) }, babe: { epochDuration: num(1200), expectedBlockTime: num(BLOCK_MS) } },
            tx: {},
            query: {
                system: { account: async () => ({ data: { free: num(100n * PDEX), reserved: num(0), frozen: num(60n * PDEX) } }), number: async () => num(BLOCK) },
                balances: { locks: async () => [{ id: { toU8a: () => new Uint8Array(Buffer.from('staking ')) }, amount: num(60n * PDEX), reasons: { type: 'All' } }], freezes: async () => [], holds: async () => [], reserves: async () => [] },
                staking: { bonded: async () => opt(null), ledger: async () => opt(null) }
            }
        };
        const app = express();
        registerBalanceLocksRoute(app, { api: () => api, ready: () => true, gate: (req) => ({ address: req.params.address }), cacheShort: (res) => res.set('Cache-Control', 'public, max-age=5'), serverError: (res) => res.status(500).json({}) });
        await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => { if (server) server.close(); });
    test('the orphan action names the stash', async () => {
        const body = await (await fetch(`${base}/api/account/${ME}/locks`)).json();
        assert.deepEqual(body.actions.orphan, { stash: ME, amount: s(60n * PDEX) });
        assert.equal(body.actions.withdraw, null);
    });
});

describe('the status card knows the new actions', () => {
    const KEYS = ['staking.migrateCurrency', 'democracy.unlock', 'democracy.removeVote', 'democracy.undelegate', 'elections.removeVoter'];
    test('each has a pending title and success copy with no dashes', () => {
        for (const k of KEYS) {
            assert.ok(ACTION_KEYS.includes(k), k);
            assert.ok(PENDING_TITLE[k], k);
            const c = successCopy(k, { freed: '5', n: 2, ref: 9, target: OTHER }, {});
            assert.ok(c.title && c.body, k);
            assert.ok(!/[–—]/.test(c.title + c.body + c.next), k);
        }
    });
    test('the errors these calls can return read as sentences', () => {
        for (const k of ['staking.AlreadyMigrated', 'staking.IncorrectSlashingSpans', 'democracy.NotVoter', 'democracy.NotDelegating', 'elections.MustBeVoter']) {
            assert.ok(ERROR_COPY[k], k);
            assert.ok(!/[–—]/.test(ERROR_COPY[k]), k);
        }
    });
});

describe('help: /help/locked-balance explains the buttons', () => {
    test('withdraw, unlock, remove council vote, and the leftover lock fix anyone can submit', () => {
        const t = HELP_TOPICS.find(x => x.slug === 'locked-balance');
        for (const w of ['Ready to withdraw', 'Remove votes and unlock', 'Remove council vote', 'Undelegate', 'Remove leftover staking lock', 'migrateCurrency', 'refunded', 'any account']) {
            assert.ok(t.body.includes(w), `article lacks "${w}"`);
        }
        assert.doesNotMatch(t.body, /preparing a fix/);
        assert.ok(!/[–—]/.test(t.body));
    });
});

const fx392 = loadFixture('metadata-392.json');
describe('spec 392 metadata: every call and storage item these buttons use exists, with the expected args', { skip: fx392 ? false : 'test/fixtures/metadata-392.json absent' }, () => {
    let registry;
    before(() => { registry = registryFromMetadata(fx392.metadata); });
    const pallet = (name) => registry.metadata.pallets.find(p => p.name.toString() === name);
    const callArgs = (p, call) => {
        const v = registry.lookup.getSiType(pallet(p).calls.unwrap().type).def.asVariant.variants.find(x => x.name.toString() === call);
        return v ? v.fields.map(f => `${f.name.toString()}:${registry.lookup.getTypeDef(f.type).type}`) : null;
    };
    const storage = (p, item) => pallet(p).storage.unwrap().items.find(i => i.name.toString() === item);
    test('calls', () => {
        assert.deepEqual(callArgs('Staking', 'withdraw_unbonded'), ['num_slashing_spans:u32']);
        assert.deepEqual(callArgs('Staking', 'migrate_currency'), ['stash:AccountId32']);
        assert.deepEqual(callArgs('Democracy', 'remove_vote'), ['index:u32']);
        assert.deepEqual(callArgs('Democracy', 'unlock'), ['target:MultiAddress']);
        assert.deepEqual(callArgs('Democracy', 'undelegate'), []);
        assert.deepEqual(callArgs('Elections', 'remove_voter'), []);
        assert.deepEqual(callArgs('Utility', 'batch_all'), ['calls:Vec<Call>']);
    });
    test('storage', () => {
        for (const [p, i] of [['Staking', 'SlashingSpans'], ['Staking', 'CurrentEra'], ['Staking', 'ActiveEra'], ['Staking', 'Ledger'], ['Staking', 'Bonded'],
            ['Democracy', 'VotingOf'], ['Democracy', 'ReferendumInfoOf'], ['Elections', 'Voting'], ['Balances', 'Locks']]) assert.ok(storage(p, i), `${p}.${i}`);
    });
    test('real codecs: ledger chunks with eras, SlashingSpans, ActiveEra decode into the snapshot', async () => {
        registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 88 }));
        const T = (p, item, v) => {
            const it = storage(p, item);
            const name = registry.createLookupType(it.type.isPlain ? it.type.asPlain : it.type.asMap.value);
            return it.modifier.isOptional ? registry.createType(`Option<${name}>`, v) : registry.createType(name, v);
        };
        const num = (n) => ({ toString: () => String(n) });
        const a = {
            consts: { balances: { existentialDeposit: num(PDEX) }, staking: { bondingDuration: num(28), sessionsPerEra: num(6) }, babe: { epochDuration: num(1200), expectedBlockTime: num(BLOCK_MS) } },
            tx: {},
            query: {
                system: { account: async () => T('System', 'Account', { data: { free: 100n * PDEX, frozen: 30n * PDEX } }), number: async () => T('System', 'Number', BLOCK) },
                balances: { locks: async () => T('Balances', 'Locks', []), freezes: async () => [], holds: async () => [], reserves: async () => [] },
                staking: {
                    bonded: async () => T('Staking', 'Bonded', ME),
                    ledger: async () => T('Staking', 'Ledger', { stash: ME, total: 30n * PDEX, active: 10n * PDEX, unlocking: [{ value: 20n * PDEX, era: 130 }], legacyClaimedRewards: [] }),
                    currentEra: async () => T('Staking', 'CurrentEra', 120),
                    activeEra: async () => T('Staking', 'ActiveEra', { index: 120, start: NOW }),
                    slashingSpans: async () => T('Staking', 'SlashingSpans', { spanIndex: 2, lastStart: 100, lastNonzeroSlash: 99, prior: [10, 20] })
                }
            }
        };
        const snapshot = await readAccountLocks(a, ME);
        assert.deepEqual(snapshot.staking.chunks, [{ value: s(20n * PDEX), era: 130 }]);
        assert.equal(snapshot.staking.spans, 3);
        assert.equal(snapshot.staking.activeEraStart, NOW);
        assert.equal(snapshot.staking.controller, ME);
        const m = describeAccountLocks(snapshot);
        assert.equal(m.actions.withdraw.pending[0].erasLeft, 10);
    });
});
