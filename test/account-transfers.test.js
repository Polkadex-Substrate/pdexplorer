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

// The real cell helpers, lifted out of script.js with the helpers they call.
const src = stripComments(readRepo('script.js', import.meta.url));
const NAMES = ['isSameAddress', 'stakingShortAddress', 'shortAddressLink', 'statusBadge',
    'transferDirection', 'transferParty', 'transferIndexCell', 'transferValueCell', 'formatUtcDateTime'];
const H = new Function('decodeAddress', 'stakingEscapeHtml',
    `${NAMES.map(n => bodyOf(src, n)).join('\n')} return { ${NAMES.join(', ')} };`)(decodeAddress, escapeHtml);

const KEY = new Uint8Array(32).fill(7);
const ME = encodeAddress(KEY, 88), ME_42 = encodeAddress(KEY, 42), OTHER = encodeAddress(new Uint8Array(32).fill(9), 88);

describe('the account transfers cells', () => {
    test('IN when the account receives, OUT when it sends, SELF when both, whatever the address prefix', () => {
        assert.equal(H.transferDirection({ from: OTHER, to: ME_42 }, ME), 'in');
        assert.equal(H.transferDirection({ from: ME, to: OTHER }, ME), 'out');
        assert.equal(H.transferDirection({ from: ME_42, to: ME }, ME), 'self');
    });

    test('the viewed account is plain text; the other side links to its account page', () => {
        assert.ok(!H.transferParty(ME_42, ME).includes('<a '), 'the viewed account must not link to itself');
        assert.ok(H.transferParty(OTHER, ME).startsWith(`<a href="/account/${OTHER}"`));
    });

    test('Index links an extrinsic to its transaction and a system transfer to its block', () => {
        assert.equal(H.transferIndexCell({ block: 4100200, extrinsicIndex: 3, txHash: '0xabc', eventIndex: 9 }),
            '<a href="/tx/4100200/0xabc" class="item-link">Extrinsic #4100200-3</a>');
        assert.equal(H.transferIndexCell({ block: 4100201, extrinsicIndex: null, txHash: '', eventIndex: 6 }),
            '<a href="/block/4100201" class="item-link">Event #4100201-6</a>');
    });

    test('Value splits the integer, the fraction and the unit, and escapes each', () => {
        assert.equal(H.transferValueCell('1,341.7476 PDEX'),
            '1,341<span style="color: var(--text-secondary);">.7476</span> <span style="color: var(--brand-primary);">PDEX</span>');
        assert.match(H.transferValueCell('5 <b>PDEX</b>'), /^5<span[^>]*><\/span> <span[^>]*>&lt;b&gt;PDEX&lt;\/b&gt;<\/span>$/);
        assert.equal(H.transferValueCell('<i>x</i>'), '&lt;i&gt;x&lt;/i&gt;');
    });

    test('Time is UTC with the zone spelled out, and a dash when unknown', () => {
        assert.equal(H.formatUtcDateTime(Date.UTC(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05 (UTC)');
        assert.equal(H.formatUtcDateTime(null), '—');
    });

    test('Result is an icon: a check for success, a cross for failed, a dash otherwise', () => {
        assert.match(H.statusBadge('success', '', { icon: true }), /bxs-check-circle" title="Success" style="[^"]*var\(--success\)/);
        assert.match(H.statusBadge('failed', '', { icon: true }), /bxs-x-circle" title="Failed" style="[^"]*var\(--error\)/);
        assert.match(H.statusBadge(null, '', { icon: true }), /bx-minus" title="unknown" style="[^"]*var\(--text-muted\)/);
    });
});
