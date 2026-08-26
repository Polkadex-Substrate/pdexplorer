// Tests for lib/email-events.js — the guard that stands between a new
// dispatcher and a mass mailing.
//
// The failure this prevents is not subtle and not recoverable: the treasury,
// council and referenda tables hold full chain history, so a dispatcher that
// naively loops them would, on its first tick after deploy, send every
// confirmed subscriber one email per historical row. The idempotency table
// would then record all of them as sent, so there is no second chance. Domain
// reputation does not survive that.
//
// The first test below is therefore the one that matters most, and it is
// written as the deploy scenario rather than as an abstract unit.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    selectDispatchable, selectNewlyResolved, isFresh, isTerminalRefStatus, describeRefOutcome
} from '../lib/email-events.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = 1_760_000_000_000;

// 400 historical proposals spanning two years, the NEWEST still a year old —
// i.e. what the treasury table actually looks like on the live explorer.
const history = Array.from({ length: 400 }, (_, i) => ({
    id: i + 1,
    proposedAt: NOW - (400 - i) * DAY - 365 * DAY
}));

const rankOf = r => r.id;
const timeOf = r => r.proposedAt;

describe('selectDispatchable — first run must send NOTHING', () => {
    test('a fresh deploy against full history dispatches zero emails', () => {
        const out = selectDispatchable({
            items: history, rankOf, timeOf, baseline: null, nowMs: NOW, maxAgeMs: 7 * DAY
        });
        assert.equal(out.dispatch.length, 0, 'first run would have mailed historical rows');
        assert.equal(out.firstRun, true);
    });

    test('first run adopts the end of history as the watermark', () => {
        const out = selectDispatchable({
            items: history, rankOf, timeOf, baseline: null, nowMs: NOW, maxAgeMs: 7 * DAY
        });
        assert.equal(out.nextBaseline, 400);
    });

    test('undefined and null baselines are both treated as first run', () => {
        for (const baseline of [null, undefined]) {
            const out = selectDispatchable({ items: history, rankOf, timeOf, baseline, nowMs: NOW, maxAgeMs: 7 * DAY });
            assert.equal(out.dispatch.length, 0);
            assert.equal(out.firstRun, true);
        }
    });

    test('baseline 0 is a REAL watermark, not a missing one', () => {
        // A genuinely empty chain records 0. If that were treated as "unset"
        // the guard would re-arm every tick and never send anything.
        const out = selectDispatchable({
            items: [{ id: 1, proposedAt: NOW - HOUR }],
            rankOf, timeOf, baseline: 0, nowMs: NOW, maxAgeMs: 7 * DAY
        });
        assert.equal(out.firstRun, false);
        assert.equal(out.dispatch.length, 1);
    });

    test('first run on an EMPTY table still arms the watermark', () => {
        const out = selectDispatchable({ items: [], rankOf, timeOf, baseline: null, nowMs: NOW, maxAgeMs: 7 * DAY });
        assert.equal(out.firstRun, true);
        assert.equal(out.nextBaseline, null);
    });
});

describe('selectDispatchable — steady state', () => {
    test('sends only rows above the watermark', () => {
        const items = [...history, { id: 401, proposedAt: NOW - HOUR }];
        const out = selectDispatchable({ items, rankOf, timeOf, baseline: 400, nowMs: NOW, maxAgeMs: 7 * DAY });
        assert.deepEqual(out.dispatch.map(rankOf), [401]);
        assert.equal(out.nextBaseline, 401);
    });

    test('a row at exactly the watermark is not resent', () => {
        const out = selectDispatchable({
            items: [{ id: 400, proposedAt: NOW - HOUR }],
            rankOf, timeOf, baseline: 400, nowMs: NOW, maxAgeMs: 7 * DAY
        });
        assert.equal(out.dispatch.length, 0);
    });

    test('several new rows go out oldest-first', () => {
        const items = [
            { id: 403, proposedAt: NOW - HOUR },
            { id: 401, proposedAt: NOW - 3 * HOUR },
            { id: 402, proposedAt: NOW - 2 * HOUR }
        ];
        const out = selectDispatchable({ items, rankOf, timeOf, baseline: 400, nowMs: NOW, maxAgeMs: 7 * DAY });
        assert.deepEqual(out.dispatch.map(rankOf), [401, 402, 403]);
    });

    test('the watermark never moves backwards', () => {
        // An indexer that briefly returns a truncated table must not re-arm
        // the guard and replay everything.
        const out = selectDispatchable({ items: [], rankOf, timeOf, baseline: 400, nowMs: NOW, maxAgeMs: 7 * DAY });
        assert.equal(out.nextBaseline, 400);
    });
});

describe('selectDispatchable — the second guard (freshness)', () => {
    test('a lost watermark cannot replay history', () => {
        // The scenario guard 1 alone does not cover: kv row wiped, backup
        // restored, event kind renamed. The baseline says 0, so everything is
        // "new" — freshness is the only thing standing between the subscriber
        // list and 400 emails.
        const out = selectDispatchable({
            items: history, rankOf, timeOf, baseline: 0, nowMs: NOW, maxAgeMs: 7 * DAY
        });
        assert.equal(out.dispatch.length, 0, 'a reset watermark replayed history');
        assert.ok(out.suppressed > 0);
    });

    test('above the watermark but too old is still not sent', () => {
        const out = selectDispatchable({
            items: [{ id: 401, proposedAt: NOW - 30 * DAY }],
            rankOf, timeOf, baseline: 400, nowMs: NOW, maxAgeMs: 7 * DAY
        });
        assert.equal(out.dispatch.length, 0);
    });

    test('a stale row still advances the watermark past itself', () => {
        // Otherwise every tick re-evaluates the same row forever.
        const out = selectDispatchable({
            items: [{ id: 401, proposedAt: NOW - 30 * DAY }],
            rankOf, timeOf, baseline: 400, nowMs: NOW, maxAgeMs: 7 * DAY
        });
        assert.equal(out.nextBaseline, 401);
    });

    test('the bound of guard 2, stated honestly: a lost watermark DOES replay the recent window', () => {
        // Not a bug — a documented limit. If the watermark is lost and rows
        // exist inside maxAgeMs, those rows are indistinguishable from new
        // ones and will be sent. The guard caps the damage at "one window of
        // events" instead of "all of history", and this test exists so that
        // bound is a decision on record rather than a surprise in production.
        // It is also the argument for keeping EMAIL_EVENT_MAX_AGE_MS small.
        const recent = [
            { id: 401, proposedAt: NOW - 2 * DAY },
            { id: 402, proposedAt: NOW - 1 * DAY }
        ];
        const out = selectDispatchable({
            items: [...history, ...recent], rankOf, timeOf, baseline: 0, nowMs: NOW, maxAgeMs: 7 * DAY
        });
        assert.deepEqual(out.dispatch.map(rankOf), [401, 402]);
        assert.equal(out.dispatch.length, 2, 'blast radius should be one freshness window, no more');
    });

    test('a row with no timestamp is not mailed', () => {
        // Several tables allow NULL for backfilled rows. Unknown age must read
        // as "too old", never as "brand new".
        for (const proposedAt of [null, undefined, 0, '', 'nonsense', NaN]) {
            const out = selectDispatchable({
                items: [{ id: 401, proposedAt }],
                rankOf, timeOf, baseline: 400, nowMs: NOW, maxAgeMs: 7 * DAY
            });
            assert.equal(out.dispatch.length, 0, `timestamp ${String(proposedAt)} was mailed`);
        }
    });
});

describe('selectDispatchable — burst cap', () => {
    test('a burst is capped per tick', () => {
        const burst = Array.from({ length: 50 }, (_, i) => ({ id: 401 + i, proposedAt: NOW - HOUR }));
        const out = selectDispatchable({
            items: burst, rankOf, timeOf, baseline: 400, nowMs: NOW, maxAgeMs: 7 * DAY, limit: 10
        });
        assert.equal(out.dispatch.length, 10);
        assert.deepEqual(out.dispatch.map(rankOf), [401,402,403,404,405,406,407,408,409,410]);
    });

    test('capped-away rows stay below the watermark for the next tick', () => {
        // They are a backlog, not a decision — losing them would silently drop
        // real events.
        const burst = Array.from({ length: 50 }, (_, i) => ({ id: 401 + i, proposedAt: NOW - HOUR }));
        const out = selectDispatchable({
            items: burst, rankOf, timeOf, baseline: 400, nowMs: NOW, maxAgeMs: 7 * DAY, limit: 10
        });
        assert.equal(out.nextBaseline, 410, 'the backlog was skipped instead of queued');
    });

    test('limit 0 sends nothing but does not corrupt the watermark', () => {
        const out = selectDispatchable({
            items: [{ id: 401, proposedAt: NOW - HOUR }],
            rankOf, timeOf, baseline: 400, nowMs: NOW, maxAgeMs: 7 * DAY, limit: 0
        });
        assert.equal(out.dispatch.length, 0);
        assert.ok(out.nextBaseline >= 400);
    });
});

describe('selectDispatchable — malformed input', () => {
    test('rows without a usable rank are ignored, not mailed', () => {
        const items = [{ id: null, proposedAt: NOW }, { id: 'abc', proposedAt: NOW }, { id: 401, proposedAt: NOW - HOUR }];
        const out = selectDispatchable({ items, rankOf, timeOf, baseline: 400, nowMs: NOW, maxAgeMs: 7 * DAY });
        assert.deepEqual(out.dispatch.map(rankOf), [401]);
    });

    test('missing or non-array items is safe', () => {
        for (const items of [undefined, null, {}, 'nope']) {
            const out = selectDispatchable({ items, rankOf, timeOf, baseline: 400, nowMs: NOW, maxAgeMs: 7 * DAY });
            assert.equal(out.dispatch.length, 0);
        }
    });

    test('no arguments at all does not throw and sends nothing', () => {
        const out = selectDispatchable();
        assert.equal(out.dispatch.length, 0);
        assert.equal(out.firstRun, true);
    });
});

describe('selectNewlyResolved — referendum results', () => {
    const ref = (refIndex, status) => ({ refIndex, status });
    const idOf = r => r.refIndex;
    const isResolved = r => isTerminalRefStatus(r.status);
    const run = (items, seen, limit) => selectNewlyResolved({ items, idOf, isResolved, seen, limit });

    test('first run announces NOTHING and adopts the resolved history', () => {
        // Same catastrophe as the watermark case: on a fresh database every
        // past referendum is "resolved", and announcing them means one email
        // per referendum per subscriber.
        const items = Array.from({ length: 60 }, (_, i) => ref(i, 'Passed'));
        const out = run(items, null);
        assert.equal(out.dispatch.length, 0);
        assert.equal(out.firstRun, true);
        assert.equal(out.nextSeen.length, 60);
    });

    test('an empty seen array is a real state, not a first run', () => {
        // After a chain with no resolved referenda, seen is []. That must not
        // re-arm first-run mode, or the guard never actually engages.
        const out = run([ref(1, 'Passed')], []);
        assert.equal(out.firstRun, false);
        assert.deepEqual(out.dispatch.map(idOf), [1]);
    });

    test('announces a referendum the moment it becomes terminal', () => {
        const out = run([ref(1, 'Passed'), ref(2, 'Ongoing')], [0]);
        assert.deepEqual(out.dispatch.map(idOf), [1]);
        assert.ok(out.nextSeen.includes(1));
    });

    test('does not re-announce an already-seen result', () => {
        assert.equal(run([ref(1, 'Passed')], [1]).dispatch.length, 0);
    });

    test('never announces an ongoing referendum as a result', () => {
        assert.equal(run([ref(9, 'Ongoing')], [1]).dispatch.length, 0);
    });

    test('resolution order, not index order, is what matters', () => {
        // #7 can be cancelled while #5 is still open — which is exactly why
        // this is a seen-set and not a watermark.
        const out = run([ref(5, 'Ongoing'), ref(7, 'Cancelled')], [1, 2, 3, 4]);
        assert.deepEqual(out.dispatch.map(idOf), [7]);
        // #5 stays unannounced and unseen, free to fire when it resolves.
        assert.ok(!out.nextSeen.includes(5));
    });

    test('a capped-away result is announced on a later tick', () => {
        const items = Array.from({ length: 10 }, (_, i) => ref(100 + i, 'Passed'));
        const out = run(items, [1], 3);
        assert.equal(out.dispatch.length, 3);
        // Only the announced ids are marked seen.
        assert.ok(!out.nextSeen.includes(103), 'a held-back result was silently marked seen');
    });

    test('the seen set is bounded so the kv row cannot grow forever', () => {
        const items = Array.from({ length: 2000 }, (_, i) => ref(i, 'Passed'));
        const out = selectNewlyResolved({ items, idOf, isResolved, seen: null, remember: 500 });
        assert.equal(out.nextSeen.length, 500);
        // It keeps the HIGHEST ids — a low id cannot resolve a second time.
        assert.equal(Math.min(...out.nextSeen), 1500);
    });

    test('malformed input is safe', () => {
        assert.equal(selectNewlyResolved().dispatch.length, 0);
        assert.equal(run(null, [1]).dispatch.length, 0);
        assert.equal(run([ref(null, 'Passed'), ref('x', 'Passed')], [1]).dispatch.length, 0);
    });
});

describe('isFresh', () => {
    test('inside the window', () => {
        assert.equal(isFresh(NOW - HOUR, NOW, 7 * DAY), true);
    });
    test('outside the window', () => {
        assert.equal(isFresh(NOW - 8 * DAY, NOW, 7 * DAY), false);
    });
    test('exactly at the boundary is still fresh', () => {
        assert.equal(isFresh(NOW - 7 * DAY, NOW, 7 * DAY), true);
    });
    test('a future timestamp is rejected', () => {
        // Clock skew, or seconds stored where ms were expected — either way
        // it must not read as "brand new".
        assert.equal(isFresh(NOW + HOUR, NOW, 7 * DAY), false);
        assert.equal(isFresh(1_760_000_000, NOW, 7 * DAY), false); // seconds, not ms
    });
    test('missing values are never fresh', () => {
        assert.equal(isFresh(null, NOW, 7 * DAY), false);
        assert.equal(isFresh(undefined, NOW, 7 * DAY), false);
        assert.equal(isFresh(0, NOW, 7 * DAY), false);
        assert.equal(isFresh(NOW, NOW, 0), false);
        assert.equal(isFresh(NOW, NOW, null), false);
    });
});

describe('isTerminalRefStatus / describeRefOutcome', () => {
    test('recognises the decided statuses', () => {
        for (const s of ['Passed', 'NotPassed', 'Executed', 'Cancelled', 'Rejected', 'Vetoed']) {
            assert.equal(isTerminalRefStatus(s), true, `${s} not recognised as terminal`);
        }
    });

    test('an ongoing referendum is not terminal', () => {
        // Casing varies across the codebase — this is the F-003 trap.
        for (const s of ['Ongoing', 'ongoing', 'ONGOING', 'Started']) {
            assert.equal(isTerminalRefStatus(s), false, `${s} would have been announced as a result`);
        }
    });

    test('an unknown or missing status is NOT terminal', () => {
        // A row the indexer hasn't resolved yet must not trigger a "result"
        // email announcing an outcome we don't actually know.
        assert.equal(isTerminalRefStatus(null), false);
        assert.equal(isTerminalRefStatus(undefined), false);
        assert.equal(isTerminalRefStatus(''), false);
        assert.equal(isTerminalRefStatus('Whatever'), false);
    });

    test('outcome wording is human, not a raw enum', () => {
        assert.equal(describeRefOutcome('Passed'), 'passed');
        assert.equal(describeRefOutcome('NotPassed'), 'did not pass');
        assert.equal(describeRefOutcome('Cancelled'), 'was cancelled');
        assert.equal(describeRefOutcome('Vetoed'), 'was vetoed');
        assert.equal(describeRefOutcome('Something'), 'was decided');
    });
});
