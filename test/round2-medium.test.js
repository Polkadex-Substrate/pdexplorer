// Audit F-184 / F-185 / F-186 / F-187 / F-188 (round 2).
//
// Common thread across four of these five: something that LOOKED like it was
// working. A health endpoint that always answered 200. A merge whose close test
// used the same key on both sides so the two key schemes were never exercised
// against each other. A decode cap whose comment claimed the budget was spent
// on matches when it was spent one filter too early. A fork delete whose test
// asserted zero rows deleted, so the missing rescan had nothing to be missing
// from. Each had a green check sitting on top of it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeRows, txRank, txIdentity, blockRank } from '../lib/merge-rows.js';
import { stripComments } from './helpers/source.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const serverSrc = read('server.js');
const dbSrc     = read('db.js');
const scriptSrc = read('script.js');
const migSrc    = read('lib/id-migration.js');

// ─────────────────────────────────────────────────────────────────────────────
// F-186 — the merge must recognise the same transfer under two id schemes
// ─────────────────────────────────────────────────────────────────────────────

describe('F-186 — one transfer, two id schemes, one row', () => {
    // The live WS path keys by extrinsic hash; the indexer keys by
    // event-<blockHash>-<index>. The round-1 close test used '0xMINE' on BOTH
    // sides, so it proved id equality works and never touched the real case.
    const liveRow = { hash: '0xEXTRINSICHASH', block: 500, from: 'esA', to: 'esB',
                      amount: '5 PDEX', unconfirmed: true };
    const indexedTwin = { hash: 'event-0xBLOCKHASH-3', block: 500, from: 'esA', to: 'esB',
                          amount: '5 PDEX' };
    const other = { hash: 'event-0xBLOCKHASH-9', block: 499, from: 'esC', to: 'esD',
                    amount: '1 PDEX' };

    const merge = (local, snapshot) => mergeRows({
        local, snapshot, keyOf: t => t.hash, rankOf: txRank, cap: 50, identityOf: txIdentity
    });

    test('the live row does NOT survive alongside its indexed twin', () => {
        const out = merge([liveRow], [indexedTwin, other]);
        assert.equal(out.length, 2, 'the same transfer was rendered twice');
        assert.ok(!out.some(r => r.hash === '0xEXTRINSICHASH'));
    });

    test('without identityOf the duplicate DOES appear — the bug, demonstrated', () => {
        // Pins that identityOf is what fixes it, not some incidental change.
        const out = mergeRows({
            local: [liveRow], snapshot: [indexedTwin, other],
            keyOf: t => t.hash, rankOf: txRank, cap: 50
        });
        assert.equal(out.length, 3, 'expected the un-fixed behaviour for contrast');
    });

    test('a live row the snapshot has NOT caught up to survives', () => {
        // The whole point of F-017. Fixing the duplicate must not reintroduce
        // "the poll erases the row you just watched arrive".
        const fresh = { hash: '0xNEW', block: 501, from: 'esX', to: 'esY',
                        amount: '9 PDEX', unconfirmed: true };
        const out = merge([fresh], [indexedTwin, other]);
        assert.ok(out.some(r => r.hash === '0xNEW'));
    });

    test('unconfirmed rows sort above confirmed ones at the same rank', () => {
        // A live row and its indexed twin share a block height, so without the
        // tiebreak their order was whatever Array.sort happened to do — the row
        // the user just saw arrive could jump around on every 12s poll.
        const sameBlockLive = { hash: '0xLIVE', block: 499, from: 'esQ', to: 'esR',
                                amount: '2 PDEX', unconfirmed: true };
        const out = merge([sameBlockLive], [other]);
        assert.equal(out[0].hash, '0xLIVE');
    });

    test('identity is what the transfer DID, not what it is called', () => {
        assert.equal(txIdentity(liveRow), txIdentity(indexedTwin));
        assert.notEqual(txIdentity(liveRow), txIdentity(other));
    });

    test('an incomplete row has NO identity, and never collapses into another', () => {
        // A null identity matching anything would merge unrelated transfers.
        for (const bad of [null, {}, { block: 1 }, { block: 1, from: 'a' },
                           { block: 1, from: 'a', to: 'b' },
                           { from: 'a', to: 'b', amount: '1' }]) {
            assert.equal(txIdentity(bad), null);
        }
        const noIdentity = { hash: '0xPARTIAL', block: 500, from: 'esA', to: '', amount: '5 PDEX' };
        const out = merge([noIdentity], [indexedTwin]);
        // Falls through to the rank rules rather than being treated as a dup.
        assert.ok(!out.some(r => r.hash === '0xPARTIAL' && r.to === undefined));
    });

    test('identityOf is optional — block merges are unaffected', () => {
        const out = mergeRows({
            local: [{ number: 10, hash: '0xa' }], snapshot: [{ number: 9, hash: '0xb' }],
            keyOf: b => b.number, rankOf: blockRank, cap: 10
        });
        assert.equal(out.length, 2);
    });

    test('both /transactions call sites pass identityOf', () => {
        const sites = (scriptSrc.match(/identityOf: txIdentity/g) || []).length;
        assert.equal(sites, 2, `expected both transaction merges to pass it, found ${sites}`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-184 — a health endpoint that cannot go red is not a health endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('F-184 — /api/health carries its verdict in the status code', () => {
    const route = serverSrc.slice(
        serverSrc.indexOf("app.get('/api/health'"),
        serverSrc.indexOf("app.get('/api/diag/rpc-cache'")
    );

    test('it can return 503', () => {
        // It used to answer 200 unconditionally, so a status-code monitor —
        // the DEFAULT in UptimeRobot, Pingdom and k8s probes — stayed green
        // while `healthy` was false.
        assert.match(route, /res\.status\(healthy \? 200 : 503\)/,
            'the endpoint answers 200 regardless again — no monitor can see a failure');
    });

    test('it checks more than the RPC socket', () => {
        // A keyword monitor watching for "healthy" also stayed green while the
        // node was syncing or the head was stale, because the word was there.
        for (const check of ['rpc', 'database', 'chainAdvancing', 'indexerProgressing']) {
            assert.ok(new RegExp(`${check}:`).test(route), `the ${check} check is gone`);
        }
    });

    test('it names what failed, so the alert body is actionable', () => {
        assert.match(route, /failing: Object\.keys\(checks\)\.filter/);
    });

    test('an unknown chain head is not treated as a failure', () => {
        // A worker that has not seen a head yet is starting, not sick. Flapping
        // red at every deploy is how a monitor gets muted.
        assert.match(route, /lastAdvanceAt \? \(Date\.now\(\) - lastAdvanceAt\) <= CHAIN_HEAD_STALE_MS : true/);
    });

    test('it stays public-safe — no pid, no version, no internal URLs', () => {
        assert.ok(!/process\.pid/.test(route), 'the public probe leaks the pid');
        assert.ok(!/DIAG_TOKEN|diagGate/.test(route), 'the public probe must not be gated');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-185 — never mail a tokenised link that names another host
// ─────────────────────────────────────────────────────────────────────────────

describe('F-185 — SITE_URL must be set before any tokenised mail', () => {
    test('there is an explicit gate, separate from the origin getter', () => {
        assert.match(serverSrc, /function canMintEmailUrls\(\)/);
        assert.match(serverSrc, /String\(process\.env\.SITE_URL \|\| ''\)\.trim\(\) !== ''/);
    });

    test('subscribe refuses with 503 rather than mailing a dead link', () => {
        const route = serverSrc.slice(
            serverSrc.indexOf("app.post('/api/email/subscribe'"),
            serverSrc.indexOf("app.post('/api/email/subscribe'") + 1400
        );
        assert.match(route, /if \(!canMintEmailUrls\(\)\)/);
        assert.match(route, /res\.status\(503\)/);
    });

    test('alert dispatch is gated BEFORE the idempotency reservation', () => {
        // Reserving first would mark the events dispatched, so once SITE_URL
        // was fixed the idempotency table would suppress the mail that should
        // have gone — turning a config mistake into permanently missed alerts.
        // Comments stripped: the comment ABOVE the gate names
        // reserveEmailDispatch to explain the ordering, so a raw indexOf finds
        // the later symbol first and the assertion fails on its own prose.
        // (Fifth instance of this trap here — hence test/helpers/source.js.)
        const fn = stripComments(serverSrc.slice(
            serverSrc.indexOf('async function dispatchToSubscribers('),
            serverSrc.indexOf('async function dispatchToSubscribers(') + 1400
        ));
        const gateAt = fn.indexOf('emailDispatchBlocked');
        const reserveAt = fn.indexOf('reserveEmailDispatch');
        assert.ok(gateAt !== -1 && reserveAt !== -1);
        assert.ok(gateAt < reserveAt, 'the gate runs after events are marked dispatched');
    });

    test('the getter still returns a STRING — no booby-trapped sentinel', () => {
        // A Symbol throws "Cannot convert a Symbol value to a string" from the
        // dozen call sites that interpolate this; a null silently mints
        // "null/email/preferences?token=…". One gate beats a poisoned getter.
        assert.match(serverSrc, /function emailSiteOrigin\(\) \{[\s\S]{0,200}return \(process\.env\.SITE_URL/);
        assert.ok(!/Symbol\('SITE_URL/.test(serverSrc));
    });

    test('SEO URLs keep the production default — they carry no token', () => {
        assert.match(serverSrc, /function siteOriginForSeo\(\)/);
        assert.match(serverSrc, /function siteOrigin\(_req\) \{[\s\S]{0,300}siteOriginForSeo\(\)/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-187 — a fork delete must leave a rescan behind it
// ─────────────────────────────────────────────────────────────────────────────

describe('F-187 — deleting fork rows queues the heights for re-crawl', () => {
    test('the migration exposes an onForkDelete hook', () => {
        assert.match(migSrc, /onForkDelete = null/);
        assert.match(migSrc, /if \(onForkDelete && touched\.length\)/);
    });

    test('the heights are captured BEFORE the delete', () => {
        // Afterwards there is nothing left to identify them by.
        const walk = migSrc.slice(migSrc.indexOf('let touched = []'), migSrc.indexOf('cursor = end + 1'));
        const captureAt = walk.indexOf('SELECT DISTINCT block');
        const deleteAt = walk.indexOf('DELETE FROM events');
        assert.ok(captureAt !== -1 && deleteAt !== -1);
        assert.ok(captureAt < deleteAt, 'the capture runs after the rows are gone');
    });

    test('the callback fires AFTER the commit', () => {
        // Queueing a rescan for a delete that rolled back sends the crawler at
        // healthy heights for nothing.
        const walk = migSrc.slice(migSrc.indexOf('let touched = []'), migSrc.indexOf('cursor = end + 1'));
        assert.ok(walk.indexOf('inTx(dbh') < walk.indexOf('onForkDelete(touched)'));
    });

    test('db.js wires it to recordScanFailure', () => {
        assert.match(dbSrc, /onForkDelete: \(heights\) => \{/);
        assert.match(dbSrc, /recordScanFailure\('chain_index', h,/);
    });

    test('a failure to queue does not fail the migration', () => {
        // Housekeeping must not roll back a completed data fix.
        const block = dbSrc.slice(dbSrc.indexOf('onForkDelete: (heights)'), dbSrc.indexOf('onForkDelete: (heights)') + 900);
        assert.match(block, /catch \(_\) \{ \/\* one height failing must not stop the migration \*\/ \}/);
    });

    test('the capture is bounded', () => {
        assert.match(migSrc, /LIMIT 5000/, 'an unbounded range could build a huge array in memory');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-188 — the decode cap must bound the OUTPUT, not the scan
// ─────────────────────────────────────────────────────────────────────────────

describe('F-188 — a method filter reaches its target', () => {
    const loop = serverSrc.slice(
        serverSrc.indexOf('let decodeBudget = DECODE_MAX_EXTRINSICS'),
        serverSrc.indexOf('let decodeBudget = DECODE_MAX_EXTRINSICS') + 2200
    );

    test('BOTH filters run before the budget is spent', () => {
        // The first fix moved the decrement past ?section= and stopped there,
        // so ?method= still burned budget on non-matching calls: the documented
        // ?method=submit_snapshot came back truncated with an EMPTY list.
        const sectionAt = loop.indexOf('wantSection && norm(section) !== wantSection');
        const methodAt = loop.indexOf('wantMethod && norm(method) !== wantMethod');
        const budgetAt = loop.indexOf('if (decodeBudget <= 0)');
        assert.ok(sectionAt !== -1 && methodAt !== -1 && budgetAt !== -1);
        assert.ok(sectionAt < budgetAt, 'the section filter must precede the budget check');
        assert.ok(methodAt < budgetAt, 'the method filter must precede the budget check — that IS F-188');
    });

    test('a truncated-and-empty response says what IS in the block', () => {
        // Otherwise "no results" is indistinguishable from "your filter is
        // wrong", and the SPA renders "none matched" for a call that is there.
        assert.match(serverSrc, /present: \(decodeTruncated && out\.length === 0\)/);
    });

    test('the present list is bounded', () => {
        assert.match(serverSrc, /\.slice\(0, 100\)/);
    });
});
