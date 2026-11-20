// A test that replaces a global (Date.now, fetch, a console method) must put it back in a `finally`,
// also when an assertion fails, or every later test in the same file runs on the patched global.
// The repo's form: the patch statement(s), then straight away `try { ... } finally { restore }`
// (or `try { patch; ... } finally { restore }`). Anything between the patch and the `try` can throw
// and leave the patch in place. This scans the test files of the validator-alert and identity work.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PATCH = /^\s*(?:try\s*\{\s*)?(Date\.now|globalThis\.fetch|global\.fetch|console\.(?:error|warn|log))\s*=[^=]/;
const indentOf = (l) => l.match(/^\s*/)[0].length;

// Offences in a test source: a patch that is not followed at once by `try`, or has no `finally` after it.
export function findUnsafePatches(src, name = 'file') {
    const lines = src.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (!PATCH.test(lines[i])) continue;
        const at = `${name}:${i + 1}: ${lines[i].trim()}`;
        if (/\btry\b/.test(lines[i])) {                                   // `try { Date.now = ...`
            if (!/\bfinally\b/.test(lines.slice(i, i + 12).join('\n'))) out.push(`${at}  <- no finally after the patch`);
            continue;
        }
        // inside a try block: the nearest enclosing line (smaller indent) is `try {` and a finally follows
        let up = i - 1;
        while (up >= 0 && (lines[up].trim() === '' || indentOf(lines[up]) >= indentOf(lines[i]))) up--;
        if (up >= 0 && /\btry\s*\{\s*$/.test(lines[up])) {
            if (!/\bfinally\b/.test(lines.slice(i, i + 80).join('\n'))) out.push(`${at}  <- inside a try with no finally`);
            continue;
        }
        let j = i;
        // a multi-line function body: skip to its closing line, at the indent of the patch
        if (/[{(]\s*$/.test(lines[i])) {
            const ind = indentOf(lines[i]);
            j = i + 1;
            while (j < lines.length && !(indentOf(lines[j]) <= ind && /^\s*[})]/.test(lines[j]))) j++;
        }
        // further patch statements may follow, then the next statement must be `try`
        let k = j + 1;
        while (k < lines.length && (lines[k].trim() === '' || PATCH.test(lines[k]) || /^\s*\/\//.test(lines[k]))) k++;
        if (!/^\s*try\b/.test(lines[k] || '')) out.push(`${at}  <- not followed at once by try/finally; anything between can throw and leave the patch in place`);
        else if (!/\bfinally\b/.test(lines.slice(k, k + 60).join('\n'))) out.push(`${at}  <- no finally after the try`);
    }
    return out;
}

describe('tests that patch a global restore it in finally', () => {
    const files = fs.readdirSync(TEST_DIR).filter(f => /^(validator-alerts|validator-rollout|identity-)[\w-]*\.test\.js$/.test(f));
    test('there are files to scan', () => assert.ok(files.length >= 5, files.join(',')));
    for (const f of files) {
        test(f, () => {
            const found = findUnsafePatches(fs.readFileSync(path.join(TEST_DIR, f), 'utf8'), f);
            assert.deepEqual(found, []);
        });
    }

    test('the scan can fail (bad samples) and allows the repo forms', () => {
        const bad1 = `const real = Date.now;\nDate.now = () => 1;\nconst x = foo();\ntry { x(); } finally { Date.now = real; }\n`;
        assert.equal(findUnsafePatches(bad1).length, 1);
        const bad2 = `const r = globalThis.fetch;\nglobalThis.fetch = async (u) => {\n    return 1;\n};\nconst h = rig();\ntry {\n    go();\n} finally { globalThis.fetch = r; }\n`;
        assert.equal(findUnsafePatches(bad2).length, 1);
        const bad3 = `console.warn = () => {};\ntry { go(); } catch (e) { console.warn = w; }\n`;
        assert.equal(findUnsafePatches(bad3).length, 1);
        const bad4 = `try { Date.now = () => 1; go(); } catch (e) { throw e; }\n`;
        assert.equal(findUnsafePatches(bad4).length, 1);
        assert.deepEqual(findUnsafePatches(`const real = Date.now;\nDate.now = () => 1;\ntry { go(); } finally { Date.now = real; }\n`), []);
        assert.deepEqual(findUnsafePatches(`globalThis.fetch = async (u) => {\n    return 1;\n};\n_set(1);\ntry {\n    go();\n} finally { globalThis.fetch = r; }\n`.replace('_set(1);\n', '')), []);
        assert.deepEqual(findUnsafePatches(`console.error = (...a) => e.push(a);\nconsole.warn = (...a) => w.push(a);\ntry { await fn(); } finally { console.error = e0; console.warn = w0; }\n`), []);
        assert.deepEqual(findUnsafePatches(`const real = Date.now;\ntry { Date.now = () => 1; go(); } finally { Date.now = real; }\n`), []);
        assert.deepEqual(findUnsafePatches(`const w = console.warn;\ntry {\n    seed();\n    console.warn = () => {};\n    go();\n} finally { console.warn = w; }\n`), []);
        assert.equal(findUnsafePatches(`try {\n    console.warn = () => {};\n    go();\n} catch (e) { throw e; }\n`).length, 1);
    });
});
