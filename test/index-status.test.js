// Regression tests for lib/index-status.js — audit F-004 / F-050 / F-020.
//
// The bug these lock down: the chain indexer wrote status: 'Synced' at the end
// of every tick, unconditionally, including the tick that logged "known
// gaps=1" over a 1,213-block hole in production. "Synced" is a promise about
// coverage; these tests make it impossible to keep that promise carelessly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIndexStatus, describeIndexStatus, shouldShowCrawlSpinner } from '../lib/index-status.js';

describe('deriveIndexStatus — the F-004 regression', () => {
    test('never reports Synced while a gap is known', () => {
        // The exact production state on 2026-08-23: full range claimed,
        // backfill finished, one 1,213-block hole from a backend crash-loop.
        assert.equal(deriveIndexStatus({
            initialized: true,
            backfillComplete: true,
            knownGapBlocks: 1213
        }), 'Repairing');
    });

    test('never reports Synced while blocks are queued for retry', () => {
        assert.equal(deriveIndexStatus({
            initialized: true, backfillComplete: true, retryableFailures: 4
        }), 'Repairing');
    });

    test('reports Synced only when there is nothing outstanding', () => {
        assert.equal(deriveIndexStatus({
            initialized: true,
            backfillComplete: true,
            knownGapBlocks: 0,
            retryableFailures: 0,
            permanentFailures: 0
        }), 'Synced');
    });

    test('a single missing block is enough to lose Synced', () => {
        assert.equal(deriveIndexStatus({
            initialized: true, backfillComplete: true, knownGapBlocks: 1
        }), 'Repairing');
    });
});

describe('deriveIndexStatus — precedence', () => {
    test('a live error outranks everything', () => {
        assert.equal(deriveIndexStatus({
            initialized: true, backfillComplete: true, hadErrorThisTick: true,
            knownGapBlocks: 10, permanentFailures: 3
        }), 'Error');
    });

    test('uninitialized outranks gap bookkeeping', () => {
        assert.equal(deriveIndexStatus({ initialized: false, knownGapBlocks: 99 }), 'Initializing');
    });

    test('permanent failures outrank in-progress repair', () => {
        // Retries are exhausted, so time alone will not fix it. Reporting
        // "Repairing" here would be a lie that never resolves.
        assert.equal(deriveIndexStatus({
            initialized: true, backfillComplete: true,
            knownGapBlocks: 5, retryableFailures: 5, permanentFailures: 3
        }), 'Degraded');
    });

    test('permanent failures outrank backfilling', () => {
        assert.equal(deriveIndexStatus({
            initialized: true, backfillComplete: false, permanentFailures: 1
        }), 'Degraded');
    });

    test('gaps outrank backfilling', () => {
        // Backfilling is normal progress; a hole inside the claimed range is
        // not, so it is the more urgent thing to say.
        assert.equal(deriveIndexStatus({
            initialized: true, backfillComplete: false, knownGapBlocks: 7
        }), 'Repairing');
    });

    test('clean but still walking toward genesis is Backfilling', () => {
        assert.equal(deriveIndexStatus({
            initialized: true, backfillComplete: false
        }), 'Backfilling');
    });

    test('no arguments does not claim Synced', () => {
        // Defaults matter: a caller that forgets to pass its counts must not
        // accidentally get the most reassuring answer.
        assert.equal(deriveIndexStatus(), 'Initializing');
        assert.equal(deriveIndexStatus({}), 'Initializing');
    });
});

describe('describeIndexStatus', () => {
    test('quantifies each category', () => {
        const text = describeIndexStatus({
            knownGapBlocks: 1213, retryableFailures: 4, permanentFailures: 3
        });
        assert.match(text, /1213 blocks missing/);
        assert.match(text, /4 blocks queued for retry/);
        assert.match(text, /3 blocks abandoned/);
    });

    test('singular grammar for one block', () => {
        assert.equal(describeIndexStatus({ knownGapBlocks: 1 }), '1 block missing inside the indexed range');
    });

    test('empty when there is nothing to report', () => {
        assert.equal(describeIndexStatus({}), '');
        assert.equal(describeIndexStatus(), '');
    });
});

describe('shouldShowCrawlSpinner — the F-020 half', () => {
    test('rows win over any status', () => {
        // The original bug: /api/blocks read a sync key that never existed, so
        // status was permanently 'Initializing' and the spinner hid rows that
        // were sitting right there in the response.
        assert.equal(shouldShowCrawlSpinner('Initializing', 20), false);
        assert.equal(shouldShowCrawlSpinner('Backfilling', 1), false);
        assert.equal(shouldShowCrawlSpinner('Error', 5), false);
    });

    test('spins only when there is genuinely nothing to show yet', () => {
        assert.equal(shouldShowCrawlSpinner('Initializing', 0), true);
        assert.equal(shouldShowCrawlSpinner('Syncing', 0), true);
        assert.equal(shouldShowCrawlSpinner('Backfilling', 0), true);
    });

    test('empty + Repairing/Degraded/Synced is not a spinner', () => {
        // These mean "this is as good as it gets right now" — an endless
        // spinner would misrepresent a state the user should be told about.
        assert.equal(shouldShowCrawlSpinner('Repairing', 0), false);
        assert.equal(shouldShowCrawlSpinner('Degraded', 0), false);
        assert.equal(shouldShowCrawlSpinner('Synced', 0), false);
    });
});
