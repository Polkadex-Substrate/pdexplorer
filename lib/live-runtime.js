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

import { apiSpecVersion } from './tx-extensions.js';

export const MIN_LIVE_SPEC = 392;

export function staleRuntimeMessage(spec, min = MIN_LIVE_SPEC) {
    return `The Polkadex node in use reports runtime spec ${spec}, older than spec ${min}, `
        + `which mainnet has run since 29 October 2026. That node is out of date or still syncing.`;
}

// { ok, status, specVersion, minSpec, message }. status is 'ok', 'stale'
// (spec known and below the minimum) or 'unknown' (no runtime version yet).
export function liveRuntimeStatus(api, min = MIN_LIVE_SPEC) {
    const spec = apiSpecVersion(api);
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
