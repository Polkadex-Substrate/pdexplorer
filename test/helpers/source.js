// Shared source-reading helpers for the contract tests.
//
// `stripComments` exists because the same false positive has now bitten five
// separate assertions in this suite: a test greps a source file for a pattern,
// and matches the COMMENT that explains why the pattern must not appear — or,
// for ordering assertions, matches a mention of the later symbol inside a
// comment that precedes the earlier one.
//
// It is a real hazard rather than a nuisance: every instance made a test either
// vacuously pass or spuriously fail, and a test that fails for the wrong reason
// gets deleted by the next person rather than understood. Reading source is a
// legitimate technique here — script.js is a 15k-line browser bundle with no
// export surface — so the answer is one shared, correct stripper rather than
// five ad-hoc ones written under time pressure.
//
// Deliberately simple: line comments and whole-line block comments only. It is
// not a JS parser and does not need to be. Anything it misses shows up as a
// test that fails loudly, not as a wrong answer.

import { readFileSync } from 'node:fs';

// Remove comment lines so a "must not contain" or ordering check sees CODE.
//
//   line  — the line-comment token ('//' for JS, '#' for shell/nginx/yaml)
//   block — also drop whole-line /* … */ and leading-* continuation lines
export function stripComments(src, { line = '//', block = true } = {}) {
    let out = String(src || '').split('\n')
        .filter(l => !l.trim().startsWith(line))
        .join('\n');
    if (block) {
        // ONLY whole-line blocks. A naive /\/\*[\s\S]*?\*\// would pair prose
        // like "the /api/diag/* endpoints" with the next real `*/` and delete
        // hundreds of lines — turning every assertion in the file into a
        // tautology, which is the exact failure mode this helper prevents.
        out = out.split('\n').filter(l => {
            const t = l.trim();
            return !(t.startsWith('/*') || t.startsWith('*') || t === '*/');
        }).join('\n');
    }
    return out;
}

// Read a repo file, given a path relative to the repo root.
export function readRepo(relPath, importMetaUrl) {
    return readFileSync(new URL(`../${relPath}`, importMetaUrl), 'utf8');
}

// Assert that `a` appears before `b` in CODE, with a message saying what the
// ordering protects. Ordering assertions are the ones most often broken by a
// comment naming the later symbol first, so they get the shared helper.
export function assertOrder(assert, src, a, b, why) {
    const code = stripComments(src);
    const ia = code.indexOf(a);
    const ib = code.indexOf(b);
    assert.ok(ia !== -1, `not found in code (only in comments?): ${a}`);
    assert.ok(ib !== -1, `not found in code (only in comments?): ${b}`);
    assert.ok(ia < ib, why);
}
