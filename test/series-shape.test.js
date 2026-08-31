// lib/series-shape.js — and the bug it exists because of.
//
// The F-081 cache guard was written as `Array.isArray(cached.series)`.
// getDailyAnalytics returns an OBJECT of named series, not an array, so the
// guard was false for every response ever produced: the cache-hit branch was
// unreachable, the pre-warm was never served, and every request ran the live
// aggregate. My unit test passed because I wrote it from the same wrong
// assumption about the shape.
//
// So the load-bearing test here is the LAST one: it calls the real
// getDailyAnalytics against a real database and feeds the actual return value
// to the predicate. A test that asserts a shape it invented can only confirm
// the author's belief; one that asks the producer cannot.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from '../db.js';
import { hasSeriesData } from '../lib/series-shape.js';
import { readRepo, stripComments } from './helpers/source.js';

describe('hasSeriesData — shapes', () => {
    test('an object of named series with data is non-empty', () => {
        // The actual production shape.
        assert.equal(hasSeriesData({
            txCount: [{ day: '2026-08-01', value: 2 }],
            txVolume: [], blocks: [], avgExtrinsics: [],
            activeAddresses: [], treasuryAwarded: []
        }), true);
    });

    test('an object whose every member is empty is EMPTY', () => {
        // This is the genuine F-081 case — pre-warmed before the indexer wrote
        // a row. It must not be served as an answer or cached at the edge.
        assert.equal(hasSeriesData({
            txCount: [], txVolume: [], blocks: [],
            avgExtrinsics: [], activeAddresses: [], treasuryAwarded: []
        }), false);
    });

    test('a bare array still works both ways', () => {
        assert.equal(hasSeriesData([{ day: 'x', value: 1 }]), true);
        assert.equal(hasSeriesData([]), false);
    });

    test('data in ANY member counts', () => {
        // The chart draws six series; one populated is enough to be an answer.
        for (const key of ['txCount', 'txVolume', 'blocks', 'avgExtrinsics',
                           'activeAddresses', 'treasuryAwarded']) {
            const s = {
                txCount: [], txVolume: [], blocks: [],
                avgExtrinsics: [], activeAddresses: [], treasuryAwarded: []
            };
            s[key] = [{ day: 'd', value: 1 }];
            assert.equal(hasSeriesData(s), true, `${key} alone was not enough`);
        }
    });

    test('junk is empty, not a throw', () => {
        for (const v of [null, undefined, 0, '', 'nope', 42, true, NaN]) {
            assert.doesNotThrow(() => hasSeriesData(v), `threw on ${String(v)}`);
            assert.equal(hasSeriesData(v), false, `${String(v)} counted as data`);
        }
        assert.equal(hasSeriesData({}), false);
    });

    test('non-array members do not count as data', () => {
        // A malformed cache entry must read as "no answer", not as an answer.
        assert.equal(hasSeriesData({ txCount: 5, blocks: 'lots' }), false);
        assert.equal(hasSeriesData({ txCount: { day: 'x' } }), false);
    });
});

describe('the handler uses it on BOTH paths', () => {
    const server = stripComments(readRepo('server.js', import.meta.url));
    const fn = (() => {
        const i = server.indexOf("app.get('/api/analytics/timeseries'");
        const next = server.indexOf("app.get('", i + 10);
        return server.slice(i, next === -1 ? undefined : next);
    })();

    test('the cache-hit guard is shape-agnostic', () => {
        assert.ok(!/Array\.isArray\(cached\.series\)/.test(fn),
            'the guard assumes an array again — the cache-hit branch becomes unreachable and every request re-derives');
        assert.match(fn, /if \(cached && hasSeriesData\(cached\.series\)\)/);
    });

    test('the fallthrough reuses a populated cache instead of re-deriving', () => {
        assert.match(fn, /hasSeriesData\(cached\.series\)\) \? cached\.series : db\.getDailyAnalytics/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The one that would have caught it
// ─────────────────────────────────────────────────────────────────────────────

describe('against the REAL producer', () => {
    let dir;
    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-series-'));
        db.initDb(dir, true);
    });
    after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

    test('an EMPTY database produces a series the predicate calls empty', () => {
        const series = db.getDailyAnalytics(0);
        assert.equal(hasSeriesData(series), false,
            'an all-empty series reads as data — F-081 is back');
    });

    test('a POPULATED database produces one the predicate calls non-empty', () => {
        // The assertion the original test should have made. Note the return is
        // an object, not an array — the whole bug in one line.
        const raw = new DatabaseSync(path.join(dir, 'explorer.db'));
        raw.exec('BEGIN IMMEDIATE');
        const ts = Date.now() - 2 * 86400000;
        raw.prepare('INSERT OR IGNORE INTO blocks(number,hash,timestamp,extrinsics_count) VALUES(?,?,?,?)')
           .run(1, '0x' + '1'.repeat(64), ts, 2);
        raw.exec('COMMIT');
        raw.close();

        const series = db.getDailyAnalytics(0);
        assert.ok(!Array.isArray(series),
            'getDailyAnalytics returns an ARRAY now — the original guard would have been right and this module is unnecessary');
        assert.equal(typeof series, 'object');
        assert.equal(hasSeriesData(series), true,
            'real data reads as empty — the pre-warm will never be served');
    });

    test('the shape is the six named series the chart expects', () => {
        // Pins the contract the predicate depends on. If a series is renamed or
        // removed, this fails here rather than silently in the guard.
        const series = db.getDailyAnalytics(0);
        assert.deepEqual(Object.keys(series).sort(), [
            'activeAddresses', 'avgExtrinsics', 'blocks',
            'treasuryAwarded', 'txCount', 'txVolume'
        ]);
        for (const [k, v] of Object.entries(series)) {
            assert.ok(Array.isArray(v), `${k} is not an array — the predicate would ignore it`);
        }
    });
});
