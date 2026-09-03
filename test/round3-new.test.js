// Round 3: F-196 through F-200.
//
// Three of the five are defects in MY OWN round-2 remediation, and two of those
// share one root cause worth naming, because it has now produced three separate
// production bugs in two rounds:
//
//   I asserted the shape of something I did not read, and then wrote a test
//   from the same assumption — so the test agreed with the bug and passed.
//
//     F-049/F-196  the purge wrote `backfillCursor`; the scanner reads
//                  `txBackfillCursor`. The reset was a no-op; the test grepped
//                  the misspelled names.
//     (F-081)      the cache guard used `Array.isArray(series)`; series is an
//                  object of named arrays. The cache-hit branch was unreachable.
//
// The countermeasure, used throughout this file: derive the expected value from
// the PRODUCER or the CONSUMER in the test itself, never restate it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments } from './helpers/source.js';
import { wasElectedInEra } from '../lib/commission-history.js';

const serverSrc = readRepo('server.js', import.meta.url);
const server = stripComments(serverSrc);
const dbSrc = stripComments(readRepo('db.js', import.meta.url));
// Shell sources are comment-stripped for the same reason JS ones are: several
// assertions below are "this pattern must NOT appear", and the comment that
// explains why it must not appear quotes the pattern. Both of these bit on the
// first run — the `-x` test and the heredoc scan each matched my own prose.
const initLE = readRepo('init-letsencrypt.sh', import.meta.url);
const provision = stripComments(readRepo('provision-ubuntu.sh', import.meta.url), { line: '#', block: false });
const verifyRaw = readRepo('tools/verify-deploy.sh', import.meta.url);
const verify = stripComments(verifyRaw, { line: '#', block: false });

// ─────────────────────────────────────────────────────────────────────────────
// F-196 — the purge must reset the field the scanner reads
// ─────────────────────────────────────────────────────────────────────────────

describe('F-196 — purge resets the backfill keys the scanner actually reads', () => {
    // The field names come from the READER. Restating them here is what let the
    // original bug through.
    const readerFields = (() => {
        const at = serverSrc.lastIndexOf("const state = db.getSyncState('transactions');");
        assert.ok(at !== -1, 'the transactions scanner moved — re-point this test');
        const reader = serverSrc.slice(at, at + 4000);
        return {
            cursor: (reader.match(/state\.(\w*[Bb]ackfillCursor)/) || [])[1],
            complete: (reader.match(/state\.(\w*[Bb]ackfillComplete)/) || [])[1]
        };
    })();

    const purgeBlock = (() => {
        const purgeAt = dbSrc.indexOf('purgeLegacyExtrinsicKeyedTx(db');
        const setAt = dbSrc.indexOf("setSyncState('transactions', {", purgeAt);
        assert.ok(setAt !== -1, 'the purge no longer resets the transactions sync state');
        return dbSrc.slice(setAt, dbSrc.indexOf('});', setAt));
    })();

    test('the reader uses tx-prefixed names', () => {
        assert.equal(readerFields.cursor, 'txBackfillCursor');
        assert.equal(readerFields.complete, 'txBackfillComplete');
    });

    test('the writer resets exactly those', () => {
        assert.ok(purgeBlock.includes(`${readerFields.cursor}: null`),
            `the purge resets a cursor field the scanner does not read (expected ${readerFields.cursor})`);
        assert.ok(purgeBlock.includes(`${readerFields.complete}: false`),
            `the purge resets a complete field the scanner does not read (expected ${readerFields.complete})`);
    });

    test('and writes no un-read look-alikes alongside', () => {
        // Writing the right key is not enough if the wrong one is still written:
        // it sits in the row forever looking meaningful to the next reader.
        assert.ok(!/\n\s+backfillCursor: null/.test(purgeBlock));
        assert.ok(!/\n\s+backfillComplete: false/.test(purgeBlock));
    });

    test('scannerVersion is still cleared too', () => {
        assert.match(purgeBlock, /scannerVersion: null/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-198 — un-elected eras are not history, on EVERY surface
// ─────────────────────────────────────────────────────────────────────────────

describe('F-198 — one elected-era predicate, shared', () => {
    test('wasElectedInEra keeps rows with real stake', () => {
        assert.equal(wasElectedInEra({ era: 1, commission: 95, stake: 1000 }), true);
    });

    test('it drops the ValueQuery phantoms', () => {
        // erasValidatorPrefs answers an un-elected era with DEFAULT prefs — 0%
        // commission, 0 stake — not with "no answer".
        assert.equal(wasElectedInEra({ era: 1, commission: 0, stake: 0 }), false);
        assert.equal(wasElectedInEra({ era: 1, commission: 0, stake: '0' }), false);
    });

    test('it KEEPS rows with no stake column at all', () => {
        // A caller that did not select `stake` must not have its history
        // silently emptied — the guard tests a present value, not truthiness.
        assert.equal(wasElectedInEra({ era: 1, commission: 5 }), true);
        assert.equal(wasElectedInEra({ era: 1, commission: 5, stake: null }), true);
        assert.equal(wasElectedInEra({ era: 1, commission: 5, stake: undefined }), true);
    });

    test('junk is not elected', () => {
        assert.equal(wasElectedInEra(null), false);
        assert.equal(wasElectedInEra(undefined), false);
    });

    test('the scorecard derives commission stats from elected eras only', () => {
        // The APY average already filtered, with a comment saying why. The
        // commission stats next to it did not — so a validator who has charged
        // 95% throughout showed min 0% the moment they had ever been idle, and
        // the detail page contradicted the correctly-filtered list.
        const fn = server.slice(server.indexOf('function computeValidatorScorecard('),
                                server.indexOf('function computeValidatorScorecard(') + 1800);
        assert.match(fn, /const activeEntries = history\.filter\(wasElectedInEra\)/);
        assert.match(fn, /const commissions = activeEntries\.map/,
            'commission stats read the UNFILTERED history — that IS F-198');
        assert.ok(!/const commissions = history\.map/.test(fn));
    });

    test('the >50% spike triggers filter too', () => {
        const fn = server.slice(server.indexOf('function getCommissionTriggers('),
                                server.indexOf('function getCommissionTriggers(') + 900);
        assert.match(fn, /history\.filter\(wasElectedInEra\)/,
            'a first-time validator already above 50% still fabricates a 0%→51% crossing');
    });

    test('the predicate is imported, not re-implemented', () => {
        // Three copies of `Number(h.stake) > 0` is how the list and the detail
        // page came to disagree in the first place.
        assert.match(server, /import \{[^}]*wasElectedInEra[^}]*\} from '\.\/lib\/commission-history\.js'/);
        assert.ok(!/history\.filter\(h => Number\(h\.stake\) > 0\)/.test(server),
            'a hand-rolled copy of the predicate is back');
    });

    test('already-stored fabricated triggers are rebuilt once', () => {
        // mergeValidatorTriggers is additive by design (F-115), so fixing the
        // producer does nothing for rows already written — they never age out.
        assert.match(dbSrc, /export function rebuildValidatorTriggers/);
        assert.match(dbSrc, /migration:rebuild-commission-triggers/);
        assert.match(dbSrc, /replaceValidatorTriggers\(address, rebuilt\)/,
            'the rebuild merges instead of replacing — the bogus rows survive');
        assert.match(server, /db\.rebuildValidatorTriggers\(getCommissionTriggers\)/,
            'the rebuild is never called');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-199 — the history-depth clamp applies to BOTH walkers
// ─────────────────────────────────────────────────────────────────────────────

describe('F-199 — no walker reads past historyDepth', () => {
    test('the clamp is one shared function', () => {
        assert.match(server, /function historyDepthCap\(\)/);
        assert.equal((server.match(/historyDepthCap\(\)/g) || []).length, 3,
            'expected one declaration and two call sites');
    });

    test('it is at MODULE scope, reachable from both callers', () => {
        // It was first written inside syncValidatorHistory, which parses fine
        // and throws ReferenceError at runtime on the detail page. `node
        // --check` cannot see that; brace-depth can.
        const at = server.indexOf('function historyDepthCap()');
        const before = server.slice(0, at);
        let depth = 0, str = null, cmt = null;
        for (let i = 0; i < before.length; i++) {
            const c = before[i], n = before[i + 1];
            if (cmt === 'line') { if (c === '\n') cmt = null; continue; }
            if (cmt === 'block') { if (c === '*' && n === '/') { cmt = null; i++; } continue; }
            if (str) { if (c === '\\') { i++; continue; } if (c === str) str = null; continue; }
            if (c === '/' && n === '/') { cmt = 'line'; i++; continue; }
            if (c === '/' && n === '*') { cmt = 'block'; i++; continue; }
            if (c === '"' || c === "'" || c === '`') { str = c; continue; }
            if (c === '{') depth++; else if (c === '}') depth--;
        }
        assert.equal(depth, 0,
            'historyDepthCap is nested inside another function — the detail-page caller would ReferenceError');
    });

    test('both walkers use it', () => {
        for (const fnName of ['async function syncValidatorHistory(', 'async function loadValidatorHistory(']) {
            const i = server.indexOf(fnName);
            assert.ok(i !== -1, `${fnName} moved`);
            const fn = server.slice(i, i + 3000);
            assert.match(fn, /historyDepthCap\(\)/, `${fnName} walks the raw configured window`);
            assert.ok(!/activeEra - VALIDATOR_HISTORY_ERAS \+ 1/.test(fn),
                `${fnName} still uses the unclamped env value — raising it rewrites history over pruned eras`);
        }
    });

    test('the clamp is against the chain constant, not a literal', () => {
        const fn = server.slice(server.indexOf('function historyDepthCap()'),
                                server.indexOf('function historyDepthCap()') + 900);
        assert.match(fn, /consts\?\.staking\?\.historyDepth/);
        assert.match(fn, /return hd;/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-197 — the cert bootstrap must not report success without a cert
// ─────────────────────────────────────────────────────────────────────────────

describe('F-197 — the keep-existing guard tests a certificate', () => {
    test('it no longer keys off the bind-mount directory', () => {
        // compose creates $CERTBOT_PATH as an empty bind mount before anything
        // is issued, so `[ -d "$data_path" ]` is TRUE on a first deploy.
        assert.ok(!/^if \[ -d "\$data_path" \]; then$/m.test(initLE),
            'the guard tests the parent directory again — a first deploy skips issuance and reports success');
    });

    test('it tests a real fullchain.pem for this domain', () => {
        assert.match(initLE, /cert_live="\$data_path\/conf\/live\/\$\{domains\[0\]\}\/fullchain\.pem"/);
        assert.match(initLE, /if \[ -s "\$cert_live" \]; then/,
            'an empty file would count as a kept certificate');
    });

    test('FORCE=1 still overrides', () => {
        assert.match(initLE, /if \[ "\$\{FORCE:-0\}" = "1" \]; then/);
    });

    test('provision invokes it the same way deploy.sh does', () => {
        // Git mode is 100644, so `[ -x ./init-letsencrypt.sh ]` was false in a
        // fresh checkout and the branch never ran.
        assert.ok(!/\[ -x \.\/init-letsencrypt\.sh \]/.test(provision),
            'provision gates on the executable bit — dead in a fresh checkout');
        assert.match(provision, /if \[ -f \.\/init-letsencrypt\.sh \]; then/);
        assert.match(provision, /bash \.\/init-letsencrypt\.sh/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-200 — a verification script must not be green over a red line
// ─────────────────────────────────────────────────────────────────────────────

describe('F-200 — failures propagate out of the embedded checks', () => {
    test('no embedded block prints FAIL and then exits 0', () => {
        // A python3 subprocess cannot assign to the parent shell's FAILED, so
        // printing a red line and returning 0 leaves the footer green.
        const blocks = verify.split(/<<'PY'/).slice(1);
        assert.ok(blocks.length >= 2, 'expected at least two embedded python checks');
        for (const b of blocks) {
            const body = b.split(/^PY$/m)[0];
            if (/FAIL/.test(body)) {
                assert.match(body, /sys\.exit\(1\)/,
                    'an embedded block prints FAIL without a non-zero exit — the footer prints green over it');
            }
            assert.ok(!/sys\.exit\(0\)\s*$/m.test(body.replace(/#.*$/gm, '')),
                'an embedded block still exits 0 on a failure path');
        }
    });

    test('the shell checks those exit statuses', () => {
        assert.match(verify, /^pycheck\(\) \{/m);
        assert.match(verify, /if python3 "\$@"; then :; else fail "\$label"; fi/);
        assert.ok(!/^python3 - \/tmp\//m.test(verify),
            'a python block is invoked directly again — its exit status is unchecked');
    });

    test('the script exits non-zero when anything failed', () => {
        // A cron job or CI wrapper cannot read the colour.
        assert.match(verify, /\[ "\$FAILED" -eq 0 \] \|\| exit 1/);
    });

    test('the expected SHA is a parameter, not baked into the filename', () => {
        // Pinned to one build, it reported a permanent red mismatch on every
        // later deploy — training the operator to ignore red.
        assert.match(verify, /EXPECTED_SHA="\$\{1:-\$\(git rev-parse --short=12 HEAD/);
        assert.match(verify, /\[ "\$BE" = "\$EXPECTED_SHA" \]/);
        assert.match(verify, /\[ "\$FE" = "\$EXPECTED_SHA" \]/);
    });

    test('the old SHA-pinned filename is gone', () => {
        assert.throws(() => readRepo('tools/verify-deploy-f4ea9037d598.sh', import.meta.url),
            'the stale SHA-pinned script is still present alongside the general one');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-196 catch-up — hosts the BUGGY build already migrated
// ─────────────────────────────────────────────────────────────────────────────
//
// The purge is one-shot behind a kv flag. On any host where the broken build
// already ran it, the flag is set, so fixing the field names alone changes
// nothing: the purge block is skipped forever and the deleted heights stay
// missing. A fix that only helps not-yet-upgraded hosts is not a fix.
describe('F-196 — a database migrated by the buggy build is repaired', () => {
    // Anchor on CODE, not on the marker comment: `dbSrc` is comment-STRIPPED
    // (several assertions in this file are "must not appear" checks whose own
    // explanations quote the pattern), so an indexOf for a comment string
    // returns -1 and every slice from it is nonsense. The version constant is
    // the first line of the block that survives stripping.
    const catchUpAt = () => {
        const i = dbSrc.indexOf('const TX_PURGE_RESET_VERSION = 2;');
        assert.ok(i !== -1, 'the F-196 catch-up block moved — re-point this test');
        return i;
    };

    test('the flag carries a reset version', () => {
        assert.match(dbSrc, /const TX_PURGE_RESET_VERSION = 2;/);
        assert.match(dbSrc, /resetVersion: TX_PURGE_RESET_VERSION/);
    });

    test('a flag with no version and a non-zero delete triggers the replay', () => {
        assert.match(dbSrc, /prior && !prior\.resetVersion && Number\(prior\.deleted\) > 0/);
        const at = dbSrc.indexOf('prior && !prior.resetVersion && Number(prior.deleted) > 0');
        const block = dbSrc.slice(at, at + 900);
        assert.match(block, /txBackfillComplete: false/);
        assert.match(block, /txBackfillCursor: null/);
        assert.match(block, /scannerVersion: null/);
    });

    test('it does NOT re-run the destructive purge', () => {
        // The rows are already gone. Re-running a delete to repair the
        // bookkeeping around it would be a far worse trade — only the backfill
        // reset is replayed.
        const at = catchUpAt();
        const block = dbSrc.slice(at, dbSrc.indexOf("if (seedCounts && !getKv('migration:purge-legacy-tx-rows'))", at));
        assert.ok(!/purgeLegacyExtrinsicKeyedTx/.test(block),
            'the catch-up re-runs the purge — it must only replay the reset');
    });

    test('a versioned flag is left alone (the replay is one-shot)', () => {
        // Bounded by the next migration block, not a byte count — the comment
        // above the code is long enough that a fixed window ends inside it.
        // (This has now bitten five times in this project; use a delimiter.)
        const at = catchUpAt();
        const end = dbSrc.indexOf("if (seedCounts && !getKv('migration:purge-legacy-tx-rows'))", at);
        const block = dbSrc.slice(at, end);
        assert.match(block, /setKv\('migration:purge-legacy-tx-rows', \{ \.\.\.prior, resetVersion: TX_PURGE_RESET_VERSION, repairedAt/);
        assert.match(block, /else if \(prior && !prior\.resetVersion\)/,
            'a flag that recorded zero deletes is never stamped, so this re-checks every boot');
    });

    test('it runs on the indexer worker only', () => {
        // The guard sits BELOW the comment block, not above it — search forward
        // from the marker to the try, and require the seedCounts gate between.
        const at = catchUpAt();
        const tryAt = dbSrc.indexOf('const prior = getKv(', at);
        assert.ok(tryAt !== -1, 'the catch-up body moved');
        assert.match(dbSrc.slice(at, tryAt), /if \(seedCounts\) \{/,
            'every HTTP worker would race to rewrite the same sync-state row');
    });
});

describe('F-198 — the rebuild reports what it REMOVED, not just what it kept', () => {
    // Found by reading a production log line: "rebuilt commission triggers for
    // 223 validator(s), 373 genuine crossing(s) kept". That number says nothing
    // about whether any fabricated crossing was deleted — which is the entire
    // purpose of the migration. An operator could not distinguish a real
    // cleanup from a no-op, and once the flag is set the count is gone for good.
    test('it counts the prior rows before replacing them', () => {
        const fn = dbSrc.slice(dbSrc.indexOf('export function rebuildValidatorTriggers'),
                               dbSrc.indexOf('export function rebuildValidatorTriggers') + 1600);
        assert.match(fn, /before \+= \(getValidatorTriggers\(address\) \|\| \[\]\)\.length;/,
            'the rebuild cannot report what it removed');
        assert.match(fn, /const removed = Math\.max\(0, before - triggers\);/);
        assert.match(fn, /removed,/, 'the delta is not persisted with the flag');
    });

    test('the boot log states the delta', () => {
        const i = server.indexOf('rebuilt commission triggers for');
        assert.ok(i !== -1, 'the rebuild log line moved');
        const line = server.slice(i, i + 260);
        assert.match(line, /\$\{r\.before\}/);
        assert.match(line, /\$\{r\.removed\}/, 'the log still reports only what was kept');
    });
});
