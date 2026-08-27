// Tests for lib/user-text.js — audit F-170.
//
// The finding is an ASYMMETRY, not a single bad line: two routes writing free
// text to the same table family, one validated and one not. So the tests are
// written around the properties that must hold for BOTH callers, and one test
// asserts the two routes actually share the checker rather than each carrying
// its own copy of the regex — because a duplicated guard is how this finding
// comes back.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkUserText } from '../lib/user-text.js';

const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('checkUserText — the injection guard', () => {
    const hostile = {
        'a script tag': '<script>alert(1)</script>',
        'a bare open bracket': 'spam < here',
        'a bare close bracket': 'spam > here',
        'an img onerror': '<img src=x onerror=alert(1)>',
        'a NUL byte': 'ok\x00hidden',
        'a CRLF log forge': 'fine\r\n2026-01-01 FAKE LOG LINE',
        'a bare newline': 'line one\nline two',
        'a tab': 'col\tcol',
        'a DEL char': 'text\x7f'
    };

    for (const [name, value] of Object.entries(hostile)) {
        test(`rejects ${name}`, () => {
            const out = checkUserText(value, { maxLength: 200, field: 'Reason' });
            assert.equal(out.ok, false, `${JSON.stringify(value)} was accepted`);
            assert.match(out.error, /disallowed characters/);
        });
    }

    test('accepts ordinary prose, punctuation and non-ASCII', () => {
        for (const good of [
            'This is a phishing label',
            "It's impersonating the treasury — see ref #42.",
            'Étiquette trompeuse',
            'ラベルが不正です',
            'quotes "like this" and (parens) and 100% signs'
        ]) {
            const out = checkUserText(good, { maxLength: 200, field: 'Reason' });
            assert.equal(out.ok, true, `${good} was rejected: ${out.error}`);
            assert.equal(out.value, good);
        }
    });
});

describe('checkUserText — length and emptiness', () => {
    test('an optional field accepts empty, null and undefined', () => {
        for (const empty of ['', '   ', null, undefined]) {
            const out = checkUserText(empty, { minLength: 0, maxLength: 200, field: 'Reason' });
            assert.equal(out.ok, true);
            assert.equal(out.value, '');
        }
    });

    test('a required field rejects empty', () => {
        const out = checkUserText('   ', { minLength: 2, maxLength: 40, field: 'Label' });
        assert.equal(out.ok, false);
        assert.match(out.error, /required/);
    });

    test('over-length is REJECTED, never silently truncated', () => {
        // db.js slices to 200. If the route also silently truncated, a user
        // would be told their report was filed while the tail was discarded.
        const long = 'a'.repeat(201);
        const out = checkUserText(long, { maxLength: 200, field: 'Reason' });
        assert.equal(out.ok, false);
        assert.match(out.error, /at most 200/);
    });

    test('exactly at the cap is accepted', () => {
        const out = checkUserText('a'.repeat(200), { maxLength: 200, field: 'Reason' });
        assert.equal(out.ok, true);
        assert.equal(out.value.length, 200);
    });

    test('length is measured AFTER trimming', () => {
        const out = checkUserText('  ' + 'a'.repeat(200) + '  ', { maxLength: 200 });
        assert.equal(out.ok, true, 'surrounding whitespace must not push a valid value over the cap');
    });

    test('the returned value is trimmed', () => {
        assert.equal(checkUserText('  hello  ', { maxLength: 20 }).value, 'hello');
    });

    test('a below-minimum value reports the range, not "required"', () => {
        const out = checkUserText('a', { minLength: 2, maxLength: 40, field: 'Label' });
        assert.equal(out.ok, false);
        assert.match(out.error, /2–40/);
    });

    test('never throws on hostile input types', () => {
        for (const weird of [{}, [], 0, false, NaN, Symbol.iterator.toString()]) {
            assert.doesNotThrow(() => checkUserText(weird, { maxLength: 200 }));
        }
    });
});

describe('F-170 — both label routes go through the shared checker', () => {
    // The finding is that these two drifted. Pin them together.
    test('the report route validates its reason', () => {
        const route = serverSrc.slice(
            serverSrc.indexOf("app.post('/api/labels/:address/:signer/report'"),
            serverSrc.indexOf("app.post('/api/labels/:address/:signer/veto'")
        );
        assert.ok(route.length > 0, 'could not locate the report route');
        assert.match(route, /checkUserText\(/, 'the report reason is unvalidated again (F-170)');
        assert.ok(!/db\.reportLabel\([^)]*reason:\s*reason\b/.test(route),
            'the raw reason is being stored again');
    });

    test('the label route validates its label through the same helper', () => {
        const route = serverSrc.slice(
            serverSrc.indexOf("app.post('/api/labels/:address', express.json"),
            serverSrc.indexOf("app.delete('/api/labels/:address'")
        );
        assert.ok(route.length > 0, 'could not locate the label route');
        assert.match(route, /checkUserText\(/,
            'the label route grew its own private guard again — that divergence IS F-170');
    });

    test('server.js holds no second hand-rolled copy of the character class', () => {
        // One definition, in lib/user-text.js. A copy in server.js means the
        // next person fixes one and not the other.
        const copies = serverSrc.match(/\/\[\\x00-\\x1f[^/]*\/\.test\(/g) || [];
        assert.equal(copies.length, 0,
            `server.js still hand-rolls the control-char regex ${copies.length}× instead of using checkUserText`);
    });
});
