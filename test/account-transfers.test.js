// Account transfers show Index, Block, From, an IN / OUT marker, To, Value, Time and Result,
// with the extrinsic of each transfer read from the events table by the transfer's event id.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import * as db from '../db.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { formatUtcDateTime, transferValueCell, transferIndexCell, transferDirection, transferParty, transferColumns } from '../lib/account-transfers.js';

const created = [];
after(() => {
    for (const dir of created) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
});

describe('transfers carry the extrinsic of their event', () => {
    test('a matching event gives extrinsicIndex and txHash; no match gives nulls', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-account-transfers-'));
        created.push(dir);
        db.initDb(dir, true, { awaitMigrator: false });
        db.insertTransactions([
            { hash: 'event-0xb1-2', from: 'esA', to: 'esB', block: 7, eventIndex: 2, blockHash: '0xb1' },
            { hash: 'event-0xb2-4', from: 'esB', to: 'esA', block: 8, eventIndex: 4, blockHash: '0xb2' }
        ]);
        db.insertEvents([
            { hash: '0xb1-2', block: 7, eventIndex: 2, extrinsicIndex: 1, txHash: '0xt1', signerAddress: 'esA' },
            { hash: '0xb2-5', block: 8, eventIndex: 5, extrinsicIndex: 3, txHash: '0xt2', signerAddress: 'esB' }
        ]);
        const rows = db.getTransactionsByAddress('esA', 10);
        assert.deepEqual(rows.map(r => [r.hash, r.extrinsicIndex, r.txHash]), [['event-0xb2-4', null, null], ['event-0xb1-2', 1, '0xt1']]);
        assert.deepEqual(db.getTransactionsByAddress('esA', 1).map(r => r.hash), ['event-0xb2-4'], 'the limit still cuts the page');
    });
});

// The cells live in lib/account-transfers.js. The address helpers and statusBadge they are
// given stay in script.js, so those are lifted out of it and passed in, as script.js does.
const src = stripComments(readRepo('script.js', import.meta.url));
const NAMES = ['isSameAddress', 'stakingShortAddress', 'shortAddressLink', 'statusBadge'];
const H = new Function('decodeAddress', 'stakingEscapeHtml',
    `${NAMES.map(n => bodyOf(src, n)).join('\n')} return { ${NAMES.join(', ')} };`)(decodeAddress, escapeHtml);
const DEPS = { same: H.isSameAddress, short: H.stakingShortAddress, link: H.shortAddressLink, timeAgo: ts => `ago:${ts}`, statusBadge: H.statusBadge };

const KEY = new Uint8Array(32).fill(7);
const ME = encodeAddress(KEY, 88), ME_42 = encodeAddress(KEY, 42), OTHER = encodeAddress(new Uint8Array(32).fill(9), 88);

describe('the account transfers cells', () => {
    test('IN when the account receives, OUT when it sends, SELF when both, whatever the address prefix', () => {
        assert.equal(transferDirection({ from: OTHER, to: ME_42 }, ME, DEPS.same), 'in');
        assert.equal(transferDirection({ from: ME, to: OTHER }, ME, DEPS.same), 'out');
        assert.equal(transferDirection({ from: ME_42, to: ME }, ME, DEPS.same), 'self');
        assert.equal(transferDirection({ from: OTHER, to: OTHER }, ME, DEPS.same), '', 'neither side is the account');
    });

    test('the viewed account is plain text; the other side links to its account page', () => {
        assert.ok(!transferParty(ME_42, ME, DEPS).includes('<a '), 'the viewed account must not link to itself');
        assert.ok(transferParty(OTHER, ME, DEPS).startsWith(`<a href="/account/${OTHER}"`));
    });

    test('Index links an extrinsic to its transaction and a system transfer to its block', () => {
        assert.equal(transferIndexCell({ block: 4100200, extrinsicIndex: 3, txHash: '0xabc', eventIndex: 9 }),
            '<a href="/tx/4100200/0xabc" class="item-link">Extrinsic #4100200-3</a>');
        assert.equal(transferIndexCell({ block: 4100201, extrinsicIndex: null, txHash: '', eventIndex: 6 }),
            '<a href="/block/4100201" class="item-link">Event #4100201-6</a>');
    });

    test('Value splits the integer, the fraction and the unit, and escapes each', () => {
        assert.equal(transferValueCell('1,341.7476 PDEX'),
            '1,341<span style="color: var(--text-secondary);">.7476</span> <span style="color: var(--brand-primary);">PDEX</span>');
        assert.match(transferValueCell('5 <b>PDEX</b>'), /^5<span[^>]*><\/span> <span[^>]*>&lt;b&gt;PDEX&lt;\/b&gt;<\/span>$/);
        assert.equal(transferValueCell('<i>x</i>'), '&lt;i&gt;x&lt;/i&gt;');
    });

    test('Time is UTC with the zone spelled out, and a dash when unknown', () => {
        assert.equal(formatUtcDateTime(Date.UTC(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05 (UTC)');
        assert.equal(formatUtcDateTime(null), '-');
        assert.equal(formatUtcDateTime('not a time'), '-');
    });

    test('Result is an icon: a check for success, a cross for failed, a dash otherwise', () => {
        assert.match(H.statusBadge('success', '', { icon: true }), /bxs-check-circle" title="Success" style="[^"]*var\(--success\)/);
        assert.match(H.statusBadge('failed', '', { icon: true }), /bxs-x-circle" title="Failed" style="[^"]*var\(--error\)/);
        assert.match(H.statusBadge(null, '', { icon: true }), /bx-minus" title="unknown" style="[^"]*var\(--text-muted\)/);
    });

    test('the Transfers columns, in order, render each cell for the viewed account', () => {
        const cols = transferColumns(ME, DEPS);
        assert.deepEqual(cols.map(c => c.label), ['Index', 'Block', 'From', ' ', 'To', 'Value', 'Time', 'Result']);
        const col = key => cols.find(c => c.key === key);
        const row = { block: 7, eventIndex: 2, from: OTHER, to: ME_42, amount: '5 PDEX', timestamp: Date.UTC(2026, 0, 2, 3, 4, 5), status: 'success' };
        assert.equal(col('block').format(row), '<a href="/block/7" class="item-link">7</a>');
        assert.ok(col('from').format(row).startsWith('<a href="/account/'), 'the other side links');
        assert.ok(!col('to').format(row).includes('<a '), 'the viewed account does not');
        assert.equal(col('direction').filter.derive(row), 'in');
        assert.equal(col('direction').format(row), '<span class="dir-pill in">IN</span>');
        assert.equal(col('direction').format({ from: OTHER, to: OTHER }), '', 'no pill when neither side is the account');
        assert.equal(col('timestamp').format(row), `<span title="ago:${row.timestamp}">2026-01-02 03:04:05 (UTC)</span>`);
        assert.match(col('status').format(row), /bxs-check-circle/);
        assert.ok(col('amount').sort({ numericAmount: 1 }, { numericAmount: 2 }) < 0);
    });
});
