// Locked, reserved and transferable PDEX: the balance breakdown and the
// "why is it locked, how do I unlock it" table on the wallet dashboard and the
// account page (CEO request, Nov 2026: show it the way Nova Wallet does).
//
//   lib/balance-locks.js        pure: the breakdown math and the id mapping
//   lib/balance-locks-chain.js  the chain reads, turned into a plain snapshot
//   lib/balance-locks-api.js    GET /api/account/:address/locks
//   lib/balance-locks-view.js   the HTML both pages render
//
// The breakdown follows the same rule as lib/fee-preflight.js (the transfer
// amount after the fee): untouchable = frozen - reserved (saturating), at least
// the existential deposit for a keep-alive transfer. A cross-check below runs
// the breakdown through feeShortfall so the two can never drift apart.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
    balanceBreakdown, lockIdText, describeAccountLocks, democracyLockPlan, blocksToDays, LOCK_HELP_SLUG
} from '../lib/balance-locks.js';
import { readAccountLocks } from '../lib/balance-locks-chain.js';
import { registerBalanceLocksRoute, LOCKS_ROUTE } from '../lib/balance-locks-api.js';
import { renderBalanceLocks, mountBalanceLocks } from '../lib/balance-locks-view.js';
import { feeShortfall } from '../lib/fee-preflight.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { allRoutes } from '../lib/api-reference.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';

const PDEX = 10n ** 12n;
const ED = 1n * PDEX;
const P = (n) => BigInt(Math.round(n * 1e4)) * (PDEX / 10000n);   // PDEX (4 dp) to planck
const s = (v) => v.toString();
const BLOCK_MS = 12000;

// A made-up account, not a real one (public repo).
const ME = 'esm9mgCefMrQ2EbGGyMNXGAFA3vnRGDid7GheURpcFRTjyokX';   // 0x11..11
const OTHER = 'esmY9ZU5xPLb8urxWNBq89tPvEAG3CZm4KboeysfVgQuEw1io'; // 0x22..22

function snap(over = {}) {
    return {
        free: s(100n * PDEX), reserved: '0', frozen: '0', ed: s(ED),
        block: 1_000_000, blockMs: BLOCK_MS, bondingDays: 28,
        locks: [], freezes: [], holds: [], reserves: [],
        staking: { bonded: false, total: '0', active: '0', unlocking: '0' },
        democracy: null, elections: null, identity: null, proxy: null,
        pallets: { vesting: false, ormlVesting: false },
        ...over
    };
}
const item = (model, pred) => model.items.find(pred);

describe('balanceBreakdown: Total, Transferable, Locked, Reserved', () => {
    test('nothing locked: transferable is free minus the existential deposit', () => {
        const b = balanceBreakdown({ free: 100n * PDEX, reserved: 0n, frozen: 0n, ed: ED });
        assert.equal(b.total, 100n * PDEX);
        assert.equal(b.transferable, 99n * PDEX);
        assert.equal(b.locked, 0n);
        assert.equal(b.reserved, 0n);
        assert.equal(b.edWithheld, ED, 'the ED is what keeps the last PDEX back');
    });
    test('the real orphan case: free 29,865.4975, frozen 29,245.5 -> 619.9975 transferable, no ED withheld', () => {
        const b = balanceBreakdown({ free: P(29865.4975), reserved: 0n, frozen: P(29245.5), ed: ED });
        assert.equal(b.total, P(29865.4975));
        assert.equal(b.locked, P(29245.5));
        assert.equal(b.transferable, P(619.9975));
        assert.equal(b.edWithheld, 0n, 'the lock already covers the ED');
    });
    test('a lock smaller than the ED: the ED applies, not the lock', () => {
        const b = balanceBreakdown({ free: 10n * PDEX, reserved: 0n, frozen: PDEX / 2n, ed: ED });
        assert.equal(b.transferable, 9n * PDEX);
        assert.equal(b.edWithheld, PDEX / 2n, 'only the part of the ED the lock does not already cover');
    });
    test('reserved PDEX counts toward a freeze (fungible rule): free 100, reserved 50, frozen 80 -> 70', () => {
        const b = balanceBreakdown({ free: 100n * PDEX, reserved: 50n * PDEX, frozen: 80n * PDEX, ed: ED });
        assert.equal(b.total, 150n * PDEX);
        assert.equal(b.transferable, 70n * PDEX);
    });
    test('frozen above free: transferable is zero, never negative', () => {
        const b = balanceBreakdown({ free: 5n * PDEX, reserved: 0n, frozen: 8n * PDEX, ed: ED });
        assert.equal(b.transferable, 0n);
    });
    test('accepts decimal strings and codec-like values', () => {
        const b = balanceBreakdown({ free: '2000000000000', reserved: { toString: () => '0' }, frozen: '0', ed: s(ED) });
        assert.equal(b.transferable, PDEX);
    });
    test('agrees with lib/fee-preflight.js: transferable is exactly the largest keep-alive amount (fee 0)', () => {
        const cases = [
            { free: 100n * PDEX, reserved: 0n, frozen: 0n },
            { free: P(29865.4975), reserved: 0n, frozen: P(29245.5) },
            { free: 100n * PDEX, reserved: 50n * PDEX, frozen: 80n * PDEX },
            { free: 10n * PDEX, reserved: 0n, frozen: PDEX / 2n }
        ];
        for (const c of cases) {
            const b = balanceBreakdown({ ...c, ed: ED });
            assert.equal(feeShortfall({ fee: 0n, amount: b.transferable, keepAlive: true, ...c, ed: ED }), null, JSON.stringify(c, (k, v) => typeof v === 'bigint' ? v.toString() : v));
            assert.notEqual(feeShortfall({ fee: 0n, amount: b.transferable + 1n, keepAlive: true, ...c, ed: ED }), null);
        }
    });
});

describe('lockIdText', () => {
    test('8 ASCII bytes become the id string, padding kept', () => {
        assert.equal(lockIdText([0x73, 0x74, 0x61, 0x6b, 0x69, 0x6e, 0x67, 0x20]), 'staking ');
        assert.equal(lockIdText('0x' + Buffer.from('democrac').toString('hex')), 'democrac');
        assert.equal(lockIdText(new Uint8Array(Buffer.from('phrelect'))), 'phrelect');
    });
    test('non-printable bytes stay hex', () => {
        assert.equal(lockIdText([0, 1, 2, 3, 4, 5, 6, 255]), '0x00010203040506ff');
    });
    test('a plain string passes through', () => {
        assert.equal(lockIdText('vesting '), 'vesting ');
    });
});

describe('describeAccountLocks: one row per lock, freeze, hold and deposit', () => {
    test('legacy "staking " lock on a bonded account: staked, unstake and wait the unbonding period', () => {
        const m = describeAccountLocks(snap({
            frozen: s(50n * PDEX), locks: [{ id: 'staking ', amount: s(50n * PDEX), reasons: 'All' }],
            staking: { bonded: true, total: s(50n * PDEX), active: s(50n * PDEX), unlocking: '0' }
        }));
        const r = item(m, i => i.id === 'staking ');
        assert.equal(r.kind, 'lock');
        assert.equal(r.status, 'active');
        assert.equal(r.amount, s(50n * PDEX));
        assert.match(r.reason, /[Ss]taked/);
        assert.match(r.unlock, /[Uu]nstake/);
        assert.match(r.unlock, /28 days/);
        assert.match(r.unlock, /withdraw/i);
    });
    test('orphan: "staking " lock with no bond and no ledger is flagged, with the help link, and no fix promised by date', () => {
        const m = describeAccountLocks(snap({
            free: s(P(29865.4975)), frozen: s(P(29245.5)),
            locks: [{ id: 'staking ', amount: s(P(29245.5)), reasons: 'All' }]
        }));
        const r = item(m, i => i.id === 'staking ');
        assert.equal(r.status, 'orphan');
        assert.match(r.reason, /[Ll]eftover staking lock/);
        assert.match(r.reason, /392/);
        assert.match(r.unlock, /cannot be removed by you today/);
        assert.match(r.unlock, /preparing a fix/);
        assert.equal(r.link.href, `/help/${LOCK_HELP_SLUG}`);
        assert.equal(m.balance.transferable, s(P(619.9975)));
        assert.equal(m.balance.locked, s(P(29245.5)));
        assert.equal(m.orphanStaking, true);
    });
    test('unbonding chunks are mentioned on a bonded account', () => {
        const m = describeAccountLocks(snap({
            frozen: s(50n * PDEX), locks: [{ id: 'staking ', amount: s(50n * PDEX), reasons: 'All' }],
            staking: { bonded: true, total: s(50n * PDEX), active: s(30n * PDEX), unlocking: s(20n * PDEX) }
        }));
        assert.match(item(m, i => i.id === 'staking ').unlock, /20 PDEX is already unbonding/);
    });
    test('hold with the Staking reason (staked via hold on 392): same unstake guidance', () => {
        const m = describeAccountLocks(snap({
            reserved: s(40n * PDEX), holds: [{ id: 'Staking.Staking', amount: s(40n * PDEX) }],
            staking: { bonded: true, total: s(40n * PDEX), active: s(40n * PDEX), unlocking: '0' }
        }));
        const r = item(m, i => i.kind === 'hold');
        assert.equal(r.status, 'active');
        assert.match(r.source, /Staking/);
        assert.match(r.unlock, /[Uu]nstake/);
        assert.match(r.unlock, /28 days/);
    });
    test('a Staking hold with no ledger is flagged, not explained as staked', () => {
        const m = describeAccountLocks(snap({ reserved: s(40n * PDEX), holds: [{ id: 'Staking.Staking', amount: s(40n * PDEX) }] }));
        const r = item(m, i => i.kind === 'hold');
        assert.equal(r.status, 'orphan');
        assert.doesNotMatch(r.unlock, /[Uu]nstake from/);
    });
    test('"democrac": democracy vote lock, lists the referenda, unlock via removeVote then unlock', () => {
        const m = describeAccountLocks(snap({
            frozen: s(10n * PDEX), locks: [{ id: 'democrac', amount: s(10n * PDEX), reasons: 'All' }],
            democracy: { delegating: false, lockingPeriod: 216000,
                votes: [{ index: 7, aye: true, conviction: 'Locked1x', balance: s(10n * PDEX) }],
                prior: { until: 0, amount: '0' },
                referenda: { 7: { finished: true, approved: true, end: 900_000 } } }
        }));
        const r = item(m, i => i.id === 'democrac');
        assert.match(r.source, /[Dd]emocracy/);
        assert.match(r.reason, /vote/);
        assert.match(r.unlock, /democracy\.removeVote/);
        assert.match(r.unlock, /democracy\.unlock/);
        assert.deepEqual(r.refs.map(x => x.index), [7]);
        assert.equal(r.refs[0].href, '/democracy/referendum/7');
    });
    test('"phrelect": council election vote, remove the vote; the voting deposit is its own row', () => {
        const m = describeAccountLocks(snap({
            frozen: s(25n * PDEX), reserved: s(PDEX), locks: [{ id: 'phrelect', amount: s(25n * PDEX), reasons: 'All' }],
            elections: { voter: { stake: s(25n * PDEX), deposit: s(PDEX), votes: 3 }, candidacy: null }
        }));
        const r = item(m, i => i.id === 'phrelect');
        assert.match(r.source, /[Cc]ouncil/);
        assert.match(r.reason, /3 candidates/);
        assert.match(r.unlock, /removeVoter/);
        const d = item(m, i => i.kind === 'deposit' && /voting deposit/i.test(i.source));
        assert.equal(d.amount, s(PDEX));
        assert.equal(m.unattributedReserved, '0');
    });
    test('"vesting " with a vesting pallet: vest() as it unlocks', () => {
        const m = describeAccountLocks(snap({ frozen: s(5n * PDEX), locks: [{ id: 'vesting ', amount: s(5n * PDEX), reasons: 'Misc' }], pallets: { vesting: true, ormlVesting: false } }));
        const r = item(m, i => i.id === 'vesting ');
        assert.equal(r.status, 'active');
        assert.match(r.unlock, /vest\(\)/);
    });
    test('"vesting " without a vesting pallet (392 has none): legacy, cannot vest()', () => {
        const m = describeAccountLocks(snap({ frozen: s(5n * PDEX), locks: [{ id: 'vesting ', amount: s(5n * PDEX), reasons: 'Misc' }] }));
        const r = item(m, i => i.id === 'vesting ');
        assert.equal(r.status, 'legacy');
        assert.doesNotMatch(r.unlock, /^Call vesting/);
    });
    for (const id of ['ormlvest', 'pdexlock', 'pdexmigr', 'REWARDID']) {
        test(`legacy id "${id}": a module removed at 392, said so, not removable by the user`, () => {
            const m = describeAccountLocks(snap({ frozen: s(PDEX), locks: [{ id, amount: s(PDEX), reasons: 'All' }] }));
            const r = item(m, i => i.id === id);
            assert.equal(r.status, 'legacy');
            assert.match(r.reason, /392/);
            assert.match(r.unlock, /cannot remove it yourself/);
        });
    }
    test('an unknown lock id is shown raw as "unknown lock"', () => {
        const m = describeAccountLocks(snap({ frozen: s(PDEX), locks: [{ id: 'mystery1', amount: s(PDEX), reasons: 'All' }] }));
        const r = item(m, i => i.id === 'mystery1');
        assert.equal(r.status, 'unknown');
        assert.match(r.source, /[Uu]nknown lock/);
        assert.match(r.reason, /mystery1/);
    });
    test('holds: preimage, council motion, session keys, delegated staking, unknown', () => {
        const holds = [
            { id: 'Preimage.Preimage', amount: s(PDEX) },
            { id: 'Council.ProposalSubmission', amount: s(PDEX) },
            { id: 'Session.Keys', amount: s(PDEX) },
            { id: 'DelegatedStaking.StakingDelegation', amount: s(PDEX) },
            { id: 'Weird.Thing', amount: s(PDEX) }
        ];
        const m = describeAccountLocks(snap({ reserved: s(5n * PDEX), holds }));
        assert.match(item(m, i => i.id === 'Preimage.Preimage').unlock, /unnotePreimage/);
        assert.match(item(m, i => i.id === 'Council.ProposalSubmission').unlock, /releaseProposalCost/);
        assert.match(item(m, i => i.id === 'Session.Keys').unlock, /purgeKeys/);
        assert.match(item(m, i => i.id === 'DelegatedStaking.StakingDelegation').source, /[Dd]elegat/);
        assert.equal(item(m, i => i.id === 'Weird.Thing').status, 'unknown');
        assert.equal(m.unattributedReserved, '0', 'holds are part of reserved');
    });
    test('deposits: identity, sub-identities, proxies, council candidacy; the rest is unattributed', () => {
        const m = describeAccountLocks(snap({
            reserved: s(20n * PDEX),
            identity: { deposit: s(3n * PDEX), subsDeposit: s(2n * PDEX), subs: 1 },
            proxy: { deposit: s(4n * PDEX), count: 2, announcementDeposit: '0' },
            elections: { voter: null, candidacy: { role: 'Candidate', deposit: s(5n * PDEX) } }
        }));
        assert.match(item(m, i => /^Identity/.test(i.source)).unlock, /[Cc]lear/);
        assert.match(item(m, i => /[Ss]ub-identit/.test(i.source)).reason, /1 sub-account/);
        assert.match(item(m, i => /[Pp]rox/.test(i.source)).reason, /2 proxies/);
        assert.match(item(m, i => /[Cc]andidacy/.test(i.source)).unlock, /[Ww]ithdraw/);
        assert.equal(m.unattributedReserved, s(6n * PDEX));
        const other = item(m, i => i.kind === 'deposit' && i.status === 'unknown');
        assert.equal(other.amount, s(6n * PDEX));
        assert.match(other.reason, /multisig/);
    });
    test('named reserves are rows of their own', () => {
        const m = describeAccountLocks(snap({ reserved: s(PDEX), reserves: [{ id: 'somerese', amount: s(PDEX) }] }));
        assert.equal(item(m, i => i.kind === 'reserve').id, 'somerese');
        assert.equal(m.unattributedReserved, '0');
    });
    test('locks overlap: frozen is the largest lock, not the sum, and the model says so', () => {
        const m = describeAccountLocks(snap({
            frozen: s(60n * PDEX),
            locks: [{ id: 'staking ', amount: s(60n * PDEX), reasons: 'All' }, { id: 'democrac', amount: s(40n * PDEX), reasons: 'All' }],
            staking: { bonded: true, total: s(60n * PDEX), active: s(60n * PDEX), unlocking: '0' }
        }));
        assert.equal(m.overlap, true);
        assert.equal(m.balance.locked, s(60n * PDEX));
        assert.equal(m.balance.transferable, s(40n * PDEX));
        assert.equal(describeAccountLocks(snap({ frozen: s(PDEX), locks: [{ id: 'democrac', amount: s(PDEX), reasons: 'All' }] })).overlap, false);
    });
    test('an account with nothing locked has no rows', () => {
        const m = describeAccountLocks(snap());
        assert.deepEqual(m.items, []);
        assert.equal(m.balance.transferable, s(99n * PDEX));
        assert.equal(m.balance.ed, s(ED));
    });
});

describe('democracyLockPlan: when the democracy lock can come off', () => {
    const base = { delegating: false, lockingPeriod: 216000, prior: { until: 0, amount: '0' } };
    test('won with conviction: locked until end + periods x lockingPeriod', () => {
        const p = democracyLockPlan({ ...base, votes: [{ index: 1, aye: true, conviction: 'Locked2x', balance: s(PDEX) }],
            referenda: { 1: { finished: true, approved: true, end: 1000 } } }, 2000);
        assert.equal(p.refs[0].unlockAt, 1000 + 2 * 216000);
        assert.equal(p.unlockAt, 1000 + 2 * 216000);
        assert.equal(p.canUnlockNow, false);
    });
    test('lost, or no conviction: no lock after the end', () => {
        const p = democracyLockPlan({ ...base, votes: [
            { index: 1, aye: false, conviction: 'Locked6x', balance: s(PDEX) },
            { index: 2, aye: true, conviction: 'None', balance: s(PDEX) }],
            referenda: { 1: { finished: true, approved: true, end: 1000 }, 2: { finished: true, approved: true, end: 1500 } } }, 2000);
        assert.equal(p.refs[0].unlockAt, 1000);
        assert.equal(p.refs[1].unlockAt, 1500);
        assert.equal(p.canUnlockNow, true);
    });
    test('an ongoing referendum blocks the unlock', () => {
        const p = democracyLockPlan({ ...base, votes: [{ index: 3, aye: true, conviction: 'Locked1x', balance: s(PDEX) }],
            referenda: { 3: { ongoing: true, end: 5000 } } }, 2000);
        assert.equal(p.ongoing, true);
        assert.equal(p.canUnlockNow, false);
    });
    test('a prior lock (vote already removed) counts', () => {
        const p = democracyLockPlan({ ...base, votes: [], prior: { until: 9000, amount: s(PDEX) }, referenda: {} }, 2000);
        assert.equal(p.unlockAt, 9000);
        assert.equal(p.canUnlockNow, false);
        assert.equal(democracyLockPlan({ ...base, votes: [], prior: { until: 1000, amount: s(PDEX) }, referenda: {} }, 2000).canUnlockNow, true);
    });
    test('delegating: undelegate first', () => {
        const p = democracyLockPlan({ delegating: true, target: OTHER, conviction: 'Locked3x', balance: s(PDEX), prior: { until: 0, amount: '0' } }, 2000);
        assert.equal(p.mode, 'delegating');
        const m = describeAccountLocks(snap({ frozen: s(PDEX), locks: [{ id: 'democrac', amount: s(PDEX), reasons: 'All' }],
            democracy: { delegating: true, target: OTHER, conviction: 'Locked3x', balance: s(PDEX), prior: { until: 0, amount: '0' }, lockingPeriod: 216000 } }));
        assert.match(item(m, i => i.id === 'democrac').unlock, /undelegate/);
    });
    test('no current block (system.number failed): no made-up "locked until" day count', () => {
        const m = describeAccountLocks(snap({ block: null, frozen: s(PDEX), locks: [{ id: 'democrac', amount: s(PDEX), reasons: 'All' }],
            democracy: { ...base, votes: [{ index: 1, aye: true, conviction: 'Locked1x', balance: s(PDEX) }], referenda: { 1: { finished: true, approved: true, end: 1000 } } } }));
        const r = item(m, i => i.id === 'democrac');
        assert.doesNotMatch(r.unlock, /days/);
        assert.match(r.unlock, /democracy\.unlock/);
    });
    test('only a prior lock, expired: just democracy.unlock, no "remove each vote"', () => {
        const m = describeAccountLocks(snap({ frozen: s(PDEX), locks: [{ id: 'democrac', amount: s(PDEX), reasons: 'All' }],
            democracy: { ...base, votes: [], prior: { until: 10, amount: s(PDEX) }, referenda: {} } }));
        const r = item(m, i => i.id === 'democrac');
        assert.match(r.unlock, /democracy\.unlock/);
        assert.doesNotMatch(r.unlock, /removeVote/);
    });
    test('blocksToDays', () => {
        assert.equal(blocksToDays(7200, 12000), 1);
        assert.equal(blocksToDays(216000 * 2, 12000), 60);
        assert.equal(blocksToDays(0, 12000), 0);
    });
});

describe('renderBalanceLocks: the panel', () => {
    const help = (slug, label) => `<a href="/help/${slug}" title="${label.replace(/"/g, '&quot;')}">?</a>`;
    test('the four figures, each with a "?", and the ED note', () => {
        const html = renderBalanceLocks(describeAccountLocks(snap()), { helpIcon: help });
        for (const label of ['Total', 'Transferable', 'Locked', 'Reserved']) assert.match(html, new RegExp(label));
        assert.equal((html.match(/href="\/help\/locked-balance"/g) || []).length >= 4, true);
        assert.match(html, /existential deposit/);
        assert.match(html, /99 PDEX/);
    });
    test('the orphan row is shown with its warning and the help link', () => {
        const html = renderBalanceLocks(describeAccountLocks(snap({
            free: s(P(29865.4975)), frozen: s(P(29245.5)), locks: [{ id: 'staking ', amount: s(P(29245.5)), reasons: 'All' }]
        })), { helpIcon: help });
        assert.match(html, /29,245\.5 PDEX/);
        assert.match(html, /619\.9975 PDEX/);
        assert.match(html, /cannot be removed by you today/);
        assert.match(html, /href="\/help\/locked-balance"/);
    });
    test('the overlap note appears when two locks overlap', () => {
        const html = renderBalanceLocks(describeAccountLocks(snap({
            frozen: s(60n * PDEX),
            locks: [{ id: 'staking ', amount: s(60n * PDEX), reasons: 'All' }, { id: 'democrac', amount: s(40n * PDEX), reasons: 'All' }],
            staking: { bonded: true, total: s(60n * PDEX), active: s(60n * PDEX), unlocking: '0' }
        })), { helpIcon: help });
        assert.match(html, /[Ll]ocks overlap; the largest one applies/);
    });
    test('escaping: a hostile lock or hold id cannot inject markup', () => {
        const evil = '<img src=x onerror=alert(1)>';
        const html = renderBalanceLocks(describeAccountLocks(snap({
            frozen: s(PDEX), reserved: s(PDEX),
            locks: [{ id: evil, amount: s(PDEX), reasons: 'All' }],
            holds: [{ id: `"><script>x</script>`, amount: s(PDEX) }]
        })), { helpIcon: help });
        assert.ok(!html.includes('<img'), 'raw <img> in output');
        assert.ok(!html.includes('<script>'), 'raw <script> in output');
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    });
    test('no rows: says nothing is locked', () => {
        assert.match(renderBalanceLocks(describeAccountLocks(snap()), { helpIcon: help }), /[Nn]othing is locked/);
    });
    test('no em or en dashes in anything the panel can print', () => {
        const all = [
            describeAccountLocks(snap({ frozen: s(PDEX), locks: ['staking ', 'democrac', 'phrelect', 'vesting ', 'ormlvest', 'pdexlock', 'REWARDID', 'zzz'].map(id => ({ id, amount: s(PDEX), reasons: 'All' })),
                reserved: s(9n * PDEX), holds: ['Staking.Staking', 'Preimage.Preimage', 'Council.ProposalSubmission', 'Session.Keys', 'DelegatedStaking.StakingDelegation', 'SafeMode.EnterOrExtend', 'X.Y'].map(id => ({ id, amount: s(PDEX) })),
                identity: { deposit: s(PDEX), subsDeposit: s(PDEX), subs: 2 }, proxy: { deposit: s(PDEX), count: 1, announcementDeposit: s(PDEX) },
                elections: { voter: { stake: s(PDEX), deposit: s(PDEX), votes: 1 }, candidacy: { role: 'Member', deposit: s(PDEX) } } }))
        ];
        const html = all.map(m => renderBalanceLocks(m, { helpIcon: help })).join('');
        assert.ok(!/[–—]/.test(html), 'em or en dash in the rendered panel');
        assert.ok(!/[–—]/.test(readRepo('lib/balance-locks.js', import.meta.url)));
        assert.ok(!/[–—]/.test(readRepo('lib/balance-locks-view.js', import.meta.url)));
    });
});

describe('mountBalanceLocks: one server call per account', () => {
    test('fetches /api/account/<addr>/locks once and renders into the slot', async () => {
        const el = { innerHTML: '', isConnected: true };
        const urls = [];
        const model = { address: ME, ...describeAccountLocks(snap()) };
        await mountBalanceLocks(el, ME, { fetchJson: async (u) => { urls.push(u); return model; }, helpIcon: () => '' });
        assert.deepEqual(urls, [`/api/account/${encodeURIComponent(ME)}/locks`]);
        assert.match(el.innerHTML, /Transferable/);
    });
    test('a failed fetch leaves a short note, not a stack trace', async () => {
        const el = { innerHTML: '', isConnected: true };
        await mountBalanceLocks(el, ME, { fetchJson: async () => { throw new Error('boom <b>'); }, helpIcon: () => '' });
        assert.match(el.innerHTML, /[Cc]ould not load/);
        assert.ok(!el.innerHTML.includes('<b>'));
    });
    test('no slot: does nothing', async () => {
        await mountBalanceLocks(null, ME, { fetchJson: async () => { throw new Error('should not be called'); } });
    });
});

// A fake api in the polkadot.js shape, hand-built (always runs).
function fakeApi(over = {}) {
    const id = (str) => ({ toU8a: () => new Uint8Array(Buffer.from(str)) });
    const opt = (v) => ({ isSome: v != null, isNone: v == null, unwrap: () => v });
    const num = (n) => ({ toString: () => String(n) });
    const ledger = over.ledger === undefined ? null : over.ledger;
    return {
        isConnected: true,
        consts: {
            balances: { existentialDeposit: num(ED) },
            staking: { bondingDuration: num(28), sessionsPerEra: num(6) },
            babe: { epochDuration: num(1200), expectedBlockTime: num(BLOCK_MS) },
            democracy: { voteLockingPeriod: num(216000) }
        },
        tx: {},
        query: {
            system: {
                account: async () => ({ data: { free: num(over.free ?? P(29865.4975)), reserved: num(over.reserved ?? 0n), frozen: num(over.frozen ?? P(29245.5)) } }),
                number: async () => num(1_000_000)
            },
            balances: {
                locks: async () => (over.locks || [{ id: id('staking '), amount: num(P(29245.5)), reasons: { type: 'All' } }]),
                freezes: async () => [],
                holds: async () => (over.holds || []),
                reserves: async () => []
            },
            staking: {
                bonded: async () => opt(ledger ? ME : null),
                ledger: async () => opt(ledger)
            },
            identity: { identityOf: async () => opt(null), subsOf: async () => [num(0), []] },
            proxy: { proxies: async () => [[], num(0)], announcements: async () => [[], num(0)] },
            elections: { voting: async () => ({ votes: [], stake: num(0), deposit: num(0) }), candidates: async () => [], members: async () => [], runnersUp: async () => [] },
            democracy: { votingOf: async () => ({ isDirect: true, isDelegating: false, asDirect: { votes: [], prior: [num(0), num(0)] } }) }
        }
    };
}

describe('readAccountLocks: chain reads to a plain snapshot (hand-built api)', () => {
    test('the orphan case reads as: lock present, not bonded', async () => {
        const snapshot = await readAccountLocks(fakeApi(), ME);
        assert.equal(snapshot.free, s(P(29865.4975)));
        assert.equal(snapshot.frozen, s(P(29245.5)));
        assert.equal(snapshot.ed, s(ED));
        assert.deepEqual(snapshot.locks, [{ id: 'staking ', amount: s(P(29245.5)), reasons: 'All' }]);
        assert.equal(snapshot.staking.bonded, false);
        assert.equal(snapshot.bondingDays, 28);
        assert.equal(snapshot.block, 1_000_000);
        assert.equal(describeAccountLocks(snapshot).items[0].status, 'orphan');
    });
    test('a bonded account reads its ledger', async () => {
        const num = (n) => ({ toString: () => String(n) });
        const snapshot = await readAccountLocks(fakeApi({ ledger: { total: num(50n * PDEX), active: num(30n * PDEX), unlocking: [{ value: num(20n * PDEX), era: num(9) }] } }), ME);
        assert.equal(snapshot.staking.bonded, true);
        assert.equal(snapshot.staking.unlocking, s(20n * PDEX));
    });
    test('a missing pallet is skipped, not an error', async () => {
        const api = fakeApi();
        delete api.query.democracy; delete api.query.elections; delete api.query.identity; delete api.query.proxy; delete api.query.balances.holds;
        const snapshot = await readAccountLocks(api, ME);
        assert.equal(snapshot.democracy, null);
        assert.deepEqual(snapshot.holds, []);
    });
});

const fx392 = loadFixture('metadata-392.json');
describe('readAccountLocks on real spec 392 codecs', { skip: fx392 ? false : 'test/fixtures/metadata-392.json absent' }, () => {
    test('locks, holds, ledger, votingOf, elections and identity decode through the real types', async () => {
        const registry = registryFromMetadata(fx392.metadata);
        registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 88 }));
        const T = (pallet, item, v) => {
            const p = registry.metadata.pallets.find(x => x.name.toString() === pallet);
            const it = p.storage.unwrap().items.find(i => i.name.toString() === item);
            const name = registry.createLookupType(it.type.isPlain ? it.type.asPlain : it.type.asMap.value);
            return it.modifier.isOptional ? registry.createType(`Option<${name}>`, v) : registry.createType(name, v);
        };
        const api = {
            consts: fakeApi().consts, tx: {},
            query: {
                system: {
                    account: async () => T('System', 'Account', { data: { free: 100n * PDEX, reserved: 7n * PDEX, frozen: 60n * PDEX } }),
                    number: async () => T('System', 'Number', 2000)
                },
                balances: {
                    locks: async () => T('Balances', 'Locks', [
                        { id: '0x' + Buffer.from('staking ').toString('hex'), amount: 60n * PDEX, reasons: 'All' },
                        { id: '0x' + Buffer.from('democrac').toString('hex'), amount: 40n * PDEX, reasons: 'All' }]),
                    freezes: async () => T('Balances', 'Freezes', []),
                    holds: async () => T('Balances', 'Holds', [{ id: { Preimage: 'Preimage' }, amount: 2n * PDEX }]),
                    reserves: async () => T('Balances', 'Reserves', [])
                },
                staking: {
                    bonded: async () => T('Staking', 'Bonded', null),
                    ledger: async () => T('Staking', 'Ledger', null)
                },
                democracy: {
                    votingOf: async () => T('Democracy', 'VotingOf', { Direct: { votes: [[4, { Standard: { vote: { aye: true, conviction: 'Locked1x' }, balance: 40n * PDEX } }]],
                        delegations: { votes: 0, capital: 0 }, prior: [0, 0] } }),
                    referendumInfoOf: async (i) => T('Democracy', 'ReferendumInfoOf', { Finished: { approved: true, end: 1500 } })
                },
                elections: {
                    voting: async () => T('Elections', 'Voting', { votes: [], stake: 0, deposit: 0 }),
                    candidates: async () => T('Elections', 'Candidates', [[ME, 5n * PDEX]]),
                    members: async () => T('Elections', 'Members', []),
                    runnersUp: async () => T('Elections', 'RunnersUp', [])
                },
                identity: {
                    identityOf: async () => T('Identity', 'IdentityOf', null),
                    subsOf: async () => T('Identity', 'SubsOf', [0, []])
                },
                proxy: {
                    proxies: async () => T('Proxy', 'Proxies', [[], 0]),
                    announcements: async () => T('Proxy', 'Announcements', [[], 0])
                }
            }
        };
        const snapshot = await readAccountLocks(api, ME);
        assert.deepEqual(snapshot.locks.map(l => [l.id, l.amount, l.reasons]), [['staking ', s(60n * PDEX), 'All'], ['democrac', s(40n * PDEX), 'All']]);
        assert.deepEqual(snapshot.holds, [{ id: 'Preimage.Preimage', amount: s(2n * PDEX) }]);
        assert.equal(snapshot.staking.bonded, false);
        assert.deepEqual(snapshot.democracy.votes, [{ index: 4, aye: true, conviction: 'Locked1x', balance: s(40n * PDEX) }]);
        assert.deepEqual(snapshot.democracy.referenda[4], { finished: true, approved: true, end: 1500 });
        assert.deepEqual(snapshot.elections.candidacy, { role: 'Candidate', deposit: s(5n * PDEX) });
        const m = describeAccountLocks(snapshot);
        assert.equal(m.overlap, true);
        assert.equal(item(m, i => i.id === 'staking ').status, 'orphan');
        assert.equal(m.unattributedReserved, '0', '2 held + 5 candidacy = 7 reserved');
    });
});

describe(`GET ${'/api/account/:address/locks'}`, () => {
    let server, base, api, ready = true;
    const SHORT = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
    before(async () => {
        api = fakeApi();
        const app = express();
        registerBalanceLocksRoute(app, {
            api: () => api,
            ready: (res) => { if (ready) return true; res.set('Cache-Control', 'no-store'); res.status(503).json({ code: 'RPC_NOT_READY' }); return false; },
            gate: (req, res) => { if (!/^e[1-9A-HJ-NP-Za-km-z]{40,}$/.test(req.params.address)) { res.status(400).json({ error: 'Invalid Polkadex address.' }); return null; } return { address: req.params.address }; },
            cacheShort: (res) => res.set('Cache-Control', SHORT),
            serverError: (res) => { res.set('Cache-Control', 'no-store'); res.status(500).json({ error: 'Internal error.' }); }
        });
        await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => { if (server) server.close(); });
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }; };

    test('the route path constant', () => assert.equal(LOCKS_ROUTE, '/api/account/:address/locks'));
    test('200: the model, short cache tier', async () => {
        const r = await get(`/api/account/${ME}/locks`);
        assert.equal(r.status, 200);
        assert.equal(r.cache, SHORT);
        assert.equal(r.body.address, ME);
        assert.equal(r.body.balance.transferable, s(P(619.9975)));
        assert.equal(r.body.items[0].status, 'orphan');
        assert.equal(r.body.block, 1_000_000);
    });
    test('400 on a bad address', async () => {
        assert.equal((await get('/api/account/not-an-address/locks')).status, 400);
    });
    test('503 when the node is not connected', async () => {
        ready = false;
        try { const r = await get(`/api/account/${ME}/locks`); assert.equal(r.status, 503); assert.equal(r.cache, 'no-store'); }
        finally { ready = true; }
    });
    test('500 no-store when a chain read fails', async () => {
        const saved = api.query.system.account;
        api.query.system.account = async () => { throw new Error('rpc gone'); };
        try { const r = await get(`/api/account/${ME}/locks`); assert.equal(r.status, 500); assert.equal(r.cache, 'no-store'); }
        finally { api.query.system.account = saved; }
    });
});

describe('wiring: server, docs, help, both pages', () => {
    const server = stripComments(readRepo('server.js', import.meta.url));
    const script = stripComments(readRepo('script.js', import.meta.url));
    test('server.js registers the route with the shared gate, requireRpc, cacheShort and serverError', () => {
        assert.match(server, /registerBalanceLocksRoute\(app, \{[^}]*requireRpc[^}]*cacheShort[^}]*serverError[^}]*\}\)/s);
    });
    test('the API reference documents it, in the short cache tier', () => {
        assert.ok(allRoutes().some(r => r.method === 'GET' && r.path === '/api/account/:address/locks'));
        assert.match(readRepo('lib/api-reference.js', import.meta.url), /name: 'Short'[\s\S]*?'\/api\/account\/:address\/locks'[\s\S]*?name: 'Medium'/);
    });
    test('a help article for locks, in the sitemap', () => {
        const t = HELP_TOPICS.find(x => x.slug === LOCK_HELP_SLUG);
        assert.ok(t, 'no help article');
        for (const word of ['Transferable', 'existential deposit', 'overlap', 'staking ', 'democracy.unlock', 'removeVoter', '392']) assert.ok(t.body.includes(word), `article lacks "${word}"`);
        assert.ok(!/[–—]/.test(t.body + t.title), 'em or en dash in the article');
        assert.match(server, new RegExp(`path: '/help/${LOCK_HELP_SLUG}'`));
    });
    test('both pages mount the panel', () => {
        assert.match(script, /import \{ mountBalanceLocks \} from '\.\/lib\/balance-locks-view\.js'/);
        assert.match(script, /id="wallet-locks-slot"/);
        assert.match(script, /id="account-locks-slot"/);
        assert.equal((script.match(/mountBalanceLocks\(/g) || []).length, 2);
    });
});
