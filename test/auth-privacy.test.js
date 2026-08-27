// Audit F-091 / F-120 / F-128 / F-135 — the auth and privacy tail.
//
// These four findings share a shape: the correct behaviour was already
// implemented somewhere and simply not reached. A logout route nobody called,
// an isSameAddress helper nobody used, a session lookup that ran too late, a
// log format nobody chose. Nothing here needs a runtime harness to detect a
// regression — it needs a check that the wiring is still connected.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const serverSrc = read('server.js');
const scriptSrc = read('script.js');
const nginxSrc  = read('nginx.conf');

describe('F-091 — bearer tokens must not reach the access log', () => {
    test('a query-stripped log format is defined', () => {
        assert.match(nginxSrc, /log_format\s+noquery\b/,
            'the noquery log_format is gone');
    });

    test('it logs $uri, never $request or $query_string', () => {
        const fmt = nginxSrc.slice(
            nginxSrc.indexOf('log_format noquery'),
            nginxSrc.indexOf(';', nginxSrc.indexOf('log_format noquery'))
        );
        assert.ok(fmt.includes('$uri'), 'the format no longer logs $uri');
        assert.ok(!fmt.includes('$request '), '$request includes the query string — that IS F-091');
        assert.ok(!fmt.includes('$query_string'), 'the query string is being logged verbatim');
        assert.ok(!fmt.includes('$request_uri'), '$request_uri includes the query string');
    });

    test('EVERY server block installs it', () => {
        // A review catch on the first version of this fix: the directive was
        // placed once at http level, where it does NOT suppress the base
        // image's own http-level `access_log ... main`. nginx writes to both,
        // so the token still reached the log and this test still passed.
        // Server level is what suppresses inheritance — so count the blocks.
        const code = nginxSrc.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
        const serverBlocks = (code.match(/^server \{/gm) || []).length;
        const installs = (code.match(/access_log\s+\/var\/log\/nginx\/access\.log\s+noquery\s*;/g) || []).length;
        assert.ok(serverBlocks > 0, 'no server blocks found — has the file moved?');
        assert.equal(installs, serverBlocks,
            `${serverBlocks} server block(s) but ${installs} noquery access_log(s): a block without one inherits the token-logging format`);
    });

    test('it is NOT left at http level, where it would merely add a second log line', () => {
        const code = nginxSrc.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
        const firstServer = code.search(/^server \{/m);
        const preamble = firstServer === -1 ? code : code.slice(0, firstServer);
        assert.ok(!/access_log/.test(preamble),
            'an http-level access_log does not replace the base image\'s — it doubles the log');
    });

    test('nothing re-enables a query-carrying format anywhere', () => {
        // A single non-noquery access_log in one location block silently
        // reopens the finding for that path. Strip comments first — the
        // explanation above this directive mentions the very pattern we are
        // searching for, and matching your own documentation is a false
        // positive that trains people to delete the test.
        const code = nginxSrc.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
        const enables = (code.match(/access_log\s+(?!off)\S+\s+(\w+)/g) || [])
            .filter(m => !m.includes('noquery'));
        assert.deepEqual(enables, [],
            `a location logs with a non-noquery format: ${enables.join(', ')}`);
    });

    test('the token-carrying routes are the ones this protects', () => {
        // Documents WHY the format matters, and fails loudly if these routes
        // stop taking their token from the query string in a future refactor
        // (at which point this test should be revisited, not deleted).
        assert.match(serverSrc, /app\.get\('\/api\/email\/preferences'/);
        assert.match(serverSrc, /const token = String\(req\.query\.token \|\| ''\)/);
    });
});

describe('F-120 — Disconnect revokes the server-side session', () => {
    const fn = scriptSrc.slice(
        scriptSrc.indexOf('function revokeDiscussSession()'),
        scriptSrc.indexOf('function disconnectWallet()')
    );

    test('the revoke helper exists and calls the logout route', () => {
        assert.ok(fn.length > 0, 'revokeDiscussSession is gone');
        assert.match(fn, /fetch\('\/api\/auth\/logout'/, 'the logout route is not called');
        assert.match(fn, /method:\s*'POST'/);
        assert.match(fn, /'Bearer '\s*\+\s*token/, 'the current bearer is not sent');
    });

    test('disconnectWallet calls it', () => {
        const dw = scriptSrc.slice(
            scriptSrc.indexOf('function disconnectWallet()'),
            scriptSrc.indexOf('function consumeSkipAutoPickFlag()')
        );
        assert.match(dw, /revokeDiscussSession\(\)/,
            'Disconnect no longer revokes the session — that IS F-120');
    });

    test('local state is cleared BEFORE the network call', () => {
        // If the removal depended on the fetch resolving, an offline user's
        // token would survive a Disconnect — the exact bug, inverted.
        const removeAt = fn.indexOf('removeItem(DISCUSS_TOKEN_KEY)');
        const fetchAt  = fn.indexOf("fetch('/api/auth/logout'");
        assert.ok(removeAt !== -1 && fetchAt !== -1);
        assert.ok(removeAt < fetchAt,
            'the local token is only cleared after the network call succeeds');
    });

    test('the call can never block or reject the disconnect', () => {
        assert.match(fn, /\.catch\(\(\)\s*=>\s*\{\}\)/, 'an unhandled rejection can escape');
        assert.ok(!/await\s+fetch/.test(fn), 'Disconnect must not wait on the network');
        assert.match(fn, /keepalive:\s*true/, 'the request dies if the page unloads');
    });

    test('the server route still deletes the row', () => {
        const route = serverSrc.slice(
            serverSrc.indexOf("app.post('/api/auth/logout'"),
            serverSrc.indexOf("app.post('/api/auth/logout'") + 400
        );
        assert.match(route, /db\.deleteSession\(token\)/);
    });
});

describe('F-128 — wallet binding compares keys, not strings', () => {
    const fn = scriptSrc.slice(
        scriptSrc.indexOf('function getDiscussSession()'),
        scriptSrc.indexOf('function getDiscussSession()') + 1400
    );

    test('getDiscussSession uses isSameAddress', () => {
        assert.match(fn, /!isSameAddress\(connected,\s*s\.address\)/,
            'the session is compared by string equality again (F-128)');
        assert.ok(!/connected\s*!==\s*s\.address/.test(fn),
            'the raw !== comparison is back');
    });

    test('isSameAddress decodes both sides rather than lowercasing or trimming', () => {
        const helper = scriptSrc.slice(
            scriptSrc.indexOf('function isSameAddress(a, b)'),
            scriptSrc.indexOf('function isSameAddress(a, b)') + 500
        );
        assert.match(helper, /decodeAddress\(a\)/);
        assert.match(helper, /decodeAddress\(b\)/);
    });
});

describe('F-135 — walletAddress is an authorisation fact, not a preference', () => {
    const normalize = serverSrc.slice(
        serverSrc.indexOf('function normalizePrefs('),
        serverSrc.indexOf('function normalizePrefs(') + 1800
    );

    test('normalizePrefs never reads walletAddress from its input', () => {
        // Comments are stripped: the function documents the field it ignores,
        // and the point of the test is what the CODE does.
        const code = normalize.split('\n')
            .filter(l => !l.trim().startsWith('//'))
            .join('\n');
        assert.ok(!/input\.account\.walletAddress/.test(code),
            'the request body can set walletAddress again — that IS F-135');
    });

    test('it takes the address as an explicit named argument', () => {
        assert.match(normalize, /function normalizePrefs\(input,\s*\{\s*walletAddress = null\s*\}/);
        assert.match(normalize, /out\.account\.walletAddress = walletAddress \|\| null/);
    });

    test('subscribe resolves the session BEFORE normalising', () => {
        // The original bug was ordering: prefs were built from the body first,
        // and the session only overwrote the field when a session existed.
        const route = serverSrc.slice(
            serverSrc.indexOf("app.post('/api/email/subscribe'"),
            serverSrc.indexOf("app.post('/api/email/confirm'")
        );
        assert.ok(route.length > 0, 'could not locate the subscribe route');
        const sessionAt   = route.indexOf('db.getSession(bearer)');
        const normalizeAt = route.indexOf('normalizePrefs(');
        assert.ok(sessionAt !== -1 && normalizeAt !== -1);
        assert.ok(sessionAt < normalizeAt,
            'prefs are normalised before the session is known — the unauthenticated case keeps the body value');
        assert.match(route, /normalizePrefs\([^)]*\{\s*walletAddress\s*\}\)/);
    });

    test('the preferences update preserves the stored address instead of taking one', () => {
        const route = serverSrc.slice(
            serverSrc.indexOf("app.post('/api/email/preferences'"),
            serverSrc.indexOf("app.get('/api/email/preferences'")
        );
        assert.ok(route.length > 0, 'could not locate the preferences POST route');
        assert.match(route, /keepWallet/,
            'the unsubscribe token can repoint the alert address again');
        assert.match(route, /normalizePrefs\([^)]*walletAddress:\s*keepWallet\s*\}\)/);
    });

    test('no other caller of normalizePrefs forgets the second argument', () => {
        const calls = serverSrc.match(/normalizePrefs\((?!input)[^;]*?\)/g) || [];
        const bare = calls.filter(c => !c.includes('walletAddress'));
        assert.deepEqual(bare, [],
            `a caller passes no provenance, silently clearing the address: ${bare.join(' | ')}`);
    });
});
