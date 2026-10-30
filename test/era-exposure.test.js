// Spec 392 incident: /api/validators served totalStake 0 for all 200
// validators, status Synced, nothing logged.
//
// Root cause: getEraValidatorStake asked "does the runtime HAVE
// erasStakersOverview?" and, on 392 where it does, returned 0 for any era with
// no overview entry, never reading the legacy erasStakers map where every
// pre-upgrade era's exposure lives. computeNetworkInfo read erasStakers
// directly, which goes to 0 on the first era elected after the upgrade.
//
// These tests drive lib/era-exposure.js with REAL codecs built from the 373
// and 392 metadata fixtures (when present; scripts/fetch-metadata.mjs writes
// them) and with plain mocks (always), and include a transcription of the old
// reader to prove the main assertion fails against it.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';
import {
    readEraExposureOverview, readEraValidatorStake, readEraExposureNominators,
    assessStakeHealth, isZeroBalance
} from '../lib/era-exposure.js';
import { apyFields, estimatedApy, APY_FIELD } from '../lib/apy.js';
import * as db from '../db.js';

const PDEX = 10n ** 12n;
const V1 = '0x' + 'd4'.repeat(32);
const V2 = '0x' + '8e'.repeat(32);
const V3 = '0x' + '90'.repeat(32);
const N1 = '0x' + '11'.repeat(32);
const N2 = '0x' + '22'.repeat(32);
const N3 = '0x' + '33'.repeat(32);

// Same planck -> PDEX conversion as server.js formatPDEX.
function formatPDEX(balance) {
    const planck = BigInt(balance.toString());
    return Number(planck / PDEX) + Number(planck % PDEX) / 1e12;
}

// A staking query surface decorated from the metadata like polkadot.js does:
// only items present in the runtime exist, Optional items return Option<T>,
// Default items return T's default when unset. Counts every call.
function mockApi(registry, { overview = {}, paged = {}, legacy = {} } = {}) {
    const pallet = registry.metadata.pallets.find(p => p.name.toString() === 'Staking');
    const items = pallet.storage.unwrap().items;
    const calls = [];
    const make = (item, data, keyOf) => {
        const it = items.find(i => i.name.toString() === item);
        if (!it) return undefined;
        const name = registry.createLookupType(it.type.asMap.value);
        const optional = it.modifier.isOptional;
        return async (...args) => {
            calls.push(item);
            const v = data[keyOf(...args)];
            if (optional) return registry.createType(`Option<${name}>`, v === undefined ? null : v);
            return registry.createType(name, v);
        };
    };
    const staking = {};
    const ov = make('ErasStakersOverview', overview, (e, a) => `${e}:${a}`);
    const pg = make('ErasStakersPaged', paged, (e, a, p) => `${e}:${a}:${p}`);
    const lg = make('ErasStakers', legacy, (e, a) => `${e}:${a}`);
    if (ov) staking.erasStakersOverview = ov;
    if (pg) staking.erasStakersPaged = pg;
    if (lg) staking.erasStakers = lg;
    return { api: { query: { staking } }, calls };
}

// The pre-fix reader, transcribed from server.js at 3914012, to prove the
// tests below fail against it.
async function oldGetEraValidatorStake(api, era, address) {
    let totalStake = 0;
    if (api.query.staking.erasStakersOverview) {
        const overviewOpt = await api.query.staking.erasStakersOverview(era, address);
        if (overviewOpt.isSome) totalStake = overviewOpt.unwrap().total;
    } else if (api.query.staking.erasStakers) {
        const exposure = await api.query.staking.erasStakers(era, address);
        totalStake = exposure.total;
    }
    return totalStake && totalStake.unwrap ? totalStake.unwrap() : totalStake;
}

const ERA_NEW = 120;   // elected after 392: paged storage only
const ERA_OLD = 110;   // elected before 392: legacy storage only

function chainData392() {
    return {
        overview: {
            [`${ERA_NEW}:${V1}`]: { total: 300n * PDEX, own: 100n * PDEX, nominatorCount: 3, pageCount: 2 },
            [`${ERA_NEW}:${V2}`]: { total: 50n * PDEX, own: 50n * PDEX, nominatorCount: 0, pageCount: 0 }
        },
        paged: {
            [`${ERA_NEW}:${V1}:0`]: { pageTotal: 150n * PDEX, others: [{ who: N1, value: 100n * PDEX }, { who: N2, value: 50n * PDEX }] },
            [`${ERA_NEW}:${V1}:1`]: { pageTotal: 50n * PDEX, others: [{ who: N3, value: 50n * PDEX }] }
        },
        legacy: {
            [`${ERA_OLD}:${V1}`]: { total: 250n * PDEX, own: 100n * PDEX, others: [{ who: N1, value: 150n * PDEX }] },
            [`${ERA_OLD}:${V2}`]: { total: 40n * PDEX, own: 40n * PDEX, others: [] }
        }
    };
}

const fx392 = loadFixture('metadata-392.json');
const fx373 = loadFixture('metadata-373.json');

describe('era exposure on real spec 392 codecs', { skip: fx392 ? false : 'test/fixtures/metadata-392.json absent' }, () => {
    const registry = fx392 && registryFromMetadata(fx392.metadata);

    test('the 392 metadata has both stores (the trap: legacy still decorates, but is not written)', () => {
        const { api } = mockApi(registry);
        assert.ok(api.query.staking.erasStakersOverview);
        assert.ok(api.query.staking.erasStakersPaged);
        assert.ok(api.query.staking.erasStakers);
    });

    test('current era: totals from erasStakersOverview, legacy never read', async () => {
        const { api, calls } = mockApi(registry, chainData392());
        const ov = await readEraExposureOverview(api, ERA_NEW, V1);
        assert.equal(ov.source, 'overview');
        assert.equal(formatPDEX(ov.total), 300);
        assert.equal(formatPDEX(ov.own), 100);
        assert.equal(ov.nominatorCount, 3);
        assert.equal(ov.pageCount, 2);
        assert.deepEqual(calls, ['ErasStakersOverview']);
    });

    test('pre-upgrade era: falls back to legacy erasStakers (old reader returned 0 here)', async () => {
        const { api } = mockApi(registry, chainData392());
        assert.equal(formatPDEX(await readEraValidatorStake(api, ERA_OLD, V1)), 250);
        // The regression, proved: the old reader gives 0 for the same state.
        assert.equal(formatPDEX(await oldGetEraValidatorStake(api, ERA_OLD, V1)), 0);
    });

    test('memo: once an era is legacy-only, later validators skip the overview read', async () => {
        const { api, calls } = mockApi(registry, chainData392());
        const memo = new Map();
        await readEraValidatorStake(api, ERA_OLD, V1, memo);
        calls.length = 0;
        assert.equal(formatPDEX(await readEraValidatorStake(api, ERA_OLD, V2, memo)), 40);
        assert.deepEqual(calls, ['ErasStakers']);
    });

    test('memo never turns a real exposure into 0: legacy-era miss still checks the overview', async () => {
        const data = chainData392();
        data.overview[`${ERA_OLD}:${V3}`] = { total: 7n * PDEX, own: 7n * PDEX, nominatorCount: 0, pageCount: 0 };
        const { api } = mockApi(registry, data);
        const memo = new Map([[ERA_OLD, 'legacy']]);
        assert.equal(formatPDEX(await readEraValidatorStake(api, ERA_OLD, V3, memo)), 7);
    });

    test('not elected in the era: explicit none, total 0', async () => {
        const { api } = mockApi(registry, chainData392());
        const ov = await readEraExposureOverview(api, ERA_NEW, V3);
        assert.equal(ov.source, 'none');
        assert.ok(isZeroBalance(ov.total));
    });

    test('nominators: every erasStakersPaged page on the current era, legacy others on an old era', async () => {
        const { api, calls } = mockApi(registry, chainData392());
        const ov = await readEraExposureOverview(api, ERA_NEW, V1);
        calls.length = 0;
        const who = await readEraExposureNominators(api, ERA_NEW, V1, ov);
        assert.equal(who.length, 3);
        assert.deepEqual(calls, ['ErasStakersPaged', 'ErasStakersPaged']);
        const old = await readEraExposureNominators(api, ERA_OLD, V1);
        assert.equal(old.length, 1);
        assert.deepEqual(await readEraExposureNominators(api, ERA_NEW, V2), []);
    });

    test('the zero guard fires on what the old network-info read produced after the upgrade', async () => {
        // computeNetworkInfo read erasStakers(activeEra) unconditionally.
        const { api } = mockApi(registry, chainData392());
        const stale = [];
        for (const v of [V1, V2]) stale.push(formatPDEX((await api.query.staking.erasStakers(ERA_NEW, v)).total));
        assert.deepEqual(stale, [0, 0]);
        assert.equal(assessStakeHealth(stale, 2, ERA_NEW).allZero, true);
        const fixed = [];
        for (const v of [V1, V2]) fixed.push(formatPDEX(await readEraValidatorStake(api, ERA_NEW, v)));
        assert.deepEqual(fixed, [300, 50]);
        assert.equal(assessStakeHealth(fixed, 2, ERA_NEW).ok, true);
    });
});

describe('era exposure on real spec 373 codecs (history before the upgrade)', { skip: fx373 ? false : 'test/fixtures/metadata-373.json absent' }, () => {
    const registry = fx373 && registryFromMetadata(fx373.metadata);

    test('373 has no paged storage: legacy only, same answers', async () => {
        const { api, calls } = mockApi(registry, chainData392());
        assert.equal(api.query.staking.erasStakersOverview, undefined);
        const ov = await readEraExposureOverview(api, ERA_OLD, V1);
        assert.equal(ov.source, 'legacy');
        assert.equal(formatPDEX(ov.total), 250);
        assert.equal(ov.nominatorCount, 1);
        assert.deepEqual(calls, ['ErasStakers']);
        assert.equal((await readEraExposureOverview(api, ERA_OLD, V3)).source, 'none');
    });
});

describe('era exposure with plain mocks (no fixtures needed)', () => {
    const opt = v => (v == null ? { isSome: false } : { isSome: true, unwrap: () => v });
    const api = {
        query: {
            staking: {
                erasStakersOverview: async (e, a) => opt(e === 2 && a === 'A' ? { total: 5n * PDEX, own: PDEX, nominatorCount: 1, pageCount: 1 } : null),
                erasStakersPaged: async (e, a, p) => opt(e === 2 && a === 'A' && p === 0 ? { others: [{ who: 'N' }] } : null),
                erasStakers: async (e, a) => (e === 1 && a === 'A' ? { total: 4n * PDEX, own: PDEX, others: [{ who: 'M' }] } : { total: 0n, own: 0n, others: [] })
            }
        }
    };
    test('overview, legacy, none', async () => {
        assert.equal(formatPDEX(await readEraValidatorStake(api, 2, 'A')), 5);
        assert.equal(formatPDEX(await readEraValidatorStake(api, 1, 'A')), 4);
        assert.equal((await readEraExposureOverview(api, 3, 'A')).source, 'none');
        assert.deepEqual(await readEraExposureNominators(api, 2, 'A'), ['N']);
        assert.deepEqual(await readEraExposureNominators(api, 1, 'A'), ['M']);
    });
    test('isZeroBalance across shapes', () => {
        assert.equal(isZeroBalance(0), true);
        assert.equal(isZeroBalance(0n), true);
        assert.equal(isZeroBalance('0'), true);
        assert.equal(isZeroBalance(null), true);
        assert.equal(isZeroBalance(1n), false);
        assert.equal(isZeroBalance('1000000000000'), false);
    });
});

describe('zero-stake guard', () => {
    test('every active validator at 0 is flagged with a message', () => {
        const h = assessStakeHealth([0, 0, 0], 3, 120);
        assert.equal(h.ok, false);
        assert.equal(h.allZero, true);
        assert.match(h.message, /all 3 of 3 active validators report 0 total stake for era 120/);
    });
    test('one real stake is enough; an empty chain or empty list is not flagged', () => {
        assert.equal(assessStakeHealth([0, 0, 12.5], 3).ok, true);
        assert.equal(assessStakeHealth([], 3).ok, true);
        assert.equal(assessStakeHealth([0, 0], 0).ok, true);
    });
    test('NaN / null stakes count as zero, not as data', () => {
        assert.equal(assessStakeHealth([null, NaN, undefined], 3).allZero, true);
    });
});

describe('APY does not depend on stake', () => {
    test('95% commission: 1.1545 on every field, which is 23.09 x 5%, correct', () => {
        const f = apyFields(95);
        assert.ok(Math.abs(f[APY_FIELD] - 1.1545) < 1e-9);
        for (const k of ['realApy', 'currentApy', 'avg30DayApy']) assert.equal(f[k], f[APY_FIELD]);
        assert.equal(estimatedApy(95), f[APY_FIELD]);
    });
    test('syncData derives APY from commission only', () => {
        const src = stripComments(readRepo('server.js', import.meta.url));
        const start = src.indexOf('async function syncData()');
        const body = src.slice(start, src.indexOf('\nasync function ', start + 10));
        assert.match(body, /\.\.\.apyFields\(commissionPct\)/);
        assert.doesNotMatch(body, /apyFields\([^)]*[Ss]take/);
    });
});

describe('server.js wiring', () => {
    const src = stripComments(readRepo('server.js', import.meta.url));
    test('no direct legacy exposure reads left in server.js', () => {
        assert.doesNotMatch(src, /query\.staking\.erasStakers(Clipped)?\(/);
        assert.doesNotMatch(src, /query\.staking\.erasStakersOverview\(/);
    });
    test('getEraValidatorStake delegates to the fallback reader', () => {
        assert.match(src, /async function getEraValidatorStake\(api, era, address, memo = null\) \{\s*return readEraValidatorStake\(api, era, address, memo\);/);
    });
    test('network info reads nominators through the paged reader and runs the guard', () => {
        const start = src.indexOf('async function computeNetworkInfo()');
        const body = src.slice(start, start + 6000);
        assert.match(body, /readEraExposureOverview\(globalApi, activeEra, address, exposureMemo\)/);
        assert.match(body, /readEraExposureNominators\(globalApi, activeEra, address, overview\)/);
        assert.match(body, /recordStakeHealth\('networkInfo', stakeHealth, activeEra\)/);
        assert.match(body, /stakeDataOk: stakeHealth\.ok/);
    });
    test('syncData runs the guard, marks Degraded, and publishes before the history scan', () => {
        const start = src.indexOf('async function syncData()');
        const body = src.slice(start, src.indexOf('\nasync function ', start + 10));
        assert.match(body, /assessStakeHealth\(validatorData\.map\(v => v\.totalStake\), validators\.length, activeEra\)/);
        assert.match(body, /status: stakeHealth\.ok \? 'Synced' : 'Degraded', stakeDataOk: stakeHealth\.ok/);
        assert.ok(body.indexOf('db.replaceValidators(') < body.indexOf('await syncValidatorHistory('));
    });
    test('the guard logs at error level and /api/health carries it', () => {
        assert.match(src, /if \(!health\.ok\) console\.error\(`\[stake-health\]/);
        const route = src.slice(src.indexOf("app.get('/api/health'"), src.indexOf("app.get('/api/health'") + 3000);
        assert.match(route, /validatorStake: \(\(\) => \{ try \{ return stakeHealthOk\(\); \}/);
    });
});

describe('stakeDataOk round trip through SQLite', () => {
    const dirs = [];
    after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
    function freshDb() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-stake0-'));
        dirs.push(dir);
        db.initDb(dir, false, { awaitMigrator: false });
    }
    test('false survives the write and read', () => {
        freshDb();
        db.replaceValidators([{ address: V1, name: 'a', totalStake: 0, commission: 95, ...apyFields(95) }],
            { totalCount: 1, lastSync: 1, status: 'Degraded', stakeDataOk: false });
        const out = db.getValidators();
        assert.equal(out.stakeDataOk, false);
        assert.equal(out.status, 'Degraded');
    });
    test('absent reads back as true (rows written before the guard)', () => {
        freshDb();
        db.replaceValidators([{ address: V1, name: 'a', totalStake: 10, commission: 5, ...apyFields(5) }],
            { totalCount: 1, lastSync: 1, status: 'Synced' });
        assert.equal(db.getValidators().stakeDataOk, true);
    });
});
