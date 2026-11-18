// Validator setup, Sprint 3 (money path): the rules and the one batched
// signature of the setup wizard (cto-team/plans/2026-11-17-validator-onboarding-design.md,
// sections 2.2, 4.3 to 4.6, 5.3 and CEO decision D4). Pure rules in
// lib/validator-setup.js, chain reads in lib/validator-setup-chain.js.
//
// The batch is encoded with the REAL spec 393 codecs (test/fixtures), the
// tracker (lib/tx-submit.js) runs end to end against a fake api, and success
// is decided from events and chain state, never from inclusion alone.
//
// Synthetic accounts: 32 bytes of one repeated value. They belong to no one.

import { test, describe, before, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAddress } from '@polkadot/util-crypto';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import * as S from '../lib/validator-setup.js';
import * as C from '../lib/validator-setup-chain.js';
import { buildTxModel, ACTION_KEYS, PENDING_TITLE } from '../lib/tx-status.js';
import { trackSignedTx, WALLET_CHANGED_UNSIGNED } from '../lib/tx-submit.js';
import { FEE_MARGIN } from '../lib/fee-preflight.js';
import { parseSessionKeys, EXPECTED_LAYOUT, SECRET_TEXT } from '../lib/session-keys.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(91), CTRL = addr(92), OTHER = addr(93), PAYEE = addr(94);
const PDEX = 10n ** 12n;
const rep = (b, n) => b.repeat(n);
const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
const NEWKEYS = { grandpa: '0x' + rep('a1', 32), babe: '0x' + rep('b2', 32), im_online: '0x' + rep('77', 32), authority_discovery: '0x' + rep('c3', 32), mixnet: '0x' + rep('d4', 32), beefy: '0x03' + rep('e5', 32) };
const blob = (k) => '0x' + EXPECTED_LAYOUT.map(l => k[l.name].slice(2)).join('');
const BLOB = blob(KEYS), NEWBLOB = blob(NEWKEYS);
const parsed = (b) => parseSessionKeys(b).keys;

let registry, ex;
before(() => {
    registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
    ex = decorateExtrinsics(registry, registry.metadata, 15);
});

// ── percent and amounts ──
describe('commission in percent to Perbill, integer math (design 4.3)', () => {
    test('whole and two-decimal percents', () => {
        assert.deepEqual(S.parsePercent('5'), { ok: true, perbill: 50_000_000 });
        assert.deepEqual(S.parsePercent(' 7.5 '), { ok: true, perbill: 75_000_000 });
        assert.deepEqual(S.parsePercent('5.25'), { ok: true, perbill: 52_500_000 });
        assert.deepEqual(S.parsePercent('0.01'), { ok: true, perbill: 100_000 });
        assert.deepEqual(S.parsePercent('0'), { ok: true, perbill: 0 });
        assert.deepEqual(S.parsePercent('100'), { ok: true, perbill: 1_000_000_000 });
        assert.deepEqual(S.parsePercent('19.99'), { ok: true, perbill: 199_900_000 });
    });
    test('refused: three decimals, over 100, negative, words, exponent, empty', () => {
        for (const t of ['5.255', '100.01', '101', '-1', 'five', '1e1', '', '.5', '5.']) {
            const r = S.parsePercent(t);
            assert.equal(r.ok, false, t);
            assert.match(r.message, /percent/i, t);
        }
    });
});

describe('PDEX amounts to planck, integer math', () => {
    test('whole, decimals, the smallest unit', () => {
        assert.deepEqual(S.parsePdexAmount('100'), { ok: true, planck: 100n * PDEX });
        assert.deepEqual(S.parsePdexAmount(' 150.5 '), { ok: true, planck: 150n * PDEX + PDEX / 2n });
        assert.deepEqual(S.parsePdexAmount('0.000000000001'), { ok: true, planck: 1n });
    });
    test('refused: more than 12 decimals, signs, separators, words, empty', () => {
        for (const t of ['1.0000000000001', '-5', '+5', '1,000', '1 000', 'ten', '', '0x10', '1e3']) {
            const r = S.parsePdexAmount(t);
            assert.equal(r.ok, false, t);
            assert.ok(r.message, t);
        }
    });
});

// ── commission rules ──
describe('commission rules against the live MinCommission (design 4.3)', () => {
    test('below the live minimum is blocked with its value; at the minimum is fine', () => {
        assert.deepEqual(S.commissionCheck(20_000_000, { minCommission: 30_000_000 }), { ok: false, message: 'The minimum commission on Polkadex is 3%.', warning: '' });
        assert.equal(S.commissionCheck(30_000_000, { minCommission: 30_000_000 }).ok, true);
        // The minimum is whatever the chain says, never a constant here.
        assert.equal(S.commissionCheck(20_000_000, { minCommission: 0 }).ok, true);
        assert.equal(S.commissionCheck(20_000_000, { minCommission: 250_000_000 }).message, 'The minimum commission on Polkadex is 25%.');
    });
    test('an unread minimum blocks: the live value is required', () => {
        const r = S.commissionCheck(50_000_000, { minCommission: null });
        assert.equal(r.ok, false);
        assert.match(r.message, /could not read the minimum commission/);
    });
    test('100% is blocked in setup', () => {
        assert.deepEqual(S.commissionCheck(1_000_000_000, { minCommission: 0 }), { ok: false, message: 'At 100% your nominators earn nothing and the explorer flags your validator to them.', warning: '' });
    });
    test('above 20% is a warning, not a block, with the network median when known', () => {
        const w = S.commissionCheck(250_000_000, { minCommission: 0, median: 50_000_000 });
        assert.equal(w.ok, true);
        assert.equal(w.warning, 'The median commission of active validators is 5%. Nominators sort by commission.');
        assert.equal(S.commissionCheck(250_000_000, { minCommission: 0, median: null }).warning, 'Nominators sort by commission, so a high commission attracts fewer nominators.');
        assert.equal(S.commissionCheck(200_000_000, { minCommission: 0, median: 50_000_000 }).warning, '', '20% itself is not above 20%');
    });
});

// ── bond rules ──
describe('bond rules (design 4.4): the live MinValidatorBond and what can really be bonded', () => {
    const bal = { free: String(1000n * PDEX), reserved: '0', frozen: '0', ed: String(PDEX) };
    test('maxBondable: free minus the fee, the existential deposit (or the uncovered lock) and 1 PDEX kept for later fees', () => {
        assert.equal(S.maxBondable({ ...bal, fee: String(2n * 10n ** 10n) }), 1000n * PDEX - 2n * 10n ** 10n - PDEX - S.WORKING_RESERVE);
        assert.equal(S.WORKING_RESERVE, PDEX);
        assert.equal(S.maxBondable({ ...bal, frozen: String(300n * PDEX), fee: '0' }), 1000n * PDEX - 300n * PDEX - S.WORKING_RESERVE);
        assert.equal(S.maxBondable({ ...bal, fee: null }), 1000n * PDEX - FEE_MARGIN - PDEX - S.WORKING_RESERVE, 'no estimate: the panel fee margin');
        assert.equal(S.maxBondable({ free: String(PDEX), reserved: '0', frozen: '0', ed: String(PDEX), fee: '0' }), 0n, 'never negative');
    });
    const ctx = { minValidatorBond: String(123n * PDEX), max: 997n * PDEX, lowestElected: String(5000n * PDEX) };
    test('bond silently clamps on chain, so an amount above what can be bonded is refused here', () => {
        const r = S.bondCheck(998n * PDEX, ctx);
        assert.equal(r.ok, false);
        assert.equal(r.message, 'That is more than this account can bond. After the network fee and 1 PDEX kept free for later fees, the most is 997 PDEX.');
        assert.equal(S.bondCheck(997n * PDEX, ctx).ok, true);
    });
    test('below the live minimum is blocked; the minimum comes from the chain', () => {
        assert.deepEqual(S.bondCheck(100n * PDEX, ctx), { ok: false, message: 'Validating needs at least 123 PDEX bonded.', warning: '' });
        assert.equal(S.bondCheck(100n * PDEX, { ...ctx, minValidatorBond: String(50n * PDEX) }).ok, true);
        assert.match(S.bondCheck(500n * PDEX, { ...ctx, minValidatorBond: null }).message, /could not read the minimum bond/);
    });
    test('already bonded: what is added counts on top of the active bond', () => {
        assert.equal(S.bondCheck(20n * PDEX, { ...ctx, active: String(100n * PDEX) }).message, 'Validating needs at least 123 PDEX bonded. This stash has 100 PDEX bonded, so add at least 23 PDEX.');
        assert.equal(S.bondCheck(23n * PDEX, { ...ctx, active: String(100n * PDEX) }).ok, true);
        assert.equal(S.bondCheck(0n, { ...ctx, active: String(200n * PDEX), optional: true }).ok, true, 'nothing to add is fine when the bond already meets the minimum');
    });
    test('zero or nothing is refused for a new bond', () => {
        assert.equal(S.bondCheck(0n, ctx).message, 'Enter an amount to bond.');
    });
    test('below the lowest elected backing is a warning, with both numbers', () => {
        const r = S.bondCheck(500n * PDEX, ctx);
        assert.equal(r.ok, true);
        assert.equal(r.warning, '500 PDEX meets the minimum but the lowest elected validator has 5,000 PDEX behind it. You will wait until your own bond plus nominations exceed that.');
    });
});

// ── payee ──
describe('where rewards go: Staked, Stash or another account (design 1.6); never Controller', () => {
    test('the argument for each choice, through the real RewardDestination codec', () => {
        assert.equal(S.payeeArg({ kind: 'staked' }), 'Staked');
        assert.equal(S.payeeArg({ kind: 'stash' }), 'Stash');
        assert.deepEqual(S.payeeArg({ kind: 'account', account: PAYEE }), { Account: PAYEE });
        const dest = (p) => ex.staking.bond(1n, S.payeeArg(p)).args[1];
        assert.equal(dest({ kind: 'staked' }).isStaked, true);
        assert.equal(dest({ kind: 'stash' }).isStash, true);
        assert.equal(dest({ kind: 'account', account: PAYEE }).asAccount.toString(), PAYEE);
    });
    test('Controller and None are not offered; an account choice needs an address', () => {
        assert.throws(() => S.payeeArg({ kind: 'controller' }), /not offered/);
        assert.throws(() => S.payeeArg({ kind: 'none' }), /not offered/);
        assert.throws(() => S.payeeArg({ kind: 'account', account: '' }), /address/);
    });
    test('plain words for the review', () => {
        assert.equal(S.payeeText({ kind: 'staked' }), 'added to the bond');
        assert.equal(S.payeeText({ kind: 'stash' }), 'paid to this stash, unbonded');
        assert.equal(S.payeeText({ kind: 'account', account: PAYEE }, (a) => a.slice(0, 6)), `paid to ${PAYEE.slice(0, 6)}`);
    });
});

// ── the plan for each resume state ──
const fresh = { stash: STASH, bonded: false, controller: null, controllerOf: null, active: '0', validating: false, nextKeys: null, nominations: 0 };
const input = { bond: 500n * PDEX, extra: 0n, payee: { kind: 'staked' }, keys: parsed(BLOB), keysHex: BLOB, commission: 50_000_000 };
const kinds = (p) => p.steps.map(s => s.kind);
describe('planSetup: the batch holds only the missing steps (design 2.2, resumable from chain state)', () => {
    test('a fresh account: bond, register keys, validate, in that order', () => {
        const p = S.planSetup(fresh, input);
        assert.deepEqual(kinds(p), ['bond', 'setKeys', 'validate']);
        assert.equal(p.refusal, null);
        assert.equal(p.nothingToDo, false);
    });
    test('bonded only: keys and validate; bonded and adding: bondExtra first', () => {
        const bonded = { ...fresh, bonded: true, controller: STASH, active: String(500n * PDEX) };
        assert.deepEqual(kinds(S.planSetup(bonded, { ...input, bond: 0n })), ['setKeys', 'validate']);
        assert.deepEqual(kinds(S.planSetup(bonded, { ...input, bond: 0n, extra: 10n * PDEX })), ['bondExtra', 'setKeys', 'validate']);
        assert.equal(S.planSetup(bonded, { ...input, bond: 0n, extra: 10n * PDEX }).steps[0].value, 10n * PDEX);
    });
    test('bonded with these keys already registered: validate only (no setKeys)', () => {
        const s = { ...fresh, bonded: true, controller: STASH, active: String(500n * PDEX), nextKeys: KEYS };
        assert.deepEqual(kinds(S.planSetup(s, { ...input, bond: 0n })), ['validate']);
    });
    test('bonded with other keys registered: kept when the operator keeps them, replaced when new ones are pasted', () => {
        const s = { ...fresh, bonded: true, controller: STASH, active: String(500n * PDEX), nextKeys: NEWKEYS };
        assert.deepEqual(kinds(S.planSetup(s, { ...input, bond: 0n, keys: null, keysHex: '' })), ['validate'], 'Keep them');
        assert.deepEqual(kinds(S.planSetup(s, { ...input, bond: 0n })), ['setKeys', 'validate'], 'Replace them');
    });
    test('already validating with keys: nothing to sign, go to the status', () => {
        const s = { ...fresh, bonded: true, controller: STASH, active: String(500n * PDEX), nextKeys: KEYS, validating: true };
        const p = S.planSetup(s, { ...input, bond: 0n, keys: null, keysHex: '' });
        assert.deepEqual(p.steps, []);
        assert.equal(p.nothingToDo, true);
    });
    test('validating but no keys: register keys only', () => {
        const s = { ...fresh, bonded: true, controller: STASH, active: String(500n * PDEX), validating: true };
        assert.deepEqual(kinds(S.planSetup(s, { ...input, bond: 0n })), ['setKeys']);
    });
    test('no keys pasted and none on chain is not a plan', () => {
        assert.match(S.planSetup(fresh, { ...input, keys: null, keysHex: '' }).refusal, /session keys/);
    });
    test('a legacy controller (Staking.Bonded(stash) is another account) is refused with that account', () => {
        const p = S.planSetup({ ...fresh, bonded: true, controller: CTRL, active: String(500n * PDEX) }, input);
        assert.equal(p.refusal, `This stash is controlled by ${CTRL} (an older setup). The explorer sets up validators signed by the stash itself. Connect that account to change commission or stop validating, or sign 'merge controller into stash' from the stash.`);
        assert.deepEqual(p.steps, []);
    });
    test('the connected account is the controller of another stash: refused, it is not a stash', () => {
        const p = S.planSetup({ ...fresh, controllerOf: OTHER }, input);
        assert.match(p.refusal, new RegExp(`controller of the stash ${OTHER}`));
        assert.deepEqual(p.steps, []);
    });
    test('a stash that nominates is told validating replaces its nominations', () => {
        assert.deepEqual(S.planSetup({ ...fresh, nominations: 3 }, input).notes, ['This stash nominates 3 validators. Validating replaces your nominations.']);
        assert.deepEqual(S.planSetup({ ...fresh, nominations: 1 }, input).notes, ['This stash nominates 1 validator. Validating replaces your nominations.']);
    });
});

// ── the batch, real codecs ──
describe('buildSetupTx: one utility.batchAll, signed by the stash (CEO D4), real spec 393 codecs', () => {
    const api = () => ({ tx: ex });
    const decode = (tx) => registry.createType('Call', tx.toHex());
    test('fresh: batchAll([staking.bond(value, payee), session.setKeys(keys, 0x), staking.validate({ commission, blocked: false })])', () => {
        const tx = S.buildSetupTx(api(), S.planSetup(fresh, input).steps);
        const c = decode(tx);
        assert.equal(`${c.section}.${c.method}`, 'utility.batchAll');
        const calls = c.args[0];
        assert.deepEqual(calls.map(x => `${x.section}.${x.method}`), ['staking.bond', 'session.setKeys', 'staking.validate']);
        assert.equal(calls[0].args[0].toBigInt(), 500n * PDEX);
        assert.equal(calls[0].args[1].isStaked, true);
        assert.equal(calls[1].args[0].toHex(), BLOB, 'the pasted keys, byte for byte, in the runtime order');
        assert.equal(calls[1].args[1].toHex(), '0x', 'proof is empty: ownership_proof_is_valid is the trait default on this SDK');
        assert.equal(calls[2].args[0].commission.toNumber(), 50_000_000);
        assert.equal(calls[2].args[0].blocked.isTrue, false);
    });
    test('the encoding is the metadata\'s: call indexes and the compact bond value', () => {
        const pallet = (n) => registry.metadata.pallets.find(p => p.name.toString() === n);
        const tx = S.buildSetupTx(api(), S.planSetup(fresh, input).steps);
        const u8 = tx.toU8a();
        const utility = pallet('Utility');
        assert.equal(u8[0], utility.index.toNumber());
        const bond = ex.staking.bond(500n * PDEX, 'Staked');
        assert.equal(bond.toU8a()[0], pallet('Staking').index.toNumber());
        assert.ok(tx.toHex().includes(bond.toHex().slice(2)), 'the bond call is embedded as encoded by the metadata');
        assert.ok(tx.toHex().includes(ex.session.setKeys(BLOB, '0x').toHex().slice(2)));
        assert.ok(tx.toHex().includes(ex.staking.validate({ commission: 50_000_000, blocked: false }).toHex().slice(2)));
    });
    test('resume: bonded and adding is bondExtra(max_additional), never a second bond', () => {
        const s = { ...fresh, bonded: true, controller: STASH, active: String(500n * PDEX) };
        const c = decode(S.buildSetupTx(api(), S.planSetup(s, { ...input, bond: 0n, extra: 7n * PDEX }).steps));
        assert.deepEqual(c.args[0].map(x => `${x.section}.${x.method}`), ['staking.bondExtra', 'session.setKeys', 'staking.validate']);
        assert.equal(c.args[0][0].args[0].toBigInt(), 7n * PDEX);
    });
    test('resume: keys identical to the registered ones: validate only, still one batchAll', () => {
        const s = { ...fresh, bonded: true, controller: STASH, active: String(500n * PDEX), nextKeys: KEYS };
        const c = decode(S.buildSetupTx(api(), S.planSetup(s, { ...input, bond: 0n }).steps));
        assert.deepEqual(c.args[0].map(x => `${x.section}.${x.method}`), ['staking.validate']);
    });
    test('another account as payee', () => {
        const c = decode(S.buildSetupTx(api(), S.planSetup(fresh, { ...input, payee: { kind: 'account', account: PAYEE } }).steps));
        assert.equal(c.args[0][0].args[1].asAccount.toString(), PAYEE);
    });
    test('nothing to sign throws in plain words', () => {
        assert.throws(() => S.buildSetupTx(api(), []), /Nothing to sign/);
    });
    test('expected events per plan', () => {
        assert.deepEqual(S.expectedSetupEvents(S.planSetup(fresh, input).steps), ['utility.BatchCompleted', 'staking.Bonded', 'staking.ValidatorPrefsSet']);
        const s = { ...fresh, bonded: true, controller: STASH, active: String(500n * PDEX), validating: true };
        assert.deepEqual(S.expectedSetupEvents(S.planSetup(s, { ...input, bond: 0n }).steps), ['utility.BatchCompleted']);
    });
});

// ── review ──
describe('the review lists each call in plain words with the call name (design 5.3, step 5)', () => {
    test('fresh', () => {
        const items = S.reviewItems(S.planSetup(fresh, input).steps, { shortAddr: (a) => a.slice(0, 6) });
        assert.deepEqual(items.map(i => [i.text, i.call]), [
            ['Bond 500 PDEX, rewards: added to the bond', 'staking.bond'],
            ['Register 6 session keys', 'session.setKeys'],
            ['Ask to validate at 5% commission', 'staking.validate']
        ]);
    });
    test('resume with bondExtra', () => {
        const s = { ...fresh, bonded: true, controller: STASH, active: String(500n * PDEX) };
        assert.equal(S.reviewItems(S.planSetup(s, { ...input, bond: 0n, extra: 2n * PDEX + PDEX / 2n }).steps)[0].text, 'Add 2.5 PDEX to the bond');
    });
    test('the summary line for a batch and for one call', () => {
        assert.equal(S.atomicText(3), 'One signature. If any step fails, none of them apply.');
        assert.equal(S.atomicText(1), 'One signature.');
    });
    test('the warnings panel (design 4.5), each a fact with a number', () => {
        assert.deepEqual(S.SETUP_WARNINGS, [
            'Bonded PDEX takes 28 days to unbond.',
            'If your node is offline for a whole session you earn nothing for it. If 22 or more of 200 validators are offline in the same session, everyone offline is slashed from 0.1% up to 7%.',
            'Two nodes running with the same keys are slashed. Never copy a keystore.',
            'Slashes also hit the people who nominate you.'
        ]);
        assert.equal(S.SLASH_ACK, 'I understand that my bond can be slashed.');
    });
    test('timing from the live parameters: the session after next, and the first era', () => {
        const p = { sessionProgress: 0.5, epochDuration: 1200, blockTimeMs: 12000, currentEra: 500, activeEra: 500, electionPhase: 'Off' };
        assert.equal(S.timingText(p), 'Keys are used from the session after next (about 6 h). The first era you can be elected for is era 501.');
        assert.equal(S.timingText({ ...p, electionPhase: 'Signed' }), 'Keys are used from the session after next (about 6 h). The election for era 501 has started, so the first era you can be elected for is era 502.');
        assert.equal(S.timingText({}), 'Keys are used from the session after next, between 4 and 8 hours from now.');
    });
});

// ── success from events and state ──
const ev = (section, method, data = []) => ({ event: { section, method, data } });
const OK_EVENTS = [ev('staking', 'Bonded', [STASH, '1']), ev('staking', 'ValidatorPrefsSet', [STASH, {}]), ev('utility', 'ItemCompleted'), ev('utility', 'BatchCompleted'), ev('system', 'ExtrinsicSuccess')];
const IN1 = { type: 'InBlock', asInBlock: '0xb1' };
const setupAction = (steps) => ({ id: 'v1', key: S.SETUP_ACTION, params: { expectEvents: S.expectedSetupEvents(steps), summary: 'Bonded, keys registered, asking to validate.' } });
describe('success is decided from the events, never from inclusion (design 4.6)', () => {
    const steps = () => S.planSetup(fresh, input).steps;
    test('the action key has its own copy and pending title', () => {
        assert.ok(ACTION_KEYS.includes('validator.setup'));
        assert.equal(PENDING_TITLE['validator.setup'], 'Setting up your validator');
    });
    test('BatchCompleted, Bonded and ValidatorPrefsSet: success', () => {
        const m = buildTxModel(setupAction(steps()), IN1, OK_EVENTS, null, { registry, blockNumber: 42 });
        assert.notEqual(m.stage, 'failed');
        assert.equal(m.title, 'Validator setup included');
        assert.match(m.body, /Bonded, keys registered, asking to validate\./);
    });
    test('included without ValidatorPrefsSet: not success, says what the chain did not report', () => {
        const m = buildTxModel(setupAction(steps()), IN1, OK_EVENTS.filter(e => e.event.method !== 'ValidatorPrefsSet'), null, { registry, blockNumber: 42 });
        assert.equal(m.stage, 'failed');
        assert.match(m.body, /did not report staking\.ValidatorPrefsSet/);
        assert.match(m.body, /Open validator status before trying again/);
    });
    test('ExtrinsicFailed with a real Staking module error is decoded; nothing applied', () => {
        const staking = registry.metadata.pallets.find(p => p.name.toString() === 'Staking');
        const errs = registry.lookup.getSiType(staking.errors.unwrap().type).def.asVariant.variants;
        const ins = errs.find(v => v.name.toString() === 'InsufficientBond');
        const err = registry.createType('DispatchError', { Module: { index: staking.index.toNumber(), error: [ins.index.toNumber(), 0, 0, 0] } });
        const m = buildTxModel(setupAction(steps()), IN1, [ev('system', 'ExtrinsicFailed', [err])], null, { registry, blockNumber: 42 });
        assert.equal(m.stage, 'failed');
        assert.equal(m.key, 'staking.InsufficientBond');
    });
    test('a batch interrupted at step 2 is a failure naming the step', () => {
        const session = registry.metadata.pallets.find(p => p.name.toString() === 'Session');
        const errs = registry.lookup.getSiType(session.errors.unwrap().type).def.asVariant.variants;
        const dup = errs.find(v => v.name.toString() === 'DuplicatedKey');
        const err = registry.createType('DispatchError', { Module: { index: session.index.toNumber(), error: [dup.index.toNumber(), 0, 0, 0] } });
        const m = buildTxModel(setupAction(steps()), IN1, [ev('staking', 'Bonded', [STASH, '1']), ev('utility', 'BatchInterrupted', [1, err]), ev('system', 'ExtrinsicSuccess')], null, { registry, blockNumber: 42 });
        assert.equal(m.stage, 'failed');
        assert.equal(m.key, 'session.DuplicatedKey');
        assert.match(m.body, /Action 2 in this transaction failed/);
    });
    test('setupApplied: the chain state shows every planned step, keys compared byte for byte', () => {
        const review = { stash: STASH, steps: steps(), keysHex: BLOB };
        const after = { ...fresh, bonded: true, controller: STASH, active: String(500n * PDEX), validating: true, nextKeys: KEYS };
        assert.deepEqual(S.setupApplied(after, review), { applied: true, missing: [] });
        assert.deepEqual(S.setupApplied({ ...after, nextKeys: NEWKEYS }, review), { applied: false, missing: ['keys'] });
        assert.deepEqual(S.setupApplied({ ...after, validating: false }, review), { applied: false, missing: ['validate'] });
        assert.deepEqual(S.setupApplied({ ...after, bonded: false }, review), { applied: false, missing: ['bond'] });
    });
});

// ── sign time ──
describe('sign time: the limits, the balance and the keys are read again (design 4.6)', () => {
    const limits = { minValidatorBond: String(123n * PDEX), minCommission: 30_000_000, maxValidatorsCount: 250, counterForValidators: 217, layout: { ok: true, hexLength: 388, layout: EXPECTED_LAYOUT } };
    const balance = { free: String(1000n * PDEX), reserved: '0', frozen: '0' };
    const review = { stash: STASH, steps: S.planSetup(fresh, input).steps, keys: parsed(BLOB), keysHex: BLOB, bond: 500n * PDEX, extra: 0n, commission: 50_000_000, state: fresh, limits };
    const freshRead = (over = {}) => ({ limits, state: fresh, balance, ed: String(PDEX), fee: String(2n * 10n ** 10n), owners: { owners: [null, null, null, null, null, null], queued: [], nextKeys: null }, ...over });
    test('nothing changed: no problem', () => {
        assert.deepEqual(S.signTimeProblems(freshRead(), review), []);
    });
    test('MinValidatorBond rose above the bond', () => {
        assert.deepEqual(S.signTimeProblems(freshRead({ limits: { ...limits, minValidatorBond: String(600n * PDEX) } }), review),
            ['The minimum bond changed since you reviewed this: it is now 600 PDEX. Go back to Bond and enter a new amount.']);
    });
    test('MinCommission rose above the commission', () => {
        assert.deepEqual(S.signTimeProblems(freshRead({ limits: { ...limits, minCommission: 100_000_000 } }), review),
            ['The minimum commission changed since you reviewed this: it is now 10%. Go back to Commission and enter a new rate.']);
    });
    test('a limit that cannot be read again blocks', () => {
        assert.match(S.signTimeProblems(freshRead({ limits: { ...limits, minCommission: null } }), review)[0], /could not read the minimum bond and commission again/);
    });
    test('the key layout changed', () => {
        assert.match(S.signTimeProblems(freshRead({ limits: { ...limits, layout: { ok: false, layout: null, hexLength: 390 } } }), review)[0], /session key format changed/);
    });
    test('a key is now registered to another account', () => {
        const p = S.signTimeProblems(freshRead({ owners: { owners: [null, OTHER, null, null, null, null], queued: [], nextKeys: null } }), review);
        assert.equal(p[0], `Key 2 (babe) is already registered to ${OTHER}. The chain will reject these keys. If you copied a keystore from another node, stop: running two nodes with the same keys is slashed.`);
    });
    test('the balance fell: the bond is now more than can be bonded (the clamp)', () => {
        const p = S.signTimeProblems(freshRead({ balance: { ...balance, free: String(400n * PDEX) } }), review);
        assert.match(p[0], /^Your balance changed since you reviewed this\. That is more than this account can bond/);
    });
    test('the staking state changed (bonded meanwhile)', () => {
        const p = S.signTimeProblems(freshRead({ state: { ...fresh, bonded: true, controller: STASH, active: String(500n * PDEX) } }), review);
        assert.deepEqual(p, ['This account\'s staking state changed since you reviewed this. Start the setup again.']);
    });
    test('the validator candidate limit is reached (TooManyValidators)', () => {
        assert.deepEqual(S.signTimeProblems(freshRead({ limits: { ...limits, counterForValidators: 250 } }), review),
            ['The chain has reached its limit of 250 validator candidates. Nobody can start validating until one leaves or governance raises the limit.']);
    });
});

// ── chain reads ──
const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const num = (v) => ({ toNumber: () => Number(v), toString: () => String(v), toBigInt: () => BigInt(v) });
const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });
const fakeLayoutRegistry = () => registry;
function fakeApi(o = {}) {
    const st = { minBond: 123n * PDEX, minComm: 30_000_000, bonded: null, ledger: null, validating: false, nextKeys: null, nominators: null, owners: {}, free: 1000n * PDEX, maxCount: 250, counter: 217, fee: 2n * 10n ** 10n, ...o };
    const reads = [];
    const validators = async () => ({ commission: num(0), blocked: { isTrue: false } });
    validators.size = async (a) => { reads.push('validators'); return num(String(a) === STASH && st.validating ? 5 : 0); };
    const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => (...args) => {
        const call = p[m](...args);
        if (sec === 'utility') { call.paymentInfo = async () => ({ partialFee: num(st.fee) }); }
        return call;
    } }) });
    const api = {
        reads, st, registry: fakeLayoutRegistry(),
        runtimeVersion: { specVersion: num(393) },
        consts: { balances: { existentialDeposit: num(PDEX) } },
        tx,
        query: {
            system: { account: async () => ({ nonce: num(0), data: { free: num(st.free), reserved: num(0), frozen: num(0) } }) },
            staking: {
                minValidatorBond: async () => { reads.push('minValidatorBond'); return num(st.minBond); },
                minCommission: async () => { reads.push('minCommission'); return num(st.minComm); },
                maxValidatorsCount: async () => opt(st.maxCount == null ? null : num(st.maxCount)),
                counterForValidators: async () => num(st.counter),
                bonded: async (a) => opt(String(a) === STASH ? st.bonded : null),
                ledger: async (c) => opt(st.ledger && String(c) === st.ledger.controller ? { stash: st.ledger.stash, total: num(st.ledger.active), active: num(st.ledger.active) } : null),
                validators,
                nominators: async () => opt(st.nominators ? { targets: st.nominators } : null)
            },
            session: {
                nextKeys: async (a) => opt(String(a) === STASH && st.nextKeys ? keysCodec(st.nextKeys) : null),
                queuedKeys: async () => [],
                keyOwner: async ([typeId, key]) => { reads.push('keyOwner'); return opt(st.owners[String(key)] || null); }
            }
        }
    };
    return api;
}

describe('chain reads: live limits, the stash state, resume', () => {
    test('readSetupLimits reads MinValidatorBond and MinCommission from storage each time (no literal)', async () => {
        const api = fakeApi();
        const a = await C.readSetupLimits(api);
        assert.equal(a.minValidatorBond, String(123n * PDEX));
        assert.equal(a.minCommission, 30_000_000);
        assert.deepEqual([a.maxValidatorsCount, a.counterForValidators, a.specVersion], [250, 217, 393]);
        assert.equal(a.layout.ok, true);
        assert.equal(a.layout.hexLength, 388);
        api.st.minBond = 777n * PDEX; api.st.minComm = 1;
        const b = await C.readSetupLimits(api);
        assert.deepEqual([b.minValidatorBond, b.minCommission], [String(777n * PDEX), 1]);
        assert.equal(api.reads.filter(r => r === 'minValidatorBond').length, 2);
    });
    test('readSetupState: a fresh account', async () => {
        const s = await C.readSetupState(fakeApi(), STASH);
        assert.deepEqual({ bonded: s.bonded, controller: s.controller, controllerOf: s.controllerOf, active: s.active, validating: s.validating, nextKeys: s.nextKeys, nominations: s.nominations },
            { bonded: false, controller: null, controllerOf: null, active: '0', validating: false, nextKeys: null, nominations: 0 });
        assert.deepEqual(s.balance, { free: String(1000n * PDEX), reserved: '0', frozen: '0' });
        assert.equal(s.ed, String(PDEX));
    });
    test('readSetupState: bonded, keys, validating, nominating', async () => {
        const s = await C.readSetupState(fakeApi({ bonded: STASH, ledger: { controller: STASH, stash: STASH, active: 500n * PDEX }, nextKeys: KEYS, validating: true, nominators: [OTHER, PAYEE] }), STASH);
        assert.deepEqual([s.bonded, s.controller, s.active, s.validating, s.nominations], [true, STASH, String(500n * PDEX), true, 2]);
        assert.deepEqual(s.nextKeys, KEYS);
    });
    test('readSetupState: a legacy controller, and an account that is itself a controller', async () => {
        const legacy = await C.readSetupState(fakeApi({ bonded: CTRL }), STASH);
        assert.equal(legacy.controller, CTRL);
        const ctrl = await C.readSetupState(fakeApi({ ledger: { controller: STASH, stash: OTHER, active: 500n * PDEX } }), STASH);
        assert.equal(ctrl.controllerOf, OTHER);
    });
    test('buildCheckedSetupTx: reads the limits, the balance, the fee and every KeyOwner again, then builds', async () => {
        const api = fakeApi();
        const limits = await C.readSetupLimits(api);
        const review = { stash: STASH, steps: S.planSetup(fresh, input).steps, keys: parsed(BLOB), keysHex: BLOB, bond: 500n * PDEX, extra: 0n, commission: 50_000_000, state: fresh, limits };
        api.reads.length = 0;
        const tx = await C.buildCheckedSetupTx(api, review);
        assert.equal(`${tx.section}.${tx.method}`, 'utility.batchAll');
        assert.equal(api.reads.filter(r => r === 'keyOwner').length, 6, 'each key asked again at signing');
        assert.ok(api.reads.includes('minValidatorBond') && api.reads.includes('minCommission'));
    });
    test('buildCheckedSetupTx: a key taken between review and signing is refused, nothing is built', async () => {
        const api = fakeApi();
        const limits = await C.readSetupLimits(api);
        const review = { stash: STASH, steps: S.planSetup(fresh, input).steps, keys: parsed(BLOB), keysHex: BLOB, bond: 500n * PDEX, extra: 0n, commission: 50_000_000, state: fresh, limits };
        api.st.owners[KEYS.grandpa] = OTHER;
        await assert.rejects(C.buildCheckedSetupTx(api, review), /Key 1 \(grandpa\) is already registered to/);
    });
    test('buildCheckedSetupTx: MinValidatorBond raised between review and signing is refused', async () => {
        const api = fakeApi();
        const limits = await C.readSetupLimits(api);
        const review = { stash: STASH, steps: S.planSetup(fresh, input).steps, keys: parsed(BLOB), keysHex: BLOB, bond: 500n * PDEX, extra: 0n, commission: 50_000_000, state: fresh, limits };
        api.st.minBond = 900n * PDEX;
        await assert.rejects(C.buildCheckedSetupTx(api, review), /The minimum bond changed since you reviewed this: it is now 900 PDEX/);
    });
    test('buildCheckedSetupTx: the real fee estimate is used for the clamp check', async () => {
        const api = fakeApi({ fee: 600n * PDEX });
        const limits = await C.readSetupLimits(api);
        const review = { stash: STASH, steps: S.planSetup(fresh, input).steps, keys: parsed(BLOB), keysHex: BLOB, bond: 500n * PDEX, extra: 0n, commission: 50_000_000, state: fresh, limits };
        await assert.rejects(C.buildCheckedSetupTx(api, review), /more than this account can bond/);
    });
    test('verifySetup: applied only when the ledger, NextKeys equal to the pasted keys and the Validators entry are all there', async () => {
        const review = { stash: STASH, steps: S.planSetup(fresh, input).steps, keysHex: BLOB };
        assert.equal(await C.verifySetup(fakeApi(), review), 'pending');
        const done = { bonded: STASH, ledger: { controller: STASH, stash: STASH, active: 500n * PDEX }, nextKeys: KEYS, validating: true };
        assert.equal(await C.verifySetup(fakeApi(done), review), 'applied');
        assert.equal(await C.verifySetup(fakeApi({ ...done, nextKeys: NEWKEYS }), review), 'pending');
        assert.equal(await C.verifySetup({ query: {} }, review), 'pending', 'an unreadable chain is never applied');
    });
    test('estimateSetupFee: the batch\'s own paymentInfo, or null', async () => {
        assert.equal(await C.estimateSetupFee(fakeApi({ fee: 3n * 10n ** 10n }), STASH, S.planSetup(fresh, input).steps), 3n * 10n ** 10n);
        assert.equal(await C.estimateSetupFee({ tx: {} }, STASH, S.planSetup(fresh, input).steps), null);
    });
});

// ── the tracker, end to end ──
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
function harness({ stillValid } = {}) {
    const listeners = {};
    const api = { registry, on: (e, f) => { (listeners[e] = listeners[e] || []).push(f); }, off: () => {},
        rpc: { chain: { getHeader: async (h) => ({ number: { toNumber: () => (h === '0xb2' ? 43 : 42) } }) } } };
    const shown = [];
    const show = (a, st, evs, err, x) => { const m = buildTxModel(a, st, evs, err, x); shown.push(m); return m; };
    const calls = { onError: [], onSuccess: 0, signed: 0 };
    let cb = null;
    const tx = {
        paymentInfo: async () => ({ partialFee: num(10n ** 10n) }),
        signAsync: async () => { calls.signed++; return { nonce: num(1), send: async (f) => { cb = f; return () => {}; } }; },
        signAndSend: async (a, o, f) => { calls.signed++; cb = f; return () => {}; }
    };
    api.query = { system: { account: async () => ({ nonce: num(0), data: { free: num(1000n * PDEX), reserved: num(0), frozen: num(0) } }) } };
    api.consts = { balances: { existentialDeposit: num(PDEX) } };
    const run = trackSignedTx({ api, show, action: setupAction(S.planSetup(fresh, input).steps), onError: (t) => calls.onError.push(t), onSuccess: () => { calls.onSuccess++; } });
    const emit = async (status, events) => { cb({ status, events, txHash: { toHex: () => '0x' + 'ab'.repeat(32) } }); await flush(); };
    return { run, tx, emit, shown, calls, last: () => shown[shown.length - 1], stillValid };
}
describe('lib/tx-submit.js with the setup action (fake api, real card model)', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());
    test('success: every expected event, onSuccess once', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, STASH, {}, { stillValid: () => true });
        await h.emit({ type: 'Ready' });
        await h.emit(IN1, OK_EVENTS);
        assert.equal(h.calls.onSuccess, 1);
        assert.deepEqual(h.calls.onError, []);
        assert.equal(h.last().title, 'Validator setup included');
    });
    test('a failed event: onError, never onSuccess', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, STASH, {}, { stillValid: () => true });
        await h.emit({ type: 'Ready' });
        await h.emit(IN1, [ev('system', 'ExtrinsicFailed', [{ isBadOrigin: true }])]);
        assert.equal(h.calls.onSuccess, 0);
        assert.equal(h.calls.onError.length, 1);
    });
    test('included without the expected events: onError (no optimism)', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, STASH, {}, { stillValid: () => true });
        await h.emit({ type: 'Ready' });
        await h.emit(IN1, [ev('utility', 'BatchCompleted'), ev('system', 'ExtrinsicSuccess')]);
        assert.equal(h.calls.onSuccess, 0);
        assert.match(h.calls.onError[0], /did not report staking\.Bonded, staking\.ValidatorPrefsSet/);
    });
    test('retracted, then in another block: onSuccess still once', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, STASH, {}, { stillValid: () => true });
        await h.emit({ type: 'Ready' });
        await h.emit(IN1, OK_EVENTS);
        await h.emit({ type: 'Retracted' });
        await h.emit({ type: 'InBlock', asInBlock: '0xb2' }, OK_EVENTS);
        assert.equal(h.calls.onSuccess, 1);
        assert.equal(h.last().stageText, 'In block #43');
    });
    test('the wallet session changed after review: refused before the wallet is asked', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, STASH, {}, { stillValid: () => false });
        assert.equal(h.calls.signed, 0, 'the wallet was asked');
        assert.deepEqual(h.calls.onError, [WALLET_CHANGED_UNSIGNED]);
    });
});

describe('never a seed', () => {
    test('a secret phrase in the keys field is refused before anything else', () => {
        const r = S.keysForSetup('bottom drive obey lake curtain smoke basket hold race lonely fit walk', { layout: EXPECTED_LAYOUT });
        assert.deepEqual(r, { ok: false, message: SECRET_TEXT });
    });
    test('valid keys parse against the live layout', () => {
        const r = S.keysForSetup(BLOB.toUpperCase().replace('0X', '0x'), { layout: EXPECTED_LAYOUT });
        assert.equal(r.ok, true);
        assert.equal(r.keysHex, BLOB);
        assert.equal(r.keys.length, 6);
    });
    test('a layout the explorer does not know switches registration off', () => {
        assert.match(S.keysForSetup(BLOB, { layout: null }).message, /session key format is different/);
    });
});
