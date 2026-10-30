// Chain reads behind the stake picker (lib/stake-choice-sync.js), run against a
// fake api shaped like polkadot-js codecs, plus the era summary table round
// trip in db.js. Fixture addresses are placeholders, not real accounts.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db.js';
import {
    readEraSummary, readEraExposures, missingEras, isVerifiedJudgements, registrationFromHuman,
    readIdentityFacts, buildChoiceSnapshot, eraDurationMs, toBool, FALLBACK_MAX_NOMINATIONS, readNominationsQuota
} from '../lib/stake-choice-sync.js';
import { TypeRegistry, Metadata } from '@polkadot/types';
import { loadFixture } from './helpers/extrinsic-builders.js';

const some = (v) => ({ isSome: true, unwrap: () => v });
const none = () => ({ isSome: false, unwrap: () => { throw new Error('none'); } });
const key = (...args) => ({ args: args.map(a => ({ toString: () => String(a) })) });
const formatPDEX = (x) => Number(x);
const commissionPercent = (p) => (p && p.commission != null ? Number(p.commission) : 0);
const c = (n) => ({ toString: () => String(n) });

function fakeApi({ withOverview = true } = {}) {
    const eras = {
        99: {
            reward: 1000,
            points: { total: 10000, individual: new Map([['V1', 500], ['V2', 1000]]) },
            exposures: { V1: { total: 100000, own: 5000, nominatorCount: 300, pageCount: 2 }, V2: { total: 400000, own: 1000, nominatorCount: 5, pageCount: 1 } },
            prefs: { V1: { commission: 10 }, V2: { commission: 0 } }
        }
    };
    const staking = {
        erasValidatorReward: async (e) => (eras[e] ? some(eras[e].reward) : none()),
        erasRewardPoints: async (e) => (eras[e] ? eras[e].points : { total: 0, individual: new Map() }),
        erasValidatorPrefs: { entries: async (e) => Object.entries((eras[e] || {}).prefs || {}).map(([a, p]) => [key(e, a), p]) },
        validators: { entries: async () => [[key('V1'), { commission: 10, blocked: false }], [key('V2'), { commission: 0, blocked: { isTrue: true } }], [key('W1'), { commission: 3, blocked: false }]] },
        nominators: { entries: async () => [[key('N1'), some({ targets: [c('V1'), c('W1')] })], [key('N2'), some({ targets: [c('W1')] })]] },
        validatorSlashInEra: { entries: async () => [[key(95, 'V2'), {}], [key(40, 'V2'), {}]] },
        bonded: async (a) => some(c(a)),
        ledger: async (a) => some({ active: { V1: 5000, V2: 1000, W1: 7000 }[a] || 0 })
    };
    if (withOverview) {
        staking.erasStakersOverview = { entries: async (e) => Object.entries((eras[e] || eras[99]).exposures).map(([a, x]) => [key(e, a), some(x)]) };
    } else {
        staking.erasStakers = { entries: async (e) => Object.entries((eras[e] || {}).exposures || {}).map(([a, x]) => [key(e, a), { total: x.total, own: x.own, others: new Array(x.nominatorCount).fill({}) }]) };
    }
    const identity = {
        superOf: async (a) => (a === 'V2' ? some([c('V1'), {}]) : none()),
        identityOf: async (a) => (a === 'V1' ? some({ toHuman: () => ({ judgements: [['0', 'Reasonable']], info: {} }) }) : none())
    };
    return {
        query: { staking, identity, session: { validators: async () => [c('V1'), c('V2')] } },
        consts: { staking: { sessionsPerEra: c(6), maxExposurePageSize: c(256), historyDepth: c(84) }, babe: { epochDuration: c(1200), expectedBlockTime: c(12000) } }
    };
}

describe('readEraSummary', () => {
    test('reward, points, exposure total and commission per elected validator', async () => {
        const s = await readEraSummary(fakeApi(), 99, { formatPDEX, commissionPercent });
        assert.deepEqual(s, {
            era: 99, reward: 1000, totalPoints: 10000,
            validators: { V1: { points: 500, stake: 100000, commission: 10 }, V2: { points: 1000, stake: 400000, commission: 0 } }
        });
    });
    test('null while the reward is not set, so the era is retried later', async () => {
        assert.equal(await readEraSummary(fakeApi(), 100, { formatPDEX, commissionPercent }), null);
    });
    test('pre-paged runtimes: erasStakers, pages derived from the page size', async () => {
        const x = await readEraExposures(fakeApi({ withOverview: false }), 99, { formatPDEX, pageSize: 256 });
        assert.deepEqual(x.V1, { total: 100000, own: 5000, nominatorCount: 300, pageCount: 2 });
        assert.equal(x.V2.pageCount, 1);
    });
});

describe('helpers', () => {
    test('missingEras walks the completed eras of the history window', () => {
        assert.deepEqual(missingEras(10, 4, [8]), [9, 7, 6]);
        assert.deepEqual(missingEras(2, 84, []), [1, 0]);
    });
    test('judgements: Reasonable and KnownGood count, FeePaid and Erroneous do not', () => {
        assert.ok(isVerifiedJudgements([['0', 'Reasonable']]));
        assert.ok(isVerifiedJudgements([[1, { KnownGood: null }]]));
        assert.ok(!isVerifiedJudgements([['0', { FeePaid: '1' }]]));
        assert.ok(!isVerifiedJudgements([['0', 'Erroneous']]));
        assert.ok(!isVerifiedJudgements(null));
    });
    test('both identityOf shapes', () => {
        assert.deepEqual(registrationFromHuman([{ judgements: [] }, null]), { judgements: [] });
        assert.deepEqual(registrationFromHuman({ judgements: [] }), { judgements: [] });
        assert.equal(registrationFromHuman(null), null);
    });
    test('era length from runtime constants: 6 x 1200 x 12s = 24h', () => {
        assert.equal(eraDurationMs(fakeApi()), 86_400_000);
        assert.equal(eraDurationMs({ consts: {} }), 0);
    });
    test('toBool reads JS and codec booleans', () => {
        assert.equal(toBool(true), true);
        assert.equal(toBool({ isTrue: true }), true);
        assert.equal(toBool({ toJSON: () => false }), false);
        assert.equal(toBool(undefined), false);
    });
    test('identity facts: a sub-identity is verified through its parent, and names the parent', async () => {
        assert.deepEqual(await readIdentityFacts(fakeApi(), 'V2'), { hasIdentity: true, verified: true, parent: 'V1' });
        assert.deepEqual(await readIdentityFacts(fakeApi(), 'W1'), { hasIdentity: false, verified: false, parent: null });
        assert.deepEqual(await readIdentityFacts({ query: {} }, 'W1'), { hasIdentity: false, verified: false, parent: null });
    });
});

describe('nominations quota from the runtime API (staking.maxNominations does not exist on 392)', () => {
    test('the 392 metadata has StakingApi.nominations_quota(balance: u128) -> u32 and no MaxNominations constant', (t) => {
        const fx = loadFixture('metadata-392.json');
        if (!fx || !fx.metadataAtVersion || !fx.metadataAtVersion['15']) { t.skip('metadata-392.json fixture not present'); return; }
        const registry = new TypeRegistry();
        const md = new Metadata(registry, fx.metadataAtVersion['15']);
        registry.setMetadata(md);
        const api = md.asLatest.apis.find(a => a.name.toString() === 'StakingApi');
        assert.ok(api, 'StakingApi missing');
        const m = api.methods.find(x => x.name.toString() === 'nominations_quota');
        assert.ok(m, 'nominations_quota missing');
        assert.deepEqual(m.inputs.map(i => [i.name.toString(), registry.lookup.getTypeDef(i.type).type]), [['balance', 'u128']]);
        assert.equal(registry.lookup.getTypeDef(m.output).type, 'u32');
        const staking = md.asLatest.pallets.find(p => p.name.toString() === 'Staking');
        assert.ok(!staking.constants.some(c => c.name.toString() === 'MaxNominations'));
    });
    test('reads api.call.stakingApi.nominationsQuota with the minimum nominator bond', async () => {
        const seen = [];
        const api = {
            query: { staking: { minNominatorBond: async () => c(7) } },
            call: { stakingApi: { nominationsQuota: async (b) => { seen.push(String(b)); return c(24); } } }
        };
        const warns = [];
        assert.equal(await readNominationsQuota(api, { warn: (m) => warns.push(m) }), 24);
        assert.deepEqual(seen, ['7']);
        assert.equal(warns.length, 0);
    });
    test('falls back to 16 with a warning only when the API is missing or fails', async () => {
        for (const api of [{}, { call: {} }, { call: { stakingApi: { nominationsQuota: async () => { throw new Error('rpc'); } } } },
            { call: { stakingApi: { nominationsQuota: async () => c(0) } } }]) {
            const warns = [];
            assert.equal(await readNominationsQuota(api, { warn: (m) => warns.push(m) }), FALLBACK_MAX_NOMINATIONS);
            assert.equal(warns.length, 1);
        }
    });
});

describe('buildChoiceSnapshot', () => {
    test('maxNominations comes from the runtime API, not a constant', async () => {
        const api = { ...fakeApi(), call: { stakingApi: { nominationsQuota: async () => c(20) } } };
        const snap = await buildChoiceSnapshot({ api, activeEra: 100, summaries: [], formatPDEX, commissionPercent, getName: async () => 'n', warn: () => {} });
        assert.equal(snap.maxNominations, 20);
    });
    test('active and waiting candidates with every field the filters need', async () => {
        const api = fakeApi();
        const summaries = [];
        for (let e = 72; e < 100; e++) summaries.push({ ...(await readEraSummary(api, 99, { formatPDEX, commissionPercent })), era: e });
        const snap = await buildChoiceSnapshot({
            api, activeEra: 100, summaries, formatPDEX, commissionPercent, getName: async (a) => `Name ${a}`, now: 1, warn: () => {}
        });
        assert.equal(snap.maxNominations, FALLBACK_MAX_NOMINATIONS);
        assert.equal(snap.exposurePageSize, 256);
        assert.equal(snap.erasPerYear, 365.25);
        const by = Object.fromEntries(snap.validators.map(v => [v.address, v]));
        assert.deepEqual(Object.keys(by).sort(), ['V1', 'V2', 'W1']);
        assert.equal(by.V1.active, true);
        assert.equal(by.W1.active, false);
        assert.equal(by.V2.blocked, true);
        assert.equal(by.V1.selfStake, 5000);
        assert.equal(by.W1.selfStake, 7000);
        assert.equal(by.V1.exposurePages, 2);
        assert.equal(by.W1.totalStake, null);
        assert.equal(by.W1.backers, 2);
        assert.deepEqual(by.V2.slashEras, [95, 40]);
        assert.equal(by.V2.identity.parent, 'V1');
        assert.equal(by.V1.name, 'Name V1');
        // Worked example from test/stake-apr.test.js: 16.43625 % over 28 eras.
        assert.ok(Math.abs(by.V1.perf['28'].apr - 16.43625) < 1e-9);
        assert.equal(by.W1.perf['28'].status, 'none');
    });
    test('a failing name lookup degrades to Unknown', async () => {
        const snap = await buildChoiceSnapshot({ api: fakeApi(), activeEra: 100, summaries: [], formatPDEX, commissionPercent, getName: () => { throw new Error('rpc'); }, warn: () => {} });
        assert.ok(snap.validators.every(v => v.name === 'Unknown'));
    });
});

describe('era_reward_summary table', () => {
    const dirs = [];
    after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });
    test('upsert, read back from an era, prune below an era', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-era-summary-'));
        dirs.push(dir);
        db.initDb(dir, true, { awaitMigrator: false });
        const v = { V1: { points: 500, stake: 100000, commission: 10 } };
        for (const era of [10, 11, 12]) db.upsertEraRewardSummary({ era, reward: 1000, totalPoints: 10000, validators: v });
        db.upsertEraRewardSummary({ era: 12, reward: 2000, totalPoints: 10000, validators: v });
        assert.deepEqual(db.getEraRewardSummaries(11).map(r => [r.era, r.reward]), [[11, 1000], [12, 2000]]);
        assert.deepEqual(db.getEraRewardSummaries(0)[0].validators, v);
        db.pruneEraRewardSummaries(12);
        assert.deepEqual(db.getEraRewardSummaries(0).map(r => r.era), [12]);
    });
});
