// Tests for lib/safe-return.js — audit F-107.
//
// The finding is that the old guard was a string check standing in for a URL
// parse. So the cases below are organised around *why* each one escaped: they
// are all strings that a human reading `startsWith('/') && !startsWith('//')`
// would classify as safe, and that the WHATWG URL parser classifies as
// cross-origin. If a future edit reintroduces any string-shaped shortcut, the
// TAB and backslash cases are the ones that will catch it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnPath, readSafeReturn } from '../lib/safe-return.js';

const ORIGIN = 'https://explorer.polkadex.ee';

describe('safeReturnPath — the bypasses F-107 names', () => {
    const bypasses = {
        'TAB then slashes (stripped by the parser AFTER a string check runs)': '/\t/evil.example.com',
        'newline then slashes': '/\n/evil.example.com',
        'carriage return then slashes': '/\r/evil.example.com',
        'backslash treated as a slash in the authority': '/\\evil.example.com',
        'slash then backslash': '/\\/evil.example.com',
        'plain protocol-relative': '//evil.example.com',
        'protocol-relative with backslashes': '\\\\evil.example.com',
        'absolute https': 'https://evil.example.com/x',
        'absolute http': 'http://evil.example.com/x',
        'javascript scheme': 'javascript:alert(1)',
        'data scheme': 'data:text/html,<script>alert(1)</script>',
        'a different port on the same host': 'https://explorer.polkadex.ee:8443/wallet',
        'http on the same host (protocol downgrade)': 'http://explorer.polkadex.ee/wallet',
        'a lookalike subdomain': 'https://explorer.polkadex.ee.evil.com/'
    };

    for (const [why, raw] of Object.entries(bypasses)) {
        test(`rejects ${why}`, () => {
            assert.equal(safeReturnPath(raw, ORIGIN), null,
                `${JSON.stringify(raw)} resolved to ${JSON.stringify(safeReturnPath(raw, ORIGIN))}`);
        });
    }

    test('the audit\'s own close test holds for every bypass', () => {
        // "returnTo with TAB or // stays same-origin
        //  (new URL(path, origin).origin === location.origin)"
        for (const raw of Object.values(bypasses)) {
            const out = safeReturnPath(raw, ORIGIN);
            if (out === null) continue;                       // rejected: fine
            assert.equal(new URL(out, ORIGIN).origin, new URL(ORIGIN).origin,
                `accepted ${JSON.stringify(raw)} as ${JSON.stringify(out)}, which leaves the origin`);
        }
    });
});

describe('safeReturnPath — legitimate destinations still work', () => {
    const good = {
        '/wallet': '/wallet',
        '/block/12885897': '/block/12885897',
        '/account/esXXX?tab=rewards': '/account/esXXX?tab=rewards',
        '/governance#motions': '/governance#motions',
        '/email/preferences?token=abc123': '/email/preferences?token=abc123',
        '/': '/',
        // Same-origin absolute URLs are legitimate and must be reduced to a path.
        'https://explorer.polkadex.ee/wallet': '/wallet',
        'https://explorer.polkadex.ee/wallet?x=1#y': '/wallet?x=1#y'
    };

    for (const [raw, expected] of Object.entries(good)) {
        test(`accepts ${raw}`, () => {
            assert.equal(safeReturnPath(raw, ORIGIN), expected);
        });
    }

    test('a TAB with only ONE slash is a harmless same-origin path', () => {
        // Worth pinning explicitly, because it is the near-miss of the real
        // bypass and the difference is a single character. "/\t/evil.com"
        // becomes "//evil.com" (cross-origin, rejected above); "/\tevil.com"
        // becomes "/evil.com" — a path on OUR host that routes to a 404.
        // Rejecting it would be harmless but would also mean the rule was
        // "looks scary" rather than "leaves the origin".
        assert.equal(safeReturnPath('/\tevil.example.com', ORIGIN), '/evil.example.com');
    });

    test('a percent-encoded TAB is NOT stripped, so it stays in the path', () => {
        // Only literal TAB/LF/CR are removed by the parser. %09 survives
        // encoding and never reaches the authority position.
        assert.equal(safeReturnPath('/%09/evil.example.com', ORIGIN), '/%09/evil.example.com');
    });

    test('dot segments are resolved, not passed through', () => {
        // The caller gets a path it can navigate to directly; '..' that walks
        // above the root is clamped by the parser, never escaping the origin.
        assert.equal(safeReturnPath('/a/../wallet', ORIGIN), '/wallet');
        assert.equal(safeReturnPath('/../../../etc/passwd', ORIGIN), '/etc/passwd');
    });

    test('the returned value is rebuilt from the parse, not echoed', () => {
        // Echoing the input would hand back a string that normalises
        // differently from the one we validated.
        assert.equal(safeReturnPath('/wallet/./', ORIGIN), '/wallet/');
    });
});

describe('safeReturnPath — degenerate input', () => {
    test('empty, null, undefined and non-strings are null', () => {
        for (const v of ['', null, undefined, 0, {}, [], true]) {
            assert.equal(safeReturnPath(v, ORIGIN), null);
        }
    });

    test('a malformed origin yields null rather than throwing', () => {
        assert.equal(safeReturnPath('/wallet', 'not-a-url'), null);
        assert.equal(safeReturnPath('/wallet', ''), null);
        assert.equal(safeReturnPath('/wallet', null), null);
    });

    test('an opaque origin never compares equal to itself', () => {
        // Both sides stringify to "null"; a naive === would pass.
        assert.equal(safeReturnPath('about:blank', 'about:blank'), null);
    });

    test('works for a localhost dev origin too', () => {
        assert.equal(safeReturnPath('/wallet', 'http://localhost:5173'), '/wallet');
        assert.equal(safeReturnPath('//evil.com', 'http://localhost:5173'), null);
        assert.equal(safeReturnPath('http://localhost:3001/x', 'http://localhost:5173'), null);
    });
});

describe('readSafeReturn — the query-string wrapper', () => {
    test('reads and validates returnTo', () => {
        assert.equal(readSafeReturn('?returnTo=%2Fwallet', ORIGIN), '/wallet');
        assert.equal(readSafeReturn('?returnTo=%2F%09%2Fevil.com', ORIGIN), null);
        assert.equal(readSafeReturn('?returnTo=https%3A%2F%2Fevil.com', ORIGIN), null);
    });

    test('a missing or empty parameter is null, not a crash', () => {
        assert.equal(readSafeReturn('', ORIGIN), null);
        assert.equal(readSafeReturn('?other=1', ORIGIN), null);
        assert.equal(readSafeReturn(null, ORIGIN), null);
        assert.equal(readSafeReturn('?returnTo=', ORIGIN), null);
    });

    test('the parameter name is configurable', () => {
        assert.equal(readSafeReturn('?next=%2Fgovernance', ORIGIN, 'next'), '/governance');
    });
});
