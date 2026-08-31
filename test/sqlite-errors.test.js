// Tests for lib/sqlite-errors.js — audit F-181 (round 2).
//
// F-181 is an OVER-CORRECTION of F-022, and that framing drives the tests. Both
// directions are failures with real cost, so both are asserted:
//
//   retrying something structural  → a busy-loop against a problem that will
//                                    never resolve, hiding it from the operator
//   exiting on something transient → a five-second lock becomes a refork loop
//                                    and indexing stops until a quiet window
//                                    happens to appear
//
// The classifier is deliberately conservative — anything unrecognised is fatal —
// so the "unknown error" case is pinned too. Getting that backwards would mean
// an unfamiliar error silently retried forever.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    isTransientSqliteError, isFatalSqliteError, retryTransient
} from '../lib/sqlite-errors.js';

// node:sqlite reports the SQLITE_* token in `code` on some paths and only in
// the message on others, so both shapes are exercised throughout.
const err = (message, code) => Object.assign(new Error(message), code ? { code } : {});

describe('transient: contention, which a later attempt can survive', () => {
    const transient = [
        ['the message form node:sqlite surfaces', err('database is locked')],
        ['SQLITE_BUSY in code',                   err('failed', 'SQLITE_BUSY')],
        ['SQLITE_BUSY in message',                err('SQLITE_BUSY: database is busy')],
        ['SQLITE_LOCKED',                         err('SQLITE_LOCKED: table is locked')],
        ['table-level lock message',              err('database table is locked')],
        ['WAL recovery contention',               err('SQLITE_PROTOCOL: locking protocol')],
        ['a cancelled query',                     err('SQLITE_INTERRUPT: interrupted')],
        ['a lost BEGIN race',                     err('cannot start a transaction within a transaction')]
    ];
    for (const [name, e] of transient) {
        test(`${name} is transient`, () => {
            assert.equal(isTransientSqliteError(e), true);
            assert.equal(isFatalSqliteError(e), false);
        });
    }
});

describe('fatal: structural, where retrying only hides the problem', () => {
    const fatal = [
        ['corruption',        err('SQLITE_CORRUPT: database disk image is malformed')],
        ['not a database',    err('file is not a database', 'SQLITE_NOTADB')],
        ['cannot open',       err('unable to open database file', 'SQLITE_CANTOPEN')],
        ['read-only',         err('attempt to write a readonly database', 'SQLITE_READONLY')],
        ['disk full',         err('database or disk is full', 'SQLITE_FULL')],
        ['I/O error',         err('disk I/O error', 'SQLITE_IOERR')],
        ['permissions',       err('EACCES: permission denied')],
        ['missing path',      err('ENOENT: no such file or directory')],
        ['no space',          err('ENOSPC: no space left on device')]
    ];
    for (const [name, e] of fatal) {
        test(`${name} is fatal`, () => {
            assert.equal(isFatalSqliteError(e), true);
            assert.equal(isTransientSqliteError(e), false, 'a structural failure must never be retried');
        });
    }
});

describe('ambiguity resolves toward STOP', () => {
    test('a message mentioning both is fatal', () => {
        // An I/O error reported while a lock was held. Retrying a failing disk
        // forever is worse than one restart the operator can see.
        const e = err('SQLITE_IOERR while database is locked');
        assert.equal(isTransientSqliteError(e), false);
        assert.equal(isFatalSqliteError(e), true);
    });

    test('an UNRECOGNISED error is not transient', () => {
        // The conservative default. If this inverted, an unfamiliar failure
        // would be retried until the attempt budget ran out on every boot.
        const e = err('something nobody has seen before');
        assert.equal(isTransientSqliteError(e), false);
        assert.equal(isFatalSqliteError(e), false, 'unknown is not claimed to be fatal either — just not retried');
    });

    test('null / undefined / non-errors do not throw', () => {
        for (const v of [null, undefined, '', 0, {}, 'a string']) {
            assert.doesNotThrow(() => isTransientSqliteError(v));
            assert.doesNotThrow(() => isFatalSqliteError(v));
        }
        assert.equal(isTransientSqliteError(null), false);
    });
});

describe('retryTransient', () => {
    const noSleep = () => {};

    test('returns the value once the lock clears', () => {
        let n = 0;
        const out = retryTransient(() => {
            if (++n < 3) throw err('database is locked');
            return 'ok';
        }, { sleep: noSleep });
        assert.equal(out, 'ok');
        assert.equal(n, 3);
    });

    test('a fatal error is thrown on the FIRST attempt, not retried', () => {
        let n = 0;
        assert.throws(() => retryTransient(() => { n++; throw err('SQLITE_CORRUPT'); }, { sleep: noSleep }));
        assert.equal(n, 1, 'a corrupt database was retried');
    });

    test('it gives up after `attempts` and rethrows the last error', () => {
        let n = 0;
        assert.throws(
            () => retryTransient(() => { n++; throw err('database is locked'); }, { attempts: 4, sleep: noSleep }),
            /database is locked/);
        assert.equal(n, 4);
    });

    test('a first-try success does not sleep at all', () => {
        let slept = 0;
        retryTransient(() => 'fine', { sleep: () => { slept++; } });
        assert.equal(slept, 0);
    });

    test('the delay backs off and is capped', () => {
        const delays = [];
        try {
            retryTransient(() => { throw err('database is locked'); },
                { attempts: 6, baseDelayMs: 100, maxDelayMs: 400, sleep: (ms) => delays.push(ms) });
        } catch (_) { /* expected */ }
        assert.deepEqual(delays, [100, 200, 400, 400, 400],
            'delays must double then hold at the cap — an uncapped doubling waits minutes at boot');
    });

    test('onRetry reports each attempt for the log', () => {
        const seen = [];
        try {
            retryTransient(() => { throw err('database is locked'); },
                { attempts: 3, sleep: noSleep, onRetry: (e, i, d) => seen.push([i, d]) });
        } catch (_) { /* expected */ }
        // Two retries between three attempts.
        assert.equal(seen.length, 2);
        assert.equal(seen[0][0], 1);
    });

    test('the default sleep does not spin a core', () => {
        // A `while (Date.now() < end)` fallback would burn 100% CPU for up to
        // eight seconds at boot. Atomics.wait blocks properly.
        const src = readFileSync(new URL('../lib/sqlite-errors.js', import.meta.url), 'utf8');
        const fn = src.slice(src.indexOf('function defaultSleep'));
        assert.match(fn, /Atomics\.wait/);
        // The busy-wait exists only as a fallback for a missing SharedArrayBuffer.
        assert.match(fn, /catch \(_\) \{[\s\S]{0,200}while \(Date\.now\(\) < end\)/);
    });
});

describe('the boot path uses it', () => {
    const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

    test('initDb is wrapped in retryTransient', () => {
        assert.match(serverSrc, /retryTransient\(\s*\(\) => db\.initDb\(DATA_DIR/,
            'initDb exits on the first transient lock again — that IS F-181');
    });

    test('the fatal exit is still there for structural failures', () => {
        // F-022 must not be undone by F-181's fix. Both properties hold.
        const block = serverSrc.slice(
            serverSrc.indexOf('retryTransient('),
            serverSrc.indexOf('retryTransient(') + 1800
        );
        assert.match(block, /FATAL: database init failed/);
        assert.match(block, /process\.exit\(1\)/);
    });

    test('retries are logged, so a slow boot is explicable', () => {
        assert.match(serverSrc, /init hit a transient lock \(attempt/);
    });
});
