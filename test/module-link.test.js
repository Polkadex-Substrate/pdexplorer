// Every entry module parses, and every named import it asks for exists.
//
// Why: merging main into the @polkadot/api 17 branch (2026-10-27) was
// textually clean, the whole suite passed, and server.js could not start:
// both sides had added `blake2AsHex` to its imports on different lines, and a
// duplicate import binding is a SyntaxError. No test loaded server.js, so
// nothing saw it. The same blind spot covers a named import that a merge or
// a dependency bump removes from the module it comes from (ERR_MODULE_NOT_FOUND
// / "does not provide an export named"), which also only shows at startup.
//
// What this checks, without starting anything:
//   1. `node --check` on server.js, db.js, email.js, script.js, every lib/*.js,
//      scripts/*.mjs, tools/**/*.mjs and vite.config.js (syntax, including
//      duplicate bindings);
//   2. for server.js, db.js, email.js and script.js: each `import { a, b }
//      from '<relative or @polkadot/*>'` names something the target module
//      really exports, under the installed dependencies.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir, re) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) return [];
    const out = [];
    for (const name of readdirSync(abs)) {
        const rel = join(dir, name);
        if (statSync(join(ROOT, rel)).isDirectory()) { if (name !== 'node_modules') out.push(...listFiles(rel, re)); }
        else if (re.test(name)) out.push(rel);
    }
    return out;
}

const ENTRY = ['server.js', 'db.js', 'email.js', 'script.js'].filter(f => existsSync(join(ROOT, f)));
const PARSE = [...ENTRY, 'vite.config.js', ...listFiles('lib', /\.js$/), ...listFiles('scripts', /\.m?js$/), ...listFiles('tools', /\.mjs$/)]
    .filter(f => existsSync(join(ROOT, f)));

// Static `import { ... } from '...'` statements (possibly spanning lines).
// Default and namespace imports are not checked; `x as y` checks x.
export function namedImports(src) {
    const out = [];
    const re = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;
    let m;
    while ((m = re.exec(src)) !== null) {
        const line = src.slice(0, m.index).split('\n').length;
        const names = m[1].split(',').map(s => s.trim()).filter(Boolean).map(s => {
            const [imported, local] = s.split(/\s+as\s+/);
            return { imported: imported.trim(), local: (local || imported).trim() };
        });
        out.push({ from: m[2], names, line });
    }
    return out;
}

describe('every module parses (node --check)', () => {
    for (const f of PARSE) {
        test(f, () => {
            const r = spawnSync(process.execPath, ['--check', join(ROOT, f)], { encoding: 'utf8' });
            const why = (r.stderr || '').split('\n').filter(Boolean).slice(0, 6).join('\n');
            assert.equal(r.status, 0, `${f} does not parse, so it cannot load:\n${why}`);
        });
    }
});

describe('every named import exists in its module', () => {
    for (const f of ENTRY) {
        test(f, async () => {
            const src = readFileSync(join(ROOT, f), 'utf8');
            const problems = [];
            const seen = new Map();
            for (const imp of namedImports(src)) {
                for (const n of imp.names) {
                    if (seen.has(n.local)) problems.push(`line ${imp.line}: '${n.local}' is already imported on line ${seen.get(n.local)} (a duplicate binding is a SyntaxError)`);
                    else seen.set(n.local, imp.line);
                }
                const relative = imp.from.startsWith('./') || imp.from.startsWith('../');
                if (!relative && !imp.from.startsWith('@polkadot/')) continue;
                let mod;
                try {
                    mod = await import(relative ? pathToFileURL(join(ROOT, dirname(f), imp.from)).href : imp.from);
                } catch (e) {
                    problems.push(`line ${imp.line}: cannot load '${imp.from}': ${String(e.message).split('\n')[0]}`);
                    continue;
                }
                for (const n of imp.names) {
                    if (!(n.imported in mod)) problems.push(`line ${imp.line}: '${imp.from}' has no export named '${n.imported}'`);
                }
            }
            assert.deepEqual(problems, [], `${f} would fail at startup:\n  ${problems.join('\n  ')}`);
        });
    }
});

describe('the import scanner itself', () => {
    test('reads multi-line imports, aliases, and reports duplicates the way the check above does', () => {
        const src = "import { a, b as c } from './x.js';\nimport {\n    d,\n    a\n} from '@polkadot/util';\n";
        const got = namedImports(src);
        assert.deepEqual(got.map(i => i.from), ['./x.js', '@polkadot/util']);
        assert.deepEqual(got[0].names, [{ imported: 'a', local: 'a' }, { imported: 'b', local: 'c' }]);
        assert.deepEqual(got[1].names.map(n => n.local), ['d', 'a']);
        assert.equal(got[1].line, 2);
    });
});
