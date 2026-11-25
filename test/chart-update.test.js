// lib/chart-update.js: the pure decisions behind "the bars change subtly" (CEO report 22 Nov).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rewardsSeries, sameSeries, renderKey, planChartUpdate, applySeries } from '../lib/chart-update.js';
import { REFRESH_UI } from '../lib/refresh-ui.js';

const S = (labels, claimed, unpaid) => ({ labels, datasets: [{ label: 'Claimed', data: claimed }, { label: 'Unpaid', data: unpaid }] });

describe('rewardsSeries', () => {
    const rows = [
        { data: { claimed: [{ era: 5, amount: 2 }, { era: 4, amount: 1 }, { era: 5, amount: 0.5 }], unclaimed: [{ era: 6, amount: 3 }] },
          want: S(['Era 4', 'Era 5', 'Era 6'], [1, 2.5, 0], [0, 0, 3]), why: 'sorted by era, summed per era, zero where absent' },
        { data: { claimed: [{ era: null, amount: 1 }, { era: 2, amount: 1 }], unclaimed: [] },
          want: S(['Era 2', 'Unknown'], [1, 1], [0, 0]), why: 'Unknown last' },
        { data: { claimed: [{ era: 1, amount: 'x' }], unclaimed: [] }, want: S(['Era 1'], [0], [0]), why: 'a non-number counts as 0' },
        { data: { claimed: [], unclaimed: [] }, want: null, why: 'no rows: no series' },
        { data: {}, want: null, why: 'missing lists: no series' }
    ];
    for (const r of rows) test(r.why, () => assert.deepEqual(rewardsSeries(r.data), r.want));
});

describe('sameSeries', () => {
    const base = S(['Era 1', 'Era 2'], [1, 2], [0, 3]);
    const rows = [
        [base, S(['Era 1', 'Era 2'], [1, 2], [0, 3]), true, 'equal copies'],
        [base, S(['Era 1', 'Era 2'], [1, 2], [0, 4]), false, 'one value differs'],
        [base, S(['Era 1', 'Era 3'], [1, 2], [0, 3]), false, 'one label differs'],
        [base, S(['Era 1'], [1], [0]), false, 'fewer bars'],
        [base, { labels: base.labels, datasets: [base.datasets[0]] }, false, 'fewer datasets'],
        [base, { labels: ['Era 1', 'Era 2'], datasets: [{ label: 'Paid', data: [1, 2] }, { label: 'Unpaid', data: [0, 3] }] }, false, 'dataset label differs'],
        [null, null, true, 'both empty'],
        [null, base, false, 'first draw'],
        [base, null, false, 'cleared']
    ];
    for (const [a, b, want, why] of rows) test(why, () => assert.equal(sameSeries(a, b), want));
});

describe('renderKey', () => {
    test('same data and filter give the same key, any change gives another', () => {
        const d = () => ({ address: 'A', summary: { claimedTotal: 1 }, claimed: [{ era: 1, amount: 1 }], unclaimed: [], apr: { apr30d: 4.5 } });
        assert.equal(renderKey(d(), 'all'), renderKey(d(), 'all'));
        assert.notEqual(renderKey(d(), 'all'), renderKey(d(), 'claimed'));
        const e = d(); e.apr.apr30d = 4.6;
        assert.notEqual(renderKey(d(), 'all'), renderKey(e, 'all'));
        const f = d(); f.address = 'B';
        assert.notEqual(renderKey(d(), 'all'), renderKey(f, 'all'));
        assert.notEqual(renderKey(d(), 'all'), '', 'a real key is never empty');
    });
});

describe('planChartUpdate', () => {
    const a = S(['Era 1'], [1], [0]), same = S(['Era 1'], [1], [0]), b = S(['Era 1'], [2], [0]);
    const MS = REFRESH_UI.collapseMs;
    const rows = [
        { prev: a, next: same, o: { canvasKept: true }, action: 'none', why: 'same data: nothing' },
        { prev: a, next: same, o: { canvasKept: true, reducedMotion: true }, action: 'none', why: 'same data, reduced motion: nothing' },
        { prev: a, next: b, o: { canvasKept: true }, action: 'update', animation: { duration: MS }, updateMode: 'default', why: 'changed: update with the short ease' },
        { prev: a, next: b, o: { canvasKept: true, reducedMotion: true }, action: 'update', animation: false, updateMode: 'none', why: 'changed, reduced motion: no animation' },
        { prev: null, next: a, o: {}, action: 'replace', animation: { duration: MS }, updateMode: 'default', why: 'first paint: short ease, not the long entrance' },
        { prev: null, next: a, o: { reducedMotion: true }, action: 'replace', animation: false, updateMode: 'none', why: 'first paint, reduced motion: none' },
        { prev: a, next: same, o: { canvasKept: false }, action: 'replace', animation: { duration: MS }, updateMode: 'default', why: 'canvas was replaced: draw again even if equal' },
        { prev: a, next: b, o: { canvasKept: false }, action: 'replace', animation: { duration: MS }, updateMode: 'default', why: 'other view (canvas replaced): full redraw, still short' }
    ];
    for (const r of rows) test(r.why, () => {
        const p = planChartUpdate(r.prev, r.next, r.o);
        assert.equal(p.action, r.action);
        if (r.action !== 'none') { assert.deepEqual(p.animation, r.animation); assert.equal(p.updateMode, r.updateMode); }
    });
    test('the short ease is the spec constant, never the 1000 ms default', () => { assert.ok(MS > 0 && MS <= 300); });
});

describe('applySeries', () => {
    test('writes labels and values into the existing arrays objects, keeping dataset styling', () => {
        const ds0 = { label: 'Claimed', data: [1], backgroundColor: 'x' }, ds1 = { label: 'Unpaid', data: [0], backgroundColor: 'y' };
        const data = { labels: ['Era 1'], datasets: [ds0, ds1] };
        const out = applySeries(data, S(['Era 1', 'Era 2'], [1, 5], [0, 7]));
        assert.equal(out, data, 'same object');
        assert.equal(data.datasets[0], ds0, 'dataset objects kept');
        assert.deepEqual(data.labels, ['Era 1', 'Era 2']);
        assert.deepEqual(ds0.data, [1, 5]); assert.deepEqual(ds1.data, [0, 7]);
        assert.equal(ds0.backgroundColor, 'x');
    });
});
