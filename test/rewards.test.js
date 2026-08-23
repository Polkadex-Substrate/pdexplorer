// Regression tests for the F-002 rewards double-count.
//
// Two independent defects added up to one wrong number on the My Account
// "Total Rewards" card:
//
//   1. A utility.batch paying several validators stored validator = null, so
//      the claimed key "1234|" could never match the unclaimed key
//      "1234|<validator>" (lib/reward-attribution.js).
//   2. The only dedup ran inside recomputeUnclaimed(), which by definition
//      does not run while the cached unclaimed set is fresh — so right after a
//      claim the era sat in BOTH lists and totalAmount added it twice
//      (lib/reward-dedup.js).
//
// This is a DISPLAY bug, not a signing bug: payout signs
// payoutStakers(validator, era) and never signs summary.totalAmount. The tests
// are still worth having — a wallet that tells a user they have more than they
// do is a wallet they stop trusting.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    claimedRewardKey, buildClaimedIndex, filterUnclaimed, summarizeRewards
} from '../lib/reward-dedup.js';
import {
    attributeBatchRewards, isBatchDelimiter, isDirectPayoutCall, isAttributableBatch
} from '../lib/reward-attribution.js';

const V1 = '5CqWfdrRGdZe6bwxZMiHfdcNAVePjkUJpSh2rpKgcCJHT2Xa';
const V2 = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';

describe('filterUnclaimed — stale cache after a claim (defect 2)', () => {
    test('drops an unclaimed row the claimed rows already cover', () => {
        const claimed = [{ era: 1234, validator: V1, amount: 5 }];
        const unclaimed = [{ era: 1234, validator: V1, amount: 5 }];
        const { kept, suppressed } = filterUnclaimed(unclaimed, buildClaimedIndex(claimed));
        assert.equal(kept.length, 0);
        assert.equal(suppressed.length, 1);
    });

    test('keeps a genuinely different validator in the same era', () => {
        // Claiming V1 for era 1234 says nothing about V2 for era 1234. This is
        // the over-correction to guard against: suppressing the whole era here
        // would hide money the user is actually owed.
        const claimed = [{ era: 1234, validator: V1, amount: 5 }];
        const unclaimed = [{ era: 1234, validator: V2, amount: 7 }];
        const { kept } = filterUnclaimed(unclaimed, buildClaimedIndex(claimed));
        assert.deepEqual(kept.map(r => r.validator), [V2]);
    });

    test('keeps a different era for the same validator', () => {
        const claimed = [{ era: 1234, validator: V1, amount: 5 }];
        const unclaimed = [{ era: 1235, validator: V1, amount: 7 }];
        const { kept } = filterUnclaimed(unclaimed, buildClaimedIndex(claimed));
        assert.equal(kept.length, 1);
    });

    test('an unattributed claimed row suppresses its whole era (defect 1 fallback)', () => {
        // Rows indexed before the attribution fix carry validator = null. We
        // cannot match them pairwise, and reporting money as both received and
        // still owed is the worse error, so the era is suppressed.
        const claimed = [{ era: 1234, validator: null, amount: 12 }];
        const unclaimed = [
            { era: 1234, validator: V1, amount: 5 },
            { era: 1234, validator: V2, amount: 7 },
            { era: 1235, validator: V1, amount: 9 }
        ];
        const { kept, suppressed } = filterUnclaimed(unclaimed, buildClaimedIndex(claimed));
        assert.equal(suppressed.length, 2);
        assert.deepEqual(kept.map(r => r.era), [1235]);
    });

    test('a null-era unclaimed row is passed through, not silently dropped', () => {
        const { kept } = filterUnclaimed([{ era: null, validator: V1, amount: 3 }], buildClaimedIndex([]));
        assert.equal(kept.length, 1);
    });

    test('handles empty and missing inputs', () => {
        assert.deepEqual(filterUnclaimed([], buildClaimedIndex([])).kept, []);
        assert.deepEqual(filterUnclaimed(undefined, undefined).kept, []);
    });
});

describe('claimedRewardKey / buildClaimedIndex', () => {
    test('era is normalized so a string era matches a numeric one', () => {
        // SQLite hands back numbers; the chain derive hands back objects that
        // stringify. "1234|V" and "1234|V" must be the same key.
        assert.equal(claimedRewardKey('1234', V1), claimedRewardKey(1234, V1));
    });

    test('an unattributed row lands in unattributedEras, not exact', () => {
        const idx = buildClaimedIndex([{ era: 7, validator: null }]);
        assert.equal(idx.exact.size, 0);
        assert.ok(idx.unattributedEras.has(7));
    });

    test('rows with no era are ignored rather than keyed as NaN', () => {
        const idx = buildClaimedIndex([{ era: null, validator: V1 }, { era: 'nope', validator: V1 }]);
        assert.equal(idx.exact.size, 0);
        assert.equal(idx.unattributedEras.size, 0);
    });
});

describe('summarizeRewards — the number on the card', () => {
    test('does NOT add claimed and unclaimed for an overlapping era', () => {
        // The audit's close test, stated as arithmetic: 5 claimed + a stale
        // 5 unclaimed for the same era|validator is 5, not 10.
        const claimed = [{ era: 1234, validator: V1, amount: 5 }];
        const unclaimed = [{ era: 1234, validator: V1, amount: 5 }];
        const { summary } = summarizeRewards(claimed, unclaimed);
        assert.equal(summary.claimedTotal, 5);
        assert.equal(summary.unclaimedTotal, 0);
        assert.equal(summary.totalAmount, 5);
        assert.equal(summary.reconciledCount, 1);
    });

    test('still adds genuinely distinct entitlements', () => {
        const { summary } = summarizeRewards(
            [{ era: 1234, validator: V1, amount: 5 }],
            [{ era: 1234, validator: V2, amount: 7 }]
        );
        assert.equal(summary.totalAmount, 12);
        assert.equal(summary.reconciledCount, 0);
    });

    test('eraCount counts an era once even when it appears in both lists', () => {
        const { summary } = summarizeRewards(
            [{ era: 1234, validator: V1, amount: 5 }],
            [{ era: 1234, validator: V2, amount: 7 }]
        );
        assert.equal(summary.eraCount, 1);
    });

    test('counts reflect the reconciled list, not the raw one', () => {
        const { summary, unclaimed } = summarizeRewards(
            [{ era: 1, validator: V1, amount: 1 }],
            [{ era: 1, validator: V1, amount: 1 }, { era: 2, validator: V1, amount: 2 }]
        );
        assert.equal(summary.unclaimedCount, 1);
        assert.equal(unclaimed.length, 1);
        assert.equal(summary.unclaimedCount, unclaimed.length);
    });

    test('empty inputs produce zeros, not NaN', () => {
        const { summary } = summarizeRewards([], []);
        assert.equal(summary.totalAmount, 0);
        assert.equal(summary.eraCount, 0);
        assert.ok(Number.isFinite(summary.totalAmount));
    });

    test('non-numeric amounts do not poison the total', () => {
        const { summary } = summarizeRewards([{ era: 1, validator: V1, amount: undefined }], []);
        assert.equal(summary.claimedTotal, 0);
    });
});

describe('attributeBatchRewards — per-validator attribution (defect 1)', () => {
    test('maps each Rewarded event to the batch item that emitted it', () => {
        // utility.batch([payoutStakers(V1, 1234), payoutStakers(V2, 1234)]):
        // validator+nominator rewards for V1, ItemCompleted, then V2's.
        const items = [{ era: 1234, validator: V1 }, { era: 1234, validator: V2 }];
        const sequence = [
            { kind: 'reward', ref: 3 },
            { kind: 'reward', ref: 4 },
            { kind: 'delimiter' },
            { kind: 'reward', ref: 6 },
            { kind: 'delimiter' }
        ];
        const map = attributeBatchRewards(items, sequence);
        assert.equal(map.get(3).validator, V1);
        assert.equal(map.get(4).validator, V1);
        assert.equal(map.get(6).validator, V2);
        // No null validators left — which is the entire point.
        for (const v of map.values()) assert.ok(v.validator);
    });

    test('a non-payout item still occupies its slot', () => {
        // If non-payout batch items were dropped from `items`, every reward
        // after them would be attributed to the wrong validator — worse than
        // null, because it looks correct.
        const items = [{ era: null, validator: null }, { era: 1234, validator: V1 }];
        const sequence = [{ kind: 'delimiter' }, { kind: 'reward', ref: 9 }];
        assert.equal(attributeBatchRewards(items, sequence).get(9).validator, V1);
    });

    test('rewards past the end of the item list degrade to null, not a wrong validator', () => {
        const map = attributeBatchRewards([{ era: 1, validator: V1 }], [
            { kind: 'delimiter' }, { kind: 'reward', ref: 1 }
        ]);
        assert.equal(map.get(1).validator, null);
    });

    test('a single-item batch attributes everything to that item', () => {
        const map = attributeBatchRewards([{ era: 88, validator: V2 }], [
            { kind: 'reward', ref: 0 }, { kind: 'reward', ref: 1 }
        ]);
        assert.equal(map.get(0).era, 88);
        assert.equal(map.get(1).validator, V2);
    });

    test('empty inputs are safe', () => {
        assert.equal(attributeBatchRewards([], []).size, 0);
        assert.equal(attributeBatchRewards(undefined, undefined).size, 0);
    });
});

describe('isAttributableBatch — the nested-batch guard', () => {
    // A code review caught this AFTER the attribution fix was written: counting
    // ItemCompleted events is only sound when every top-level item is a direct
    // payout. A nested batch emits delimiters of its own, so
    // batch([batch([payout(A), payout(B)]), payout(C)]) has 2 top-level items
    // but 3 delimiters — and B's reward gets filed under C. A confidently
    // wrong validator is worse than the null it replaced, because it corrupts
    // the payout UI in both directions.
    const payout = v => ({ section: 'staking', method: 'payoutStakers', args: [v, 1234] });

    test('a flat batch of payouts is attributable', () => {
        assert.equal(isAttributableBatch([payout(V1), payout(V2)]), true);
    });

    test('payoutStakersByPage is attributable too', () => {
        assert.equal(isAttributableBatch([{ section: 'staking', method: 'payoutStakersByPage' }]), true);
    });

    test('a NESTED batch is not attributable', () => {
        const nested = { section: 'utility', method: 'batch', args: [[payout(V1), payout(V2)]] };
        assert.equal(isAttributableBatch([nested, payout('5Cx')]), false);
    });

    test('a proxy-wrapped payout is not attributable', () => {
        // proxy.proxy emits its own events around the inner call.
        const proxied = { section: 'proxy', method: 'proxy', args: [V1, null, payout(V2)] };
        assert.equal(isAttributableBatch([proxied, payout(V1)]), false);
    });

    test('a mixed batch with a transfer is not attributable', () => {
        const transfer = { section: 'balances', method: 'transferKeepAlive' };
        assert.equal(isAttributableBatch([payout(V1), transfer]), false);
    });

    test('an empty batch is not attributable', () => {
        assert.equal(isAttributableBatch([]), false);
        assert.equal(isAttributableBatch(undefined), false);
    });
});

describe('isDirectPayoutCall', () => {
    test('accepts both payout methods and nothing else', () => {
        assert.equal(isDirectPayoutCall({ section: 'staking', method: 'payoutStakers' }), true);
        assert.equal(isDirectPayoutCall({ section: 'staking', method: 'payoutStakersByPage' }), true);
        assert.equal(isDirectPayoutCall({ section: 'staking', method: 'bond' }), false);
        // A same-named method in another pallet must not qualify.
        assert.equal(isDirectPayoutCall({ section: 'utility', method: 'payoutStakers' }), false);
        assert.equal(isDirectPayoutCall(null), false);
        assert.equal(isDirectPayoutCall(undefined), false);
    });
});

describe('isBatchDelimiter', () => {
    test('ItemCompleted and ItemFailed both delimit a batch item', () => {
        // forceBatch emits ItemFailed for a failing item; missing it would
        // shift attribution for every subsequent reward in the extrinsic.
        assert.equal(isBatchDelimiter('utility', 'ItemCompleted'), true);
        assert.equal(isBatchDelimiter('utility', 'ItemFailed'), true);
    });

    test('BatchCompleted is not an item delimiter', () => {
        // It fires once at the end; counting it would push the item index past
        // the last real item.
        assert.equal(isBatchDelimiter('utility', 'BatchCompleted'), false);
        assert.equal(isBatchDelimiter('utility', 'BatchInterrupted'), false);
    });

    test('same method name from another pallet is not a delimiter', () => {
        assert.equal(isBatchDelimiter('staking', 'ItemCompleted'), false);
        assert.equal(isBatchDelimiter('staking', 'Rewarded'), false);
    });
});
