// "Discussion (2)" over a board with one message (production, referendum #36,
// 2026-10-27). A referendum's page is the last stage of a lifecycle: the council
// motion that queued the call and the external proposal each had a thread, linked
// by the proposal hash, and the motion's thread holds posts of its own. The
// button must count exactly what the board lists; earlier posts are shown apart,
// read-only, under their own heading, and never added to the item's own count.
//
// Real code: the real SQLite db, the real API summary (lib/gov-detail-api.js),
// the link / count helpers (lib/discussion-lifecycle.js) and the renderers.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db.js';
import { referendumDetail } from '../lib/gov-detail-api.js';
import { renderGovDetailSummary, discussionCountLabel, boardIsStale } from '../lib/gov-detail-view.js';
import { discussionLabel, earlierPostCount, earlierBoards, withEarlierCounts, lifecycleLinks } from '../lib/discussion-lifecycle.js';
import { renderEarlierDiscussion, EARLIER_OPEN_MAX } from '../lib/discussion-edit.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';

const PH = '0x' + '27'.repeat(32);
const MOTION = 'motion-0x' + 'be'.repeat(32);
const EXTERNAL = `external-${PH}`;
const ALICE = 'eAliceAddressForTestsOnly000000000000000000000001';
const BOB = 'eBobAddressForTestsOnly00000000000000000000000002';
const h = { esc: escapeHtml, num: (n) => String(n), pdex: (n) => String(n), shortAddr: (a) => String(a).slice(0, 6), fmtDate: (ms) => `T${ms}` };

let DIR;
before(() => {
    DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-discussion-count-'));
    db.initDb(DIR, true);
    db.setKv('democracy_meta', { referendumCount: 40, publicPropCount: 0, currentBlock: 1100, launchPeriod: 100, totalIssuance: 10000 });
    db.upsertDemocracyReferendum({ refIndex: 36, status: 'Ongoing', endBlock: 1200, ayes: 1, nays: 1, turnout: 1, tallyKnown: 1, threshold: 'SimpleMajority' });
    // The lifecycle: council motion #140 (2 posts) -> external proposal (none) -> referendum #36 (1 post).
    db.createThreadIfMissing({ id: MOTION, kind: 'motion', refKey: MOTION.slice(7), title: 'Council Motion #140' });
    db.setThreadProposalHash(MOTION, PH);
    db.closeThread(MOTION, 'Motion concluded.');
    db.createThreadIfMissing({ id: EXTERNAL, kind: 'external', refKey: PH, title: 'External proposal' });
    db.setThreadProposalHash(EXTERNAL, PH);
    db.closeThread(EXTERNAL, 'External proposal launched as referendum #36.');
    db.createThreadIfMissing({ id: 'referendum-36', kind: 'referendum', refKey: '36', title: 'Referendum #36' });
    db.setThreadProposalHash('referendum-36', PH);
    db.createPost({ threadId: MOTION, author: ALICE, authorName: 'Alice', content: 'Motion post one' });
    db.createPost({ threadId: MOTION, author: BOB, authorName: 'Bob', content: 'Motion post two' });
    db.createPost({ threadId: 'referendum-36', author: ALICE, authorName: 'Alice', content: 'Only message on the referendum' });
    // An unrelated thread with a post must not leak into anyone's count.
    db.createThreadIfMissing({ id: 'referendum-5', kind: 'referendum', refKey: '5', title: 'Referendum #5' });
    db.createPost({ threadId: 'referendum-5', author: BOB, authorName: 'Bob', content: 'Unrelated' });
});
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {} });

const server = (kind) => {
    // What GET /api/discussions/:id does, minus express.
    const thread = db.getThread(kind);
    const links = lifecycleLinks(thread, db.getThreadsByProposalHash(thread.proposalHash));
    return { thread: { ...thread, links }, posts: db.getPosts(thread.id), earlier: earlierBoards(links, db.getThread, db.getPosts) };
};

describe('referendum #36: the count and the board are the same set of posts', () => {
    test('the API summary counts the item\'s own thread and reports the earlier posts apart', async () => {
        const r = await referendumDetail(36, { db, chain: null });
        assert.equal(r.status, 200);
        const t = r.body.thread;
        assert.equal(t.postCount, 1, 'own posts only');
        assert.equal(t.earlierPostCount, 2, 'the council motion\'s posts, kept separate');
        const motion = t.links.earlier.find(l => l.id === MOTION);
        assert.equal(motion.postCount, 2, 'each earlier thread carries its own post count');
        assert.equal(t.links.earlier.find(l => l.id === EXTERNAL).postCount, 0);
    });
    test('the header button reads "Discussion (1) + 2 earlier", never "(2)"', async () => {
        const r = await referendumDetail(36, { db, chain: null });
        assert.equal(discussionCountLabel(r.body, null), 'Discussion (1) + 2 earlier');
        const html = renderGovDetailSummary(r.body, h);
        assert.ok(html.includes('>Discussion (1) + 2 earlier</a>'));
        assert.ok(!html.includes('Discussion (2)'));
    });
    test('no earlier posts: the plain "Discussion (N)"', () => {
        assert.equal(discussionLabel(3, 0), 'Discussion (3)');
        assert.equal(discussionLabel(0, 0), 'Discussion (0)');
        assert.equal(discussionLabel(0, 4), 'Discussion (0) + 4 earlier');
        assert.equal(discussionLabel(undefined, null), 'Discussion (0)');
        assert.equal(discussionCountLabel({ thread: null }, null), 'Discussion');
    });
    test('the thread route hands the board the earlier posts; the count of what it lists equals the label', () => {
        const s = server('referendum-36');
        assert.equal(s.posts.length, 1);
        const listed = s.earlier.reduce((n, b) => n + b.posts.length, 0);
        assert.equal(listed, 2);
        assert.equal(listed, earlierPostCount(s.thread.links), 'what the board lists is what "+ N earlier" says');
        assert.deepEqual(s.earlier.map(b => b.thread.id).sort(), [EXTERNAL, MOTION].sort());
        // The motion thread is the motion's page and has nothing earlier of its own.
        assert.deepEqual(server(MOTION).earlier, []);
    });
    test('an unrelated thread is never pulled in', () => {
        const s = server('referendum-36');
        assert.ok(!s.earlier.some(b => b.thread.id === 'referendum-5'));
        assert.equal(db.getThread('referendum-5').postCount, 1);
    });
    test('the /discussions list: Posts is the thread\'s own, earlierPostCount beside it', () => {
        const all = db.getThreads(null);
        const byId = Object.fromEntries(withEarlierCounts(all, null).map(t => [t.id, t]));
        assert.equal(byId['referendum-36'].postCount, 1);
        assert.equal(byId['referendum-36'].earlierPostCount, 2);
        assert.equal(byId[MOTION].postCount, 2);
        assert.equal(byId[MOTION].earlierPostCount, 0, 'a motion has no earlier stage');
        assert.equal(byId['referendum-5'].earlierPostCount, 0);
        // Filtered by kind, the earlier threads (other kinds) are still found.
        const only = withEarlierCounts(db.getThreads('referendum'), all).find(t => t.id === 'referendum-36');
        assert.equal(only.earlierPostCount, 2);
    });
});

describe('the board draws the earlier discussion read-only, under its own heading', () => {
    const o = { esc: escapeHtml, shortAddr: a => String(a).slice(0, 6), fmtDate: ms => `T${ms}`, hrefOf: id => `/x/${id}` };
    test('heading names the earlier thread; posts are there, with no Edit and no Copy link', () => {
        const s = server('referendum-36');
        const html = renderEarlierDiscussion(s.earlier, { ...o, isEditable: () => true, actions: () => '<button>copy</button>' });
        assert.ok(html.includes('Earlier discussion on Council Motion #140'));
        assert.ok(html.includes('2 posts, read-only, closed'));
        assert.equal((html.match(/class="discussion-post"/g) || []).length, 2);
        assert.ok(html.includes('Motion post one') && html.includes('Motion post two'));
        assert.ok(!html.includes('data-edit-post') && !html.includes('<button>copy</button>'));
        assert.ok(html.includes('href="/x/' + MOTION + '"'));
        assert.ok(!html.includes('External proposal'), 'an earlier thread with no posts adds no empty block');
    });
    test('open while short, collapsed when long, and the heading always says how many', () => {
        const mk = n => [{ thread: { id: MOTION, title: 'Council Motion #1', status: 'closed' }, posts: Array.from({ length: n }, (_, i) => ({ id: i + 1, threadId: MOTION, author: ALICE, authorName: 'A', content: 'p' + i, createdAt: 1 })) }];
        assert.match(renderEarlierDiscussion(mk(EARLIER_OPEN_MAX), o), /<details class="discussion-earlier"[^>]* open>/);
        const long = renderEarlierDiscussion(mk(EARLIER_OPEN_MAX + 1), o);
        assert.ok(!/<details[^>]* open>/.test(long));
        assert.ok(long.includes(`(${EARLIER_OPEN_MAX + 1} posts, read-only`));
        assert.ok(renderEarlierDiscussion(mk(1), o).includes('(1 post, read-only'));
    });
    test('nothing earlier: nothing drawn; hostile titles are escaped', () => {
        assert.equal(renderEarlierDiscussion([], o), '');
        assert.equal(renderEarlierDiscussion(undefined, o), '');
        const evil = [{ thread: { id: 'x', title: '<img src=x onerror=alert(1)>', status: 'open' }, posts: [{ id: 9, author: ALICE, authorName: 'A', content: 'hi', createdAt: 1 }] }];
        assert.ok(!renderEarlierDiscussion(evil, o).includes('<img'));
    });
});

describe('boardIsStale', () => {
    const d = (own, earlier) => ({ thread: { id: 'referendum-36', postCount: own, earlierPostCount: earlier } });
    test('compares the board\'s counts with the server\'s, only for the same thread', () => {
        assert.equal(boardIsStale(d(1, 2), { threadId: 'referendum-36', own: 1, earlier: 2 }), false);
        assert.equal(boardIsStale(d(2, 2), { threadId: 'referendum-36', own: 1, earlier: 2 }), true);
        assert.equal(boardIsStale(d(1, 3), { threadId: 'referendum-36', own: 1, earlier: 2 }), true);
        assert.equal(boardIsStale(d(2, 0), null), false, 'no board drawn yet: nothing to refresh');
        assert.equal(boardIsStale(d(2, 0), { threadId: 'other', own: 0, earlier: 0 }), false);
    });
});

describe('wiring', () => {
    const server_ = stripComments(readRepo('server.js', import.meta.url));
    const script = stripComments(readRepo('script.js', import.meta.url));
    test('the list route adds earlierPostCount; the thread route adds earlier', () => {
        assert.match(server_, /res\.json\(\{ threads: withEarlierCounts\(db\.getThreads\(kind\), kind \? db\.getThreads\(null\) : null\) \}\)/);
        assert.match(server_, /earlier: earlierBoards\(withLinks\.links, db\.getThread, db\.getPosts\)/);
    });
    test('the thread view draws the earlier block and reports what it drew; the list shows "+ N earlier"', () => {
        const render = bodyOf(script, 'renderThread');
        assert.match(render, /renderEarlierDiscussion\(opts\.earlier,/);
        assert.match(render, /opts\.onRendered\(thread, posts, opts\.earlier \|\| \[\]\)/);
        assert.match(bodyOf(script, 'renderThreadList'), /earlierPostCount > 0/);
        assert.match(bodyOf(script, 'fetchDiscussionThread'), /earlier: data\.earlier \|\| \[\]/);
    });
});
