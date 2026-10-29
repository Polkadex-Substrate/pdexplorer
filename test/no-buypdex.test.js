// buypdex.com is down (404), so the explorer must not link to it. The links
// are meant to come back pointing at the swap app, at which point this test is
// updated to the new URL rather than deleted.
//
// Source assertion over the shipped files. HTML comments are stripped first
// because the removal spots carry a comment that names the old site on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'test', 'outputs']);
const SKIP_FILES = new Set(['package-lock.json']);
const TEXT = /\.(html|js|mjs|cjs|css|json|md|txt|conf|xml|yml|yaml|sh|py)$/;

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
            if (!SKIP_DIRS.has(name)) walk(full, out);
        } else if (TEXT.test(name) && !SKIP_FILES.has(name)) {
            out.push(full);
        }
    }
    return out;
}

test('no shipped file references buypdex.com or a "Buy PDEX" link', () => {
    const offenders = [];
    for (const f of walk(ROOT)) {
        const src = readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        if (/buypdex/i.test(src) || /buy\s+pdex/i.test(src)) offenders.push(relative(ROOT, f));
    }
    assert.deepEqual(offenders, [], 'files still referencing Buy PDEX: ' + offenders.join(', '));
});

test('the removed sidebar section and footer column leave no empty heading', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!html.includes('Community Projects'), 'empty "Community Projects" heading left behind');
});
