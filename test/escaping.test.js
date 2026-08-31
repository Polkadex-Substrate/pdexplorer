// Audit F-121 / F-123 / F-131-133 — the escaping contract, checked as source.
//
// There is no DOM harness in this project (script.js is a 13.7k-line browser
// module with no export surface), and standing one up to test six template
// literals would be a worse trade than reading the source. So these tests are
// deliberately SOURCE ASSERTIONS: they extract the innerHTML templates that
// render chain-derived data and require every interpolation in them to pass
// through an escape helper.
//
// The weakness of that approach is worth naming: this cannot prove the escaping
// is CORRECT at runtime, only that it is PRESENT. Correctness of the helper
// itself is covered separately below, since stakingEscapeHtml is a pure
// function and can simply be re-implemented from its own source and exercised.
//
// Why bother at all: F-121 existed because renderBlocks() on the HOME page
// interpolated raw while the /blocks page rendering the SAME fields escaped.
// Nobody introduced that on purpose — it drifted. A drift check is exactly the
// thing a test can hold.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escapeHtml as sharedEscapeHtml, ESCAPED_CHARS } from '../lib/html-escape.js';
import { readRepo } from './helpers/source.js';

const src = readFileSync(new URL('../script.js', import.meta.url), 'utf8');

// Pull a function body out of script.js by name, brace-matching from its `{`.
function functionBody(name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `function ${name} not found — was it renamed?`);
    let i = src.indexOf('{', start);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') {
            depth--;
            if (depth === 0) return src.slice(i, j + 1);
        }
    }
    throw new Error(`unbalanced braces reading ${name}`);
}

// Every `${...}` inside a template literal in `body`.
function interpolations(body) {
    const out = [];
    const re = /\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    let m;
    while ((m = re.exec(body)) !== null) out.push(m[1].trim());
    return out;
}

const ESCAPED = /(stakingEscapeHtml|escapeHtml|encodeURIComponent)\s*\(/;

// Interpolations that are safe without escaping, with the reason each is safe.
// Anything not matching one of these must be escaped — the default is DENY, so
// a newly added raw field fails rather than slipping through.
const SAFE = [
    /^`?[^`]*`?$/u                                  // placeholder, refined below
];

function isStructurallySafe(expr) {
    // A literal class/attribute decision, not data:  index === 0 ? 'x' : ''
    if (/^index\s*===\s*0\s*\?/.test(expr)) return true;
    // A pre-built HTML fragment assembled elsewhere (checked at its own site).
    if (/^(titleHtml|countLine|emptyLine)$/.test(expr)) return true;
    // liveBadge() (F-064) returns a fixed string literal with no interpolation
    // at all — there is no data in it to escape. Listed explicitly rather than
    // pattern-matched, so that if it ever starts taking an argument this test
    // fails and someone has to think about it.
    if (/^\w+\.unconfirmed \? liveBadge\(\) : ''$/.test(expr)) return true;
    // Ternaries whose BOTH branches are themselves escaped or literal.
    if (expr.includes('?') && expr.includes(':')) {
        const parts = expr.split(/\?|:/).map(s => s.trim()).filter(Boolean);
        return parts.every(p =>
            ESCAPED.test(p) ||
            /^'[^']*'$/.test(p) ||
            /^`[^`$]*`$/.test(p) ||
            /^(short(Hash|From|To)|titleHtml)$/.test(p) ||
            /===|!==|==|!=/.test(p) ||
            p.includes('.length')
        );
    }
    // Values already escaped when they were computed, a few lines above.
    if (/^short(Hash|From|To)$/.test(expr)) return true;
    return false;
}

describe('F-121 — the home page escapes chain data like the full-list pages do', () => {
    for (const fn of ['renderBlocks', 'renderTransactions']) {
        test(`${fn}() interpolates nothing raw`, () => {
            const body = functionBody(fn);
            const raw = interpolations(body).filter(
                e => !ESCAPED.test(e) && !isStructurallySafe(e)
            );
            assert.deepEqual(raw, [],
                `${fn}() interpolates unescaped chain data: ${raw.join(' | ')}`);
        });
    }

    test('liveBadge() is a constant, so exempting it above stays honest', () => {
        const body = functionBody('liveBadge');
        assert.ok(!body.includes('${'),
            'liveBadge() now interpolates something — it must escape it, and the exemption in isStructurallySafe must go');
    });

    test('the short-hash slices are escaped BEFORE truncation, not after', () => {
        // Escaping after slicing can cut an entity in half ("&am"), which is
        // both wrong-looking and, worse, can reopen the hole if a later edit
        // moves the slice. Escape the slice of the RAW string instead.
        const body = functionBody('renderTransactions');
        assert.match(body, /stakingEscapeHtml\(String\(tx\.hash\)\.substring/);
        assert.match(body, /stakingEscapeHtml\(String\(tx\.from\)\.substring/);
    });
});

describe('F-180 — the deep-search paint path (round 2)', () => {
    // The round-2 audit caught this, and caught WHY the round-1 test missed it:
    // the escaping tests grepped renderBlocks/renderTransactions only, so a
    // third paint path for the same fields was invisible to them. `name` here
    // is the on-chain IDENTITY — settable by anyone who pays the deposit — so
    // this was a live XSS on the origin that signs transactions.
    //
    // The lesson is about the TEST, not just the code: an escaping test scoped
    // to named functions verifies those functions, not the property. This block
    // is scoped to the sink instead.
    function deepSearchBlock() {
        const at = src.indexOf("if (data.type === 'block')");
        assert.notEqual(at, -1, 'the deep-search render block moved or was renamed');
        return src.slice(at, src.indexOf('if (html) {', at));
    }

    test('every interpolation in the deep-search result is escaped', () => {
        const raw = interpolations(deepSearchBlock())
            .filter(e => !/^E\(|stakingEscapeHtml|escapeHtml/.test(e));
        assert.deepEqual(raw, [],
            `deep search interpolates unescaped chain data: ${raw.join(' | ')}`);
    });

    test('the on-chain identity specifically goes through the escaper', () => {
        // Naming the field, because this is the one an attacker controls
        // directly and cheaply.
        assert.match(deepSearchBlock(), /Identity: \$\{E\(data\.data\.name\)\}/,
            'the on-chain identity is raw in deep search again — that IS F-180');
    });

    test('NO innerHTML sink in this file interpolates data.data.* raw', () => {
        // The generalised form. F-013 closed one path, F-180 was a second one
        // for the same data. Catch the third.
        const bad = [...src.matchAll(/\$\{(data\.data\.[A-Za-z_.]+)\}/g)].map(m => m[1]);
        assert.deepEqual(bad, [],
            `raw data.data.* interpolation(s) remain: ${bad.join(', ')}`);
    });
});

describe('F-123 — option values are escaped, not just option labels', () => {
    test('no <option value="${...}"> interpolates without an escape helper', () => {
        const re = /<option value="\$\{([^}]*)\}"/g;
        const bad = [];
        let m;
        while ((m = re.exec(src)) !== null) {
            if (!ESCAPED.test(m[1])) bad.push(m[1].trim());
        }
        assert.deepEqual(bad, [],
            `unescaped <option value> interpolations (F-123): ${bad.join(' | ')}`);
    });

    test('every metadata-driven select escapes BOTH halves', () => {
        // The original bug's exact shape: label escaped, value not. If a
        // template escapes one and not the other it is caught above; this pins
        // that the pallet/storage selects specifically still do both.
        for (const needle of [
            '<option value="${escapeHtml(p.queryKey)}">${escapeHtml(p.name)}</option>',
            '<option value="${escapeHtml(s.item)}">${escapeHtml(s.item)}</option>'
        ]) {
            assert.ok(src.includes(needle), `chain-state select regressed: ${needle}`);
        }
    });
});

describe('the escape helper itself is correct', () => {
    // Audit F-133 (round 2): there is now ONE implementation, in
    // lib/html-escape.js, and both stakingEscapeHtml (script.js) and htmlEscape
    // (server.js) forward to it. So this exercises the real exported function
    // rather than lifting a body out of the source with `new Function` — which
    // is what it used to do, and which silently stopped working the moment the
    // body referenced an import.
    const escape = sharedEscapeHtml;

    test('neutralises every character that can break out of text or an attribute', () => {
        assert.equal(escape('<script>'), '&lt;script&gt;');
        assert.equal(escape('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)');
        assert.equal(escape("' onfocus='x"), '&#39; onfocus=&#39;x');
        assert.equal(escape('a & b'), 'a &amp; b');
    });

    test('escapes the ampersand so entities cannot be double-decoded', () => {
        // If & were not escaped, "&lt;script&gt;" typed by a user would render
        // as a live tag after one decode pass.
        assert.equal(escape('&lt;script&gt;'), '&amp;lt;script&amp;gt;');
    });

    test('null and undefined become empty, not the strings "null"/"undefined"', () => {
        assert.equal(escape(null), '');
        assert.equal(escape(undefined), '');
    });

    test('numbers and bigints survive intact', () => {
        assert.equal(escape(12885897), '12885897');
        assert.equal(escape(0), '0');
        assert.equal(escape(123n), '123');
    });

    test('F-133 — escapeHtml and stakingEscapeHtml are the same function', () => {
        // Two helpers with the same job is how one of them ends up weaker.
        assert.match(src, /(const|let|var)\s+escapeHtml\s*=\s*stakingEscapeHtml|function\s+escapeHtml\s*\([\s\S]{0,120}?stakingEscapeHtml/,
            'escapeHtml is no longer an alias of stakingEscapeHtml (F-133)');
    });

    test('F-133 — the SERVER escaper is the same function too', () => {
        // The round-1 fix collapsed the two client helpers and left server.js
        // with an independent chain of five .replace() calls. They had already
        // drifted on the apostrophe entity (&#039; server-side, &#39; client-
        // side). Harmless in itself — but two hand-maintained escapers on an
        // XSS boundary will eventually disagree about something that is not.
        const serverSrc = readRepo('server.js', import.meta.url);
        const i = serverSrc.indexOf('function htmlEscape(');
        assert.ok(i !== -1, 'htmlEscape moved — re-point this test');
        const body = serverSrc.slice(i, serverSrc.indexOf('\n}', i));
        assert.match(body, /sharedEscapeHtml\(/,
            'server.js hand-rolls its own escaper again (F-133)');
        assert.ok(!/replace\(\/&\/g/.test(body),
            'the old five-replace chain is back');
        assert.match(serverSrc, /import \{ escapeHtml as sharedEscapeHtml \} from '\.\/lib\/html-escape\.js'/);
    });

    test('F-133 — both wrappers encode the apostrophe identically', () => {
        // The specific character the two copies disagreed on. Asserted through
        // the shared module, which is what both now call.
        assert.equal(escape("it's"), 'it&#39;s');
        for (const c of ESCAPED_CHARS) {
            assert.notEqual(escape(c), c, `${c} is no longer escaped at all`);
        }
    });
});
