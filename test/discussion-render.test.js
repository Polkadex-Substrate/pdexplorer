// "No posts yet" on a thread the database holds posts for (production,
// 2026-10-22). The API on the box returned both posts; the page did not.
//
// Part 1 runs the REAL fetchDiscussionThread + renderThread from script.js
// (lifted with bodyOf, as other tests do) against the production payload
// shape. It renders both posts for the signed-in author and for everyone else,
// on the deployed code too: the rendering path was not what lost them.
// Part 2 is the cause: GET /api/discussions/:id sent no Cache-Control, so a
// copy fetched before the first post was written could keep being served.
// Part 3 is the guard: an empty list from a thread that reports posts shows an
// error, not "No posts yet".
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAddress } from '@polkadot/util-crypto';
import * as edit from '../lib/discussion-edit.js';
import * as links from '../lib/discussion-links.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';

const SCRIPT = readRepo('script.js', import.meta.url);
const SERVER = readRepo('server.js', import.meta.url);

const AUTHOR = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const OTHER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const TID = 'motion-0x27befa0fdbb72a238099f9c63668789ceaebbd3cdad7d471c177510bc5208033';
const LONG1 = 'POLKADEX TREASURY PROPOSAL 86\nCore team funding: (12 months), 1,234,567 PDEX; phase 1.\n'.repeat(60).slice(0, 4000);
const LONG2 = 'Second post: colons, commas (parens) 42\n'.repeat(100).slice(0, 3492);
function payload({ posts = true, postCount = 2 } = {}) {
    return {
        thread: { id: TID, kind: 'motion', refKey: TID.slice(7), title: 'treasury.approveProposal', status: 'open',
            createdAt: 1792696273392, closedAt: null, closedReason: null, postCount },
        posts: posts ? [
            { id: 1, threadId: TID, author: AUTHOR, authorName: 'Validator One', content: LONG1, createdAt: 1792696378000, editedAt: null },
            // editedAt absent, not null
            { id: 2, threadId: TID, author: AUTHOR, authorName: 'Validator One', content: LONG2, createdAt: 1792696565000 }
        ] : []
    };
}

// Lift the thread view out of script.js and run it with a fake page.
async function openThread(body, signedInAs) {
    const names = ['fetchDiscussionThread', 'renderThread', 'isSameAddress', 'getDiscussSession',
        'stakingShortAddress', 'formatLocalDateTime', 'helpIcon', 'stakingEscapeHtml'];
    const code = names.map(n => (n === 'fetchDiscussionThread' ? 'async ' : '') + bodyOf(SCRIPT, n)).join('\n');
    const root = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
    const store = new Map(signedInAs ? [['pdex_discuss_session', JSON.stringify({ token: 't', address: signedInAs })]] : []);
    const fetches = [];
    const errors = [];
    const env = {
        ...edit, ...links, canEditPost: edit.canEdit,
        document: { getElementById: id => (id === 'discussions-content' ? root : null) },
        window: { location: { search: '', hash: '', origin: 'https://explorer.polkadex.ee' } },
        localStorage: { getItem: k => store.get(k) ?? null, removeItem: k => store.delete(k) },
        navigator: {},
        fetch: async (url, opts) => { fetches.push({ url, opts }); return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }; },
        getStoredWallet: () => signedInAs || null,
        sharedEscapeHtml: escapeHtml, decodeAddress, DISCUSS_TOKEN_KEY: 'pdex_discuss_session',
        discussSignIn: async () => false, submitDiscussionPost: () => {},
    };
    const run = new Function(...Object.keys(env), code + '\nreturn fetchDiscussionThread;')(...Object.values(env));
    const realError = console.error;   // the lib logs through the global console
    console.error = (...a) => errors.push(a.join(' '));
    try { await run(TID, true); } finally { console.error = realError; }
    const html = root.innerHTML;
    return {
        html, fetches, errors,
        posts: (html.match(/class="discussion-post"/g) || []).length,
        editButtons: (html.match(/data-edit-post=/g) || []).length
    };
}

describe('the thread view renders the production payload', () => {
    test('signed out: both posts, no edit buttons, no empty state', async () => {
        const r = await openThread(payload(), null);
        assert.equal(r.posts, 2);
        assert.equal(r.editButtons, 0);
        assert.ok(!r.html.includes('No posts yet'));
        assert.ok(!r.html.includes('Error:'));
        assert.ok(r.html.includes('POLKADEX TREASURY PROPOSAL 86<br>Core team funding: (12 months)'));
    });
    test('signed in as the author: both posts, each editable', async () => {
        const r = await openThread(payload(), AUTHOR);
        assert.equal(r.posts, 2);
        assert.equal(r.editButtons, 2);
        assert.ok(!r.html.includes('No posts yet'));
    });
    test('signed in as someone else: both posts, none editable', async () => {
        const r = await openThread(payload(), OTHER);
        assert.equal(r.posts, 2);
        assert.equal(r.editButtons, 0);
    });
});

describe('a stale thread response cannot be served', () => {
    test('GET /api/discussions/:id sends Cache-Control: no-store', () => {
        const code = stripComments(SERVER);
        const start = code.indexOf("app.get('/api/discussions/:id'");
        assert.ok(start !== -1, 'route not found');
        const route = code.slice(start, code.indexOf('\n});', start));
        assert.match(route, /res\.set\('Cache-Control', 'no-store'\)/,
            'with no Cache-Control a Cache Everything edge rule keeps serving a copy taken before the posts were written');
    });
    test('the browser fetches the thread with cache: no-store', async () => {
        const r = await openThread(payload(), null);
        assert.equal(r.fetches.length, 1);
        assert.equal(r.fetches[0].url, '/api/discussions/' + encodeURIComponent(TID));
        assert.equal(r.fetches[0].opts && r.fetches[0].opts.cache, 'no-store');
    });
});

describe('never "No posts yet" for a thread that has posts', () => {
    test('postCount 2 but an empty list: inline error and a console line', async () => {
        const r = await openThread(payload({ posts: false, postCount: 2 }), AUTHOR);
        assert.ok(!r.html.includes('No posts yet'), 'a thread that reports posts must not look empty');
        assert.match(r.html, /2 posts that could not be loaded/);
        assert.equal(r.errors.length, 1);
    });
    test('a genuinely empty thread still says "No posts yet"', async () => {
        const r = await openThread(payload({ posts: false, postCount: 0 }), null);
        assert.ok(r.html.includes('No posts yet'));
        assert.equal(r.errors.length, 0);
    });
    test('a post that throws while rendering gives an error, not an empty thread', () => {
        const errors = [];
        const o = { esc: escapeHtml, shortAddr: a => a, fmtDate: () => { throw new Error('bad date'); }, isEditable: () => false };
        const html = edit.renderPostList(payload().thread, payload().posts, o, { error: (...a) => errors.push(a) });
        assert.ok(!html.includes('No posts yet'));
        assert.match(html, /could not be displayed/);
        assert.equal(errors.length, 1);
    });
    test('a non-array posts value with a positive postCount is an error', () => {
        const html = edit.renderPostList({ id: TID, postCount: 1 }, { 0: {} }, { esc: escapeHtml }, { error() {} });
        assert.match(html, /1 post that could not be loaded/);
    });
});
