// F-044 — what /api/validators ACTUALLY returns, against a real database.
//
// WHY THIS FILE EXISTS, WHICH IS THE WHOLE POINT
//
// The F-044 fix was landed, 1,217 tests passed, seven mutation harnesses killed
// 83 of 83 mutants, and the deployed endpoint still returned exactly the two
// dishonest field names the finding was about. Nothing caught it, because of
// what the tests were pointed at:
//
//   * unit tests asserted apyFields() in isolation — correct, and irrelevant
//   * source tests asserted server.js calls apyFields() — true, and irrelevant
//
// Both were true while the API was wrong, because the payload apyFields() built
// went through a `validators` table with only TWO apy columns. The write
// truncated four keys to two; the read handed back the two survivors. The fix
// had been applied at the layer that BUILDS the object and not at the layer
// that PERSISTS and RETURNS it.
//
// That is the same shape as the finding it was fixing — symptom addressed at
// one layer, mechanism intact at another — and it was caught by querying the
// live endpoint, not by any test here.
//
// So this file asserts the ROUND TRIP: through replaceValidators, into real
// SQLite, back out of getValidators, in the shape an integrator receives.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db.js';
import { APY_FIELD, APY_DEPRECATED_ALIASES, estimatedApy } from '../lib/apy.js';

const dirs = [];
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-apy-'));
    dirs.push(dir);
    db.initDb(dir, false, { awaitMigrator: false });
    return dir;
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

describe('F-044 — the honest APY key survives the database', () => {
    test('getValidators returns the honest key, not just the aliases', () => {
        freshDb();
        db.replaceValidators(
            [{ address: 'eAAA', name: 'one', totalStake: 100, commission: 10, ...apy(10) }],
            { totalCount: 1, lastSync: Date.now(), status: 'Synced' });

        const row = db.getValidators().validators[0];
        assert.ok(APY_FIELD in row,
            `/api/validators does not expose ${APY_FIELD} — the honest name never leaves the DB, ` +
            'which is exactly the state the F-044 fix was believed to have ended');
        assert.equal(row[APY_FIELD], estimatedApy(10));
    });

    test('every deprecated alias is present and equal to it', () => {
        freshDb();
        db.replaceValidators(
            [{ address: 'eBBB', name: 'two', totalStake: 5, commission: 25, ...apy(25) }],
            { totalCount: 1, lastSync: Date.now(), status: 'Synced' });

        const row = db.getValidators().validators[0];
        for (const alias of APY_DEPRECATED_ALIASES) {
            assert.ok(alias in row, `the deprecated alias ${alias} vanished — integrators read undefined`);
            assert.equal(row[alias], row[APY_FIELD],
                `${alias} disagrees with ${APY_FIELD}; two names for one number must not drift`);
        }
    });

    test('a missing APY comes back as null, not 0', () => {
        // `?? 0` on the write turned absent data into 0, which renders as
        // "0.00%" — a validator that looks like it pays nothing, rather than
        // one whose commission failed to load. Same class as estimatedApy(null)
        // returning the full 23.09%: coercing absence into a plausible number.
        freshDb();
        db.replaceValidators(
            [{ address: 'eCCC', name: 'three', totalStake: 1, commission: 0, ...apy(undefined) }],
            { totalCount: 1, lastSync: Date.now(), status: 'Synced' });

        const row = db.getValidators().validators[0];
        assert.equal(row[APY_FIELD], null, 'an absent APY was stored as a number');
        for (const alias of APY_DEPRECATED_ALIASES) assert.equal(row[alias], null);
    });

    test('a 0% commission still yields the full base, not null', () => {
        // The inverse mistake: treating a legitimate 0 as missing.
        freshDb();
        db.replaceValidators(
            [{ address: 'eDDD', name: 'four', totalStake: 1, commission: 0, ...apy(0) }],
            { totalCount: 1, lastSync: Date.now(), status: 'Synced' });
        assert.equal(db.getValidators().validators[0][APY_FIELD], estimatedApy(0));
    });

    test('the other columns still round-trip', () => {
        // The read query was rewritten to alias one column and map the rest;
        // a typo there would silently drop a field.
        freshDb();
        db.replaceValidators(
            [{ address: 'eEEE', name: 'five', totalStake: 4242, commission: 7, ...apy(7) }],
            { totalCount: 1, lastSync: 123, status: 'Synced' });
        const out = db.getValidators();
        const row = out.validators[0];
        assert.equal(row.address, 'eEEE');
        assert.equal(row.name, 'five');
        assert.equal(row.totalStake, 4242);
        assert.equal(row.commission, 7);
        assert.equal(out.status, 'Synced');
        assert.ok(!('error' in out), 'F-084: the indexer exception is leaking on a cached 200 again');
    });

    test('ordering by position is preserved', () => {
        freshDb();
        db.replaceValidators(
            ['eA', 'eB', 'eC'].map((a, i) => ({ address: a, name: a, totalStake: i, commission: i, ...apy(i) })),
            { totalCount: 3, lastSync: 1, status: 'Synced' });
        assert.deepEqual(db.getValidators().validators.map(v => v.address), ['eA', 'eB', 'eC']);
    });
});

// Build the apy fields the way the indexer does, so the test exercises the same
// path rather than a hand-written approximation of it.
function apy(commission) {
    const value = estimatedApy(commission);
    const out = { [APY_FIELD]: value };
    for (const alias of APY_DEPRECATED_ALIASES) out[alias] = value;
    return out;
}
