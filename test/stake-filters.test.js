// Stake picker filters, counts, the Suggested filters preset, sort and persistence
// (lib/stake-filters.js). Fixture validators are made up; no real addresses or names.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_FILTERS, RECOMMENDED_PRESET, STORAGE_KEY, FILTER_KEYS, PREDICATES, WHY,
    sanitizeFilters, loadFilters, saveFilters, applyFilters, filterCounts, sortValidators,
    identityGroup, selectedGroups, matchesSearch
} from '../lib/stake-filters.js';

const perf = (apr, o = {}) => ({ '7': { status: 'ok', apr, reliability: 100, missedEras: 0, electedEras: 7, ...o },
    '28': { status: 'ok', apr, reliability: 100, missedEras: 0, electedEras: 28, ...o },
    '84': { status: 'ok', apr, reliability: 100, missedEras: 0, electedEras: 84, ...o } });

function v(address, o = {}) {
    return {
        address, name: `Node ${address}`, active: true, commission: 5, blocked: false,
        totalStake: 1000, selfStake: 100, exposureNominators: 10, backers: 10,
        identity: { hasIdentity: true, verified: false, parent: null },
        slashEras: [], commissionHistory: { raisedRecently: false, pendingRaise: false },
        perf: perf(10), ...o
    };
}
const ALL = () => sanitizeFilters({ status: 'all', maxCommission: 100, notBlocked: false, noSlash: false });
const ctx0 = { activeEra: 1000, pageSize: 256 };

describe('each filter on its own', () => {
    const cases = [
        ['status active', { status: 'active' }, v('a'), v('b', { active: false })],
        ['status waiting', { status: 'waiting' }, v('a', { active: false }), v('b')],
        ['max commission is inclusive', { maxCommission: 10 }, v('a', { commission: 10 }), v('b', { commission: 10.5 })],
        ['default excludes 100% commission', { maxCommission: DEFAULT_FILTERS.maxCommission }, v('a', { commission: 99 }), v('b', { commission: 100 })],
        ['unknown commission fails a commission cap', { maxCommission: 50 }, v('a'), v('b', { commission: null })],
        ['no recent raise', { noRecentRaise: true }, v('a'), v('b', { commissionHistory: { raisedRecently: true } })],
        ['no pending raise', { noRecentRaise: true }, v('a'), v('b', { commissionHistory: { pendingRaise: true } })],
        ['has identity', { identity: 'has' }, v('a'), v('b', { identity: { hasIdentity: false } })],
        ['verified identity', { identity: 'verified' }, v('a', { identity: { hasIdentity: true, verified: true } }), v('b')],
        ['not blocked', { notBlocked: true }, v('a'), v('b', { blocked: true })],
        ['reliability 90', { reliability: '90' }, v('a', { perf: perf(5, { reliability: 90 }) }), v('b', { perf: perf(5, { reliability: 89.9 }) })],
        ['no missed eras', { reliability: 'nomiss' }, v('a'), v('b', { perf: perf(5, { missedEras: 1 }) })],
        ['reliability needs data', { reliability: '90' }, v('a'), v('b', { perf: null })],
        ['room on one payout page: exactly 256 backers is one page', { singlePage: true }, v('a', { exposureNominators: 256 }), v('b', { exposureNominators: 257 })],
        ['the chain page count wins when known', { singlePage: true }, v('a', { exposureNominators: 256, exposurePages: 1 }), v('b', { exposureNominators: 256, exposurePages: 2 })],
        ['no nominators at all is zero pages, which fits', { singlePage: true }, v('a', { exposureNominators: 0, exposurePages: 0 }), v('b', { exposurePages: 3 })],
        ['waiting validators use backers for the page check', { singlePage: true }, v('a', { exposureNominators: null, backers: 256 }), v('b', { exposureNominators: null, backers: 300 })],
        ['min self-stake', { minSelfStake: 100 }, v('a', { selfStake: 100 }), v('b', { selfStake: 99.9 })],
        ['unknown self-stake fails a minimum', { minSelfStake: 1 }, v('a'), v('b', { selfStake: null })],
        ['slashed inside 84 eras', { noSlash: true }, v('a', { slashEras: [900] }), v('b', { slashEras: [916] })]
    ];
    for (const [name, on, pass, fail] of cases) {
        test(name, () => {
            const s = { ...ALL(), ...on };
            const out = applyFilters([pass, fail], s, ctx0).map(x => x.address);
            assert.deepEqual(out, ['a'], name);
            // ...and switching it back off lets both through.
            const offKey = Object.keys(on)[0];
            const off = { ...s, [offKey]: ALL()[offKey] };
            assert.equal(applyFilters([pass, fail], off, ctx0).length, 2, `${name}: off`);
        });
    }

    test('spread: hides a validator under the identity of one already picked, never the pick itself', () => {
        const parent = v('p');
        const sub = v('s', { identity: { hasIdentity: true, parent: 'p' } });
        const other = v('o');
        const anon = v('x', { identity: { hasIdentity: false } });
        const anon2 = v('y', { identity: { hasIdentity: false } });
        const list = [parent, sub, other, anon, anon2];
        const byAddress = new Map(list.map(x => [x.address, x]));
        const selected = new Set(['p', 'x']);
        const ctx = { ...ctx0, selected, groups: selectedGroups(selected, byAddress) };
        const out = applyFilters(list, { ...ALL(), spread: true }, ctx).map(x => x.address);
        assert.deepEqual(out, ['p', 'o', 'x', 'y'], 'sub of the picked parent is hidden; anonymous validators are never grouped');
    });

    test('identityGroup follows the on-chain parent only', () => {
        assert.equal(identityGroup(v('a')), 'a');
        assert.equal(identityGroup(v('a', { identity: { hasIdentity: true, parent: 'p' } })), 'p');
        assert.equal(identityGroup(v('a', { identity: { hasIdentity: false, parent: 'p' } })), null);
        assert.equal(identityGroup(v('a', { identity: undefined })), null);
    });

    test('search matches name or address, case-insensitive', () => {
        assert.ok(matchesSearch(v('abc'), 'NODE'));
        assert.ok(matchesSearch(v('abcdef'), 'cde'));
        assert.ok(!matchesSearch(v('abc'), 'zzz'));
        assert.ok(matchesSearch(v('abc'), '  '));
        assert.deepEqual(applyFilters([v('abc'), v('xyz')], ALL(), { search: 'xy' }).map(x => x.address), ['xyz']);
    });

    test('every filter has a plain-language why', () => {
        for (const k of FILTER_KEYS) assert.ok(WHY[k] && WHY[k].length > 20, k);
        assert.ok(WHY.aprWindow && WHY.sort);
    });
});

describe('combined filters and counts', () => {
    const list = [
        v('a'),
        v('b', { commission: 20 }),
        v('c', { blocked: true }),
        v('d', { commission: 20, blocked: true }),
        v('e', { active: false }),
        v('f', { active: false, commission: 20 })
    ];
    const s = { ...ALL(), status: 'active', maxCommission: 10, notBlocked: true };

    test('filters combine with AND', () => {
        assert.deepEqual(applyFilters(list, s, ctx0).map(x => x.address), ['a']);
    });

    test('hiddenBy counts what switching off that one filter would add back', () => {
        const c = filterCounts(list, s, ctx0);
        assert.equal(c.shown, 1);
        assert.equal(c.total, 6);
        assert.equal(c.hiddenBy.maxCommission, 1, 'b');
        assert.equal(c.hiddenBy.notBlocked, 1, 'c');
        assert.equal(c.hiddenBy.status, 1, 'e: waiting, but passes every other filter');
    });

    test('status counts apply every other filter', () => {
        const c = filterCounts(list, s, ctx0);
        assert.deepEqual(c.status, { active: 1, waiting: 1, all: 2 });
    });

    test('the default state shows the active set minus 100% commission, blocked and slashed', () => {
        const l = [v('a'), v('b', { commission: 100 }), v('c', { blocked: true }), v('d', { slashEras: [999] }), v('e', { active: false })];
        assert.deepEqual(applyFilters(l, DEFAULT_FILTERS, ctx0).map(x => x.address), ['a']);
    });
});

describe('Suggested filters preset', () => {
    test('is exactly the documented definition', () => {
        assert.deepEqual({ ...RECOMMENDED_PRESET }, {
            status: 'active', maxCommission: 10, noRecentRaise: true, identity: 'has', notBlocked: true,
            reliability: '90', singlePage: true, minSelfStake: 0, noSlash: true, spread: true, aprWindow: 28, sort: 'apr'
        });
        assert.deepEqual(sanitizeFilters(RECOMMENDED_PRESET), { ...RECOMMENDED_PRESET }, 'the preset is a valid state');
    });
    test('keeps a good validator and drops each kind of bad one', () => {
        const l = [
            v('good', { perf: perf(12) }),
            v('fee', { commission: 11 }),
            v('raise', { commissionHistory: { pendingRaise: true } }),
            v('anon', { identity: { hasIdentity: false } }),
            v('flaky', { perf: perf(30, { reliability: 50 }) }),
            v('full', { exposureNominators: 400 }),
            v('slashed', { slashEras: [990] }),
            v('waiting', { active: false }),
            v('better', { perf: perf(14) })
        ];
        const shown = sortValidators(applyFilters(l, RECOMMENDED_PRESET, ctx0), RECOMMENDED_PRESET).map(x => x.address);
        assert.deepEqual(shown, ['better', 'good']);
    });
    test('the user can adjust it: one change, everything else stays', () => {
        const adjusted = sanitizeFilters({ ...RECOMMENDED_PRESET, maxCommission: 15 });
        assert.equal(adjusted.maxCommission, 15);
        assert.equal(adjusted.spread, true);
    });
});

describe('sort', () => {
    const list = [
        v('n1', { perf: perf(0, { status: 'none', apr: null, reliability: null }) }),
        v('a', { perf: perf(10), commission: 5, totalStake: 3, selfStake: 1 }),
        v('new', { perf: perf(0, { status: 'new', apr: null, reliability: 80 }) }),
        v('b', { perf: perf(12), commission: 1, totalStake: null, selfStake: 9 }),
        v('c', { perf: perf(10), commission: 5, totalStake: 7, selfStake: null })
    ];
    const order = (sort) => sortValidators(list, { ...ALL(), sort }).map(x => x.address);

    test('APR: highest first, then new, then none', () => {
        assert.deepEqual(order('apr'), ['b', 'a', 'c', 'new', 'n1']);
    });
    test('commission ascending, total and self-stake descending, nulls always last', () => {
        assert.deepEqual(order('commission'), ['b', 'n1', 'a', 'new', 'c']);
        assert.deepEqual(order('totalStake'), ['n1', 'new', 'c', 'a', 'b']);
        assert.deepEqual(order('selfStake'), ['n1', 'new', 'b', 'a', 'c']);
    });
    test('reliability descending', () => {
        assert.deepEqual(order('reliability'), ['a', 'b', 'c', 'new', 'n1']);
    });
    test('stable: equal keys keep their incoming order, both ways round', () => {
        const same = ['p', 'q', 'r', 's'].map(x => v(x, { perf: perf(10) }));
        assert.deepEqual(sortValidators(same, ALL()).map(x => x.address), ['p', 'q', 'r', 's']);
        assert.deepEqual(sortValidators(same.slice().reverse(), ALL()).map(x => x.address), ['s', 'r', 'q', 'p']);
    });
    test('the window decides which APR is sorted on', () => {
        const x = v('x', { perf: { '7': { status: 'ok', apr: 1 }, '28': { status: 'ok', apr: 50 } } });
        const y = v('y', { perf: { '7': { status: 'ok', apr: 9 }, '28': { status: 'ok', apr: 5 } } });
        assert.deepEqual(sortValidators([x, y], { ...ALL(), aprWindow: 7 }).map(z => z.address), ['y', 'x']);
        assert.deepEqual(sortValidators([x, y], { ...ALL(), aprWindow: 28 }).map(z => z.address), ['x', 'y']);
    });
    test('does not mutate the input', () => {
        const copy = list.map(x => x.address);
        order('apr');
        assert.deepEqual(list.map(x => x.address), copy);
    });
});

describe('persistence', () => {
    const mem = () => {
        const m = new Map();
        return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, val) => m.set(k, String(val)), m };
    };
    test('round trip under the documented key', () => {
        const st = mem();
        assert.ok(saveFilters(st, { ...DEFAULT_FILTERS, maxCommission: 7, spread: true }));
        assert.ok(st.m.has(STORAGE_KEY));
        assert.equal(STORAGE_KEY, 'pdex_stake_filters_v1');
        const back = loadFilters(st);
        assert.equal(back.maxCommission, 7);
        assert.equal(back.spread, true);
    });
    test('nothing stored, garbage stored, or a store that throws: defaults, no exception', () => {
        assert.deepEqual(loadFilters(mem()), { ...DEFAULT_FILTERS });
        const bad = mem(); bad.setItem(STORAGE_KEY, '{not json');
        assert.deepEqual(loadFilters(bad), { ...DEFAULT_FILTERS });
        const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
        assert.deepEqual(loadFilters(throwing), { ...DEFAULT_FILTERS });
        assert.equal(saveFilters(throwing, DEFAULT_FILTERS), false);
        assert.deepEqual(loadFilters(null), { ...DEFAULT_FILTERS });
    });
    test('stored values are sanitized: unknown keys dropped, ranges clamped, bad enums reset', () => {
        const st = mem();
        st.setItem(STORAGE_KEY, JSON.stringify({ status: 'evil', maxCommission: 900, minSelfStake: -5, aprWindow: 5, sort: '__proto__', identity: '<b>', extra: 1, reliability: 90 }));
        const s = loadFilters(st);
        assert.equal(s.status, 'active');
        assert.equal(s.maxCommission, 100);
        assert.equal(s.minSelfStake, 0);
        assert.equal(s.aprWindow, 28);
        assert.equal(s.sort, 'apr');
        assert.equal(s.identity, 'any');
        assert.equal(s.reliability, '90');
        assert.ok(!('extra' in s));
    });
    test('the predicate table and the state agree on keys', () => {
        for (const k of FILTER_KEYS) assert.ok(k in DEFAULT_FILTERS, k);
        assert.equal(typeof PREDICATES.spread, 'function');
    });
});
