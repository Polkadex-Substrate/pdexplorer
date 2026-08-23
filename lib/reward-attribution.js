// Which validator paid this reward, when one extrinsic paid several?
//
// Audit F-002, indexer half. `staking.payoutStakers(validator, era)` emits one
// `staking.Rewarded` event per recipient. Wrapped in `utility.batch` — which is
// how every real claim UI submits, including ours — a single extrinsic pays N
// validators, and the old code gave up:
//
//     validator: inner.length === 1 ? result.validator : null
//
// A null validator makes the claimed row unmatchable against the chain's
// unclaimed set (see lib/reward-dedup.js), so the era got counted twice.
//
// It is recoverable without guessing. `utility` emits `ItemCompleted` after
// each top-level batch item, in order, so the events between the (k-1)th and
// kth `ItemCompleted` belong to batch item k. Counting those delimiters gives
// exact attribution rather than an assumption about event ordering.
//
// (`batchAll` emits ItemCompleted per item too, and `forceBatch` emits
// ItemCompleted or ItemFailed — both are treated as delimiters.)
//
// LIMIT, deliberately enforced by isAttributableBatch below: delimiter counting
// is only sound when every top-level item is a DIRECT payoutStakers call. A
// nested batch, a proxy wrapper, or utility.asDerivative emits ItemCompleted
// events of its own, which shifts the count and attributes a reward to the
// wrong validator. For `batch([batch([payout(A,e), payout(B,e)]), payout(C,e)])`
// there are two top-level items but three delimiters, so B's reward would be
// filed under C. That is strictly worse than the null it replaced: a null is
// visibly unknown, whereas a confident wrong validator corrupts the payout UI
// in both directions (suppresses a real entitlement for C, offers an
// already-claimed one for B). So anything we can't count exactly falls back to
// the old conservative null.

// Is this event one of utility's batch-item delimiters?
export function isBatchDelimiter(section, method) {
    return section === 'utility' && (method === 'ItemCompleted' || method === 'ItemFailed');
}

// A call we can attribute by position: staking.payoutStakers itself, with no
// wrapper that could emit extra delimiters.
export function isDirectPayoutCall(call) {
    return !!call && call.section === 'staking' &&
        (call.method === 'payoutStakers' || call.method === 'payoutStakersByPage');
}

// Can the delimiter count be trusted for this batch's top-level items?
export function isAttributableBatch(innerCalls) {
    const calls = innerCalls ? Array.from(innerCalls) : [];
    if (calls.length === 0) return false;
    return calls.every(isDirectPayoutCall);
}

// batchCalls: ordered descriptors for the batch's TOP-LEVEL items, one entry
//   per item, `{era, validator}` — nulls for items that are not payouts. The
//   position matters, so non-payout items must still occupy a slot.
// sequence: the extrinsic's events in chain order, as
//   `{ kind: 'delimiter' }` or `{ kind: 'reward', ref: <any key> }`.
//
// Returns Map<ref, {era, validator}>.
export function attributeBatchRewards(batchCalls, sequence) {
    const calls = batchCalls || [];
    const out = new Map();
    let item = 0;
    for (const entry of (sequence || [])) {
        if (!entry) continue;
        if (entry.kind === 'delimiter') { item++; continue; }
        if (entry.kind !== 'reward') continue;
        const call = calls[item];
        out.set(entry.ref, {
            era: call && call.era != null ? call.era : null,
            validator: call && call.validator ? call.validator : null
        });
    }
    return out;
}
