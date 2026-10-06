// Council + technical committee motions keyed by (collective, index).
//
// WHAT WAS WRONG (found Oct 2026)
//
// council_motions had PRIMARY KEY hash. The hash is the hash of the CALL, and
// the same call can be proposed again: 11 council motions (#33, #45, #50, #51,
// #59, #60, #68, #89, #117, #119, #123) re-proposed an earlier motion's exact
// call, so their rows merged into the earlier motion's — the explorer showed
// 124 of 135 motions, some with a mix of two motions' data. Separately, motion
// #134's outcome was never recorded (its close block fell in an RPC outage),
// and nothing could notice, because the crawler only knows what it scanned.
//
// These tests pin the replacement: identity by index, outcomes attributed by
// position, a one-time migration that UNDOES the merge, and a locator that
// asks the chain what should exist. Real database where persistence matters.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from '../db.js';
import {
    attributeMotionEvents, findProposalBlock, findCloseBlock, missingIndices, neighbourHints, COLLECTIVES, EVENT_RANK
} from '../lib/collective-motions.js';

const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-cm-'));
    dirs.push(dir);
    db.initDb(dir, false, { awaitMigrator: false });
    return dir;
}
const byIndex = (list) => Object.fromEntries(list.map(m => [m.motionIndex, m]));

describe('attribution: an outcome belongs to the latest same-hash motion proposed before it', () => {
    test('two motions with the same call each get their own outcome, in any insertion order', () => {
        const motions = [
            { motionIndex: 33, hash: '0xH', proposedBlock: 5260125 },
            { motionIndex: 31, hash: '0xH', proposedBlock: 5209227 },
        ];
        const events = [
            { hash: '0xH', block: 5260200, kind: 'executed' },
            { hash: '0xH', block: 5209300, kind: 'closed', ayes: 3, nays: 1 },
            { hash: '0xH', block: 5209300, kind: 'disapproved' },
        ];
        const m = byIndex(attributeMotionEvents(motions, events));
        assert.equal(m[31].status, 'disapproved');
        assert.equal(m[31].ayes, 3);
        assert.equal(m[31].resolvedBlock, 5209300);
        assert.equal(m[33].status, 'executed');
        assert.equal(m[33].resolvedBlock, 5260200);
    });

    test('closed and re-proposed in the SAME block are ordered by event index', () => {
        const motions = [
            { motionIndex: 1, hash: '0xH', proposedBlock: 100, proposedEventIndex: 2 },
            { motionIndex: 2, hash: '0xH', proposedBlock: 200, proposedEventIndex: 5 },
        ];
        const events = [{ hash: '0xH', block: 200, eventIndex: 3, kind: 'executed' }];
        const m = byIndex(attributeMotionEvents(motions, events));
        assert.equal(m[1].status, 'executed', 'the event precedes the re-proposal inside block 200');
        assert.equal(m[2].status, 'proposed');
    });

    test('Executed outranks Approved outranks Closed; the tally comes from Closed', () => {
        const m = attributeMotionEvents(
            [{ motionIndex: 7, hash: '0xA', proposedBlock: 10 }],
            [{ hash: '0xA', block: 20, kind: 'executed' }, { hash: '0xA', block: 20, kind: 'approved' },
             { hash: '0xA', block: 20, kind: 'closed', ayes: 4, nays: 0 }])[0];
        assert.equal(m.status, 'executed');
        assert.deepEqual([m.ayes, m.nays], [4, 0]);
        assert.ok(EVENT_RANK.executed > EVENT_RANK.approved && EVENT_RANK.approved > EVENT_RANK.closed);
    });

    test('an event with no matching motion is ignored (MemberExecuted / other collective)', () => {
        const out = attributeMotionEvents([{ motionIndex: 1, hash: '0xA', proposedBlock: 10 }],
            [{ hash: '0xZZ', block: 20, kind: 'executed' }]);
        assert.equal(out[0].status, 'proposed');
    });

    test('no event: proposed, or resolved once it left storage — never an outcome it did not have', () => {
        const out = byIndex(attributeMotionEvents([
            { motionIndex: 1, hash: '0xA', proposedBlock: 10, leftStorageAt: 123 },
            { motionIndex: 2, hash: '0xB', proposedBlock: 11, liveAyes: 2, liveNays: 1 },
        ], []));
        assert.equal(out[1].status, 'resolved');
        assert.equal(out[2].status, 'proposed');
        assert.deepEqual([out[2].ayes, out[2].nays], [2, 1], 'open motions show the live tally');
    });
});

describe('storage round trip (real database)', () => {
    test('council #1 and technical committee #1 never collide', () => {
        freshDb();
        db.upsertCollectiveMotion('council', { motionIndex: 1, hash: '0xA', proposedBlock: 10 });
        db.upsertCollectiveMotion('technicalCommittee', { motionIndex: 1, hash: '0xA', proposedBlock: 10 });
        db.insertCollectiveMotionEvent('technicalCommittee', { hash: '0xA', block: 12, kind: 'executed' });
        assert.equal(db.getCouncilMotions()[0].status, 'proposed');
        assert.equal(db.getCollectiveMotions('technicalCommittee')[0].status, 'executed');
    });

    test('a re-proposal of the same call is a SECOND motion, not an overwrite', () => {
        freshDb();
        db.upsertCollectiveMotion('council', { motionIndex: 31, hash: '0xH', proposer: 'esA', proposedBlock: 5209227 });
        db.upsertCollectiveMotion('council', { motionIndex: 33, hash: '0xH', proposer: 'esB', proposedBlock: 5260125 });
        const m = byIndex(db.getCouncilMotions());
        assert.equal(db.countCouncilMotions(), 2);
        assert.equal(m[31].proposer, 'esA');
        assert.equal(m[33].proposer, 'esB');
    });

    test('live and crawler writes enrich each other instead of erasing', () => {
        freshDb();
        db.upsertCollectiveMotion('council', { motionIndex: 5, hash: '0xA', liveAyes: 2, liveNays: 0 }, { open: true });
        db.upsertCollectiveMotion('council', { motionIndex: 5, hash: '0xA', proposer: 'esP', proposedBlock: 900, proposedAt: 1 });
        const [m] = db.getCouncilMotions();
        assert.equal(m.proposer, 'esP');
        assert.equal(m.proposedBlock, 900);
        assert.equal(m.ayes, 2);
    });

    test('…in the other order too: a live tick after the crawler keeps the crawled fields', () => {
        // The live sync runs every few minutes for open motions and knows no
        // proposer or proposal block; it must not erase what the crawler wrote.
        freshDb();
        db.upsertCollectiveMotion('council', { motionIndex: 6, hash: '0xB', proposer: 'esP', proposerName: 'Pat', proposedBlock: 901, proposedAt: 5 });
        db.upsertCollectiveMotion('council', { motionIndex: 6, hash: '0xB', liveAyes: 1, liveNays: 1 }, { open: true });
        const [m] = db.getCouncilMotions();
        assert.deepEqual([m.proposer, m.proposerName, m.proposedBlock, m.proposedAt], ['esP', 'Pat', 901, 5]);
    });

    test('a motion known only from the live sync (no proposal block yet) still gets its outcome', () => {
        freshDb();
        db.upsertCollectiveMotion('technicalCommittee', { motionIndex: 9, hash: '0xC' }, { open: true });
        db.insertCollectiveMotionEvent('technicalCommittee', { hash: '0xC', block: 50, kind: 'approved' });
        assert.equal(db.getCollectiveMotions('technicalCommittee')[0].status, 'approved');
    });

    test('rejects rows without a usable index or hash', () => {
        freshDb();
        assert.equal(db.upsertCollectiveMotion('council', { motionIndex: null, hash: '0xA' }), false);
        assert.equal(db.upsertCollectiveMotion('council', { motionIndex: 3 }), false);
        assert.equal(db.insertCollectiveMotionEvent('council', { hash: '0xA', block: 1, kind: 'memberexecuted' }), false);
        assert.equal(db.countCouncilMotions(), 0);
    });
});

describe('one-time migration from the hash-keyed table undoes the merge', () => {
    // The legacy OUTCOME fields of a merged row are not trustworthy: status took
    // the highest rank across both motions, while the resolved block and tally
    // took whichever event was written last. A review reproduced the damage of
    // trusting them: #31 disapproved at 1100 + #33 executed at 2100 merged into
    // "executed at 1100", which a synthetic event then pinned on #31 for good.
    // So the migration moves only the motions and queues every block it knew
    // about for the real scanner to re-read.
    function legacy(dir, rows) {
        const h = new DatabaseSync(path.join(dir, 'explorer.db'));
        const ins = h.prepare(`INSERT INTO council_motions (hash, motion_index, proposer, status, ayes, nays,
            proposed_block, resolved_block, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`);
        for (const r of rows) ins.run(...r);
        h.close();
    }
    const queue = () => db.getScanFailures('governance', 1000, 10).map(r => r.block).sort((a, b) => a - b);

    test('the merged row from the review: no motion inherits the other\'s outcome', () => {
        const dir = freshDb();
        legacy(dir, [['0xH', 31, 'esA', 'executed', 1, 3, 1000, 1100, 7]]);
        const r = db.migrateCouncilMotionsToCollective();
        assert.equal(r.skipped, false);
        assert.deepEqual([r.motions, r.queued, r.unindexed], [1, 2, 0]);
        assert.deepEqual(queue(), [1000, 1100], 'both legacy blocks must be re-read by the real scanner');
        const m31 = db.getCouncilMotions()[0];
        assert.equal(m31.status, 'resolved', 'finished, outcome unknown until re-read — NOT executed');
        assert.equal(m31.proposer, 'esA');

        // What the scanner then records from those blocks and #33's own:
        db.insertCollectiveMotionEvent('council', { hash: '0xH', block: 1100, eventIndex: 1, kind: 'closed', ayes: 1, nays: 3 });
        db.insertCollectiveMotionEvent('council', { hash: '0xH', block: 1100, eventIndex: 2, kind: 'disapproved' });
        db.upsertCollectiveMotion('council', { motionIndex: 33, hash: '0xH', proposedBlock: 2000, proposedEventIndex: 1 });
        db.insertCollectiveMotionEvent('council', { hash: '0xH', block: 2100, eventIndex: 3, kind: 'executed' });
        const m = byIndex(db.getCouncilMotions());
        assert.equal(m[31].status, 'disapproved');
        assert.deepEqual([m[31].ayes, m[31].nays], [1, 3]);
        assert.equal(m[33].status, 'executed');
    });

    test('unindexed rows are skipped, open rows stay open, and it is one-shot', () => {
        const dir = freshDb();
        legacy(dir, [['0xM', null, null, 'executed', null, null, null, 500, 3],
                     ['0xO', 41, 'esB', 'proposed', 2, 0, 6000, null, 4]]);
        const r = db.migrateCouncilMotionsToCollective();
        assert.deepEqual([r.motions, r.unindexed], [1, 1]);
        const [m] = db.getCouncilMotions();
        assert.equal(m.status, 'proposed');
        assert.deepEqual([m.ayes, m.nays], [2, 0]);
        assert.equal(db.migrateCouncilMotionsToCollective().skipped, true);
    });
});

describe('locator: find blocks by bisecting chain state', () => {
    // A fake chain: proposals at these blocks (index = position).
    const proposedAt = [100, 250, 250, 900, 4000, 4001, 9999];
    const countAt = async (b) => proposedAt.filter(p => p <= b).length;

    test('finds every proposal block exactly, with or without hints', async () => {
        for (let i = 0; i < proposedAt.length; i++) {
            assert.equal(await findProposalBlock({ index: i, countAt, head: 20000 }), proposedAt[i], `index ${i}`);
        }
    });

    test('good hints are used; WRONG hints are detected and widened, never trusted', async () => {
        let probes = 0;
        const counting = async (b) => { probes++; return countAt(b); };
        assert.equal(await findProposalBlock({ index: 4, countAt: counting, head: 20000, lo: 900, hi: 4001 }), 4000);
        const withHints = probes; probes = 0;
        assert.equal(await findProposalBlock({ index: 4, countAt: counting, head: 20000 }), 4000);
        assert.ok(withHints < probes, `hints should save probes (${withHints} vs ${probes})`);
        assert.equal(await findProposalBlock({ index: 4, countAt, head: 20000, lo: 5000, hi: 50 }), 4000, 'bad bracket');
    });

    test('a motion the chain does not have yet, or an unreadable node, gives null', async () => {
        assert.equal(await findProposalBlock({ index: 7, countAt, head: 20000 }), null);
        assert.equal(await findProposalBlock({ index: 2, countAt: async () => null, head: 20000 }), null);
    });

    test('close block: first block where the Voting entry is gone', async () => {
        const isOpenAt = async (b) => b >= 500 && b < 731;
        assert.equal(await findCloseBlock({ proposedBlock: 500, isOpenAt, until: 20000 }), 731);
        assert.equal(await findCloseBlock({ proposedBlock: 500, isOpenAt: async () => true, until: 20000 }), null, 'still open');
        assert.equal(await findCloseBlock({ proposedBlock: 500, isOpenAt: async (b) => false, until: 20000 }), 500,
            'proposed and resolved in one block: the proposal block holds the outcome');
    });

    test('missing indices and neighbour hints', () => {
        assert.deepEqual(missingIndices([0, 1, 3, 5], 7), [2, 4, 6]);
        assert.deepEqual(neighbourHints(4, [{ motionIndex: 3, proposedBlock: 90 }, { motionIndex: 6, proposedBlock: 200 },
            { motionIndex: 5, proposedBlock: 150 }, { motionIndex: 1, proposedBlock: 10 }]), { lo: 90, hi: 150 });
    });
});

describe('wiring (source contracts — server.js cannot be imported)', () => {
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    test('both collectives are crawled from the same blocks, keyed by their own pallet', () => {
        assert.deepEqual([...COLLECTIVES], ['council', 'technicalCommittee']);
        assert.match(src, /const collective = ev\.section;/);
        assert.match(src, /collectiveList\.includes\(ev\.section\)/);
        assert.ok(!/ev\.method === 'MemberExecuted'/.test(src), 'MemberExecuted has no motion index and must not create one');
    });

    test('records route to the right table', () => {
        const fn = src.slice(src.indexOf('async function applyGovernanceRecords'), src.indexOf('async function applyGovernanceRecords') + 900);
        assert.match(fn, /m\.type === 'event'\) \{ db\.insertCollectiveMotionEvent\(m\.collective, m\)/);
        assert.match(fn, /db\.upsertCollectiveMotion\(m\.collective, m\)/);
        assert.ok(!/upsertCouncilMotion/.test(src), 'the hash-keyed writer is gone');
    });

    test('the locator runs every governance tick, after the passes, and cannot break the crawl', () => {
        const fn = src.slice(src.indexOf('async function syncGovernance'), src.indexOf('async function syncDemocracy'));
        const locAt = fn.indexOf('await locateMissingMotions(collectives, head)');
        assert.ok(locAt > fn.indexOf('GAP-FILL') || locAt > fn.indexOf('govFailures'), 'locator must run after gap-fill');
        assert.match(fn, /catch \(e\) \{ console\.warn\('\[governance\] motion locator failed \(non-fatal\):'/);
        const loc = src.slice(src.indexOf('async function locateMissingMotions'), src.indexOf('async function scanGovernanceRange'));
        assert.equal((loc.match(/db\.queueOrRearmScanFailure\('governance', block/g) || []).length, 2,
            'both locator paths must re-arm retired rows — a plain queue is a no-op on them (#134, Oct 2026)');
        assert.ok(!/queueScanFailureIfAbsent/.test(loc), 'queue-if-absent is back in the locator');
        assert.ok(!/upsertCollectiveMotion|insertCollectiveMotionEvent/.test(loc), 'the locator only queues; the scanner records');
    });

    test('locator review fixes: rows without a proposal block count as missing; RPC failures back off briefly', () => {
        const loc = src.slice(src.indexOf('async function locateMissingMotions'), src.indexOf('async function scanGovernanceRange'));
        // A motion first seen by the live sync has a row but no proposal block;
        // counting it as "held" left it without proposer/block forever.
        assert.match(loc, /const located = rows\.filter\(r => r\.proposedBlock != null\)\.map\(r => r\.motionIndex\);/);
        assert.match(loc, /missingIndices\(located, count\)/);
        // A search that found nothing must not be parked for a day.
        assert.match(loc, /markRetry\(key\)/);
        assert.ok((loc.match(/markDone\(key\)/g) || []).length === 2, 'only a found block parks a target for the long retry');
        // Closed and re-proposed in one block: the re-proposal block holds the outcome.
        assert.match(loc, /block = until \+ 1/);
    });

    test('technical committee: synced, served, on the calendar', () => {
        assert.match(src, /app\.get\('\/api\/technical-committee'/);
        assert.match(src, /setInterval\(syncTechnicalCommittee, COUNCIL_REFRESH_MS\)/);
        assert.match(src, /db\.getCollectiveMotions\('technicalCommittee'\)\.map/);
        assert.match(src, /'\/council\?tcmotion='/);
    });

    test('council motion emails are keyed by index, not the repeatable hash', () => {
        assert.match(src, /eventIdOf: m => `council:\$\{m\.motionIndex\}`/);
    });
});
