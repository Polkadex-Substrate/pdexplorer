// docs/archive/392-readiness.md is the record of the 392 upgrade. It must say
// up front that it is archived, when, and that its run sheet no longer applies,
// so nobody follows a pre-392 rollback or gate from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const doc = readFileSync(new URL('../docs/archive/392-readiness.md', import.meta.url), 'utf8');
const flat = doc.replace(/\s+/g, ' ');

test('the readiness doc lives only under docs/archive/', () => {
    assert.equal(existsSync(new URL('../docs/392-readiness.md', import.meta.url)), false);
});

test('the archive note comes first, is dated, and closes the run sheet', () => {
    assert.ok(doc.startsWith('> **Archived 2026-10-29.**'), 'the dated note must be the first line');
    assert.match(flat, /enacted runtime spec 392 on > 29 October 2026/);
    assert.match(flat, /no longer apply: rollback to the pre-392 image is > closed/);
});

test('it names what was retired and what was kept for history', () => {
    assert.match(flat, /`scripts\/find-upgrade-block\.mjs` and `lib\/upgrade-block\.js` were removed/);
    assert.match(flat, /Everything that decodes HISTORY is kept unchanged/);
});

test('no em or en dashes, ASCII only', () => {
    assert.doesNotMatch(doc, /[^\x00-\x7F]/);
});
