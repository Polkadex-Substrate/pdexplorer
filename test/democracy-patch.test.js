// In-place updates of the Democracy page (lib/democracy-patch.js). Live
// tallies arrive every block; redrawing the whole page each time would reset
// the table's sort, search, paging and scroll. These check the merge of live
// chain state over the REST snapshot, the plan that decides between a cell
// patch and a full render, the patcher itself against a small fake DOM, the
// in-flight vote and second feedback, and that chain data is escaped.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { overlayDemocracy, newRowCache, democracyCells, democracyFrame, democracyPatchPlan,
    patchDemocracyCells, demPendingStage, demPendingSettled, buildSecondTx } from '../lib/democracy-patch.js';

const rest = () => ({
    referendumCount: 3, publicPropCount: 2, activeReferenda: 1, activeProposals: 1, status: 'Synced',
    referenda: [
        { refIndex: 0, status: 'Passed', endBlock: 10, ayes: 5, nays: 1, turnout: 6, tallyKnown: 1 },
        { refIndex: 2, status: 'Ongoing', endBlock: 900, ayes: 1, nays: 0, turnout: 1, tallyKnown: 1, threshold: 'SimpleMajority', proposal: '0xaa' }
    ],
    publicProposals: [{ index: 1, proposer: 'eBob', proposerName: 'Bob', deposit: 10, seconds: 1 }]
});
const live = (over = {}) => ({ available: true, count: 3, refs: {}, props: null, deposits: {}, voting: null, ...over });

describe('overlay of live state on the REST snapshot', () => {
    test('no live state: the REST data as it was', () => {
        const d = overlayDemocracy(rest(), null, newRowCache());
        assert.deepEqual(d.referenda.map(r => [r.refIndex, r.status, r.ayes]), [[0, 'Passed', 5], [2, 'Ongoing', 1]]);
        assert.equal(d.publicProposals[0].proposerName, 'Bob');
        assert.equal(d.activeReferenda, 1);
    });

    test('live tallies win; REST keeps the fields the chain feed does not have', () => {
        const d = overlayDemocracy(rest(), live({ refs: { 2: { refIndex: 2, status: 'Ongoing', endBlock: 900, ayes: 40, nays: 2, turnout: 42, tallyKnown: 1 } } }), newRowCache());
        const r = d.referenda.find(x => x.refIndex === 2);
        assert.equal(r.ayes, 40);
        assert.equal(r.threshold, 'SimpleMajority');
        assert.equal(r.proposal, '0xaa');
    });

    test('a new referendum appears and the counts follow', () => {
        const d = overlayDemocracy(rest(), live({ count: 4, refs: { 3: { refIndex: 3, status: 'Ongoing', endBlock: 1000, ayes: 0, nays: 0, turnout: 0, tallyKnown: 1 } } }), newRowCache());
        assert.ok(d.referenda.some(r => r.refIndex === 3));
        assert.equal(d.activeReferenda, 2);
        assert.equal(d.referendumCount, 4);
    });

    test('an ended referendum changes status and keeps its tally', () => {
        const d = overlayDemocracy(rest(), live({ refs: { 2: { refIndex: 2, status: 'Passed', endBlock: 901, ayes: 1, nays: 0, turnout: 1, tallyKnown: 1 } } }), newRowCache());
        assert.equal(d.referenda.find(x => x.refIndex === 2).status, 'Passed');
        assert.equal(d.activeReferenda, 0);
    });

    test('row objects are stable across overlays, so the table sorts on current values', () => {
        const cache = newRowCache();
        const a = overlayDemocracy(rest(), null, cache).referenda.find(r => r.refIndex === 2);
        const b = overlayDemocracy(rest(), live({ refs: { 2: { refIndex: 2, status: 'Ongoing', ayes: 9, nays: 0, turnout: 9, tallyKnown: 1, endBlock: 900 } } }), cache).referenda.find(r => r.refIndex === 2);
        assert.equal(a, b);
        assert.equal(a.ayes, 9);
        // Live state goes away (link down): the REST values come back.
        overlayDemocracy(rest(), null, cache);
        assert.equal(a.ayes, 1);
        assert.equal(a.cancelled, undefined);
    });

    test('live public proposals decide which are open; seconds come from depositOf', () => {
        const d = overlayDemocracy(rest(), live({ props: [{ index: 1, proposer: 'eBob' }, { index: 4, proposer: 'eCarol' }],
            deposits: { 1: { seconds: 3, deposit: 10 }, 4: { seconds: 1, deposit: 7 } } }), newRowCache());
        assert.deepEqual(d.publicProposals.map(p => [p.index, p.seconds]), [[1, 3], [4, 1]]);
        assert.equal(d.publicProposals[0].proposerName, 'Bob');
        assert.equal(d.publicProposals[1].proposerName, undefined);
        assert.equal(d.activeProposals, 2);
        assert.equal(d.publicPropCount, 5);
        const tabled = overlayDemocracy(rest(), live({ props: [] }), newRowCache());
        assert.equal(tabled.publicProposals.length, 0);
    });

    test('a row the server does not have yet, with no hash from the chain, is marked for a placeholder', () => {
        const H = '0x' + 'cd'.repeat(32);
        const ref3 = (proposal) => ({ refIndex: 3, status: 'Ongoing', endBlock: 1000, ayes: 0, nays: 0, turnout: 0, tallyKnown: 1, proposal });
        const d = overlayDemocracy(rest(), live({ count: 4, refs: { 3: ref3(null) },
            props: [{ index: 1, proposer: 'eBob' }, { index: 4, proposer: 'eCarol', proposal: null }] }), newRowCache());
        assert.equal(d.referenda.find(r => r.refIndex === 3).proposalPending, 1);
        assert.equal(d.referenda.find(r => r.refIndex === 2).proposalPending, undefined);
        assert.equal(d.publicProposals.find(p => p.index === 4).proposalPending, 1);
        assert.equal(d.publicProposals.find(p => p.index === 1).proposalPending, undefined);
        const e = overlayDemocracy(rest(), live({ count: 4, refs: { 3: ref3(H) }, props: [{ index: 4, proposer: 'eCarol', proposal: H }] }), newRowCache());
        assert.equal(e.referenda.find(r => r.refIndex === 3).proposal, H);
        assert.equal(e.referenda.find(r => r.refIndex === 3).proposalPending, undefined);
        assert.equal(e.publicProposals[0].proposalPending, undefined);
    });

    test('null REST data stays null', () => {
        assert.equal(overlayDemocracy(null, live(), newRowCache()), null);
    });
});

const h = {
    pdex: (v) => Number(v || 0).toFixed(4), num: (v) => String(Number(v || 0)), esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    pending: () => null, myVote: () => null, canSecond: () => true
};

describe('cells', () => {
    test('every cell is wrapped with its key', () => {
        const cells = democracyCells(h);
        const row = { refIndex: 2, status: 'Ongoing', ayes: 1, nays: 0, turnout: 1, tallyKnown: 1 };
        assert.match(cells.cell('ref', row, 'tally'), /^<span data-dem-cell="ref:2:tally">1\.0000 \/ 0\.0000<\/span>$/);
        assert.match(cells.cell('ref', row, 'vote'), /data-ref-index="2" data-side="aye"/);
        const ended = { ...row, status: 'Passed' };
        assert.ok(!/referendum-vote-trigger/.test(cells.cell('ref', ended, 'vote')));
    });

    test('unknown tally is a dash', () => {
        const cells = democracyCells(h);
        assert.ok(!/0\.0000/.test(cells.cell('ref', { refIndex: 1, status: 'Passed', tallyKnown: 0 }, 'tally')));
    });

    test('an in-flight vote shows its stage on the row and disables the buttons', () => {
        const cells = democracyCells({ ...h, pending: (k) => (k === 'ref:2' ? { kind: 'aye', stage: 'broadcast' } : null) });
        const html = cells.cell('ref', { refIndex: 2, status: 'Ongoing' }, 'vote');
        assert.match(html, /Your Aye is being recorded/);
        assert.match(html, /bx-spin/);
        assert.match(html, /disabled/);
    });

    test('a failed vote shows the reason, escaped', () => {
        const cells = democracyCells({ ...h, pending: () => ({ kind: 'nay', stage: 'failed', error: '<img src=x onerror=alert(1)>' }) });
        const html = cells.cell('ref', { refIndex: 2, status: 'Ongoing' }, 'vote');
        assert.ok(!html.includes('<img'));
        assert.match(html, /&lt;img/);
    });

    test('the connected account\'s own vote is shown', () => {
        const cells = democracyCells({ ...h, myVote: (i) => (i === 2 ? { aye: false, balance: 12, conviction: 'Locked1x' } : null) });
        assert.match(cells.cell('ref', { refIndex: 2, status: 'Ongoing' }, 'vote'), /You voted Nay/);
    });

    test('proposal cells: seconds, deposit, and a Second button with its feedback', () => {
        const cells = democracyCells({ ...h, pending: (k) => (k === 'prop:4' ? { kind: 'second', stage: 'signing' } : null) });
        const row = { index: 4, seconds: 2, deposit: 7 };
        assert.equal(cells.cell('prop', row, 'seconds'), '<span data-dem-cell="prop:4:seconds">2</span>');
        const action = cells.cell('prop', row, 'action');
        assert.match(action, /Your second is being recorded/);
        assert.match(action, /class="[^"]*democracy-second-btn[^"]*" data-prop-index="4"/);
        assert.match(action, /disabled/);
    });

    test('index values that are not integers never reach an attribute', () => {
        const cells = democracyCells(h);
        assert.equal(cells.cell('ref', { refIndex: '"><script>', status: 'Ongoing' }, 'vote'), '');
        assert.equal(cells.cell('prop', { index: 'x"' }, 'seconds'), '');
    });
});

describe('patch plan', () => {
    const cells = democracyCells(h);
    const frameOf = (d, tab = 'referenda', extra = 'all') => democracyFrame(tab, d, cells, extra);

    test('a tally change patches two cells of one row', () => {
        const cache = newRowCache();
        const prev = frameOf(overlayDemocracy(rest(), null, cache));
        const next = frameOf(overlayDemocracy(rest(), live({ refs: { 2: { refIndex: 2, status: 'Ongoing', endBlock: 900, ayes: 7, nays: 0, turnout: 7, tallyKnown: 1 } } }), cache));
        const plan = democracyPatchPlan(prev, next);
        assert.equal(plan.full, false);
        assert.deepEqual(plan.changed.sort(), ['ref:2:tally', 'ref:2:turnout']);
    });

    test('nothing changed: nothing to do', () => {
        const d = overlayDemocracy(rest(), null, newRowCache());
        assert.deepEqual(democracyPatchPlan(frameOf(d), frameOf(d)), { full: false, changed: [] });
    });

    test('a new referendum, an ended one, a tab or filter switch: full render', () => {
        const base = frameOf(overlayDemocracy(rest(), null, newRowCache()));
        const added = frameOf(overlayDemocracy(rest(), live({ refs: { 3: { refIndex: 3, status: 'Ongoing', tallyKnown: 1, ayes: 0, nays: 0, turnout: 0 } } }), newRowCache()));
        const ended = frameOf(overlayDemocracy(rest(), live({ refs: { 2: { refIndex: 2, status: 'Passed', tallyKnown: 1, ayes: 1, nays: 0, turnout: 1 } } }), newRowCache()));
        assert.equal(democracyPatchPlan(base, added).full, true);
        assert.equal(democracyPatchPlan(base, ended).full, true);
        assert.equal(democracyPatchPlan(base, frameOf(overlayDemocracy(rest(), null, newRowCache()), 'proposals')).full, true);
        assert.equal(democracyPatchPlan(base, frameOf(overlayDemocracy(rest(), null, newRowCache()), 'referenda', 'Ongoing')).full, true);
        assert.equal(democracyPatchPlan(null, base).full, true);
    });

    test('proposals tab: a new second patches; a tabled proposal re-renders', () => {
        const cache = newRowCache();
        const props = [{ index: 1, proposer: 'eBob' }];
        const a = frameOf(overlayDemocracy(rest(), live({ props, deposits: { 1: { seconds: 1, deposit: 10 } } }), cache), 'proposals');
        const b = frameOf(overlayDemocracy(rest(), live({ props, deposits: { 1: { seconds: 2, deposit: 10 } } }), cache), 'proposals');
        const plan = democracyPatchPlan(a, b);
        assert.equal(plan.full, false);
        // The Second button carries the count too (the older runtimes' upper bound).
        assert.deepEqual(plan.changed.sort(), ['prop:1:action', 'prop:1:seconds']);
        const c = frameOf(overlayDemocracy(rest(), live({ props: [] }), cache), 'proposals');
        assert.equal(democracyPatchPlan(b, c).full, true);
    });

    test('overview and statistics: count changes re-render, tally ticks do not', () => {
        const cache = newRowCache();
        const a = frameOf(overlayDemocracy(rest(), null, cache), 'statistics');
        const b = frameOf(overlayDemocracy(rest(), live({ refs: { 2: { refIndex: 2, status: 'Ongoing', ayes: 7, nays: 0, turnout: 7, tallyKnown: 1, endBlock: 900 } } }), cache), 'statistics');
        assert.deepEqual(democracyPatchPlan(a, b), { full: false, changed: [] });
        const o1 = frameOf(overlayDemocracy(rest(), null, cache), 'overview');
        const o2 = frameOf(overlayDemocracy(rest(), live({ count: 4, refs: { 3: { refIndex: 3, status: 'Ongoing', tallyKnown: 1, ayes: 0, nays: 0, turnout: 0 } } }), cache), 'overview');
        assert.equal(democracyPatchPlan(o1, o2).full, true);
    });
});

describe('patcher', () => {
    function fakeRoot(keys) {
        const els = keys.map(k => ({ key: k, innerHTML: 'old' }));
        return {
            els,
            querySelectorAll: (sel) => {
                const m = /^\[data-dem-cell="([^"]+)"\]$/.exec(sel);
                assert.ok(m, 'unexpected selector ' + sel);
                return els.filter(e => e.key === m[1]);
            }
        };
    }

    test('replaces the inner html of the changed cells only', () => {
        const root = fakeRoot(['ref:2:tally', 'ref:2:turnout', 'ref:0:tally']);
        const n = patchDemocracyCells(root, ['ref:2:tally'], { 'ref:2:tally': '<span data-dem-cell="ref:2:tally">7 / 0</span>' });
        assert.equal(n, 1);
        assert.equal(root.els[0].innerHTML, '7 / 0');
        assert.equal(root.els[1].innerHTML, 'old');
        assert.equal(root.els[2].innerHTML, 'old');
    });

    test('a row on another page of the table is skipped, not an error', () => {
        const root = fakeRoot([]);
        assert.equal(patchDemocracyCells(root, ['ref:9:tally'], { 'ref:9:tally': '<span data-dem-cell="ref:9:tally">x</span>' }), 0);
    });

    test('a malformed key is never turned into a selector', () => {
        const root = fakeRoot([]);
        assert.equal(patchDemocracyCells(root, ['ref"]:x'], { 'ref"]:x': 'y' }), 0);
    });
});

describe('in-flight vote and second feedback', () => {
    test('stages: set, keep the failure text, clear on the neutral endings', () => {
        const m = new Map();
        assert.equal(demPendingStage(m, 'ref:2', 'aye', 'signing'), false);
        assert.deepEqual(m.get('ref:2'), { kind: 'aye', stage: 'signing' });
        assert.equal(demPendingStage(m, 'ref:2', 'aye', 'inBlock'), true, 'inBlock should ask for a fresh read');
        demPendingStage(m, 'ref:2', 'aye', 'failed', { text: 'Not enough PDEX' });
        assert.deepEqual(m.get('ref:2'), { kind: 'aye', stage: 'failed', error: 'Not enough PDEX' });
        for (const s of ['cancelled', 'stalled', 'unconfirmed', 'waiting', 'resent']) {
            demPendingStage(m, 'ref:2', 'aye', 'signing');
            demPendingStage(m, 'ref:2', 'aye', s);
            assert.equal(m.has('ref:2'), false, s);
        }
    });

    test('a vote is settled when it is in a block AND the voting record shows that side', () => {
        assert.equal(demPendingSettled({ kind: 'aye', stage: 'inBlock' }, { aye: true }), true);
        assert.equal(demPendingSettled({ kind: 'aye', stage: 'inBlock' }, { aye: false }), false, 'an old Nay settled a new Aye');
        assert.equal(demPendingSettled({ kind: 'aye', stage: 'broadcast' }, { aye: true }), false);
        assert.equal(demPendingSettled({ kind: 'nay', stage: 'finalized' }, null), true, 'without votingOf, Finalized settles');
        assert.equal(demPendingSettled({ kind: 'nay', stage: 'inBlock' }, null), false);
        assert.equal(demPendingSettled({ kind: 'aye', stage: 'failed', error: 'x' }, { aye: true }), false, 'a failure stays until the next attempt');
        assert.equal(demPendingSettled(null, null), true);
    });

    test('a second is settled once it is in a block', () => {
        assert.equal(demPendingSettled({ kind: 'second', stage: 'inBlock' }, null), true);
        assert.equal(demPendingSettled({ kind: 'second', stage: 'broadcast' }, null), false);
    });
});

describe('democracy.second call shape', () => {
    test('one argument on current runtimes; the seconds upper bound on older ones', () => {
        const calls = [];
        const mk = (n) => ({ tx: { democracy: { second: Object.assign((...a) => { calls.push(a); return 'tx'; }, { meta: { args: new Array(n) } }) } } });
        assert.equal(buildSecondTx(mk(1), 4, 2), 'tx');
        assert.deepEqual(calls.pop(), [4]);
        buildSecondTx(mk(2), 4, 2);
        assert.deepEqual(calls.pop(), [4, 3]);
    });

    test('a runtime without democracy.second is a clear error', () => {
        assert.throws(() => buildSecondTx({ tx: {} }, 1, 0), /not available/);
    });
});
