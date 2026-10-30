// Unclaimed staking rewards across the spec 392 boundary.
//
// recomputeUnclaimed used api.derive.staking.stakerRewards (api-derive
// 17.0.2), whose exposure source reads only erasStakersPaged when the runtime
// has it. On 392 every era elected before the upgrade lives in the legacy
// stores, so unpaid pre-392 rewards vanished from the explorer's "unclaimed"
// list. lib/unclaimed-rewards.js reads paged first and legacy (clipped, which
// is what payout_stakers pays from) for an era with no paged data, and takes
// claimed state from claimedRewards pages and the validator ledger.
//
// Driven with REAL codecs from the 373 and 392 metadata fixtures when present.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { readEraExposureIndex } from '../lib/era-exposure.js';
import { computeStashUnclaimed, stashEraPayouts, mergeUnclaimed, ledgerClaimedEras } from '../lib/unclaimed-rewards.js';

const PDEX = 10n ** 12n;
const V1 = '0x' + 'd4'.repeat(32);
const V2 = '0x' + '8e'.repeat(32);
const N1 = '0x' + '11'.repeat(32);
const N2 = '0x' + '22'.repeat(32);
const N3 = '0x' + '33'.repeat(32);
const N9 = '0x' + '99'.repeat(32);

const toHex = (a) => u8aToHex(decodeAddress(a.toString()));
const argKey = (a) => {
    const s = a.toString();
    return /^\d+$/.test(s) ? s : toHex(s);
};

// Staking storage decorated from the metadata like polkadot.js: only items
// the runtime has exist, Optional items return Option<T>, Default items T's
// default; map items also get entries(era) with real StorageKey-like args.
function mockApi(registry, data) {
    const pallet = registry.metadata.pallets.find(p => p.name.toString() === 'Staking');
    const items = pallet.storage.unwrap().items;
    const calls = [];
    const staking = {};
    for (const it of items) {
        const itemName = it.name.toString();
        if (!it.type.isMap) continue;
        const store = data[itemName] || {};
        const valueType = registry.createLookupType(it.type.asMap.value);
        const optional = it.modifier.isOptional;
        const wrap = (v) => optional
            ? registry.createType(`Option<${valueType}>`, v === undefined ? null : v)
            : registry.createType(valueType, v);
        const fn = async (...args) => {
            calls.push(itemName);
            return wrap(store[args.map(argKey).join(':')]);
        };
        fn.entries = async (era) => {
            calls.push(itemName + '.entries');
            return Object.keys(store)
                .filter(k => k.split(':')[0] === String(era))
                .map(k => {
                    const [e, who, page] = k.split(':');
                    const args = [registry.createType('u32', Number(e)), registry.createType('AccountId', who)];
                    if (page !== undefined) args.push(registry.createType('u32', Number(page)));
                    return [{ args }, wrap(store[k])];
                });
        };
        const name = itemName.charAt(0).toLowerCase() + itemName.slice(1);
        staking[name] = fn;
    }
    return { api: { query: { staking } }, calls };
}

const ERA_OLD = 110;   // elected under 373, claimable on 392
const ERA_NEW = 120;   // elected under 392

// One era: reward 1000 PDEX, 100 points, V1 has 50, V2 has 50. V1 10%.
function eraRewardData(era) {
    return {
        ErasValidatorReward: { [`${era}`]: 1000n * PDEX },
        ErasRewardPoints: { [`${era}`]: { total: 100, individual: { [V1]: 50, [V2]: 50 } } },
        ErasValidatorPrefs: {
            [`${era}:${V1}`]: { commission: 100_000_000, blocked: false },
            [`${era}:${V2}`]: { commission: 0, blocked: false }
        }
    };
}

function merge(...parts) {
    const out = {};
    for (const p of parts) for (const [k, v] of Object.entries(p)) out[k] = { ...(out[k] || {}), ...v };
    return out;
}

// Legacy era as 373 wrote it. N9 is in the full exposure but was clipped out
// (pays nothing). V1: total 250, own 100, N1 150.
function legacyEra(era) {
    return {
        ErasStakers: {
            [`${era}:${V1}`]: { total: 250n * PDEX, own: 100n * PDEX, others: [{ who: N1, value: 140n * PDEX }, { who: N9, value: 10n * PDEX }] },
            [`${era}:${V2}`]: { total: 40n * PDEX, own: 40n * PDEX, others: [] }
        },
        ErasStakersClipped: {
            [`${era}:${V1}`]: { total: 250n * PDEX, own: 100n * PDEX, others: [{ who: N1, value: 140n * PDEX }] },
            [`${era}:${V2}`]: { total: 40n * PDEX, own: 40n * PDEX, others: [] }
        }
    };
}

// Paged era as 392 writes it. V1: total 300, own 100; page 0 N1 100 + N2 50,
// page 1 N3 50.
function pagedEra(era) {
    return {
        ErasStakersOverview: {
            [`${era}:${V1}`]: { total: 300n * PDEX, own: 100n * PDEX, nominatorCount: 3, pageCount: 2 },
            [`${era}:${V2}`]: { total: 50n * PDEX, own: 50n * PDEX, nominatorCount: 0, pageCount: 0 }
        },
        ErasStakersPaged: {
            [`${era}:${V1}:0`]: { pageTotal: 150n * PDEX, others: [{ who: N1, value: 100n * PDEX }, { who: N2, value: 50n * PDEX }] },
            [`${era}:${V1}:1`]: { pageTotal: 50n * PDEX, others: [{ who: N3, value: 50n * PDEX }] }
        }
    };
}

const ledger392 = (claimed = []) => ({
    Bonded: { [V1]: V1, [V2]: V2 },
    Ledger: { [V1]: { stash: V1, total: 100n * PDEX, active: 100n * PDEX, unlocking: [], legacyClaimedRewards: claimed } }
});

const pdex = (raw) => Number(raw / 10n ** 9n) / 1000;   // 3 decimals is enough here
const opts = { normalize: toHex };

// What the 17.0.2 derive could see on 392: erasStakersPaged entries only.
async function deriveVisibleValidators(api, era) {
    const r = await api.query.staking.erasStakersPaged.entries(era);
    return r.filter(([, o]) => o.isSome).map(([k]) => toHex(k.args[1]));
}

const fx392 = loadFixture('metadata-392.json');
const fx373 = loadFixture('metadata-373.json');

describe('unclaimed rewards on real spec 392 codecs', { skip: fx392 ? false : 'test/fixtures/metadata-392.json absent' }, () => {
    const registry = fx392 && registryFromMetadata(fx392.metadata);

    test('pre-392 era: nominator reward is owed (the derive saw no exposure at all)', async () => {
        const { api } = mockApi(registry, merge(legacyEra(ERA_OLD), eraRewardData(ERA_OLD), ledger392()));
        // The regression, proved: the derive's only source is empty for this era.
        assert.deepEqual(await deriveVisibleValidators(api, ERA_OLD), []);
        const { rows, emptyEras } = await computeStashUnclaimed(api, N1, [ERA_OLD], opts);
        assert.deepEqual(emptyEras, []);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].validator, V1);
        assert.equal(rows[0].era, ERA_OLD);
        // 500 to V1, 10% commission, 450 split by stake: 450 * 140 / 250
        assert.equal(pdex(rows[0].amount), 252);
    });

    test('pre-392 era: paid out before the upgrade (ledger.legacyClaimedRewards) is not owed', async () => {
        const { api } = mockApi(registry, merge(legacyEra(ERA_OLD), eraRewardData(ERA_OLD), ledger392([ERA_OLD])));
        const { rows } = await computeStashUnclaimed(api, N1, [ERA_OLD], opts);
        assert.deepEqual(rows, []);
    });

    test('pre-392 era: paid out after the upgrade (claimedRewards page 0) is not owed', async () => {
        const { api } = mockApi(registry, merge(legacyEra(ERA_OLD), eraRewardData(ERA_OLD), ledger392(),
            { ClaimedRewards: { [`${ERA_OLD}:${V1}`]: [0] } }));
        const { rows } = await computeStashUnclaimed(api, N1, [ERA_OLD], opts);
        assert.deepEqual(rows, []);
    });

    test('pre-392 era: a nominator clipped out of the payout set is owed nothing', async () => {
        const { api } = mockApi(registry, merge(legacyEra(ERA_OLD), eraRewardData(ERA_OLD), ledger392()));
        const { rows } = await computeStashUnclaimed(api, N9, [ERA_OLD], opts);
        assert.deepEqual(rows, []);
    });

    test('post-392 era: nominator on page 1 is owed until page 1 is claimed', async () => {
        const base = merge(pagedEra(ERA_NEW), eraRewardData(ERA_NEW), ledger392());
        let { api } = mockApi(registry, merge(base, { ClaimedRewards: { [`${ERA_NEW}:${V1}`]: [0] } }));
        let { rows } = await computeStashUnclaimed(api, N3, [ERA_NEW], opts);
        assert.equal(rows.length, 1);
        assert.equal(pdex(rows[0].amount), 75);   // 450 * 50 / 300
        ({ api } = mockApi(registry, merge(base, { ClaimedRewards: { [`${ERA_NEW}:${V1}`]: [0, 1] } })));
        ({ rows } = await computeStashUnclaimed(api, N3, [ERA_NEW], opts));
        assert.deepEqual(rows, []);
    });

    test('post-392 era: page 0 claimed settles page 0 nominators only', async () => {
        const { api } = mockApi(registry, merge(pagedEra(ERA_NEW), eraRewardData(ERA_NEW), ledger392(),
            { ClaimedRewards: { [`${ERA_NEW}:${V1}`]: [0] } }));
        assert.deepEqual((await computeStashUnclaimed(api, N1, [ERA_NEW], opts)).rows, []);
        assert.equal((await computeStashUnclaimed(api, N3, [ERA_NEW], opts)).rows.length, 1);
    });

    test('validator stash: commission plus own share, reduced to the unpaid pages', async () => {
        const base = merge(pagedEra(ERA_NEW), eraRewardData(ERA_NEW), ledger392());
        let { api } = mockApi(registry, base);
        let { rows } = await computeStashUnclaimed(api, V1, [ERA_NEW], opts);
        assert.equal(rows.length, 1);
        assert.equal(pdex(rows[0].amount), 200);   // 50 + 450 * 100 / 300
        ({ api } = mockApi(registry, merge(base, { ClaimedRewards: { [`${ERA_NEW}:${V1}`]: [0] } })));
        ({ rows } = await computeStashUnclaimed(api, V1, [ERA_NEW], opts));
        assert.equal(pdex(rows[0].amount), 50);    // page 1 is 50 of 200 paged stake
    });

    test('a window spanning the boundary reports both eras', async () => {
        const { api } = mockApi(registry, merge(legacyEra(ERA_OLD), eraRewardData(ERA_OLD),
            pagedEra(ERA_NEW), eraRewardData(ERA_NEW), ledger392()));
        const { rows, emptyEras } = await computeStashUnclaimed(api, N1, [ERA_OLD, ERA_NEW], opts);
        assert.deepEqual(emptyEras, []);
        assert.deepEqual(rows.map(r => [r.era, pdex(r.amount)]), [[ERA_OLD, 252], [ERA_NEW, 150]]);
    });

    test('an era with no exposure anywhere is reported empty, not "nothing owed"', async () => {
        const { api } = mockApi(registry, merge(eraRewardData(ERA_OLD), ledger392()));
        const { rows, emptyEras } = await computeStashUnclaimed(api, N1, [ERA_OLD], opts);
        assert.deepEqual(rows, []);
        assert.deepEqual(emptyEras, [ERA_OLD]);
    });

    test('era index cache: a second stash reuses the scan', async () => {
        const { api, calls } = mockApi(registry, merge(pagedEra(ERA_NEW), eraRewardData(ERA_NEW), ledger392()));
        const indexCache = new Map();
        await computeStashUnclaimed(api, N1, [ERA_NEW], { ...opts, indexCache });
        const scans = calls.filter(c => c.endsWith('.entries')).length;
        await computeStashUnclaimed(api, N3, [ERA_NEW], { ...opts, indexCache });
        assert.equal(calls.filter(c => c.endsWith('.entries')).length, scans);
    });

    test('readEraExposureIndex: overview wins over legacy for the same validator', async () => {
        const { api } = mockApi(registry, merge(pagedEra(ERA_NEW), {
            ErasStakersClipped: { [`${ERA_NEW}:${V1}`]: { total: 1n, own: 1n, others: [] } }
        }));
        const idx = await readEraExposureIndex(api, ERA_NEW, toHex);
        assert.equal(idx.get(V1).source, 'overview');
        assert.equal(idx.get(V1).pages.length, 2);
    });
});

describe('unclaimed rewards on real spec 373 codecs', { skip: fx373 ? false : 'test/fixtures/metadata-373.json absent' }, () => {
    const registry = fx373 && registryFromMetadata(fx373.metadata);
    const ledger373 = (claimed = []) => ({
        Bonded: { [V1]: V1 },
        Ledger: { [V1]: { stash: V1, total: 100n * PDEX, active: 100n * PDEX, unlocking: [], claimedRewards: claimed } }
    });

    test('legacy era owed, then claimed via ledger.claimedRewards', async () => {
        let { api } = mockApi(registry, merge(legacyEra(ERA_OLD), eraRewardData(ERA_OLD), ledger373()));
        assert.equal(api.query.staking.erasStakersOverview, undefined);
        let { rows } = await computeStashUnclaimed(api, N1, [ERA_OLD], opts);
        assert.equal(rows.length, 1);
        assert.equal(pdex(rows[0].amount), 252);
        ({ api } = mockApi(registry, merge(legacyEra(ERA_OLD), eraRewardData(ERA_OLD), ledger373([ERA_OLD]))));
        ({ rows } = await computeStashUnclaimed(api, N1, [ERA_OLD], opts));
        assert.deepEqual(rows, []);
    });
});

describe('pure parts', () => {
    test('ledgerClaimedEras reads both field names and Option', () => {
        assert.deepEqual(ledgerClaimedEras({ legacyClaimedRewards: [3, 4] }), [3, 4]);
        assert.deepEqual(ledgerClaimedEras({ claimedRewards: [5] }), [5]);
        assert.deepEqual(ledgerClaimedEras({ isSome: false }), []);
        assert.deepEqual(ledgerClaimedEras(null), []);
    });

    test('stashEraPayouts: zero reward or zero points owes nothing', () => {
        const index = new Map([[V1, { total: 10n, own: 10n, source: 'legacy', pages: [{ page: 0, pageTotal: 10n, others: [] }] }]]);
        const base = { points: { total: 1n, individual: { [V1]: 1n } }, commissionOf: () => 0n, isPageClaimed: () => false };
        assert.deepEqual(stashEraPayouts(index, V1, { ...base, eraReward: 0n }), []);
        assert.deepEqual(stashEraPayouts(index, V1, { ...base, eraReward: 5n, points: { total: 0n, individual: {} } }), []);
        assert.deepEqual(stashEraPayouts(index, V1, { ...base, eraReward: 5n }), [{ validator: V1, amount: 5n }]);
    });

    test('mergeUnclaimed: an all-empty read never wipes the stored list', () => {
        const stored = [{ era: 110, validator: V1, amount: 3 }];
        assert.equal(mergeUnclaimed(stored, [], [110, 111], 2), null);
    });

    test('mergeUnclaimed: an empty era keeps its stored rows, other eras are replaced', () => {
        const stored = [{ era: 110, validator: V1, amount: 3 }, { era: 111, validator: V1, amount: 4 }];
        const fresh = [{ era: 111, validator: V1, amount: 1 }];
        assert.deepEqual(mergeUnclaimed(stored, fresh, [110], 2), [stored[0], fresh[0]]);
        assert.deepEqual(mergeUnclaimed(stored, [], [], 2), []);
    });
});

describe('server.js wiring', () => {
    const body = stripComments(bodyOf(readRepo('server.js', import.meta.url), 'recomputeUnclaimed'));

    test('recomputeUnclaimed no longer uses the derive', () => {
        assert.ok(body.length > 100);
        assert.ok(!/derive\.staking/.test(body));
        assert.match(body, /computeStashUnclaimed\(/);
    });

    test('recomputeUnclaimed never writes an empty list unconditionally', () => {
        assert.ok(!/replaceUnclaimed\(stash,\s*\[\]\)/.test(body));
        assert.match(body, /mergeUnclaimed\(/);
        assert.match(body, /rows === null/);
    });
});
