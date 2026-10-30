// A JSON-RPC provider for a REAL ApiPromise, with no network. It answers the
// calls ApiPromise makes while it boots (from the metadata and the runtime
// version it is given), records the name of every method and subscription it
// is asked for, and answers anything listed in `extra`. Anything else is
// rejected, so a test sees a method it did not expect instead of a hang.
//
// Used by the tests that boot a real ApiPromise (test/live-runtime.test.js).

import { TypeRegistry, Metadata } from '@polkadot/types';
import { u8aToHex } from '@polkadot/util';

export function mockProvider({ metadataHex, specVersion = 392, specName = 'node', transactionVersion = 3, extra = {} }) {
    const sent = [];
    const subscriptions = [];
    const handlers = { connected: [], disconnected: [], error: [] };
    const registry = new TypeRegistry();
    registry.setMetadata(new Metadata(registry, metadataHex));
    const genesis = '0x' + '11'.repeat(32);
    const runtimeVersion = {
        specName, implName: specName, authoringVersion: 1, specVersion, implVersion: 0,
        apis: [], transactionVersion, stateVersion: 1
    };
    const header = { parentHash: '0x' + '00'.repeat(32), number: '0x10', stateRoot: '0x' + '00'.repeat(32), extrinsicsRoot: '0x' + '00'.repeat(32), digest: { logs: [] } };
    const answers = {
        rpc_methods: () => ({ version: 1, methods: Object.keys(answers).concat(['chain_subscribeNewHeads', 'chain_unsubscribeNewHeads', 'state_subscribeRuntimeVersion', 'state_unsubscribeRuntimeVersion']) }),
        chain_getBlockHash: () => genesis,
        chain_getHeader: () => header,
        chain_getFinalizedHead: () => genesis,
        state_getRuntimeVersion: () => runtimeVersion,
        state_getMetadata: () => metadataHex,
        // Metadata_metadata_versions is refused, so the api falls back to
        // state_getMetadata (the metadata given) instead of asking for v15/v16.
        state_call: (params) => { if (extra.state_call) return extra.state_call(params, registry); throw new Error('state_call not mocked'); },
        system_chain: () => 'Mock',
        system_properties: () => ({ ss58Format: 88, tokenDecimals: 12, tokenSymbol: 'PDEX' }),
        system_name: () => 'mock',
        system_version: () => '0.0.0',
        system_health: () => ({ peers: 1, isSyncing: false, shouldHavePeers: true }),
        ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'state_call'))
    };
    let nextId = 1;
    const provider = {
        hasSubscriptions: true,
        isClonable: false,
        isConnected: true,
        stats: { active: { requests: 0, subscriptions: 0 }, total: { bytesRecv: 0, bytesSent: 0, cached: 0, errors: 0, requests: 0, subscriptions: 0, timeout: 0 } },
        clone() { throw new Error('not clonable'); },
        async connect() {},
        async disconnect() { this.isConnected = false; },
        // isConnected is true from the start, which is how ApiPromise learns
        // it may boot; firing 'connected' as well would boot it twice.
        on(type, cb) { (handlers[type] = handlers[type] || []).push(cb); return () => {}; },
        async send(method, params) {
            sent.push(method);
            const a = answers[method];
            if (!a) throw new Error(`mock provider: ${method} not mocked`);
            return a(params, registry);
        },
        async subscribe(type, method, params, cb) {
            sent.push(method);
            subscriptions.push({ type, method, params, cb });
            const id = nextId++;
            if (method === 'state_subscribeRuntimeVersion') setTimeout(() => cb(null, runtimeVersion), 0);
            if (/^chain_subscribe/.test(method)) setTimeout(() => cb(null, header), 0);
            return id;
        },
        async unsubscribe(type, method) { sent.push(method); return true; }
    };
    return { provider, sent, subscriptions, registry, runtimeVersion, header, u8aToHex };
}
