// Remove finished votes must never hold more PDEX for longer than the locks it
// replaces (lib/democracy-lock-projection.js, used by lib/lock-actions.js and
// the balance breakdown panel).
//
// pallet-democracy (polkadot-stable2512-3), the rules this follows:
//   - PriorLock::accumulate(until, amount): self.0 = max(self.0, until);
//     self.1 = max(self.1, amount). The merged lock keeps the LARGER amount
//     AND the LATER date.
//   - try_remove_vote on a finished referendum accumulates only for a vote
//     with locked_if(approved) (Standard, on the winning side) and only while
//     now < end + VoteLockingPeriod x lock_periods.
//   - update_lock (unlock): rejig clears the prior once now >= prior.until,
//     then lock = max(every recorded vote's balance, prior amount).
//   - try_undelegate: prior.accumulate(now + VoteLockingPeriod x lock_periods,
//     delegated balance).
// So removing a 10 PDEX 6x winning vote while a 500 PDEX prior runs for 100
// more blocks keeps 500 PDEX locked for up to 960 days; the panel must not
// offer that, and must say what to do instead.
//
// Every amount and account here is made up (public repo).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { projectDemocracyLocks, accumulate } from '../lib/democracy-lock-projection.js';
import { lockActions, lockActionSpec, democracyActions } from '../lib/lock-actions.js';
import { describeAccountLocks } from '../lib/balance-locks.js';
import { renderBalanceLocks } from '../lib/balance-locks-view.js';
import { successCopy } from '../lib/tx-status.js';
import { HELP_TOPICS } from '../lib/help-topics.js';

const PDEX = 10n ** 12n;
const s = (v) => v.toString();
const BLOCK = 1_000_000;
const BLOCK_MS = 12000;
const PERIOD = 216000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const ME = 'esm9mgCefMrQ2EbGGyMNXGAFA3vnRGDid7GheURpcFRTjyokX';   // 0x11..11 at prefix 88
const OTHER = 'esmY9ZU5xPLb8urxWNBq89tPvEAG3CZm4KboeysfVgQuEw1io'; // 0x22..22 at prefix 88
const same = (a, b) => String(a) === String(b);
const dayOf = (block) => new Date(NOW + (block - BLOCK) * BLOCK_MS).toISOString().slice(0, 10);
const num = (b) => Number(b).toLocaleString('en-US');

function snap(over = {}) {
    return {
        address: ME, now: NOW, free: s(1000n * PDEX), reserved: '0', frozen: '0', ed: s(PDEX),
        block: BLOCK, blockMs: BLOCK_MS, bondingDays: 28, eraMs: 86400000,
        locks: [], freezes: [], holds: [], reserves: [],
        staking: { bonded: false, total: '0', active: '0', unlocking: '0', chunks: [], currentEra: null, activeEra: null, activeEraStart: null, spans: 0, controller: null, stash: null },
        democracy: null, elections: null, identity: null, proxy: null,
        pallets: { vesting: false, ormlVesting: false },
        ...over
    };
}
const lock = (id, amount) => ({ id, amount: s(amount), reasons: 'All' });
const vote = (index, aye, conviction, amount) => ({ index, aye, conviction, balance: s(amount) });
const direct = (votes, referenda, prior = { until: 0, amount: '0' }) => ({ delegating: false, lockingPeriod: PERIOD, votes, referenda, prior });
const withDem = (dem, lockAmount, over = {}) => snap({ frozen: s(lockAmount), locks: [lock('democrac', lockAmount)], democracy: dem, ...over });
const html = (sn) => renderBalanceLocks(describeAccountLocks(sn), { canSign: true });
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// The 6x vote ended at block 900,000 on the winning side: its own lock runs to
// 900,000 + 32 x PERIOD (960 days of 30-day periods).
const FAR = 900_000 + 32 * PERIOD;
const PRIOR_SOON = { until: BLOCK + 100, amount: s(500n * PDEX) };
const SIX_X = direct([vote(4, true, 'Locked6x', 10n * PDEX)], { 4: { finished: true, approved: true, end: 900_000 } }, PRIOR_SOON);
const OVERLOCK = withDem(SIX_X, 500n * PDEX);

describe('accumulate is the pallet rule: max date and max amount', () => {
    test('the merged lock keeps the larger amount and the later date', () => {
        assert.deepEqual(accumulate({ until: BLOCK + 100, amount: 500n }, FAR, 10n), { until: FAR, amount: 500n });
        assert.deepEqual(accumulate({ until: FAR, amount: 10n }, BLOCK + 100, 500n), { until: FAR, amount: 500n });
    });
});

describe('a 500 PDEX prior ending soon and a finished 10 PDEX 6x winning vote', () => {
    test('the projection: removing the vote now would hold 500 PDEX until the vote\'s date, so it is not safe', () => {
        const p = projectDemocracyLocks(SIX_X, { now: BLOCK, period: PERIOD });
        const v = p.votes.find(x => x.index === 4);
        assert.equal(v.accumulates, true);
        assert.equal(v.lockUntil, FAR);
        assert.deepEqual(v.ifRemoved, { until: FAR, amount: 500n * PDEX });
        assert.equal(v.safe, false);
        assert.deepEqual(p.batch.remove, []);
        assert.equal(p.batch.unlock, false);
        assert.deepEqual(p.held.map(h => [h.index, h.wait, h.waitUntil, h.frees]), [[4, 'prior', BLOCK + 100, 490n * PDEX]]);
    });
    test('the panel offers no remove: it says wait for the earlier lock, Unlock, then remove the vote', () => {
        const d = lockActions(OVERLOCK).democracy;
        assert.deepEqual(d.remove, []);
        assert.equal(d.unlock, false);
        const h = html(OVERLOCK);
        assert.doesNotMatch(h, /data-lock-action="democracy-unlock"/);
        assert.match(text(h), new RegExp(`Wait until block ${num(BLOCK + 100)} \\(about ${dayOf(BLOCK + 100)}\\), then Unlock frees 490 PDEX; after that, remove the vote on referendum #4\\.`));
    });
    test('both locks are shown with their own dates, and 500 PDEX is never said to be locked until the vote\'s date', () => {
        const t = text(html(OVERLOCK));
        assert.match(t, new RegExp(`Earlier vote lock: 500 PDEX until block ${num(BLOCK + 100)} \\(about ${dayOf(BLOCK + 100)}\\)\\.`));
        assert.match(t, new RegExp(`Vote on referendum #4: 10 PDEX until block ${num(FAR)} \\(about ${dayOf(FAR)}\\)\\.`));
        assert.doesNotMatch(t, new RegExp(`500 PDEX stays locked until block (${num(FAR)}|${FAR})`));
        const row = describeAccountLocks(OVERLOCK).items.find(i => i.id === 'democrac').unlock;
        assert.doesNotMatch(row, new RegExp(`500 PDEX stays locked until block ${FAR}`));
        assert.match(row, new RegExp(`500 PDEX until block ${BLOCK + 100}`));
        assert.match(row, new RegExp(`10 PDEX until block ${FAR}`));
    });
    test('the spec refuses a batch with nothing safe in it', () => {
        const spec = lockActionSpec('democracy-unlock', describeAccountLocks(OVERLOCK), ME, { connected: ME, isSame: same });
        assert.ok(spec.error);
    });
    test('once the earlier lock has ended: unlock first, then remove; only the vote\'s own 10 PDEX stays', () => {
        const later = { ...OVERLOCK, block: BLOCK + 200 };
        const d = lockActions(later).democracy;
        assert.equal(d.rejigFirst, true);
        assert.deepEqual(d.remove.map(r => r.index), [4]);
        assert.equal(d.lockAfter, s(10n * PDEX));
        assert.equal(d.lockedUntil, FAR);
        assert.equal(d.freed, s(490n * PDEX));
    });
});

describe('the mirror: a small far-dated prior and a large vote whose own lock ends soon', () => {
    const END = BLOCK + 1000 - PERIOD;   // 1x: its own lock ends at BLOCK + 1000
    const PRIOR_FAR = { until: FAR, amount: s(10n * PDEX) };
    const MIRROR = withDem(direct([vote(4, true, 'Locked1x', 500n * PDEX)], { 4: { finished: true, approved: true, end: END } }, PRIOR_FAR), 500n * PDEX);
    test('not offered: removing now would hold 500 PDEX until the prior\'s date', () => {
        const p = projectDemocracyLocks(MIRROR.democracy, { now: BLOCK, period: PERIOD });
        assert.deepEqual(p.votes[0].ifRemoved, { until: FAR, amount: 500n * PDEX });
        assert.deepEqual(p.batch.remove, []);
        assert.deepEqual(p.held.map(h => [h.index, h.wait, h.waitUntil]), [[4, 'vote', BLOCK + 1000]]);
    });
    test('the panel: remove it after its own lock ends, and says what removing it now would do', () => {
        const t = text(html(MIRROR));
        assert.doesNotMatch(html(MIRROR), /data-lock-action="democracy-unlock"/);
        assert.match(t, new RegExp(`Remove the vote on referendum #4 after block ${num(BLOCK + 1000)} \\(about ${dayOf(BLOCK + 1000)}\\), when its own lock ends; removing it now would keep 500 PDEX locked until block ${num(FAR)} \\(about ${dayOf(FAR)}\\)\\.`));
        assert.match(t, /Earlier vote lock: 10 PDEX until block/);
    });
    test('after its own lock ends the remove is safe again (no accumulate)', () => {
        const d = lockActions({ ...MIRROR, block: BLOCK + 1000 }).democracy;
        assert.deepEqual(d.remove.map(r => r.index), [4]);
        assert.equal(d.lockAfter, s(10n * PDEX), 'only the prior stays');
        assert.equal(d.lockedUntil, FAR);
    });
});

describe('removes that create no prior stay offered under a running prior', () => {
    const REFS = {
        1: { finished: true, approved: true, end: 900_000 },    // lost: nay on an approved referendum
        2: { finished: true, approved: true, end: 900_000 },    // won with None
        3: { finished: true, approved: true, end: 700_000 },    // won 1x, own lock ended at 916,000
        5: { cancelled: true },
        9: { ongoing: true, end: 1_050_000 }
    };
    const VOTES = [vote(1, false, 'Locked6x', 700n * PDEX), vote(2, true, 'None', 700n * PDEX), vote(3, true, 'Locked1x', 700n * PDEX), vote(5, true, 'Locked6x', 700n * PDEX), vote(9, true, 'Locked2x', 20n * PDEX)];
    const SAFE = withDem(direct(VOTES, REFS, PRIOR_SOON), 700n * PDEX);
    test('losing side, no conviction, expired lock and cancelled are in the batch; the running one is a separate cancel', () => {
        const d = lockActions(SAFE).democracy;
        assert.deepEqual(d.remove.map(r => r.index), [1, 2, 3, 5]);
        assert.deepEqual(d.cancel.map(c => c.index), [9]);
        assert.equal(d.held.length, 0);
        assert.equal(d.lockAfter, s(500n * PDEX), 'the prior stays, unchanged');
        assert.equal(d.lockedUntil, BLOCK + 100);
        assert.equal(d.unlock, true);
    });
});

describe('several votes, some safe and some not', () => {
    const REFS = { 1: { finished: true, approved: true, end: 900_000 }, 2: { finished: true, approved: true, end: 900_000 }, 3: { finished: true, approved: true, end: BLOCK + 500 - PERIOD } };
    test('a larger, later vote takes the prior over; the far small vote waits for it', () => {
        // #3: 600 PDEX until BLOCK + 500 covers the 500 PDEX prior (BLOCK + 100) in both amount and date.
        const VOTES = [vote(1, true, 'Locked6x', 10n * PDEX), vote(2, false, 'Locked6x', 50n * PDEX), vote(3, true, 'Locked1x', 600n * PDEX)];
        const d = lockActions(withDem(direct(VOTES, REFS, PRIOR_SOON), 600n * PDEX)).democracy;
        assert.deepEqual(d.remove.map(r => r.index), [2, 3]);
        assert.equal(d.lockedUntil, BLOCK + 500);
        assert.equal(d.lockedUntilAmount, s(600n * PDEX));
        assert.deepEqual(d.held.map(h => [h.index, h.wait, h.waitUntil]), [[1, 'prior', BLOCK + 500]]);
    });
    test('an expired prior: a leading unlock clears it, then the removes, then the unlock', async () => {
        const VOTES = [vote(1, true, 'Locked6x', 10n * PDEX), vote(2, false, 'Locked6x', 50n * PDEX)];
        const sn = withDem(direct(VOTES, REFS, { until: BLOCK - 10, amount: s(500n * PDEX) }), 500n * PDEX);
        const d = lockActions(sn).democracy;
        assert.equal(d.rejigFirst, true);
        assert.deepEqual(d.remove.map(r => r.index), [1, 2]);
        assert.equal(d.lockAfter, s(10n * PDEX));
        const spec = lockActionSpec('democracy-unlock', describeAccountLocks(sn), ME, { connected: ME, isSame: same });
        assert.deepEqual(await spec.buildTx(fakeApi()), { batch: [['unlock', ME], ['removeVote', 1], ['removeVote', 2], ['unlock', ME]] });
    });
});

describe('undelegating over an earlier vote lock', () => {
    const FAR_PRIOR = BLOCK + 900 * 7200;
    const DELEGATING = withDem({ delegating: true, target: OTHER, conviction: 'None', balance: s(500n * PDEX), lockingPeriod: PERIOD, prior: { until: FAR_PRIOR, amount: s(10n * PDEX) } }, 500n * PDEX);
    test('the projection keeps the larger amount and the later date', () => {
        const u = projectDemocracyLocks(DELEGATING.democracy, { now: BLOCK, period: PERIOD }).undelegate;
        assert.deepEqual([u.until, u.amount, u.byPrior], [FAR_PRIOR, 500n * PDEX, true]);
        const a = democracyActions(DELEGATING.democracy, { block: BLOCK, blockMs: BLOCK_MS, now: NOW });
        assert.equal(a.undelegate.lockUntil, FAR_PRIOR);
        assert.equal(a.undelegate.lockAmount, s(500n * PDEX));
    });
    test('the panel says it before the user undelegates, with the max amount and the max date', () => {
        const t = text(html(DELEGATING));
        assert.match(t, new RegExp(`Undelegating keeps 500 PDEX locked until block ${num(FAR_PRIOR)} \\(about ${dayOf(FAR_PRIOR)}\\) because of an earlier vote lock`));
        assert.doesNotMatch(t, new RegExp(`until block ${num(BLOCK)}\\b`));
    });
    test('an ended earlier lock larger than the delegation: unlock first, so undelegate does not carry it to the new date', async () => {
        const ended = withDem({ ...DELEGATING.democracy, conviction: 'Locked1x', balance: s(10n * PDEX), prior: { until: BLOCK - 5, amount: s(500n * PDEX) } }, 500n * PDEX);
        const u = lockActions(ended).democracy.undelegate;
        assert.deepEqual([u.rejigFirst, u.lockAmount, u.lockUntil], [true, s(10n * PDEX), BLOCK + PERIOD]);
        const spec = lockActionSpec('democracy-undelegate', describeAccountLocks(ended), ME, { connected: ME, isSame: same });
        assert.deepEqual(await spec.buildTx(fakeApi()), { batch: [['unlock', ME], ['undelegate']] });
    });
    test('a larger earlier lock ending before the delegation\'s: says that undelegating after it ends holds only the delegated PDEX', () => {
        const soon = withDem({ ...DELEGATING.democracy, conviction: 'Locked1x', balance: s(10n * PDEX), prior: { until: BLOCK + 100, amount: s(500n * PDEX) } }, 500n * PDEX);
        const t = text(html(soon));
        assert.match(t, new RegExp(`Undelegating keeps 500 PDEX locked until block ${num(BLOCK + PERIOD)} \\(about ${dayOf(BLOCK + PERIOD)}\\) because of an earlier vote lock`));
        assert.match(t, new RegExp(`Undelegating after block ${num(BLOCK + 100)} \\(about ${dayOf(BLOCK + 100)}\\), when that lock ends, holds only the delegated PDEX\\.`));
    });
    test('no earlier lock and no conviction: Unlock frees it right after', () => {
        const plain = withDem({ ...DELEGATING.democracy, prior: { until: 0, amount: '0' } }, 500n * PDEX);
        assert.match(text(html(plain)), /After undelegating, Unlock frees 500 PDEX\./);
    });
});

describe('what an unlock frees: another lock, not staking, can be the blocker', () => {
    // Staked 50 (a hold), a 100 PDEX council vote lock, and a lost 100 PDEX referendum vote.
    const lost = direct([vote(4, false, 'None', 100n * PDEX)], { 4: { finished: true, approved: true, end: 900_000 } });
    const UNDER_COUNCIL = snap({ free: s(200n * PDEX), reserved: s(50n * PDEX), frozen: s(100n * PDEX),
        holds: [{ id: 'Staking.Staking', amount: s(50n * PDEX) }],
        staking: { bonded: true, total: s(50n * PDEX), active: s(50n * PDEX), unlocking: '0', chunks: [], currentEra: 100, activeEra: 100, activeEraStart: NOW, spans: 0, controller: ME, stash: ME },
        locks: [lock('phrelect', 100n * PDEX), lock('democrac', 100n * PDEX)], democracy: lost });
    test('staking is not blamed: the council vote keeps the 100 PDEX locked', () => {
        const d = lockActions(UNDER_COUNCIL).democracy;
        assert.equal(d.spendable, '0');
        assert.equal(d.staysStaked, '0');
        assert.deepEqual(d.heldBy, { id: 'phrelect', amount: s(100n * PDEX) });
        const t = text(html(UNDER_COUNCIL));
        assert.match(t, /Nothing becomes spendable now; the council vote keeps 100 PDEX locked\./);
        assert.doesNotMatch(t, /stays staked/);
    });
    test('a spendable amount reads as an estimate: "About X becomes spendable now"', () => {
        const free = withDem(lost, 40n * PDEX, { free: s(100n * PDEX), democracy: direct([vote(4, false, 'None', 40n * PDEX)], { 4: { finished: true, approved: true, end: 900_000 } }) });
        assert.match(text(html(free)), /About 39 PDEX becomes spendable now\./);
    });
});

// The batch the button signs, run through a model of the pallet written here
// from the rules above (not from the code under test).
function fakeApi() {
    return { tx: {
        democracy: { unlock: (who) => ['unlock', who], removeVote: (i) => ['removeVote', i], undelegate: () => ['undelegate'] },
        utility: { batchAll: (calls) => ({ batch: calls }) }
    } };
}
const PERIODS = { None: 0, Locked1x: 1, Locked2x: 2, Locked3x: 4, Locked4x: 8, Locked5x: 16, Locked6x: 32 };
// st0: carry on from an earlier run (a later step); delegating: Voting::Delegating.
function palletRun(dem, now, calls, st0 = null) {
    const st = st0 ? { ...st0, votes: [...st0.votes], prior: { ...st0.prior } } : {
        delegating: dem.delegating ? { balance: BigInt(dem.balance), conviction: dem.conviction } : null,
        votes: (dem.votes || []).map(v => ({ ...v, balance: BigInt(v.balance) })), prior: { until: Number(dem.prior.until), amount: BigInt(dem.prior.amount) }, lock: null };
    for (const [op, arg] of calls) {
        if (op === 'undelegate') {
            // try_undelegate: prior.accumulate(now + VoteLockingPeriod x lock_periods, balance); Direct, no votes.
            assert.ok(st.delegating, 'undelegate while not delegating');
            const at = now + PERIOD * PERIODS[st.delegating.conviction];
            st.prior = { until: Math.max(st.prior.until, at), amount: st.delegating.balance > st.prior.amount ? st.delegating.balance : st.prior.amount };
            st.delegating = null;
            continue;
        }
        if (op === 'removeVote') {
            assert.ok(!st.delegating, 'removeVote while delegating');
            const i = st.votes.findIndex(v => v.index === arg);
            assert.ok(i >= 0, `removeVote(${arg}) on a vote not recorded`);
            const v = st.votes[i], info = dem.referenda[arg];
            if (info && info.finished && v.aye === !!info.approved) {
                const at = Number(info.end) + PERIOD * PERIODS[v.conviction];
                if (now < at) st.prior = { until: Math.max(st.prior.until, at), amount: v.balance > st.prior.amount ? v.balance : st.prior.amount };
            }
            st.votes.splice(i, 1);
        } else if (op === 'unlock') {
            if (now >= st.prior.until) st.prior = { until: 0, amount: 0n };
            const held = st.delegating ? (st.delegating.balance > st.prior.amount ? st.delegating.balance : st.prior.amount) : st.prior.amount;
            st.lock = st.votes.reduce((a, v) => (v.balance > a ? v.balance : a), held);
        }
    }
    return st;
}
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }

describe('property: the offered batch never holds more PDEX for longer than the locks it replaces', () => {
    test('random votes and priors: the new prior is covered by one of the old locks in both amount and date', async () => {
        const r = rng(20261114);
        const pick = (xs) => xs[Math.floor(r() * xs.length)];
        const convs = Object.keys(PERIODS);
        let offered = 0;
        for (let k = 0; k < 600; k++) {
            const now = BLOCK;
            const n = 1 + Math.floor(r() * 4);
            const votes = [], referenda = {};
            for (let i = 1; i <= n; i++) {
                const state = pick(['finished', 'finished', 'finished', 'ongoing', 'cancelled']);
                votes.push(vote(i, r() < 0.6, pick(convs), BigInt(1 + Math.floor(r() * 1000)) * PDEX));
                referenda[i] = state === 'finished' ? { finished: true, approved: r() < 0.7, end: now - Math.floor(r() * 3 * PERIOD) }
                    : state === 'ongoing' ? { ongoing: true, end: now + 1000 } : { cancelled: true };
            }
            const prior = r() < 0.2 ? { until: 0, amount: '0' }
                : { until: Math.max(1, now + Math.floor((r() - 0.3) * 40 * PERIOD)), amount: s(BigInt(1 + Math.floor(r() * 1000)) * PDEX) };
            const dem = direct(votes, referenda, prior);
            const lockNow = votes.reduce((a, v) => (BigInt(v.balance) > a ? BigInt(v.balance) : a), BigInt(prior.amount));
            const sn = withDem(dem, lockNow);
            const model = describeAccountLocks(sn);
            const spec = lockActionSpec('democracy-unlock', model, ME, { connected: ME, isSame: same });
            if (spec.error) continue;
            offered++;
            const tx = await spec.buildTx(fakeApi());
            const calls = tx.batch || [tx];
            const after = palletRun(dem, now, calls);
            // The locks each removed vote would hold alone, and the prior if it is still running.
            const own = [];
            if (Number(prior.until) > now) own.push({ until: Number(prior.until), amount: BigInt(prior.amount) });
            for (const [op, i] of calls) {
                if (op !== 'removeVote') continue;
                const v = votes.find(x => x.index === i), info = referenda[i];
                if (info.finished && v.aye === info.approved) {
                    const at = info.end + PERIOD * PERIODS[v.conviction];
                    if (at > now) own.push({ until: at, amount: BigInt(v.balance) });
                }
            }
            const p = after.prior;
            if (p.until > now && p.amount > 0n) {
                assert.ok(own.some(x => x.until >= p.until && x.amount >= p.amount),
                    `case ${k} ${JSON.stringify({ votes, referenda, prior, calls })}: the batch leaves ${p.amount} until ${p.until}, more than any old lock alone (${JSON.stringify(own, (_, v) => (typeof v === 'bigint' ? v.toString() : v))})`);
                assert.ok(p.amount <= lockNow, `case ${k}: amount grew`);
            }
            const d = model.actions.democracy;
            if (after.lock != null) assert.equal(s(after.lock), d.lockAfter, `case ${k}: the projected lock after the batch`);
            assert.equal(p.until > now ? p.until : null, d.lockedUntil, `case ${k}: the projected date`);
        }
        assert.ok(offered > 150, `enough cases offered a batch (${offered})`);
    });
});

// Review round 2 (findings 1 to 5).
const coversLock = (a, b) => a.until >= b.until && a.amount >= b.amount;
const delegatingDem = (conviction, balance, prior) => ({ delegating: true, target: OTHER, conviction, balance: s(balance), lockingPeriod: PERIOD, prior });
const delegatingSnap = (dem, over = {}) => withDem(dem, BigInt(dem.balance) > BigInt(dem.prior.amount) ? BigInt(dem.balance) : BigInt(dem.prior.amount), over);

describe('undelegate: "wait for the earlier lock" only when waiting really holds less', () => {
    test('500 PDEX at 1x over a 10 PDEX far prior: no advice to wait (waiting would hold 500 until the prior plus the conviction period)', () => {
        const FAR_PRIOR = BLOCK + 3 * PERIOD;
        const sn = delegatingSnap(delegatingDem('Locked1x', 500n * PDEX, { until: FAR_PRIOR, amount: s(10n * PDEX) }));
        const u = lockActions(sn).democracy.undelegate;
        assert.equal(u.betterAfter, null);
        assert.equal(u.betterAfterEta, null);
        assert.deepEqual([u.lockAmount, u.lockUntil], [s(500n * PDEX), FAR_PRIOR]);
        assert.doesNotMatch(text(html(sn)), /Undelegating after block/);
    });
    test('the same with no conviction: no advice to wait either', () => {
        const sn = delegatingSnap(delegatingDem('None', 500n * PDEX, { until: BLOCK + 900 * 7200, amount: s(10n * PDEX) }));
        assert.equal(lockActions(sn).democracy.undelegate.betterAfter, null);
        assert.doesNotMatch(text(html(sn)), /Undelegating after block/);
    });
    test('a larger prior ending before the delegation\'s date: the advice stays', () => {
        const sn = delegatingSnap(delegatingDem('Locked1x', 10n * PDEX, { until: BLOCK + 100, amount: s(500n * PDEX) }));
        assert.equal(lockActions(sn).democracy.undelegate.betterAfter, BLOCK + 100);
    });
    test('ties: an equal amount, or an equal date, gives no advice', () => {
        const eqAmount = delegatingSnap(delegatingDem('Locked1x', 500n * PDEX, { until: BLOCK + 100, amount: s(500n * PDEX) }));
        assert.equal(lockActions(eqAmount).democracy.undelegate.betterAfter, null);
        const eqDate = delegatingSnap(delegatingDem('Locked1x', 10n * PDEX, { until: BLOCK + PERIOD, amount: s(500n * PDEX) }));
        assert.equal(lockActions(eqDate).democracy.undelegate.betterAfter, null);
    });
});

describe('Cancel vote re-reads the referendum before it signs', () => {
    const RUNNING = withDem(direct([vote(9, true, 'Locked6x', 10n * PDEX)], { 9: { ongoing: true, end: BLOCK + 50 } }, PRIOR_SOON), 500n * PDEX);
    const api = (info) => {
        const asked = [];
        return { asked, tx: fakeApi().tx, query: { democracy: { referendumInfoOf: async (i) => { asked.push(i); return info; } } } };
    };
    const spec = () => lockActionSpec('democracy-cancel', describeAccountLocks(RUNNING), ME, { connected: ME, isSame: same, ref: 9 });
    const ENDED = /^This referendum has just ended; reload to see the safe options\.$/;
    test('still running: removeVote(9)', async () => {
        const a = api({ isSome: true, unwrap: () => ({ isOngoing: true, isFinished: false }) });
        assert.deepEqual(await spec().buildTx(a), ['removeVote', 9]);
        assert.deepEqual(a.asked, [9]);
    });
    test('ended (approved) since the panel was drawn: refuses, so the remove cannot merge a conviction lock', async () => {
        const a = api({ isSome: true, unwrap: () => ({ isOngoing: false, isFinished: true, asFinished: { approved: true, end: BLOCK } }) });
        await assert.rejects(async () => spec().buildTx(a), (e) => ENDED.test(e.message));
    });
    test('no referendum info any more: refuses too', async () => {
        await assert.rejects(async () => spec().buildTx(api({ isSome: false })), (e) => ENDED.test(e.message));
    });
    test('the referendum cannot be read: refuses', async () => {
        await assert.rejects(async () => spec().buildTx({ tx: fakeApi().tx, query: {} }), (e) => ENDED.test(e.message));
    });
});

describe('undelegate copy matches accumulate: the larger amount until the later date', () => {
    const LARGER = /larger of the delegated PDEX and any earlier vote lock/;
    const LATER = /until the later of the conviction period from now and that earlier lock's end/;
    const OLD = /(delegated PDEX (then )?stays locked for the conviction period|wait the conviction period)/;
    test('the success card', () => {
        const b = successCopy('democracy.undelegate', {}, {}).body;
        assert.match(b, LARGER); assert.match(b, LATER); assert.doesNotMatch(b, OLD);
    });
    test('the lock row', () => {
        const sn = delegatingSnap(delegatingDem('Locked1x', 10n * PDEX, { until: 0, amount: '0' }));
        const r = describeAccountLocks(sn).items.find(i => i.id === 'democrac').unlock;
        assert.match(r, LARGER); assert.match(r, LATER); assert.doesNotMatch(r, OLD);
    });
    test('the help article', () => {
        const b = HELP_TOPICS.find(t => t.slug === 'locked-balance').body;
        assert.match(b, LARGER); assert.match(b, LATER); assert.doesNotMatch(b, OLD);
    });
});

describe('a lock id that is an Object.prototype name', () => {
    test('"toString" as the blocking lock reads as its id, never as a function', () => {
        const lost = direct([vote(4, false, 'None', 100n * PDEX)], { 4: { finished: true, approved: true, end: 900_000 } });
        const sn = snap({ free: s(200n * PDEX), frozen: s(100n * PDEX), locks: [lock('toString', 100n * PDEX), lock('democrac', 100n * PDEX)], democracy: lost });
        assert.deepEqual(lockActions(sn).democracy.heldBy, { id: 'toString', amount: s(100n * PDEX) });
        const t = text(html(sn));
        assert.match(t, /Nothing becomes spendable now; the toString lock keeps 100 PDEX locked\./);
        assert.doesNotMatch(t, /function|native code/);
        const m = describeAccountLocks({ ...sn, holds: [{ id: 'toString', amount: s(PDEX) }] });
        assert.equal(m.items.find(i => i.kind === 'lock' && i.id === 'toString').source, 'Unknown lock');
        assert.equal(m.items.find(i => i.kind === 'hold' && i.id === 'toString').source, 'Unknown hold');
    });
});

// Tie-prone pools: equal amounts and equal dates come up often. 'held':
// winning conviction votes behind a running prior, so votes are kept back.
function randomDirect(r, ties) {
    if (ties === 'held') {
        const pick = (xs) => xs[Math.floor(r() * xs.length)];
        const now = BLOCK, n = 2 + Math.floor(r() * 3), votes = [], referenda = {};
        for (let i = 1; i <= n; i++) {
            votes.push(vote(i, true, pick(['Locked1x', 'Locked2x']), pick([10n, 100n, 300n, 500n, 700n]) * PDEX));
            referenda[i] = { finished: true, approved: true, end: now - PERIOD + pick([100, 200, 300, 400]) };
        }
        const prior = { until: now + pick([100, 200, 300]), amount: s(pick([300n, 500n]) * PDEX) };
        return { now, votes, referenda, prior, dem: direct(votes, referenda, prior) };
    }
    const pick = (xs) => xs[Math.floor(r() * xs.length)];
    const now = BLOCK;
    const n = 1 + Math.floor(r() * 4);
    const votes = [], referenda = {};
    const amount = () => (ties ? pick([10n, 300n, 500n]) : BigInt(1 + Math.floor(r() * 1000))) * PDEX;
    for (let i = 1; i <= n; i++) {
        const state = pick(['finished', 'finished', 'finished', 'ongoing', 'cancelled']);
        votes.push(vote(i, r() < 0.6, ties ? pick(['None', 'Locked1x', 'Locked2x']) : pick(Object.keys(PERIODS)), amount()));
        const end = ties ? pick([now - PERIOD + 100, now - 2 * PERIOD + 100, now - PERIOD + 300]) : now - Math.floor(r() * 3 * PERIOD);
        referenda[i] = state === 'finished' ? { finished: true, approved: r() < 0.7, end }
            : state === 'ongoing' ? { ongoing: true, end: now + 1000 } : { cancelled: true };
    }
    const prior = r() < 0.2 ? { until: 0, amount: '0' }
        : { until: ties ? pick([now - 10, now, now + 100, now + 300, now + PERIOD + 100]) : Math.max(1, now + Math.floor((r() - 0.3) * 40 * PERIOD)), amount: s(amount()) };
    return { now, votes, referenda, prior, dem: direct(votes, referenda, prior) };
}
const ownLock = (c, now) => {
    const info = c.referenda[c.v.index];
    if (!(info && info.finished && c.v.aye === info.approved)) return null;
    const at = info.end + PERIOD * PERIODS[c.v.conviction];
    return at > now ? { until: at, amount: BigInt(c.v.balance) } : null;
};
const lockNowOf = (c) => c.votes.reduce((a, v) => (BigInt(v.balance) > a ? BigInt(v.balance) : a), BigInt(c.prior.amount));
const fmt = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

describe('two held votes that do not nest, both behind a running prior', () => {
    // Prior 500 PDEX to BLOCK + 100; #1 300 PDEX to BLOCK + 200; #2 100 PDEX to BLOCK + 400.
    const TWO = direct([vote(1, true, 'Locked1x', 300n * PDEX), vote(2, true, 'Locked1x', 100n * PDEX)],
        { 1: { finished: true, approved: true, end: BLOCK + 200 - PERIOD }, 2: { finished: true, approved: true, end: BLOCK + 400 - PERIOD } }, PRIOR_SOON);
    test('the second waits for the first one\'s lock, not the prior: removing both when the prior ends would hold 300 PDEX to BLOCK + 400', () => {
        const d = lockActions(withDem(TWO, 500n * PDEX)).democracy;
        assert.deepEqual(d.held.map(h => [h.index, h.wait, h.waitUntil]), [[1, 'prior', BLOCK + 100], [2, 'prior', BLOCK + 200]]);
        const t = text(html(withDem(TWO, 500n * PDEX)));
        assert.match(t, new RegExp(`Wait until block ${num(BLOCK + 200)} \\(about ${dayOf(BLOCK + 200)}\\), then press Unlock; after that, remove the vote on referendum #2\\.`));
    });
    test('following both in order through the pallet model: each step stays covered by a lock it joins', () => {
        let st = palletRun(TWO, BLOCK + 100, [['unlock', ME], ['removeVote', 1]]);
        assert.deepEqual([st.prior.until, st.prior.amount], [BLOCK + 200, 300n * PDEX]);
        st = palletRun(TWO, BLOCK + 200, [['unlock', ME], ['removeVote', 2]], st);
        assert.deepEqual([st.prior.until, st.prior.amount], [BLOCK + 400, 100n * PDEX]);
    });
});

describe('property, round 2: later inclusion, ties, and following the held guidance', () => {
    test('a batch included some blocks after it was drawn still never holds more PDEX for longer', async () => {
        const r = rng(20261115);
        const pick = (xs) => xs[Math.floor(r() * xs.length)];
        let offered = 0;
        for (let k = 0; k < 800; k++) {
            const c = randomDirect(r, [true, false, 'held'][k % 3]);
            const delay = pick([0, 1, 2, 50, 99, 100, 101, 200, 299, 300, 301, Math.floor(r() * 2 * PERIOD)]);
            const spec = lockActionSpec('democracy-unlock', describeAccountLocks(withDem(c.dem, lockNowOf(c))), ME, { connected: ME, isSame: same });
            if (spec.error) continue;
            offered++;
            const tx = await spec.buildTx(fakeApi());
            const calls = tx.batch || [tx];
            const at = c.now + delay;
            const after = palletRun(c.dem, at, calls);
            const own = [];
            if (Number(c.prior.until) > at) own.push({ until: Number(c.prior.until), amount: BigInt(c.prior.amount) });
            for (const [op, i] of calls) {
                if (op !== 'removeVote') continue;
                const o = ownLock({ v: c.votes.find(x => x.index === i), referenda: c.referenda }, at);
                if (o) own.push(o);
            }
            const p = after.prior;
            if (p.until > at && p.amount > 0n) {
                assert.ok(own.some(x => coversLock(x, p)), `case ${k} (+${delay}) ${fmt({ c, calls, p, own })}`);
                assert.ok(p.amount <= lockNowOf(c), `case ${k}: amount grew`);
            }
        }
        assert.ok(offered > 200, `enough cases offered a batch (${offered})`);
    });
    test('ties: the projection still matches the pallet exactly', async () => {
        const r = rng(7);
        for (let k = 0; k < 600; k++) {
            const c = randomDirect(r, true);
            const model = describeAccountLocks(withDem(c.dem, lockNowOf(c)));
            const spec = lockActionSpec('democracy-unlock', model, ME, { connected: ME, isSame: same });
            if (spec.error) continue;
            const tx = await spec.buildTx(fakeApi());
            const calls = tx.batch || [tx];
            const after = palletRun(c.dem, c.now, calls);
            const d = model.actions.democracy;
            if (after.lock != null) assert.equal(s(after.lock), d.lockAfter, `case ${k} ${fmt({ c, calls })}`);
            assert.equal(after.prior.until > c.now ? after.prior.until : null, d.lockedUntil, `case ${k} ${fmt({ c, calls })}`);
        }
    });
    test('following each held vote\'s guidance, alone or all in order, never merges into a larger, longer lock', async () => {
        const r = rng(4242);
        let followed = 0;
        for (let k = 0; k < 1500; k++) {
            const c = randomDirect(r, [true, false, 'held'][k % 3]);
            const model = describeAccountLocks(withDem(c.dem, lockNowOf(c)));
            const d = model.actions.democracy;
            if (!d.held || !d.held.length) continue;
            const spec = lockActionSpec('democracy-unlock', model, ME, { connected: ME, isSame: same });
            const calls = spec.error ? [] : (((t) => t.batch || [t])(await spec.buildTx(fakeApi())));
            const today = palletRun(c.dem, c.now, calls);
            // What the panel says to do for h, as the calls it names.
            const steps = (h) => {
                const t = text(html(withDem(c.dem, lockNowOf(c))));
                const ref = `the vote on referendum #${h.index}`;
                const unlockFirst = h.wait === 'prior';
                if (unlockFirst) assert.match(t, new RegExp(`Wait until block ${num(h.waitUntil)}[^.]*, then (press Unlock|Unlock frees [^;]+); after that, remove ${ref}\\.`), `case ${k}: the text for #${h.index}`);
                return unlockFirst ? [['unlock', ME], ['removeVote', h.index]] : [['removeVote', h.index]];
            };
            // The locks running at that block: the prior as the pallet holds it,
            // and the own lock of every vote still recorded (h among them; one
            // removed at the same block by another step may set the date).
            const check = (st, h, at, label) => {
                const next = palletRun(c.dem, at, steps(h), st);
                const p = next.prior;
                if (p.until > at && p.amount > 0n) {
                    const live = [];
                    if (st.prior.until > at) live.push(st.prior);
                    for (const v of st.votes) {
                        const o = ownLock({ v: { ...v, balance: s(v.balance) }, referenda: c.referenda }, at);
                        if (o) live.push(o);
                    }
                    assert.ok(live.some(x => coversLock(x, p)), `case ${k} ${label} #${h.index} at ${at}: ${fmt({ c, held: d.held, calls, prior: st.prior, p, live })}`);
                }
                return next;
            };
            // Done at the block the panel names, or some blocks after it.
            const late = () => (r() < 0.5 ? 0 : Math.floor(r() * 400));
            for (const h of d.held) { check(today, h, h.waitUntil + late(), 'alone'); followed++; }
            let st = today, at = 0;
            for (const h of [...d.held].sort((a, b) => a.waitUntil - b.waitUntil)) { at = Math.max(at, h.waitUntil + late()); st = check(st, h, at, 'in order'); }
        }
        assert.ok(followed > 100, `enough held votes followed (${followed})`);
    });
});

describe('property, round 2: undelegate', () => {
    test('random delegations and priors, included now or later: the pallet result is what the panel said, and the wait advice holds', async () => {
        const r = rng(99);
        const pick = (xs) => xs[Math.floor(r() * xs.length)];
        let advised = 0;
        for (let k = 0; k < 2000; k++) {
            const now = BLOCK;
            const conviction = pick(Object.keys(PERIODS).slice(0, 4));
            const balance = pick([10n, 500n, BigInt(1 + Math.floor(r() * 1000))]) * PDEX;
            const ownUntil = now + PERIOD * PERIODS[conviction];
            const prior = r() < 0.15 ? { until: 0, amount: '0' }
                : { until: pick([now - 10, now, now + 100, ownUntil, ownUntil + 100, now + Math.floor(r() * 10 * PERIOD)]), amount: s(pick([10n, 500n, balance / PDEX]) * PDEX) };
            const dem = delegatingDem(conviction, balance, prior);
            const u = describeAccountLocks(delegatingSnap(dem)).actions.democracy.undelegate;
            const spec = lockActionSpec('democracy-undelegate', describeAccountLocks(delegatingSnap(dem)), ME, { connected: ME, isSame: same });
            const tx = await spec.buildTx(fakeApi());
            const calls = tx.batch || [tx];
            // Drawn at now, included delay blocks later: the prior that still
            // runs is the one running at INCLUSION, not when the panel was drawn.
            const delay = k % 3 === 0 ? 0 : pick([1, 99, 100, 101, Math.floor(r() * 2 * PERIOD)]);
            const at = now + delay;
            const live = Number(prior.until) > at ? { until: Number(prior.until), amount: BigInt(prior.amount) } : { until: 0, amount: 0n };
            const after = palletRun(dem, at, calls).prior;
            if (delay === 0) assert.deepEqual([after.until, s(after.amount)], [u.lockUntil, u.lockAmount], `case ${k} ${fmt({ dem, u })}`);
            // A prior expired by inclusion is never carried to the new date.
            assert.ok(after.amount <= (balance > live.amount ? balance : live.amount), `case ${k} (+${delay}): amount ${fmt({ dem, calls, after })}`);
            assert.ok(after.until <= Math.max(live.until, at + PERIOD * PERIODS[conviction]), `case ${k} (+${delay}): date ${fmt({ dem, calls, after })}`);
            const drawn = Number(prior.until) > now ? { until: Number(prior.until), amount: BigInt(prior.amount) } : { until: 0, amount: 0n };
            const shouldAdvise = drawn.amount > balance && drawn.until < ownUntil;
            assert.equal(u.betterAfter, shouldAdvise ? drawn.until : null, `case ${k}: advice ${fmt({ dem, u })}`);
            if (u.betterAfter) {
                advised++;
                // Following it: undelegate at that block, through the panel then.
                const t = u.betterAfter;
                const later = describeAccountLocks(delegatingSnap(dem, { block: t }));
                const sp = lockActionSpec('democracy-undelegate', later, ME, { connected: ME, isSame: same });
                const tx2 = await sp.buildTx(fakeApi());
                const p = palletRun(dem, t, tx2.batch || [tx2]).prior;
                assert.deepEqual([p.until, p.amount], [t + PERIOD * PERIODS[conviction], balance], `case ${k}: following the advice ${fmt({ dem, p })}`);
            }
        }
        assert.ok(advised > 20, `enough cases advised waiting (${advised})`);
    });
});

// Fable review round 3: whether the leading democracy.unlock goes in was
// decided when the panel was drawn. A prior running then can end before the
// transaction is included; try_undelegate and try_remove_vote accumulate
// into it without a rejig (only update_lock, democracy.unlock, rejigs), so
// the ended prior is carried to the new date. The leading unlock is now in
// every batch that removes votes or undelegates whenever a prior is on
// record, whatever its date (with a running prior it changes nothing).
describe('the leading unlock does not depend on the date the panel was drawn at', () => {
    const PRIOR = { until: BLOCK + 100, amount: s(500n * PDEX) };
    const calls = async (kind, sn, ref = null, api = fakeApi()) => {
        const spec = lockActionSpec(kind, describeAccountLocks(sn), ME, { connected: ME, isSame: same, ref });
        assert.ok(!spec.error, spec.error);
        const tx = await spec.buildTx(api);
        return tx.batch || [tx];
    };
    test('500 PDEX prior until +100, delegating 10 PDEX at 1x, drawn at +0 and included at +101: only the 10 PDEX stays, until +101 + one period', async () => {
        const dem = delegatingDem('Locked1x', 10n * PDEX, PRIOR);
        const c = await calls('democracy-undelegate', delegatingSnap(dem));
        assert.deepEqual(c, [['unlock', ME], ['undelegate']]);
        const p = palletRun(dem, BLOCK + 101, c).prior;
        assert.deepEqual([p.until, p.amount], [BLOCK + 101 + PERIOD, 10n * PDEX]);
        // Included while the prior still runs: the same as before, the larger amount until the later date.
        const q = palletRun(dem, BLOCK + 99, c).prior;
        assert.deepEqual([q.until, q.amount], [BLOCK + 99 + PERIOD, 500n * PDEX]);
    });
    test('undelegate with no prior on record: a single undelegate', async () => {
        assert.deepEqual(await calls('democracy-undelegate', delegatingSnap(delegatingDem('Locked1x', 10n * PDEX, { until: 0, amount: '0' }))), [['undelegate']]);
    });
    test('removes under a running prior: unlock, removes, unlock', async () => {
        const VOTES = [vote(1, false, 'Locked6x', 700n * PDEX), vote(2, true, 'None', 700n * PDEX)];
        const sn = withDem(direct(VOTES, { 1: { finished: true, approved: true, end: 900_000 }, 2: { finished: true, approved: true, end: 900_000 } }, PRIOR), 700n * PDEX);
        assert.deepEqual(await calls('democracy-unlock', sn), [['unlock', ME], ['removeVote', 1], ['removeVote', 2], ['unlock', ME]]);
    });
    test('removes under a running prior with no final unlock: unlock, removes', async () => {
        // #3: 300 PDEX 1x until +50, covered by the 500 PDEX prior: removing it frees nothing now.
        const sn = withDem(direct([vote(3, true, 'Locked1x', 300n * PDEX)], { 3: { finished: true, approved: true, end: BLOCK + 50 - PERIOD } }, PRIOR), 500n * PDEX);
        assert.deepEqual(await calls('democracy-unlock', sn), [['unlock', ME], ['removeVote', 3]]);
    });
    test('removes with no prior on record: no leading unlock', async () => {
        const sn = withDem(direct([vote(1, false, 'Locked6x', 70n * PDEX)], { 1: { finished: true, approved: true, end: 900_000 } }), 70n * PDEX);
        assert.deepEqual(await calls('democracy-unlock', sn), [['removeVote', 1], ['unlock', ME]]);
    });
    test('only an unlock: still one call', async () => {
        const sn = withDem(direct([], {}, { until: BLOCK - 1, amount: s(500n * PDEX) }), 500n * PDEX);
        assert.deepEqual(await calls('democracy-unlock', sn), [['unlock', ME]]);
    });
    const ongoing = (info) => ({ tx: fakeApi().tx, query: { democracy: { referendumInfoOf: async () => info } } });
    const RUNNING_INFO = { isSome: true, unwrap: () => ({ isOngoing: true }) };
    test('Cancel vote with a prior on record: unlock, then removeVote', async () => {
        const sn = withDem(direct([vote(9, true, 'Locked2x', 20n * PDEX)], { 9: { ongoing: true, end: BLOCK + 50 } }, PRIOR), 500n * PDEX);
        assert.deepEqual(await calls('democracy-cancel', sn, 9, ongoing(RUNNING_INFO)), [['unlock', ME], ['removeVote', 9]]);
    });
    test('Cancel vote with no prior: a single removeVote', async () => {
        const sn = withDem(direct([vote(9, true, 'Locked2x', 20n * PDEX)], { 9: { ongoing: true, end: BLOCK + 50 } }), 20n * PDEX);
        assert.deepEqual(await calls('democracy-cancel', sn, 9, ongoing(RUNNING_INFO)), [['removeVote', 9]]);
    });
    test('property: Cancel vote included after the prior ended and the referendum closed never carries the ended prior', async () => {
        const r = rng(31337);
        const pick = (xs) => xs[Math.floor(r() * xs.length)];
        let carried = 0;
        for (let k = 0; k < 1500; k++) {
            const amount = pick([10n, 300n, 500n, 700n]) * PDEX;
            const prior = r() < 0.15 ? { until: 0, amount: '0' } : { until: BLOCK + pick([-10, 0, 50, 100, 300]), amount: s(pick([10n, 300n, 500n, 700n]) * PDEX) };
            const conviction = pick(Object.keys(PERIODS));
            const dem = direct([vote(9, r() < 0.7, conviction, amount)], { 9: { ongoing: true, end: BLOCK + 50 } }, prior);
            const c = await calls('democracy-cancel', withDem(dem, lockNowOf({ votes: dem.votes, prior })), 9, ongoing(RUNNING_INFO));
            // The re-read said running; by inclusion the referendum may have closed.
            const at = BLOCK + pick([0, 1, 51, 101, 301, Math.floor(r() * 2 * PERIOD)]);
            const end = Math.min(at, BLOCK + 50);
            const closed = r() < 0.6 ? { finished: true, approved: r() < 0.5, end } : { ongoing: true, end: BLOCK + 50 };
            const p = palletRun({ ...dem, referenda: { 9: closed } }, at, c).prior;
            if (Number(prior.until) > at || !(p.until > at && p.amount > 0n)) continue;
            carried++;
            const o = ownLock({ v: dem.votes[0], referenda: { 9: closed } }, at);
            assert.ok(o && coversLock(o, p), `case ${k} at +${at - BLOCK}: ${fmt({ prior, vote: dem.votes[0], closed, c, p })}`);
        }
        assert.ok(carried > 50, `enough cases where the vote accumulated after the prior ended (${carried})`);
    });
    test('property: every remove or undelegate batch starts with an unlock whenever a prior is on record', async () => {
        const r = rng(8080);
        let checked = 0;
        for (let k = 0; k < 900; k++) {
            const cs = randomDirect(r, [true, false, 'held'][k % 3]);
            const spec = lockActionSpec('democracy-unlock', describeAccountLocks(withDem(cs.dem, lockNowOf(cs))), ME, { connected: ME, isSame: same });
            if (spec.error) continue;
            const c = (((t) => t.batch || [t])(await spec.buildTx(fakeApi())));
            if (!c.some(([op]) => op === 'removeVote')) continue;
            checked++;
            const hasPrior = BigInt(cs.prior.amount) > 0n;
            assert.equal(c[0][0] === 'unlock', hasPrior, `case ${k}: ${fmt({ prior: cs.prior, c })}`);
        }
        assert.ok(checked > 200, `enough batches with removes (${checked})`);
    });
});
