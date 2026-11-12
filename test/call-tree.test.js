// lib/call-tree.js: a decoded call (or event) from REAL @polkadot/types
// codecs, built from Substrate's runtime metadata, into the plain typed tree
// the explorer's pages and API send: every argument keeps its declared type
// name (BalanceOf, Balance, AccountIdLookupOf...) and its value as a typed node,
// and nested calls (utility.batch, proxy.proxy, sudo, council.propose,
// democracy's inline Bounded call, scheduler) are decoded recursively.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { encodeAddress } from '@polkadot/util-crypto';
import { registryFromMetadata } from './helpers/extrinsic-builders.js';
import { codecToNode, callToTree, eventToTree, argEntries, collectAssetIds, assetIdOf } from '../lib/call-tree.js';

const registry = registryFromMetadata(substrateMetadata);
registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 88, tokenDecimals: 12, tokenSymbol: 'PDEX' }));
const ex = decorateExtrinsics(registry, registry.metadata, 15);
// Synthetic accounts (filler bytes, SS58 prefix 88), never real ones.
const A = encodeAddress(new Uint8Array(32).fill(7), 88);
const B = encodeAddress(new Uint8Array(32).fill(9), 88);
const call = (c) => registry.createType('Call', c.toHex());
const arg = (tree, name) => tree.args.find(a => a.name === name);

describe('callToTree: one call', () => {
    test('balances.transferKeepAlive: names, type names, exact decimal amount, account string', () => {
        const t = callToTree(call(ex.balances.transferKeepAlive(A, 1234567890123456789n)));
        assert.equal(t.section, 'balances');
        assert.equal(t.method, 'transferKeepAlive');
        assert.deepEqual(t.args.map(a => a.name), ['dest', 'value']);
        const value = arg(t, 'value');
        assert.equal(value.typeName, 'Balance');
        assert.deepEqual({ k: value.node.k, v: value.node.v }, { k: 'num', v: '1234567890123456789' });
        const dest = arg(t, 'dest');
        assert.equal(dest.typeName, 'AccountIdLookupOf');
        assert.equal(dest.node.k, 'enum');
        assert.equal(dest.node.e, 'Id');
        assert.deepEqual({ k: dest.node.v.k, v: dest.node.v.v }, { k: 'acct', v: A });
    });

    test('staking.bond: BalanceOf amount as a decimal string, reward destination as an enum', () => {
        const t = callToTree(call(ex.staking.bond(5_000_000_000_000n, 'Staked')));
        const value = arg(t, 'value');
        assert.equal(value.typeName, 'BalanceOf');
        assert.equal(value.node.v, '5000000000000');
        assert.equal(arg(t, 'payee').node.e, 'Staked');
    });

    test('treasury.spend: Compact amount, Option validFrom (none and some), unit-like asset kind', () => {
        const none = callToTree(call(ex.treasury.spend(null, 50_000n * 10n ** 12n, { Id: A }, null)));
        assert.equal(arg(none, 'amount').typeName, 'AssetBalanceOf');
        assert.equal(arg(none, 'amount').node.v, '50000000000000000');
        assert.equal(arg(none, 'validFrom').node.k, 'none');
        assert.equal(arg(none, 'assetKind').node.e, 'Native');
        const some = callToTree(call(ex.treasury.spend(null, 5n, { Id: B }, 123456)));
        assert.equal(arg(some, 'validFrom').node.v, '123456');
        assert.equal(arg(some, 'validFrom').typeName, 'Option<BlockNumberFor>');
    });

    test('a u128 that is not a balance keeps its type name so it stays raw', () => {
        const t = callToTree(call(ex.assets.transfer(7n, { Id: A }, 5n)));
        assert.equal(arg(t, 'id').typeName, 'AssetIdParameter');
        assert.equal(arg(t, 'id').node.v, '7');
        assert.equal(arg(t, 'amount').typeName, 'Balance');
    });

    test('values that are big enough to be hex in toJSON stay decimal', () => {
        const big = (2n ** 100n) + 1n;
        const t = callToTree(call(ex.balances.transferKeepAlive(A, big)));
        assert.equal(arg(t, 'value').node.v, big.toString());
    });
});

describe('callToTree: nested calls', () => {
    test('utility.batch holds a list of decoded calls', () => {
        const t = callToTree(call(ex.utility.batch([ex.balances.transferKeepAlive(A, 5n), ex.balances.transferKeepAlive(B, 6n)])));
        const calls = arg(t, 'calls').node;
        assert.equal(calls.k, 'vec');
        assert.equal(calls.v.length, 2);
        assert.equal(calls.v[0].k, 'call');
        assert.equal(calls.v[1].v.section + '.' + calls.v[1].v.method, 'balances.transferKeepAlive');
        assert.equal(arg(calls.v[1].v, 'value').node.v, '6');
    });

    test('proxy.proxy wraps one call', () => {
        const t = callToTree(call(ex.proxy.proxy(A, null, ex.balances.transferKeepAlive(B, 9n))));
        const inner = arg(t, 'call').node;
        assert.equal(inner.k, 'call');
        assert.equal(inner.v.method, 'transferKeepAlive');
    });

    test('council.propose decodes the proposal it carries', () => {
        const t = callToTree(call(ex.council.propose(3, ex.treasury.spend(null, 7n, { Id: A }, null), 40)));
        const inner = arg(t, 'proposal').node;
        assert.equal(inner.k, 'call');
        assert.equal(inner.v.section + '.' + inner.v.method, 'treasury.spend');
        assert.equal(arg(t, 'lengthBound').node.v, '40');
    });

    test('democracy.externalProposeMajority: the inline call inside Bounded is decoded; a Lookup stays a hash', () => {
        const inner = ex.balances.transferKeepAlive(A, 5n);
        const inline = callToTree(call(ex.democracy.externalProposeMajority({ Inline: inner.toHex() })));
        const node = arg(inline, 'proposal').node;
        assert.equal(node.k, 'enum');
        assert.equal(node.e, 'Inline');
        assert.equal(node.v.k, 'call');
        assert.equal(node.v.v.method, 'transferKeepAlive');
        const hash = '0x' + 'ab'.repeat(32);
        const lookup = callToTree(call(ex.democracy.externalProposeMajority({ Lookup: { hash, len: 40 } })));
        const l = arg(lookup, 'proposal').node;
        assert.equal(l.e, 'Lookup');
        assert.equal(l.v.k, 'struct');
        assert.equal(l.v.v.hash.v, hash);
    });

    test('scheduler.schedule carries its call; an undecodable inline blob does not throw', () => {
        const t = callToTree(call(ex.scheduler.schedule(100, null, 0, ex.balances.transferKeepAlive(A, 1n))));
        assert.equal(arg(t, 'call').node.v.method, 'transferKeepAlive');
        const bad = callToTree(call(ex.democracy.externalProposeMajority({ Inline: '0xffff' })));
        assert.ok(['enum', 'trunc', 'raw'].includes(arg(bad, 'proposal').node.k));
    });

    test('depth and size are capped, so a hostile nesting cannot blow the payload', () => {
        let c = ex.balances.transferKeepAlive(A, 1n);
        for (let i = 0; i < 12; i++) c = ex.utility.batch([c]);
        const t = callToTree(call(c), { limits: { depth: 4 } });
        const json = JSON.stringify(t);
        assert.ok(json.includes('"k":"trunc"'));
        assert.ok(json.length < 20000);
    });

    test('long text and byte strings are cut', () => {
        const t = callToTree(call(ex.system.remark('0x' + '61'.repeat(5000))));
        const n = arg(t, 'remark').node;
        assert.ok(JSON.stringify(n).length < 2000);
    });
});

describe('argEntries and codecToNode', () => {
    test('argEntries returns name, type, typeName and node per argument', () => {
        const entries = argEntries(call(ex.balances.transferKeepAlive(A, 5n)));
        assert.equal(entries.length, 2);
        assert.deepEqual(Object.keys(entries[1]).sort(), ['name', 'node', 'type', 'typeName']);
        assert.equal(entries[1].type, 'Balance');
    });

    test('booleans, text and fixed hashes', () => {
        assert.deepEqual(codecToNode(registry.createType('bool', true)), { k: 'bool', v: true });
        assert.deepEqual(codecToNode(registry.createType('Text', 'hi <b>')), { k: 'text', v: 'hi <b>' });
        const h = registry.createType('H256', '0x' + '11'.repeat(32));
        assert.deepEqual(codecToNode(h), { k: 'hex', v: '0x' + '11'.repeat(32), b: 32 });
    });

    test('Perbill keeps its raw type for the percent rule', () => {
        const n = codecToNode(registry.createType('Perbill', 250_000_000));
        assert.equal(n.k, 'num');
        assert.equal(n.t, 'Perbill');
        assert.equal(n.v, '250000000');
    });
});

describe('eventToTree', () => {
    test('an event keeps field names and type names', () => {
        const ev = registry.createType('Event', new Uint8Array([5, 2, ...new Array(32).fill(1), ...new Array(32).fill(2), ...new Array(16).fill(0)]));
        const t = eventToTree(ev);
        assert.equal(t.section, ev.section);
        assert.equal(t.method, ev.method);
        assert.ok(t.args.length >= 1);
        assert.ok(t.args.every(a => typeof a.name === 'string' && a.node && a.node.k));
    });
});

describe('asset ids', () => {
    test('collectAssetIds finds the asset a call names, also inside a batch, once each', () => {
        const t = callToTree(call(ex.utility.batch([ex.assets.transfer(7n, { Id: A }, 5n), ex.assets.transfer(7n, { Id: B }, 6n), ex.assets.transfer(9n, { Id: B }, 1n), ex.balances.transferKeepAlive(A, 1n)])));
        assert.deepEqual(collectAssetIds(t).sort(), ['7', '9']);
        assert.deepEqual(collectAssetIds(callToTree(call(ex.balances.transferKeepAlive(A, 1n)))), []);
    });
    test('the number of ids is capped', () => {
        const t = callToTree(call(ex.utility.batch([1n, 2n, 3n, 4n].map(i => ex.assets.transfer(i, { Id: A }, 1n)))));
        assert.equal(collectAssetIds(t, 2).length, 2);
    });
    test('assetIdOf reads id, assetId and WithId', () => {
        assert.equal(assetIdOf([{ name: 'assetId', node: { k: 'num', v: '4' } }]), '4');
        assert.equal(assetIdOf([{ name: 'assetKind', node: { k: 'enum', e: 'WithId', v: { k: 'num', v: '5' } } }]), '5');
        assert.equal(assetIdOf([{ name: 'assetKind', node: { k: 'enum', e: 'Native', v: null } }]), null);
    });
    test('event field names are camelCased like call argument names', () => {
        const fake = { section: 'assets', method: 'Transferred', meta: { fields: [{ name: { isSome: true, unwrap: () => 'asset_id' }, typeName: { isSome: true, unwrap: () => 'T::AssetId' } }] }, data: [registry.createType('u32', 7)] };
        const t = eventToTree(fake);
        assert.equal(t.args[0].name, 'assetId');
        assert.equal(t.args[0].node.v, '7');
    });
});
