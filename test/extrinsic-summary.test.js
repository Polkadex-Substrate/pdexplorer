// Tests for lib/extrinsic-summary.js — audit F-045.
//
// The finding is duplication, so the test that matters most is the LAST one:
// that neither call site has grown its own copy of the method table again.
// The behavioural tests exist because extracting a function is only safe if
// the extracted version does what both originals did, including for the calls
// they both got subtly right (forceTransfer's shifted argument indices) and the
// one they both handled specially (transferAll has no amount argument).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    summarizeExtrinsicAmount, formatAmountLabel, BALANCE_TRANSFER_CALLS
} from '../lib/extrinsic-summary.js';

// Minimal stand-in for a decoded extrinsic. Args stringify like codecs do.
function ex(section, method, args) {
    return { method: { section, method, args: args.map(a => ({ toString: () => String(a) })) } };
}
// A converter with the same contract as formatPDEX / formatLivePDEX.
const toPdex = (codec) => Number(BigInt(codec.toString())) / 1e12;

describe('summarizeExtrinsicAmount — transfer shapes', () => {
    test('transfer / transferAllowDeath / transferKeepAlive read args 0 and 1', () => {
        for (const call of ['transfer', 'transferAllowDeath', 'transferKeepAlive']) {
            const out = summarizeExtrinsicAmount(ex('balances', call, ['esDEST', '2500000000000']), toPdex);
            assert.equal(out.to, 'esDEST', `${call} read the wrong destination`);
            assert.equal(out.numericAmount, 2.5);
            assert.equal(out.amount, '2.5 PDEX');
            assert.equal(out.method, `balances.${call}`);
        }
    });

    test('forceTransfer reads args 1 and 2, not 0 and 1', () => {
        // The source is arg 0 here. Reading arg 0 as the destination would
        // report every forced transfer as going to the account it came FROM.
        const out = summarizeExtrinsicAmount(
            ex('balances', 'forceTransfer', ['esSOURCE', 'esDEST', '1000000000000']), toPdex);
        assert.equal(out.to, 'esDEST');
        assert.equal(out.numericAmount, 1);
    });

    test('transferAll reports "All" and no numeric amount', () => {
        // The amount is not in the call — it is whatever the account holds at
        // execution time. Any number here would be invented.
        const out = summarizeExtrinsicAmount(ex('balances', 'transferAll', ['esDEST', true]), toPdex);
        assert.equal(out.to, 'esDEST');
        assert.equal(out.amount, 'All');
        assert.equal(out.numericAmount, 0);
    });
});

describe('summarizeExtrinsicAmount — everything else is "-"', () => {
    test('a non-balances call', () => {
        const out = summarizeExtrinsicAmount(ex('staking', 'bond', ['x', '1']), toPdex);
        assert.equal(out.amount, '-');
        assert.equal(out.to, 'staking.bond', 'to falls back to the method label');
    });

    test('an unknown balances call is not guessed at', () => {
        // setBalance takes (who, free, reserved) — reading arg 1 as "the
        // amount" would render a balance FORCE-SET as a transfer of that size.
        const out = summarizeExtrinsicAmount(
            ex('balances', 'setBalance', ['who', '999000000000000', '0']), toPdex);
        assert.equal(out.amount, '-');
    });

    test('a truncated arg list does not misread the remaining args', () => {
        const out = summarizeExtrinsicAmount(ex('balances', 'forceTransfer', ['a', 'b']), toPdex);
        assert.equal(out.amount, '-', 'minArgs must reject a short forceTransfer');
    });

    test('malformed extrinsics do not throw', () => {
        assert.doesNotThrow(() => summarizeExtrinsicAmount(null, toPdex));
        assert.doesNotThrow(() => summarizeExtrinsicAmount({}, toPdex));
        assert.doesNotThrow(() => summarizeExtrinsicAmount({ method: {} }, toPdex));
        assert.equal(summarizeExtrinsicAmount({}, toPdex).amount, '-');
    });
});

describe('summarizeExtrinsicAmount — the injected converter', () => {
    test('the caller\'s converter is what produces the number', () => {
        // This is the whole reason the module takes a function: server.js and
        // script.js legitimately convert differently.
        const out = summarizeExtrinsicAmount(
            ex('balances', 'transfer', ['d', '1']), () => 42);
        assert.equal(out.numericAmount, 42);
        assert.equal(out.amount, '42 PDEX');
    });

    test('a BigInt-safe converter survives an amount above 2^53 planck', () => {
        // F-043/F-067: Number(planck)/1e12 truncates above ~9007 PDEX. The
        // module must not re-introduce a Number() cast of its own.
        const big = '123456789012345678901';   // ~123.4M PDEX
        const bigSafe = (c) => {
            const p = BigInt(c.toString());
            return Number(p / 1000000000000n) + Number(p % 1000000000000n) / 1e12;
        };
        const out = summarizeExtrinsicAmount(ex('balances', 'transfer', ['d', big]), bigSafe);
        assert.equal(out.numericAmount, bigSafe({ toString: () => big }));
    });

    test('a method-name override is used verbatim', () => {
        // server.js passes getExtrinsicMethod(ex), which unwraps proxy/batch.
        const out = summarizeExtrinsicAmount(
            ex('balances', 'transfer', ['d', '1000000000000']), toPdex, 'proxy.proxy → balances.transfer');
        assert.equal(out.method, 'proxy.proxy → balances.transfer');
    });
});

describe('formatAmountLabel', () => {
    test('thousands separators and a 4dp cap, as both originals produced', () => {
        assert.equal(formatAmountLabel(1234567.891234567), '1,234,567.8912 PDEX');
        assert.equal(formatAmountLabel(0), '0 PDEX');
    });
});

describe('F-045 — there is exactly one method table', () => {
    const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const scriptSrc = readFileSync(new URL('../script.js', import.meta.url), 'utf8');

    test('the table lists every transfer call both copies knew about', () => {
        assert.deepEqual(Object.keys(BALANCE_TRANSFER_CALLS).sort(), [
            'forceTransfer', 'transfer', 'transferAll', 'transferAllowDeath', 'transferKeepAlive'
        ]);
    });

    for (const [name, src] of [['server.js', () => serverSrc], ['script.js', () => scriptSrc]]) {
        test(`${name} does not hand-roll the transfer list again`, () => {
            const s = src();
            assert.ok(!/\['transfer',\s*'transferAllowDeath',\s*'transferKeepAlive'\]/.test(s),
                `${name} has its own copy of the method list — that IS F-045`);
            assert.match(s, /summarizeExtrinsicAmount\(/,
                `${name} no longer uses the shared summariser`);
        });
    }

    test('both summarisers are now one-liners delegating to the shared module', () => {
        // If either grows a body again, the drift can restart.
        const serverFn = serverSrc.slice(
            serverSrc.indexOf('function getExtrinsicAmountSummary(ex) {'),
            serverSrc.indexOf('function getExtrinsicAmountSummary(ex) {') + 260
        );
        assert.match(serverFn, /return summarizeExtrinsicAmount\(ex, formatPDEX, getExtrinsicMethod\(ex\)\)/);
        const clientFn = scriptSrc.slice(
            scriptSrc.indexOf('function getLiveExtrinsicAmountSummary(ex) {'),
            scriptSrc.indexOf('function getLiveExtrinsicAmountSummary(ex) {') + 260
        );
        assert.match(clientFn, /return summarizeExtrinsicAmount\(ex, formatLivePDEX\)/);
    });
});
