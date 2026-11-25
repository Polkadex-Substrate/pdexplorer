// The automatic validator choice (lib/stake-pick.js): design
// 2026-11-22-stake-card-simple-and-advanced.md section 4 and the 10.1 table,
// CEO decisions 2026-11-23 (eight picks; no automatic re-pick for an existing
// staker). Money rule M1: no pick ever fails a gate, and no gate is relaxed to
// reach the count.
//
// Validators are made up: "Validator A" and on, with addresses from filler
// bytes at prefix 88. They belong to no one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAddress } from '@polkadot/util-crypto';
import { pickValidators, reviewNominations, proposeReplacement, returnEstimate, medianOf, GATES, PICK_COUNT, LOW_RETURN_RATIO } from '../lib/stake-pick.js';
import { applyFilters, RECOMMENDED_PRESET } from '../lib/stake-filters.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const ERA = 500;
const META = { activeEra: ERA, pageSize: 256, full: true };
const NO_ID = { hasIdentity: false, verified: false, parent: null };

// A validator that passes every gate. apr is the 28-era realized return.
function val(n, over = {}) {
    const { apr = 10, perf, ...rest } = over;
    return {
        address: addr(n), name: `Validator ${String.fromCharCode(64 + (n % 26 || 26))}${n > 26 ? n : ''}`,
        active: true, commission: 5, blocked: false, selfStake: 1000, totalStake: 50000,
        exposurePages: 1, exposureNominators: 20, backers: 20, identity: NO_ID, slashEras: [],
        commissionHistory: { raisedRecently: false, pendingRaise: false },
        perf: perf === undefined ? { 28: { status: 'ok', apr, erasUsed: 28, electedEras: 28, missedEras: 0, reliability: 100 } } : perf,
        ...rest
    };
}
const pool = (aprs, from = 1) => aprs.map((apr, i) => val(from + i, { apr }));
const addrs = (r) => r.picks.map(p => p.address);

describe('pickValidators: rank and count', () => {
    test('a full pool picks 8 in rank order, highest realized return first', () => {
        const list = pool([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
        const r = pickValidators(list, META);
        assert.equal(PICK_COUNT, 8);
        assert.equal(r.status, 'ok');
        assert.equal(r.picks.length, 8);
        assert.deepEqual(r.picks.map(p => p.apr), [31, 30, 29, 28, 27, 26, 25, 24]);
        assert.equal(r.pool, 12);
        assert.ok(r.picks.every(p => p.kept === false));
        assert.deepEqual(Object.keys(r.picks[0]).sort(), ['address', 'apr', 'commission', 'kept', 'name']);
    });
    test('quota 4 gives 4', () => {
        const r = pickValidators(pool([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]), META, { quota: 4 });
        assert.equal(r.status, 'ok');
        assert.deepEqual(r.picks.map(p => p.apr), [29, 28, 27, 26]);
    });
    test('5 eligible gives short with all 5; the 7 that fail a gate stay out', () => {
        const list = pool([10, 11, 12, 13, 14]).concat([15, 16, 17, 18, 19, 20, 21].map((apr, i) => val(40 + i, { apr, active: false })));
        const r = pickValidators(list, META);
        assert.equal(r.status, 'short');
        assert.equal(r.picks.length, 5);
        assert.deepEqual(r.picks.map(p => p.apr), [14, 13, 12, 11, 10]);
        assert.equal(r.rejected.G1, 7);
    });
    test('0 eligible gives none; a snapshot that is not full gives no-data', () => {
        const none = pickValidators([val(1, { active: false }), val(2, { blocked: true })], META);
        assert.equal(none.status, 'none');
        assert.deepEqual(none.picks, []);
        const noData = pickValidators(pool([10, 11, 12]), { ...META, full: false });
        assert.equal(noData.status, 'no-data');
        assert.deepEqual(noData.picks, []);
        assert.equal(pickValidators(pool([10]), {}).status, 'no-data');
    });
    test('fewer than 8 eligible: no gate is relaxed to fill the count (M1)', () => {
        const good = pool([10, 11, 12]);
        const near = [val(20, { apr: 30, commission: 10.5 }), val(21, { apr: 30, perf: { 28: { status: 'new', apr: null, erasUsed: 6, electedEras: 6, missedEras: 0, reliability: 100 } } }),
            val(22, { apr: 30, exposurePages: 2 }), val(23, { apr: 30, perf: { 28: { status: 'ok', apr: 30, erasUsed: 28, electedEras: 28, missedEras: 4, reliability: 85 } } })];
        const r = pickValidators(good.concat(near), META);
        assert.equal(r.status, 'short');
        assert.deepEqual(addrs(r).sort(), good.map(v => v.address).sort());
    });
});

describe('pickValidators: each gate alone keeps a validator out and is counted', () => {
    const okPerf = (o) => ({ 28: { status: 'ok', apr: 50, erasUsed: 28, electedEras: 28, missedEras: 0, reliability: 100, ...o } });
    // The bad one has the highest return, so only the gate can keep it out.
    const CASES = [
        ['G1', 'not in the active set', { active: false }],
        ['G2', 'status new (fewer than 7 counted eras)', { perf: okPerf({ status: 'new', apr: null, erasUsed: 6 }) }],
        ['G2', 'status none', { perf: okPerf({ status: 'none', apr: null, electedEras: 0 }) }],
        ['G2', 'apr NaN', { perf: okPerf({ apr: NaN }) }],
        ['G2', 'apr zero', { perf: okPerf({ apr: 0 }) }],
        ['G2', 'perf null', { perf: null }],
        ['G2', 'no 28-era window', { perf: { 7: okPerf()[28] } }],
        ['G3', 'blocks new stake', { blocked: true }],
        ['G4', 'commission 11%', { commission: 11 }],
        ['G4', 'commission unknown', { commission: null }],
        ['G4', 'raised recently', { commissionHistory: { raisedRecently: true, pendingRaise: false } }],
        ['G4', 'raise pending', { commissionHistory: { raisedRecently: false, pendingRaise: true } }],
        ['G5', 'slashed 10 eras ago', { slashEras: [ERA - 10] }],
        ['G6', 'reliable in only 85% of elected eras', { perf: okPerf({ reliability: 85 }) }],
        ['G7', 'two payout pages', { exposurePages: 2 }],
        ['G8', 'return under 75% of the median', { apr: 1 }]
    ];
    for (const [gate, why, over] of CASES) {
        test(`${gate}: ${why}`, () => {
            const base = pool([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
            const bad = val(60, { apr: 50, ...over });
            const r = pickValidators(base.concat([bad]), META);
            assert.ok(!addrs(r).includes(bad.address), `${why}: picked`);
            assert.equal(r.rejected[gate], 1, `${why}: counted under ${gate}`);
            assert.equal(GATES.reduce((s, g) => s + r.rejected[g], 0), 1, 'counted once');
        });
    }
    test('commission exactly 10% and a slash 85 eras ago pass', () => {
        const r = pickValidators([val(1, { apr: 20, commission: 10 }), val(2, { apr: 19, slashEras: [ERA - 85] })], META);
        assert.equal(r.picks.length, 2);
    });
    test('every pick passes the Suggested filters (identity any, spread off): Simple and Advanced cannot disagree', () => {
        const list = pool([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]).concat(CASES.map(([, , over], i) => val(70 + i, { apr: 50, ...over })));
        const r = pickValidators(list, META);
        const suggested = new Set(applyFilters(list, { ...RECOMMENDED_PRESET, identity: 'any', spread: false }, { activeEra: ERA, pageSize: 256 }).map(v => v.address));
        assert.equal(r.picks.length, 8);
        for (const a of addrs(r)) assert.ok(suggested.has(a), a);
    });
});

describe('pickValidators: the 75% of median gate (G8)', () => {
    test('median of an even pool is the mean of the middle two; the boundary is inclusive', () => {
        assert.equal(medianOf([16, 10, 14, 12]), 13);
        assert.equal(medianOf([3, 1, 2]), 2);
        assert.equal(medianOf([]), null);
        assert.equal(LOW_RETURN_RATIO, 0.75);
        // G1 to G7 pool sorted: 8.24, 8.25, 10, 12, 14, 16, so the median is (10 + 12) / 2 = 11 and 75% of it is 8.25.
        const list = pool([10, 12, 14, 16]).concat([val(30, { apr: 8.25 }), val(31, { apr: 8.24 })]);
        const r = pickValidators(list, META);
        assert.equal(r.median, 11);
        assert.ok(addrs(r).includes(addr(30)), '8.25 is exactly 75% of 11: kept');
        assert.ok(!addrs(r).includes(addr(31)), '8.24 is under: out');
        assert.equal(r.rejected.G8, 1);
    });
    test('the median is taken over validators passing G1 to G7 only', () => {
        // Inactive validators with huge returns must not raise the median.
        const list = pool([10, 10, 10, 10]).concat([100, 100, 100, 100, 100].map((apr, i) => val(40 + i, { apr, active: false })));
        const r = pickValidators(list, META);
        assert.equal(r.median, 10);
        assert.equal(r.picks.length, 4);
    });
});

describe('pickValidators: ties, one per identity, keep', () => {
    // Each row: two validators equal on everything before the tie-break named;
    // the first must rank above the second. apr 12.001 and 12.004 both show 12.00.
    const TIES = [
        ['lower commission', { apr: 12.001, commission: 3 }, { apr: 12.004, commission: 4 }],
        ['verified identity over has identity', { apr: 12.001, identity: { hasIdentity: true, verified: true, parent: null } }, { apr: 12.004, identity: { hasIdentity: true, verified: false, parent: null } }],
        ['has identity over none', { apr: 12.001, identity: { hasIdentity: true, verified: false, parent: null } }, { apr: 12.004, identity: NO_ID }],
        ['higher self-stake', { apr: 12.001, selfStake: 2000 }, { apr: 12.004, selfStake: 1000 }]
    ];
    test('tie at two decimals on every key broken by address ascending, not by the raw return', () => {
        const [lo, hi] = [addr(1), addr(2)].sort();
        const first = { ...val(1, { apr: 12.001 }), address: lo }, second = { ...val(2, { apr: 12.004 }), address: hi };
        assert.deepEqual(addrs(pickValidators([second, first], META)), [lo, hi]);
        assert.deepEqual(addrs(pickValidators([first, second], META)), [lo, hi]);
    });
    for (const [why, a, b] of TIES) {
        test(`tie at two decimals broken by ${why}`, () => {
            const first = val(1, a), second = val(2, b);
            const r1 = pickValidators([second, first], META, { count: 2 });
            const r2 = pickValidators([first, second], META, { count: 2 });
            assert.deepEqual(addrs(r1), [first.address, second.address], why);
            assert.deepEqual(addrs(r2), addrs(r1), 'input order does not matter');
        });
    }
    test('a real difference at two decimals beats every tie-break', () => {
        const r = pickValidators([val(1, { apr: 12.01, commission: 9 }), val(2, { apr: 12.0, commission: 0, selfStake: 1e9 })], META);
        assert.deepEqual(addrs(r), [addr(1), addr(2)]);
    });
    test('two validators under one identity yield one, the higher ranked; validators without identity are each their own group', () => {
        const P = addr(99);
        const sub = (n, apr) => val(n, { apr, identity: { hasIdentity: true, verified: true, parent: P } });
        const list = [sub(1, 20), sub(2, 19), val(3, { apr: 18 }), val(4, { apr: 17 }), val(5, { apr: 16, identity: { hasIdentity: true, verified: true, parent: null } })];
        const r = pickValidators(list, META);
        assert.deepEqual(addrs(r), [addr(1), addr(3), addr(4), addr(5)]);
        // The parent itself holding the identity is the same group as its subs.
        const r2 = pickValidators([sub(1, 20), val(99, { apr: 25, identity: { hasIdentity: true, verified: true, parent: null } })], META);
        assert.deepEqual(addrs(r2), [addr(99)]);
    });
    test('keep: 3 healthy kept validators come first and the rule fills 5', () => {
        const list = pool([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
        const keep = [addr(1), addr(2), addr(3)];
        const r = pickValidators(list, META, { keep });
        assert.equal(r.picks.length, 8);
        assert.deepEqual(addrs(r).slice(0, 3), keep);
        assert.deepEqual(r.picks.map(p => p.kept), [true, true, true, false, false, false, false, false]);
        assert.deepEqual(r.picks.slice(3).map(p => p.apr), [31, 30, 29, 28, 27]);
    });
    test('keep: a kept validator that fails G1 is dropped; kept identities are not picked twice', () => {
        const P = addr(98);
        const list = pool([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]).concat([val(30, { apr: 19, active: false }),
            val(31, { apr: 19.5, identity: { hasIdentity: true, verified: true, parent: P } }), val(32, { apr: 40, identity: { hasIdentity: true, verified: true, parent: P } })]);
        const r = pickValidators(list, META, { keep: [addr(30), addr(31)] });
        assert.ok(!addrs(r).includes(addr(30)), 'inactive kept validator dropped');
        assert.equal(addrs(r)[0], addr(31));
        assert.ok(!addrs(r).includes(addr(32)), 'same identity as a kept one: not added');
    });
});

describe('pickValidators: never the commission-only estimate, deterministic, no mutation', () => {
    test('the lib/apy.js figure on a row is ignored: rank and eligibility use the realized return only', () => {
        const apy = { estimatedApyAtCurrentCommission: 99, realApy: 99, currentApy: 99, avg30DayApy: 99 };
        const list = [val(1, { apr: 12 }), val(2, { apr: 11, ...apy }), val(3, { perf: null, ...apy })];
        const r = pickValidators(list, META);
        assert.deepEqual(addrs(r), [addr(1), addr(2)]);
        assert.deepEqual(r.picks.map(p => p.apr), [12, 11]);
    });
    test('same input twice gives the same output; the input is not mutated; shuffling the input does not change the picks', () => {
        const list = pool([10, 11, 12, 12, 13, 13.001, 14, 15, 16, 17, 18]);
        const before = JSON.stringify(list);
        const a = pickValidators(list, META);
        const b = pickValidators(list, META);
        assert.equal(a.picks.length, 8);
        assert.deepEqual(a, b);
        assert.equal(JSON.stringify(list), before);
        const shuffled = list.slice().reverse();
        assert.deepEqual(addrs(pickValidators(shuffled, META)), addrs(a));
    });
});

describe('existing stakers: review and replacement (decision Q2)', () => {
    const list = () => pool([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
    test('all validators earning: no change is offered and the set stays', () => {
        const cur = [addr(1), addr(5), addr(9)];
        const p = proposeReplacement(cur, list(), META);
        assert.equal(p.offer, false);
        assert.deepEqual(p.targets, cur);
        assert.deepEqual(p.added, []);
        assert.deepEqual(p.removed, []);
    });
    test('some not earning: kept, removed with the reason, and added by the rule', () => {
        const l = list().concat([val(40, { apr: 30, active: false }), val(41, { apr: 30, blocked: true })]);
        const cur = [addr(2), addr(40), addr(41)];
        const p = proposeReplacement(cur, l, META);
        assert.equal(p.offer, true);
        assert.deepEqual(p.kept, [addr(2)]);
        assert.deepEqual(p.removed, [{ address: addr(40), reason: 'inactive' }, { address: addr(41), reason: 'blocked' }]);
        assert.equal(p.added.length, 7);
        assert.ok(!p.added.includes(addr(2)));
        assert.deepEqual(p.targets, [addr(2)].concat(p.added));
        assert.deepEqual(p.added.slice(0, 2), [addr(12), addr(11)], 'by rank');
    });
    test('every removal reason (SC-164), and a validator missing from the snapshot reads as not active', () => {
        const l = pool([10, 10, 10, 10]).concat([
            val(20, { active: false }), val(21, { commission: 100 }), val(22, { blocked: true }),
            val(23, { perf: { 28: { status: 'new', apr: null } } }), val(24, { apr: 2 }), val(25, { slashEras: [ERA - 3] })
        ]);
        const by = new Map(l.map(v => [v.address, v]));
        const r = reviewNominations([addr(1), addr(20), addr(21), addr(22), addr(23), addr(24), addr(25), addr(77)], by, { median: 10, activeEra: ERA });
        assert.deepEqual(r.rows.map(x => x.state), ['ok', 'inactive', 'commission100', 'blocked', 'no-history', 'low-return', 'slashed', 'inactive']);
        assert.equal(r.unhealthy, 7);
        assert.deepEqual(r.keep, [addr(1)]);
    });
    test('a snapshot that is not full offers nothing', () => {
        const p = proposeReplacement([addr(40)], [val(40, { active: false })], { ...META, full: false });
        assert.equal(p.offer, false);
        assert.equal(p.status, 'no-data');
    });
});

describe('returnEstimate', () => {
    test('the range over active validators with a realized figure; the rest are missing', () => {
        const l = [val(1, { apr: 9 }), val(2, { apr: 14 }), val(3, { apr: 30, active: false }), val(4, { perf: { 28: { status: 'new', apr: null } } })];
        const by = new Map(l.map(v => [v.address, v]));
        assert.deepEqual(returnEstimate(l.map(v => v.address), by), { low: 9, high: 14, counted: 2, missing: 2 });
        assert.deepEqual(returnEstimate([addr(4)], by), { none: 'no-history' });
        assert.deepEqual(returnEstimate([addr(50)], by), { none: 'no-data' });
    });
});
