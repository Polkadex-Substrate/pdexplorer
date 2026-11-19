// Validator onboarding, Sprint 5 (money path): acting for a validator stash
// through a proxy or a multisig (cto-team/plans/2026-11-17-validator-onboarding-design.md,
// sections 1.10, 4.1, 4.6, 5.4 and Sprint 5; CEO decision D2: the Staking
// proxy limit is accepted, so key rotation and first-time setup need the
// stash itself). Pure rules in lib/validator-delegate.js, chain reads in
// lib/validator-delegate-chain.js.
//
// Every call is encoded with the REAL spec 393 codecs (test/fixtures). The
// proxy filter is data, copied from the runtime source and cited there.
//
// Synthetic accounts: 32 bytes of one repeated value. They belong to no one.

import { test, describe, before, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAddress, decodeAddress, blake2AsHex } from '@polkadot/util-crypto';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import * as D from '../lib/validator-delegate.js';
import * as DC from '../lib/validator-delegate-chain.js';
import * as M from '../lib/validator-manage.js';
import { buildSetupTx } from '../lib/validator-setup.js';
import { normalizeMultisig, prepareMultisig } from '../lib/multisig.js';
import { evaluateEvents, buildTxModel } from '../lib/tx-status.js';
import { trackSignedTx } from '../lib/tx-submit.js';
import * as F from '../lib/fee-preflight.js';
import { EXPECTED_LAYOUT } from '../lib/session-keys.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(131), PROXY = addr(132), OTHER = addr(133), SA = addr(134), SB = addr(135), SC = addr(136);
const PDEX = 10n ** 12n;
const rep = (b, n) => b.repeat(n);
const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
const NEWKEYS = { grandpa: '0x' + rep('a1', 32), babe: '0x' + rep('b2', 32), im_online: '0x' + rep('77', 32), authority_discovery: '0x' + rep('c3', 32), mixnet: '0x' + rep('d4', 32), beefy: '0x03' + rep('e5', 32) };
const blob = (k) => '0x' + EXPECTED_LAYOUT.map(l => k[l.name].slice(2)).join('');
const NEWBLOB = blob(NEWKEYS);
const isSame = (a, b) => a === b;
const norm = (a) => encodeAddress(decodeAddress(String(a)), 88);

let registry, ex;
before(() => {
    registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
    ex = decorateExtrinsics(registry, registry.metadata, 15);
});

const STATE = Object.freeze({
    stash: STASH, bonded: true, controller: STASH, controllerOf: null, active: String(500n * PDEX), total: String(500n * PDEX), unlocking: [],
    validating: true, prefs: { commission: 50_000_000, blocked: false }, payee: { kind: 'staked', account: '' }, nextKeys: KEYS, nominations: 0, nominating: false,
    balance: { free: String(1000n * PDEX), reserved: '0', frozen: String(500n * PDEX) }, ed: String(PDEX), currentEra: 500,
    proxies: [{ delegate: PROXY, type: 'Staking', delay: 0 }]
});
const withProxies = (proxies, over = {}) => ({ ...STATE, proxies, ...over });

// ── the proxy filter, as data, against the runtime source ──
describe('the proxy filter table is the runtime\'s InstanceFilter, as data', () => {
    test('the source is cited: polkadex-node mainnet runtimes/mainnet/src/lib.rs, spec_version 394 on the branch', () => {
        assert.equal(D.PROXY_SOURCE.file, 'runtimes/mainnet/src/lib.rs');
        assert.equal(D.PROXY_SOURCE.branch, 'mainnet');
        assert.equal(D.PROXY_SOURCE.specVersion, 394);
        assert.match(D.PROXY_SOURCE.lines, /^\d+-\d+$/);
        assert.equal(D.PROXY_SOURCE.lines, '803-862', 'the impl InstanceFilter block (Fable round 1)');
        assert.match(readRepo('lib/validator-delegate.js', import.meta.url), /runtimes\/mainnet\/src\/lib\.rs lines 803-862/);
        const src = readRepo('lib/validator-delegate.js', import.meta.url);
        assert.match(src, /ProxyType::Staking => matches!\(c, RuntimeCall::Staking\(\.\.\)\)/, 'the Staking arm is quoted next to the data');
        assert.match(src, /ProxyType::NonTransfer => !matches!\(/, 'the NonTransfer arm is quoted next to the data');
    });
    test('exactly the four types of the runtime enum, in index order', () => {
        assert.deepEqual(D.PROXY_TYPES, ['Any', 'NonTransfer', 'Governance', 'Staking']);
    });
    test('the 393 metadata names the same proxy types: the test fails if the runtime gains or loses one', () => {
        const api = { registry, tx: ex };
        assert.deepEqual(D.proxyTypesOf(api), D.PROXY_TYPES);
        assert.equal(D.proxyTypesProblem(D.proxyTypesOf(api)), null);
        assert.match(D.proxyTypesProblem([...D.PROXY_TYPES, 'IdentityJudgement']), /proxy types changed/);
        assert.match(D.proxyTypesProblem(['Any', 'NonTransfer', 'Staking']), /proxy types changed/);
        assert.match(D.proxyTypesProblem(null), /could not read/);
    });
    test('every pallet the table names exists in the 393 metadata (a rename would silently widen a deny list)', () => {
        const pallets = new Set(registry.metadata.pallets.map(p => p.name.toString()));
        for (const name of D.filterPallets()) assert.ok(pallets.has(name), name);
    });
    const TABLE = [
        // [pallet, call]                    Any   NonTransfer Governance Staking
        [['Staking', 'validate'],            true, true,  false, true],
        [['Staking', 'chill'],               true, true,  false, true],
        [['Staking', 'bond_extra'],          true, true,  false, true],
        [['Staking', 'set_payee'],           true, true,  false, true],
        [['Staking', 'rebond'],              true, true,  false, true],
        [['Staking', 'unbond'],              true, true,  false, true],
        [['Staking', 'withdraw_unbonded'],   true, true,  false, true],
        [['Session', 'set_keys'],            true, true,  false, false],
        [['Session', 'purge_keys'],          true, true,  false, false],
        [['Utility', 'batch_all'],           true, true,  false, false],
        [['Identity', 'set_identity'],       true, true,  false, false],
        [['Proxy', 'add_proxy'],             true, true,  false, false],
        [['Balances', 'transfer_keep_alive'], true, false, false, false],
        [['Indices', 'transfer'],            true, false, false, false],
        [['Indices', 'claim'],               true, true,  false, false],
        [['Assets', 'transfer'],             true, false, false, false],
        [['Recovery', 'create_recovery'],    true, false, false, false],
        [['HyperFungibleToken', 'send'],     true, false, false, false],
        [['Ismp', 'fund_message'],           true, false, false, false],
        [['Treasury', 'spend'],              true, true,  true,  false],
        [['Council', 'vote'],                true, true,  true,  false]
    ];
    test('the capability table: which calls each proxy type may make', () => {
        for (const [[p, c], ...expected] of TABLE) {
            assert.deepEqual(D.PROXY_TYPES.map(t => D.proxyAllows(t, p, c)), expected, `${p}.${c}`);
        }
        assert.equal(D.proxyAllows('IdentityJudgement', 'Staking', 'validate'), false, 'an unknown type allows nothing');
    });
});

// ── which manage actions a connected proxy can make (design 1.10, 5.4) ──
describe('a connected proxy of the stash: the actions its type allows, the rest greyed with the reason', () => {
    test('Staking proxy: commission, bond more, payee, stop validating, rebond allowed through proxy.proxy(Staking)', () => {
        for (const kind of ['commission', 'bondExtra', 'payee', 'chill', 'rebond']) {
            const r = D.proxyAction(kind, { state: STATE, me: PROXY, isSame });
            assert.deepEqual(r, { ok: true, type: 'Staking', real: STASH, delay: 0 }, kind);
            assert.equal(M.signerProblem(kind, STATE, PROXY, { isSame }), null, kind);
        }
    });
    test('Staking proxy: rotate keys greyed with "Key rotation needs the stash on this runtime" and connect the stash', () => {
        const r = D.proxyAction('keys', { state: STATE, me: PROXY, isSame });
        assert.equal(r.ok, false);
        assert.match(r.reason, /^Key rotation needs the stash on this runtime\./);
        assert.match(r.reason, /Connect the stash/);
        assert.equal(M.signerProblem('keys', STATE, PROXY, { isSame }), r.reason);
    });
    test('NonTransfer and Any proxies may rotate keys (the filter allows session.set_keys); the narrowest type is forced', () => {
        const s = withProxies([{ delegate: PROXY, type: 'NonTransfer', delay: 0 }]);
        assert.deepEqual(D.proxyAction('keys', { state: s, me: PROXY, isSame }), { ok: true, type: 'NonTransfer', real: STASH, delay: 0 });
        const both = withProxies([{ delegate: PROXY, type: 'Any', delay: 0 }, { delegate: PROXY, type: 'Staking', delay: 0 }]);
        assert.equal(D.proxyAction('commission', { state: both, me: PROXY, isSame }).type, 'Staking', 'Staking before Any for a staking call');
        assert.equal(D.proxyAction('keys', { state: both, me: PROXY, isSame }).type, 'Any', 'only Any can set keys here');
    });
    test('a Governance proxy can make no validator change', () => {
        const s = withProxies([{ delegate: PROXY, type: 'Governance', delay: 0 }]);
        for (const kind of ['commission', 'keys', 'bondExtra', 'payee', 'chill', 'rebond']) {
            const r = D.proxyAction(kind, { state: s, me: PROXY, isSame });
            assert.equal(r.ok, false, kind);
            assert.match(r.reason, /Connect the stash/, kind);
        }
    });
    test('delay > 0: detected and explained, never attempted (proxy.proxy refuses Unannounced)', () => {
        const s = withProxies([{ delegate: PROXY, type: 'Staking', delay: 100 }]);
        const r = D.proxyAction('commission', { state: s, me: PROXY, isSame });
        assert.equal(r.ok, false);
        assert.match(r.reason, /announcement delay of 100 blocks/);
        assert.match(r.reason, /does not make announced proxy calls/);
        assert.match(r.reason, /Connect the stash/);
        const mixed = withProxies([{ delegate: PROXY, type: 'Any', delay: 50 }, { delegate: PROXY, type: 'Staking', delay: 0 }]);
        assert.equal(D.proxyAction('commission', { state: mixed, me: PROXY, isSame }).type, 'Staking', 'a zero-delay definition that allows the call is used');
        assert.match(D.proxyAction('keys', { state: mixed, me: PROXY, isSame }).reason, /announcement delay of 50 blocks/);
    });
    test('the runtime\'s proxy types changed: every proxy action is off with that reason', () => {
        const r = D.proxyAction('commission', { state: STATE, me: PROXY, isSame, typesProblem: D.proxyTypesProblem(['Any']) });
        assert.equal(r.ok, false);
        assert.match(r.reason, /proxy types changed/);
    });
    test('a legacy controller stash: a proxy of the stash cannot make controller calls', () => {
        const s = withProxies([{ delegate: PROXY, type: 'Staking', delay: 0 }], { controller: OTHER });
        assert.match(D.proxyAction('commission', { state: s, me: PROXY, isSame }).reason, /controlled by .* older setup/);
        assert.equal(D.proxyAction('bondExtra', { state: s, me: PROXY, isSame }).ok, true, 'bond_extra is signed by the stash');
    });
    test('the stash itself and the unrelated wallet are unchanged from Sprint 4', () => {
        assert.equal(M.signerProblem('commission', STATE, STASH, { isSame }), null);
        assert.equal(M.signerProblem('commission', STATE, OTHER, { isSame }), M.WATCHED_TEXT);
    });
});

// ── call wrapping with the real codecs ──
describe('proxy.proxy wrapping against the 393 metadata', () => {
    test('real = the stash, force_proxy_type = Some(type), call = the exact inner call', () => {
        const inner = ex.staking.validate({ commission: 70_000_000, blocked: false });
        const tx = D.buildProxyCall({ tx: ex }, STASH, 'Staking', inner);
        assert.equal(`${tx.section}.${tx.method}`, 'proxy.proxy');
        const call = registry.createType('Call', tx.toHex());
        assert.equal(call.section, 'proxy');
        assert.equal(norm(call.args[0].toString()), STASH);
        assert.equal(call.args[1].isSome, true);
        assert.equal(call.args[1].unwrap().toString(), 'Staking');
        assert.equal(call.args[2].toHex(), inner.toHex());
        assert.equal(`${call.args[2].section}.${call.args[2].method}`, 'staking.validate');
    });
    test('an unknown proxy type or a batch is refused before encoding', () => {
        assert.throws(() => D.buildProxyCall({ tx: ex }, STASH, 'IdentityJudgement', ex.staking.chill()), /proxy type/);
        const batch = ex.utility.batchAll([ex.staking.chill()]);
        assert.throws(() => D.buildProxyCall({ tx: ex }, STASH, 'Staking', batch), /single call/);
    });
});

// ── the chain side of the proxy path ──
const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const num = (v) => ({ toNumber: () => Number(v), toString: () => String(v), toBigInt: () => BigInt(v) });
const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });
function chainApi(o = {}) {
    const st = { minBond: 123n * PDEX, minComm: 30_000_000, bonded: STASH, ledger: { controller: STASH, stash: STASH, active: 500n * PDEX, total: 500n * PDEX, unlocking: [] },
        validating: true, commission: 50_000_000, blocked: false, payee: 'Staked', nextKeys: KEYS, owners: {}, free: 1000n * PDEX, frozen: 500n * PDEX,
        proxies: [{ delegate: PROXY, type: 'Staking', delay: 0 }], fee: 2n * 10n ** 10n, safeModeUntil: null, paused: [], pending: [], ...o };
    const reads = [];
    const validators = async () => ({ commission: num(st.commission), blocked: { isTrue: !!st.blocked } });
    validators.size = async (a) => num(String(a) === STASH && st.validating ? 5 : 0);
    const patch = (c, who) => { c.paymentInfo = async (w) => { reads.push(['paymentInfo', String(w)]); return { partialFee: num(st.fee), weight: { refTime: '1000000', proofSize: '2000' } }; }; return c; };
    // multisig calls come back as an extrinsic-like { method } (prepareMultisig reads tx.method), the rest as the Call itself
    const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => Object.assign((...args) => (sec === 'multisig' ? patch({ method: p[m](...args) }) : patch(p[m](...args))), { meta: p[m] && p[m].meta }) }) });
    const callable = (call) => patch({ method: call });
    const txFn = Object.assign((call) => callable(call), {});
    for (const sec of Object.keys(ex)) txFn[sec] = tx[sec];
    return {
        reads, st, registry, tx: txFn, runtimeVersion: { specVersion: num(393) }, genesisHash: { toHex: () => '0x' + 'ab'.repeat(32) },
        consts: { balances: { existentialDeposit: num(PDEX) }, staking: { maxUnlockingChunks: num(32), bondingDuration: num(28), sessionsPerEra: num(6) },
            multisig: { maxSignatories: num(100), depositBase: num(20n * PDEX), depositFactor: num(PDEX) }, system: {} },
        query: {
            system: { account: async (a) => { reads.push(['account', String(a)]); return { nonce: num(0), data: { free: num(st.free), reserved: num(0), frozen: num(st.frozen) } }; } },
            staking: {
                minValidatorBond: async () => num(st.minBond), minCommission: async () => num(st.minComm), minNominatorBond: async () => num(50n * PDEX),
                maxValidatorsCount: async () => opt(null), counterForValidators: async () => num(217), currentEra: async () => opt(num(500)),
                bonded: async (a) => opt(String(a) === STASH && st.bonded ? st.bonded : null),
                ledger: async (c) => opt(st.ledger && String(c) === st.ledger.controller
                    ? { stash: st.ledger.stash, total: num(st.ledger.total), active: num(st.ledger.active), unlocking: st.ledger.unlocking.map(u => ({ value: num(u.value), era: num(u.era) })) } : null),
                validators, nominators: async () => opt(null),
                payee: async () => registry.createType('Option<RewardDestination>', st.payee)
            },
            session: {
                nextKeys: async (a) => opt(String(a) === STASH && st.nextKeys ? keysCodec(st.nextKeys) : null),
                queuedKeys: async () => [],
                keyOwner: async ([, key]) => opt(st.owners[String(key)] || null)
            },
            proxy: { proxies: async (a) => { reads.push(['proxies', String(a)]); return [st.proxies.map(p => ({ delegate: p.delegate, proxyType: { toString: () => p.type }, delay: num(p.delay) })), num(0)]; } },
            safeMode: { enteredUntil: async () => opt(st.safeModeUntil == null ? null : num(st.safeModeUntil)) },
            txPause: { pausedCalls: async (c) => (st.paused.includes(c.join('.')) ? opt(true) : opt(null)) },
            multisig: { multisigs: Object.assign(async () => ({ isNone: true }), { entries: async () => st.pending }) }
        }
    };
}
const proxyReview = (step, over = {}) => ({ kind: step.kind, stash: STASH, signer: STASH, step, state: { ...STATE }, limits: null, keys: null,
    proxy: { real: STASH, type: 'Staking', delegate: PROXY }, ...over });

describe('buildCheckedProxyTx: the Sprint 4 sign-time checks, then the proxy definition read again, then the wrap', () => {
    test('commission through a Staking proxy: proxy.proxy(stash, Staking, staking.validate)', async () => {
        const api = chainApi();
        const tx = await DC.buildCheckedProxyTx(api, proxyReview({ kind: 'commission', commission: 70_000_000, blocked: false }));
        assert.equal(`${tx.section}.${tx.method}`, 'proxy.proxy');
        const call = registry.createType('Call', tx.toHex());
        assert.equal(norm(call.args[0].toString()), STASH);
        assert.equal(call.args[1].unwrap().toString(), 'Staking');
        assert.equal(`${call.args[2].section}.${call.args[2].method}`, 'staking.validate');
        assert.ok(api.reads.some(r => r[0] === 'proxies' && r[1] === STASH), 'the proxy definitions are read again at signing');
    });
    test('the proxy was removed, its type changed or it gained a delay since review: refused, nothing signed', async () => {
        for (const proxies of [[], [{ delegate: PROXY, type: 'NonTransfer', delay: 0 }], [{ delegate: PROXY, type: 'Staking', delay: 10 }]]) {
            await assert.rejects(DC.buildCheckedProxyTx(chainApi({ proxies }), proxyReview({ kind: 'chill' })), /proxy .* changed since you reviewed this|no longer a proxy/, JSON.stringify(proxies));
        }
    });
    test('the inner rules still apply: MinCommission rose since review', async () => {
        await assert.rejects(DC.buildCheckedProxyTx(chainApi({ minComm: 80_000_000 }), proxyReview({ kind: 'commission', commission: 70_000_000, blocked: false })), /minimum commission changed/);
    });
    test('SafeMode and TxPause: proxy.proxy paused refuses, and so does the inner call', async () => {
        await assert.rejects(DC.buildCheckedProxyTx(chainApi({ paused: ['Proxy.proxy'] }), proxyReview({ kind: 'chill' })), /paused Proxy\.proxy/);
        await assert.rejects(DC.buildCheckedProxyTx(chainApi({ paused: ['Staking.chill'] }), proxyReview({ kind: 'chill' })), /paused Staking\.chill/);
        await assert.rejects(DC.buildCheckedProxyTx(chainApi({ safeModeUntil: 9000 }), proxyReview({ kind: 'chill' })), /safe mode until block #9,000/);
    });
    test('readProxyDefs keeps the delay', async () => {
        assert.deepEqual(await DC.readProxyDefs(chainApi({ proxies: [{ delegate: PROXY, type: 'Staking', delay: 7 }] }), STASH), [{ delegate: PROXY, type: 'Staking', delay: 7 }]);
    });
});

// ── who pays ──
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
describe('the fee is preflighted on the account that pays: the proxy, or the multisig signatory, never the stash', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());
    test('proxy: the tracker checks the proxy\'s balance and fee, not the stash\'s', async () => {
        const api = chainApi();
        Object.assign(api, { on: () => {}, off: () => {}, rpc: { chain: { getHeader: async () => ({ number: { toNumber: () => 42 } }) } } });
        const tx = await DC.buildCheckedProxyTx(api, proxyReview({ kind: 'chill' }));
        tx.signAsync = async () => ({ nonce: num(1), send: async () => () => {} });
        tx.signAndSend = async () => () => {};
        api.reads.length = 0;
        const run = trackSignedTx({ api, show: (a, s, e, err, x) => buildTxModel(a, s, e, err, x), action: { id: 'p1', key: M.MANAGE_ACTION, params: { kind: 'chill' } } });
        run.start();
        await run.send(tx, PROXY, {}, { stillValid: () => true });
        await flush();
        const who = api.reads.filter(r => r[0] === 'account' || r[0] === 'paymentInfo').map(r => r[1]);
        assert.ok(who.length >= 2, JSON.stringify(api.reads));
        assert.ok(who.every(a => a === PROXY), 'every fee read is on the proxy: ' + JSON.stringify(who));
    });
    test('multisig: the inner weight is read for the multisig, the fee for the signatory (lib/multisig.js prepareMultisig)', async () => {
        const api = chainApi();
        const m = normalizeMultisig({ signers: [SA, SB, SC], threshold: 2, name: 'Validator stash' });
        const inner = ex.staking.chill();
        const p = await prepareMultisig({ api, multisig: m, signer: SB, callHex: inner.toHex() });
        assert.deepEqual(api.reads.filter(r => r[0] === 'paymentInfo').map(r => r[1]), [m.address, SB]);
        assert.equal(p.fee, String(2n * 10n ** 10n));
    });
});

// ── multisig wrap of validator calls (the existing lib/multisig.js path) ──
describe('a multisig stash: asMulti and approveAsMulti around the validator call, real codecs', () => {
    test('2-of-3 setup batch: first signer asMulti(2, sorted others, None, the batchAll, max weight); second executes with the timepoint', async () => {
        const api = chainApi({ bonded: null, validating: false, ledger: null, nextKeys: null });
        const m = normalizeMultisig({ signers: [SC, SA, SB], threshold: 2, name: 'Validator stash' });
        const steps = [{ kind: 'bond', value: 200n * PDEX, payee: { kind: 'staked' } }, { kind: 'setKeys', keysHex: NEWBLOB }, { kind: 'validate', commission: 50_000_000, blocked: false }];
        const batch = buildSetupTx(api, steps);
        assert.equal(`${batch.section}.${batch.method}`, 'utility.batchAll');
        const callHex = batch.toHex();
        const first = await prepareMultisig({ api, multisig: m, signer: SA, callHex });
        assert.equal(first.kind, 'approve');
        const c1 = registry.createType('Call', first.tx.method.toHex());
        assert.equal(`${c1.section}.${c1.method}`, 'multisig.asMulti');
        assert.equal(c1.args[0].toNumber(), 2);
        const others = Array.from(c1.args[1], norm);
        assert.deepEqual(others, m.signers.filter(a => a !== SA), 'the other signatories, in the sorted order');
        assert.equal(c1.args[2].isNone, true, 'no timepoint on the first approval');
        assert.equal(c1.args[3].toHex(), callHex, 'the full batch goes on chain so other signers can recover it');
        assert.deepEqual(c1.args[4].toJSON(), { refTime: 1100000, proofSize: 2200 }, 'max weight is the estimate plus 10%');
        assert.equal(first.callHash, blake2AsHex(registry.createType('Call', callHex).toU8a()));
        api.query.multisig.multisigs = async () => opt({ when: { height: num(900), index: num(2) }, approvals: [SA], depositor: SA, deposit: num(22n * PDEX) });
        const second = await prepareMultisig({ api, multisig: m, signer: SB, callHex, callHash: first.callHash, mode: 'approve' });
        assert.equal(second.kind, 'execute');
        const c2 = registry.createType('Call', second.tx.method.toHex());
        assert.equal(`${c2.section}.${c2.method}`, 'multisig.asMulti');
        assert.deepEqual(c2.args[2].unwrap().toJSON(), { height: 900, index: 2 });
        assert.equal(c2.args[3].toHex(), callHex);
    });
    test('3-of-3 middle approval: approveAsMulti(3, others, Some(timepoint), blake2(call), max weight)', async () => {
        const api = chainApi();
        const m = normalizeMultisig({ signers: [SA, SB, SC], threshold: 3, name: 'Validator stash' });
        const callHex = ex.staking.validate({ commission: 70_000_000, blocked: false }).toHex();
        api.query.multisig.multisigs = async () => opt({ when: { height: num(901), index: num(1) }, approvals: [SA], depositor: SA, deposit: num(23n * PDEX) });
        const p = await prepareMultisig({ api, multisig: m, signer: SC, callHex, mode: 'approve', callHash: blake2AsHex(registry.createType('Call', callHex).toU8a()) });
        assert.equal(p.kind, 'approve');
        const c = registry.createType('Call', p.tx.method.toHex());
        assert.equal(`${c.section}.${c.method}`, 'multisig.approveAsMulti');
        assert.equal(c.args[0].toNumber(), 3);
        assert.deepEqual(Array.from(c.args[1], norm), [SA, SB].sort((a, b) => Buffer.compare(Buffer.from(decodeAddress(a)), Buffer.from(decodeAddress(b)))));
        assert.deepEqual(c.args[2].unwrap().toJSON(), { height: 901, index: 1 });
        assert.equal(c.args[3].toHex(), blake2AsHex(registry.createType('Call', callHex).toU8a()));
    });
});

// ── the inner result decides ──
const moduleErr = (pallet, name) => {
    const p = registry.metadata.pallets.find(x => x.name.toString() === pallet);
    const v = registry.lookup.getSiType(p.errors.unwrap().type).def.asVariant.variants.find(x => x.name.toString() === name);
    return { Module: { index: p.index.toNumber(), error: '0x' + v.index.toNumber().toString(16).padStart(2, '0') + '000000' } };
};
const ev = (section, method, data = []) => ({ event: { section, method, data } });
const OK = () => registry.createType('DispatchResult', { Ok: null });
const ERR = (pallet, name) => registry.createType('DispatchResult', { Err: moduleErr(pallet, name) });
describe('outer Ok with an inner Err is a failure, with the decoded inner error', () => {
    const opts = (kind) => ({ actionKey: M.MANAGE_ACTION, params: { kind, expectEvents: M.expectedManageEvents({ kind }) } });
    test('proxy.ProxyExecuted { result: Err(staking.CommissionTooLow) } after ExtrinsicSuccess: not success, the error named', () => {
        const r = evaluateEvents([ev('proxy', 'ProxyExecuted', [ERR('Staking', 'CommissionTooLow')]), ev('system', 'ExtrinsicSuccess')], registry, opts('commission'));
        assert.equal(r.ok, false);
        assert.equal(r.key, 'staking.CommissionTooLow');
        assert.match(r.text, /proxy/i);
        assert.match(r.text, /Nothing changed/);
    });
    test('a filtered call (a Staking proxy sending a batch): system.CallFiltered is decoded, not reported as success', () => {
        const filtered = registry.createType('DispatchResult', { Err: moduleErr('System', 'CallFiltered') });
        const r = evaluateEvents([ev('proxy', 'ProxyExecuted', [filtered]), ev('system', 'ExtrinsicSuccess')], registry, opts('chill'));
        assert.equal(r.ok, false);
        assert.equal(r.key, 'system.CallFiltered');
    });
    test('ProxyExecuted Ok with the staking event: success', () => {
        const r = evaluateEvents([ev('staking', 'ValidatorPrefsSet', [STASH, {}]), ev('proxy', 'ProxyExecuted', [OK()]), ev('system', 'ExtrinsicSuccess')], registry, opts('commission'));
        assert.equal(r.ok, true);
    });
    test('ProxyExecuted Ok but the staking event missing: still not success', () => {
        const r = evaluateEvents([ev('proxy', 'ProxyExecuted', [OK()]), ev('system', 'ExtrinsicSuccess')], registry, opts('commission'));
        assert.equal(r.ok, false);
        assert.match(r.text, /did not report staking\.ValidatorPrefsSet/);
    });
    test('multisig.MultisigExecuted { result: Err } at the final approval: not success, decoded', () => {
        const r = evaluateEvents([ev('multisig', 'MultisigExecuted', [SB, {}, STASH, '0x00', ERR('Staking', 'InsufficientBond')]), ev('system', 'ExtrinsicSuccess')], registry,
            { actionKey: 'multisig.transaction', params: { kind: 'execute' } });
        assert.equal(r.ok, false);
        assert.equal(r.key, 'staking.InsufficientBond');
    });
    test('the result card for an inner failure says failed, with the decoded error', () => {
        const action = { id: 'x', key: M.MANAGE_ACTION, label: 'Change commission', params: { kind: 'commission', expectEvents: ['staking.ValidatorPrefsSet'] } };
        const model = buildTxModel(action, { type: 'InBlock', asInBlock: '0xb1' }, [ev('proxy', 'ProxyExecuted', [ERR('Staking', 'CommissionTooLow')]), ev('system', 'ExtrinsicSuccess')], null, { registry });
        assert.equal(model.stage, 'failed');
        assert.match(model.text, /CommissionTooLow|commission/i);
    });
});

// ── the last approval re-checks the conservative rules ──
describe('validatorCallGuard: the Sprint 3 and 4 refusals, re-checked when the final approval is built', () => {
    test('a pending commission change below the minimum that rose meanwhile: refused', async () => {
        const call = registry.createType('Call', ex.staking.validate({ commission: 40_000_000, blocked: false }).toHex());
        assert.deepEqual(await DC.validatorCallGuard(chainApi(), call, STASH), []);
        const p = await DC.validatorCallGuard(chainApi({ minComm: 60_000_000 }), call, STASH);
        assert.equal(p.length, 1);
        assert.match(p[0], /minimum commission .* 6%/);
    });
    test('pending key rotation whose key is now registered to another account: refused with the owner', async () => {
        const call = registry.createType('Call', ex.session.setKeys(NEWBLOB, '0x').toHex());
        assert.deepEqual(await DC.validatorCallGuard(chainApi(), call, STASH), []);
        const p = await DC.validatorCallGuard(chainApi({ owners: { [NEWKEYS.grandpa]: OTHER } }), call, STASH);
        assert.ok(p.some(x => x.includes(OTHER)), p.join(' '));
    });
    test('pending stop validating on a stash that already stopped: not a validator now, so passed to the chain untouched (Fable round 1: a nominator multisig chills too)', async () => {
        const call = registry.createType('Call', ex.staking.chill().toHex());
        assert.deepEqual(await DC.validatorCallGuard(chainApi({ validating: false }), call, STASH), []);
    });
    test('pending setup batch: the minimum bond rose above the batch\'s bond: refused', async () => {
        const base = { bonded: null, validating: false, ledger: null, nextKeys: null };
        const steps = [{ kind: 'bond', value: 200n * PDEX, payee: { kind: 'staked' } }, { kind: 'setKeys', keysHex: NEWBLOB }, { kind: 'validate', commission: 50_000_000, blocked: false }];
        const call = registry.createType('Call', buildSetupTx(chainApi(base), steps).toHex());
        assert.deepEqual(await DC.validatorCallGuard(chainApi(base), call, STASH), []);
        assert.match((await DC.validatorCallGuard(chainApi({ ...base, minBond: 300n * PDEX }), call, STASH)).join(' '), /minimum bond .* 300 PDEX/);
    });
    test('the call is paused, or the chain is in safe mode: refused', async () => {
        const call = registry.createType('Call', ex.staking.chill().toHex());
        assert.match((await DC.validatorCallGuard(chainApi({ paused: ['Staking.chill'] }), call, STASH)).join(' '), /paused Staking\.chill/);
        assert.match((await DC.validatorCallGuard(chainApi({ safeModeUntil: 77 }), call, STASH)).join(' '), /safe mode/);
    });
    test('a call that is not a validator operation is left alone', async () => {
        const call = registry.createType('Call', ex.balances.transferKeepAlive(OTHER, 5n * PDEX).toHex());
        assert.deepEqual(await DC.validatorCallGuard(chainApi({ validating: false, safeModeUntil: 77 }), call, STASH), []);
    });
});

// ── pending validator operations for a multisig stash ──
describe('pending multisig operations: what each is, who approved, who has not', () => {
    test('describeValidatorCall names validator calls and returns null for anything else', () => {
        const c = (tx) => registry.createType('Call', tx.toHex());
        assert.equal(D.describeValidatorCall(c(ex.staking.validate({ commission: 70_000_000, blocked: true }))), 'Change commission to 7%, new nominations blocked');
        assert.equal(D.describeValidatorCall(c(ex.staking.chill())), 'Stop validating');
        assert.equal(D.describeValidatorCall(c(ex.staking.bondExtra(5n * PDEX))), 'Bond 5 PDEX more');
        assert.equal(D.describeValidatorCall(c(ex.session.setKeys(NEWBLOB, '0x'))), 'Register new session keys');
        const steps = [{ kind: 'bond', value: 200n * PDEX, payee: { kind: 'staked' } }, { kind: 'setKeys', keysHex: NEWBLOB }, { kind: 'validate', commission: 50_000_000, blocked: false }];
        assert.equal(D.describeValidatorCall(c(buildSetupTx({ tx: ex }, steps))), 'Set up the validator: bond 200 PDEX, register session keys, commission 5%');
        assert.equal(D.describeValidatorCall(c(ex.balances.transferKeepAlive(OTHER, 1n))), null);
        assert.equal(D.describeValidatorCall(null), null);
    });
    test('pendingValidatorOps: label, approvals of threshold, approved by, still to approve; other pending calls counted', () => {
        const m = normalizeMultisig({ signers: [SA, SB, SC], threshold: 2, name: 'Validator stash' });
        const chill = registry.createType('Call', ex.staking.chill().toHex());
        const xfer = registry.createType('Call', ex.balances.transferKeepAlive(OTHER, 1n).toHex());
        const rows = [
            { hash: '0x' + '01'.repeat(32), pending: { when: { height: '900', index: '2' }, approvals: [SB], depositor: SB, deposit: String(22n * PDEX) }, call: chill },
            { hash: '0x' + '02'.repeat(32), pending: { when: { height: '901', index: '1' }, approvals: [SA], depositor: SA, deposit: '1' }, call: xfer },
            { hash: '0x' + '03'.repeat(32), pending: { when: { height: '902', index: '0' }, approvals: [SC], depositor: SC, deposit: '1' }, call: null }
        ];
        const v = D.pendingValidatorOps(rows, m, { isSame });
        assert.equal(v.ops.length, 1);
        assert.deepEqual(v.ops[0], { hash: '0x' + '01'.repeat(32), label: 'Stop validating', approvals: 1, threshold: 2, approvedBy: [SB],
            waitingFor: m.signers.filter(a => a !== SB), since: '900', callHex: chill.toHex(), rechecked: true });
        assert.equal(v.others, 2, 'a non-validator call and one whose call data is unknown are counted, not shown as validator changes');
        assert.match(D.pendingOpText(v.ops[0]), /^1 of 2 approvals\. Approved by .*\. Waiting for .*\.$/);
    });
    test('readPendingValidatorOps reads Multisig.Multisigs for the stash and recovers each call from its first approval', async () => {
        const m = normalizeMultisig({ signers: [SA, SB, SC], threshold: 2, name: 'Validator stash' });
        const chill = ex.staking.chill();
        const hash = blake2AsHex(registry.createType('Call', chill.toHex()).toU8a());
        const api = chainApi({ pending: [[{ args: [{ toString: () => m.address }, { toHex: () => hash }] }, opt({ when: { height: num(900), index: num(2) }, approvals: [SB], depositor: SB, deposit: num(1) })]] });
        const recovered = [];
        const v = await DC.readPendingValidatorOps(api, m, { recover: async (a, pending, h) => { recovered.push([pending.when.height, h]); return chill.toHex(); }, isSame });
        assert.deepEqual(recovered, [['900', hash]]);
        assert.equal(v.ops[0].label, 'Stop validating');
        assert.equal(v.ops[0].callHex, chill.toHex());
    });
    test('a recovered call whose hash does not match is not trusted', async () => {
        const m = normalizeMultisig({ signers: [SA, SB, SC], threshold: 2, name: 'Validator stash' });
        const api = chainApi({ pending: [[{ args: [{ toString: () => m.address }, { toHex: () => '0x' + '0f'.repeat(32) }] }, opt({ when: { height: num(900), index: num(2) }, approvals: [SB], depositor: SB, deposit: num(1) })]] });
        const v = await DC.readPendingValidatorOps(api, m, { recover: async () => ex.staking.chill().toHex(), isSame });
        assert.equal(v.ops.length, 0);
        assert.equal(v.others, 1);
    });
});

// ── copy ──
describe('copy: the limits and the change warning', () => {
    test('the 4.1 limits copy and the between-approvals warning', () => {
        assert.equal(D.STAKING_PROXY_LIMITS, 'A Staking proxy cannot move your bond out. It can change where rewards are paid and can stop you validating. It cannot register session keys on this runtime: key rotation needs the stash.');
        assert.match(D.MULTISIG_CHANGE_WARNING, /can change between approvals/);
        assert.match(D.MULTISIG_CHANGE_WARNING, /checks .* again .* last approval/);
        for (const t of [D.STAKING_PROXY_LIMITS, D.MULTISIG_CHANGE_WARNING, D.MULTISIG_FEE_NOTE, D.PROXY_FEE_NOTE]) assert.doesNotMatch(t, /[\u2013\u2014]/);
    });
    test('the module is pure: no DOM and no network', () => {
        const src = stripComments(readRepo('lib/validator-delegate.js', import.meta.url));
        assert.doesNotMatch(src, /document\.|window\.|fetch\(/);
    });
});

// ── Fable round 1: the guard must not refuse the live site's multisig staking ──
// FEATURE_FLAGS.validate is off on the live site, but the guard is wired into
// every multisig final approval. A nominator multisig's staking calls must pass
// exactly as before this branch; validator rules apply only to a stash that is a
// validator now, or to a validator setup (a setup batch, or staking.validate on
// a bonded stash that is not validating). The signatory pays the fee of a
// multisig, so the stash keeps no fee margin and no working reserve.
const STAKE_MAX_KEEP = 10n ** 10n;   // script.js Stake modal Max keeps 0.01 PDEX
const call = (tx) => registry.createType('Call', tx.toHex());
// The refusal paths throw if they are reached: a non-validator must never touch them.
function strictNominator(o = {}) {
    const api = chainApi({ validating: false, ...o });
    const touched = [];
    const trap = (name) => async () => { touched.push(name); throw new Error('refusal path touched: ' + name); };
    api.query.safeMode.enteredUntil = trap('safeMode');
    api.query.txPause.pausedCalls = trap('txPause');
    api.query.staking.minValidatorBond = trap('minValidatorBond');
    api.query.staking.minCommission = trap('minCommission');
    api.query.staking.ledger = trap('ledger');
    api.query.system.account = trap('account');
    return { api, touched };
}
describe('validatorCallGuard on the live site: nominator multisigs pass untouched (Fable round 1)', () => {
    test('bondExtra Max from the Stake modal (keeps 0.01 PDEX) on a nominator multisig: passed, no refusal path touched', async () => {
        const { api, touched } = strictNominator();
        const value = 1000n * PDEX - 500n * PDEX - STAKE_MAX_KEEP;
        assert.deepEqual(await DC.validatorCallGuard(api, call(ex.staking.bondExtra(value)), STASH), []);
        assert.deepEqual(touched, []);
    });
    test('a nominator multisig\'s chill, unbond, rebond, setPayee, withdrawUnbonded and bond: passed, no refusal path touched', async () => {
        const { api, touched } = strictNominator();
        for (const tx of [ex.staking.chill(), ex.staking.unbond(450n * PDEX), ex.staking.rebond(5n * PDEX), ex.staking.setPayee('Staked'), ex.staking.withdrawUnbonded(0), ex.staking.bond(10n * PDEX, 'Staked')]) {
            assert.deepEqual(await DC.validatorCallGuard(api, call(tx), STASH), [], `${tx.section}.${tx.method}`);
        }
        assert.deepEqual(touched, []);
    });
    test('the flag off: a multisig that is not a validator never reaches a refusal, even in safe mode, paused, and with the minimums raised', async () => {
        const api = chainApi({ validating: false, safeModeUntil: 77, paused: ['Staking.bondExtra', 'Staking.chill'], minBond: 10_000n * PDEX, minComm: 900_000_000 });
        for (const tx of [ex.staking.bondExtra(499n * PDEX), ex.staking.chill(), ex.staking.unbond(1n * PDEX)]) {
            assert.deepEqual(await DC.validatorCallGuard(api, call(tx), STASH), [], `${tx.section}.${tx.method}`);
        }
    });
    test('the role read fails: fail open (the chain decides), never a refusal', async () => {
        const api = chainApi();
        api.query.staking.validators.size = async () => { throw new Error('socket closed'); };
        for (const tx of [ex.staking.chill(), ex.staking.bondExtra(5n * PDEX), ex.staking.validate({ commission: 1, blocked: false })]) {
            assert.deepEqual(await DC.validatorCallGuard(api, call(tx), STASH), [], `${tx.section}.${tx.method}`);
        }
    });
    test('a non-validator setup whose limit or state reads fail: fail open', async () => {
        const base = { bonded: null, validating: false, ledger: null, nextKeys: null };
        const steps = [{ kind: 'bond', value: 200n * PDEX, payee: { kind: 'staked' } }, { kind: 'setKeys', keysHex: NEWBLOB }, { kind: 'validate', commission: 50_000_000, blocked: false }];
        const c = call(buildSetupTx(chainApi(base), steps));
        const a1 = chainApi(base); a1.query.staking.minValidatorBond = async () => { throw new Error('x'); };
        assert.deepEqual(await DC.validatorCallGuard(a1, c, STASH), []);
        const a2 = chainApi(base); a2.query.system.account = async () => { throw new Error('x'); };
        assert.deepEqual(await DC.validatorCallGuard(a2, c, STASH), []);
    });
    test('a validator whose reads fail: refused with a try-again message, not a guess', async () => {
        const api = chainApi();
        api.query.system.account = async () => { throw new Error('socket closed'); };
        const p = await DC.validatorCallGuard(api, call(ex.staking.chill()), STASH);
        assert.equal(p.length, 1);
        assert.match(p[0], /could not read .* Try again/);
    });
});
describe('validatorCallGuard: a multisig pays no fee from the stash (the signatory pays)', () => {
    test('bondExtra Max from the Stake modal on a validator multisig: passed (was refused with "Your balance changed")', async () => {
        const value = 1000n * PDEX - 500n * PDEX - STAKE_MAX_KEEP;
        assert.deepEqual(await DC.validatorCallGuard(chainApi(), call(ex.staking.bondExtra(value)), STASH), []);
    });
    test('bondExtra above what the stash holds free of its lock: still refused, with no fee or reserve in the text', async () => {
        const p = await DC.validatorCallGuard(chainApi(), call(ex.staking.bondExtra(501n * PDEX)), STASH);
        assert.equal(p.length, 1);
        assert.match(p[0], /Your balance changed .* the most is 500 PDEX/);
        assert.doesNotMatch(p[0], /network fee|kept free/);
    });
    test('a setup batch bonding everything above the existential deposit: passed (no fee margin, no working reserve)', async () => {
        const base = { bonded: null, validating: false, ledger: null, nextKeys: null, frozen: 0n };
        const steps = [{ kind: 'bond', value: 999n * PDEX, payee: { kind: 'staked' } }, { kind: 'setKeys', keysHex: NEWBLOB }, { kind: 'validate', commission: 50_000_000, blocked: false }];
        const c = call(buildSetupTx(chainApi(base), steps));
        assert.deepEqual(await DC.validatorCallGuard(chainApi(base), c, STASH), []);
        const over = [{ ...steps[0], value: 999n * PDEX + 1n }, steps[1], steps[2]];
        assert.match((await DC.validatorCallGuard(chainApi(base), call(buildSetupTx(chainApi(base), over)), STASH)).join(' '), /Your balance changed/);
    });
});
describe('validatorCallGuard: staking.validate on a bonded stash that is not validating is a setup (Sprint 3 rules)', () => {
    test('enough bond and commission at the minimum: passed (was refused as a commission change)', async () => {
        const p = await DC.validatorCallGuard(chainApi({ validating: false }), call(ex.staking.validate({ commission: 50_000_000, blocked: false })), STASH);
        assert.deepEqual(p, []);
    });
    test('the setup rules apply: commission below the minimum and bond below MinValidatorBond are refused with the setup wording', async () => {
        const c = call(ex.staking.validate({ commission: 20_000_000, blocked: false }));
        const p = await DC.validatorCallGuard(chainApi({ validating: false, minBond: 600n * PDEX }), c, STASH);
        assert.ok(p.some(x => /minimum commission changed .* Go back to Commission/.test(x)), p.join(' | '));
        assert.ok(p.some(x => /minimum bond changed .* 600 PDEX/.test(x)), p.join(' | '));
        assert.ok(!p.some(x => /not asking to validate/.test(x)), p.join(' | '));
    });
});
describe('pending unbond, withdrawUnbonded, bond and utility.batch: re-checked, or labelled honestly (Fable round 1)', () => {
    test('stepsFromCall maps unbond to the unbond rule; bond, withdrawUnbonded and utility.batch are not re-checked', () => {
        assert.deepEqual(D.stepsFromCall(call(ex.staking.unbond(5n * PDEX))), { unbond: { value: 5n * PDEX } });
        for (const tx of [ex.staking.bond(10n * PDEX, 'Staked'), ex.staking.withdrawUnbonded(0), ex.utility.batch([ex.staking.chill()])]) {
            assert.equal(D.stepsFromCall(call(tx)), null, `${tx.section}.${tx.method}`);
            assert.equal(D.isRechecked(call(tx)), false, `${tx.section}.${tx.method}`);
        }
        for (const tx of [ex.staking.unbond(5n * PDEX), ex.staking.chill(), ex.staking.validate({ commission: 1, blocked: false })]) assert.equal(D.isRechecked(call(tx)), true);
    });
    test('a validator\'s pending unbond that would leave less than MinValidatorBond: refused with the unbond rule', async () => {
        const p = await DC.validatorCallGuard(chainApi(), call(ex.staking.unbond(450n * PDEX)), STASH);
        assert.equal(p.length, 1);
        assert.match(p[0], /must keep at least 123 PDEX bonded/);
        assert.deepEqual(await DC.validatorCallGuard(chainApi(), call(ex.staking.unbond(100n * PDEX)), STASH), []);
    });
    test('a validator\'s pending unbond while Staking.unbond is paused: refused', async () => {
        assert.match((await DC.validatorCallGuard(chainApi({ paused: ['Staking.unbond'] }), call(ex.staking.unbond(1n * PDEX)), STASH)).join(' '), /paused Staking\.unbond/);
    });
    test('pendingValidatorOps marks each op: re-checked or not, and the label for those that are not', () => {
        const m = normalizeMultisig({ signers: [SA, SB, SC], threshold: 2, name: 'Validator stash' });
        const row = (n, tx) => ({ hash: '0x' + String(n).padStart(2, '0').repeat(32), pending: { when: { height: '900', index: '0' }, approvals: [SB], depositor: SB, deposit: '1' }, call: call(tx) });
        const v = D.pendingValidatorOps([row(1, ex.staking.unbond(5n * PDEX)), row(2, ex.staking.withdrawUnbonded(0)), row(3, ex.staking.bond(10n * PDEX, 'Staked')), row(4, ex.utility.batch([ex.staking.chill()]))], m, { isSame });
        assert.deepEqual(v.ops.map(o => o.rechecked), [true, false, false, false]);
        assert.equal(D.NOT_RECHECKED, 'Not re-checked by the explorer; the chain decides.');
        assert.doesNotMatch(D.NOT_RECHECKED, /[–—]/);
    });
    test('the manage view labels a pending op that is not re-checked', () => {
        const src = stripComments(readRepo('lib/validator-manage-view.js', import.meta.url));
        assert.match(src, /op\.rechecked \? '' : [^\n]*NOT_RECHECKED/);
    });
});
describe('the multisig deposit is in the fee preflight of a first approval (Fable round 1)', () => {
    const W = { refTime: 1_000_000, proofSize: 2000 };
    test('multisigDepositOf: DepositBase + threshold x DepositFactor for a first approval, read from the live constants; 0 otherwise', () => {
        const api = chainApi();
        const inner = ex.staking.chill();
        const hash = blake2AsHex(call(inner).toU8a());
        assert.equal(F.multisigDepositOf(api, { method: ex.multisig.asMulti(2, [SA, SC], null, inner, W) }), 22n * PDEX);
        assert.equal(F.multisigDepositOf(api, { method: ex.multisig.approveAsMulti(3, [SA, SC], null, hash, W) }), 23n * PDEX);
        assert.equal(F.multisigDepositOf(api, { method: ex.multisig.asMulti(2, [SA, SC], { height: 9, index: 1 }, inner, W) }), 0n);
        assert.equal(F.multisigDepositOf(api, { method: ex.multisig.approveAsMulti(2, [SA, SC], { height: 9, index: 1 }, hash, W) }), 0n);
        assert.equal(F.multisigDepositOf(api, { method: ex.multisig.asMultiThreshold1([SA], inner) }), 0n);
        assert.equal(F.multisigDepositOf(api, { method: inner }), 0n);
        api.consts.multisig.depositBase = num(40n * PDEX);
        assert.equal(F.multisigDepositOf(api, { method: ex.multisig.asMulti(2, [SA, SC], null, inner, W) }), 42n * PDEX, 'the constants are read at preflight, not cached');
    });
    test('feeShortfall: the deposit counts with the fee; the text names the fee and the deposit separately', () => {
        const s = F.feeShortfall({ fee: 2n * 10n ** 10n, deposit: 22n * PDEX, free: 510n * PDEX, frozen: 500n * PDEX, ed: PDEX });
        assert.ok(s, 'short');
        assert.equal(s.deposit, 22n * PDEX);
        const t = F.feeShortText(s);
        assert.match(t, /network fee/);
        assert.match(t, /multisig deposit of 22 PDEX/);
        assert.match(t, /returned/);
        assert.equal(F.feeShortfall({ fee: 2n * 10n ** 10n, deposit: 22n * PDEX, free: 523n * PDEX, frozen: 500n * PDEX, ed: PDEX }), null);
        assert.doesNotMatch(F.feeShortText(F.feeShortfall({ fee: 2n * 10n ** 10n, free: PDEX, ed: PDEX })), /deposit/, 'no deposit, no deposit wording');
    });
    test('feePreflight on a first approval: a signer that can pay the fee but not the deposit is stopped before the wallet is asked', async () => {
        const api = chainApi({ free: 510n * PDEX, frozen: 500n * PDEX });
        const m = normalizeMultisig({ signers: [SA, SB, SC], threshold: 2, name: 'Validator stash' });
        const p = await prepareMultisig({ api, multisig: m, signer: SB, callHex: ex.staking.chill().toHex() });
        assert.equal(p.deposit, String(22n * PDEX));
        const r = await F.feePreflight(api, p.tx, SB);
        assert.equal(r.status, 'short');
        assert.match(r.text, /multisig deposit of 22 PDEX/);
        const ok = await F.feePreflight(chainApi({ free: 1000n * PDEX, frozen: 500n * PDEX }), p.tx, SB);
        assert.equal(ok.status, 'ok');
    });
});
