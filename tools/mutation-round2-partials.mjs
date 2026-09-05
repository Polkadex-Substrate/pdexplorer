// Mutation harness for the round-2 PARTIAL residuals.
//
// Each entry reverts one property to its pre-fix state. A survivor means the
// suite does not cover that property — which has already happened twice in this
// round (an F-047 test that reimplemented the query instead of calling it, and
// getLowestScanFailure with no behavioural test at all), so this is run rather
// than assumed.
//
//   node tools/mutation-round2-partials.mjs

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const MUTANTS = [
    // --- F-049: the legacy-row purge ---
    ['lib/id-migration.js',
        'WHERE event_derived IS NULL OR event_derived != 1', 'WHERE event_derived = 1',
        'F-049 purge deletes the NEW rows instead of the legacy ones'],
    ['lib/id-migration.js',
        'if (out.total > 0 && out.candidates / out.total > maxFraction) {', 'if (false) {',
        'F-049 safety rail removed — a mis-set flag wipes the table'],
    ['lib/id-migration.js',
        'SUM(CASE WHEN event_derived IS NULL OR event_derived != 1 THEN 1 ELSE 0 END) AS legacy',
        'SUM(CASE WHEN event_derived != 1 THEN 1 ELSE 0 END) AS legacy',
        'F-049 NULL event_derived no longer counted as legacy'],
    // Re-pointed twice: F-196 fixed the key NAMES (backfillCursor ->
    // txBackfillCursor) and F-203 fixed the VALUE (null -> an explicit
    // height). Each change silently turned this into a SKIP.
    ['db.js',
        'scannerVersion: null,\n                        txBackfillCursor: postPurgeBackfillCursor(st),\n                        txBackfillComplete: false',
        'scannerVersion: null',
        'F-049 re-crawl no longer resets the backfill — deleted history is not re-derived'],
    ['db.js',
        "                        scannerVersion: null,", '',
        'F-049 no re-crawl at all after the purge — double-count becomes a missing row'],
    ['db.js',
        "if (seedCounts && !getKv('migration:purge-legacy-tx-rows')) {",
        "if (seedCounts && !getKv('migration:hash-keyed-ids')) {",
        'F-049 purge hidden behind the already-completed flag (dead code)'],

    // --- F-133: one escaper ---
    ['lib/html-escape.js',
        "'&': '&amp;',", "",
        'F-133 ampersand no longer escaped (entity double-decode)'],
    ['lib/html-escape.js',
        'String(value == null ? \'\' : value)', 'String(value)',
        'F-133 null becomes the literal "null"'],
    ['server.js',
        'function htmlEscape(s) {\n    return sharedEscapeHtml(s);\n}',
        'function htmlEscape(s) {\n    return String(s == null ? \'\' : s).replace(/&/g, \'&amp;\');\n}',
        'F-133 server hand-rolls its own escaper again'],

    // --- F-118: the motion-close digit check ---
    ['script.js',
        "const idx = /^\\d+$/.test(rawIndex) ? Number(rawIndex) : NaN;",
        'const idx = Number(rawIndex);',
        'F-118 councilMotionClose accepts a non-numeric index again'],

    // --- F-120: cookies reset revokes the session ---
    ['script.js',
        "        revokeDiscussSession();\n        try {\n            // Walk a snapshot of keys",
        "        try {\n            // Walk a snapshot of keys",
        'F-120 cookies reset leaves the server session alive'],

    // --- F-067: BigInt formatting ---
    ['script.js',
        'return formatLivePDEX(balance).toLocaleString',
        'return (Number(balance) / 10 ** 12).toLocaleString',
        'F-067 formatPDEX back to Number()/1e12'],

    // --- F-060: one document ---
    ['lib/api-reference.js',
        "{ id: 'caching',     title: 'Caching tiers',                                   toc: 'Caching' },", '',
        'F-060 a section vanishes from the outline but stays in one renderer'],
    ['lib/api-reference.js',
        '`<section${cls} id="${esc(entry.id)}">', '`<section${cls}>',
        'F-060 sections lose their anchors — every shared #link breaks'],

    // --- F-083: the cache tiers ---
    ['lib/api-reference.js',
        "routes: ['/api/wallet/:address', '/api/identity/:address',",
        "routes: ['/api/identity/:address',",
        'F-083 the wallet dashboard drops out of the no-shared-cache tier'],

    // --- F-047 / F-004 regression guards (from the earlier batches) ---
    ['db.js',
        'SELECT MIN(number) AS n FROM blocks WHERE number > ?',
        'SELECT MAX(number) AS n FROM blocks WHERE number > ?',
        'F-047 upper seam snap points the wrong way'],
    ['lib/watermark.js',
        'if (fail != null && Number.isFinite(fail)) mark = Math.min(mark, fail - 1);', '',
        'F-004 the failure queue no longer pins the watermark']
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
