// Tests for lib/tx-paging.js — audit F-078 / F-079.
//
// This cursor was wrong twice, so the tests are written as PROPERTIES over a
// simulated full pagination run rather than as spot checks. The two that
// matter:
//
//   PROGRESS — consecutive pages strictly advance. A cursor that repeats is
//              an infinite Load-Older loop; the v2 bug produced exactly that.
//   COMPLETE — every transfer comes back exactly once. The v1 bug silently
//              dropped rows, which is worse than looping because nobody sees it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planTxPage } from '../lib/tx-paging.js';

// A synthetic chain: block N holds `counts[N]` transfers, each row a unique id.
function makeChain(counts) {
    const blocks = new Map();
    for (const [num, n] of Object.entries(counts)) {
        blocks.set(Number(num), {
            blockNumber: Number(num),
            transactions: Array.from({ length: n }, (_, i) => `b${num}-tx${i}`)
        });
    }
    return blocks;
}

// Walk the whole chain the way the client does, and report what happened.
function paginate(chain, limit, { maxPages = 200 } = {}) {
    const heights = [...chain.keys()].sort((a, b) => b - a);
    const top = heights[0];
    let before = top + 1;
    let resume = null;
    const seen = [];
    const cursors = [];
    let pages = 0;

    while (pages < maxPages) {
        pages++;
        // The server scans downward from `before - 1`, or AT the resume height.
        const from = resume ? resume.block : before - 1;
        const window = heights.filter(h => h <= from).slice(0, 8).map(h => chain.get(h));
        if (window.length === 0) break;

        const page = planTxPage({ blocks: window, limit, skip: resume });
        seen.push(...page.emitted);
        cursors.push({ before, resume: resume ? { ...resume } : null, next: page.nextBeforeBlock });

        if (page.emitted.length === 0 && !page.resumeInBlock) break;
        resume = page.resumeInBlock;
        if (page.nextBeforeBlock === null) break;
        before = page.nextBeforeBlock;
        if (!resume && before <= Math.min(...heights)) {
            // Drain the final block, then stop.
            const last = chain.get(Math.min(...heights));
            if (last && before - 1 < Math.min(...heights)) break;
        }
    }
    return { seen, cursors, pages };
}

describe('planTxPage — the PROGRESS property', () => {
    test('a block with more transfers than one page still advances', () => {
        // The v2 bug verbatim: limit fills inside the first block scanned, and
        // the cursor came back equal to the caller's own beforeBlock.
        const chain = makeChain({ 1000: 250 });
        const p1 = planTxPage({ blocks: [chain.get(1000)], limit: 100, skip: null });
        assert.equal(p1.emitted.length, 100);
        assert.deepEqual(p1.resumeInBlock, { block: 1000, count: 100 });

        const p2 = planTxPage({ blocks: [chain.get(1000)], limit: 100, skip: p1.resumeInBlock });
        assert.equal(p2.emitted.length, 100);
        assert.equal(p2.emitted[0], 'b1000-tx100', 'page 2 must resume after page 1, not restart');
        assert.deepEqual(p2.resumeInBlock, { block: 1000, count: 200 });

        const p3 = planTxPage({ blocks: [chain.get(1000)], limit: 100, skip: p2.resumeInBlock });
        assert.equal(p3.emitted.length, 50);
        assert.equal(p3.resumeInBlock, null, 'the block is drained; stop resuming');
    });

    test('paging a fat block never repeats a row', () => {
        const chain = makeChain({ 500: 350 });
        const { seen } = paginate(chain, 100);
        assert.equal(new Set(seen).size, seen.length, 'a transfer was returned twice');
    });

    test('the cursor never moves backwards or stalls across a mixed chain', () => {
        const chain = makeChain({ 900: 3, 899: 0, 898: 140, 897: 7, 896: 0, 895: 1 });
        const { cursors } = paginate(chain, 50);
        for (let i = 1; i < cursors.length; i++) {
            const prev = cursors[i - 1];
            const cur = cursors[i];
            const advanced = cur.before < prev.before
                || (cur.before === prev.before && cur.resume && (!prev.resume || cur.resume.count > prev.resume.count));
            assert.ok(advanced,
                `page ${i} did not advance: before ${prev.before}→${cur.before}, resume ${JSON.stringify(prev.resume)}→${JSON.stringify(cur.resume)}`);
        }
    });
});

describe('planTxPage — the COMPLETE property', () => {
    const shapes = {
        'limit lands exactly on a block boundary': { 300: 50, 299: 50, 298: 50 },
        'limit cuts mid-block': { 300: 30, 299: 90, 298: 10 },
        'a block far bigger than the page': { 300: 5, 299: 400, 298: 5 },
        'empty blocks interleaved': { 300: 0, 299: 12, 298: 0, 297: 0, 296: 3 },
        'single transfer at the bottom': { 300: 0, 299: 0, 298: 1 }
    };

    for (const [name, counts] of Object.entries(shapes)) {
        test(`every transfer is returned exactly once — ${name}`, () => {
            const chain = makeChain(counts);
            const expected = [];
            for (const h of [...chain.keys()].sort((a, b) => b - a)) {
                expected.push(...chain.get(h).transactions);
            }
            const { seen } = paginate(chain, 50);
            assert.deepEqual(seen, expected,
                'pagination lost, duplicated or reordered transfers');
        });
    }
});

describe('planTxPage — the resume contract is explicit', () => {
    // A mutation test caught nextBeforeBlock being unobservable on the resume
    // path: both the server handler and a resume-aware client use
    // resumeInBlock.block directly, so changing +1 to +0 broke nothing they
    // could see — while silently flipping a resume-UNAWARE consumer between an
    // infinite loop and skipped rows. The contract has to be assertable.
    test('a mid-block stop flags that the cursor alone is insufficient', () => {
        const out = planTxPage({
            blocks: [{ blockNumber: 1000, transactions: Array.from({ length: 250 }, (_, i) => i) }],
            limit: 100
        });
        assert.equal(out.resumeRequired, true,
            'a caller following only nextBeforeBlock has no way to know it must resume');
        assert.deepEqual(out.resumeInBlock, { block: 1000, count: 100 });
    });

    test('a clean block boundary does NOT flag resume', () => {
        const out = planTxPage({
            blocks: [{ blockNumber: 1000, transactions: ['a', 'b'] }, { blockNumber: 999, transactions: ['c'] }],
            limit: 100
        });
        assert.equal(out.resumeRequired, false);
        assert.equal(out.resumeInBlock, null);
        assert.equal(out.nextBeforeBlock, 999);
    });

    test('when resume IS required the cursor re-serves that height, never skips it', () => {
        // Duplicates are recoverable; skipped transfers are not. This pins the
        // direction of the trade-off so a future edit cannot silently invert it.
        const out = planTxPage({
            blocks: [{ blockNumber: 1000, transactions: Array.from({ length: 250 }, (_, i) => i) }],
            limit: 100
        });
        assert.ok(out.nextBeforeBlock > out.resumeInBlock.block,
            'nextBeforeBlock must not point BELOW a partly-read height — that skips its leftovers');
    });
});

describe('planTxPage — edges', () => {
    test('an empty window yields nothing and no cursor', () => {
        const out = planTxPage({ blocks: [], limit: 100 });
        assert.deepEqual(out.emitted, []);
        assert.equal(out.resumeInBlock, null);
        assert.equal(out.nextBeforeBlock, null);
    });

    test('blocks with no transfers still advance the cursor', () => {
        // Otherwise a long transfer-free stretch stalls paging entirely.
        const out = planTxPage({
            blocks: [{ blockNumber: 10, transactions: [] }, { blockNumber: 9, transactions: [] }],
            limit: 100
        });
        assert.equal(out.emitted.length, 0);
        assert.equal(out.nextBeforeBlock, 9, 'the cursor must move past drained empty blocks');
    });

    test('limit 0 emits nothing and does not claim to have drained anything', () => {
        const out = planTxPage({ blocks: [{ blockNumber: 5, transactions: ['a', 'b'] }], limit: 0 });
        assert.equal(out.emitted.length, 0);
        assert.deepEqual(out.resumeInBlock, { block: 5, count: 0 },
            'with nothing emitted the next page must start at the same offset');
    });

    test('malformed input does not throw', () => {
        assert.equal(planTxPage().emitted.length, 0);
        assert.equal(planTxPage({ blocks: null, limit: 10 }).emitted.length, 0);
        assert.equal(planTxPage({ blocks: [{ blockNumber: 1 }], limit: 10 }).emitted.length, 0);
    });

    test('the skip offset only applies to its own height', () => {
        // A stale resume cursor for a different block must not silently drop
        // rows from the block we are actually reading.
        const out = planTxPage({
            blocks: [{ blockNumber: 7, transactions: ['x', 'y', 'z'] }],
            limit: 10,
            skip: { block: 99, count: 2 }
        });
        assert.deepEqual(out.emitted, ['x', 'y', 'z']);
    });
});
