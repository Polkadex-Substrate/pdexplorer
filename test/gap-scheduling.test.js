// Tests for lib/gap-scheduling.js — audit F-046.
//
// The finding is STARVATION, which is a property over many ticks, not a
// property of one call. So the central tests simulate a full repair run and
// assert what must be true of the sequence: an unfillable hole cannot consume
// the budget forever, and every hole eventually gets a turn.
//
// This is why the arithmetic was pulled out of syncChainIndex. Inside the
// indexer it could only be checked by watching a live chain for an hour.

import { test, describe } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import assert from 'node:assert/strict';
import {
    chooseGap, gapKey, recordAttempt, shouldRetire, exhaustedGapCount,
    DEFAULT_MAX_GAP_ATTEMPTS
} from '../lib/gap-scheduling.js';

const gap = (start, end) => ({ gapStart: start, gapEnd: end, gapSize: end - start + 1 });

// Simulate the repair loop. `fillable` decides whether a given gap makes
// progress this tick — the unfillable ones stand for pruned RPC history.
function runRepair({ gaps, fillable, ticks }) {
    const attempts = new Map();
    const chosen = [];
    let tick = 0;
    for (let i = 0; i < ticks; i++) {
        const g = chooseGap(gaps, { attempts, tick: tick++ });
        chosen.push(g ? gapKey(g) : null);
        if (!g) continue;
        recordAttempt(attempts, g, fillable(g) ? 100 : 0);
    }
    return { chosen, attempts };
}

describe('F-046 — an unfillable hole cannot starve the others', () => {
    test('the newest gap being permanently stuck does not block the oldest', () => {
        // The bug, exactly: gaps[0] is unfillable, and the old code took
        // gaps[0] every single tick.
        const gaps = [gap(9000, 9100), gap(5000, 5100), gap(100, 200)];
        const { chosen } = runRepair({
            gaps,
            fillable: (g) => g.gapStart !== 9000,   // the newest never fills
            ticks: 10
        });
        assert.ok(chosen.includes('100'),
            `the oldest gap was never attempted in 10 ticks: ${JSON.stringify(chosen)}`);
    });

    test('a stuck gap is set aside after maxAttempts and stops being chosen', () => {
        const gaps = [gap(9000, 9100), gap(100, 200)];
        const { chosen, attempts } = runRepair({
            gaps, fillable: (g) => g.gapStart !== 9000, ticks: 30
        });
        assert.equal(attempts.get('9000'), DEFAULT_MAX_GAP_ATTEMPTS,
            'the failure count must stop at the cap, not grow forever');
        // After the cap is reached it must never be picked again.
        const lastPick = chosen.lastIndexOf('9000');
        const attemptsBefore = chosen.slice(0, lastPick + 1).filter(c => c === '9000').length;
        assert.equal(attemptsBefore, DEFAULT_MAX_GAP_ATTEMPTS,
            'a retired gap was chosen again before the amnesty');
    });

    test('when EVERY gap is stuck, it returns null instead of a least-bad choice', () => {
        // Reporting "cannot repair" is more useful than burning an RPC round
        // on a range that has failed five times running — and F-004's honest
        // status needs to be able to say so.
        const gaps = [gap(9000, 9100), gap(100, 200)];
        const { chosen } = runRepair({ gaps, fillable: () => false, ticks: 40 });
        assert.equal(chosen[chosen.length - 1], null);
        assert.equal(exhaustedGapCount(gaps, new Map([['9000', 5], ['100', 5]])), 2);
    });

    test('every gap gets a turn when all are fillable', () => {
        const gaps = [gap(900, 910), gap(500, 510), gap(100, 110)];
        const { chosen } = runRepair({ gaps, fillable: () => true, ticks: 8 });
        // Alternating newest/oldest, so with all three live we expect both ends.
        assert.ok(chosen.includes('900'));
        assert.ok(chosen.includes('100'));
    });
});

describe('F-046 — the attempt key must survive a shrinking gap', () => {
    test('gapKey is stable as the gap is filled from the top down', () => {
        // The fill works downward from gapEnd, so gapEnd and gapSize both move
        // while the gap is being repaired. Keying on either would reset the
        // failure count every tick and no gap could ever be set aside.
        const before = gap(1000, 1500);
        const after  = gap(1000, 1400);   // 100 heights repaired
        assert.equal(gapKey(before), gapKey(after));
    });

    test('a DIFFERENT gap gets a different key', () => {
        assert.notEqual(gapKey(gap(1000, 1500)), gapKey(gap(2000, 2500)));
    });

    test('a slowly-shrinking gap is never treated as stuck', () => {
        const attempts = new Map();
        let g = gap(1000, 1500);
        for (let i = 0; i < 20; i++) {
            recordAttempt(attempts, g, 100);
            g = gap(1000, g.gapEnd - 100);
        }
        assert.equal(attempts.get('1000'), undefined,
            'progress must clear the counter — a shrinking gap is not stuck');
    });
});

describe('recordAttempt', () => {
    test('zero progress increments, any progress clears', () => {
        const attempts = new Map();
        const g = gap(10, 20);
        recordAttempt(attempts, g, 0);
        recordAttempt(attempts, g, 0);
        assert.equal(attempts.get('10'), 2);
        recordAttempt(attempts, g, 1);
        assert.equal(attempts.get('10'), undefined, 'one filled block is progress');
    });

    test('a null gap is a no-op, not a crash', () => {
        assert.doesNotThrow(() => recordAttempt(new Map(), null, 0));
    });
});

describe('shouldRetire — the amnesty', () => {
    test('fires once the cooldown has elapsed', () => {
        assert.equal(shouldRetire(1000, 1000 + 6 * 3600_000, 6 * 3600_000), true);
        assert.equal(shouldRetire(1000, 1000 + 3600_000, 6 * 3600_000), false);
    });

    test('a never-reset map fires immediately', () => {
        // Otherwise a process that restarts often never retries anything.
        assert.equal(shouldRetire(0, Date.now(), 6 * 3600_000), true);
        assert.equal(shouldRetire(undefined, Date.now(), 6 * 3600_000), true);
    });

    test('after an amnesty a previously-exhausted gap is chosen again', () => {
        // The point of the cooldown: an operator repointing RPC at an archive
        // node makes yesterday's unfillable hole fillable, and nothing
        // in-process can observe that.
        const gaps = [gap(9000, 9100)];
        const attempts = new Map([['9000', DEFAULT_MAX_GAP_ATTEMPTS]]);
        assert.equal(chooseGap(gaps, { attempts, tick: 0 }), null);
        attempts.clear();
        assert.deepEqual(chooseGap(gaps, { attempts, tick: 0 }), gaps[0]);
    });
});

describe('chooseGap — degenerate input', () => {
    test('no gaps is null, not a throw', () => {
        assert.equal(chooseGap([], {}), null);
        assert.equal(chooseGap(null, {}), null);
        assert.equal(chooseGap(undefined, {}), null);
    });

    test('malformed gap rows are skipped', () => {
        assert.equal(chooseGap([{}, null, { gapStart: 5 }], {}), null);
        assert.deepEqual(chooseGap([{}, gap(1, 2)], {}), gap(1, 2));
    });

    test('a single gap is chosen on both parities', () => {
        // With one live gap the rotation must not alternate to nothing.
        const gaps = [gap(1, 2)];
        assert.deepEqual(chooseGap(gaps, { tick: 0 }), gaps[0]);
        assert.deepEqual(chooseGap(gaps, { tick: 1 }), gaps[0]);
    });
});

describe('F-046 — the indexer actually uses this', () => {
    test('syncChainIndex chooses via chooseGap, not gaps[0]', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
        assert.match(src, /const g = chooseGap\(gaps, \{/,
            'the gap-fill pass takes gaps[0] again — that IS F-046');
        assert.ok(!/const g = gaps\[0\];/.test(src));
        assert.match(src, /recordAttempt\(gapAttempts, g, fill\.blocks\.length\)/,
            'outcomes are not fed back, so nothing is ever set aside');
        assert.match(src, /shouldRetire\(gapAttemptsResetAt/,
            'without the amnesty an exhausted gap is exhausted forever');
    });

    test('the exhausted count is published in the index status', () => {
        // A review catch: exhaustedGapCount was imported and never used, while
        // this module's header promised "the caller surfaces this in the index
        // status so Repairing does not imply making progress". Without it the
        // status sits at "Repairing" forever with nothing to distinguish
        // "working through holes" from "given up on them" — which is the F-004
        // dishonesty F-046 claims to close, one level up.
        const { readFileSync } = require('node:fs');
        const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
        assert.match(src, /gapsExhausted = exhaustedGapCount\(gaps, gapAttempts/,
            'exhaustedGapCount is imported but never called');
        assert.match(src, /^\s+gapsExhausted,$/m,
            'the count is computed but never persisted to the sync state');
        assert.match(src, /gapsExhausted: Number\(state\.gapsExhausted\) \|\| 0/,
            'the count is persisted but never served to clients');
    });
});
