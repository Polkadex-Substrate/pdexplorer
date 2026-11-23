// Stake-aware nominator APY (lib/nominator-apy.js).
//
// The bug this pins: the validators list and the validator page showed
// MAX_APY_BASE x (1 - commission) for every validator, so a validator with
// ten times the average stake showed the same "Est. APY" as an average one,
// while its nominators were really paid about a tenth as much per PDEX. On
// this runtime each active validator earns about the same per era whatever
// its stake, so the return per PDEX falls as the stake grows.
//
// Every expected value below is worked by hand from the formula:
//   perEra = (eraReward x points / totalPoints) x (1 - commission) / exposureTotal
//   apy    = mean(perEra over counted eras) x erasPerYear x 100   (simple, not compounded)
// Made-up addresses and stakes only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    NOMINATOR_APY_FIELD, NOMINATOR_APY_METHOD_FIELD, METHOD_PAST_ERAS, METHOD_CURRENT_STAKE,
    rewardPerActiveValidator, currentStakeApy, nominatorApy, nominatorApyForAddress, withNominatorApy,
    perEraNominatorApy, withPerEraNominatorApy, compareNominatorApy, formatNominatorApy, nominatorApyCaption
} from '../lib/nominator-apy.js';
import { performanceForAll, DEFAULT_APR_WINDOW } from '../lib/stake-apr.js';
import { estimatedApy, MAX_APY_BASE } from '../lib/apy.js';

const ERAS_PER_YEAR = 365.25;
const AVG_STAKE = 34_500;
const BIG_STAKE = 392_000;
const N_VALIDATORS = 200;
// Per-validator reward per era chosen so an average-stake validator at 0%
// commission earns exactly the old nominal figure, MAX_APY_BASE (23.09%):
//   r / 34,500 x 365.25 x 100 = 23.09  =>  r = 0.2309 x 34,500 / 365.25
const PER_VALIDATOR_REWARD = (MAX_APY_BASE / 100) * AVG_STAKE / ERAS_PER_YEAR;
const ACTIVE_ERA = 100;
const WINDOW_ERAS = Array.from({ length: DEFAULT_APR_WINDOW }, (_, i) => ACTIVE_ERA - DEFAULT_APR_WINDOW + i);

// One era: N_VALIDATORS elected with equal points. `special` overrides rows.
function era(e, special = {}) {
    const validators = {};
    for (let i = 0; i < N_VALIDATORS; i++) validators[`F${i}`] = { points: 1000, stake: AVG_STAKE, commission: 5 };
    for (const [addr, row] of Object.entries(special)) {
        if (row === null) delete validators[addr];
        else validators[addr] = { points: 1000, ...row };
    }
    const elected = Object.values(validators).filter(r => r.stake > 0).length;
    return { era: e, reward: PER_VALIDATOR_REWARD * elected, totalPoints: 1000 * elected, validators };
}
function summaries(fn) { return WINDOW_ERAS.map(e => era(e, fn ? fn(e) : {})); }
function perfOf(sums, addr) { return performanceForAll(sums, [addr], { activeEra: ACTIVE_ERA, erasPerYear: ERAS_PER_YEAR })[addr][String(DEFAULT_APR_WINDOW)]; }
function close(actual, expected, tol, msg) {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tol, `${msg}: expected ${expected} +/- ${tol}, got ${actual}`);
}

describe('the reporter\'s numbers', () => {
    // A validator with 392k staked at 5% commission, beside 199 average ones.
    const sums = summaries(() => ({ BIG: { stake: BIG_STAKE, commission: 5 } }));
    const rpv = rewardPerActiveValidator(sums, { activeEra: ACTIVE_ERA });

    test('392k stake at 5% lands at 1.9305%, not 21.94%', () => {
        // 23.09 x 0.95 x 34,500 / 392,000 = 1.930549...
        const expected = MAX_APY_BASE * 0.95 * AVG_STAKE / BIG_STAKE;
        const r = nominatorApy({ perf: perfOf(sums, 'BIG'), commission: 5, totalStake: BIG_STAKE, rewardPerValidator: rpv, erasPerYear: ERAS_PER_YEAR });
        close(r.value, expected, 1e-9, 'big validator');
        close(r.value, 1.93, 0.01, 'reporter prediction about 1.9%');
        assert.equal(r.method, METHOD_PAST_ERAS);
        assert.equal(r.eras, DEFAULT_APR_WINDOW);
        assert.ok(r.value < estimatedApy(5) / 10, 'still within a tenth of the old commission-only figure');
    });

    test('an average-stake validator at 5% lands on the old network figure, 21.9355%', () => {
        const r = nominatorApy({ perf: perfOf(sums, 'F1'), commission: 5, totalStake: AVG_STAKE, rewardPerValidator: rpv, erasPerYear: ERAS_PER_YEAR });
        close(r.value, estimatedApy(5), 1e-9, 'average validator');
        close(r.value, 21.9355, 1e-4, 'average validator in plain numbers');
    });

    test('the fallback (current stake) agrees with the past-eras figure when nothing changed', () => {
        close(rpv, PER_VALIDATOR_REWARD, 1e-12, 'reward per active validator');
        close(currentStakeApy({ rewardPerValidator: rpv, commission: 5, totalStake: BIG_STAKE, erasPerYear: ERAS_PER_YEAR }),
            MAX_APY_BASE * 0.95 * AVG_STAKE / BIG_STAKE, 1e-9, 'fallback for the big validator');
    });
});

describe('commission', () => {
    test('0% gives the full rate, 100% gives zero (a number, not "no estimate")', () => {
        const sums = summaries(() => ({ Z: { stake: AVG_STAKE, commission: 0 }, H: { stake: AVG_STAKE, commission: 100 } }));
        close(nominatorApy({ perf: perfOf(sums, 'Z') }).value, MAX_APY_BASE, 1e-9, '0%');
        const h = nominatorApy({ perf: perfOf(sums, 'H') });
        assert.equal(h.value, 0);
        assert.equal(h.method, METHOD_PAST_ERAS);
        assert.equal(currentStakeApy({ rewardPerValidator: 10, commission: 100, totalStake: 1000 }), 0);
    });

    test('commission that changes across eras uses each era\'s own commission', () => {
        // 14 eras at 0%, 14 at 10%: mean factor 0.95, so the same as 5% flat.
        const sums = summaries(e => ({ C: { stake: AVG_STAKE, commission: e < ACTIVE_ERA - 14 ? 0 : 10 } }));
        close(nominatorApy({ perf: perfOf(sums, 'C') }).value, estimatedApy(5), 1e-9, 'changing commission');
    });

    test('an unusable commission gives no fallback estimate, never the full rate', () => {
        for (const c of [null, undefined, '', 'x', -1, 101, NaN, true, []]) {
            assert.equal(currentStakeApy({ rewardPerValidator: 20, commission: c, totalStake: AVG_STAKE }), null, `commission ${String(c)}`);
        }
    });
});

describe('stake', () => {
    test('zero, negative or unknown stake: null, and nominatorApy says "no estimate"', () => {
        for (const s of [0, -5, null, undefined, '', NaN]) {
            assert.equal(currentStakeApy({ rewardPerValidator: 20, commission: 5, totalStake: s }), null, `stake ${String(s)}`);
        }
        const r = nominatorApy({ perf: { status: 'none', apr: null }, commission: 5, totalStake: 0, rewardPerValidator: 20 });
        assert.deepEqual(r, { value: null, method: null, eras: 0 });
    });

    test('huge stake and reward: finite, positive, no overflow', () => {
        const v = currentStakeApy({ rewardPerValidator: 1e24, commission: 5, totalStake: 1e30, erasPerYear: ERAS_PER_YEAR });
        assert.ok(Number.isFinite(v) && v > 0, String(v));
        close(v, 1e24 * 0.95 / 1e30 * ERAS_PER_YEAR * 100, 1e-18, 'huge');
        const sums = summaries(() => ({ W: { stake: 1e30, commission: 5 } }));
        const p = nominatorApy({ perf: perfOf(sums, 'W') });
        assert.ok(Number.isFinite(p.value) && p.value > 0 && p.value < 1e-20, String(p.value));
    });

    test('monotonic: for the same commission, more stake never gives a higher estimate', () => {
        const stakes = [1, 10, 1000, AVG_STAKE, 50_000, BIG_STAKE, 1e7, 1e12, 1e30];
        let prevPast = Infinity;
        let prevNow = Infinity;
        for (const s of stakes) {
            const past = nominatorApy({ perf: perfOf(summaries(() => ({ M: { stake: s, commission: 5 } })), 'M') }).value;
            const now = currentStakeApy({ rewardPerValidator: PER_VALIDATOR_REWARD, commission: 5, totalStake: s, erasPerYear: ERAS_PER_YEAR });
            assert.ok(past <= prevPast, `past eras: stake ${s} gave ${past}, more than ${prevPast} for less stake`);
            assert.ok(now <= prevNow, `current stake: stake ${s} gave ${now}, more than ${prevNow} for less stake`);
            prevPast = past;
            prevNow = now;
        }
    });
});

describe('history coverage', () => {
    test('one era of history is too few: falls back to the current-stake formula', () => {
        const sums = WINDOW_ERAS.map(e => era(e, e === ACTIVE_ERA - 1 ? { N: { stake: 100_000, commission: 10 } } : {}));
        const perf = perfOf(sums, 'N');
        assert.equal(perf.status, 'new');
        const rpv = rewardPerActiveValidator(sums, { activeEra: ACTIVE_ERA });
        const r = nominatorApy({ perf, commission: 10, totalStake: 100_000, rewardPerValidator: rpv, erasPerYear: ERAS_PER_YEAR });
        assert.equal(r.method, METHOD_CURRENT_STAKE);
        close(r.value, rpv * 0.9 / 100_000 * ERAS_PER_YEAR * 100, 1e-9, 'one-era fallback');
    });

    test('no history at all (waiting or new): fallback, or null without a network reward', () => {
        const r = nominatorApy({ perf: undefined, commission: 10, totalStake: 100_000, rewardPerValidator: PER_VALIDATOR_REWARD, erasPerYear: ERAS_PER_YEAR });
        assert.equal(r.method, METHOD_CURRENT_STAKE);
        close(r.value, PER_VALIDATOR_REWARD * 0.9 / 100_000 * ERAS_PER_YEAR * 100, 1e-9, 'no-history fallback');
        assert.equal(nominatorApy({ perf: undefined, commission: 10, totalStake: 100_000 }).value, null);
        assert.equal(rewardPerActiveValidator([], { activeEra: ACTIVE_ERA }), null);
    });

    test('active in only some eras: out-of-set eras after the first election pay nothing', () => {
        // Elected in the first 14 eras of the window only: half the full rate.
        const early = summaries(e => (e < ACTIVE_ERA - 14 ? { P: { stake: AVG_STAKE, commission: 5 } } : {}));
        close(nominatorApy({ perf: perfOf(early, 'P') }).value, estimatedApy(5) / 2, 1e-9, 'elected early, then out');
        // Elected in the last 14 only: counted from its first election, full rate.
        const late = summaries(e => (e >= ACTIVE_ERA - 14 ? { L: { stake: AVG_STAKE, commission: 5 } } : {}));
        close(nominatorApy({ perf: perfOf(late, 'L') }).value, estimatedApy(5), 1e-9, 'newly elected');
    });

    test('the window is the existing 28-era default', () => {
        assert.equal(DEFAULT_APR_WINDOW, 28);
        const snap = { rewardPerValidator: 1, erasPerYear: ERAS_PER_YEAR, validators: [{ address: 'A', commission: 5, totalStake: 10, perf: { 7: { status: 'ok', apr: 99, erasUsed: 7 }, 28: { status: 'ok', apr: 3, erasUsed: 28 } } }] };
        assert.equal(nominatorApyForAddress(snap, 'A').value, 3);
    });
});

describe('list and page enrichment from the stake-picker snapshot', () => {
    const sums = summaries(() => ({ BIG: { stake: BIG_STAKE, commission: 5 } }));
    const perf = performanceForAll(sums, ['BIG', 'F1'], { activeEra: ACTIVE_ERA, erasPerYear: ERAS_PER_YEAR });
    const snapshot = {
        erasPerYear: ERAS_PER_YEAR,
        rewardPerValidator: rewardPerActiveValidator(sums, { activeEra: ACTIVE_ERA }),
        validators: [
            { address: 'BIG', commission: 5, totalStake: BIG_STAKE, perf: perf.BIG },
            { address: 'F1', commission: 5, totalStake: AVG_STAKE, perf: perf.F1 }
        ]
    };
    const rows = [
        { address: 'BIG', commission: 5, totalStake: BIG_STAKE, estimatedApyAtCurrentCommission: estimatedApy(5) },
        { address: 'F1', commission: 5, totalStake: AVG_STAKE, estimatedApyAtCurrentCommission: estimatedApy(5) },
        { address: 'NEWCOMER', commission: 2, totalStake: 50_000, estimatedApyAtCurrentCommission: estimatedApy(2) }
    ];

    test('rows differ by stake, carry the method, and keep the old field as it was', () => {
        const out = withNominatorApy(rows, snapshot);
        const by = Object.fromEntries(out.map(r => [r.address, r]));
        close(by.BIG[NOMINATOR_APY_FIELD], MAX_APY_BASE * 0.95 * AVG_STAKE / BIG_STAKE, 1e-9, 'BIG');
        close(by.F1[NOMINATOR_APY_FIELD], estimatedApy(5), 1e-9, 'F1');
        assert.equal(by.BIG[NOMINATOR_APY_METHOD_FIELD], METHOD_PAST_ERAS);
        // Not in the snapshot: the current-stake formula with the row's own values.
        assert.equal(by.NEWCOMER[NOMINATOR_APY_METHOD_FIELD], METHOD_CURRENT_STAKE);
        close(by.NEWCOMER[NOMINATOR_APY_FIELD], PER_VALIDATOR_REWARD * 0.98 / 50_000 * ERAS_PER_YEAR * 100, 1e-9, 'NEWCOMER');
        for (const r of out) assert.equal(r.estimatedApyAtCurrentCommission, estimatedApy(r.commission), 'old field keeps its old meaning');
        assert.equal(rows[0][NOMINATOR_APY_FIELD], undefined, 'input rows are not mutated');
    });

    test('no snapshot yet (fresh deploy): every row says "no estimate", none falls back to commission only', () => {
        for (const r of withNominatorApy(rows, null)) {
            assert.equal(r[NOMINATOR_APY_FIELD], null);
            assert.equal(r[NOMINATOR_APY_METHOD_FIELD], null);
        }
    });

    test('per-era history rows get that era\'s own return, null where the era is not held', () => {
        const history = [{ era: ACTIVE_ERA - 1, commission: 5, stake: BIG_STAKE, apy: estimatedApy(5) }, { era: 3, commission: 5, stake: BIG_STAKE, apy: estimatedApy(5) }];
        const out = withPerEraNominatorApy(history, sums, 'BIG', ERAS_PER_YEAR);
        close(out[0].nominatorApy, MAX_APY_BASE * 0.95 * AVG_STAKE / BIG_STAKE, 1e-9, 'held era');
        assert.equal(out[1].nominatorApy, null);
        assert.equal(out[0].apy, estimatedApy(5), 'history apy keeps its old meaning');
        assert.equal(perEraNominatorApy(null, 'BIG', ERAS_PER_YEAR), null);
    });
});

describe('sorting the list column', () => {
    const rows = [
        { address: 'b', [NOMINATOR_APY_FIELD]: 5 },
        { address: 'n2', [NOMINATOR_APY_FIELD]: null },
        { address: 'a', [NOMINATOR_APY_FIELD]: 5 },
        { address: 'c', [NOMINATOR_APY_FIELD]: 20 },
        { address: 'n1' },
        { address: 'd', [NOMINATOR_APY_FIELD]: 0 }
    ];
    test('ascending: low to high, ties by address, no-estimate last', () => {
        assert.deepEqual(rows.slice().sort((x, y) => compareNominatorApy(x, y, 'asc')).map(r => r.address), ['d', 'a', 'b', 'c', 'n1', 'n2']);
    });
    test('descending: high to low, ties by address, no-estimate still last', () => {
        assert.deepEqual(rows.slice().sort((x, y) => compareNominatorApy(x, y, 'desc')).map(r => r.address), ['c', 'a', 'b', 'd', 'n1', 'n2']);
    });
});

describe('display text', () => {
    test('a number has two decimals; no estimate is null (the caller shows the dash)', () => {
        assert.equal(formatNominatorApy(1.930549), '1.93%');
        assert.equal(formatNominatorApy(0), '0.00%');
        for (const v of [null, undefined, '', NaN, 'x']) assert.equal(formatNominatorApy(v), null, String(v));
    });
    test('the caption says where the number came from', () => {
        assert.equal(nominatorApyCaption({ [NOMINATOR_APY_FIELD]: 2, [NOMINATOR_APY_METHOD_FIELD]: METHOD_PAST_ERAS, estimatedNominatorApyEras: 28 }),
            'past 28 eras, after commission, per PDEX staked');
        assert.equal(nominatorApyCaption({ [NOMINATOR_APY_FIELD]: 2, [NOMINATOR_APY_METHOD_FIELD]: METHOD_CURRENT_STAKE }),
            'from current stake and commission');
        assert.equal(nominatorApyCaption({ [NOMINATOR_APY_FIELD]: null }), 'not enough data yet');
        assert.equal(nominatorApyCaption(null), 'not enough data yet');
    });
});
