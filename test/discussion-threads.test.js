// Discussion thread lifecycle (lib/discussion-threads.js): the reconcile that
// opens one thread per public proposal / council motion and closes it when the
// item leaves the chain's active list.
//
// Regression for the 2026-10-22 "the old discussion is lost" report. No code
// path deletes discussion rows (see docs/discussion-recovery-2026-10-22.md), but
// the reconcile closed every thread missing from ONE read of the chain, with no
// check that the read was current, and never reopened a thread afterwards. A
// backend restart that lands on a lagging RPC node behind the load balancer
// therefore locked live discussions for good, labelled "moved to a referendum".
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from '../db.js';
import {
    reconcileThreads, proposalReadTrusted, motionReadTrusted, nextHighWater, AUTO_CLOSE_REASON
} from '../lib/discussion-threads.js';
import { readRepo, stripComments } from './helpers/source.js';

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-disc-threads-')); dirs.push(d); return d; }
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

const prop = (i) => ({ id: `proposal-${i}`, refKey: String(i), title: `Public Proposal #${i}` });
const postCount = () => db.getThreads().reduce((n, t) => n + t.postCount, 0);

before(() => {
    db.initDb(tmp(), true);
    for (const i of [7, 8, 9]) {
        db.createThreadIfMissing({ id: `proposal-${i}`, kind: 'proposal', refKey: String(i), title: `Public Proposal #${i}` });
        db.createPost({ threadId: `proposal-${i}`, author: 'eAlice', content: `about ${i}` });
    }
});

describe('stale chain read (lagging RPC node after a restart)', () => {
    test('an empty proposal list from a node that has not seen our proposals closes nothing', () => {
        // The node reports publicPropCount 5: it has never seen proposal 7, 8 or 9.
        const t = proposalReadTrusted({ publicPropCount: 5, currentBlock: 900, highWater: 0, knownRefKeys: ['7', '8', '9'] });
        reconcileThreads(db, 'proposal', [], { trusted: t.trusted });
        for (const i of [7, 8, 9]) assert.equal(db.getThread(`proposal-${i}`).status, 'open', `proposal-${i} must stay open`);
        assert.equal(postCount(), 3);
        assert.equal(t.trusted, false, 'a node behind our own threads must not be trusted');
    });

    test('a read from a block older than the last trusted read is not trusted', () => {
        const t = proposalReadTrusted({ publicPropCount: 10, currentBlock: 999, highWater: 1000, knownRefKeys: ['7'] });
        assert.equal(t.trusted, false);
        assert.match(t.reason, /behind/);
        assert.equal(motionReadTrusted({ listTrusted: true, currentBlock: 999, highWater: 1000 }).trusted, false);
        assert.equal(motionReadTrusted({ listTrusted: false, currentBlock: 2000, highWater: 1000 }).trusted, false);
        assert.equal(motionReadTrusted({ listTrusted: true, currentBlock: 1000, highWater: 1000 }).trusted, true);
    });

    test('a current read is trusted; a missing publicPropCount falls back to the block check', () => {
        assert.equal(proposalReadTrusted({ publicPropCount: 10, currentBlock: 1001, highWater: 1000, knownRefKeys: ['7', '8', '9'] }).trusted, true);
        assert.equal(proposalReadTrusted({ publicPropCount: null, currentBlock: 1001, highWater: 1000, knownRefKeys: ['7'] }).trusted, true);
        assert.equal(proposalReadTrusted({ publicPropCount: 10, currentBlock: NaN, highWater: 1000, knownRefKeys: [] }).trusted, false);
    });

    test('the high-water mark only moves forward', () => {
        assert.equal(nextHighWater(1000, 1200), 1200);
        assert.equal(nextHighWater(1000, 900), 1000);
        assert.equal(nextHighWater(undefined, 5), 5);
        assert.equal(nextHighWater(1000, NaN), 1000);
    });
});

describe('self-healing: a wrongly closed thread reopens', () => {
    test('a thread auto-closed while its proposal is still active reopens on the next trusted read', () => {
        db.closeThread('proposal-8', AUTO_CLOSE_REASON.proposal);   // the damage, as production has it
        assert.equal(db.getThread('proposal-8').status, 'closed');
        const r = reconcileThreads(db, 'proposal', [prop(7), prop(8), prop(9)], { trusted: true });
        const t = db.getThread('proposal-8');
        assert.equal(t.status, 'open');
        assert.equal(t.closedAt, null);
        assert.equal(t.closedReason, null);
        assert.deepEqual(r.reopened, ['proposal-8']);
        assert.equal(t.postCount, 1, 'the posts were there all along');
    });

    test('a thread closed for any other reason is left alone', () => {
        db.closeThread('proposal-9', 'Closed by a moderator.');
        reconcileThreads(db, 'proposal', [prop(7), prop(8), prop(9)], { trusted: true });
        assert.equal(db.getThread('proposal-9').status, 'closed');
        assert.equal(db.getThread('proposal-9').closedReason, 'Closed by a moderator.');
    });

    test('an untrusted read never reopens either', () => {
        db.closeThread('proposal-7', AUTO_CLOSE_REASON.proposal);
        reconcileThreads(db, 'proposal', [prop(7)], { trusted: false });
        assert.equal(db.getThread('proposal-7').status, 'closed');
        reconcileThreads(db, 'proposal', [prop(7), prop(8)], { trusted: true });
        assert.equal(db.getThread('proposal-7').status, 'open');
    });
});

describe('ordinary lifecycle still works', () => {
    test('a trusted read creates new threads and closes tabled ones, keeping their posts', () => {
        const before = postCount();
        const r = reconcileThreads(db, 'proposal', [prop(8), prop(10)], { trusted: true });
        assert.ok(r.created.includes('proposal-10'));
        assert.ok(r.closed.includes('proposal-7'));
        assert.equal(db.getThread('proposal-7').status, 'closed');
        assert.equal(db.getThread('proposal-7').closedReason, AUTO_CLOSE_REASON.proposal);
        assert.equal(db.getThread('proposal-10').status, 'open');
        assert.equal(postCount(), before, 'closing never removes posts');
        assert.equal(db.getPosts('proposal-7').length, 1);
    });

    test('an untrusted read may still create threads for items it does list', () => {
        reconcileThreads(db, 'motion', [{ id: 'motion-0xab', refKey: '0xab', title: 'M' }], { trusted: false });
        assert.equal(db.getThread('motion-0xab').status, 'open');
        const r = reconcileThreads(db, 'motion', [], { trusted: false });
        assert.equal(r.skipped, true);
        assert.equal(db.getThread('motion-0xab').status, 'open');
    });
});

describe('the deploy itself does not lose discussion rows', () => {
    test('a pre-edit database (no edited_at) keeps every thread and post through initDb', async () => {
        const dir = tmp();
        const old = new DatabaseSync(path.join(dir, 'explorer.db'));
        // Exactly the table shapes shipped before 0c09910.
        old.exec(`CREATE TABLE discussion_threads (id TEXT PRIMARY KEY, kind TEXT, ref_key TEXT, title TEXT, status TEXT DEFAULT 'open', created_at INTEGER, closed_at INTEGER, closed_reason TEXT);
            CREATE TABLE discussion_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, author TEXT, author_name TEXT, content TEXT, created_at INTEGER);
            INSERT INTO discussion_threads VALUES ('proposal-3','proposal','3','Public Proposal #3','closed',1,2,'x');
            INSERT INTO discussion_posts (thread_id,author,author_name,content,created_at) VALUES ('proposal-3','eA','A','one',5),('proposal-3','eB','B','two',6);`);
        old.close();
        // Fresh module instance so this test's initDb does not disturb the shared one above.
        const fresh = await import('../db.js?pre-edit-migration');
        fresh.initDb(dir, true);
        const posts = fresh.getPosts('proposal-3');
        assert.deepEqual(posts.map(p => p.content), ['one', 'two']);
        assert.ok(posts.every(p => p.editedAt === null));
        assert.equal(fresh.getThread('proposal-3').postCount, 2);
    });

    test('no code path deletes or drops discussion tables', () => {
        for (const f of ['db.js', 'server.js', 'lib/discussion-threads.js', 'lib/discussion-edit.js', 'lib/discussion-links.js']) {
            if (!fs.existsSync(new URL(`../${f}`, import.meta.url))) continue;
            const src = stripComments(readRepo(f, import.meta.url));
            assert.doesNotMatch(src, /DELETE\s+FROM\s+discussion_|DROP\s+TABLE[^;]*discussion_|UPDATE\s+discussion_posts\s+SET\s+content\s*=\s*''/i, f);
        }
    });
});

describe('server.js is wired to the guarded reconcile', () => {
    const server = stripComments(readRepo('server.js', import.meta.url));
    test('the old unguarded closures are gone', () => {
        assert.doesNotMatch(server, /function reconcileProposalThreads/);
        assert.doesNotMatch(server, /function reconcileMotionThreads/);
    });
    test('both callers go through reconcileThreads with a trust decision', () => {
        assert.match(server, /import \{[^}]*reconcileThreads[^}]*\} from '\.\/lib\/discussion-threads\.js'/);
        assert.match(server, /proposalReadTrusted\(/);
        assert.match(server, /motionReadTrusted\(/);
        assert.match(server, /reconcileThreads\(db, kind, items, \{ trusted: trust\.trusted \}\)/);
        assert.match(server, /reconcileGovThreads\('proposal'/);
        assert.match(server, /reconcileGovThreads\('motion'/);
        assert.doesNotMatch(server, /if \(motionsTrusted\) reconcile/, 'the motion call must always run so it can create and self-heal');
    });
});
