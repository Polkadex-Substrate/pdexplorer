// Substrate JSON-RPC: the current names for the two places the explorer used
// a deprecated or aliased method. Inventory and sources:
// docs/rpc-methods.md. No imports, so this loads the same way in Node, in the
// Vite bundle and in the tests.

// 1. chain_subscribeNewHead -> chain_subscribeNewHeads.
//
// @polkadot/api 17.0.2 sends `chain_subscribeNewHead` / `chain_unsubscribeNewHead`
// (singular) for api.rpc.chain.subscribeNewHeads, an alias it keeps for 1.x
// nodes (@polkadot/types interfaces/chain/rpc.js, "These still has the
// aliassed version"). polkadot-sdk's canonical names are
// `chain_subscribeNewHeads` / `chain_unsubscribeNewHeads` (sc-rpc-api, chain);
// the singular forms are only aliases there. The notification method is
// `chain_newHead` either way, so only the subscribe and unsubscribe names
// change. Passed as ApiPromise.create({ rpc: canonicalRpc() }), which
// @polkadot/rpc-core merges over its own definition (user definitions win).
// The aliases are listed so the api does not report them as unknown methods.
//
// polkadot-js removes api.rpc.chain.subscribeNewHeads at start-up unless the
// node's rpc_methods lists `chain_subscribeNewHeads`
// (api/base/Decorate.js _filterRpcMethods), so a node without the canonical
// name would already have broken the live block stream before this change.
export function canonicalRpc() {
    return {
        chain: {
            subscribeNewHeads: {
                alias: ['chain_subscribeNewHead', 'chain_unsubscribeNewHead', 'subscribe_newHead', 'unsubscribe_newHead'],
                description: 'Retrieves the best header via subscription',
                params: [],
                pubsub: ['newHead', 'subscribeNewHeads', 'unsubscribeNewHeads'],
                type: 'Header'
            }
        }
    };
}

// 2. payment_queryInfo -> TransactionPaymentApi_query_info (runtime API).
//
// The payment_* RPCs are deprecated in favour of the TransactionPaymentApi
// runtime API (@polkadot/types marks payment_queryInfo deprecated: "Use
// api.call.transactionPaymentApi.queryInfo instead"). TransactionPaymentApi
// with query_info is in both the 373 and the 392 metadata. The /chain-state
// RPC console offered payment_queryInfo; it now offers
// transactionPaymentApi_queryInfo with the same parameters
// ([extrinsicHex, atBlockHash?]), run through api.call (state_call with the
// library's own encoding) and, with a block hash, through api.at(hash) so the
// call is encoded for that block's runtime.

export class ConsoleParamError extends Error {
    constructor(message) { super(message); this.name = 'ConsoleParamError'; this.consoleParam = true; }
}

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/;
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;

export async function queryInfoViaRuntimeApi(api, params) {
    const [extrinsic, at] = Array.isArray(params) ? params : [];
    if (typeof extrinsic !== 'string' || !HEX_BYTES.test(extrinsic)) {
        throw new ConsoleParamError('params[0] must be the extrinsic as 0x-prefixed hex.');
    }
    if (at !== undefined && at !== null && !(typeof at === 'string' && BLOCK_HASH.test(at))) {
        throw new ConsoleParamError('params[1], if given, must be a 0x-prefixed 32-byte block hash.');
    }
    // No api at all means the node link is down, which is the server's
    // condition and not the caller's: a plain Error carrying statusCode 503
    // (serverError passes that through), never the 400 below that says the
    // runtime lacks the API.
    if (!api) {
        const err = new Error('The chain node is not connected. Please retry shortly.');
        err.statusCode = 503;
        throw err;
    }
    const target = at ? await api.at(at) : api;
    const fn = target && target.call && target.call.transactionPaymentApi && target.call.transactionPaymentApi.queryInfo;
    if (typeof fn !== 'function') {
        throw new ConsoleParamError('TransactionPaymentApi.query_info is not available on this runtime.');
    }
    // The runtime API takes the encoded length too: the byte length of the
    // extrinsic as submitted, which is what tx.paymentInfo passes.
    return fn(extrinsic, (extrinsic.length - 2) / 2);
}

// Console entries that run a runtime API instead of a JSON-RPC method, keyed
// by the name the console shows. `replaces` is the deprecated RPC it stands in for.
export const RUNTIME_API_CONSOLE = Object.freeze({
    transactionPaymentApi_queryInfo: Object.freeze({ replaces: 'payment_queryInfo', run: queryInfoViaRuntimeApi })
});
