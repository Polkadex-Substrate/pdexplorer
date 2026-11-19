// Validator manage, Sprint 4 (money path): the rules behind the manage panel on
// /validate (cto-team/plans/2026-11-17-validator-onboarding-design.md,
// sections 1.6, 1.7, 2.3, 4.3, 4.6, 5.2 and 5.4). Pure rules in
// lib/validator-manage.js, chain reads in lib/validator-manage-chain.js.
//
// Every call is encoded with the REAL spec 393 codecs (test/fixtures), the
// tracker (lib/tx-submit.js) runs end to end against a fake api, and success
// is decided from events and a chain re-read, never from inclusion alone.
//
// Synthetic accounts: 32 bytes of one repeated value. They belong to no one.

import { test, describe, before, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAddress } from '@polkadot/util-crypto';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import * as M from '../lib/validator-manage.js';
import * as C from '../lib/validator-manage-chain.js';
import { buildTxModel, ACTION_KEYS, PENDING_TITLE } from '../lib/tx-status.js';
import { trackSignedTx, WALLET_CHANGED_UNSIGNED } from '../lib/tx-submit.js';
import { parseSessionKeys, EXPECTED_LAYOUT, classifyKeyOwners } from '../lib/session-keys.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(111), CTRL = addr(112), OTHER = addr(113), PAYEE = addr(114), PROXY = addr(115);
const PDEX = 10n ** 12n;
const rep = (b, n) => b.repeat(n);
const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
const NEWKEYS = { grandpa: '0x' + rep('a1', 32), babe: '0x' + rep('b2', 32), im_online: '0x' + rep('77', 32), authority_discovery: '0x' + rep('c3', 32), mixnet: '0x' + rep('d4', 32), beefy: '0x03' + rep('e5', 32) };
const blob = (k) => '0x' + EXPECTED_LAYOUT.map(l => k[l.name].slice(2)).join('');
const BLOB = blob(KEYS), NEWBLOB = blob(NEWKEYS);
const isSame = (a, b) => a === b;

let registry, ex;
before(() => {
    registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
    ex = decorateExtrinsics(registry, registry.metadata, 15);
});

// A validating stash that is its own controller: the common case.
const STATE = Object.freeze({
    stash: STASH, bonded: true, controller: STASH, controllerOf: null, active: String(500n * PDEX), total: String(500n * PDEX), unlocking: [],
    validating: true, prefs: { commission: 50_000_000, blocked: false }, payee: { kind: 'staked', account: '' }, nextKeys: KEYS, nominations: 0, nominating: false,
    balance: { free: String(1000n * PDEX), reserved: '0', frozen: String(500n * PDEX) }, ed: String(PDEX), proxies: [], currentEra: 500
});
const LIMITS = Object.freeze({ minValidatorBond: String(123n * PDEX), minCommission: 30_000_000, minNominatorBond: String(50n * PDEX), maxUnlockingChunks: 32, bondingDuration: 28, sessionsPerEra: 6,
    specVersion: 393, layout: { ok: true, hexLength: 388, layout: EXPECTED_LAYOUT } });
const T = Object.freeze({ activeEra: 500, currentEra: 500, eraEndsIn: 5 * 3600, sessionIndex: 3000, nextSessionIn: 2 * 3600, sessionSeconds: 4 * 3600, eraSeconds: 24 * 3600 });

// ── the menu (design 5.2) ──
describe('the manage menu follows the headline state: secondary actions, at most one primary', () => {
    const kinds = (m) => m.actions.map(a => a.kind);
    test('active and elected-next: change commission, rotate keys, bond more, change payee, stop validating; no primary', () => {
        for (const s of ['active', 'elected-next']) {
            const m = M.manageMenu(s);
            assert.deepEqual(kinds(m), ['commission', 'keys', 'bondExtra', 'payee', 'chill'], s);
            assert.deepEqual(m.actions.map(a => a.label), ['Change commission', 'Rotate keys', 'Bond more', 'Change payee', 'Stop validating'], s);
            assert.equal(m.primary, null, s);
        }
    });
    test('waiting: "Add to your bond" first, then commission and keys (and stop validating)', () => {
        const m = M.manageMenu('waiting');
        assert.deepEqual(kinds(m), ['bondExtra', 'commission', 'keys', 'chill']);
        assert.equal(m.actions[0].label, 'Add to your bond');
        assert.equal(m.primary, null);
    });
    test('active and offline this session: one primary, Open the node checklist', () => {
        assert.deepEqual(M.manageMenu('active', { offline: true }).primary, { label: 'Open the node checklist', href: '/validate/node' });
    });
    test('active-leaving: no commission (validate would ask to validate again) and no stop', () => {
        assert.deepEqual(kinds(M.manageMenu('active-leaving')), ['keys', 'bondExtra', 'payee']);
    });
    test('disabled: nothing to do; setup states and an unbonded account: no manage menu', () => {
        for (const s of ['disabled', 'not-bonded', 'bonded-no-keys', 'keys-not-validating']) assert.deepEqual(kinds(M.manageMenu(s)), [], s);
    });
    test('rebond only while something is unbonding; unbond and withdraw link to the existing wallet flow', () => {
        assert.ok(!kinds(M.manageMenu('active')).includes('rebond'));
        assert.ok(kinds(M.manageMenu('active', { unlocking: true })).includes('rebond'));
        assert.deepEqual(M.manageMenu('active').links.find(l => l.href === '/unstake'), { label: 'Unbond or withdraw', href: '/unstake' });
        assert.deepEqual(M.manageMenu('disabled').links, []);
    });
});

// ── who signs (design 1.6, 1.10) ──
describe('the signer: the stash, or the legacy controller for controller calls; proxies are Sprint 5', () => {
    test('stash calls (bond_extra, set_keys) and controller calls (validate, chill, set_payee, rebond)', () => {
        assert.deepEqual(['commission', 'keys', 'bondExtra', 'payee', 'chill', 'rebond'].map(k => M.signerFor(k, { ...STATE, controller: CTRL })),
            [CTRL, STASH, STASH, CTRL, CTRL, CTRL]);
    });
    test('the stash that is its own controller signs everything', () => {
        for (const k of ['commission', 'keys', 'bondExtra', 'payee', 'chill', 'rebond']) assert.equal(M.signerProblem(k, STATE, STASH, { isSame }), null, k);
    });
    test('a legacy controller: the stash is told to connect the controller for controller calls', () => {
        const s = { ...STATE, controller: CTRL };
        assert.equal(M.signerProblem('commission', s, STASH, { isSame }),
            `This stash is controlled by ${CTRL} (an older setup). Connect that account to change commission or stop validating, or sign 'merge controller into stash' from the stash.`);
        assert.equal(M.signerProblem('keys', s, STASH, { isSame }), null);
        assert.equal(M.signerProblem('chill', s, CTRL, { isSame }), null);
        assert.equal(M.signerProblem('bondExtra', s, CTRL, { isSame }), `Bonding more and registering session keys are signed by the stash ${STASH}. Connect it to do this.`);
    });
    test('a proxy of the stash is detected and told proxy signing comes later; a Staking proxy cannot rotate keys at all', () => {
        const s = { ...STATE, proxies: [{ delegate: PROXY, type: 'Staking', delay: 0 }] };
        assert.equal(M.roleOf(s, PROXY, { isSame }).role, 'proxy');
        assert.equal(M.signerProblem('commission', s, PROXY, { isSame }),
            'You are connected as a Staking proxy of this stash. Acting for a stash through a proxy comes in a later release: connect the stash itself to make this change.');
        assert.match(M.signerProblem('keys', s, PROXY, { isSame }), /A Staking proxy cannot register session keys on this runtime: key rotation needs the stash\.$/);
    });
    test('an unrelated account: no role, and the sentence for a watched account', () => {
        assert.equal(M.roleOf(STATE, OTHER, { isSame }).role, null);
        assert.equal(M.signerProblem('chill', STATE, OTHER, { isSame }), 'Connect the wallet that holds this account to make changes.');
    });
});

// ── commission (design 4.3, 5.4) ──
describe('commission change: old to new, the live minimum, 100% behind a confirmation', () => {
    const ctx = { current: 50_000_000, currentBlocked: false, blocked: false, minCommission: 30_000_000, median: 50_000_000 };
    test('below the live MinCommission is refused with the chain value; the minimum is never a literal', () => {
        assert.deepEqual(M.commissionChange(20_000_000, ctx), { ok: false, message: 'The minimum commission on Polkadex is 3%. The chain refuses a lower rate.', warning: '', needsConfirm: false });
        assert.equal(M.commissionChange(20_000_000, { ...ctx, minCommission: 0 }).ok, true);
        assert.match(M.commissionChange(20_000_000, { ...ctx, minCommission: 250_000_000 }).message, /is 25%\./);
    });
    test('an unread minimum refuses', () => {
        assert.match(M.commissionChange(70_000_000, { ...ctx, minCommission: null }).message, /could not read the minimum commission/);
    });
    test('the same rate and the same blocked flag: nothing would change', () => {
        assert.equal(M.commissionChange(50_000_000, ctx).message, 'That is the current commission. Nothing would change.');
        assert.equal(M.commissionChange(50_000_000, { ...ctx, blocked: true }).ok, true, 'blocking alone is a change');
    });
    test('100% needs the extra confirmation, then passes; Block new nominations is suggested', () => {
        const r = M.commissionChange(1_000_000_000, ctx);
        assert.equal(r.ok, false);
        assert.equal(r.needsConfirm, true);
        assert.equal(r.message, 'At 100% your nominators earn nothing and the explorer flags your validator to them. To stop new nominations instead, use Block new nominations.');
        assert.equal(M.commissionChange(1_000_000_000, { ...ctx, confirmed: true }).ok, true);
    });
    test('above 20% warns with the median; not a block', () => {
        const r = M.commissionChange(250_000_000, ctx);
        assert.equal(r.ok, true);
        assert.equal(r.warning, 'The median commission of active validators is 5%. Nominators sort by commission.');
    });
    test('the review line says old to new and the blocked change', () => {
        assert.equal(M.commissionText({ commission: 70_000_000, blocked: false }, { commission: 50_000_000, blocked: false }), 'Change commission from 5% to 7%');
        assert.equal(M.commissionText({ commission: 50_000_000, blocked: true }, { commission: 50_000_000, blocked: false }), 'Keep commission at 5% and block new nominations');
        assert.equal(M.commissionText({ commission: 70_000_000, blocked: false }, { commission: 50_000_000, blocked: true }), 'Change commission from 5% to 7% and accept new nominations again');
    });
    test('nominators see it, and when it takes effect (the next era, or the one after when the next is already planned)', () => {
        assert.equal(M.COMMISSION_NOTE, 'Your nominators see this change. The explorer keeps a commission history for every validator.');
        assert.equal(M.commissionTimingText(T), 'Applies from era 501, which starts in about 5 h. Rewards until then use the current rate.');
        assert.equal(M.commissionTimingText({ ...T, currentEra: 501 }), 'Applies from era 502, which starts in about 1 d 5 h. Rewards until then use the current rate.');
        assert.equal(M.commissionTimingText({}), 'Applies from the next era. Rewards until then use the current rate.');
        assert.equal(M.BLOCKED_NOTE, 'Blocking new nominations applies at once. Nominators who already nominate you stay.');
    });
});

// ── keys (design 4.2, 5.4) ──
describe('rotate keys: the Sprint 1 checker, KeyOwner conflicts, the old-node rule, never purge', () => {
    const keys = () => parseSessionKeys(NEWBLOB).keys;
    test('keys registered to another account are refused with the checker sentence', () => {
        const c = classifyKeyOwners(keys(), { owners: [null, OTHER, null, null, null, null], stash: STASH, nextKeys: KEYS });
        assert.match(M.rotateKeysProblem(c), /^Key 2 \(babe\) is already registered to /);
    });
    test('the keys already registered to this stash: nothing to sign', () => {
        const same = parseSessionKeys(BLOB).keys;
        const c = classifyKeyOwners(same, { owners: Array(6).fill(STASH), stash: STASH, nextKeys: KEYS });
        assert.equal(M.rotateKeysProblem(c), 'These keys are already registered to this stash. Nothing to sign.');
    });
    test('new keys, free on chain: no problem', () => {
        assert.equal(M.rotateKeysProblem(classifyKeyOwners(keys(), { owners: Array(6).fill(null), stash: STASH, nextKeys: KEYS })), null);
    });
    test('the old-node rule, the timing and what the explorer never does', () => {
        assert.equal(M.ROTATE_RULE, 'Keep the old node running with the old keys until the dashboard says the new keys are in use. Then stop the old node. Never run both with the same keys.');
        assert.equal(M.keysTimingText(T), 'The new keys are used from session 3002, in about 6 h. Until then the chain uses the keys registered now.');
        assert.equal(M.keysTimingText({}), 'The new keys are used from the session after next, between 4 and 8 hours from now. Until then the chain uses the keys registered now.');
        assert.match(M.PURGE_NOTE, /never removes keys/);
    });
    test('no purge_keys call anywhere in the manage modules (purging an active validator drops it from the set)', () => {
        for (const f of ['lib/validator-manage.js', 'lib/validator-manage-chain.js', 'lib/validator-manage-view.js']) {
            assert.doesNotMatch(stripComments(readRepo(f, import.meta.url)), /purgeKeys\s*\(|purge_keys\s*\(/, f);
        }
    });
});

// ── bond more ──
describe('bond more: refused above what can be bonded (bond_extra clamps silently)', () => {
    test('nothing, too much, enough', () => {
        assert.equal(M.bondMoreCheck(0n, { max: 400n * PDEX }).message, 'Enter an amount to add.');
        assert.equal(M.bondMoreCheck(401n * PDEX, { max: 400n * PDEX }).message, 'That is more than this account can bond. After the network fee and 1 PDEX kept free for later fees, the most is 400 PDEX.');
        assert.equal(M.bondMoreCheck(400n * PDEX, { max: 400n * PDEX }).ok, true);
    });
    test('what can be bonded: free minus the uncovered lock, the fee and the kept 1 PDEX', () => {
        assert.equal(M.maxBondMore(STATE, 2n * 10n ** 10n), 1000n * PDEX - 500n * PDEX - 2n * 10n ** 10n - PDEX);
    });
    test('the bonding duration is read live, never written here', () => {
        assert.equal(M.unbondingText({ ...LIMITS }, T), 'Bonded PDEX takes 28 eras, about 28 d, to unbond.');
        assert.equal(M.unbondingText({ ...LIMITS, bondingDuration: 7 }, T), 'Bonded PDEX takes 7 eras, about 7 d, to unbond.');
        assert.equal(M.unbondingText({ ...LIMITS, bondingDuration: null }, T), 'Bonded PDEX takes the chain\'s bonding duration to unbond.');
    });
});

// ── payee (design 1.6) ──
describe('change payee: Staked, Stash or another account; never Controller or None', () => {
    test('the current payee from the real RewardDestination codec', () => {
        assert.deepEqual(M.payeeOf(registry.createType('RewardDestination', 'Staked')), { kind: 'staked', account: '' });
        assert.deepEqual(M.payeeOf(registry.createType('RewardDestination', 'Stash')), { kind: 'stash', account: '' });
        assert.deepEqual(M.payeeOf(registry.createType('RewardDestination', { Account: PAYEE })), { kind: 'account', account: PAYEE });
        assert.deepEqual(M.payeeOf(registry.createType('RewardDestination', 'Controller')), { kind: 'controller', account: '' });
        assert.deepEqual(M.payeeOf(registry.createType('Option<RewardDestination>', null)), null);
    });
    test('unchanged, an address that is not Polkadex, the stash itself as an account', () => {
        const isAddress = (a) => a.startsWith('e');
        const cur = { kind: 'staked', account: '' };
        assert.equal(M.payeeChange({ kind: 'staked' }, cur, { isAddress, isSame, stash: STASH }).message, 'That is where rewards go now. Nothing would change.');
        assert.equal(M.payeeChange({ kind: 'account', account: 'nope' }, cur, { isAddress, isSame, stash: STASH }).message, 'Enter a Polkadex address for the rewards account. Polkadex addresses start with e.');
        assert.equal(M.payeeChange({ kind: 'account', account: STASH }, cur, { isAddress, isSame, stash: STASH }).message, 'That is this stash. Choose "Pay rewards to this stash, unbonded" instead.');
        assert.equal(M.payeeChange({ kind: 'account', account: PAYEE }, cur, { isAddress, isSame, stash: STASH }).ok, true);
        assert.equal(M.payeeChange({ kind: 'stash' }, cur, { isAddress, isSame, stash: STASH }).ok, true);
        assert.equal(M.payeeChange({ kind: 'controller' }, cur, { isAddress, isSame, stash: STASH }).ok, false);
    });
    test('when it applies', () => {
        assert.equal(M.PAYEE_TIMING, 'Applies at once, to every payout made from now on, including eras not paid out yet.');
    });
});

// ── chill (design 1.7, 5.4) ──
describe('stop validating: consequences in plain words', () => {
    test('stays bonded, keeps keys, stops at the next era, nominations stay, responsible until the era ends', () => {
        assert.deepEqual(M.chillText(T, { inSet: true }), [
            'You stay bonded and keep your session keys.',
            'You stop being a candidate from the next era.',
            'You remain responsible for this era: keep the node running until era 500 ends, in about 5 h.',
            'Your nominators keep their nominations; they earn nothing from you while you are not validating.'
        ]);
        assert.match(M.chillText({ ...T, currentEra: 501 }, { inSet: true })[2], /until era 501 ends/, 'the planned era already elected you');
        assert.equal(M.chillText(T, { inSet: false }).length, 3, 'a waiting stash has no era to finish');
    });
});

// ── rebond ──
describe('rebond: only what is unbonding', () => {
    const s = { ...STATE, unlocking: [{ value: String(30n * PDEX), era: 520 }, { value: String(20n * PDEX), era: 525 }] };
    test('nothing, more than unbonding, up to it', () => {
        assert.equal(M.unlockingTotal(s), 50n * PDEX);
        assert.equal(M.rebondCheck(0n, { state: s }).message, 'Enter an amount to rebond.');
        assert.equal(M.rebondCheck(51n * PDEX, { state: s }).message, 'Only 50 PDEX is unbonding, so that is the most you can rebond.');
        assert.equal(M.rebondCheck(50n * PDEX, { state: s }).ok, true);
    });
    test('a rebond that leaves less than the existential deposit bonded is refused (InsufficientBond)', () => {
        const z = { ...s, active: '0' };
        assert.match(M.rebondCheck(PDEX / 2n, { state: z }).message, /at least the existential deposit, 1 PDEX/);
    });
});

// ── unbond, the pallet rule (do_unbond) ──
describe('unbond: the pallet rule for a validator (InsufficientBond, chill first), dust and unlocking chunks', () => {
    const ctx = { active: 500n * PDEX, total: 500n * PDEX, unlocking: [], validating: true, nominating: false, minValidatorBond: 123n * PDEX, minNominatorBond: 50n * PDEX, ed: PDEX, maxUnlockingChunks: 32, currentEra: 500, bondingDuration: 28 };
    test('a partial unbond leaving the validator below MinValidatorBond is refused: chill first', () => {
        assert.equal(M.unbondProblem(400n * PDEX, ctx),
            'This stash validates, so it must keep at least 123 PDEX bonded. Unbonding 400 PDEX leaves 100 PDEX, and the chain refuses it. Stop validating first, or unbond at most 377 PDEX.');
        assert.equal(M.unbondProblem(377n * PDEX, ctx), null);
    });
    test('unbonding everything chills on chain (value >= ledger.total), so it is allowed', () => {
        assert.equal(M.unbondProblem(500n * PDEX, ctx), null);
    });
    test('the dust rule: a remainder below the existential deposit is unbonded too', () => {
        assert.equal(M.unbondProblem(499n * PDEX + 1n, { ...ctx, validating: false }), null);
    });
    test('a nominator keeps MinNominatorBond; a stash that is neither keeps nothing', () => {
        assert.match(M.unbondProblem(460n * PDEX, { ...ctx, validating: false, nominating: true }), /^This stash nominates, so it must keep at least 50 PDEX bonded\./);
        assert.equal(M.unbondProblem(460n * PDEX, { ...ctx, validating: false }), null);
    });
    test('MaxUnlockingChunks: full and nothing matured is refused, even when the new chunk would merge (the length check comes first); a matured chunk is withdrawn first, so it is fine', () => {
        const full = Array.from({ length: 32 }, (_, i) => ({ value: String(PDEX), era: 501 + i }));
        const refused = 'This stash already has 32 unbonding amounts, the most the chain allows. Withdraw the ones that have finished, or wait until one finishes, then unbond again.';
        assert.equal(M.unbondProblem(PDEX, { ...ctx, validating: false, unlocking: full, total: 532n * PDEX }), refused);
        const matured = [{ value: String(PDEX), era: 499 }, ...full.slice(1)];
        assert.equal(M.unbondProblem(PDEX, { ...ctx, validating: false, unlocking: matured, total: 532n * PDEX }), null);
        // do_unbond: ensure!(ledger.unlocking.len() < MaxUnlockingChunks, NoMoreChunks) runs before the same-era merge.
        const sameEra = [...full.slice(0, 31), { value: String(PDEX), era: 528 }];
        assert.equal(M.unbondProblem(PDEX, { ...ctx, validating: false, unlocking: sameEra, total: 532n * PDEX }), refused);
    });
});

// ── the calls, real spec 393 codecs ──
describe('one call per action, through the metadata\'s own codecs', () => {
    const api = () => ({ tx: ex });
    const decode = (tx) => registry.createType('Call', tx.toHex());
    const name = (c) => `${c.section}.${c.method}`;
    test('commission: staking.validate({ commission, blocked })', () => {
        const c = decode(M.buildManageCall(api(), { kind: 'commission', commission: 70_000_000, blocked: true }));
        assert.equal(name(c), 'staking.validate');
        assert.equal(c.args[0].commission.toNumber(), 70_000_000);
        assert.equal(c.args[0].blocked.isTrue, true);
    });
    test('keys: session.setKeys(keys, 0x), the pasted bytes in the runtime order', () => {
        const c = decode(M.buildManageCall(api(), { kind: 'keys', keysHex: NEWBLOB }));
        assert.equal(name(c), 'session.setKeys');
        assert.equal(c.args[0].toHex(), NEWBLOB);
        assert.equal(c.args[1].toHex(), '0x');
    });
    test('bond more: staking.bondExtra(max_additional), compact', () => {
        const c = decode(M.buildManageCall(api(), { kind: 'bondExtra', value: 7n * PDEX }));
        assert.equal(name(c), 'staking.bondExtra');
        assert.equal(c.args[0].toBigInt(), 7n * PDEX);
    });
    test('payee: staking.setPayee(Staked | Stash | Account)', () => {
        assert.equal(decode(M.buildManageCall(api(), { kind: 'payee', payee: { kind: 'stash' } })).args[0].isStash, true);
        const c = decode(M.buildManageCall(api(), { kind: 'payee', payee: { kind: 'account', account: PAYEE } }));
        assert.equal(name(c), 'staking.setPayee');
        assert.equal(c.args[0].asAccount.toString(), PAYEE);
        assert.throws(() => M.buildManageCall(api(), { kind: 'payee', payee: { kind: 'controller' } }), /not offered/);
    });
    test('chill and rebond', () => {
        assert.equal(name(decode(M.buildManageCall(api(), { kind: 'chill' }))), 'staking.chill');
        const r = decode(M.buildManageCall(api(), { kind: 'rebond', value: 5n * PDEX }));
        assert.equal(name(r), 'staking.rebond');
        assert.equal(r.args[0].toBigInt(), 5n * PDEX);
    });
    test('never a batch: single calls only', () => {
        for (const step of [{ kind: 'commission', commission: 1, blocked: false }, { kind: 'chill' }]) assert.notEqual(name(decode(M.buildManageCall(api(), step))), 'utility.batchAll');
    });
    test('the review line, in plain words with the call name', () => {
        assert.deepEqual(M.reviewItem({ kind: 'bondExtra', value: 7n * PDEX }), { call: 'staking.bondExtra', text: 'Add 7 PDEX to the bond' });
        assert.deepEqual(M.reviewItem({ kind: 'keys', keysHex: NEWBLOB, count: 6 }), { call: 'session.setKeys', text: 'Register 6 new session keys' });
        assert.deepEqual(M.reviewItem({ kind: 'payee', payee: { kind: 'account', account: PAYEE } }, { shortAddr: (a) => a.slice(0, 6) }), { call: 'staking.setPayee', text: `Pay rewards to ${PAYEE.slice(0, 6)}` });
        assert.deepEqual(M.reviewItem({ kind: 'chill' }), { call: 'staking.chill', text: 'Stop validating' });
        assert.deepEqual(M.reviewItem({ kind: 'rebond', value: 5n * PDEX }), { call: 'staking.rebond', text: 'Rebond 5 PDEX' });
        assert.deepEqual(M.reviewItem({ kind: 'commission', commission: 70_000_000, blocked: false }, { prefs: { commission: 50_000_000, blocked: false } }), { call: 'staking.validate', text: 'Change commission from 5% to 7%' });
    });
});

// ── success from events and state ──
const ev = (section, method, data = []) => ({ event: { section, method, data } });
const IN1 = { type: 'InBlock', asInBlock: '0xb1' };
const action = (step, extra = {}) => ({ id: 'm1', key: M.MANAGE_ACTION, params: { kind: step.kind, expectEvents: M.expectedManageEvents(step), summary: M.manageSummary(step), ...extra } });
describe('success is decided from the events and a chain re-read, never from inclusion', () => {
    test('the action key, its pending title and the events each call deposits', () => {
        assert.ok(ACTION_KEYS.includes('validator.manage'));
        assert.equal(PENDING_TITLE['validator.manage'], 'Updating your validator');
        assert.deepEqual(M.expectedManageEvents({ kind: 'commission' }), ['staking.ValidatorPrefsSet']);
        assert.deepEqual(M.expectedManageEvents({ kind: 'bondExtra' }), ['staking.Bonded']);
        assert.deepEqual(M.expectedManageEvents({ kind: 'rebond' }), ['staking.Bonded']);
        assert.deepEqual(M.expectedManageEvents({ kind: 'chill' }), ['staking.Chilled']);
        assert.deepEqual(M.expectedManageEvents({ kind: 'keys' }), [], 'set_keys deposits no event: NextKeys is read');
        assert.deepEqual(M.expectedManageEvents({ kind: 'payee' }), [], 'set_payee deposits no event: Payee is read');
    });
    test('commission with ValidatorPrefsSet: included; without it: failed, the change unconfirmed', () => {
        const step = { kind: 'commission', commission: 70_000_000, blocked: false };
        const ok = buildTxModel(action(step), IN1, [ev('staking', 'ValidatorPrefsSet', [STASH, {}]), ev('system', 'ExtrinsicSuccess')], null, { registry, blockNumber: 42 });
        assert.notEqual(ok.stage, 'failed');
        assert.equal(ok.title, 'Validator change included');
        const bad = buildTxModel(action(step), IN1, [ev('system', 'ExtrinsicSuccess')], null, { registry, blockNumber: 42 });
        assert.equal(bad.stage, 'failed');
        assert.match(bad.body, /did not report staking\.ValidatorPrefsSet\. The explorer cannot confirm the change\. Open validator status before trying again\./);
    });
    test('a real Staking error is decoded (CommissionTooLow)', () => {
        const staking = registry.metadata.pallets.find(p => p.name.toString() === 'Staking');
        const errs = registry.lookup.getSiType(staking.errors.unwrap().type).def.asVariant.variants;
        const e = errs.find(v => v.name.toString() === 'CommissionTooLow');
        const err = registry.createType('DispatchError', { Module: { index: staking.index.toNumber(), error: [e.index.toNumber(), 0, 0, 0] } });
        const m = buildTxModel(action({ kind: 'commission' }), IN1, [ev('system', 'ExtrinsicFailed', [err])], null, { registry, blockNumber: 42 });
        assert.equal(m.stage, 'failed');
        assert.equal(m.key, 'staking.CommissionTooLow');
    });
    test('bond more: a Bonded amount below the request is a warning with both numbers', () => {
        const step = { kind: 'bondExtra', value: 7n * PDEX };
        const m = buildTxModel(action(step, { bondRequested: String(7n * PDEX) }), IN1, [ev('staking', 'Bonded', [STASH, String(4n * PDEX)]), ev('system', 'ExtrinsicSuccess')], null, { registry, blockNumber: 42 });
        assert.equal(m.title, 'Bond increased by less than you asked');
        assert.match(m.body, /Bonded 4 PDEX of the 7 PDEX you asked for/);
    });
    test('manageApplied: the chain shows exactly the change', () => {
        const review = (step) => ({ step, state: STATE });
        assert.equal(M.manageApplied({ ...STATE, prefs: { commission: 70_000_000, blocked: false } }, review({ kind: 'commission', commission: 70_000_000, blocked: false })).applied, true);
        assert.equal(M.manageApplied(STATE, review({ kind: 'commission', commission: 70_000_000, blocked: false })).applied, false);
        assert.equal(M.manageApplied({ ...STATE, nextKeys: NEWKEYS }, review({ kind: 'keys', keysHex: NEWBLOB, names: EXPECTED_LAYOUT.map(l => l.name) })).applied, true);
        assert.equal(M.manageApplied(STATE, review({ kind: 'keys', keysHex: NEWBLOB, names: EXPECTED_LAYOUT.map(l => l.name) })).applied, false);
        assert.equal(M.manageApplied({ ...STATE, payee: { kind: 'stash', account: '' } }, review({ kind: 'payee', payee: { kind: 'stash' } })).applied, true);
        assert.equal(M.manageApplied({ ...STATE, validating: false }, review({ kind: 'chill' })).applied, true);
        assert.equal(M.manageApplied(STATE, review({ kind: 'chill' })).applied, false);
        assert.deepEqual(M.manageApplied({ ...STATE, active: String(504n * PDEX) }, review({ kind: 'bondExtra', value: 7n * PDEX })), { applied: true, short: { bonded: 4n * PDEX, requested: 7n * PDEX } });
        assert.deepEqual(M.manageApplied({ ...STATE, active: String(507n * PDEX) }, review({ kind: 'bondExtra', value: 7n * PDEX })), { applied: true });
        assert.equal(M.manageApplied(STATE, review({ kind: 'rebond', value: 5n * PDEX })).applied, false);
    });
});

// ── sign time ──
describe('sign time: read again right before the wallet is asked (design 4.6)', () => {
    const fresh = (over = {}) => ({ limits: LIMITS, state: STATE, owners: null, fee: String(2n * 10n ** 10n), ...over });
    const rv = (step, over = {}) => ({ kind: step.kind, stash: STASH, step, state: STATE, limits: LIMITS, ...over });
    test('nothing changed: no problem', () => {
        assert.deepEqual(M.manageSignTimeProblems(fresh(), rv({ kind: 'commission', commission: 70_000_000, blocked: false })), []);
    });
    test('MinCommission rose above the new rate', () => {
        assert.deepEqual(M.manageSignTimeProblems(fresh({ limits: { ...LIMITS, minCommission: 100_000_000 } }), rv({ kind: 'commission', commission: 70_000_000, blocked: false })),
            ['The minimum commission changed since you reviewed this: it is now 10%. Enter a new rate.']);
    });
    test('the commission was changed meanwhile (the "old" in the review is stale)', () => {
        assert.deepEqual(M.manageSignTimeProblems(fresh({ state: { ...STATE, prefs: { commission: 60_000_000, blocked: false } } }), rv({ kind: 'commission', commission: 70_000_000, blocked: false })),
            ['The commission changed since you reviewed this: it is now 6%. Start again.']);
    });
    test('the stash stopped validating, or its controller changed', () => {
        const p = ['This stash\'s staking state changed since you reviewed this. Start again.'];
        assert.deepEqual(M.manageSignTimeProblems(fresh({ state: { ...STATE, validating: false } }), rv({ kind: 'chill' })), p);
        assert.deepEqual(M.manageSignTimeProblems(fresh({ state: { ...STATE, controller: CTRL } }), rv({ kind: 'payee', payee: { kind: 'stash' } })), p);
        assert.deepEqual(M.manageSignTimeProblems(fresh({ state: { ...STATE, bonded: false } }), rv({ kind: 'chill' })), ['This stash is no longer bonded. Open validator status.']);
    });
    test('keys: the layout changed, a key is taken, or NextKeys moved', () => {
        const step = { kind: 'keys', keysHex: NEWBLOB, names: EXPECTED_LAYOUT.map(l => l.name), count: 6 };
        const r = rv(step, { keys: parseSessionKeys(NEWBLOB).keys });
        const free = { owners: Array(6).fill(null), queued: [], nextKeys: KEYS };
        assert.deepEqual(M.manageSignTimeProblems(fresh({ owners: free }), r), []);
        assert.match(M.manageSignTimeProblems(fresh({ owners: free, limits: { ...LIMITS, layout: { ok: false, layout: null, hexLength: 390 } } }), r)[0], /session key format changed/);
        assert.match(M.manageSignTimeProblems(fresh({ owners: { ...free, owners: [OTHER, null, null, null, null, null] } }), r)[0], /^Key 1 \(grandpa\) is already registered to /);
        assert.deepEqual(M.manageSignTimeProblems(fresh({ owners: free, state: { ...STATE, nextKeys: NEWKEYS } }), r), ['The registered keys changed since you reviewed this. Start again.']);
    });
    test('bond more: the balance fell (the clamp)', () => {
        const p = M.manageSignTimeProblems(fresh({ state: { ...STATE, balance: { ...STATE.balance, free: String(600n * PDEX) } } }), rv({ kind: 'bondExtra', value: 200n * PDEX }));
        assert.match(p[0], /^Your balance changed since you reviewed this\. That is more than this account can bond/);
    });
    test('payee changed meanwhile; rebond above what is unbonding now', () => {
        assert.deepEqual(M.manageSignTimeProblems(fresh({ state: { ...STATE, payee: { kind: 'stash', account: '' } } }), rv({ kind: 'payee', payee: { kind: 'account', account: PAYEE } })),
            ['Where rewards go changed since you reviewed this. Start again.']);
        const s = { ...STATE, unlocking: [{ value: String(3n * PDEX), era: 520 }] };
        assert.deepEqual(M.manageSignTimeProblems(fresh({ state: s }), rv({ kind: 'rebond', value: 5n * PDEX }, { state: s })),
            ['The unbonding amount changed since you reviewed this: 3 PDEX is unbonding now. Enter a new amount.']);
    });
    test('a limit that cannot be read again blocks a commission change', () => {
        assert.match(M.manageSignTimeProblems(fresh({ limits: { ...LIMITS, minCommission: null } }), rv({ kind: 'commission', commission: 70_000_000, blocked: false }))[0], /could not read the minimum commission again/);
    });
});

// ── chain reads ──
const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const num = (v) => ({ toNumber: () => Number(v), toString: () => String(v), toBigInt: () => BigInt(v) });
const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });
function manageApi(o = {}) {
    const st = { minBond: 123n * PDEX, minComm: 30_000_000, minNom: 50n * PDEX, bonded: STASH, ledger: { controller: STASH, stash: STASH, active: 500n * PDEX, total: 500n * PDEX, unlocking: [] },
        validating: true, commission: 50_000_000, blocked: false, payee: 'Staked', nextKeys: KEYS, nominators: null, owners: {}, proxies: [], free: 1000n * PDEX, frozen: 500n * PDEX,
        fee: 2n * 10n ** 10n, currentEra: 500, safeModeUntil: null, paused: [], bondingDuration: 28, ...o };
    const reads = [];
    const validators = async (a) => { reads.push('validators'); return { commission: num(st.commission), blocked: { isTrue: !!st.blocked, valueOf: () => !!st.blocked } }; };
    validators.size = async (a) => num(String(a) === STASH && st.validating ? 5 : 0);
    const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => (...args) => { const c = p[m](...args); c.paymentInfo = async () => ({ partialFee: num(st.fee) }); return c; } }) });
    return {
        reads, st, registry, tx, runtimeVersion: { specVersion: num(393) },
        consts: { balances: { existentialDeposit: num(PDEX) }, staking: { maxUnlockingChunks: num(32), get bondingDuration() { return num(st.bondingDuration); }, sessionsPerEra: num(6) } },
        query: {
            system: { account: async () => ({ nonce: num(0), data: { free: num(st.free), reserved: num(0), frozen: num(st.frozen) } }) },
            staking: {
                minValidatorBond: async () => { reads.push('minValidatorBond'); return num(st.minBond); },
                minCommission: async () => { reads.push('minCommission'); return num(st.minComm); },
                minNominatorBond: async () => num(st.minNom),
                maxValidatorsCount: async () => opt(null), counterForValidators: async () => num(217),
                currentEra: async () => opt(num(st.currentEra)),
                bonded: async (a) => opt(String(a) === STASH ? st.bonded : null),
                ledger: async (c) => opt(st.ledger && String(c) === st.ledger.controller
                    ? { stash: st.ledger.stash, total: num(st.ledger.total), active: num(st.ledger.active), unlocking: st.ledger.unlocking.map(u => ({ value: num(u.value), era: num(u.era) })) } : null),
                validators,
                nominators: async () => opt(st.nominators ? { targets: st.nominators } : null),
                payee: async () => registry.createType('Option<RewardDestination>', st.payee),
                slashingSpans: async () => opt(null)
            },
            session: {
                nextKeys: async (a) => opt(String(a) === STASH && st.nextKeys ? keysCodec(st.nextKeys) : null),
                queuedKeys: async () => [],
                keyOwner: async ([, key]) => { reads.push('keyOwner'); return opt(st.owners[String(key)] || null); }
            },
            proxy: { proxies: async () => [st.proxies.map(p => ({ delegate: p.delegate, proxyType: { toString: () => p.type }, delay: num(0) })), num(0)] },
            safeMode: { enteredUntil: async () => opt(st.safeModeUntil == null ? null : num(st.safeModeUntil)) },
            txPause: { pausedCalls: async (c) => (st.paused.includes(c.join('.')) ? opt(true) : opt(null)) }
        }
    };
}

describe('chain reads: the live limits and the stash state', () => {
    test('readManageLimits reads MinCommission, MinValidatorBond, MinNominatorBond, MaxUnlockingChunks and BondingDuration live, each time', async () => {
        const api = manageApi();
        const a = await C.readManageLimits(api);
        assert.deepEqual([a.minValidatorBond, a.minCommission, a.minNominatorBond, a.maxUnlockingChunks, a.bondingDuration, a.sessionsPerEra],
            [String(123n * PDEX), 30_000_000, String(50n * PDEX), 32, 28, 6]);
        assert.equal(a.layout.ok, true);
        api.st.minComm = 1; api.st.bondingDuration = 7;
        const b = await C.readManageLimits(api);
        assert.deepEqual([b.minCommission, b.bondingDuration], [1, 7]);
    });
    test('readManageState: ledger, unlocking, prefs, payee, proxies, keys, balance', async () => {
        const api = manageApi({ ledger: { controller: STASH, stash: STASH, active: 450n * PDEX, total: 500n * PDEX, unlocking: [{ value: 50n * PDEX, era: 520 }] }, payee: { Account: PAYEE }, proxies: [{ delegate: PROXY, type: 'Staking' }] });
        const s = await C.readManageState(api, STASH);
        assert.deepEqual([s.bonded, s.controller, s.active, s.total, s.validating], [true, STASH, String(450n * PDEX), String(500n * PDEX), true]);
        assert.deepEqual(s.unlocking, [{ value: String(50n * PDEX), era: 520 }]);
        assert.deepEqual(s.prefs, { commission: 50_000_000, blocked: false });
        assert.deepEqual(s.payee, { kind: 'account', account: PAYEE });
        assert.deepEqual(s.proxies, [{ delegate: PROXY, type: 'Staking' }]);
        assert.deepEqual(s.nextKeys, KEYS);
        assert.equal(s.currentEra, 500);
        assert.deepEqual(s.balance, { free: String(1000n * PDEX), reserved: '0', frozen: String(500n * PDEX) });
    });
    test('readManageState: a legacy controller is read through Bonded', async () => {
        const s = await C.readManageState(manageApi({ bonded: CTRL, ledger: { controller: CTRL, stash: STASH, active: 500n * PDEX, total: 500n * PDEX, unlocking: [] } }), STASH);
        assert.equal(s.controller, CTRL);
        assert.equal(s.active, String(500n * PDEX));
    });
});

describe('buildCheckedManageTx: limits, state, keys, pauses read again; refusals in plain words; then one call', () => {
    async function review(api, step, extra = {}) {
        const state = await C.readManageState(api, STASH);
        const limits = await C.readManageLimits(api);
        return { kind: step.kind, stash: STASH, signer: STASH, step, state, limits, ...extra };
    }
    test('commission: builds staking.validate after reading MinCommission again', async () => {
        const api = manageApi();
        const r = await review(api, { kind: 'commission', commission: 70_000_000, blocked: false });
        api.reads.length = 0;
        const tx = await C.buildCheckedManageTx(api, r);
        assert.equal(`${tx.section}.${tx.method}`, 'staking.validate');
        assert.ok(api.reads.includes('minCommission'));
    });
    test('commission: MinCommission raised between review and signing is refused, nothing built', async () => {
        const api = manageApi();
        const r = await review(api, { kind: 'commission', commission: 70_000_000, blocked: false });
        api.st.minComm = 100_000_000;
        await assert.rejects(C.buildCheckedManageTx(api, r), /The minimum commission changed since you reviewed this: it is now 10%/);
    });
    test('keys: every KeyOwner asked again; a key taken meanwhile is refused', async () => {
        const api = manageApi();
        const keys = parseSessionKeys(NEWBLOB).keys;
        const r = await review(api, { kind: 'keys', keysHex: NEWBLOB, names: keys.map(k => k.name), count: 6 }, { keys });
        api.reads.length = 0;
        const tx = await C.buildCheckedManageTx(api, r);
        assert.equal(`${tx.section}.${tx.method}`, 'session.setKeys');
        assert.equal(api.reads.filter(x => x === 'keyOwner').length, 6);
        api.st.owners[NEWKEYS.mixnet] = OTHER;
        await assert.rejects(C.buildCheckedManageTx(api, r), /Key 5 \(mixnet\) is already registered to/);
    });
    test('safe mode and a paused call are refused before the wallet is asked', async () => {
        const api = manageApi();
        const r = await review(api, { kind: 'chill' });
        api.st.paused = ['Staking.chill'];
        await assert.rejects(C.buildCheckedManageTx(api, r), /The network has paused Staking\.chill/);
        api.st.paused = []; api.st.safeModeUntil = 9000;
        await assert.rejects(C.buildCheckedManageTx(api, r), /safe mode until block #9,000/);
    });
    test('bond more: the real fee is used for the clamp check', async () => {
        const api = manageApi({ fee: 450n * PDEX });
        const r = await review(api, { kind: 'bondExtra', value: 100n * PDEX });
        await assert.rejects(C.buildCheckedManageTx(api, r), /more than this account can bond/);
    });
    test('verifyManage: applied only when the chain shows the change; an unreadable chain is pending', async () => {
        const api = manageApi();
        const r = await review(api, { kind: 'commission', commission: 70_000_000, blocked: false });
        assert.equal(await C.verifyManage(api, r), 'pending');
        api.st.commission = 70_000_000;
        assert.equal(await C.verifyManage(api, r), 'applied');
        assert.equal(await C.verifyManage({ query: {} }, r), 'pending');
    });
});

describe('the existing unbond flow gets the validator rule at signing (buildCheckedUnbondTx)', () => {
    test('a partial unbond leaving a validator below MinValidatorBond is refused before the wallet is asked', async () => {
        const api = manageApi();
        await assert.rejects(C.buildCheckedUnbondTx(api, { signer: STASH, value: String(400n * PDEX) }), /This stash validates, so it must keep at least 123 PDEX bonded/);
    });
    test('an allowed amount builds staking.unbond with the exact planck', async () => {
        const tx = await C.buildCheckedUnbondTx(manageApi(), { signer: STASH, value: String(100n * PDEX) });
        assert.equal(`${tx.section}.${tx.method}`, 'staking.unbond');
        assert.equal(tx.args[0].toBigInt(), 100n * PDEX);
    });
    test('MinValidatorBond is read live: lower it and the same amount passes', async () => {
        const api = manageApi({ minBond: 50n * PDEX });
        const tx = await C.buildCheckedUnbondTx(api, { signer: STASH, value: String(400n * PDEX) });
        assert.equal(`${tx.section}.${tx.method}`, 'staking.unbond');
    });
    test('an account with no ledger is refused in plain words', async () => {
        await assert.rejects(C.buildCheckedUnbondTx(manageApi(), { signer: OTHER, value: '1' }), /This account has nothing bonded to unbond/);
    });
});

// ── the tracker, end to end ──
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
function harness(step) {
    const api = { registry, on: () => {}, off: () => {}, rpc: { chain: { getHeader: async () => ({ number: { toNumber: () => 42 } }) } } };
    api.query = { system: { account: async () => ({ nonce: num(0), data: { free: num(1000n * PDEX), reserved: num(0), frozen: num(0) } }) } };
    api.consts = { balances: { existentialDeposit: num(PDEX) } };
    const shown = [];
    const show = (a, st, evs, err, x) => { const m = buildTxModel(a, st, evs, err, x); shown.push(m); return m; };
    const calls = { onError: [], onSuccess: 0, signed: 0 };
    let cb = null;
    const tx = { paymentInfo: async () => ({ partialFee: num(10n ** 10n) }),
        signAsync: async () => { calls.signed++; return { nonce: num(1), send: async (f) => { cb = f; return () => {}; } }; },
        signAndSend: async (a, o, f) => { calls.signed++; cb = f; return () => {}; } };
    const run = trackSignedTx({ api, show, action: action(step), onError: (t) => calls.onError.push(t), onSuccess: () => { calls.onSuccess++; } });
    const emit = async (status, events) => { cb({ status, events, txHash: { toHex: () => '0x' + 'cd'.repeat(32) } }); await flush(); };
    return { run, tx, emit, calls, last: () => shown[shown.length - 1] };
}
describe('lib/tx-submit.js with the manage action (fake api, real card model)', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());
    test('chill: Chilled reported, onSuccess once', async () => {
        const h = harness({ kind: 'chill' });
        h.run.start();
        await h.run.send(h.tx, STASH, {}, { stillValid: () => true });
        await h.emit({ type: 'Ready' });
        await h.emit(IN1, [ev('staking', 'Chilled', [STASH]), ev('system', 'ExtrinsicSuccess')]);
        assert.equal(h.calls.onSuccess, 1);
    });
    test('chill included without Chilled: onError, never onSuccess', async () => {
        const h = harness({ kind: 'chill' });
        h.run.start();
        await h.run.send(h.tx, STASH, {}, { stillValid: () => true });
        await h.emit({ type: 'Ready' });
        await h.emit(IN1, [ev('system', 'ExtrinsicSuccess')]);
        assert.equal(h.calls.onSuccess, 0);
        assert.match(h.calls.onError[0], /did not report staking\.Chilled/);
    });
    test('the wallet session changed after review: refused before the wallet is asked', async () => {
        const h = harness({ kind: 'commission' });
        h.run.start();
        await h.run.send(h.tx, STASH, {}, { stillValid: () => false });
        assert.equal(h.calls.signed, 0);
        assert.deepEqual(h.calls.onError, [WALLET_CHANGED_UNSIGNED]);
    });
});

// ── review round 5 ──
describe('review round 5: a failed read never blocks a nominator, the live state gates validator actions', () => {
    test('Validators.size failing does not block a nominator partial unbond (fail open for the validator rule)', async () => {
        const api = manageApi({ validating: false, nominators: [OTHER] });
        api.query.staking.validators.size = async () => { throw new Error('rpc down'); };
        const tx = await C.buildCheckedUnbondTx(api, { signer: STASH, value: String(100n * PDEX) });
        assert.equal(`${tx.section}.${tx.method}`, 'staking.unbond');
    });
    test('with the read failing, the nominator minimum is still enforced', async () => {
        const api = manageApi({ validating: false, nominators: [OTHER] });
        api.query.staking.validators.size = async () => { throw new Error('rpc down'); };
        await assert.rejects(C.buildCheckedUnbondTx(api, { signer: STASH, value: String(480n * PDEX) }), /This stash nominates, so it must keep at least 50 PDEX bonded/);
    });
    test('menu state from the live chain: a chilled stash is no longer offered commission or stop validating', () => {
        for (const s of ['active', 'elected-next', 'waiting']) assert.equal(M.liveMenuState(s, false), 'active-leaving', s);
        for (const s of ['active', 'elected-next', 'waiting', 'active-leaving', 'disabled']) assert.equal(M.liveMenuState(s, true), s, s);
        assert.equal(M.liveMenuState('disabled', false), 'disabled');
        assert.equal(M.liveMenuState('nothing-yet', false), 'nothing-yet');
        assert.deepEqual(M.manageMenu(M.liveMenuState('active', false)).actions.map(a => a.kind), ['keys', 'bondExtra', 'payee']);
    });
    test('commission and stop validating are refused explicitly when the stash is not validating (not a NaN comparison)', () => {
        const idle = { ...STATE, validating: false, prefs: null };
        for (const step of [{ kind: 'commission', commission: 70_000_000, blocked: false }, { kind: 'chill' }]) {
            const p = M.manageSignTimeProblems({ limits: LIMITS, state: idle, owners: null, fee: null }, { kind: step.kind, stash: STASH, step, state: idle, limits: LIMITS });
            assert.equal(p.length, 1);
            assert.match(p[0], /This stash is not asking to validate now/);
            assert.doesNotMatch(p[0], /NaN/);
        }
        assert.equal(M.notValidatingProblem('commission', false).includes('Bond more'), false);
        assert.equal(M.notValidatingProblem('keys', false), null);
        assert.equal(M.notValidatingProblem('commission', true), null);
    });
    test('commission below the live MinValidatorBond is refused before signing, telling the operator to bond more', () => {
        const p = M.commissionBondProblem({ active: String(100n * PDEX), minValidatorBond: String(123n * PDEX) });
        assert.match(p, /at least 123 PDEX bonded/);
        assert.match(p, /bond more/i);
        assert.match(p, /100 PDEX/);
        assert.equal(M.commissionBondProblem({ active: String(123n * PDEX), minValidatorBond: String(123n * PDEX) }), null);
        assert.equal(M.commissionBondProblem({ active: '1', minValidatorBond: null }), null);
        const low = { ...STATE, active: String(100n * PDEX) };
        const sign = M.manageSignTimeProblems({ limits: LIMITS, state: low, owners: null, fee: null }, { kind: 'commission', stash: STASH, step: { kind: 'commission', commission: 70_000_000, blocked: false }, state: low, limits: LIMITS });
        assert.ok(sign.some(x => /at least 123 PDEX bonded/.test(x)), sign.join('|'));
    });
    test('buildCheckedManageTx refuses a commission change below the live MinValidatorBond before the wallet', async () => {
        const api = manageApi({ minBond: 600n * PDEX });
        const state = await C.readManageState(api, STASH);
        await assert.rejects(C.buildCheckedManageTx(api, { kind: 'commission', stash: STASH, signer: STASH, step: { kind: 'commission', commission: 70_000_000, blocked: false }, state, limits: await C.readManageLimits(api) }), /at least 600 PDEX bonded/);
    });
    test('the max-unbond warning names the consequences; a read failure gives no warning', async () => {
        const w = M.maxUnbondWarning({ eraEndsIn: 5 * 3600, activeEra: 500, currentEra: 500 });
        assert.match(w, /Max unbonds your whole bond/);
        assert.match(w, /stops this stash validating/);
        assert.match(w, /keep the node running until era 500 ends/);
        assert.match(await C.readMaxUnbondWarning(manageApi(), STASH), /stops this stash validating/);
        assert.equal(await C.readMaxUnbondWarning(manageApi({ validating: false }), STASH), null);
        const bad = manageApi();
        bad.query.staking.validators.size = async () => { throw new Error('rpc down'); };
        assert.equal(await C.readMaxUnbondWarning(bad, STASH), null);
    });
});
