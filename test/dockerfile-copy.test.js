// Does the backend image actually contain the files the backend imports?
//
// This test exists because of a real outage on 2026-08-22. server.js gained
// `import { isOpenGovStatus } from './lib/gov-status.js'`, but
// Dockerfile.backend copies an EXPLICIT file list (not `COPY . .`) and lib/
// was not on it. Result: the container crash-looped on ERR_MODULE_NOT_FOUND,
// every /api/* route went dark, and — because nginx kept serving the SPA and
// the browser's own WebSocket kept streaming blocks — the site LOOKED alive
// with every backend-derived figure blank. It took two deploys to close.
//
// `node --check` cannot catch this: it validates syntax file by file and has
// no opinion about what gets shipped. The defect lives in the gap between the
// source tree and the built artifact, so the assertion has to compare those
// two things directly — which is all this file does.
//
// It is intentionally dumb: parse the COPY lines, parse the relative imports,
// assert every import is covered. No Docker required, runs in milliseconds.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

// Every path the Dockerfile copies into the image, as written.
function copiedPaths(dockerfile) {
    const out = [];
    for (const line of dockerfile.split('\n')) {
        const m = line.match(/^COPY\s+(.*)$/);
        if (!m) continue;
        // Drop flags (--chown=..., --from=...); last token is the destination.
        const parts = m[1].trim().split(/\s+/).filter(p => !p.startsWith('--'));
        if (parts.length < 2) continue;
        out.push(...parts.slice(0, -1));
    }
    return out;
}

// Relative specifiers an entrypoint imports at runtime.
function relativeImports(src) {
    return [...src.matchAll(/(?:from|import)\s+['"](\.\/[^'"]+)['"]/g)].map(m => m[1]);
}

describe('Dockerfile.backend COPY list covers server.js imports', () => {
    const dockerfile = read('Dockerfile.backend');
    const copied = copiedPaths(dockerfile);
    const imports = relativeImports(read('server.js'));

    test('server.js declares at least one relative import (guard against a no-op test)', () => {
        assert.ok(imports.length > 0, 'parser found no relative imports — regex probably broke');
    });

    test('every relative import server.js declares is copied into the image', () => {
        for (const spec of imports) {
            const rel = spec.replace(/^\.\//, '');            // lib/gov-status.js
            const topDir = rel.split('/')[0];                  // lib
            const covered = copied.includes(rel) || copied.includes(topDir);
            assert.ok(covered,
                `server.js imports '${spec}' but Dockerfile.backend never COPYs ` +
                `'${rel}' or '${topDir}'. The container will die at startup with ` +
                `ERR_MODULE_NOT_FOUND and every /api/* route will go dark while ` +
                `the SPA keeps serving. Add it to the COPY list.`);
        }
    });

    test('every path the Dockerfile COPYs exists in the repo', () => {
        // The mirror-image failure: a COPY of a path that was never committed
        // fails the BUILD instead of the runtime. Same outage, different half.
        for (const p of copied) {
            if (p === './' || p === '.') continue;
            const clean = p.replace(/\*.*$/, '');              // package-lock.json* → package-lock.json
            if (!clean) continue;
            assert.ok(existsSync(path.join(ROOT, clean)),
                `Dockerfile.backend COPYs '${p}' which does not exist in the repo — ` +
                `the image build will fail. Either commit it or drop the COPY line.`);
        }
    });
});

describe('lib/ modules are self-contained', () => {
    // lib/ ships into the backend image; if a lib module imported something
    // from the repo root that ISN'T copied, we would reintroduce the same
    // outage one level deeper.
    for (const mod of ['lib/gov-status.js', 'lib/wallet-safety.js']) {
        test(`${mod} imports nothing outside lib/ or node_modules`, () => {
            const bad = relativeImports(read(mod)).filter(s => s.includes('..'));
            assert.deepEqual(bad, [],
                `${mod} reaches outside lib/ (${bad.join(', ')}); those files are not ` +
                `guaranteed to be in the backend image.`);
        });
    }
});
