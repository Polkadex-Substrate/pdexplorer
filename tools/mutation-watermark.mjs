// Mutation harness for the F-004 / F-009 / F-010 watermark split.
//
// A passing test suite proves the code does what the tests say; it does not
// prove the tests would notice if the fix were removed. That distinction has
// mattered repeatedly in this repo — an earlier draft of the F-047 tests
// reimplemented the query it was meant to check, and a mutant that disabled the
// real one survived.
//
// Each entry below reverts ONE property to its pre-fix state. A survivor means
// the suite does not actually cover that property.
//
//   node tools/mutation-watermark.mjs

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTANTS = [
    // --- lib/watermark.js: the derivation itself ---
    ['lib/watermark.js',
        'if (fail != null && Number.isFinite(fail)) mark = Math.min(mark, fail - 1);', '',
        'the failure queue no longer pins the watermark (this IS the finding)'],
    ['lib/watermark.js',
        'mark = Math.min(mark, fail - 1)', 'mark = Math.min(mark, fail)',
        'off-by-one: the watermark includes the missing block'],
    ['lib/watermark.js',
        'mark = Math.min(mark, fail - 1)', 'mark = fail - 1',
        'a failure above the span top inflates the claim'],
    ['lib/watermark.js',
        'const legacy = numeric(state.latestScannedBlock, NaN);', 'const legacy = NaN;',
        'readHeadSeen drops pre-upgrade state (re-walks the chain from genesis)'],
    ['lib/watermark.js',
        'if (numeric(headSeen, 0) < numeric(head, 0)) return false;', '',
        'isCaughtUp ignores being behind head'],
    ['lib/watermark.js',
        'return lowestOutstandingFailure == null || !Number.isFinite(numeric(lowestOutstandingFailure, NaN));',
        'return true;',
        "isCaughtUp reports caught-up with a non-empty skip queue"],

    // --- server.js: the wiring, which is where round 1 went wrong ---
    ['server.js',
        'const edgeGaps = db.getEdgeGaps(oldestScannedBlock, headSeen);',
        'const edgeGaps = db.getEdgeGaps(oldestScannedBlock, latestScannedBlock);',
        'edge gaps measured against the derived mark — a suffix hole hides itself'],
    ['server.js',
        'let headSeen = readHeadSeen(state);', 'let headSeen = Number(state.headSeen) || 0;',
        'a scanner bypasses readHeadSeen (first mention only)'],

    // --- db.js: the query the derivation reads ---
    ['db.js',
        "'SELECT MIN(block) AS lo FROM scan_failures WHERE indexer = ?'",
        "'SELECT MAX(block) AS lo FROM scan_failures WHERE indexer = ?'",
        'lowest outstanding failure becomes the highest — pins the watermark to the wrong hole']
];

let survived = 0, skipped = 0;
for (const [file, from, to, label] of MUTANTS) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes(from)) { console.log(`SKIP     ${label}`); skipped++; continue; }
    copyFileSync(file, `${file}.bak`);
    writeFileSync(file, src.replace(from, to));
    let caught = false;
    try {
        execSync("node --test 'test/**/*.test.js' 2>&1 | grep -q '# fail 0'", { stdio: 'pipe' });
    } catch { caught = true; }
    copyFileSync(`${file}.bak`, file);
    rmSync(`${file}.bak`, { force: true });
    if (caught) console.log(`KILLED   ${label}`);
    else { console.log(`SURVIVED ${label}   <-- NOT COVERED`); survived++; }
}
console.log(`\n${MUTANTS.length} mutants: ${MUTANTS.length - survived - skipped} killed, ${survived} survived, ${skipped} skipped`);
process.exit(survived ? 1 : 0);
