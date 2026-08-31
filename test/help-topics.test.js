// The help centre's content, now that it is a module (audit F-069).
//
// These tests are the point of the extraction, not a side effect of it. While
// the array lived inside script.js there was no export surface to reach it
// through, so none of the properties below could be checked at all — and every
// one of them is invisible to a reader:
//
//   * `slug` is a live URL at /help/<slug>. A duplicate does not error; the
//     later article silently shadows the earlier one, which still appears in
//     the category grid and still looks clickable.
//   * `category` is matched against HELP_CATEGORIES by id. A typo drops the
//     article out of every grid — it exists, it is reachable by direct URL, and
//     nothing links to it.
//   * an internal <a href="/help/x"> pointing at a slug that no longer exists
//     renders as a working link to an empty page.
//
// The extraction itself was verified by deep-equality against the pre-move
// array, so nothing here is asserting that the move was faithful — that was
// checked once, at the time. These assert what must stay true from now on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HELP_TOPICS, HELP_CATEGORIES } from '../lib/help-topics.js';
import { readRepo, stripComments } from './helpers/source.js';

const slugs = HELP_TOPICS.map(t => t.slug);
const categoryIds = new Set(HELP_CATEGORIES.map(c => c.id));

describe('shape', () => {
    test('there is content', () => {
        assert.ok(HELP_TOPICS.length >= 30, `only ${HELP_TOPICS.length} topics — did the extraction truncate?`);
        assert.ok(HELP_CATEGORIES.length >= 5);
    });

    test('every topic has all five fields, non-empty', () => {
        for (const t of HELP_TOPICS) {
            for (const field of ['slug', 'title', 'category', 'keywords', 'body']) {
                assert.ok(typeof t[field] === 'string' && t[field].trim(),
                    `${t.slug || '(no slug)'}: missing or empty '${field}'`);
            }
        }
    });

    test('every category has an id and a label', () => {
        for (const c of HELP_CATEGORIES) {
            assert.ok(c.id && c.label, `incomplete category: ${JSON.stringify(c)}`);
        }
    });
});

describe('slugs are URLs, so they have to behave like URLs', () => {
    test('no duplicates', () => {
        const seen = new Set();
        const dupes = slugs.filter(s => seen.size === seen.add(s).size);
        assert.deepEqual(dupes, [],
            `duplicate slug(s) — the later article silently shadows the earlier one at the same URL: ${dupes.join(', ')}`);
    });

    test('all lowercase, hyphen-separated, no path characters', () => {
        for (const s of slugs) {
            assert.match(s, /^[a-z0-9]+(-[a-z0-9]+)*$/,
                `'${s}' is not a clean URL segment — a slash, space or capital breaks /help/<slug> routing`);
        }
    });
});

describe('categories', () => {
    test('every topic points at a real category', () => {
        for (const t of HELP_TOPICS) {
            assert.ok(categoryIds.has(t.category),
                `'${t.slug}' has category '${t.category}', which is not in HELP_CATEGORIES — the article vanishes from every grid while staying reachable by URL`);
        }
    });

    test('no category is empty', () => {
        // An empty category renders a heading with nothing under it.
        for (const c of HELP_CATEGORIES) {
            assert.ok(HELP_TOPICS.some(t => t.category === c.id),
                `category '${c.id}' (${c.label}) has no articles — it renders as an empty heading`);
        }
    });

    test('category ids are unique', () => {
        assert.equal(categoryIds.size, HELP_CATEGORIES.length);
    });
});

describe('internal links resolve', () => {
    test('every /help/<slug> link points at an article that exists', () => {
        const known = new Set(slugs);
        const broken = [];
        for (const t of HELP_TOPICS) {
            for (const m of t.body.matchAll(/href="\/help\/([a-z0-9-]+)"/g)) {
                if (!known.has(m[1])) broken.push(`${t.slug} → /help/${m[1]}`);
            }
        }
        assert.deepEqual(broken, [],
            `link(s) to a non-existent article — these render as working links to an empty page:\n  ${broken.join('\n  ')}`);
    });

    test('no topic links to itself', () => {
        for (const t of HELP_TOPICS) {
            assert.ok(!t.body.includes(`href="/help/${t.slug}"`), `'${t.slug}' links to itself`);
        }
    });
});

describe('the body is HTML that will be injected as-is', () => {
    test('no unclosed <p>/<li>/<ol>/<ul> tags', () => {
        // Bodies go through innerHTML, so an unbalanced tag silently swallows
        // the rest of the article rather than throwing.
        for (const t of HELP_TOPICS) {
            for (const tag of ['p', 'li', 'ol', 'ul', 'table', 'code']) {
                const open = (t.body.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'g')) || []).length;
                const close = (t.body.match(new RegExp(`</${tag}>`, 'g')) || []).length;
                assert.equal(open, close, `'${t.slug}': ${open} <${tag}> vs ${close} </${tag}>`);
            }
        }
    });

    test('no script tags or inline handlers', () => {
        // The CSP (F-039/F-041) forbids both; content that needed them would
        // fail silently in the browser rather than at build time.
        for (const t of HELP_TOPICS) {
            assert.ok(!/<script/i.test(t.body), `'${t.slug}' contains a <script> tag`);
            assert.ok(!/\son[a-z]+\s*=/i.test(t.body), `'${t.slug}' has an inline event handler — the CSP blocks it`);
        }
    });
});

describe('F-069 — the extraction is real', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));

    test('script.js imports the data rather than declaring it', () => {
        assert.match(script, /import \{ HELP_CATEGORIES, HELP_TOPICS \} from '\.\/lib\/help-topics\.js'/);
        assert.ok(!/^const HELP_TOPICS = \[/m.test(script),
            'the array is back in script.js');
        assert.ok(!/^const HELP_CATEGORIES = \[/m.test(script));
    });

    test('the renderers still use it', () => {
        // Extracting data that nothing reads would be deletion, not extraction.
        assert.match(script, /HELP_TOPICS\.filter/);
        assert.match(script, /HELP_BY_SLUG = Object\.fromEntries\(HELP_TOPICS\.map/);
    });

    test('script.js got meaningfully smaller', () => {
        // The audit's note is that the file GREW between round 1 and round 2
        // (13,701 → 15,158 → 15,295). The trend is the thing to watch, so this
        // pins a ceiling rather than an exact number.
        const lines = readRepo('script.js', import.meta.url).split('\n').length;
        assert.ok(lines < 15000,
            `script.js is ${lines} lines — it has grown back past the F-069 extraction`);
    });
});
