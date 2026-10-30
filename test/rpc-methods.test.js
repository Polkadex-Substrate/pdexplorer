// The Substrate JSON-RPC methods the explorer sends are current: no deprecated
// method and no alias where polkadot-sdk has a canonical name. The two
// replacements (lib/rpc-methods.js) run against a REAL ApiPromise booted
// through a mock provider that records every method name it is asked for.
// Inventory: docs/rpc-methods.md.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiPromise } from '@polkadot/api';
import { TypeRegistry, GenericExtrinsic, rpcDefinitions } from '@polkadot/types';
import { blake2AsHex } from '@polkadot/util-crypto';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { canonicalRpc, queryInfoViaRuntimeApi, RUNTIME_API_CONSOLE } from '../lib/rpc-methods.js';
import { installPolkadotFixes } from '../lib/tx-extensions.js';
import { mockProvider } from './helpers/mock-provider.js';
import { loadFixture } from './helpers/extrinsic-builders.js';
import { stripComments } from './helpers/source.js';

installPolkadotFixes({ TypeRegistry, GenericExtrinsic });

// Every method name @polkadot/types marks deprecated, and every alias whose
// canonical name the library also knows. Read from the library, not typed in.
const DEPRECATED = new Set();
const ALIASES = new Set();
for (const [section, defs] of Object.entries(rpcDefinitions)) {
    for (const [method, def] of Object.entries(defs)) {
        if (def.deprecated) DEPRECATED.add(`${section}_${method}`);
        for (const a of def.alias || []) ALIASES.add(a);
    }
}

const fx392 = loadFixture('metadata-392.json');
const metadataHex = fx392 ? fx392.metadata : substrateMetadata;
const TX_PAYMENT_API = [blake2AsHex('TransactionPaymentApi', 64), 4];

function dispatchInfoAnswer(seen) {
    return (params, registry) => {
        seen.push(params);
        return registry.createType('RuntimeDispatchInfo', { weight: { refTime: 5, proofSize: 6 }, class: 'Normal', partialFee: 7 }).toHex();
    };
}

async function boot(opts = {}) {
    const stateCalls = [];
    const m = mockProvider({ metadataHex, specVersion: 392, apis: [TX_PAYMENT_API], extra: { state_call: dispatchInfoAnswer(stateCalls) } });
    const api = await ApiPromise.create({ provider: m.provider, noInitWarn: true, ...opts });
    return { m, api, stateCalls };
}

describe('the library facts the replacements rest on', () => {
    test('@polkadot/types still marks the payment_* RPCs deprecated', () => {
        assert.ok(DEPRECATED.has('payment_queryInfo'));
        assert.ok(DEPRECATED.has('payment_queryFeeDetails'));
        assert.ok(DEPRECATED.has('state_getKeys') && DEPRECATED.has('state_getPairs'));
    });

    test('without the override the library sends the chain_subscribeNewHead alias', async () => {
        // The control: if upstream starts sending the canonical name itself,
        // this fails and canonicalRpc() can go.
        const { m, api } = await boot();
        try {
            await api.rpc.chain.subscribeNewHeads(() => {});
            assert.ok(m.sent.includes('chain_subscribeNewHead'), m.sent.join(','));
            assert.ok(!m.sent.includes('chain_subscribeNewHeads'));
        } finally { await api.disconnect(); }
    });

    test('tx.paymentInfo in the installed @polkadot/api uses the runtime API, not payment_queryInfo', () => {
        const src = readFileSync(new URL('../node_modules/@polkadot/api/submittable/createClass.js', import.meta.url), 'utf8');
        const fn = src.slice(src.indexOf('paymentInfo(account'), src.indexOf('paymentInfo(account') + 1600);
        assert.match(fn, /transactionPaymentApi\.queryInfo\(u8a, u8a\.length\)/);
        assert.doesNotMatch(fn, /rpc\.payment/);
    });
});

describe('replacement 1: chain_subscribeNewHead -> chain_subscribeNewHeads', () => {
    test('with canonicalRpc() the api subscribes with the canonical name', async () => {
        const { m, api } = await boot({ rpc: canonicalRpc() });
        try {
            let resolveHead;
            const first = new Promise((r) => { resolveHead = r; });
            const unsub = await api.rpc.chain.subscribeNewHeads((h) => resolveHead(h));
            const got = await first;
            assert.ok(m.sent.includes('chain_subscribeNewHeads'), m.sent.join(','));
            assert.ok(!m.sent.includes('chain_subscribeNewHead'));
            assert.equal(got.number.toNumber(), 16, 'the header still decodes');
            const sub = m.subscriptions.find(s => s.method === 'chain_subscribeNewHeads');
            assert.equal(sub.type, 'chain_newHead', 'the notification name is unchanged');
            unsub();
        } finally { await api.disconnect(); }
    });

    test('canonicalRpc() returns a fresh object each time', () => {
        const a = canonicalRpc();
        a.chain.subscribeNewHeads.pubsub[1] = 'x';
        assert.equal(canonicalRpc().chain.subscribeNewHeads.pubsub[1], 'subscribeNewHeads');
    });
});

describe('replacement 2: payment_queryInfo -> TransactionPaymentApi_query_info', () => {
    test('at the head: one state_call to the runtime API with the extrinsic and its length', async () => {
        const { m, api, stateCalls } = await boot({ rpc: canonicalRpc() });
        try {
            const xt = api.tx.system.remark('0x1234').toHex();
            const info = await queryInfoViaRuntimeApi(api, [xt]);
            assert.equal(info.partialFee.toString(), '7');
            assert.equal(stateCalls.length, 1);
            assert.equal(stateCalls[0][0], 'TransactionPaymentApi_query_info');
            const args = stateCalls[0][1];
            const len = (xt.length - 2) / 2;
            // The library encodes the extrinsic argument as the runtime's
            // metadata types it (Polkadex: the bytes as is; Substrate's own
            // metadata: with one more length prefix), then the length as u32.
            const lenHex = Buffer.from(Uint32Array.of(len).buffer).toString('hex');
            assert.ok(args.endsWith(xt.slice(2) + lenHex), `args ${args} carry ${xt} then its length ${len}`);
            assert.ok(!m.sent.some(x => x.startsWith('payment_')), m.sent.join(','));
        } finally { await api.disconnect(); }
    });

    test('at a block hash: the call goes to that block', async () => {
        const { api, stateCalls } = await boot({ rpc: canonicalRpc() });
        try {
            const at = '0x' + 'ab'.repeat(32);
            await queryInfoViaRuntimeApi(api, [api.tx.system.remark('0x01').toHex(), at]);
            assert.equal(stateCalls.at(-1)[0], 'TransactionPaymentApi_query_info');
            assert.equal(stateCalls.at(-1)[2], at);
        } finally { await api.disconnect(); }
    });

    test('bad parameters are the caller\'s mistake, said plainly', async () => {
        const api = { call: { transactionPaymentApi: { queryInfo: () => assert.fail('must not be called') } } };
        for (const params of [[], ['nothex'], ['0x123'], [42], ['0x00', 'latest'], ['0x00', '0x1234']]) {
            await assert.rejects(queryInfoViaRuntimeApi(api, params), (e) => e.consoleParam === true && /^params\[[01]\]/.test(e.message), JSON.stringify(params));
        }
        await assert.rejects(queryInfoViaRuntimeApi({ call: {} }, ['0x00']), /TransactionPaymentApi\.query_info is not available on this runtime/);
    });

    test('no api (node link down) is a 503 the server passes through, not a 400 about the runtime', async () => {
        for (const params of [['0x00'], ['0x00', '0x' + 'ab'.repeat(32)]]) {
            for (const api of [null, undefined]) {
                await assert.rejects(queryInfoViaRuntimeApi(api, params), (e) => e.statusCode === 503 && !e.consoleParam && !/not available on this runtime/.test(e.message));
            }
        }
        // Bad parameters are still the caller's 400, api or not.
        await assert.rejects(queryInfoViaRuntimeApi(null, ['nothex']), (e) => e.consoleParam === true);
        const server = stripComments(readFileSync(new URL('../server.js', import.meta.url), 'utf8'));
        assert.match(server, /if \(err && err\.statusCode === 503 && err\.message\)/);
    });

    test('the console entry names what it replaces', () => {
        assert.deepEqual(Object.keys(RUNTIME_API_CONSOLE), ['transactionPaymentApi_queryInfo']);
        assert.equal(RUNTIME_API_CONSOLE.transactionPaymentApi_queryInfo.replaces, 'payment_queryInfo');
    });
});

describe('what a booted api sends is current', () => {
    test('boot, head subscription and a fee query: no deprecated method, no alias', async () => {
        const { m, api } = await boot({ rpc: canonicalRpc() });
        try {
            await api.rpc.chain.subscribeNewHeads(() => {});
            await queryInfoViaRuntimeApi(api, [api.tx.system.remark('0x01').toHex()]);
            const bad = m.sent.filter(x => DEPRECATED.has(x) || ALIASES.has(x));
            assert.deepEqual(bad, [], `sent: ${[...new Set(m.sent)].join(', ')}`);
        } finally { await api.disconnect(); }
    });
});

describe('wiring', () => {
    const server = stripComments(readFileSync(new URL('../server.js', import.meta.url), 'utf8'));
    const script = stripComments(readFileSync(new URL('../script.js', import.meta.url), 'utf8'));

    test('both ApiPromise.create calls pass canonicalRpc()', () => {
        assert.match(server, /ApiPromise\.create\(\{ provider: wsProvider, rpc: canonicalRpc\(\) \}\)/);
        assert.match(script, /ApiPromise\.create\(\{ provider: wsProvider, rpc: canonicalRpc\(\) \}\)/);
        assert.doesNotMatch(server + script, /ApiPromise\.create\(\{ provider: wsProvider \}\)/);
    });

    test('the RPC console allowlist has no deprecated method and offers the runtime API instead', () => {
        const block = server.slice(server.indexOf('const RPC_ALLOWLIST'), server.indexOf(']);', server.indexOf('const RPC_ALLOWLIST')));
        const entries = [...block.matchAll(/'([A-Za-z]+_[A-Za-z]+)'/g)].map(x => x[1]);
        assert.ok(entries.length > 10);
        assert.deepEqual(entries.filter(e => DEPRECATED.has(e) || ALIASES.has(e)), []);
        assert.ok(!entries.includes('payment_queryInfo'));
        assert.ok(entries.includes('transactionPaymentApi_queryInfo'));
    });

    test('the console dispatches runtime API entries before the RPC lookup', () => {
        const fn = server.slice(server.indexOf("app.post('/api/rpc/call'"), server.indexOf('const value = await withRpcBudget(method, () => target(...params))'));
        const dispatch = fn.indexOf('if (RUNTIME_API_CONSOLE[method]) return runConsoleRuntimeApi(req, res, method, params);');
        assert.ok(dispatch > 0 && dispatch < fn.indexOf('globalApi.rpc[section]'));
        assert.ok(fn.indexOf('RPC_ALLOWLIST.has(method)') < dispatch, 'the allowlist still decides first');
        assert.match(server, /if \(err && err\.consoleParam\) return res\.status\(400\)\.json\(\{ error: err\.message \}\)/);
    });

    test('no raw deprecated RPC anywhere in the shipped code', () => {
        const files = ['server.js', 'script.js', 'lib/tx-submit.js', 'lib/extrinsic-decode.js', 'tools/rpc-health.mjs',
            'tools/link-motion-threads.mjs', 'scripts/fetch-metadata.mjs', 'lib/json-rpc-client.js'];
        for (const f of files) {
            const src = stripComments(readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
            for (const name of [...DEPRECATED, ...ALIASES]) {
                assert.ok(!src.includes(`'${name}'`), `${f} names the deprecated or aliased RPC ${name}`);
            }
            assert.doesNotMatch(src, /\.rpc\.payment\.|\.rpc\.state\.getKeys\(|\.rpc\.state\.getPairs\(/, f);
        }
    });
});
