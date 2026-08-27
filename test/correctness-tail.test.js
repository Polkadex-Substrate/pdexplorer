// Audit F-049 / F-052 / F-062 / F-064 / F-068 / F-111 / F-115 / F-125 / F-126.
//
// Two kinds of test here, deliberately separated:
//
//   1. Real behaviour, run against an in-memory SQLite database — the F-052
//      reconcile and the F-115 trigger merge. Both are stateful, both had a
//      "this silently loses data" failure mode, and both are exactly the kind
//      of thing a source grep would pretend to verify without verifying.
//
//   2. Source contracts for the browser-only changes. script.js has no export
//      surface and no DOM harness; see test/escaping.test.js for the reasoning.
//      These are drift checks, and they say so.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const serverSrc = read('server.js');
const scriptSrc = read('script.js');
const dbSrc     = read('db.js');
const htmlSrc   = read('index.html');

// ─────────────────────────────────────────────────────────────────────────────
// F-052 / F-111 — reconciling rows that left chain storage
// ─────────────────────────────────────────────────────────────────────────────

// The reconcile logic re-implemented against a real table, mirroring db.js.
// Importing db.js directly would open the production database file, so the
// SCHEMA and the queries are reproduced here.
//
// A review pointed out that the previous version of this comment CLAIMED the
// re-implementation was pinned against db.js and no such assertion existed —
// and that the local copy silently omitted the trusted-flag guard, the
// early return, and the whole BEGIN IMMEDIATE / ROLLBACK block. A test that
// exercises a simplified copy while advertising that it exercises the real
// thing is worse than no test. The pin is now real: see
// 'the local re-implementation matches db.js' below.
function makeGovDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE treasury_proposals (
            id INTEGER PRIMARY KEY, status TEXT, updated_at INTEGER
        );
        CREATE TABLE council_motions (
            hash TEXT PRIMARY KEY, motion_index INTEGER, status TEXT, updated_at INTEGER
        );
    `);
    return db;
}

function resolveMissingTreasury(db, liveIds) {
    const open = db.prepare(
        "SELECT id FROM treasury_proposals WHERE status IN ('proposed','approved')"
    ).all();
    const live = new Set(liveIds.map(Number));
    const gone = open.filter(r => !live.has(Number(r.id)));
    const upd = db.prepare("UPDATE treasury_proposals SET status = 'resolved', updated_at = ? WHERE id = ?");
    for (const r of gone) upd.run(Date.now(), r.id);
    return gone.length;
}

describe('F-052 — an item missing from live storage stops being open', () => {
    let db;
    before(() => {
        db = makeGovDb();
        const ins = db.prepare('INSERT INTO treasury_proposals(id,status,updated_at) VALUES(?,?,?)');
        ins.run(1, 'proposed', 0);      // still live
        ins.run(2, 'proposed', 0);      // vanished without a resolving event
        ins.run(3, 'approved', 0);      // approved and still queued
        ins.run(4, 'approved', 0);      // approved then paid, event missed
        ins.run(5, 'awarded',  0);      // already resolved properly
        ins.run(6, 'rejected', 0);
    });

    test('only the vanished OPEN rows are closed', () => {
        const closed = resolveMissingTreasury(db, [1, 3]);
        assert.equal(closed, 2, 'expected exactly #2 and #4 to be reconciled');
        const rows = db.prepare('SELECT id,status FROM treasury_proposals ORDER BY id').all();
        assert.deepEqual(rows.map(r => r.status),
            ['proposed', 'resolved', 'approved', 'resolved', 'awarded', 'rejected']);
    });

    test('already-resolved rows are never touched', () => {
        // Reconciling must not overwrite a known outcome with "unknown".
        const before = db.prepare("SELECT status FROM treasury_proposals WHERE id = 5").get();
        resolveMissingTreasury(db, []);
        const after = db.prepare("SELECT status FROM treasury_proposals WHERE id = 5").get();
        assert.equal(after.status, before.status, 'an awarded proposal was downgraded');
    });

    test('it is idempotent', () => {
        // A review catch: this used to run AFTER the test above had already
        // closed every open row, so `first` was 0 and the assertions passed
        // against an implementation that did nothing at all. Build fresh state
        // so the first pass genuinely has work to do.
        const fresh = makeGovDb();
        const ins = fresh.prepare('INSERT INTO treasury_proposals(id,status,updated_at) VALUES(?,?,?)');
        ins.run(10, 'proposed', 0);
        ins.run(11, 'proposed', 0);
        const first = resolveMissingTreasury(fresh, [10]);
        assert.equal(first, 1, 'the first pass must actually close something');
        const second = resolveMissingTreasury(fresh, [10]);
        assert.equal(second, 0, 'a second identical pass must be a no-op');
    });
});

describe('F-052 — the local re-implementation matches db.js', () => {
    // The pin the header promises. If db.js's SQL changes, these fail and the
    // copy above has to be revisited rather than quietly diverging.
    test('the SELECT of open treasury rows is the same predicate', () => {
        assert.match(dbSrc, /SELECT id FROM treasury_proposals WHERE status IN \('proposed','approved'\)/);
    });
    test('the UPDATE writes the resolved status the same way', () => {
        assert.match(dbSrc, /UPDATE treasury_proposals SET status = 'resolved', updated_at = \? WHERE id = \?/);
        assert.match(dbSrc, /UPDATE council_motions SET status = 'resolved', updated_at = \? WHERE hash = \?/);
    });
    test('the council half selects only proposed motions', () => {
        assert.match(dbSrc, /SELECT hash FROM council_motions WHERE status = 'proposed'/);
    });
    test('both functions wrap their writes in a transaction that rolls back', () => {
        // The one part with a real runtime failure mode, and the part the
        // local copy cannot exercise.
        const fns = dbSrc.slice(
            dbSrc.indexOf('export function resolveMissingTreasuryProposals'),
            dbSrc.indexOf('// --- council motions')
        );
        assert.equal((fns.match(/BEGIN IMMEDIATE/g) || []).length, 2);
        assert.equal((fns.match(/ROLLBACK/g) || []).length, 2);
    });
});

describe('F-052 — the council half, which is the one that can lose data', () => {
    // A review catch: the council reconcile was never tested, and it was the
    // half carrying a blocker — its live set is built inside a log-and-continue
    // catch, so an RPC error left it empty and would have closed every open
    // motion permanently.
    function resolveMissingMotions(db, liveHashes) {
        const open = db.prepare("SELECT hash FROM council_motions WHERE status = 'proposed'").all();
        const live = new Set(liveHashes.map(String));
        const gone = open.filter(r => !live.has(String(r.hash)));
        const upd = db.prepare("UPDATE council_motions SET status = 'resolved', updated_at = ? WHERE hash = ?");
        for (const r of gone) upd.run(Date.now(), r.hash);
        return gone.length;
    }

    test('only motions absent from the live set are closed', () => {
        const db = makeGovDb();
        const ins = db.prepare('INSERT INTO council_motions(hash,motion_index,status,updated_at) VALUES(?,?,?,?)');
        ins.run('0xaa', 1, 'proposed', 0);
        ins.run('0xbb', 2, 'proposed', 0);
        ins.run('0xcc', 3, 'executed', 0);
        assert.equal(resolveMissingMotions(db, ['0xaa']), 1);
        const rows = db.prepare('SELECT hash,status FROM council_motions ORDER BY motion_index').all();
        assert.deepEqual(rows.map(r => r.status), ['proposed', 'resolved', 'executed']);
    });

    test('an EMPTY live set would close everything — hence the trusted flag', () => {
        // This is the blocker, reproduced. The protection is not in this
        // function; it is that the caller must prove the set is complete.
        const db = makeGovDb();
        const ins = db.prepare('INSERT INTO council_motions(hash,motion_index,status,updated_at) VALUES(?,?,?,?)');
        ins.run('0xaa', 1, 'proposed', 0);
        ins.run('0xbb', 2, 'proposed', 0);
        assert.equal(resolveMissingMotions(db, []), 2,
            'sanity: an empty live set really does close every open motion');
    });

    test('db.js REFUSES to run without trusted:true', () => {
        assert.match(dbSrc, /export function resolveMissingCouncilMotions\(liveHashes, \{ trusted = false \} = \{\}\)/);
        assert.match(dbSrc, /export function resolveMissingTreasuryProposals\(liveIds, \{ trusted = false \} = \{\}\)/);
        const fns = dbSrc.slice(
            dbSrc.indexOf('export function resolveMissingTreasuryProposals'),
            dbSrc.indexOf('// --- council motions')
        );
        assert.equal((fns.match(/if \(!trusted\)/g) || []).length, 2,
            'a precondition that is only a comment is not a precondition');
    });

    test('the council caller only trusts the set after a clean walk', () => {
        const fn = serverSrc.slice(
            serverSrc.indexOf('async function syncCouncil'),
            serverSrc.indexOf('// --- Governance history crawler')
        );
        assert.match(fn, /let motionsTrusted = false/);
        // Set INSIDE the try, after the sort — not before the loop.
        const trustAt = fn.indexOf('motionsTrusted = true');
        const catchAt = fn.indexOf("catch (e) { console.warn('Council motions skipped:");
        assert.ok(trustAt !== -1 && catchAt !== -1);
        assert.ok(trustAt < catchAt, 'the flag must be set inside the try it protects');
        assert.match(fn, /if \(!motionsTrusted\)/, 'the reconcile is not gated');
        assert.match(fn, /if \(motionsTrusted\) reconcileMotionThreads\(motions\)/,
            'thread reconciliation has the same empty-set hazard and must share the gate');
    });
});

describe('F-052 — the status ranks let resolved be upgraded, never downgraded', () => {
    // Extract the rank tables from db.js and reason about them directly. This
    // ordering is the whole mechanism: get it wrong and either the reconcile
    // cannot write (rank too low) or a real outcome can be overwritten by
    // "unknown" (rank too high).
    function rankTable(name) {
        const line = dbSrc.split('\n').find(l => l.includes(`const ${name} =`));
        assert.ok(line, `${name} not found in db.js`);
        return JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1)
            .replace(/(\w+):/g, '"$1":'));
    }

    test('treasury: proposed < approved < resolved < awarded = rejected', () => {
        const r = rankTable('TREASURY_STATUS_RANK');
        assert.ok(r.proposed < r.approved, 'approved must beat proposed');
        assert.ok(r.approved < r.resolved,
            'the reconcile writes resolved over approved — it must outrank it or the write is dropped');
        assert.ok(r.resolved < r.awarded && r.resolved < r.rejected,
            'a real outcome must be able to replace the unknown one');
        assert.equal(r.awarded, r.rejected, 'the two terminal outcomes are peers');
    });

    test('motions: proposed < resolved < closed < approved = disapproved < executed', () => {
        const r = rankTable('MOTION_STATUS_RANK');
        assert.ok(r.proposed < r.resolved);
        assert.ok(r.resolved < r.closed);
        assert.ok(r.closed < r.approved && r.approved === r.disapproved);
        assert.ok(r.approved < r.executed);
    });
});

describe('F-052 — the reconcile is only called with a trusted live set', () => {
    test('treasury reconciles AFTER the live upserts, inside the success path', () => {
        const fn = serverSrc.slice(
            serverSrc.indexOf('async function syncTreasury'),
            serverSrc.indexOf('async function syncCouncil')
        );
        assert.ok(fn.length > 0);
        const upsertAt = fn.indexOf('db.upsertTreasuryProposal(');
        const reconcileAt = fn.indexOf('db.resolveMissingTreasuryProposals(');
        const catchAt = fn.indexOf('logSyncError(\'Treasury sync\'');
        assert.ok(upsertAt !== -1 && reconcileAt !== -1 && catchAt !== -1);
        assert.ok(upsertAt < reconcileAt, 'reconcile must see the freshly-upserted rows');
        assert.ok(reconcileAt < catchAt,
            'reconcile must be inside the try — a failed sync must not close everything');
    });

    test('council likewise', () => {
        const fn = serverSrc.slice(
            serverSrc.indexOf('async function syncCouncil'),
            serverSrc.indexOf('// --- Governance history crawler')
        );
        const upsertAt = fn.indexOf('db.upsertCouncilMotion(');
        const reconcileAt = fn.indexOf('db.resolveMissingCouncilMotions(');
        assert.ok(upsertAt !== -1 && reconcileAt !== -1 && upsertAt < reconcileAt);
    });

    test('a reconcile failure is non-fatal to the sync', () => {
        // Closing out stale rows is housekeeping. If it throws, the sync that
        // actually keeps the site current must still finish.
        assert.match(serverSrc, /Treasury reconcile failed \(non-fatal\)/);
        assert.match(serverSrc, /Council reconcile failed \(non-fatal\)/);
    });
});

describe('F-111 — approved-but-unpaid treasury is ACTIVE on the calendar', () => {
    const calendar = serverSrc.slice(
        serverSrc.indexOf('// Treasury proposals — proposed_at'),
        serverSrc.indexOf('// Council motions — similar to treasury')
    );

    test('approved counts as active', () => {
        assert.match(calendar, /p\.status === 'approved'/,
            'approved treasury is inactive again — that IS F-111');
    });

    test('the resolved status introduced by F-052 does NOT count as active', () => {
        // The two findings pull in opposite directions; this pins both at once.
        const expr = calendar.slice(calendar.indexOf('const isActive'), calendar.indexOf('\n', calendar.indexOf('const isActive')));
        assert.ok(!expr.includes("'resolved'"), 'resolved must not be listed as active');
    });

    test('motions treat only proposed as active', () => {
        const m = serverSrc.slice(
            serverSrc.indexOf('// Council motions — similar to treasury'),
            serverSrc.indexOf('// Sort: most recently-active first')
        );
        assert.match(m, /const isActive = !m\.status \|\| m\.status === 'proposed'/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-115 — commission triggers outlive the 30-era scan window
// ─────────────────────────────────────────────────────────────────────────────

describe('F-115 — merging triggers instead of replacing them', () => {
    function makeTriggerDb() {
        const db = new DatabaseSync(':memory:');
        db.exec(`CREATE TABLE validator_triggers (
            address TEXT, era INTEGER, prev_commission REAL, new_commission REAL,
            timestamp INTEGER, PRIMARY KEY (address, era)
        )`);
        return db;
    }
    const merge = (db, addr, triggers) => {
        const stmt = db.prepare('INSERT OR REPLACE INTO validator_triggers(address,era,prev_commission,new_commission,timestamp) VALUES(?,?,?,?,?)');
        for (const t of triggers) stmt.run(addr, t.era, t.prevCommission, t.newCommission, t.timestamp);
    };
    const replace = (db, addr, triggers) => {
        db.prepare('DELETE FROM validator_triggers WHERE address = ?').run(addr);
        merge(db, addr, triggers);
    };

    test('the OLD behaviour loses an out-of-window trigger (the bug, reproduced)', () => {
        const db = makeTriggerDb();
        replace(db, 'esV', [{ era: 100, prevCommission: 10, newCommission: 90, timestamp: 1 }]);
        // Next sync only scanned eras 120-150; era 100 is not in its output.
        replace(db, 'esV', [{ era: 140, prevCommission: 20, newCommission: 80, timestamp: 2 }]);
        const rows = db.prepare('SELECT era FROM validator_triggers WHERE address = ?').all('esV');
        assert.deepEqual(rows.map(r => r.era), [140],
            'sanity: the old replace-everything really did erase era 100');
    });

    test('merging keeps it', () => {
        const db = makeTriggerDb();
        merge(db, 'esV', [{ era: 100, prevCommission: 10, newCommission: 90, timestamp: 1 }]);
        merge(db, 'esV', [{ era: 140, prevCommission: 20, newCommission: 80, timestamp: 2 }]);
        const rows = db.prepare('SELECT era FROM validator_triggers WHERE address = ? ORDER BY era').all('esV');
        assert.deepEqual(rows.map(r => r.era), [100, 140]);
    });

    test('re-deriving the same era is idempotent, not duplicated', () => {
        const db = makeTriggerDb();
        const t = { era: 100, prevCommission: 10, newCommission: 90, timestamp: 1 };
        merge(db, 'esV', [t]);
        merge(db, 'esV', [t]);
        const n = db.prepare('SELECT COUNT(*) AS c FROM validator_triggers WHERE address = ?').get('esV');
        assert.equal(n.c, 1, 'the (address, era) key must collapse a re-derivation');
    });

    test('server.js derives from the STORED history, not the scanned window', () => {
        assert.match(serverSrc, /db\.getValidatorHistory\(address\)/);
        assert.match(serverSrc, /db\.mergeValidatorTriggers\(address/);
        // The windowed replace at these two call sites is what F-115 names.
        const scan = serverSrc.slice(0, serverSrc.indexOf('function getCommissionTriggers'));
        assert.ok(!/db\.replaceValidatorTriggers\(address, getCommissionTriggers\(rows\)\)/.test(scan),
            'the windowed replace is back — that IS F-115');
    });
});

describe('F-115 — the scorecard no longer calls commission spikes "slashes"', () => {
    test('the API exposes commissionSpikeCount', () => {
        assert.match(serverSrc, /commissionSpikeCount:/);
    });

    test('the frontend renders the honest label', () => {
        assert.match(scriptSrc, /Commission spikes/);
        assert.ok(!/<div class="label">Slash history<\/div>/.test(scriptSrc),
            'the "Slash history" card is back — it never counted slashes');
    });

    test('the frontend prefers the new field but tolerates the old one', () => {
        // A cached bundle during the deploy window must not render "undefined".
        assert.match(scriptSrc, /scorecard\.commissionSpikeCount \?\? scorecard\.slashCount \?\? 0/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-049 — one transfer, one row
// ─────────────────────────────────────────────────────────────────────────────

describe('F-049 — the extrinsic-hash-keyed row builder is gone', () => {
    test('nothing constructs a transfer row keyed by ex.hash', () => {
        assert.ok(!/function buildFinancialTransaction\(ex,/.test(serverSrc),
            'the second id scheme is back — that IS F-049');
    });

    test('the event-derived builder is the only writer', () => {
        assert.match(serverSrc, /function buildFinancialTransactionFromEvent\(/);
        const calls = serverSrc.match(/buildFinancialTransaction\w*\(/g) || [];
        const nonEvent = calls.filter(c => !c.includes('FromEvent'));
        assert.deepEqual(nonEvent, [],
            `something calls an extrinsic-keyed builder: ${nonEvent.join(', ')}`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-064 — the live WebSocket path stops inventing data
// ─────────────────────────────────────────────────────────────────────────────

describe('F-064 — live rows carry what the chain said, or null', () => {
    const fn = scriptSrc.slice(
        scriptSrc.indexOf('function subscribeNewBlocks(api)'),
        scriptSrc.indexOf('function readBlockTimestamp(')
    );

    test('the timestamp comes from the block, not the browser clock', () => {
        assert.ok(!/timestamp: Date\.now\(\)/.test(fn),
            'Date.now() is back on live rows — that IS F-064');
        assert.match(fn, /const blockTimestamp = readBlockTimestamp\(signedBlock\)/);
    });

    test('readBlockTimestamp reads the timestamp.set inherent', () => {
        const helper = scriptSrc.slice(
            scriptSrc.indexOf('function readBlockTimestamp('),
            scriptSrc.indexOf('function extrinsicOutcomes(')
        );
        assert.match(helper, /section === 'timestamp'/);
        assert.match(helper, /method === 'set'/);
        assert.match(helper, /return null/, 'an unreadable timestamp must be null, not a guess');
    });

    test('the event count is read, never defaulted to zero', () => {
        assert.ok(!/events: 0/.test(fn), 'events: 0 is back — no block has zero events');
        assert.ok(!/eventsCount: 0/.test(fn));
        assert.match(fn, /const eventsCount = events \? events\.length : null/);
    });

    test('the author is null rather than a fabricated "Validator 0x…" label', () => {
        assert.ok(!/"Validator " \+/.test(fn),
            'the pre-runtime digest is being rendered as an author again — it names no account');
        assert.match(fn, /author: null/);
        assert.match(fn, /authorName: null/);
    });

    test('transfer status comes from the dispatch events', () => {
        assert.ok(!/status: 'success'/.test(fn), "status: 'success' is hardcoded again");
        assert.match(fn, /outcomes \? \(outcomes\[exIndex\] \|\| 'unknown'\) : 'unknown'/);
    });

    test('extrinsicOutcomes distinguishes "could not read" from "no outcome"', () => {
        const helper = scriptSrc.slice(
            scriptSrc.indexOf('function extrinsicOutcomes('),
            scriptSrc.indexOf('function extrinsicOutcomes(') + 1200
        );
        assert.match(helper, /if \(!events\) return null/,
            'a failed events query must return null, not an empty array that reads as "all failed"');
        assert.match(helper, /ExtrinsicSuccess/);
        assert.match(helper, /ExtrinsicFailed/);
    });

    test('live rows are flagged and badged', () => {
        assert.match(fn, /unconfirmed: true/);
        assert.match(scriptSrc, /function liveBadge\(\)/);
        assert.match(scriptSrc, /block\.unconfirmed \? liveBadge\(\)/);
        assert.match(scriptSrc, /tx\.unconfirmed \? liveBadge\(\)/);
    });

    test("'unknown' is not painted as success, and is filterable", () => {
        // A review catch: F-064's third status hit two independent copies of
        // `status === 'failed' ? error : success`, so an unverified transfer
        // rendered success-GREEN — the exact lie F-064 exists to stop, wearing
        // a different label — and neither filter option could select it.
        const badge = scriptSrc.slice(
            scriptSrc.indexOf('function statusBadge(status'),
            scriptSrc.indexOf('function liveBadge()')
        );
        assert.ok(badge.length > 0, 'statusBadge is gone');
        // The colour decision funnels through one `key`, which is 'unknown'
        // for anything that is not exactly success or failed. That is the
        // property: no third value can fall into either coloured branch, in
        // EITHER the solid or the soft variant.
        assert.match(badge, /const key = \(st === 'success' \|\| st === 'failed'\) \? st : 'unknown'/,
            'the status is no longer funnelled through an explicit three-way key');
        assert.match(badge, /unknown:\s*'background: rgba\(255, 255, 255/, 'the soft variant needs an unknown style');
        assert.match(badge, /var\(--text-muted\)/, 'the solid variant needs a neutral colour for unknown');
        // And the label must not claim an outcome it does not have.
        assert.match(badge, /st === 'success' \? 'Success' : st === 'failed' \? 'Failed' : st/,
            "an unknown status must render as 'unknown', not as Success or Failed");
    });

    test('every status column goes through statusBadge — no local ternary', () => {
        // The F-045 shape again: two copies of the same colour decision.
        assert.ok(!/status === 'failed' \? 'var\(--error\)' : 'var\(--success\)'/.test(scriptSrc),
            'a table has its own status ternary again; unknown will paint green there');
        // Only DISPATCH-status columns. There are other 'status' columns in
        // this file — rewards are claimed/unclaimed, threads are open/closed,
        // referenda have their own vocabulary — and they legitimately render
        // differently. Identify the dispatch ones by their filter options.
        const columns = [...scriptSrc.matchAll(
            /key: 'status', label: 'Status',[\s\S]{0,600}?options: \[[^\]]*'failed'[^\]]*\][\s\S]{0,400}?format: row => ([^\n]+)/g
        )];
        assert.ok(columns.length >= 2,
            `expected at least 2 dispatch-status columns, found ${columns.length}`);
        for (const m of columns) {
            assert.match(m[1], /statusBadge\(/,
                `a dispatch-status column renders its own badge: ${m[1]}`);
            assert.match(m[0], /options: \['success', 'failed', 'unknown'\]/,
                'the filter cannot select unknown rows');
        }
    });

    test('a null count renders as an em dash, not the text "null"', () => {
        assert.match(scriptSrc, /row\.eventsCount == null[\s\S]{0,120}—/);
        assert.match(scriptSrc, /row\.extrinsicsCount == null[\s\S]{0,120}—/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-068 — cached is labelled cached; an unrefreshable dashboard cannot sign
// ─────────────────────────────────────────────────────────────────────────────

describe('F-068 — the wallet dashboard admits when it is not live', () => {
    const fn = scriptSrc.slice(
        scriptSrc.indexOf('async function fetchWalletDashboard(address)'),
        scriptSrc.indexOf('function repaintWalletPriceCard(')
    );

    test('a cache paint shows the banner', () => {
        assert.match(fn, /didPaintFromCache = true;[\s\S]{0,400}showWalletStaleBanner\(root, cached\.savedAt, 'cached'\)/);
    });

    test('a failed refresh over a cache paint shows an error AND disables signing', () => {
        // The original bug: this branch did nothing at all when a cache paint
        // had happened, leaving stale balances with live-looking buttons.
        const failBranch = fn.slice(fn.indexOf('if (!result.ok'), fn.indexOf('latestWallet = result.data'));
        assert.match(failBranch, /showWalletStaleBanner\(root, cached && cached\.savedAt, 'error'/);
        assert.match(failBranch, /disableWalletActions\(/);
    });

    test('the network-error path does the same', () => {
        const catchBranch = fn.slice(fn.indexOf('}).catch(err =>'), fn.indexOf('// Price-history payload'));
        assert.match(catchBranch, /showWalletStaleBanner/);
        assert.match(catchBranch, /disableWalletActions/);
    });

    test('a successful refresh clears the banner', () => {
        assert.match(fn, /clearWalletStaleBanner\(root\)/);
    });

    test('every signing action is covered by the disable', () => {
        const list = scriptSrc.slice(
            scriptSrc.indexOf('const WALLET_ACTION_IDS = ['),
            scriptSrc.indexOf('const WALLET_ACTION_IDS = [') + 300
        );
        for (const id of ['wallet-act-send', 'wallet-act-stake', 'wallet-act-payout',
                          'wallet-act-unstake', 'wallet-act-identity']) {
            assert.ok(list.includes(id), `${id} is not disabled on a failed refresh`);
        }
        const helper = scriptSrc.slice(
            scriptSrc.indexOf('function applyWalletActionBlock()'),
            scriptSrc.indexOf('function applyWalletActionBlock()') + 600
        );
        assert.match(helper, /btn\.title = walletActionsBlockedReason/,
            'a disabled button with no reason is just broken');
    });

    test('the block is STICKY, not a one-shot DOM edit', () => {
        // A review catch: the first version called getElementById five times
        // and stopped. On a late-injecting mobile wallet the buttons did not
        // exist yet, so it was a silent no-op — and the recheck loop then
        // rebuilt them fully armed under the "do not send" banner.
        assert.match(scriptSrc, /let walletActionsBlockedReason = null/);
        assert.match(scriptSrc, /function applyWalletActionBlock\(\)/);
    });

    test('every path that rebuilds the action bar re-applies the block', () => {
        // Find each site that renders the bar, and require applyWalletActionBlock
        // nearby. If a new render path appears without it, this fails.
        const sites = [];
        let i = scriptSrc.indexOf('bindWalletActionHandlers();');
        while (i !== -1) { sites.push(i); i = scriptSrc.indexOf('bindWalletActionHandlers();', i + 1); }
        assert.ok(sites.length >= 2, 'expected at least two action-bar render paths');
        for (const at of sites) {
            const window_ = scriptSrc.slice(at, at + 400);
            assert.match(window_, /applyWalletActionBlock\(\)/,
                `an action-bar render path at offset ${at} does not re-apply the block`);
        }
    });

    test('a successful refresh clears the block', () => {
        assert.match(scriptSrc, /clearWalletActionBlock\(\)/);
    });

    test('the error banner is an alert for assistive tech', () => {
        assert.match(scriptSrc, /mode === 'error' \? 'alert' : 'status'/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-125 — storage failures are handled, not swallowed
// ─────────────────────────────────────────────────────────────────────────────

describe('F-125 — localStorage quota and eviction', () => {
    test('a shared safeSetItem exists and reports failure', () => {
        assert.match(scriptSrc, /function safeSetItem\(key, value/);
        assert.match(scriptSrc, /QuotaExceededError/);
        assert.match(scriptSrc, /NS_ERROR_DOM_QUOTA_REACHED/, 'Firefox spells it differently');
        assert.match(scriptSrc, /err\.code === 22 \|\| err\.code === 1014/);
    });

    test('the warning fires once per session, not per write', () => {
        const helper = scriptSrc.slice(
            scriptSrc.indexOf('function warnStorageUnavailable('),
            scriptSrc.indexOf('function warnStorageUnavailable(') + 700
        );
        assert.match(helper, /if \(storageWarningShown\) return/);
    });

    test('expired wallet snapshots are DELETED on read, not merely ignored', () => {
        const reader = scriptSrc.slice(
            scriptSrc.indexOf('function readWalletCache(address)'),
            scriptSrc.indexOf('function writeWalletCache(address')
        );
        assert.match(reader, /localStorage\.removeItem\(WALLET_CACHE_KEY_PREFIX \+ address\)/,
            'expiry must reclaim the key or the namespace grows forever');
    });

    test('eviction collects keys before deleting them', () => {
        // Removing during a localStorage.key(i) walk shifts the index and
        // silently skips every other entry.
        const evict = scriptSrc.slice(
            scriptSrc.indexOf('function evictExpiredWalletCaches('),
            scriptSrc.indexOf('function evictExpiredWalletCaches(') + 1600
        );
        assert.match(evict, /doomed\.push\(key\)/);
        assert.match(evict, /doomed\.forEach/);
        assert.ok(evict.indexOf('doomed.push') < evict.indexOf('doomed.forEach'));
    });

    test('the address being written is never evicted', () => {
        const evict = scriptSrc.slice(
            scriptSrc.indexOf('function evictExpiredWalletCaches('),
            scriptSrc.indexOf('function evictExpiredWalletCaches(') + 1600
        );
        assert.match(evict, /if \(keepAddress && key === WALLET_CACHE_KEY_PREFIX \+ keepAddress\) continue/);
    });

    test('the watchlist is bounded and drops the oldest entries', () => {
        assert.match(scriptSrc, /WATCHLIST_MAX_ENTRIES/);
        const setter = scriptSrc.slice(
            scriptSrc.indexOf('function setWatchlist(map)'),
            scriptSrc.indexOf('function watchlistKey(')
        );
        assert.match(setter, /addedAt/, 'the cap must evict by age, not by hash order');
        assert.match(setter, /safeSetItem\(/, 'a failed watchlist save is silent again');
    });

    test('no bare empty-catch setItem survives in the cache writers', () => {
        for (const name of ['function writeHomeCache(patch)', 'function writeWalletCache(address']) {
            const fn = scriptSrc.slice(scriptSrc.indexOf(name), scriptSrc.indexOf(name) + 500);
            assert.ok(!/localStorage\.setItem/.test(fn),
                `${name} writes storage directly again instead of via safeSetItem`);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-126 — modal keyboard accessibility
// ─────────────────────────────────────────────────────────────────────────────

describe('F-126 — Escape and focus trap for every modal', () => {
    const layer = scriptSrc.slice(
        scriptSrc.indexOf('function wireModalAccessibility()'),
        scriptSrc.indexOf('function openSendModal()')
    );

    test('the layer is wired at boot', () => {
        assert.match(scriptSrc, /wireModalAccessibility\(\);\s*\/\/ F-126/);
    });

    test('Escape and Tab are both handled', () => {
        assert.match(layer, /e\.key !== 'Escape' && e\.key !== 'Tab'/);
        assert.match(layer, /closeModalElement\(modal\)/);
    });

    test('closing goes through the modal\'s own close control', () => {
        // Setting display:none directly would skip each modal's teardown —
        // trading an accessibility bug for a state-leak bug.
        const closer = scriptSrc.slice(
            scriptSrc.indexOf('function closeModalElement(modal)'),
            scriptSrc.indexOf('function closeModalElement(modal)') + 1400
        );
        assert.match(closer, /data-modal-close/);
        assert.match(closer, /modal-close-btn/);
        assert.match(closer, /btn\.click\(\)/);
    });

    test('focus wraps at both ends', () => {
        assert.match(layer, /e\.shiftKey && active === first/);
        assert.match(layer, /!e\.shiftKey && active === last/);
    });

    test('focus is pulled back in when it has escaped the modal', () => {
        assert.match(layer, /if \(!modal\.contains\(active\)\)/);
    });

    test('the opener is captured BEFORE the modal takes focus', () => {
        // A review catch: capturing inside the MutationObserver callback runs
        // after the open function has already focused a field inside the modal,
        // so the "return here on close" element was itself inside the modal and
        // focusing it did nothing.
        assert.match(layer, /addEventListener\('mousedown'[\s\S]{0,160}modalFocusReturnEl = document\.activeElement[\s\S]{0,40}\}, true\)/,
            'the opener must be captured on a capturing listener, not in the observer');
        const observerPart = layer.slice(layer.indexOf('new MutationObserver'));
        assert.ok(!/modalFocusReturnEl = document\.activeElement/.test(observerPart),
            'the capture is back inside the observer, where it is always too late');
    });

    test('focus is only restored to an element still in the document', () => {
        assert.match(layer, /document\.contains\(modalFocusReturnEl\)/);
    });

    test('there is exactly ONE MutationObserver, scoped to the static modals', () => {
        // The second one watched document.body{childList,subtree} for
        // dynamically-mounted modals. There are none — every .modal is static
        // markup in index.html — so it ran a querySelectorAll over every node
        // the SPA ever inserted, for nothing.
        assert.equal((layer.match(/new MutationObserver/g) || []).length, 1);
        assert.ok(!/observe\(document\.body/.test(layer),
            'a whole-document observer is back; check it has a real payoff first');
    });

    test('the premise of that removal still holds: no modal is built in JS', () => {
        assert.ok(!/class="modal[ "]/.test(scriptSrc),
            'script.js now creates a .modal dynamically — it must be registered with the observer explicitly');
    });

    test('aria-modal is set while open', () => {
        assert.match(layer, /setAttribute\('aria-modal', 'true'\)/);
        assert.match(layer, /setAttribute\('role', 'dialog'\)/);
    });

    test('focus returns to the opener on close', () => {
        assert.match(layer, /modalFocusReturnEl/);
    });

    test('no per-modal Escape handler survives anywhere', () => {
        // A review catch: the first version of this test used an
        // order-sensitive regex and missed a THIRD handler (the onboarding
        // tour) written with its operands the other way round. Match on the
        // shape instead of one spelling of it.
        // Scoped to `.modal` elements: the glossary popover keeps its own
        // Escape handler legitimately, because it is a popover with
        // display:block and the modal layer never sees it.
        const lines = scriptSrc.split('\n')
            .filter(l => l.includes("'Escape'") && /\bmodal\b/.test(l) && /style\.display/.test(l));
        assert.deepEqual(lines.map(l => l.trim()), [],
            `per-modal Escape handlers remain, which is the duplication F-126 is about:\n${lines.join('\n')}`);
    });

    test('the onboarding tour closes through its own handler, not a raw hide', () => {
        // Its button is labelled "Skip tour", so the layer needs the explicit
        // hook — otherwise Escape hides the modal without writing the
        // "seen it" flag and the tour reopens forever.
        assert.match(htmlSrc, /id="close-onboarding-tour-modal" data-modal-close/);
        assert.match(scriptSrc, /querySelector\('\[data-modal-close\], \.modal-close-btn/);
    });

    test('every .modal in index.html has a close control the layer can find', () => {
        const ids = [...htmlSrc.matchAll(/id="([\w-]+)" class="modal"/g)].map(m => m[1]);
        assert.ok(ids.length >= 10, `expected the full modal set, found ${ids.length}`);
        for (const id of ids) {
            const at = htmlSrc.indexOf(`id="${id}"`);
            const block = htmlSrc.slice(at, at + 2000);
            assert.ok(/data-modal-close|modal-close-btn|aria-label="Close"/.test(block),
                `#${id} has no close control the Escape layer can click — it would fall back to a raw hide, skipping teardown`);
        }
    });

    test('every wallet modal specifically uses the standard close button', () => {
        for (const id of ['send-modal', 'stake-modal', 'payout-modal', 'unstake-modal', 'identity-modal']) {
            const block = htmlSrc.slice(htmlSrc.indexOf(`id="${id}"`), htmlSrc.indexOf(`id="${id}"`) + 900);
            assert.ok(block.includes('modal-close-btn'),
                `#${id} has no .modal-close-btn — Escape would fall back to a raw hide`);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-062 — per-route SEO
// ─────────────────────────────────────────────────────────────────────────────

describe('F-062 — googlebot and route-scoped structured data', () => {
    const fn = scriptSrc.slice(
        scriptSrc.indexOf('function updateSeoMeta(mainTarget'),
        scriptSrc.indexOf('function setMetaContent(')
    );

    test('googlebot gets the same directive as robots', () => {
        // Google prefers the more specific tag, so a static "index, follow"
        // googlebot meta overrode every noindex this function set.
        assert.match(fn, /setMetaContent\('name', 'googlebot', robotsValue\)/);
        assert.match(fn, /setMetaContent\('name', 'robots', robotsValue\)/);
    });

    test('the two can never diverge', () => {
        // Both read one variable. A second literal here would reopen F-062.
        const robotsLines = (fn.match(/setMetaContent\('name', '(robots|googlebot)',[^)]*\)/g) || []);
        assert.equal(robotsLines.length, 2);
        robotsLines.forEach(l => assert.ok(l.includes('robotsValue'),
            `a directive is hardcoded rather than shared: ${l}`));
    });

    test('the homepage @graph is disabled away from home', () => {
        assert.match(htmlSrc, /<script type="application\/ld\+json" id="home-jsonld">/);
        assert.match(fn, /mainTarget === 'home'/);
        assert.match(fn, /application\/ld\+json-disabled/);
    });

    test('it is disabled rather than removed, so returning home restores it', () => {
        assert.ok(!/homeLd\.remove\(\)/.test(fn));
    });
});
