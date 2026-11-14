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
function palletRun(dem, now, calls) {
    const st = { votes: dem.votes.map(v => ({ ...v, balance: BigInt(v.balance) })), prior: { until: Number(dem.prior.until), amount: BigInt(dem.prior.amount) }, lock: null };
    for (const [op, arg] of calls) {
        if (op === 'removeVote') {
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
            st.lock = st.votes.reduce((a, v) => (v.balance > a ? v.balance : a), st.prior.amount);
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
