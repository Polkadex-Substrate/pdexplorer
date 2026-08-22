// Regression test for audit F-003 — the governance status casing mismatch.
//
// The indexer wrote 'Ongoing'; the banner, calendar, and email dispatcher
// compared against lowercase 'ongoing'. Nothing errored, nothing logged, and
// no voter was ever notified of an open referendum. A single assertion on the
// indexer's actual output value would have caught it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isOpenGovStatus } from '../lib/gov-status.js';

describe('isOpenGovStatus — audit F-003', () => {
    test("accepts 'Ongoing' exactly as the indexer writes it", () => {
        // This is the literal the democracy indexer stores in SQLite. If this
        // assertion fails, open referenda are invisible to notifications.
        assert.equal(isOpenGovStatus('Ongoing'), true);
    });

    test('accepts every casing of the open states', () => {
        for (const s of ['ongoing', 'ONGOING', 'oNgOiNg', 'Started', 'started', 'STARTED']) {
            assert.equal(isOpenGovStatus(s), true, `${s} should count as open`);
        }
    });

    test('rejects the closed states the indexer also writes', () => {
        for (const s of ['Passed', 'NotPassed', 'Cancelled', 'passed', 'notpassed', 'Executed']) {
            assert.equal(isOpenGovStatus(s), false, `${s} should NOT count as open`);
        }
    });

    test('rejects empty and missing status without throwing', () => {
        assert.equal(isOpenGovStatus(''), false);
        assert.equal(isOpenGovStatus(null), false);
        assert.equal(isOpenGovStatus(undefined), false);
    });

    test('is not fooled by substrings', () => {
        assert.equal(isOpenGovStatus('not-ongoing'), false);
        assert.equal(isOpenGovStatus('ongoing-ish'), false);
    });
});
