// Regression tests for the wallet's signing-critical logic.
//
// Every case here corresponds to a finding the 2026-08 audit rated
// "fix risk: funds". These are the bugs that let the explorer sign something
// other than what the user asked for. They were undetectable by inspection
// (the call hex looked perfect) and trivially detectable by assertion — which
// is the whole argument for this file existing.
//
// Run: npm test          (node --test, no framework, no new dependencies)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAddress } from '@polkadot/util-crypto';

import {
    pdexToPlanck,
    isPositiveNumberInput,
    isValidPolkadexAddress,
    buildTransferTx,
    PDEX_DECIMALS
} from '../lib/wallet-safety.js';

const POLKADEX_SS58 = 88;

// Derive real addresses instead of hardcoding: a hardcoded string that gets
// mistyped would make these tests pass for the wrong reason.
const validPolkadexAddr = encodeAddress(new Uint8Array(32).fill(1), POLKADEX_SS58);
const validGenericAddr  = encodeAddress(new Uint8Array(32).fill(1), 42);

describe('pdexToPlanck — audit F-011 (signed amount must equal typed amount)', () => {
    test('whole numbers scale by 10^12', () => {
        assert.equal(pdexToPlanck('1'), '1000000000000');
        assert.equal(pdexToPlanck('0'), '0');
        assert.equal(PDEX_DECIMALS, 12);
    });

    test('decimals are exact', () => {
        assert.equal(pdexToPlanck('1.1'), '1100000000000');
        assert.equal(pdexToPlanck('0.000000000001'), '1');       // one planck
        assert.equal(pdexToPlanck('12.345678901234'), '12345678901234');
    });

    test('decimals the float path gets WRONG — the actual F-011 bug', () => {
        // Not every decimal diverges (1.1 * 1e12 happens to be exact), which
        // is precisely why this shipped: it looked fine in casual testing.
        // These inputs are the ones that bite.
        //
        //   8.7                 float → 8699999999999   (one planck SHORT)
        //   1.005               float → 1004999999999   (one planck SHORT)
        //   9999.999999999999   float → 9999999999999998 (one planck SHORT)
        for (const [input, exact] of [
            ['8.7',               '8700000000000'],
            ['1.005',             '1005000000000'],
            ['9999.999999999999', '9999999999999999']
        ]) {
            assert.equal(pdexToPlanck(input), exact);
            const floatWay = BigInt(Math.floor(parseFloat(input) * 1e12)).toString();
            assert.notEqual(floatWay, pdexToPlanck(input),
                `${input}: float path should differ — if it stops differing this test is no longer proving anything`);
        }
    });

    test('amounts above Number.MAX_SAFE_INTEGER/1e12 stay exact', () => {
        // ~9007 PDEX is where Number can no longer represent planck precisely.
        // Above it the float path can round UP — signing MORE than was typed.
        assert.equal(pdexToPlanck('10000'), '10000000000000000');
        assert.equal(pdexToPlanck('9007199.254740993'), '9007199254740993000');

        // float gives 9007199254740993024 — 24 planck more than the user typed.
        const floatWay = BigInt(Math.floor(9007199.254740993 * 1e12)).toString();
        assert.equal(floatWay, '9007199254740993024');
        assert.notEqual(floatWay, pdexToPlanck('9007199.254740993'));

        // And an over-signing case at a rounder magnitude.
        assert.equal(pdexToPlanck('10000.000000000001'), '10000000000000001');
        assert.equal(BigInt(Math.floor(10000.000000000001 * 1e12)).toString(),
            '10000000000000002');
    });

    test('excess decimal places are truncated, not rounded up', () => {
        // Never round UP: that would sign more than the user typed.
        assert.equal(pdexToPlanck('1.9999999999999'), '1999999999999');
    });

    test('whitespace and empty input are handled without throwing', () => {
        assert.equal(pdexToPlanck('  2.5  '), '2500000000000');
        assert.equal(pdexToPlanck(''), '0');
        assert.equal(pdexToPlanck(null), '0');
        assert.equal(pdexToPlanck(undefined), '0');
    });

    test('returns a string (BigInt or Number would break signAndSend)', () => {
        assert.equal(typeof pdexToPlanck('1.5'), 'string');
    });
});

describe('isValidPolkadexAddress — audit F-012 (0x hash must never be a dest)', () => {
    test('accepts a real Polkadex SS58 address', () => {
        assert.equal(isValidPolkadexAddress(validPolkadexAddr), true);
    });

    test('accepts a generic prefix-42 address (extensions hand these back)', () => {
        assert.equal(isValidPolkadexAddress(validGenericAddr), true);
    });

    test('REJECTS a 0x 32-byte hex public key — the funds-loss case', () => {
        // decodeAddress() accepts this happily. A user pasting a block or
        // extrinsic hash into Send would otherwise transfer to an account
        // whose key nobody holds. Unrecoverable.
        const hash = '0x' + 'ab'.repeat(32);
        assert.equal(isValidPolkadexAddress(hash), false);
    });

    test('rejects 0x-prefixed input of any length', () => {
        assert.equal(isValidPolkadexAddress('0x'), false);
        assert.equal(isValidPolkadexAddress('0x1234'), false);
        assert.equal(isValidPolkadexAddress('0x' + 'cd'.repeat(64)), false);
    });

    test('rejects truncated or padded addresses instead of coercing them', () => {
        assert.equal(isValidPolkadexAddress(validPolkadexAddr.slice(0, 20)), false);
        assert.equal(isValidPolkadexAddress(validPolkadexAddr + 'AAAAA'), false);
    });

    test('rejects empty, null, and non-address junk', () => {
        assert.equal(isValidPolkadexAddress(''), false);
        assert.equal(isValidPolkadexAddress('   '), false);
        assert.equal(isValidPolkadexAddress(null), false);
        assert.equal(isValidPolkadexAddress(undefined), false);
        assert.equal(isValidPolkadexAddress('not an address at all, obviously'), false);
    });

    test('tolerates surrounding whitespace from a paste', () => {
        assert.equal(isValidPolkadexAddress(`  ${validPolkadexAddr}\n`), true);
    });
});

describe('buildTransferTx — audit F-054 (keep-alive intent binds the method)', () => {
    // Minimal api stub: each method records that it was the one chosen.
    const stub = (methods) => ({
        tx: {
            balances: Object.fromEntries(
                methods.map(m => [m, (dest, amount) => ({ method: m, dest, amount })])
            )
        }
    });

    const DEST = 'esrSTmnMFsSBktr9Fn1UkXHh6vDC8DtMDZZkkCNbNpV8e9n5j';
    const AMT = '1000000000000';

    test('keepAlive=true uses transferKeepAlive when present', () => {
        const api = stub(['transferKeepAlive', 'transferAllowDeath']);
        assert.equal(buildTransferTx(api, DEST, AMT, true).method, 'transferKeepAlive');
    });

    test('keepAlive=true THROWS rather than substituting transferAllowDeath', () => {
        // The regression: the old fallback chain returned transferAllowDeath
        // here, so a checked "Keep-alive" box could reap the sender.
        const api = stub(['transferAllowDeath']);
        assert.throws(() => buildTransferTx(api, DEST, AMT, true), /transferKeepAlive/);
    });

    test('keepAlive=true THROWS rather than falling back to legacy transfer', () => {
        // Legacy `balances.transfer` carries allow-death semantics.
        const api = stub(['transfer']);
        assert.throws(() => buildTransferTx(api, DEST, AMT, true), /transferKeepAlive/);
    });

    test('keepAlive=false uses transferAllowDeath', () => {
        const api = stub(['transferKeepAlive', 'transferAllowDeath']);
        assert.equal(buildTransferTx(api, DEST, AMT, false).method, 'transferAllowDeath');
    });

    test('keepAlive=false may use legacy transfer when that is all there is', () => {
        const api = stub(['transfer']);
        assert.equal(buildTransferTx(api, DEST, AMT, false).method, 'transfer');
    });

    test('passes dest and amount through untouched', () => {
        const api = stub(['transferKeepAlive']);
        const tx = buildTransferTx(api, DEST, AMT, true);
        assert.equal(tx.dest, DEST);
        assert.equal(tx.amount, AMT);
    });

    test('throws when the balances pallet is missing entirely', () => {
        assert.throws(() => buildTransferTx({ tx: {} }, DEST, AMT, true), /balances pallet/);
        assert.throws(() => buildTransferTx({}, DEST, AMT, false), /balances pallet/);
    });
});

describe('isPositiveNumberInput — form guard', () => {
    test('accepts positive integers and decimals', () => {
        assert.equal(isPositiveNumberInput('1'), true);
        assert.equal(isPositiveNumberInput('0.5'), true);
        assert.equal(isPositiveNumberInput(' 2.25 '), true);
    });

    test('rejects zero, negatives, blanks, and non-numeric text', () => {
        assert.equal(isPositiveNumberInput('0'), false);
        assert.equal(isPositiveNumberInput('-1'), false);
        assert.equal(isPositiveNumberInput(''), false);
        assert.equal(isPositiveNumberInput('   '), false);
        assert.equal(isPositiveNumberInput(null), false);
        assert.equal(isPositiveNumberInput(undefined), false);
        assert.equal(isPositiveNumberInput('abc'), false);
    });

    test('rejects Infinity and NaN spellings', () => {
        assert.equal(isPositiveNumberInput('Infinity'), false);
        assert.equal(isPositiveNumberInput('NaN'), false);
    });
});
