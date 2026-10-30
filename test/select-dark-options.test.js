// Native <select> popups on Windows Chrome/Edge rendered white-on-white
// because the site is dark-only but did not declare it, and options inherited
// the page's light text colour. Guard the declarations that fix it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

test('site declares a dark colour scheme only (no light theme)', () => {
    assert.match(css, /:root\s*{[^}]*color-scheme:\s*dark\s*;/s);
    assert.match(html, /<meta name="color-scheme" content="dark">/);
    assert.doesNotMatch(css, /color-scheme:\s*[^;]*light/);
});

test('select options and optgroups get explicit dark surface and light text', () => {
    const m = css.match(/select option,\s*select optgroup\s*{([^}]*)}/);
    assert.ok(m, 'select option, select optgroup rule is missing');
    assert.match(m[1], /background-color:\s*var\(--bg-surface\)/);
    assert.match(m[1], /color:\s*var\(--text-primary\)/);
});

test('disabled options stay readable (muted, not same as surface)', () => {
    const m = css.match(/select option:disabled[^{]*{([^}]*)}/);
    assert.ok(m, 'disabled option rule is missing');
    assert.match(m[1], /color:\s*var\(--text-muted\)/);
});
