// Regression tests for lib/client-ip.js — audit F-019.
//
// The bug: `X-Forwarded-For.split(',')[0]`. nginx APPENDS the real peer rather
// than replacing the header, so the leftmost value is whatever the caller sent.
// One extra header per request gave every request its own rate-limit bucket,
// which silently disabled the 60/min developer API cap, the email-signup cap,
// and the auth gate in front of signature verification.
//
// The tests below are written from the attacker's side first: if a spoofed
// header can still change the bucket, the limiter is decorative.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientIp } from '../lib/client-ip.js';

const REAL = '203.0.113.7';        // the actual client
const SPOOF = '198.51.100.99';     // what the attacker claims to be

describe('resolveClientIp — spoofing must not change the bucket', () => {
    test('a client-supplied XFF cannot displace nginx x-real-ip', () => {
        // The production shape: nginx resolved CF-Connecting-IP into
        // X-Real-IP and appended the peer to the client's XFF.
        const ip = resolveClientIp({
            'x-forwarded-for': `${SPOOF}, ${REAL}`,
            'x-real-ip': REAL
        }, '10.0.0.5');
        assert.equal(ip, REAL);
    });

    test('rotating the spoofed value does not change the bucket', () => {
        // The actual attack is a loop with a fresh forged IP each request. If
        // these two disagree, the cap is bypassable.
        const a = resolveClientIp({ 'x-forwarded-for': `1.1.1.1, ${REAL}`, 'x-real-ip': REAL }, '10.0.0.5');
        const b = resolveClientIp({ 'x-forwarded-for': `2.2.2.2, ${REAL}`, 'x-real-ip': REAL }, '10.0.0.5');
        assert.equal(a, b);
        assert.equal(a, REAL);
    });

    test('without x-real-ip, the RIGHTMOST hop wins, not the leftmost', () => {
        // The rightmost entry is the one our nearest proxy appended; the
        // leftmost is pure client input. This single assertion is the finding.
        assert.equal(resolveClientIp({ 'x-forwarded-for': `${SPOOF}, ${REAL}` }, '10.0.0.5'), REAL);
    });

    test('a long forged chain still resolves to the appended hop', () => {
        const xff = `1.1.1.1, 2.2.2.2, 3.3.3.3, ${REAL}`;
        assert.equal(resolveClientIp({ 'x-forwarded-for': xff }, '10.0.0.5'), REAL);
    });
});

describe('resolveClientIp — precedence and fallbacks', () => {
    test('x-real-ip alone is used', () => {
        assert.equal(resolveClientIp({ 'x-real-ip': REAL }, '10.0.0.5'), REAL);
    });

    test('falls back to the socket peer when no proxy headers are present', () => {
        // Direct, unproxied connection — e.g. an operator on the box.
        assert.equal(resolveClientIp({}, '127.0.0.1'), '127.0.0.1');
    });

    test('returns a stable sentinel rather than undefined', () => {
        // The value is a Map key in every limiter; undefined would collapse
        // all anonymous callers into one bucket by accident.
        assert.equal(resolveClientIp({}, ''), 'unknown');
        assert.equal(resolveClientIp(undefined, undefined), 'unknown');
        assert.equal(resolveClientIp(null, null), 'unknown');
    });

    test('whitespace and empty hops are tolerated', () => {
        assert.equal(resolveClientIp({ 'x-forwarded-for': `  ${SPOOF} ,  ${REAL}  ` }, ''), REAL);
        assert.equal(resolveClientIp({ 'x-forwarded-for': `${REAL}, ,` }, ''), REAL);
    });

    test('an empty or whitespace-only x-real-ip does not shadow the fallbacks', () => {
        // Otherwise a header present-but-blank would return '' and bucket
        // every such caller together.
        assert.equal(resolveClientIp({ 'x-real-ip': '   ', 'x-forwarded-for': REAL }, ''), REAL);
        assert.equal(resolveClientIp({ 'x-real-ip': '' }, '127.0.0.1'), '127.0.0.1');
    });

    test('IPv6 and IPv4-mapped forms survive intact', () => {
        assert.equal(resolveClientIp({ 'x-real-ip': '2001:db8::1' }, ''), '2001:db8::1');
        assert.equal(resolveClientIp({}, '::ffff:127.0.0.1'), '::ffff:127.0.0.1');
    });
});

describe('resolveClientIp — distinct clients stay distinct', () => {
    test('two different real clients get different buckets', () => {
        // The limiter must still WORK, not just resist spoofing. Collapsing
        // everyone into one bucket would "pass" the tests above.
        const a = resolveClientIp({ 'x-real-ip': '203.0.113.1' }, '10.0.0.5');
        const b = resolveClientIp({ 'x-real-ip': '203.0.113.2' }, '10.0.0.5');
        assert.notEqual(a, b);
    });
});
