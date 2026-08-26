// Tests for lib/tx-from-event.js — the transfer parsing shared by the live
// indexer backfill (F-008) and the operator script, plus the hash-keyed id
// scheme (F-021).
//
// The amounts feed numeric_amount, which drives the analytics volume series
// and account-history totals — a wrong multiplier here misstates money, so the
// SI cases carry exact expected values.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseAmountToPdex, parseTransfer, buildTxRowFromEventRow, eventTxId, rewardId, formatAmountDisplay
} from '../lib/tx-from-event.js';

const HASH = '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

describe('parseAmountToPdex', () => {
    test('comma-grouped planck (modern metadata)', () => {
        assert.equal(parseAmountToPdex('12,345,678,900,000'), 12.3456789);
        assert.equal(parseAmountToPdex('1,000,000,000,000'), 1);
    });
    test('planck precision above 2^53 survives via BigInt', () => {
        // 9,007,199,254,740,993 planck — the float-precision trap from F-011.
        // A naive Number() path is off; whole-token BigInt division is not.
        assert.equal(parseAmountToPdex('9,007,199,254,740,993'), 9007.199254740993);
    });
    test('SI-formatted PDEX (legacy metadata)', () => {
        assert.equal(parseAmountToPdex('12.3456 PDEX'), 12.3456);
        assert.equal(parseAmountToPdex('1.5000 kPDEX'), 1500);
        assert.equal(parseAmountToPdex('640.0000 mPDEX'), 0.64);
        assert.equal(parseAmountToPdex('2.0000 MPDEX'), 2_000_000);
        // µ multiplies by 1e-6, which is not exactly representable — the
        // product is one ULP off. numeric_amount is an analytics float, so an
        // epsilon is the honest assertion (byte-identical to the original
        // script's behaviour).
        assert.ok(Math.abs(parseAmountToPdex('5.0000 µPDEX') - 0.000005) < 1e-18);
    });
    test('bare decimal treated as PDEX', () => {
        assert.equal(parseAmountToPdex('42.5'), 42.5);
    });
    test('garbage is null, not zero', () => {
        // Zero would silently deflate volume; null makes the row skippable
        // and countable as unparseable.
        for (const v of [null, undefined, '', 'abc', '1.2.3 XYZ', {}]) {
            assert.equal(parseAmountToPdex(v), null, `${String(v)} parsed`);
        }
    });
});

describe('parseTransfer', () => {
    test('positional toHuman array', () => {
        const t = parseTransfer(JSON.stringify(['5From', '5To', '1,000,000,000,000']));
        assert.deepEqual(t, { from: '5From', to: '5To', amountPdex: 1 });
    });
    test('named-field object variants', () => {
        assert.equal(parseTransfer(JSON.stringify({ from: 'a', to: 'b', amount: '1,000,000,000,000' })).amountPdex, 1);
        assert.equal(parseTransfer(JSON.stringify({ who: 'a', dest: 'b', value: '2,000,000,000,000' })).amountPdex, 2);
    });
    test('rejects short arrays, bad JSON, missing fields', () => {
        assert.equal(parseTransfer(JSON.stringify(['a', 'b'])), null);
        assert.equal(parseTransfer('{not json'), null);
        assert.equal(parseTransfer(JSON.stringify({ from: 'a', amount: '1' })), null);
        assert.equal(parseTransfer(JSON.stringify(null)), null);
    });
});

describe('eventTxId / rewardId — the F-021 scheme', () => {
    test('hash-keyed when a hash exists', () => {
        assert.equal(eventTxId(HASH, 123, 4), `event-${HASH}-4`);
        assert.equal(rewardId(HASH, 123, 4), `${HASH}-4`);
    });
    test('two forks of the same height get DIFFERENT ids', () => {
        // The entire finding: number-keyed ids made the orphan and the
        // canonical row collide, and INSERT OR IGNORE kept whichever came
        // first — after a reorg, the orphan.
        const a = eventTxId('0xaaa1', 500, 2);
        const b = eventTxId('0xbbb2', 500, 2);
        assert.notEqual(a, b);
    });
    test('missing hash falls back to the legacy number-keyed id', () => {
        // Never mint 'event-null-3': legacy shape is what the migration and
        // the reorg repair know how to recognise.
        assert.equal(eventTxId(null, 123, 4), 'event-123-4');
        assert.equal(eventTxId('', 123, 4), 'event-123-4');
        assert.equal(rewardId(undefined, 123, 4), '123-4');
    });
    test('a non-hash string is not trusted as a hash', () => {
        assert.equal(eventTxId('garbage', 123, 4), 'event-123-4');
    });
});

describe('buildTxRowFromEventRow', () => {
    const ev = {
        block: 12_862_690, eventIndex: 3,
        data: JSON.stringify(['5From', '5To', '2,500,000,000,000']),
        timestamp: 1_756_000_000_000, blockHash: HASH, status: 'success'
    };

    test('produces exactly the live writer shape', () => {
        const row = buildTxRowFromEventRow(ev);
        assert.equal(row.hash, `event-${HASH}-3`);
        assert.equal(row.method, 'balances.Transfer');
        assert.equal(row.numericAmount, 2.5);
        assert.equal(row.amount, formatAmountDisplay(2.5));
        assert.equal(row.value, '-');
        assert.equal(row.eventDerived, true);
        assert.equal(row.blockHash, HASH);
    });
    test('a non-transfer or unparseable row is null, not a broken row', () => {
        assert.equal(buildTxRowFromEventRow({ ...ev, data: '{bad' }), null);
        assert.equal(buildTxRowFromEventRow(null), null);
    });
    test('missing status defaults to success (matches live writer)', () => {
        assert.equal(buildTxRowFromEventRow({ ...ev, status: null }).status, 'success');
    });
});
