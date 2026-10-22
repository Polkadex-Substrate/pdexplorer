// Discussion board post editing: real SQLite, real route logic (lib/discussion-edit.js),
// plus source-level checks that server.js and script.js are wired to it.
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from '../db.js';
import { checkWindow } from '../lib/rate-limit.js';
import {
    applyEdit, canEdit, isEdited, validateContent, renderPostHtml, MAX_POST_LEN
} from '../lib/discussion-edit.js';
import { readRepo, stripComments } from './helpers/source.js';

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-disc-edit-')); dirs.push(d); return d; }
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

const ALICE = 'eAliceAddress', BOB = 'eBobAddress';
const same = (a, b) => a === b;
let postId, otherThreadPost, closedPost, clock;
const gate = (a) => db.consumeRateLimit('discussion-edit', a, (hits) => checkWindow(hits, { windowMs: 8000, limit: 1 }));
const edit = (o) => applyEdit({ db, same, gate, now: () => clock, address: ALICE, threadId: 't1', postId, body: { content: 'new text' }, ...o });

before(() => {
    db.initDb(tmp(), true);
    db.createThreadIfMissing({ id: 't1', kind: 'proposal', refKey: '1', title: 'T1' });
    db.createThreadIfMissing({ id: 't2', kind: 'proposal', refKey: '2', title: 'T2' });
    db.createThreadIfMissing({ id: 't3', kind: 'proposal', refKey: '3', title: 'T3' });
    postId = db.createPost({ threadId: 't1', author: ALICE, authorName: 'Alice', content: 'old text' });
    otherThreadPost = db.createPost({ threadId: 't2', author: ALICE, content: 'elsewhere' });
    closedPost = db.createPost({ threadId: 't3', author: ALICE, content: 'frozen' });
    db.closeThread('t3', 'done');
});

describe('API: PATCH /api/discussions/:threadId/posts/:postId', () => {
    test('401 when not signed in', () => assert.equal(edit({ address: null }).status, 401));
    test('404 unknown thread', () => assert.equal(edit({ threadId: 'nope' }).status, 404));
    test('404 post in a different thread', () => assert.equal(edit({ postId: otherThreadPost }).status, 404));
    test('404 non-numeric or missing post id', () => {
        assert.equal(edit({ postId: 'abc' }).status, 404);
        assert.equal(edit({ postId: 999999 }).status, 404);
    });
    test('403 non-author, and the post is untouched', () => {
        assert.equal(edit({ address: BOB }).status, 403);
        assert.equal(db.getPost(postId).content, 'old text');
        assert.equal(db.getPost(postId).editedAt, null);
    });
    test('403 closed thread, even for the author', () => {
        const r = edit({ threadId: 't3', postId: closedPost });
        assert.equal(r.status, 403);
        assert.equal(db.getPost(closedPost).content, 'frozen');
    });
    test('400 empty and whitespace-only', () => {
        assert.equal(edit({ body: { content: '   ' } }).status, 400);
        assert.equal(edit({ body: {} }).status, 400);
        assert.equal(edit({ body: null }).status, 400);
    });
    test('400 over 4000 chars; exactly 4000 passes validation', () => {
        assert.equal(edit({ body: { content: 'x'.repeat(4001) } }).status, 400);
        assert.equal(validateContent('x'.repeat(MAX_POST_LEN)).content.length, 4000);
    });
    test('unchanged content is a no-op: 200, no edited_at, no rate-limit slot spent', () => {
        clock = 1000;
        const r = edit({ body: { content: '  old text  ' } });
        assert.equal(r.status, 200);
        assert.equal(db.getPost(postId).editedAt, null);
    });
    test('success updates content and sets edited_at; response lists posts like create', () => {
        clock = 5555;
        const r = edit({});
        assert.equal(r.status, 200);
        assert.ok(r.json.thread && Array.isArray(r.json.posts));
        const p = r.json.posts.find(x => x.id === postId);
        assert.equal(p.content, 'new text');
        assert.equal(p.editedAt, 5555);
    });
    test('429 on a second real edit inside the cooldown, with Retry-After', () => {
        const r = edit({ body: { content: 'again' } });
        assert.equal(r.status, 429);
        assert.match(r.headers['Retry-After'], /^\d+$/);
        assert.equal(db.getPost(postId).content, 'new text');
    });
    test('GET path: getPosts includes editedAt (null for unedited posts)', () => {
        assert.equal(db.getPosts('t2')[0].editedAt, null);
        assert.equal(db.getPosts('t1')[0].editedAt, 5555);
    });
    test('the edit bucket is separate from the create bucket', () => {
        db.consumeRateLimit('discussion-post', 'eCarol', (h) => checkWindow(h, { windowMs: 8000, limit: 1 }));
        const r = db.consumeRateLimit('discussion-edit', 'eCarol', (h) => checkWindow(h, { windowMs: 8000, limit: 1 }));
        assert.equal(r.allowed, true);
    });
});

describe('migration: discussion_posts.edited_at', () => {
    test('an old database without the column is upgraded, twice, with data kept', () => {
        const dir = tmp();
        const h = new DatabaseSync(path.join(dir, 'explorer.db'));
        h.exec('CREATE TABLE discussion_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, author TEXT, author_name TEXT, content TEXT, created_at INTEGER)');
        h.prepare('INSERT INTO discussion_posts(thread_id,author,content,created_at) VALUES(?,?,?,?)').run('t', 'a', 'kept', 1);
        h.close();
        db.initDb(dir, true);
        db.initDb(dir, true);
        const p = db.getPosts('t')[0];
        assert.equal(p.content, 'kept');
        assert.equal(p.editedAt, null);
    });
    test('the column is declared in the additive-migration table', () => {
        assert.match(readRepo('db.js', import.meta.url), /\['discussion_posts', 'edited_at', 'INTEGER DEFAULT NULL'\]/);
    });
});

describe('UI logic', () => {
    const open = { status: 'open' };
    test('canEdit: author on an open thread only', () => {
        assert.equal(canEdit({ author: ALICE }, open, ALICE, same), true);
        assert.equal(canEdit({ author: ALICE }, open, BOB, same), false);
        assert.equal(canEdit({ author: ALICE }, { status: 'closed' }, ALICE, same), false);
        assert.equal(canEdit({ author: ALICE }, open, null, same), false);
        assert.equal(canEdit({ author: ALICE }, open, ALICE, () => { throw new Error('bad'); }), false);
    });
    test('isEdited', () => {
        assert.equal(isEdited({ editedAt: 5 }), true);
        assert.equal(isEdited({ editedAt: null }), false);
        assert.equal(isEdited({}), false);
        assert.equal(isEdited(null), false);
    });
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const o = (extra) => ({ esc, shortAddr: a => a.slice(0, 4), fmtDate: t => 'D' + t, editable: false, ...extra });
    test('render escapes content and shows tag + button only when due', () => {
        const evil = { id: 7, author: ALICE, authorName: '<b>x</b>', content: '<script>alert(1)</script>\nline2', createdAt: 1, editedAt: 9 };
        const html = renderPostHtml(evil, o({ editable: true }));
        assert.ok(!html.includes('<script>'));
        assert.ok(!html.includes('<b>x</b>'));
        assert.match(html, /&lt;script&gt;.*<br>line2/);
        assert.match(html, /discussion-edited-tag" title="Edited D9"/);
        assert.match(html, /data-edit-post="7"/);
        const plain = renderPostHtml({ ...evil, editedAt: null }, o());
        assert.ok(!plain.includes('edited'));
        assert.ok(!plain.includes('data-edit-post'));
    });
});

describe('wiring', () => {
    const server = stripComments(readRepo('server.js', import.meta.url));
    const script = stripComments(readRepo('script.js', import.meta.url));
    test('server route uses the shared limiter with its own key and the shared body parser', () => {
        assert.match(server, /app\.patch\('\/api\/discussions\/:threadId\/posts\/:postId'/);
        assert.match(server, /consumeRateLimit\('discussion-edit'/);
        assert.match(server, /applyEdit\(/);
    });
    test('script.js renders through the lib and stays under the line ceiling', () => {
        // renderPostList (lib) renders each post through renderPostHtml.
        assert.match(script, /renderPostList\(thread, posts,/);
        assert.match(stripComments(readRepo('lib/discussion-edit.js', import.meta.url)), /list\.map\(p => renderPostHtml\(p,/);
        assert.match(script, /wireEditing\(root,/);
        assert.ok(readRepo('script.js', import.meta.url).split('\n').length < 15000);
    });
    test('no alert() in the edit UI', () => {
        assert.ok(!/alert\(/.test(stripComments(readRepo('lib/discussion-edit.js', import.meta.url))));
    });
});
