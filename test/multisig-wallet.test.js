// Exercise the actual SPA submission path with injected wallet extensions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { bodyOf } from './helpers/source.js';
import { makeProfile, openTab, fakeExtension, A, B, C } from './helpers/wallet-world.js';
import { createMultisigStore, normalizeMultisig } from '../lib/multisig.js';

const script = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const multisig = normalizeMultisig({ signers: [A, B, C], threshold: 2, name: 'Team wallet' });
function setup() {
    const ext = fakeExtension('talisman', [{ address: A, name: 'Alice' }, { address: B, name: 'Bob' }]);
    const profile = makeProfile({ extensions: [ext] });
    const tab = openTab(profile);
    const store = createMultisigStore(profile.local); store.save(multisig);
    const reviewed = [], sent = [], errors = [];
    Object.assign(tab.ctx, {
        globalApi: {}, liveRuntimeError: () => null, multisigStore: store,
        multisigUI: { mountAccounts() {}, review: async request => reviewed.push(request) },
        showTxStatus: () => ({ stage: 'failed' }),
        trackSignedTx: () => ({ start() {}, buildFailed: e => errors.push(e.message), send: async (tx, address, signer) => sent.push({ tx, address, signer }) })
    });
    vm.runInContext('async ' + bodyOf(script, 'submitSignedTx'), tab.ctx);
    tab.fn('selectWallet')(multisig.address, 'multisig');
    return { tab, ext, reviewed, sent, errors, submit: options => tab.fn('submitSignedTx')({ onError: e => errors.push(e), ...options }) };
}

test('selecting a saved multisig persists it across reload without replacing it with the first injected signer', async () => {
    const { tab } = setup();
    await tab.settle();
    const reload = openTab(tab.profile);
    await reload.visit('/wallet');
    assert.equal(reload.read('pdex_wallet_address'), multisig.address);
    assert.equal(createMultisigStore(tab.profile.local).find(multisig.address).threshold, 2);
});

test('a multisig action opens review and never attempts to sign with the multisig address', async () => {
    const w = setup();
    await w.submit({ buildTx: () => ({ method: { toHex: () => '0x1234' } }) });
    assert.equal(w.reviewed.length, 1);
    assert.equal(w.reviewed[0].multisig.address, multisig.address);
    assert.equal(w.reviewed[0].callHex, '0x1234');
    assert.equal(w.sent.length, 0);
});

test('reviewed approvals sign with the chosen individual account and leave the selected multisig intact', async () => {
    const w = setup(); const tx = {};
    await w.submit({ signingAccount: { address: B, source: 'talisman' }, multisigHandled: true, buildTx: () => tx });
    assert.equal(w.sent.length, 1);
    assert.equal(w.sent[0].address, B);
    assert.equal(w.sent[0].signer.extKey, 'talisman');
    assert.equal(w.tab.read('pdex_wallet_address'), multisig.address);
});

test('a removed signer is rejected instead of silently selecting a different signing account', async () => {
    const w = setup();
    w.ext.accounts.splice(1, 1);
    await w.submit({ signingAccount: { address: B, source: 'talisman' }, multisigHandled: true, buildTx: () => ({}) });
    assert.equal(w.sent.length, 0);
    assert.match(w.errors[0], /isn't available/);
});

test('switching wallets while an asynchronous transaction is built prevents signing', async () => {
    const w = setup();
    await w.submit({ signingAccount: { address: A, source: 'talisman' }, multisigHandled: true, buildTx: async () => { w.tab.fn('selectWallet')(B, 'talisman'); return {}; } });
    assert.equal(w.sent.length, 0);
    assert.match(w.errors[0], /wallet changed/);
});

test('ordinary accounts keep their direct-signing path', async () => {
    const w = setup(); w.tab.fn('selectWallet')(A, 'talisman');
    await w.submit({ buildTx: () => ({}) });
    assert.equal(w.sent.length, 1);
    assert.equal(w.sent[0].address, A);
    assert.equal(w.reviewed.length, 0);
});
