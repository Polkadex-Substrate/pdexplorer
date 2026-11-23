// Stake-aware Est. APY, end to end: what the routes serve from a real SQLite
// database, what the validators list and the validator page render, and a
// guard that no per-validator display goes back to the commission-only figure.
//
// server.js cannot be imported (it starts the app), so the routes are checked
// in two halves, as elsewhere in this suite: the route's data path runs for
// real against a seeded temp database through the same exported functions the
// handler calls, and a source check pins that the handler calls them.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db.js';
import { stripComments, readRepo, bodyOf } from './helpers/source.js';
import {
    NOMINATOR_APY_FIELD, NOMINATOR_APY_METHOD_FIELD, METHOD_PAST_ERAS,
    rewardPerActiveValidator, withNominatorApy, withPerEraNominatorApy, nominatorApyFields, nominatorApyForAddress,
    formatNominatorApy, nominatorApyCaption, compareNominatorApy
} from '../lib/nominator-apy.js';
import { performanceForAll } from '../lib/stake-apr.js';
import { apyFields, estimatedApy, APY_FIELD, MAX_APY_BASE } from '../lib/apy.js';

const server = readRepo('server.js', import.meta.url);
// One route handler: from its app.get line to the first line that closes it.
function routeSrc(route) {
    const start = server.indexOf(route);
    assert.ok(start !== -1, `route not found: ${route}`);
    return server.slice(start, server.indexOf('\n});\n', start) + 4);
}
const script = readRepo('script.js', import.meta.url);

const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-nom-apy-'));
    dirs.push(dir);
    return db.initDb(dir, true, { awaitMigrator: false });
}

// 28 eras, two validators at 5%: one at the average stake, one with 392k.
const ACTIVE_ERA = 100;
const EPY = 365.25;
const R = (MAX_APY_BASE / 100) * 34_500 / EPY;
function seed() {
    const h = freshDb();
    const summaries = [];
    for (let e = 72; e < 100; e++) {
        const validators = { V1: { points: 1000, stake: 34_500, commission: 5 }, V2: { points: 1000, stake: 392_000, commission: 5 } };
        const s = { era: e, reward: 2 * R, totalPoints: 2000, validators };
        db.upsertEraRewardSummary(s);
        summaries.push(s);
    }
    const perf = performanceForAll(summaries, ['V1', 'V2'], { activeEra: ACTIVE_ERA, erasPerYear: EPY });
    db.setKv('validator_choice', {
        activeEra: ACTIVE_ERA, erasPerYear: EPY, rewardPerValidator: rewardPerActiveValidator(summaries, { activeEra: ACTIVE_ERA }),
        validators: [
            { address: 'V1', commission: 5, totalStake: 34_500, perf: perf.V1 },
            { address: 'V2', commission: 5, totalStake: 392_000, perf: perf.V2 }
        ]
    });
    db.replaceValidators([
        { address: 'V1', name: 'one', totalStake: 34_500, commission: 5, ...apyFields(5) },
        { address: 'V2', name: 'two', totalStake: 392_000, commission: 5, ...apyFields(5) }
    ], { totalCount: 2, lastSync: Date.now(), status: 'Synced' });
    return h;
}

describe('/api/validators data path on a seeded database', () => {
    test('the new field differs by stake; the old field keeps its old meaning', () => {
        seed();
        const out = withNominatorApy(db.getValidators().validators, db.getKv('validator_choice'));
        const by = Object.fromEntries(out.map(r => [r.address, r]));
        assert.ok(Math.abs(by.V1[NOMINATOR_APY_FIELD] - estimatedApy(5)) < 1e-9, String(by.V1[NOMINATOR_APY_FIELD]));
        assert.ok(Math.abs(by.V2[NOMINATOR_APY_FIELD] - MAX_APY_BASE * 0.95 * 34_500 / 392_000) < 1e-9, String(by.V2[NOMINATOR_APY_FIELD]));
        assert.equal(by.V2[NOMINATOR_APY_METHOD_FIELD], METHOD_PAST_ERAS);
        assert.equal(by.V1[APY_FIELD], estimatedApy(5));
        assert.equal(by.V2[APY_FIELD], estimatedApy(5), 'estimatedApyAtCurrentCommission is still the commission-only ceiling');
    });

    test('the handler attaches it, and a failure there cannot cost the list', () => {
        const handler = stripComments(routeSrc("app.get('/api/validators',"));
        assert.match(handler, /withNominatorApy\(payload\.validators, nominatorApyInputs\(\)\.snapshot\)/,
            '/api/validators does not attach the stake-aware estimate');
        assert.match(handler, /try \{\s*payload\.validators = withNominatorApy/, 'the enrichment must sit in its own try block');
    });
});

describe('/api/validator/:address data path on a seeded database', () => {
    test('scorecard and per-era rows carry the stake-aware figures; old fields unchanged', () => {
        seed();
        const snap = db.getKv('validator_choice');
        const scorecard = { estimatedApy: estimatedApy(5), ...nominatorApyFields(nominatorApyForAddress(snap, 'V2')) };
        assert.ok(Math.abs(scorecard[NOMINATOR_APY_FIELD] - 1.930549) < 1e-5, String(scorecard[NOMINATOR_APY_FIELD]));
        assert.equal(scorecard.estimatedNominatorApyEras, 28);
        assert.equal(scorecard.estimatedApy, estimatedApy(5));
        const history = withPerEraNominatorApy([{ era: 99, commission: 5, stake: 392_000, apy: estimatedApy(5) }], db.getEraRewardSummaries(0), 'V2', snap.erasPerYear);
        assert.ok(Math.abs(history[0].nominatorApy - 1.930549) < 1e-5);
        assert.equal(history[0].apy, estimatedApy(5));
    });

    test('the handler attaches both, best-effort', () => {
        const handler = stripComments(routeSrc("app.get('/api/validator/:address',"));
        assert.match(handler, /nominatorApyFields\(nominatorApyForAddress\(/, 'scorecard lacks the stake-aware estimate');
        assert.match(handler, /withPerEraNominatorApy\(history, nominatorApySummaries\(\), address/, 'history rows lack the per-era return');
    });

    test('the summaries read uses the era primary key, no scan', () => {
        const h = seed();
        assert.match(server, /db\.getEraRewardSummaries\(0\)/);
        const plan = h.prepare(`EXPLAIN QUERY PLAN ${db.ERA_REWARD_SUMMARIES_SQL}`).all(0).map(r => r.detail);
        assert.ok(plan.some(d => /SEARCH era_reward_summary USING INTEGER PRIMARY KEY \(rowid>\?\)/.test(d)), plan.join(' | '));
        assert.ok(!plan.some(d => /SCAN era_reward_summary|TEMP B-TREE/.test(d)), plan.join(' | '));
    });

    test('the inputs are memoised with a TTL, not read per request', () => {
        const fn = stripComments(bodyOf(server, 'nominatorApyInputs'));
        assert.match(fn, /NOMINATOR_APY_MEMO_MS/);
        assert.match(server, /const NOMINATOR_APY_MEMO_MS = /);
    });
});

describe('the validator snapshot carries the network reward per active validator', () => {
    test('buildChoiceSnapshot stores rewardPerValidator from the stored era summaries', () => {
        const src = stripComments(readRepo('lib/stake-choice-sync.js', import.meta.url));
        assert.match(src, /rewardPerValidator: rewardPerActiveValidator\(summaries, \{ activeEra \}\)/);
    });
});

describe('views', () => {
    const stakingFormatPDEX = n => String(n);
    const scorecardFn = new Function('NOMINATOR_APY_FIELD', 'formatNominatorApy', 'nominatorApyCaption', 'stakingFormatPDEX',
        `${bodyOf(script, 'renderValidatorScorecard')}; return renderValidatorScorecard;`)(NOMINATOR_APY_FIELD, formatNominatorApy, nominatorApyCaption, stakingFormatPDEX);
    const base = { estimatedApy: estimatedApy(5), avgCommission: 5, minCommission: 5, maxCommission: 5, activeEras: 28, totalEras: 28, activeEraRate: 1, currentStake: 392_000, commissionSpikeCount: 0 };

    test('validator page scorecard shows the stake-aware number, not the commission-only one', () => {
        const html = scorecardFn({ ...base, [NOMINATOR_APY_FIELD]: 1.930549, [NOMINATOR_APY_METHOD_FIELD]: METHOD_PAST_ERAS, estimatedNominatorApyEras: 28 });
        assert.match(html, />1\.93%</);
        assert.ok(!html.includes(estimatedApy(5).toFixed(2)), 'the commission-only 21.94% is still on the page');
        assert.match(html, /past 28 eras, after commission, per PDEX staked/);
    });

    test('validator page: no estimate renders the dash, never 0.00% or 21.94%', () => {
        const html = scorecardFn({ ...base, [NOMINATOR_APY_FIELD]: null, [NOMINATOR_APY_METHOD_FIELD]: null });
        const card = html.slice(html.indexOf('Est. APY'), html.indexOf('Est. APY') + 200);
        assert.match(card, />\u2014</);
        assert.ok(!/0\.00%|21\.94%/.test(card), card);
    });

    test('validators list column renders and sorts the stake-aware field', () => {
        const code = stripComments(script);
        const col = code.slice(code.indexOf('key: NOMINATOR_APY_FIELD'), code.indexOf('key: NOMINATOR_APY_FIELD') + 600);
        assert.ok(col.length > 0 && col.includes("label: 'Est. APY'"), 'list column for the stake-aware field is missing');
        assert.match(col, /sort: compareNominatorApy/);
        assert.match(col, /directional: true/);
        assert.match(col, /formatNominatorApy\(row\[NOMINATOR_APY_FIELD\]\)/);
        assert.match(col, /'<span style="color: var\(--text-secondary\);">\u2014<\/span>'/, 'no estimate must render the dash, as before');
        // makeTable hands a directional column the direction instead of reversing, so nulls stay last.
        assert.match(stripComments(bodyOf(script, 'makeTable')), /col\.directional \? \(a, b\) => cmp\(a, b, sortDir\) : cmp/);
        assert.equal(typeof compareNominatorApy, 'function');
    });

    test('validator page history table and chart use the per-era return', () => {
        const code = stripComments(script);
        assert.match(code, /formatNominatorApy\(h\.nominatorApy\) \?\? '\\u2014'/);
        assert.match(code, /chronHistory\.map\(h => h\.nominatorApy \?\? null\)/);
    });
});

// GUARD. Exclusion, not allowlist: scan ALL code of script.js and the two
// validator routes for every way to reach the commission-only figure, and
// exclude only the home page's network-average tile, which is not a
// per-validator display.
describe('guard: no per-validator display uses the commission-only figure', () => {
    const COMMISSION_ONLY = /estimatedApy\(|estimatedApyAtCurrentCommission|\bAPY_FIELD\b|avg30DayApy|realApy|currentApy|scorecard\.estimatedApy\b|\bh\.apy\b|apyFields\(/;
    function offenders(src, excludedFns) {
        let code = src;
        for (const name of excludedFns) code = code.replace(bodyOf(code, name), `/* excluded: ${name} */`);
        return stripComments(code).split('\n')
            .map((line, i) => ({ line: line.trim(), i }))
            .filter(({ line }) => !/^import /.test(line) && COMMISSION_ONLY.test(line));
    }

    test('script.js: only the home network-average tile may use it', () => {
        const bad = offenders(script, ['updateAvgApyCell', 'fetchNetworkInformation']);
        assert.deepEqual(bad.map(b => b.line), [],
            'per-validator UI reads the commission-only APY again, which shows the same Est. APY for every ' +
            'validator at one commission whatever its stake. Use NOMINATOR_APY_FIELD / formatNominatorApy ' +
            `(lib/nominator-apy.js). Offending code:\n  ${bad.map(b => b.line).join('\n  ')}`);
    });

    test('server.js validator routes: neither serves it as the per-validator figure', () => {
        for (const route of ["app.get('/api/validators',", "app.get('/api/validator/:address',"]) {
            const bad = offenders(routeSrc(route), []);
            assert.deepEqual(bad.map(b => b.line), [],
                `${route} computes a per-validator APY from commission alone. Offending code:\n  ${bad.map(b => b.line).join('\n  ')}`);
        }
    });
});
