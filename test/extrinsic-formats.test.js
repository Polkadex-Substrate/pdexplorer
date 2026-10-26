// lib/extrinsic-formats.js and the wiring in scripts/fetch-metadata.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyExtrinsic, newFormatTally, tallyExtrinsic, sampleLabel, v5MissingMessage } from '../lib/extrinsic-formats.js';
import { stripComments } from './helpers/source.js';

// Compact length prefix then the version byte; the rest is padding.
const ext = (versionByte, lenPrefix = '10') => '0x' + lenPrefix + versionByte.toString(16).padStart(2, '0') + '00'.repeat(15);

describe('classifyExtrinsic', () => {
    test('the four formats from the version byte', () => {
        assert.deepEqual(classifyExtrinsic(ext(0x04)), { version: 4, kind: 'bare', byte: 0x04 });
        assert.deepEqual(classifyExtrinsic(ext(0x84)), { version: 4, kind: 'signed', byte: 0x84 });
        assert.deepEqual(classifyExtrinsic(ext(0x05)), { version: 5, kind: 'bare', byte: 0x05 });
        assert.deepEqual(classifyExtrinsic(ext(0x45)), { version: 5, kind: 'general', byte: 0x45 });
    });

    test('reads the byte after a 2-byte and a 4-byte compact length', () => {
        assert.equal(classifyExtrinsic('0x' + '2d01' + '45' + '00'.repeat(8)).byte, 0x45);       // two-byte mode
        assert.equal(classifyExtrinsic('0x' + '02000100' + '84' + '00'.repeat(8)).byte, 0x84);   // four-byte mode
        assert.equal(classifyExtrinsic('0x' + '03' + '01000000' + '84' + '00'.repeat(8)).byte, 0x84);  // big-integer mode, 4 length bytes
    });
});

describe('sampleLabel', () => {
    test('keeps bare v5 (the 392 inherents), general v5 and signed v4; drops the rest', () => {
        const label = b => sampleLabel(classifyExtrinsic(ext(b)));
        assert.equal(label(0x05), 'v5-bare');
        assert.equal(label(0x45), 'v5-general');
        assert.equal(label(0x84), 'v4-signed');
        assert.equal(label(0x04), null);
    });

    test('a block of only bare v5 inherents passes the v5 verdict and yields samples', () => {
        const t = newFormatTally();
        const kept = [0x05, 0x05, 0x84].map(b => {
            const hex = ext(b);
            return sampleLabel(tallyExtrinsic(t, hex));
        });
        assert.deepEqual(kept, ['v5-bare', 'v5-bare', 'v4-signed']);
        assert.equal(t[5].general, 0);
        assert.equal(v5MissingMessage(t, { blocks: 1, spec: 392, widen: 400 }), null);
    });
});

describe('tally and the v5 verdict', () => {
    test('counts per version with the bare/signed/general split', () => {
        const t = newFormatTally();
        for (const b of [0x04, 0x84, 0x84, 0x45, 0x05, 0x45, 0x45]) tallyExtrinsic(t, ext(b));
        assert.deepEqual(t, {
            4: { total: 3, bare: 1, signed: 2, general: 0 },
            5: { total: 4, bare: 1, signed: 0, general: 3 }
        });
        assert.equal(v5MissingMessage(t, { blocks: 400, spec: 392, widen: 400 }), null);
    });

    test('only v4 seen: a clear message naming the window, the counts and --blocks', () => {
        const t = newFormatTally();
        tallyExtrinsic(t, ext(0x84)); tallyExtrinsic(t, ext(0x04));
        const msg = v5MissingMessage(t, { blocks: 400, spec: 392, widen: 400 });
        assert.match(msg, /no v5 extrinsic/);
        assert.match(msg, /400 block\(s\)/);
        assert.match(msg, /seenFormats=\{"4":\{"total":2,"bare":1,"signed":1,"general":0\}\}/);
        assert.match(msg, /--blocks <N>/);
        assert.match(msg, /NOT written/);
    });

    test('an empty range is a failure too', () => {
        assert.match(v5MissingMessage(newFormatTally(), { blocks: 0, spec: 392, widen: 400 }), /no v5 extrinsic/);
    });
});

describe('scripts/fetch-metadata.mjs wiring', () => {
    const src = stripComments(readFileSync(new URL('../scripts/fetch-metadata.mjs', import.meta.url), 'utf8'));
    test('uses the shared module, takes --blocks, prints seenFormats, exits non-zero without v5', () => {
        assert.match(src, /from '\.\.\/lib\/extrinsic-formats\.js'/);
        assert.match(src, /opt\('blocks'/);
        assert.match(src, /seenFormats=/);
        assert.match(src, /v5MissingMessage/);
        assert.match(src, /sampleLabel\(/);
        assert.match(src, /'v5-bare': 0/);
        assert.match(src, /process\.exit\(1\)/);
    });
});
