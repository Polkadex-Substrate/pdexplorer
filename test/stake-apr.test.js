// Realized nominator APR (lib/stake-apr.js), checked against numbers worked by hand.
//
// Worked example used throughout (era 100):
//   era reward pool  1,000 PDEX, total era points 10,000
//   validator A      500 points, exposure 100,000 PDEX, commission 10%
//     share          1,000 x 500 / 10,000            = 50 PDEX
//     to backers     50 x (1 - 0.10)                 = 45 PDEX
//     per PDEX       45 / 100,000                    = 0.00045
//     APR            0.00045 x 365.25 eras x 100     = 16.43625 %
//   validator B      1,000 points, exposure 400,000 PDEX, commission 0%
//     per PDEX       1,000 x 0.1 / 400,000           = 0.00025 -> 9.13125 %

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    eraReturnPerUnit, validatorPerformance, performanceForAll, eraMedianPoints, windowEras,
    minErasFor, erasPerYearFromMs, aprLabel, indexSummaries, DAYS_PER_YEAR
} from '../lib/stake-apr.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function era(n, validators, { reward = 1000, totalPoints = 10000 } = {}) {
    return { era: n, reward, totalPoints, validators };
}
const A = (o = {}) => ({ points: 500, stake: 100000, commission: 10, ...o });
const B = (o = {}) => ({ points: 1000, stake: 400000, commission: 0, ...o });

describe('one era, by hand', () => {
    test('validator A: 0.00045 per PDEX', () => {
        close(eraReturnPerUnit(era(100, { A: A() }), 'A'), 0.00045);
    });
    test('validator B: 0.00025 per PDEX', () => {
        close(eraReturnPerUnit(era(100, { B: B() }), 'B'), 0.00025);
    });
    test('commission is taken before the split: 100% leaves nothing, 0% leaves all', () => {
        assert.equal(eraReturnPerUnit(era(1, { A: A({ commission: 100 }) }), 'A'), 0);
        close(eraReturnPerUnit(era(1, { A: A({ commission: 0 }) }), 'A'), 0.0005);
    });
    test('commission outside 0..100 is clamped, unusable commission pays nothing', () => {
        assert.equal(eraReturnPerUnit(era(1, { A: A({ commission: 150 }) }), 'A'), 0);
        close(eraReturnPerUnit(era(1, { A: A({ commission: -5 }) }), 'A'), 0.0005);
        assert.equal(eraReturnPerUnit(era(1, { A: A({ commission: null }) }), 'A'), 0);
    });
    test('zero stake, zero total points, missing reward: no number at all', () => {
        assert.equal(eraReturnPerUnit(era(1, { A: A({ stake: 0 }) }), 'A'), null);
        assert.equal(eraReturnPerUnit(era(1, { A: A() }, { totalPoints: 0 }), 'A'), null);
        assert.equal(eraReturnPerUnit(era(1, { A: A() }, { reward: null }), 'A'), null);
        assert.equal(eraReturnPerUnit(era(1, {}), 'A'), null);
    });
    test('zero points while elected is a real zero, not a gap', () => {
        assert.equal(eraReturnPerUnit(era(1, { A: A({ points: 0 }) }), 'A'), 0);
    });
});

describe('annualizing', () => {
    test('one era a day gives 365.25 eras a year; half-day eras double it', () => {
        assert.equal(erasPerYearFromMs(86_400_000), 365.25);
        assert.equal(erasPerYearFromMs(43_200_000), 730.5);
    });
    test('unknown era length falls back to one a day', () => {
        for (const bad of [0, -1, null, undefined, NaN, 'x']) assert.equal(erasPerYearFromMs(bad), DAYS_PER_YEAR);
    });
    test('A over 28 identical eras: 16.43625 %', () => {
        const s = [];
        for (let e = 72; e < 100; e++) s.push(era(e, { A: A(), B: B() }));
        const p = validatorPerformance(s, 'A', { activeEra: 100, window: 28, erasPerYear: 365.25 });
        assert.equal(p.status, 'ok');
        assert.equal(p.erasUsed, 28);
        close(p.apr, 16.43625);
        close(validatorPerformance(s, 'B', { activeEra: 100, window: 28, erasPerYear: 365.25 }).apr, 9.13125);
    });
});

describe('the window', () => {
    test('completed eras only: the active era is never in it', () => {
        assert.deepEqual(windowEras(104, 3), [101, 102, 103]);
        assert.deepEqual(windowEras(2, 7), [0, 1]);
        assert.deepEqual(windowEras(0, 7), []);
    });
    test('an era the explorer has no summary for is left out, not counted as zero', () => {
        const s = [era(97, { A: A() }), era(99, { A: A() }), era(98, { A: A() })];
        const p = validatorPerformance(s, 'A', { activeEra: 100, window: 7 });
        assert.equal(p.erasInWindow, 3);
        assert.equal(p.erasUsed, 3);
        close(p.apr, 16.43625);
    });
    test('partial eras: elected in only some eras, the mean is over the eras it was elected', () => {
        // Elected eras 95..99 at A's rate, 93..94 waiting (no exposure row).
        const s = [];
        for (let e = 93; e < 100; e++) s.push(era(e, e >= 95 ? { A: A(), B: B() } : { B: B() }));
        const p = validatorPerformance(s, 'A', { activeEra: 100, window: 7 });
        assert.equal(p.electedEras, 5);
        assert.equal(p.erasInWindow, 7);
        close(p.apr, 16.43625);
    });
    test('different eras average, they are not pooled', () => {
        // era 98: 0.00045, era 99: points doubled -> 0.0009; mean 0.000675
        const s = [era(97, { A: A() }), era(98, { A: A() }), era(99, { A: A({ points: 1000 }) })];
        const p = validatorPerformance(s, 'A', { activeEra: 100, window: 3, erasPerYear: 1 });
        close(p.apr, ((0.00045 * 2 + 0.0009) / 3) * 100);
    });
});

describe('new validators show a word, not a number', () => {
    test('minimum eras: a quarter of the window, never fewer than 3', () => {
        assert.equal(minErasFor(7), 3);
        assert.equal(minErasFor(28), 7);
        assert.equal(minErasFor(84), 21);
    });
    test('elected 6 of 28 eras: new, apr null', () => {
        const s = [];
        for (let e = 72; e < 100; e++) s.push(era(e, e >= 94 ? { A: A(), B: B() } : { B: B() }));
        const p = validatorPerformance(s, 'A', { activeEra: 100, window: 28 });
        assert.equal(p.status, 'new');
        assert.equal(p.apr, null);
        assert.equal(aprLabel(p), 'new');
    });
    test('never elected in the window: none, label n/a', () => {
        const s = [era(99, { B: B() })];
        const p = validatorPerformance(s, 'A', { activeEra: 100, window: 7 });
        assert.equal(p.status, 'none');
        assert.equal(p.apr, null);
        assert.equal(aprLabel(p), 'n/a');
        assert.equal(aprLabel(null), 'n/a');
    });
    test('elected with zero stake counts as not elected', () => {
        const s = [97, 98, 99].map(e => era(e, { A: A({ stake: 0 }) }));
        assert.equal(validatorPerformance(s, 'A', { activeEra: 100, window: 3 }).status, 'none');
    });
    test('an ok value renders with two decimals', () => {
        assert.equal(aprLabel({ status: 'ok', apr: 16.43625 }), '16.44%');
    });
});

describe('oversubscribed exposures (paged staking, spec 392)', () => {
    // A re-implementation of pallet-staking's do_payout_stakers_by_page split,
    // to show that the per-PDEX rate is the same on every exposure page.
    function pagedPayout({ validatorPayout, commission, own, nominators, pageSize }) {
        const total = own + nominators.reduce((a, b) => a + b, 0);
        const commissionPayout = validatorPayout * commission;
        const leftover = validatorPayout - commissionPayout;
        const pages = [];
        for (let i = 0; i < nominators.length; i += pageSize) pages.push(nominators.slice(i, i + pageSize));
        return pages.map(page => page.map(value => (value / total) * leftover));
    }
    test('a nominator on page 3 earns the same per PDEX as one on page 1, and as the formula says', () => {
        const nominators = Array.from({ length: 600 }, (_, i) => 100 + i);
        const own = 10000;
        const total = own + nominators.reduce((a, b) => a + b, 0);
        const pages = pagedPayout({ validatorPayout: 50, commission: 0.1, own, nominators, pageSize: 256 });
        assert.equal(pages.length, 3);
        const perUnit = eraReturnPerUnit(era(1, { V: { points: 500, stake: total, commission: 10 } }), 'V');
        close(pages[0][0] / nominators[0], perUnit, 1e-15);
        close(pages[2][10] / nominators[512 + 10], perUnit, 1e-15);
    });
});

describe('reliability', () => {
    test('median of elected validators, even and odd counts', () => {
        assert.equal(eraMedianPoints(era(1, { a: { points: 1, stake: 1 }, b: { points: 3, stake: 1 }, c: { points: 100, stake: 1 } })), 3);
        assert.equal(eraMedianPoints(era(1, { a: { points: 2, stake: 1 }, b: { points: 4, stake: 1 } })), 3);
        assert.equal(eraMedianPoints(era(1, { a: { points: 2, stake: 0 } })), 0);
    });
    test('a zero-point era is missed and not reliable; half the median passes', () => {
        const s = [
            era(97, { A: A({ points: 0 }), B: B({ points: 1000 }), C: B({ points: 1000 }) }),
            era(98, { A: A({ points: 500 }), B: B({ points: 1000 }), C: B({ points: 1000 }) }),
            era(99, { A: A({ points: 499 }), B: B({ points: 1000 }), C: B({ points: 1000 }) })
        ];
        const p = validatorPerformance(s, 'A', { activeEra: 100, window: 3 });
        assert.equal(p.missedEras, 1);
        close(p.reliability, 100 / 3);
    });
});

describe('performanceForAll', () => {
    test('every address gets every window, keyed by string', () => {
        const s = [];
        for (let e = 16; e < 100; e++) s.push(era(e, { A: A() }));
        const out = performanceForAll(s, ['A', 'Z'], { activeEra: 100, erasPerYear: 365.25 });
        assert.deepEqual(Object.keys(out.A), ['7', '28', '84']);
        close(out.A['84'].apr, 16.43625);
        assert.equal(out.A['84'].erasUsed, 84);
        assert.equal(out.Z['7'].status, 'none');
    });
    test('indexSummaries drops junk', () => {
        assert.equal(indexSummaries([null, { era: 'x' }, era(5, {})]).size, 1);
    });
});
