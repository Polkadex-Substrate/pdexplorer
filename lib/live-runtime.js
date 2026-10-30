// The runtime the explorer's LIVE paths assume: signing in the browser, and
// the server's reads at the chain head. Polkadex mainnet enacted runtime spec
// 392 on 29 October 2026 (block ~13,342,584); the code that kept signing and
// the head working on spec 373 is gone (docs/archive/392-readiness.md).
//
// This is NOT a gate on history. Every old block, extrinsic, event and storage
// item is still decoded with the runtime that produced it, through
// api.at(blockHash) and the per-registry hooks in lib/tx-extensions.js.
//
// A node that reports a spec below MIN_LIVE_SPEC at its head is out of date
// (a stale or still-syncing RPC node behind the load balancer, or a wrong
// endpoint). The live paths refuse it with one readable message instead of
// carrying on with assumptions that no longer hold.
//
// No imports beyond lib/, so the module loads the same way in Node, in the
// Vite bundle and in the tests.

import { apiSpecVersion, specOfRuntimeVersion } from './tx-extensions.js';

export const MIN_LIVE_SPEC = 392;

export function staleRuntimeMessage(spec, min = MIN_LIVE_SPEC) {
    return `The Polkadex node in use reports runtime spec ${spec}, older than spec ${min}, `
        + `which mainnet has run since 29 October 2026. That node is out of date or still syncing.`;
}

// { ok, status, specVersion, minSpec, message }. status is 'ok', 'stale'
// (spec known and below the minimum) or 'unknown' (no runtime version yet).
export function liveRuntimeStatus(api, min = MIN_LIVE_SPEC) {
    return statusForSpec(apiSpecVersion(api), min);
}

// The same status for a runtime version value taken from the node's own
// subscription callback. api.runtimeVersion is NOT used: polkadot.js keeps the
// old value across a reconnect until its own subscription catches up.
export function liveRuntimeStatusForVersion(version, min = MIN_LIVE_SPEC) {
    return statusForSpec(specOfRuntimeVersion(version), min);
}

function statusForSpec(spec, min) {
    if (spec === null) {
        return { ok: false, status: 'unknown', specVersion: null, minSpec: min,
            message: 'The node connection is not ready yet (runtime version unknown).' };
    }
    if (spec < min) {
        return { ok: false, status: 'stale', specVersion: spec, minSpec: min, message: staleRuntimeMessage(spec, min) };
    }
    return { ok: true, status: 'ok', specVersion: spec, minSpec: min, message: `runtime spec ${spec} (minimum ${min})` };
}

// The one message to show before signing, or null when signing may go ahead.
export function liveRuntimeError(api, min = MIN_LIVE_SPEC) {
    const s = liveRuntimeStatus(api, min);
    if (s.ok) return null;
    return s.status === 'stale'
        ? `${s.message} Nothing was signed or sent. Reload the page to reconnect; if this keeps happening, the node needs to catch up.`
        : `${s.message} Nothing was signed or sent. Please wait a moment and try again.`;
}

// One log line for a status, and which console method to use.
export function describeLiveRuntime(status, label = 'api') {
    const line = status.ok
        ? `[runtime] ${label} live runtime OK (spec ${status.specVersion}, minimum ${status.minSpec})`
        : `[runtime] ${label} live runtime FAILED (${status.status}): ${status.message}`;
    return { level: status.ok ? 'log' : 'loud', line };
}

// Follow the node's runtime version for as long as the api lives, so the
// result tracks the node actually connected: after a reconnect (possibly to a
// different node behind the load balancer) and after a runtime upgrade.
// polkadot.js re-subscribes on every reconnect and emits the new node's
// version; the callback reads the spec from that value, never from
// api.runtimeVersion.
//
//   onVersion(version, spec) runs when the spec CHANGES (the first value, when
//   it equals what the api already reports, is not repeated).
//
// Set up once per api instance (a second call returns the first handle).
// Returns { stop }: stop() unsubscribes, is idempotent, and is also run when
// api.disconnect() is called. Never throws; an api without the subscription
// (or one that refuses it) just gets a handle that does nothing.
const followed = new WeakMap();

export function followRuntimeVersion(api, onVersion) {
    if (!api || (typeof api !== 'object' && typeof api !== 'function')) return { stop() {} };
    if (followed.has(api)) return followed.get(api);

    let stopped = false;
    let unsub = null;
    let last = apiSpecVersion(api);
    const stop = () => {
        if (stopped) return;
        stopped = true;
        const u = unsub;
        unsub = null;
        if (typeof u === 'function') { try { u(); } catch (_) { /* already gone */ } }
    };
    const handle = { stop };
    followed.set(api, handle);

    try {
        const state = api.rpc && api.rpc.state;
        if (!state || typeof state.subscribeRuntimeVersion !== 'function') return handle;
        // Called as a method of state, never detached: the decorated function
        // is not safe to call without its owner.
        const pending = state.subscribeRuntimeVersion((version) => {
            if (stopped) return;
            const spec = specOfRuntimeVersion(version);
            if (spec === last) return;
            last = spec;
            try { onVersion(version, spec); } catch (_) { /* a failing listener must not end the subscription */ }
        });
        Promise.resolve(pending).then((u) => {
            if (stopped) { if (typeof u === 'function') { try { u(); } catch (_) { /* already gone */ } } }
            else unsub = u;
        }).catch(() => {});
    } catch (_) { return handle; }

    // Teardown: wrap the api's own disconnect (kept bound to the api, with
    // every argument and the return value passed through).
    try {
        const orig = api.disconnect;
        if (typeof orig === 'function') {
            api.disconnect = function (...args) {
                stop();
                return Reflect.apply(orig, this === undefined ? api : this, args);
            };
        }
    } catch (_) { /* a frozen api: stop() is still available */ }
    return handle;
}
