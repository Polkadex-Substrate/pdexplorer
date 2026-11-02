import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiPromise } from '@polkadot/api';
import { encodeAddress } from '@polkadot/util-crypto';
import metadata from '@polkadot/types-support/metadata/static-substrate';
import { mockProvider } from './helpers/mock-provider.js';
import { councilRole, readCouncilCandidacy, buildCouncilWithdrawal } from '../lib/council-candidacy.js';
import { createCouncilCandidacyUI } from '../lib/council-candidacy-view.js';
import { successCopy, buildTxModel, decodeDispatchError } from '../lib/tx-status.js';

const address = (n, prefix = 88) => encodeAddress(new Uint8Array(32).fill(n), prefix);
const A = address(1), B = address(2);
const hash = '0x' + '22'.repeat(32);
let chain;
before(async () => { chain = await ApiPromise.create({ provider: mockProvider({ metadataHex: metadata }).provider, noInitWarn: true }); });
after(async () => { await chain?.disconnect(); });

function world(role = 'Candidate', pallet = 'elections') {
    const snapshots = [], built = [];
    let state, beforeRead = async () => {};
    function set(next, count = 2) {
        state = { members: next === 'Member' ? [{ who: A, stake: 100, deposit: 10 }] : [],
            runnersUp: next === 'RunnerUp' ? [{ who: A, stake: 100, deposit: 10 }] : [],
            candidates: next === 'Candidate' ? Array.from({ length: count }, (_, i) => [address(i + 1), 10]) : [] };
    }
    set(role);
    const api = {
        genesisHash: chain.genesisHash, runtimeVersion: { specVersion: 392 },
        query: { [pallet]: { members() {}, runnersUp() {}, candidates() {} } },
        tx: { [pallet]: { renounceCandidacy: arg => { built.push(arg); return chain.tx.elections.renounceCandidacy(arg); } } },
        rpc: { chain: { getBlockHash: async () => hash } },
        at: async h => {
            snapshots.push(h);
            const snap = state;
            await beforeRead();
            return { query: { [pallet]: Object.fromEntries(['members', 'runnersUp', 'candidates'].map(k => [k, async () => snap[k]])) } };
        }
    };
    return { api, snapshots, built, set, get state() { return state; }, beforeRead: fn => { beforeRead = fn; } };
}

test('detects candidates and both seat-holder shapes across SS58 prefixes', () => {
    const alt = address(1, 42);
    assert.equal(councilRole({ candidates: [[alt, 10]] }, A), 'Candidate');
    assert.equal(councilRole({ runnersUp: [{ who: alt, stake: 100 }] }, A), 'RunnerUp');
    assert.equal(councilRole({ members: [[alt, 100]] }, A), 'Member');
    assert.equal(councilRole({ members: [{ address: alt }] }, A), 'Member');
    assert.equal(councilRole({ candidates: [[B, 10]] }, A), null);
    assert.equal(councilRole({}, null), null);
});

test('reads real storage codecs at one pinned block and builds the correct SCALE variant for all roles', async () => {
    for (const role of ['Candidate', 'RunnerUp', 'Member']) {
        const w = world(role);
        for (const key of ['members', 'runnersUp', 'candidates']) {
            const type = chain.registry.createLookupType(chain.query.elections[key].meta.type.asPlain);
            w.state[key] = chain.registry.createType(type, w.state[key]);
        }
        const review = await readCouncilCandidacy(w.api, A);
        assert.equal(review.role, role);
        const tx = await buildCouncilWithdrawal(w.api, A, review);
        const call = chain.registry.createType('Call', tx.method.toHex());
        assert.equal(call.method, 'renounceCandidacy');
        assert.equal(call.args[0].type, role);
        if (role === 'Candidate') assert.equal(call.args[0].asCandidate.toNumber(), 2);
        assert.deepEqual(w.snapshots, [hash, hash]);
    }
});

test('resolves the actual elections pallet and refreshes the candidate-count witness just before signing', async () => {
    for (const pallet of ['elections', 'electionsPhragmen', 'phragmenElection']) {
        const w = world('Candidate', pallet);
        const review = await readCouncilCandidacy(w.api, A);
        assert.equal(review.pallet, pallet);
        w.set('Candidate', 3);
        const tx = await buildCouncilWithdrawal(w.api, A, review);
        assert.equal(tx.method.args[0].asCandidate.toNumber(), 3);
    }
});

test('an election cannot silently turn a reviewed withdrawal into a seat resignation', async () => {
    const w = world();
    const review = await readCouncilCandidacy(w.api, A);
    for (const role of ['Member', 'RunnerUp', null]) {
        w.set(role);
        await assert.rejects(buildCouncilWithdrawal(w.api, A, review), /role changed/);
    }
    assert.equal(w.built.length, 0);
});

test('rejects a changed account, chain or runtime, and fails closed when reads fail', async () => {
    const w = world();
    const review = await readCouncilCandidacy(w.api, A);
    await assert.rejects(buildCouncilWithdrawal(w.api, B, review), /selected account/);
    w.api.runtimeVersion.specVersion = 393;
    await assert.rejects(buildCouncilWithdrawal(w.api, A, review), /runtime changed/);
    w.api.runtimeVersion.specVersion = 392;
    w.api.genesisHash = { toHex: () => hash };
    await assert.rejects(buildCouncilWithdrawal(w.api, A, review), /network or runtime changed/);
    w.api.at = async () => { throw new Error('RPC disconnected'); };
    await assert.rejects(readCouncilCandidacy(w.api, A), /RPC disconnected/);
    assert.equal(w.built.length, 0);
});

test('rejects missing storage, missing call support and a runtime change during the read', async () => {
    await assert.rejects(readCouncilCandidacy(null, A), /not ready/);
    const unsupported = world(); delete unsupported.api.tx.elections.renounceCandidacy;
    await assert.rejects(readCouncilCandidacy(unsupported.api, A), /not supported/);
    const malformed = world(); malformed.state.members = null;
    await assert.rejects(readCouncilCandidacy(malformed.api, A), /could not be read/);
    const upgrading = world();
    upgrading.beforeRead(async () => { upgrading.api.runtimeVersion.specVersion = 393; });
    await assert.rejects(readCouncilCandidacy(upgrading.api, A), /runtime changed/);
});

test('a stalled node read times out without building a transaction', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = world();
    w.api.rpc.chain.getBlockHash = () => new Promise(() => {});
    const pending = readCouncilCandidacy(w.api, A);
    t.mock.timers.tick(15000);
    await assert.rejects(pending, /timed out/);
    assert.equal(w.built.length, 0);
});

function uiWorld(role = 'Candidate', multisig = false) {
    const w = world(role), submitted = [];
    let selected = A, api = w.api, handler = async opts => { submitted.push(opts); await opts.buildTx(api); }, refreshed = 0;
    // Match the static shell's real IDs. The view uses textContent and existing
    // controls; these nodes only replace browser events, not transaction logic.
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const nodes = new Map([...html.matchAll(/id="((?:council-withdraw|close-council-withdraw|cancel-council-withdraw)[^"]*)"/g)].map(([, id]) => [id, {
        style: {}, textContent: '', innerHTML: '', disabled: false, checked: false, handlers: {},
        addEventListener(type, fn) { this.handlers[type] = fn; }, focus() {},
        async fire(type = 'click') { await this.handlers[type]?.({ target: this }); }
    }]));
    const get = id => nodes.get(id);
    const ui = createCouncilCandidacyUI({ api: () => api, selected: () => selected, isMultisig: () => multisig,
        document: { getElementById: get }, submit: opts => handler(opts), refresh: () => { refreshed++; }, connectPrompt: () => '<a>Connect wallet</a>' });
    return { ...w, ui, get, submitted, get refreshed() { return refreshed; },
        select: value => { selected = value; }, replaceApi: value => { api = value; }, submitWith: fn => { handler = fn; } };
}

test('a member must acknowledge immediate seat resignation before submitting', async () => {
    const w = uiWorld('Member');
    w.ui.refreshActions(w.state);
    assert.equal(w.get('council-withdraw-btn').textContent, 'Leave council');
    await w.ui.open();
    assert.match(w.get('council-withdraw-effect').textContent, /immediately gives up your council seat/);
    assert.equal(w.get('council-withdraw-sign').disabled, true);
    await w.get('council-withdraw-sign').fire(); assert.equal(w.submitted.length, 0);
    w.get('council-withdraw-ack').checked = true;
    await w.get('council-withdraw-ack').fire('change');
    assert.equal(w.get('council-withdraw-sign').disabled, false);
    await w.get('council-withdraw-sign').fire();
    assert.deepEqual(w.built, ['Member']);
    assert.equal(w.submitted[0].expectedWallet, A);
    assert.equal(w.submitted[0].action.key, 'elections.withdraw');
});

test('disconnected, ineligible and RPC-failed accounts cannot sign', async () => {
    const w = uiWorld(null);
    await w.ui.open();
    assert.match(w.get('council-withdraw-effect').textContent, /no candidacy to withdraw/);
    assert.equal(w.get('council-withdraw-sign').disabled, true);
    w.select(null); await w.ui.open();
    assert.match(w.get('council-withdraw-connect').innerHTML, /Connect wallet/);
    w.select(A); w.api.at = async () => { throw new Error('Disconnected'); };
    await w.ui.open(); await w.get('council-withdraw-sign').fire();
    assert.match(w.get('council-withdraw-error').textContent, /Disconnected/);
    assert.equal(w.submitted.length, 0);
});

test('an account switch or close during loading cannot enable a stale withdrawal', async () => {
    for (const change of [w => { w.select(B); }, w => { w.ui.close(); }, w => { w.replaceApi({}); }]) {
        const w = uiWorld(); let release;
        w.beforeRead(() => new Promise(resolve => { release = resolve; }));
        const pending = w.ui.open();
        await new Promise(resolve => setImmediate(resolve));
        change(w); release(); await pending;
        assert.equal(w.get('council-withdraw-sign').disabled, true);
        await w.get('council-withdraw-sign').fire(); assert.equal(w.submitted.length, 0);
    }
});

test('wallet changes while constructing the call prevent sending; failures require a fresh review', async () => {
    const w = uiWorld(); await w.ui.open();
    w.beforeRead(async () => { w.select(B); });
    await w.get('council-withdraw-sign').fire();
    assert.match(w.get('council-withdraw-error').textContent, /account, network, or review changed/);
    assert.equal(w.get('council-withdraw-sign').disabled, true);
    assert.equal(w.get('council-withdraw-retry').disabled, false);
    w.select(A); w.beforeRead(async () => {}); await w.ui.open();
    w.submitWith(async opts => { opts.onError('Rejected in wallet'); });
    await w.get('council-withdraw-sign').fire();
    assert.match(w.get('council-withdraw-error').textContent, /Rejected in wallet/);
    assert.equal(w.get('council-withdraw-sign').disabled, true);
});

test('normal success refreshes council data; multisig proposals wait for actual execution', async () => {
    const single = uiWorld(); await single.ui.open();
    single.submitWith(async opts => { await opts.buildTx(single.api); opts.onStage('finalized'); opts.onSuccess(); });
    await single.get('council-withdraw-sign').fire();
    assert.equal(single.refreshed, 1);
    assert.equal(single.get('council-withdraw-modal').style.display, 'none');
    const multi = uiWorld('Candidate', true); await multi.ui.open();
    assert.equal(multi.get('council-withdraw-sign').textContent, 'Review with multisig signers');
    assert.equal(multi.get('council-withdraw-multisig').style.display, 'block');
    await multi.get('council-withdraw-sign').fire();
    assert.equal(multi.refreshed, 0, 'a proposal is not an executed withdrawal');
    multi.submitted[0].onSuccess(); // Shared multisig review only calls this on execution.
    assert.equal(multi.refreshed, 1);
});

test('withdrawal status describes the actual role and explains runtime rejection', () => {
    assert.equal(successCopy('elections.withdraw', { role: 'Member' }).title, 'Council seat relinquished');
    assert.match(successCopy('elections.withdraw', { role: 'RunnerUp' }).body, /runner-up list/);
    assert.equal(buildTxModel({ key: 'elections.withdraw' }, 'signing').title, 'Withdrawing your council candidacy');
    for (const section of ['elections', 'electionsPhragmen', 'phragmenElection']) {
        const error = decodeDispatchError({ isModule: true, asModule: {} }, { findMetaError: () => ({ section, name: 'InvalidRenouncing', docs: [] }) });
        assert.match(error.text, /no longer has the council role/);
    }
});
