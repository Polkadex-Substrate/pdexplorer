// What an unlock really frees (mainnet-fork test of the lock buttons, Nov
// 2026). Remove votes and unlock, Withdraw and Cancel vote all worked, but the
// texts around them misled, above all for votes cast with staked PDEX: staking
// is a hold, a vote lock overlaps it, so clearing the lock can add little or
// nothing to Transferable.
//
//   lib/lock-actions.js        what an unlock adds to Transferable (the
//                              reducible balance before and after) and the
//                              part of the cleared lock that stays staked
//   lib/balance-locks-view.js  the unlock line, the conviction line, and the
//                              re-read after an action (?fresh=1)
//   lib/balance-locks.js       the democracy row after a cancel; unbonding
//                              chunks ready to withdraw vs still unbonding
//   lib/balance-locks-api.js   ?fresh=1 is no-store
//   lib/tx-status.js           the status card after an unlock
//   lib/help-topics.js         /help/locked-balance on votes with staked PDEX
//
// Every amount and account here is made up (public repo).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { lockActions, lockActionSpec } from '../lib/lock-actions.js';
import { describeAccountLocks } from '../lib/balance-locks.js';
import { registerBalanceLocksRoute } from '../lib/balance-locks-api.js';
import { renderBalanceLocks, mountBalanceLocks } from '../lib/balance-locks-view.js';
import { readAccountLocks } from '../lib/balance-locks-chain.js';
import { successCopy } from '../lib/tx-status.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { readRepo, stripComments } from './helpers/source.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';

const PDEX = 10n ** 12n;
const s = (v) => v.toString();
const DAY = 86400000;
const BLOCK = 1_000_000;
const PERIOD = 216000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const ME = 'esm9mgCefMrQ2EbGGyMNXGAFA3vnRGDid7GheURpcFRTjyokX';   // 0x11..11 at prefix 88
const same = (a, b) => String(a) === String(b);

function snap(over = {}) {
    return {
        address: ME, now: NOW, free: s(100n * PDEX), reserved: '0', frozen: '0', ed: s(PDEX),
        block: BLOCK, blockMs: 12000, bondingDays: 28, eraMs: DAY,
        locks: [], freezes: [], holds: [], reserves: [],
        staking: { bonded: false, total: '0', active: '0', unlocking: '0', chunks: [], currentEra: null, activeEra: null, activeEraStart: null, spans: 0, controller: null, stash: null },
        democracy: null, elections: null, identity: null, proxy: null,
        pallets: { vesting: false, ormlVesting: false },
        ...over
    };
}
const lock = (id, amount) => ({ id, amount: s(amount), reasons: 'All' });
const staked = (amount) => ({ bonded: true, total: s(amount), active: s(amount), unlocking: '0', chunks: [], currentEra: 100, activeEra: 100, activeEraStart: NOW, spans: 0, controller: ME, stash: ME });
const stakeHold = (amount) => ({ reserved: s(amount), holds: [{ id: 'Staking.Staking', amount: s(amount) }], staking: staked(amount) });
// One finished vote on the losing side: removable now, and the unlock clears the whole vote lock.
const lostVote = (amount) => ({ delegating: false, lockingPeriod: PERIOD, prior: { until: 0, amount: '0' },
    votes: [{ index: 4, aye: false, conviction: 'None', balance: s(amount) }], referenda: { 4: { finished: true, approved: true, end: 900_000 } } });

const VOTED_STAKED = snap({ free: s(12n * PDEX), frozen: s(400n * PDEX), locks: [lock('democrac', 400n * PDEX)], ...stakeHold(500n * PDEX), democracy: lostVote(400n * PDEX) });
const VOTED_MIXED = snap({ free: s(310n * PDEX), frozen: s(300n * PDEX), locks: [lock('democrac', 300n * PDEX)], ...stakeHold(100n * PDEX), democracy: lostVote(300n * PDEX) });
const VOTED_LEGACY = snap({ free: s(310n * PDEX), frozen: s(300n * PDEX), locks: [lock('staking ', 300n * PDEX), lock('democrac', 300n * PDEX)],
    staking: staked(300n * PDEX), democracy: lostVote(300n * PDEX) });
const VOTED_FREE = snap({ frozen: s(40n * PDEX), locks: [lock('democrac', 40n * PDEX)], democracy: lostVote(40n * PDEX) });
const UNDER_COUNCIL = snap({ frozen: s(50n * PDEX), locks: [lock('phrelect', 50n * PDEX), lock('democrac', 40n * PDEX)], democracy: lostVote(40n * PDEX) });

describe('unlock: what it adds to Transferable, and what stays staked', () => {
    const dem = (sn) => lockActions(sn).democracy;
    test('voted with staked PDEX: the vote lock clears, nothing becomes spendable, all of it stays staked', () => {
        const d = dem(VOTED_STAKED);
        assert.equal(d.unlock, true);
        assert.equal(d.freed, s(400n * PDEX), 'the vote lock itself still clears in full');
        assert.equal(d.spendable, '0');
        assert.equal(d.staysStaked, s(400n * PDEX));
    });
    test('partly staked: Transferable rises by the unstaked part, less the ED the lock used to cover; the staked part stays', () => {
        const d = dem(VOTED_MIXED);
        assert.equal(d.spendable, s(199n * PDEX), '310 - (300 - 100) = 110 before, 310 - ED = 309 after');
        assert.equal(d.staysStaked, s(100n * PDEX));
    });
    test('a legacy staking lock overlaps the vote the same way', () => {
        const d = dem(VOTED_LEGACY);
        assert.equal(d.spendable, '0');
        assert.equal(d.staysStaked, s(300n * PDEX));
    });
    test('nothing staked: the gain is the whole Transferable change, nothing is called staked', () => {
        const d = dem(VOTED_FREE);
        assert.equal(d.spendable, s(39n * PDEX), '100 - 40 = 60 before, 100 - ED = 99 after');
        assert.equal(d.staysStaked, '0');
    });
    test('a larger lock remains: nothing becomes spendable, and nothing is called staked', () => {
        const d = dem(UNDER_COUNCIL);
        assert.equal(d.spendable, '0');
        assert.equal(d.staysStaked, '0');
    });
    test('the gain is the Transferable card after the unlock less the card now', () => {
        const t = (x) => BigInt(describeAccountLocks(x).balance.transferable);
        for (const sn of [VOTED_STAKED, VOTED_MIXED, VOTED_LEGACY, VOTED_FREE, UNDER_COUNCIL]) {
            const locks = sn.locks.filter(l => l.id !== 'democrac');
            const frozen = locks.reduce((a, l) => (BigInt(l.amount) > a ? BigInt(l.amount) : a), 0n);
            assert.equal(dem(sn).spendable, s(t({ ...sn, locks, frozen: s(frozen), democracy: null }) - t(sn)));
        }
    });
});

const fx393 = loadFixture('metadata-testnet-393.json');
describe('a staked vote read through the real testnet spec 393 codecs', () => {
    test('a staking hold under the vote lock: the model and the panel say it stays staked', async () => {
        const registry = registryFromMetadata(fx393.metadata);
        registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 88 }));
        const T = (pallet, item, v) => {
            const it = registry.metadata.pallets.find(x => x.name.toString() === pallet).storage.unwrap().items.find(i => i.name.toString() === item);
            const name = registry.createLookupType(it.type.isPlain ? it.type.asPlain : it.type.asMap.value);
            return it.modifier.isOptional ? registry.createType(`Option<${name}>`, v) : registry.createType(name, v);
        };
        const num = (n) => ({ toString: () => String(n) });
        const api = {
            consts: { balances: { existentialDeposit: num(PDEX) }, staking: { bondingDuration: num(28), sessionsPerEra: num(6) },
                babe: { epochDuration: num(1200), expectedBlockTime: num(12000) }, democracy: { voteLockingPeriod: num(PERIOD) } },
            tx: {},
            query: {
                system: { account: async () => T('System', 'Account', { data: { free: 12n * PDEX, reserved: 500n * PDEX, frozen: 400n * PDEX } }), number: async () => T('System', 'Number', BLOCK) },
                balances: {
                    locks: async () => T('Balances', 'Locks', [{ id: '0x' + Buffer.from('democrac').toString('hex'), amount: 400n * PDEX, reasons: 'All' }]),
                    freezes: async () => T('Balances', 'Freezes', []),
                    holds: async () => T('Balances', 'Holds', [{ id: { Staking: 'Staking' }, amount: 500n * PDEX }]),
                    reserves: async () => T('Balances', 'Reserves', [])
                },
                staking: {
                    bonded: async () => T('Staking', 'Bonded', ME),
                    ledger: async () => T('Staking', 'Ledger', { stash: ME, total: 500n * PDEX, active: 500n * PDEX, unlocking: [], legacyClaimedRewards: [] }),
                    currentEra: async () => T('Staking', 'CurrentEra', 100),
                    activeEra: async () => T('Staking', 'ActiveEra', { index: 100, start: NOW }),
                    slashingSpans: async () => T('Staking', 'SlashingSpans', null)
                },
                democracy: {
                    votingOf: async () => T('Democracy', 'VotingOf', { Direct: { votes: [[4, { Standard: { vote: { aye: false, conviction: 'None' }, balance: 400n * PDEX } }]],
                        delegations: { votes: 0, capital: 0 }, prior: [0, 0] } }),
                    referendumInfoOf: async () => T('Democracy', 'ReferendumInfoOf', { Finished: { approved: true, end: 900_000 } })
                }
            }
        };
        const m = describeAccountLocks(await readAccountLocks(api, ME));
        assert.equal(m.items.find(i => i.kind === 'hold').id, 'Staking.Staking');
        assert.deepEqual([m.actions.democracy.spendable, m.actions.democracy.staysStaked], ['0', s(400n * PDEX)]);
        assert.match(renderBalanceLocks(m, { canSign: true }), /Nothing becomes spendable now; 400 PDEX stays staked until you unstake\./);
    });
});

describe('the panel says what the unlock makes spendable', () => {
    const html = (sn, canSign = true) => renderBalanceLocks(describeAccountLocks(sn), { canSign });
    test('voted with staked PDEX: nothing spendable, the PDEX stays staked; the whole lock is never promised', () => {
        const h = html(VOTED_STAKED);
        assert.match(h, /data-lock-action="democracy-unlock"/);
        assert.match(h, /Nothing becomes spendable now; 400 PDEX stays staked until you unstake\./);
        assert.doesNotMatch(h, /Frees/);
    });
    test('partly staked: both parts, apart', () => {
        assert.match(html(VOTED_MIXED), /199 PDEX becomes spendable now; 100 PDEX stays staked until you unstake\./);
    });
    test('nothing staked: only the spendable part', () => {
        const h = html(VOTED_FREE);
        assert.match(h, /39 PDEX becomes spendable now\./);
        assert.doesNotMatch(h, /stays staked/);
    });
    test('visitors read the same line, without the button', () => {
        const h = html(VOTED_STAKED, false);
        assert.doesNotMatch(h, /data-lock-action="democracy-unlock"/);
        assert.match(h, /400 PDEX stays staked until you unstake/);
    });
    test('a model without the gain (a response the CDN cached before the deploy) makes no claim', () => {
        const m = describeAccountLocks(VOTED_FREE);
        const { spendable, staysStaked, ...older } = m.actions.democracy;
        const h = renderBalanceLocks({ ...m, actions: { ...m.actions, democracy: older } }, { canSign: true });
        assert.match(h, /data-lock-action="democracy-unlock"/);
        assert.doesNotMatch(h, /spendable|stays staked/);
    });
});

describe('the status card after the unlock says the same', () => {
    const card = (sn) => {
        const spec = lockActionSpec('democracy-unlock', describeAccountLocks(sn), ME, { connected: ME, isSame: same });
        return successCopy(spec.key, spec.params, {});
    };
    test('voted with staked PDEX: nothing more spendable, the PDEX stays staked', () => {
        const c = card(VOTED_STAKED);
        assert.match(c.body, /400 PDEX stays staked until you unstake/);
        assert.doesNotMatch(c.body, /is unlocked|About 400/);
    });
    test('partly staked, and nothing staked', () => {
        assert.match(card(VOTED_MIXED).body, /About 199 PDEX is now spendable; 100 PDEX stays staked until you unstake\./);
        const free = card(VOTED_FREE).body;
        assert.match(free, /About 39 PDEX is now spendable\./);
        assert.doesNotMatch(free, /staked/);
    });
});

// A vote on a running referendum, and a smaller prior lock from an earlier
// conviction vote that is still running (until two days from now).
const RUNNING_AND_PRIOR = snap({ free: s(400n * PDEX), frozen: s(300n * PDEX), locks: [lock('democrac', 300n * PDEX)],
    democracy: { delegating: false, lockingPeriod: PERIOD, prior: { until: BLOCK + 14400, amount: s(10n * PDEX) },
        votes: [{ index: 9, aye: true, conviction: 'Locked1x', balance: s(300n * PDEX) }], referenda: { 9: { ongoing: true, end: 1_050_000 } } } });
const AFTER_CANCEL = { ...RUNNING_AND_PRIOR, democracy: { ...RUNNING_AND_PRIOR.democracy, votes: [], referenda: {} } };
const democracyRow = (sn) => describeAccountLocks(sn).items.find(i => i.id === 'democrac');

describe('the conviction line names only the prior lock', () => {
    test('a running vote and a smaller prior: the prior amount and its end, not the whole lock', () => {
        const h = renderBalanceLocks(describeAccountLocks(RUNNING_AND_PRIOR), { canSign: true });
        assert.match(h, /10 PDEX stays locked until block 1,014,400 \(about 2026-11-07\) \(conviction lock\)\./);
        assert.doesNotMatch(h, /300 PDEX stays locked until block/);
    });
});

describe('after a cancel the democracy row names only the prior lock', () => {
    test('the prior amount and its end; the rest unlocks now, with the Unlock button', () => {
        assert.equal(democracyRow(AFTER_CANCEL).unlock,
            '10 PDEX stays locked until block 1014400 (about 2 days); the rest can be unlocked now: press Unlock (democracy.unlock for your address).');
    });
    test('the row agrees with the button line next to it', () => {
        const h = renderBalanceLocks(describeAccountLocks(AFTER_CANCEL), { canSign: true });
        assert.match(h, /290 PDEX becomes spendable now\./);
        assert.doesNotMatch(h, /Locked until block/);
    });
    test('a prior holding the whole lock: its amount and end, then Unlock', () => {
        const all = { ...AFTER_CANCEL, democracy: { ...AFTER_CANCEL.democracy, prior: { until: BLOCK + 14400, amount: s(300n * PDEX) } } };
        assert.equal(democracyRow(all).unlock, '300 PDEX stays locked until block 1014400 (about 2 days). After that, press Unlock (democracy.unlock for your address).');
    });
});

// Running votes only: Cancel vote, then the next Unlock.
const RUNNING_STAKED = snap({ free: s(12n * PDEX), frozen: s(400n * PDEX), locks: [lock('democrac', 400n * PDEX)], ...stakeHold(500n * PDEX),
    democracy: { delegating: false, lockingPeriod: PERIOD, prior: { until: 0, amount: '0' },
        votes: [{ index: 9, aye: true, conviction: 'Locked1x', balance: s(400n * PDEX) }], referenda: { 9: { ongoing: true, end: 1_050_000 } } } });
const TWO_RUNNING = snap({ free: s(400n * PDEX), frozen: s(300n * PDEX), locks: [lock('democrac', 300n * PDEX)],
    democracy: { delegating: false, lockingPeriod: PERIOD, prior: { until: 0, amount: '0' },
        votes: [{ index: 9, aye: true, conviction: 'None', balance: s(300n * PDEX) }, { index: 10, aye: false, conviction: 'None', balance: s(300n * PDEX) }],
        referenda: { 9: { ongoing: true, end: 1_050_000 }, 10: { ongoing: true, end: 1_060_000 } } } });

describe('the card after Cancel vote says what the next Unlock frees', () => {
    const card = (sn) => {
        const spec = lockActionSpec('democracy-cancel', describeAccountLocks(sn), ME, { connected: ME, isSame: same, ref: 9 });
        return successCopy(spec.key, spec.params, {}).body;
    };
    test('voted with staked PDEX: nothing more spendable, the PDEX stays staked; never "released"', () => {
        const b = card(RUNNING_STAKED);
        assert.match(b, /The next Unlock makes nothing more spendable; 400 PDEX stays staked until you unstake\./);
        assert.doesNotMatch(b, /released/);
    });
    test('nothing staked: the gain once the vote is gone, the prior lock kept', () => {
        assert.match(card(RUNNING_AND_PRIOR), /The next Unlock makes about 290 PDEX spendable\./);
    });
    test('another running vote still holds the lock: nothing more spendable, nothing called staked', () => {
        const b = card(TWO_RUNNING);
        assert.match(b, /The next Unlock makes nothing more spendable\./);
        assert.doesNotMatch(b, /staked/);
    });
    test('params without the gain (a model cached before the deploy) make no claim', () => {
        assert.equal(successCopy('democracy.removeVote', { ref: 9 }, {}).body, 'Your vote on referendum #9 is removed and no longer counts.');
    });
});

describe('unbonding chunks: ready to withdraw and still unbonding, apart', () => {
    const row = (chunks) => describeAccountLocks(snap({ ...stakeHold(30n * PDEX),
        staking: { ...staked(30n * PDEX), active: s(10n * PDEX), unlocking: s(20n * PDEX), chunks, currentEra: 101, activeEra: 101, activeEraStart: Date.UTC(2026, 10, 5) } }))
        .items.find(i => i.kind === 'hold');
    test('a matured chunk reads ready to withdraw now, never "already unbonding"', () => {
        const r = row([{ value: s(20n * PDEX), era: 100 }]);
        assert.match(r.unlock, /20 PDEX is ready to withdraw now\./);
        assert.doesNotMatch(r.unlock, /already unbonding|[Ss]till unbonding/);
    });
    test('ready and pending apart, the pending one with its era and date', () => {
        const r = row([{ value: s(15n * PDEX), era: 100 }, { value: s(5n * PDEX), era: 104 }]);
        assert.match(r.unlock, /15 PDEX is ready to withdraw now\. Still unbonding: 5 PDEX from era 104, about 2026-11-08\./);
    });
    test('nothing matured: only what is still unbonding, with when', () => {
        const r = row([{ value: s(20n * PDEX), era: 104 }]);
        assert.doesNotMatch(r.unlock, /ready to withdraw/);
        assert.match(r.unlock, /Still unbonding: 20 PDEX from era 104, about 2026-11-08\./);
    });
});

describe('the refresh after an action asks for fresh data', () => {
    let server, base;
    const SHORT = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
    before(async () => {
        const num = (n) => ({ toString: () => String(n) });
        const api = {
            consts: { balances: { existentialDeposit: num(PDEX) } }, tx: {},
            query: { system: { account: async () => ({ data: { free: num(100n * PDEX), reserved: num(0), frozen: num(0) } }) }, balances: {} }
        };
        const app = express();
        registerBalanceLocksRoute(app, { api: () => api, ready: () => true, gate: (req) => ({ address: req.params.address }),
            cacheShort: (res) => res.set('Cache-Control', SHORT), isFresh: (q) => q.fresh === '1', serverError: (res) => res.status(500).json({}) });
        await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => { if (server) server.close(); });
    const cache = async (p) => (await fetch(base + p)).headers.get('cache-control');
    test('?fresh=1 is no-store, so neither the CDN nor the browser keeps it; the plain read keeps the short tier', async () => {
        assert.equal(await cache(`/api/account/${ME}/locks?fresh=1`), 'no-store');
        assert.equal(await cache(`/api/account/${ME}/locks`), SHORT);
    });
    test('server.js gives the locks route the shared ?fresh=1 check', () => {
        assert.match(stripComments(readRepo('server.js', import.meta.url)), /registerBalanceLocksRoute\(app, \{[^}]*isFresh: isFreshRequest[^}]*\}\)/);
    });
    test('the panel re-reads with ?fresh=1 and cache no-store after a successful action; the first paint does not', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const model = { address: ME, ...describeAccountLocks(VOTED_FREE) };
        const reads = [], submits = [];
        let handler = null;
        const el = { isConnected: true, innerHTML: '', addEventListener: (type, fn) => { if (type === 'click') handler = fn; },
            querySelectorAll: () => [], querySelector: () => ({ textContent: '', className: '' }) };
        await mountBalanceLocks(el, ME, { fetchJson: async (url, o) => { reads.push([url, o]); return model; }, helpIcon: () => '',
            actions: { submit: async (o) => { submits.push(o); }, connected: () => ME, isSame: same, api: () => ({}) } });
        const button = { textContent: 'Remove votes and unlock', getAttribute: (k) => (k === 'data-lock-action' ? 'democracy-unlock' : null), closest() { return this; } };
        handler({ target: button });
        await new Promise(r => setImmediate(r));
        assert.equal(submits.length, 1);
        await submits[0].onSuccess();
        t.mock.timers.tick(2500);
        for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
        assert.deepEqual(reads.map(r => r[0]), [`/api/account/${ME}/locks`, `/api/account/${ME}/locks?fresh=1`]);
        assert.equal(reads[0][1], undefined, 'the first paint may come from the short cache tier');
        assert.equal(reads[1][1] && reads[1][1].cache, 'no-store');
    });
});

describe('help: votes with staked PDEX', () => {
    test('/help/locked-balance says the PDEX stays staked, as the how-to post does', () => {
        const t = HELP_TOPICS.find(x => x.slug === 'locked-balance');
        const text = t.body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
        assert.ok(text.includes('Voted with staked PDEX? Unlocking clears the vote lock, and your PDEX stays staked until you unstake.'), 'the staked-vote line is missing');
    });
});
