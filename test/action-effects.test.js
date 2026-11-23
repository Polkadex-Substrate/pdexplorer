// The effects table (design 2026-11-22-post-action-refresh-design.md, sections 0, 2.3, 3, 4): per action key,
// which accounts and data domains change, what evidence proves it and, for the payout, which rows are
// PROVEN paid. Table-driven: a fake event list and params in, changes, known and later out.
//
// The payout rule (section 0): PayoutStarted for (era, validator) does NOT prove this nominator was paid
// (runtime 392 pays the next unpaid page). Only a staking.Rewarded { stash = this account } inside that
// batch item does, attributed by position (lib/reward-attribution.js). Items without that proof, and
// skipped items, are HELD (UX U7, U8, hook H1): never overlaid as paid, never offered again inside the
// hold, offered again after it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { effectsFor, EFFECTS, DOMAINS, SOURCE } from '../lib/action-effects.js';
import { evaluateEvents } from '../lib/tx-status.js';
import { ME, OTHER, V1, PAIRS, keyOf, REGISTRY, paidItem, otherPageItem, skippedItem, forceBatch,
    payoutStarted, rewarded, success, feePaid, itemCompleted, itemFailed } from './helpers/payout-events.js';

const outcomeOf = (key, events, params = {}) => evaluateEvents(events, REGISTRY, { actionKey: key, params });
const payout = (events, { pairs = PAIRS, stage = 'inBlock', account = ME, outcome } = {}) => {
    const params = { k: pairs.length, remaining: 0, account, pairs };
    return effectsFor({ key: 'staking.payout', params, stage, events, blockNumber: 77, txHash: '0xab', signer: ME,
        outcome: outcome === undefined ? outcomeOf('staking.payout', events, params) : outcome });
};
const removes = (eff) => eff.known.filter(k => k.op === 'remove').map(k => k.key).sort();
const holds = (eff) => eff.known.filter(k => k.op === 'hold').map(k => k.key).sort();

describe('payout evidence', () => {
    test('a block whose events hold Rewarded for this account in every item proves those rows', () => {
        const eff = payout(forceBatch(...PAIRS.map(p => paidItem(p))));
        assert.deepEqual(removes(eff), PAIRS.map(keyOf).sort());
        assert.deepEqual(holds(eff), []);
        for (const k of eff.known) { assert.equal(k.account, ME); assert.equal(k.domain, 'rewards.unpaid'); }
        const mine = eff.changes.find(c => c.account === ME);
        assert.deepEqual(mine.domains, ['rewards.unpaid', 'rewards.claimed', 'balance', 'staking.ledger', 'tx.recent']);
        assert.deepEqual(eff.later, []);
    });
    test('PayoutStarted alone proves nothing: the row is held, not removed', () => {
        const single = [payoutStarted(501, V1), rewarded(V1), rewarded(OTHER), feePaid(), success()];
        const eff = payout(single, { pairs: [PAIRS[0]] });
        assert.deepEqual(removes(eff), []);
        assert.deepEqual(holds(eff), [keyOf(PAIRS[0])]);
        const batch = payout(forceBatch(...PAIRS.map(otherPageItem)));
        assert.deepEqual(removes(batch), []);
        assert.deepEqual(holds(batch), PAIRS.map(keyOf).sort());
    });
    test('a single call with Rewarded for this account proves its one row', () => {
        const eff = payout([payoutStarted(501, V1), rewarded(V1), rewarded(ME), feePaid(), success()], { pairs: [PAIRS[0]] });
        assert.deepEqual(removes(eff), [keyOf(PAIRS[0])]);
    });
    test('mixed batch: one AlreadyClaimed item is held, the paid items are proven, the outcome is a warn success', () => {
        const events = forceBatch(paidItem(PAIRS[0]), skippedItem(), paidItem(PAIRS[2]));
        const o = outcomeOf('staking.payout', events);
        assert.equal(o.ok, true);
        assert.equal(o.tone, 'warn');
        const eff = payout(events);
        assert.deepEqual(removes(eff), [keyOf(PAIRS[0]), keyOf(PAIRS[2])].sort());
        assert.deepEqual(holds(eff), [keyOf(PAIRS[1])]);
    });
    test('attribution is by position: a Rewarded for this account in item 2 does not prove item 1', () => {
        const eff = payout(forceBatch(otherPageItem(PAIRS[0]), paidItem(PAIRS[1]), otherPageItem(PAIRS[2])));
        assert.deepEqual(removes(eff), [keyOf(PAIRS[1])]);
        assert.deepEqual(holds(eff), [keyOf(PAIRS[0]), keyOf(PAIRS[2])].sort());
    });
    test('all items failed: a failure, no effects at all', () => {
        const events = forceBatch(skippedItem(), skippedItem(), skippedItem());
        assert.equal(outcomeOf('staking.payout', events).ok, false);
        assert.equal(payout(events), null);
    });
    test('unconfirmed after a clean In block: the events were read, the same proof applies', () => {
        const eff = payout(forceBatch(...PAIRS.map(p => paidItem(p))), { stage: 'unconfirmed' });
        assert.deepEqual(removes(eff), PAIRS.map(keyOf).sort());
    });
    test('usurped, dropped, failed, cancelled, waiting, processed, unverified: nothing may be claimed', () => {
        for (const stage of ['failed', 'cancelled', 'waiting', 'processed', 'unverified', 'signing', 'broadcast', 'confirmed']) {
            assert.equal(payout(forceBatch(...PAIRS.map(p => paidItem(p))), { stage, outcome: stage === 'confirmed' ? { ok: true } : null }), null, stage);
        }
        assert.equal(payout([], { outcome: null }), null, 'no outcome');
        assert.equal(payout(forceBatch(...PAIRS.map(p => paidItem(p))), { outcome: { ok: false } }), null, 'outcome not ok');
    });
    test('an unattributable batch (delimiter count is not the item count) proves nothing: every row held', () => {
        // A nested batch emits extra delimiters (lib/reward-attribution.js LIMIT).
        const events = [...paidItem(PAIRS[0]), itemCompleted(), ...paidItem(PAIRS[1]), ...paidItem(PAIRS[2]), feePaid(), success()];
        const eff = payout(events);
        assert.deepEqual(removes(eff), []);
        assert.deepEqual(holds(eff), PAIRS.map(keyOf).sort());
    });
    test('a Rewarded for another stash in this account\'s place proves nothing', () => {
        const eff = payout(forceBatch(...PAIRS.map(p => paidItem(p, OTHER))));
        assert.deepEqual(removes(eff), []);
    });
    test('without the batch pairs in params: changes only, no known result', () => {
        const events = forceBatch(...PAIRS.map(p => paidItem(p)));
        const eff = effectsFor({ key: 'staking.payout', params: { k: 3 }, stage: 'inBlock', events, blockNumber: 77, txHash: '0xab', signer: ME, outcome: outcomeOf('staking.payout', events) });
        assert.deepEqual(eff.known, []);
        assert.ok(eff.changes.length >= 1);
    });
    test('the address comparison is injectable (SS58 prefixes differ between the wallet and the chain)', () => {
        const events = forceBatch(...PAIRS.map(p => paidItem(p, 'chain-format-of-me')));
        const params = { account: ME, pairs: PAIRS };
        const eff = effectsFor({ key: 'staking.payout', params, stage: 'inBlock', events, blockNumber: 77, txHash: '0xab', signer: ME,
            outcome: outcomeOf('staking.payout', events), same: (a, b) => (a === 'chain-format-of-me' ? ME : a) === (b === 'chain-format-of-me' ? ME : b) });
        assert.equal(removes(eff).length, 3);
    });
    test('an item that failed with another error than AlreadyClaimed is held as well (nothing proven)', () => {
        const eff = payout(forceBatch(paidItem(PAIRS[0]), [itemFailed({ isModule: true, asModule: {} })], paidItem(PAIRS[2])));
        assert.deepEqual(holds(eff), [keyOf(PAIRS[1])]);
    });
});

// R2, review follow-up F6: a held row keeps WHY it is held. The UX spec has one wording for both (S2, S3, and
// S15 after the deadline), so the reason changes no string; it is stored for the copy and the diagnostics.
describe('F6: the hold reason', () => {
    const reasons = (eff) => Object.fromEntries(eff.known.map(k => [k.key, k.op === 'hold' ? k.value : (k.value === null ? 'proven' : k.value)]));
    test('an item that completed without a Rewarded for this account: noReward; a failed item: itemFailed; a proven row: no value', () => {
        const eff = payout(forceBatch(paidItem(PAIRS[0]), otherPageItem(PAIRS[1]), skippedItem()));
        assert.deepEqual(reasons(eff), { [keyOf(PAIRS[0])]: 'proven', [keyOf(PAIRS[1])]: 'noReward', [keyOf(PAIRS[2])]: 'itemFailed' });
    });
    test('a single call that succeeded without a Rewarded for this account: noReward', () => {
        const eff = payout([payoutStarted(501, V1), rewarded(V1), rewarded(OTHER), feePaid(), success()], { pairs: [PAIRS[0]] });
        assert.deepEqual(reasons(eff), { [keyOf(PAIRS[0])]: 'noReward' });
    });
    test('a batch that cannot be attributed: unattributable for every row', () => {
        const events = [...paidItem(PAIRS[0]), itemCompleted(), ...paidItem(PAIRS[1]), ...paidItem(PAIRS[2]), feePaid(), success()];
        assert.deepEqual(Object.values(reasons(payout(events))), ['unattributable', 'unattributable', 'unattributable']);
    });
    test('a failed item with another error than AlreadyClaimed is itemFailed as well', () => {
        const eff = payout(forceBatch(paidItem(PAIRS[0]), [itemFailed({ isModule: true, asModule: {} })], paidItem(PAIRS[2])));
        assert.equal(reasons(eff)[keyOf(PAIRS[1])], 'itemFailed');
    });
});

// Every other action key: domains and evidence, no known results in R1.
const OK = { ok: true, tone: 'ok' };
const TABLE = [
    ['staking.bondNominate', {}, ['balance', 'staking.ledger', 'staking.nominations', 'locks', 'tx.recent'], 'events', ['nextEra']],
    ['staking.unbond', {}, ['staking.ledger', 'staking.nominations', 'locks', 'balance'], 'events', ['afterUnbonding']],
    ['staking.withdraw', {}, ['balance', 'staking.ledger', 'locks'], 'events', []],
    ['staking.migrateCurrency', { stash: OTHER }, ['locks', 'balance'], 'predicate', []],
    ['balances.transfer', { to: OTHER }, ['balance', 'locks', 'tx.recent'], 'events', []],
    ['identity.set', {}, ['identity', 'balance'], 'events', []],
    ['identity.clear', {}, ['identity', 'balance'], 'events', []],
    ['proxy.add', {}, ['proxies', 'balance'], 'events', []],
    ['proxy.remove', {}, ['proxies', 'balance', 'locks'], 'events', []],
    ['democracy.vote', {}, ['democracy', 'locks'], 'live', []],
    ['democracy.second', {}, ['democracy', 'locks'], 'live', []],
    ['democracy.unlock', {}, ['locks', 'democracy', 'balance'], 'events', []],
    ['democracy.removeVote', {}, ['locks', 'democracy', 'balance'], 'events', []],
    ['democracy.undelegate', {}, ['locks', 'democracy', 'balance'], 'events', []],
    ['elections.removeVoter', {}, ['locks', 'council.elections'], 'events', []],
    ['elections.vote', {}, ['council.elections', 'locks'], 'predicate', []],
    ['validator.setup', { stash: OTHER }, ['validator.status', 'staking.ledger', 'balance'], 'predicate', ['nextEra']],
    ['validator.setupStep', { stash: OTHER }, ['validator.status', 'staking.ledger', 'balance'], 'predicate', ['nextEra']],
    ['validator.manage', { stash: OTHER }, ['validator.status', 'staking.ledger'], 'predicate', ['nextEra']]
];

describe('every other action key', () => {
    for (const [key, params, domains, evidence, later] of TABLE) {
        test(`${key}: domains, evidence, no known result in R1, nothing on failure`, () => {
            assert.ok(EFFECTS[key], 'no entry');
            assert.deepEqual(EFFECTS[key].domains, domains);
            assert.equal(EFFECTS[key].evidence, evidence);
            const eff = effectsFor({ key, params, stage: 'inBlock', events: [success()], blockNumber: 9, txHash: '0x1', signer: ME, outcome: OK });
            assert.deepEqual(eff.known, []);
            assert.deepEqual(eff.later.map(l => l.note), later);
            const all = new Set(eff.changes.flatMap(c => c.domains));
            for (const d of domains) assert.ok(all.has(d), `${key} misses ${d}`);
            assert.equal(effectsFor({ key, params, stage: 'failed', events: null, blockNumber: null, txHash: '0x1', signer: ME, outcome: null }), null);
            assert.equal(effectsFor({ key, params, stage: 'inBlock', events: [success()], blockNumber: 9, txHash: '0x1', signer: ME, outcome: { ok: false } }), null);
        });
    }
    test('proxy or stash actions go to the real account R; the fee side stays with the signer S', () => {
        const eff = effectsFor({ key: 'staking.unbond', params: { real: OTHER }, stage: 'inBlock', events: [success()], blockNumber: 9, txHash: '0x1', signer: ME, outcome: OK });
        assert.ok(eff.changes.some(c => c.account === OTHER && c.domains.includes('staking.ledger')));
        assert.ok(eff.changes.some(c => c.account === ME && c.domains.includes('balance')));
        assert.ok(!eff.changes.some(c => c.account === ME && c.domains.includes('staking.ledger')));
    });
    test('a transfer changes the sender and the destination', () => {
        const eff = effectsFor({ key: 'balances.transfer', params: { to: OTHER }, stage: 'inBlock', events: [success()], blockNumber: 9, txHash: '0x1', signer: ME, outcome: OK });
        assert.deepEqual(eff.changes.map(c => c.account).sort(), [ME, OTHER].sort());
    });
    test('multisig: a first approval changes only the pending list; an executed call adds the inner key\'s domains', () => {
        const ms = 'multisig-address';
        const first = effectsFor({ key: 'multisig.transaction', params: { multisig: ms, inner: { key: 'balances.transfer', params: { to: OTHER } } }, stage: 'inBlock', events: [success()], blockNumber: 9, txHash: '0x1', signer: ME, outcome: { ok: true, executed: null, approvalRecorded: true } });
        assert.deepEqual(first.changes, [{ account: ms, domains: ['multisig.pending'] }]);
        const done = effectsFor({ key: 'multisig.transaction', params: { multisig: ms, inner: { key: 'balances.transfer', params: { to: OTHER } } }, stage: 'inBlock', events: [success()], blockNumber: 9, txHash: '0x1', signer: ME, outcome: { ok: true, executed: 'ok' } });
        const domains = new Set(done.changes.filter(c => c.account === ms).flatMap(c => c.domains));
        for (const d of ['multisig.pending', 'balance', 'tx.recent']) assert.ok(domains.has(d), d);
        assert.deepEqual(done.known, []);
    });
    test('an unknown key gives no effects (the guard keeps the table complete)', () => {
        assert.equal(effectsFor({ key: 'nope.nope', params: {}, stage: 'inBlock', events: [success()], blockNumber: 1, txHash: '0x1', signer: ME, outcome: OK }), null);
    });
    test('every domain has a source; every entry names only known domains', () => {
        for (const d of DOMAINS) assert.ok(SOURCE[d], `${d} has no source`);
        for (const [k, e] of Object.entries(EFFECTS)) for (const d of e.domains) assert.ok(DOMAINS.includes(d), `${k}: ${d}`);
        assert.equal(SOURCE['rewards.unpaid'], 'indexed.chain');
    });
});

// R4: governance and treasury (audit rows 10 to 19). The rows that name events (10, 11, 14, 15, 16, 17) claim
// nothing without them; the elections rows carry the proven role (12 from a clean inclusion, held back by the
// page until the chain predicate agrees; 14 from Renounced). Every governance row acts only at an inclusion the
// page saw (inBlock): never on failure and never on an unconfirmed end (UX section 0, line 1).
describe('R4: governance and treasury rows 10 to 19', () => {
    const ev = (section, method, data = []) => ({ event: { section, method, data } });
    const fx = (key, events, { params = {}, stage = 'inBlock', signer = ME } = {}) => effectsFor({ key, params, stage, events, blockNumber: 42, txHash: '0x42', signer,
        outcome: evaluateEvents(events, REGISTRY, { actionKey: key, params }) });
    const HASH = '0x' + 'ab'.repeat(32);
    const voted = (who = ME, section = 'council') => ev(section, 'Voted', [who, HASH, true, 1, 0]);
    const closed = (section = 'council') => [ev(section, 'Closed', [HASH, 3, 0]), ev(section, 'Approved', [HASH]), ev(section, 'Executed', [HASH, { isErr: false, isOk: true }])];
    const domainsOf = (eff) => eff.changes.map(c => [c.account, c.domains]);

    test('the technical committee has its own motions domain, served by its own snapshot', () => {
        assert.ok(DOMAINS.includes('technicalCommittee.motions'));
        assert.equal(SOURCE['technicalCommittee.motions'], 'kv.technicalCommittee');
        assert.deepEqual(EFFECTS['council.vote'].domains, ['council.motions', 'technicalCommittee.motions']);
    });
    test('10 council.vote: the Voted event of this account; the body picks the snapshot; no known result', () => {
        const eff = fx('council.vote', [voted(), success()], { params: { aye: true, idx: 3, body: 'council' } });
        assert.deepEqual(domainsOf(eff), [[ME, ['council.motions']]]);
        assert.deepEqual(eff.known, []);
        const tc = fx('council.vote', [voted(ME, 'technicalCommittee'), success()], { params: { aye: true, idx: 3, body: 'technical committee' } });
        assert.deepEqual(domainsOf(tc), [[ME, ['technicalCommittee.motions']]]);
        assert.equal(fx('council.vote', [success()], { params: { body: 'council' } }), null, 'no Voted event: nothing is claimed or re-read');
        assert.equal(fx('council.vote', [voted(OTHER), success()], { params: { body: 'council' } }), null, 'another account voted');
    });
    test('11 council.close: Closed proves it; the motion card, the treasury overview and democracy follow', () => {
        const eff = fx('council.close', [...closed(), success()], { params: { idx: 3, method: 'spend', body: 'council' } });
        assert.deepEqual(domainsOf(eff), [[ME, ['council.motions', 'treasury.overview', 'democracy']]]);
        const tc = fx('council.close', [...closed('technicalCommittee'), success()], { params: { idx: 3, body: 'technical committee' } });
        assert.deepEqual(domainsOf(tc), [[ME, ['technicalCommittee.motions', 'treasury.overview', 'democracy']]]);
        assert.equal(fx('council.close', [success()], { params: { body: 'council' } }), null);
    });
    test('12 elections.candidacy: a clean inclusion records the role, to be shown once the chain predicate agrees', () => {
        const eff = fx('elections.candidacy', [ev('balances', 'Reserved', [ME, '1000']), success()]);
        assert.deepEqual(domainsOf(eff), [[ME, ['council.elections', 'balance']]]);
        assert.deepEqual(eff.known, [{ account: ME, domain: 'council.elections', op: 'set', key: 'role', value: { role: 'Candidate' } }]);
        assert.equal(EFFECTS['elections.candidacy'].evidence, 'predicate');
    });
    test('13 elections.vote: re-read only; nothing on the page draws the council vote from the server', () => {
        const eff = fx('elections.vote', [success()], { params: { n: 2, stake: '10' } });
        assert.deepEqual(domainsOf(eff), [[ME, ['council.elections', 'locks']]]);
        assert.deepEqual(eff.known, []);
    });
    test('14 elections.withdraw: Renounced for this account proves the role is gone, and from which list', () => {
        for (const [section, role] of [['elections', 'RunnerUp'], ['phragmenElection', 'Candidate'], ['electionsPhragmen', 'Member']]) {
            const eff = fx('elections.withdraw', [ev(section, 'Renounced', [ME]), success()], { params: { role } });
            assert.deepEqual(domainsOf(eff), [[ME, ['council.elections', 'balance']]], section);
            assert.deepEqual(eff.known, [{ account: ME, domain: 'council.elections', op: 'set', key: 'role', value: { role: null, from: role } }], section);
        }
        assert.equal(fx('elections.withdraw', [success()], { params: { role: 'Member' } }), null, 'no Renounced: no claim');
        assert.equal(fx('elections.withdraw', [ev('elections', 'Renounced', [OTHER]), success()], { params: { role: 'Member' } }), null, 'someone else renounced');
    });
    test('15 council.propose: Proposed proves the new motion', () => {
        const eff = fx('council.propose', [ev('council', 'Proposed', [ME, 4, HASH, 2]), success()], { params: {} });
        assert.deepEqual(domainsOf(eff), [[ME, ['council.motions']]]);
        assert.equal(fx('council.propose', [success()]), null);
    });
    test('16 and 17 treasury: public; Paid or SpendProcessed for THIS spend index, nothing else', () => {
        const paid = fx('treasury.payout', [ev('treasury', 'Paid', [7, 1]), success()], { params: { index: 7 } });
        assert.deepEqual(domainsOf(paid), [[null, ['treasury.spends', 'treasury.overview']]]);
        assert.deepEqual(paid.known, []);
        const cleared = fx('treasury.checkStatus', [ev('treasury', 'SpendProcessed', [7]), success()], { params: { index: 7 } });
        assert.deepEqual(domainsOf(cleared), [[null, ['treasury.spends', 'treasury.overview']]]);
        assert.equal(fx('treasury.payout', [ev('treasury', 'Paid', [8, 1]), success()], { params: { index: 7 } }), null, 'another spend was paid');
        assert.equal(fx('treasury.payout', [ev('treasury', 'PaymentFailed', [7, 1]), success()], { params: { index: 7 } }), null, 'the payment failed: the pot did not move');
        assert.equal(fx('treasury.checkStatus', [success()], { params: { index: 7 } }), null);
    });
    test('18 and 19 democracy: the clean inclusion re-reads; the live feed and the stage chip stay the evidence', () => {
        for (const key of ['democracy.vote', 'democracy.second']) {
            const eff = fx(key, [success()], { params: { index: 5 } });
            assert.deepEqual(domainsOf(eff), [[ME, ['democracy', 'locks']]], key);
        }
    });
    test('never on failure, and never on an unconfirmed end: rows 10 to 19 act only at an inclusion seen in block', () => {
        const cases = [['council.vote', [voted(), success()], { body: 'council' }], ['council.close', [...closed(), success()], { body: 'council' }],
            ['elections.candidacy', [success()], {}], ['elections.vote', [success()], {}], ['elections.withdraw', [ev('elections', 'Renounced', [ME]), success()], { role: 'Candidate' }],
            ['council.propose', [ev('council', 'Proposed', [ME, 4, HASH, 2]), success()], {}], ['treasury.payout', [ev('treasury', 'Paid', [7, 1]), success()], { index: 7 }],
            ['treasury.checkStatus', [ev('treasury', 'SpendProcessed', [7]), success()], { index: 7 }], ['democracy.vote', [success()], {}], ['democracy.second', [success()], {}]];
        const failedExtrinsic = ev('system', 'ExtrinsicFailed', [{ isModule: true, asModule: { index: 9, error: 14 } }]);
        for (const [key, events, params] of cases) {
            assert.ok(fx(key, events, { params }), key + ' gives nothing even when proven');
            assert.equal(fx(key, events, { params, stage: 'unconfirmed' }), null, key + ' acted on an unconfirmed end');
            assert.equal(fx(key, [...events.slice(0, -1), failedExtrinsic], { params }), null, key + ' acted on a failed extrinsic');
            for (const stage of ['failed', 'cancelled', 'waiting', 'processed', 'unverified']) assert.equal(fx(key, events, { params, stage }), null, `${key} at ${stage}`);
        }
    });
});
