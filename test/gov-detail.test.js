// Governance item pages (2026-10-26, "a separate permalink for each proposal,
// referendum and motion ... including graph for voting percentage, discussion
// board"). Real code throughout: the route and vote arithmetic
// (lib/gov-detail.js), the API handlers on a real express app over a real
// SQLite file (lib/gov-detail-api.js, with a fake chain), the page renderer and
// controller (lib/gov-detail-view.js, with a fake DOM and fake node link), and
// the script.js / server.js wiring by source.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { blake2AsHex } from '@polkadot/util-crypto';
import * as db from '../db.js';
import {
    parseGovRoute, isGovDetailRoute, govItemPath, govApiPath, govThreadId, itemPathForThread, legacyGovRedirect,
    ayeNaySplit, turnoutPercent, weightedVotes, approvalState, motionProgress, etaText, humanDuration,
    nextLaunchBlock, referendumTimeline, motionTimeline, launchedReferendum
} from '../lib/gov-detail.js';
import { registerGovDetailRoutes, referendumDetail, proposalDetail, externalDetail, motionDetail, enactmentEventMatches, democracyEnactmentTaskIds } from '../lib/gov-detail-api.js';
import {
    renderGovDetailSummary, renderNotFound, govRowLinkHtml, wireGovRowClicks, barSvg, createGovDetailPage, GOV_ROW_CLASS, GOV_DETAIL_POLL_MS
} from '../lib/gov-detail-view.js';
import { isFreshRequest } from '../lib/gov-refresh.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';

const H1 = '0x' + '11'.repeat(32);
const H2 = '0x' + '22'.repeat(32);
const M1 = '0x' + 'aa'.repeat(32);
const M2 = '0x' + 'bb'.repeat(32);
const ALICE = 'eAliceAddressForTestsOnly000000000000000000000001';
const BOB = 'eBobAddressForTestsOnly00000000000000000000000002';
const CAROL = 'eCarolAddressForTestsOnly0000000000000000000000003';

const h = { esc: escapeHtml, num: (n) => String(n), pdex: (n) => String(n), shortAddr: (a) => String(a).slice(0, 6), fmtDate: (ms) => `T${ms}` };

describe('routes', () => {
    test('every item kind parses, ids are normalised, the query and #discussion are ignored', () => {
        assert.deepEqual(parseGovRoute('democracy/referendum/12'), { kind: 'referendum', id: '12' });
        assert.deepEqual(parseGovRoute('/democracy/referendum/007/'), { kind: 'referendum', id: '7' });
        assert.deepEqual(parseGovRoute('democracy/proposal/3?post=4#discussion'), { kind: 'proposal', id: '3' });
        assert.deepEqual(parseGovRoute('democracy/external/' + H1.toUpperCase().replace('0X', '0x')), { kind: 'external', id: H1 });
        assert.deepEqual(parseGovRoute('council/motion/' + M1), { kind: 'motion', id: M1, collective: 'council' });
        assert.deepEqual(parseGovRoute('council/motion/140'), { kind: 'motion', id: '140', collective: 'council' });
        assert.deepEqual(parseGovRoute('council/tc-motion/' + M2), { kind: 'motion', id: M2, collective: 'technicalCommittee' });
    });
    test('anything else is not a governance item route', () => {
        for (const bad of ['democracy', 'council', 'democracy/referendum', 'democracy/referendum/-1', 'democracy/referendum/1.5',
            'democracy/referendum/abc', 'democracy/referendum/1/2', 'democracy/external/0x12', 'democracy/external/12',
            'council/motion/0xzz', 'council/other/1', 'discussions/referendum-1', 'democracy/referendum/1234567890', '', null]) {
            assert.equal(parseGovRoute(bad), null, String(bad));
            assert.equal(isGovDetailRoute(bad), false);
        }
    });
    test('paths, API paths and thread ids line up with the indexer\'s thread ids', () => {
        assert.equal(govItemPath('referendum', 4), '/democracy/referendum/4');
        assert.equal(govItemPath('motion', 9, 'technicalCommittee'), '/council/tc-motion/9');
        assert.equal(govApiPath(parseGovRoute('council/tc-motion/9')), '/api/technical-committee/motion/9');
        assert.equal(govApiPath(parseGovRoute(`democracy/external/${H1}`)), `/api/democracy/external/${H1}`);
        assert.equal(govThreadId('referendum', '4'), 'referendum-4');
        assert.equal(govThreadId('proposal', 2), 'proposal-2');
        assert.equal(govThreadId('external', H1), `external-${H1}`);
        assert.equal(govThreadId('motion', M1), `motion-${M1}`);
        assert.equal(govThreadId('motion', M1, 'technicalCommittee'), null, 'TC motions have no thread');
        assert.equal(itemPathForThread(`motion-${M1}`), `/council/motion/${M1}`);
        assert.equal(itemPathForThread('referendum-3'), '/democracy/referendum/3');
        assert.equal(itemPathForThread('weird-1'), '');
        // Every page path parses back to itself.
        for (const p of ['/democracy/referendum/4', '/democracy/proposal/2', `/democracy/external/${H1}`, `/council/motion/${M1}`, '/council/tc-motion/9']) {
            const r = parseGovRoute(p);
            assert.equal(govItemPath(r.kind, r.id, r.collective), p);
        }
    });
    test('old query links (emails, calendar, bookmarks) redirect to the page', () => {
        assert.equal(legacyGovRedirect('democracy', '?ref=12'), 'democracy/referendum/12');
        assert.equal(legacyGovRedirect('/democracy/', '?proposal=3'), 'democracy/proposal/3');
        assert.equal(legacyGovRedirect('council', '?motion=140'), 'council/motion/140');
        assert.equal(legacyGovRedirect('council', '?tcmotion=5'), 'council/tc-motion/5');
        assert.equal(legacyGovRedirect('democracy', '?ref=abc'), null);
        assert.equal(legacyGovRedirect('democracy', ''), null);
        assert.equal(legacyGovRedirect('treasury', '?proposal=3'), null, 'treasury keeps its modal');
    });
});

describe('vote arithmetic behind the charts', () => {
    test('zero votes: an empty chart, not NaN', () => {
        assert.deepEqual(ayeNaySplit(0, 0), { aye: 0, nay: 0, total: 0, empty: true });
        assert.deepEqual(ayeNaySplit(null, undefined), { aye: 0, nay: 0, total: 0, empty: true });
        assert.equal(turnoutPercent(0, 1000), 0);
        assert.equal(turnoutPercent(5, 0), null, 'no electorate, no percentage');
    });
    test('rounding: one decimal, aye + nay always 100', () => {
        const s = ayeNaySplit(1, 2);
        assert.equal(s.aye, 33.3);
        assert.equal(s.nay, 66.7);
        for (const [a, n] of [[1, 2], [2, 1], [1, 6], [123.456, 0.001], [7, 7], [1, 0]]) {
            const x = ayeNaySplit(a, n);
            assert.equal(Math.round((x.aye + x.nay) * 10) / 10, 100, `${a}/${n}`);
        }
        assert.equal(turnoutPercent(1, 3), 33.33);
        assert.equal(turnoutPercent(5, 1), 100, 'capped');
        assert.equal(turnoutPercent(1, 1000000), 0, 'tiny turnout rounds to 0 (the page prints <0.01% only above 0)');
    });
    test('conviction: the chart uses the conviction-weighted tally; one vote = balance x multiplier', () => {
        assert.equal(weightedVotes(100, 'None'), 10);
        assert.equal(weightedVotes(100, 'Locked1x'), 100);
        assert.equal(weightedVotes(100, 'Locked6x'), 600);
        assert.equal(weightedVotes(100, 'Locked9x'), null);
        // 100 PDEX at 6x aye vs 300 PDEX at 1x nay: by turnout nay wins 75%, by votes aye wins 66.7%.
        const ayes = weightedVotes(100, 'Locked6x'), nays = weightedVotes(300, 'Locked1x');
        assert.equal(ayeNaySplit(ayes, nays).aye, 66.7);
        const html = renderGovDetailSummary(refPayload({ tally: { ayes, nays, turnout: 400, known: true } }), h);
        assert.ok(html.includes('66.7% aye / 33.3% nay'), 'the chart label is the weighted split');
        assert.ok(html.includes('400 PDEX voted'), 'turnout is the raw PDEX');
    });
    test('passing or failing under each threshold (adaptive quorum biasing)', () => {
        assert.equal(approvalState({ ayes: 2, nays: 1, threshold: 'SimpleMajority' }), 'passing');
        assert.equal(approvalState({ ayes: 1, nays: 1, threshold: 'SimpleMajority' }), 'failing');
        // Low turnout: approve needs a super-majority, against is easy.
        const low = { ayes: 60, nays: 40, turnout: 100, electorate: 10000 };
        assert.equal(approvalState({ ...low, threshold: 'SuperMajorityApprove' }), 'failing');
        assert.equal(approvalState({ ...low, threshold: 'SuperMajorityAgainst' }), 'passing');
        const full = { ayes: 60, nays: 40, turnout: 10000, electorate: 10000 };
        assert.equal(approvalState({ ...full, threshold: 'SuperMajorityApprove' }), 'passing');
        assert.equal(approvalState({ ayes: 0, nays: 0, turnout: 0, electorate: 1, threshold: 'SuperMajorityApprove' }), 'failing');
        assert.equal(approvalState({ ayes: 1, nays: 0, threshold: 'Other' }), null);
    });
    test('motion progress: ayes to the threshold, nays to rejection', () => {
        const p = motionProgress({ ayes: 2, nays: 1, threshold: 3, seats: 5 });
        assert.deepEqual([p.ayePct, p.toReject, p.nayPct, p.decided], [66.7, 3, 33.3, null]);
        assert.equal(motionProgress({ ayes: 3, nays: 0, threshold: 3, seats: 5 }).decided, 'approved');
        assert.equal(motionProgress({ ayes: 0, nays: 3, threshold: 3, seats: 5 }).decided, 'rejected');
        assert.equal(motionProgress({ ayes: 9, nays: 0, threshold: 3, seats: 5 }).ayePct, 100, 'capped');
        assert.deepEqual(motionProgress({ ayes: 0, nays: 0, threshold: 0, seats: 0 }).ayePct, 0);
    });
    test('bars: segments clamp to the track', () => {
        const svg = barSvg([{ pct: 70, cls: 'gd-aye' }, { pct: 50, cls: 'gd-nay' }]);
        assert.match(svg, /width="70" height="10" class="gd-aye"/);
        assert.match(svg, /x="70" y="0" width="30" height="10" class="gd-nay"/, 'the second segment is cut at 100');
        assert.match(svg, /aria-hidden="true"/, 'decorative: the numbers are printed next to it');
    });
});

describe('time and timelines', () => {
    test('block estimates', () => {
        assert.equal(etaText(1000 + 7200, 1000, 12000), 'in about 24 hours');
        assert.equal(etaText(1000 + 3 * 7200, 1000, 12000), 'in about 3 days');
        assert.equal(etaText(1000 - 300, 1000, 12000), 'about 60 minutes ago');
        assert.equal(etaText(1000, 1000), 'now');
        assert.equal(etaText(5, 0), '', 'unknown head: no guess');
        assert.equal(humanDuration(60000), '1 minute');
        assert.equal(nextLaunchBlock(1050, 100), 1100);
        assert.equal(nextLaunchBlock(1100, 100), 1200);
        assert.equal(nextLaunchBlock(0, 100), null);
    });
    test('referendum: launched at a launch boundary vs fast-tracked; enactment', () => {
        const std = referendumTimeline({ status: 'Passed', end: 1200, votingPeriod: 200, launchPeriod: 100, delay: 50, currentBlock: 2000, enactmentConfirmed: true });
        assert.deepEqual(std.map(s => [s.key, s.label, s.block, s.state]), [
            ['start', 'Voting started', 1000, 'done'], ['end', 'Voting ended', 1200, 'done'], ['outcome', 'Passed', 1200, 'done'], ['enact', 'Enacted', 1250, 'done']]);
        const fast = referendumTimeline({ status: 'Ongoing', end: 1234, votingPeriod: 200, launchPeriod: 100, delay: 10, currentBlock: 1100 });
        assert.equal(fast[0].block, null);
        assert.match(fast[0].note, /fast-tracked/);
        assert.deepEqual(fast.slice(1).map(s => [s.label, s.state]), [['Voting ends', 'current'], ['Result', 'upcoming'], ['Enacts if passed', 'upcoming']]);
        const failed = referendumTimeline({ status: 'NotPassed', end: 1200, votingPeriod: 200, launchPeriod: 100, currentBlock: 2000 });
        assert.ok(!failed.some(s => s.key === 'enact'), 'a failed referendum is never enacted');
        const unconfirmed = referendumTimeline({ status: 'Passed', end: 1200, votingPeriod: 200, launchPeriod: 100, delay: 50, currentBlock: 2000 });
        assert.equal(unconfirmed[3].label, 'Enactment block reached');
        assert.match(unconfirmed[3].note, /not confirmed/);
        assert.match(referendumTimeline({ status: 'Passed', end: 1200, currentBlock: 2000 }).pop().note, /archive/);
    });
    test('motion timeline, and what a closed thread became', () => {
        assert.deepEqual(motionTimeline({ status: 'executed', proposedBlock: 10, resolvedBlock: 20, currentBlock: 30 }).map(s => [s.label, s.block]), [['Proposed', 10], ['Executed', 20]]);
        assert.deepEqual(motionTimeline({ status: 'proposed', proposedBlock: 10, end: 40, currentBlock: 30 }).map(s => s.state), ['done', 'current', 'upcoming']);
        assert.equal(launchedReferendum({ later: [{ id: `external-${H1}` }, { id: 'referendum-5' }] }), 5);
        assert.equal(launchedReferendum(null), null);
    });
});

// A chain that answers from a table, or is down.
function fakeChain(over = {}) {
    return {
        up: true,
        ready() { return this.up; },
        consts: async () => ({ votingPeriod: 200, enactmentPeriod: 50, launchPeriod: 100, blockMs: 12000 }),
        currentBlock: async () => 1150,
        referendum: async () => ({ state: 'none' }),
        referendumAt: async () => null,
        decodeCall: async () => ({ call: null, note: 'The preimage of this call is not noted on chain, so its contents cannot be shown.' }),
        publicProp: async () => ({ absent: true }),
        deposit: async () => null,
        nextExternal: async () => ({ absent: true }),
        motionAt: async () => null,
        name: async () => 'Unknown',
        ...over
    };
}

const SHORT = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
let server, base, chain, DIR;
const dirs = [];
before(async () => {
    DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-gov-detail-'));
    dirs.push(DIR);
    db.initDb(DIR, true);
    db.setKv('democracy_meta', {
        referendumCount: 6, publicPropCount: 4, currentBlock: 1100, launchPeriod: 100, totalIssuance: 10000,
        publicProposals: [{ index: 3, proposer: ALICE, proposerName: 'Proposer <b>One</b>', deposit: 100, seconds: 2 }],
        externalProposal: { proposalHash: H1, threshold: 'SimpleMajority' }
    });
    db.upsertDemocracyReferendum({ refIndex: 1, status: 'Passed', endBlock: 1000, ayes: 30, nays: 10, turnout: 25, tallyKnown: 1, threshold: 'SuperMajorityApprove' });
    db.upsertDemocracyReferendum({ refIndex: 2, status: 'Ongoing', endBlock: 1200, ayes: 1, nays: 1, turnout: 1, tallyKnown: 1, threshold: 'SimpleMajority' });
    // Threads: a referendum, a closed external that became referendum #2, a tabled proposal.
    db.createThreadIfMissing({ id: 'referendum-1', kind: 'referendum', refKey: '1', title: 'Referendum #1' });
    db.setThreadProposalHash('referendum-1', '0x' + '33'.repeat(32));
    db.createThreadIfMissing({ id: `external-${H2}`, kind: 'external', refKey: H2, title: 'External proposal' });
    db.setThreadProposalHash(`external-${H2}`, H2);
    db.closeThread(`external-${H2}`, 'External proposal launched as referendum #2.');
    db.createThreadIfMissing({ id: 'referendum-2', kind: 'referendum', refKey: '2', title: 'Referendum #2' });
    db.setThreadProposalHash('referendum-2', H2);
    db.createThreadIfMissing({ id: 'proposal-0', kind: 'proposal', refKey: '0', title: 'Public Proposal #0' });
    db.setThreadProposalHash('proposal-0', H1);
    db.closeThread('proposal-0', 'Moved to a referendum.');
    db.createThreadIfMissing({ id: 'referendum-4', kind: 'referendum', refKey: '4', title: 'Referendum #4' });
    db.setThreadProposalHash('referendum-4', H1);
    // Motions: #7 executed (closed, from history), #8 open (live snapshot), #9 re-proposes #7's hash.
    db.upsertCollectiveMotion('council', { hash: M1, motionIndex: 7, section: 'treasury', method: 'approveProposal', proposer: BOB, proposerName: 'Bob', threshold: 3, proposedBlock: 500 });
    db.insertCollectiveMotionEvent('council', { hash: M1, block: 520, eventIndex: 1, kind: 'closed', ayes: 3, nays: 1 });
    db.insertCollectiveMotionEvent('council', { hash: M1, block: 520, eventIndex: 2, kind: 'executed' });
    db.upsertCollectiveMotion('council', { hash: M1, motionIndex: 9, section: 'treasury', method: 'approveProposal', proposer: BOB, threshold: 3, proposedBlock: 900 });
    db.insertCollectiveMotionEvent('council', { hash: M1, block: 950, eventIndex: 1, kind: 'disapproved' });
    db.createThreadIfMissing({ id: `motion-${M1}`, kind: 'motion', refKey: M1, title: 'treasury.approveProposal' });
    db.setKv('council', {
        currentBlock: 1100, collectivePallet: 'council',
        members: [{ address: ALICE, name: 'Alice' }, { address: BOB, name: 'Bob' }, { address: CAROL, name: 'Unknown' }],
        motions: [{ hash: M2, index: 8, title: 'democracy.externalPropose', section: 'democracy', method: 'externalPropose',
            args: [{ name: 'proposal', value: '<img src=x onerror=alert(1)>' }], proposalHash: H1, threshold: 2, ayes: [ALICE], nays: [], end: 1300 }]
    });
    db.setKv('technicalCommittee', { members: [{ address: ALICE, name: 'Alice' }], motions: [] });

    chain = fakeChain();
    const app = express();
    registerGovDetailRoutes(app, {
        db, chain, isFresh: isFreshRequest,
        cacheShort: (res) => res.set('Cache-Control', SHORT),
        serverError: (res) => { res.set('Cache-Control', 'no-store'); res.status(500).json({ error: 'Internal error.' }); }
    });
    await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
    if (server) server.close();
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});
async function get(p) {
    const res = await fetch(base + p);
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
}

describe('API routes', () => {
    test('a live referendum: chain tally, decoded call, short cache tier', async () => {
        chain.referendum = async () => ({ state: 'ongoing', end: 1200, threshold: 'SimpleMajority', delay: 50, ayes: 600, nays: 300, turnout: 450, bounded: null, proposalHash: H2 });
        chain.decodeCall = async () => ({ call: { section: 'treasury', method: 'spend', args: [{ name: 'amount', type: 'Compact<u128>', value: '5' }] } });
        try {
            const r = await get('/api/democracy/referendum/2');
            assert.equal(r.status, 200);
            assert.equal(r.cache, SHORT);
            assert.equal(r.body.title, 'Referendum #2: treasury.spend');
            assert.equal(r.body.status, 'Ongoing');
            assert.deepEqual(r.body.tally, { ayes: 600, nays: 300, turnout: 450, known: true });
            assert.equal(r.body.electorate, 10000);
            assert.equal(r.body.threadId, 'referendum-2');
            assert.deepEqual(r.body.thread.links.earlier.map(t => t.id), [`external-${H2}`], 'links back to the external proposal');
            assert.equal(r.body.timeline.find(s => s.key === 'start').block, 1000);
        } finally { chain.referendum = async () => ({ state: 'none' }); chain.decodeCall = fakeChain().decodeCall; }
    });
    test('?fresh=1 is no-store', async () => {
        const r = await get('/api/democracy/referendum/1?fresh=1');
        assert.equal(r.status, 200);
        assert.equal(r.cache, 'no-store');
    });
    test('an old referendum resolves from stored history with the node down', async () => {
        chain.up = false;
        try {
            const r = await get('/api/democracy/referendum/1');
            assert.equal(r.status, 200);
            assert.equal(r.body.status, 'Passed');
            assert.deepEqual(r.body.tally, { ayes: 30, nays: 10, turnout: 25, known: true });
            assert.equal(r.body.sources.chain, false);
            assert.match(r.body.callNote || '', /unreachable/);
        } finally { chain.up = true; }
    });
    test('a finished referendum reads its call and delay from archive state at end - 1', async () => {
        const seen = [];
        chain.referendum = async () => ({ state: 'finished', approved: true, end: 1000 });
        chain.referendumAt = async (i, b) => { seen.push([i, b]); return { state: 'ongoing', end: 1000, threshold: 'SuperMajorityApprove', delay: 25, ayes: 31, nays: 9, turnout: 26, bounded: null, proposalHash: H2 }; };
        try {
            const r = await get('/api/democracy/referendum/1');
            assert.deepEqual(seen, [[1, 999]]);
            assert.equal(r.body.delay, 25);
            assert.equal(r.body.sources.archive, true);
            assert.deepEqual(r.body.tally, { ayes: 30, nays: 10, turnout: 25, known: true }, 'the stored final tally wins over a re-read');
            assert.equal(r.body.timeline.find(s => s.key === 'enact').block, 1025);
        } finally { chain.referendum = async () => ({ state: 'none' }); chain.referendumAt = async () => null; }
    });
    test('a removed referendum below referendumCount is Cancelled, not 404', async () => {
        const r = await get('/api/democracy/referendum/3');
        assert.equal(r.status, 200);
        assert.equal(r.body.status, 'Cancelled');
    });
    test('not found and bad ids: 404 / 400, both no-store', async () => {
        for (const [p, code] of [['/api/democracy/referendum/99', 404], ['/api/democracy/referendum/abc', 400], ['/api/democracy/proposal/77', 404],
            [`/api/democracy/external/${'0x' + '99'.repeat(32)}`, 404], ['/api/democracy/external/0x12', 400],
            [`/api/council/motion/${'0x' + '99'.repeat(32)}`, 404], ['/api/council/motion/555', 404], ['/api/council/motion/x', 400],
            ['/api/technical-committee/motion/1', 404]]) {
            const r = await get(p);
            assert.equal(r.status, code, p);
            assert.equal(r.cache, 'no-store', p + ': a cached not-found would hide an item created a block later');
            assert.ok(r.body.error, p);
        }
    });
    test('a failing chain read degrades the page; a failing database is a 500 with no-store', async () => {
        chain.consts = async () => { throw new Error('boom'); };
        try {
            const r = await get('/api/democracy/referendum/1');
            assert.equal(r.status, 200, 'a failing chain read degrades, it does not fail the page');
        } finally { chain.consts = fakeChain().consts; }
        const app = express();
        registerGovDetailRoutes(app, { db: { getKv() { throw new Error('database is locked'); } }, chain: fakeChain(), isFresh: isFreshRequest,
            cacheShort: (res) => res.set('Cache-Control', SHORT),
            serverError: (res) => { res.set('Cache-Control', 'no-store'); res.status(500).json({ error: 'Internal error.' }); } });
        const srv = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
        try {
            const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/democracy/referendum/1`);
            assert.equal(res.status, 500);
            assert.equal(res.headers.get('cache-control'), 'no-store');
        } finally { srv.close(); }
    });
    test('a queued public proposal: proposer, seconders, next launch', async () => {
        chain.publicProp = async () => ({ bounded: null, proposalHash: H1, proposer: ALICE });
        chain.deposit = async () => ({ seconders: [ALICE, BOB, CAROL], deposit: 100 });
        chain.name = async (a) => (a === BOB ? 'Bob' : 'Unknown');
        try {
            const r = await get('/api/democracy/proposal/3');
            assert.equal(r.status, 200);
            assert.equal(r.body.status, 'Queued');
            assert.equal(r.body.seconds, 3);
            assert.deepEqual(r.body.seconders.map(s => s.name), [null, 'Bob', null]);
            assert.equal(r.body.nextLaunch, 1200);
            assert.equal(r.body.proposer.name, 'Proposer <b>One</b>', 'raw here; escaped by the page');
        } finally { Object.assign(chain, { publicProp: fakeChain().publicProp, deposit: fakeChain().deposit, name: fakeChain().name }); }
    });
    test('a tabled public proposal resolves from its thread and names the referendum it became', async () => {
        const r = await get('/api/democracy/proposal/0');
        assert.equal(r.status, 200);
        assert.equal(r.body.status, 'Tabled');
        assert.equal(r.body.tabledAs, 4);
    });
    test('external proposals: queued (launch block or fast-track) and launched (from its closed thread)', async () => {
        chain.nextExternal = async () => ({ bounded: null, proposalHash: H1, threshold: 'SimpleMajority' });
        const q = await get(`/api/democracy/external/${H1}`);
        chain.nextExternal = fakeChain().nextExternal;
        assert.equal(q.status, 200);
        assert.equal(q.body.thresholdLabel, 'simple majority');
        assert.equal(q.body.status, 'Queued');
        assert.equal(q.body.nextLaunch, 1200);
        assert.match(q.body.timeline.find(s => s.key === 'launch').label, /Technical Committee fast-track/);
        // The node says the slot is empty: the snapshot does not resurrect it.
        assert.equal((await get(`/api/democracy/external/${H1}`)).status, 404, 'live chain wins over a stale snapshot');
        // Launched: found from its closed thread.
        const l = await get(`/api/democracy/external/${H2}`);
        assert.equal(l.status, 200);
        assert.equal(l.body.status, 'Launched');
        assert.equal(l.body.launchedAs, 2);
    });
    test('council motions: open from the snapshot, closed from history, by hash or index', async () => {
        const open = await get(`/api/council/motion/${M2}`);
        assert.equal(open.status, 200);
        assert.equal(open.body.status, 'proposed');
        assert.equal(open.body.index, 8);
        assert.deepEqual([open.body.ayes, open.body.nays, open.body.threshold, open.body.seats], [1, 0, 2, 3]);
        assert.deepEqual(open.body.members.map(m => m.vote), ['aye', null, null]);
        assert.equal(open.body.ayeVoters[0].name, 'Alice');
        assert.equal(open.body.proposalHash, H1);
        const byIndex = await get('/api/council/motion/7');
        assert.equal(byIndex.status, 200);
        assert.equal(byIndex.body.index, 7, 'an index picks that motion, not the newest with its hash');
        assert.equal(byIndex.body.status, 'executed');
        assert.deepEqual([byIndex.body.ayes, byIndex.body.nays], [3, 1]);
        assert.deepEqual(byIndex.body.related.map(m => m.index), [9]);
        assert.equal(byIndex.body.threadId, `motion-${M1}`);
        const byHash = await get(`/api/council/motion/${M1}`);
        assert.equal(byHash.body.index, 9, 'a hash picks the newest motion with it');
        const tc = await get('/api/technical-committee/motion/7');
        assert.equal(tc.status, 404, 'collectives are separate');
    });
    test('a closed motion reads its voters from archive state just before it resolved', async () => {
        const seen = [];
        chain.motionAt = async (c, hash, b) => { seen.push([c, hash, b]); return { call: { section: 'treasury', method: 'approveProposal', args: [{ name: 'proposal_id', type: 'Compact<u32>', value: '12' }] }, voting: { index: 7, threshold: 3, ayes: [ALICE, BOB, CAROL], nays: [], end: 600 } }; };
        try {
            const r = await get('/api/council/motion/7');
            assert.deepEqual(seen, [['council', M1, 519]]);
            assert.deepEqual(r.body.ayeVoters.map(v => v.name), ['Alice', 'Bob', null]);
            assert.equal(r.body.call.args[0].value, '12');
            assert.equal(r.body.sources.archive, true);
        } finally { chain.motionAt = async () => null; }
    });
});

function refPayload(over = {}) {
    return {
        kind: 'referendum', id: '2', index: 2, title: 'Referendum #2: treasury.spend', status: 'Ongoing', endBlock: 1200, delay: 50,
        threshold: 'SimpleMajority', thresholdLabel: 'simple majority', proposalHash: H2,
        call: { section: 'treasury', method: 'spend', args: [{ name: 'amount', type: 'u128', value: '5' }] },
        tally: { ayes: 600, nays: 300, turnout: 450, known: true }, electorate: 10000, currentBlock: 1100, blockMs: 12000, now: 1e12,
        timeline: referendumTimeline({ status: 'Ongoing', end: 1200, votingPeriod: 200, launchPeriod: 100, delay: 50, currentBlock: 1100 }),
        threadId: 'referendum-2', thread: { id: 'referendum-2', status: 'open', postCount: 2, links: { earlier: [{ id: `external-${H2}`, kind: 'external', title: 'External <i>x</i>', status: 'closed' }], later: [] } },
        sources: { chain: true, archive: null }, ...over
    };
}

describe('rendering and escaping', () => {
    test('a referendum page: chart, text values, verdict, time remaining, lifecycle links to item pages', () => {
        const html = renderGovDetailSummary(refPayload(), h);
        assert.ok(html.includes('66.7% aye / 33.3% nay'));
        assert.ok(html.includes('4.5%'), 'turnout of the electorate');
        assert.ok(html.includes('Passing right now under simple majority'));
        assert.ok(html.includes('in about 20 minutes'), 'time remaining');
        assert.ok(html.includes(`href="/democracy/external/${H2}"`), 'earlier stage links to its page, not its thread');
        assert.ok(html.includes('External &lt;i&gt;x&lt;/i&gt;'));
        assert.ok(html.includes('data-gd-copy="/democracy/referendum/2"'));
        assert.ok(html.includes('href="#discussion"'));
        assert.ok(html.includes('<code class="gd-call-name">treasury.spend</code>'));
    });
    test('everything from the chain or the index is escaped', () => {
        const evil = '<img src=x onerror=alert(1)>';
        const html = renderGovDetailSummary(refPayload({
            title: evil, threshold: evil, thresholdLabel: evil, proposalHash: evil,
            call: { section: evil, method: evil, args: [{ name: evil, type: evil, value: evil }] },
            timeline: [{ key: 'x', label: evil, block: null, state: evil, note: evil }]
        }), h);
        assert.ok(!html.includes('<img'), 'no raw markup from data');
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
        const motion = renderGovDetailSummary({ kind: 'motion', collective: 'council', id: M1, hash: M1, index: 7, title: 'm', status: 'proposed',
            call: null, callNote: evil, proposer: { address: '"><script>', name: evil }, ayes: 1, nays: 0, threshold: 2, seats: 3,
            ayeVoters: [{ address: ALICE, name: evil }], nayVoters: [], members: [{ address: ALICE, name: evil, vote: 'aye' }], related: [], timeline: [] }, h);
        assert.ok(!motion.includes('<img') && !motion.includes('<script'));
        assert.ok(motion.includes('href="/account/%22%3E%3Cscript%3E"'));
    });
    test('a motion page: threshold progress, voters, every member\'s vote; its permalink is the index', () => {
        const html = renderGovDetailSummary({ kind: 'motion', collective: 'council', id: M1, hash: M1, index: 7, title: 'Council Motion #7', status: 'executed',
            call: null, callNote: 'x', ayes: 3, nays: 1, threshold: 3, seats: 5, ayeVoters: [{ address: ALICE, name: 'Alice' }], nayVoters: [{ address: BOB, name: null }],
            members: [{ address: ALICE, name: 'Alice', vote: 'aye' }, { address: CAROL, name: null, vote: null }], related: [{ index: 9, status: 'disapproved' }], timeline: [] }, h);
        assert.ok(html.includes('3 of 3 needed') && html.includes('1 of 3 to reject'));
        assert.ok(html.includes('Not voted'));
        assert.ok(html.includes('#9 (Disapproved)'));
        assert.ok(html.includes('data-gd-copy="/council/motion/7"'));
    });
    test('unknown tally and not-found states say so', () => {
        assert.match(renderGovDetailSummary(refPayload({ tally: { known: false } }), h), /tally of this referendum is not indexed/);
        const nf = renderNotFound(parseGovRoute('democracy/referendum/99'), 'Referendum #99 was not found. <b>', h);
        assert.match(nf, /This referendum was not found/);
        assert.ok(nf.includes('&lt;b&gt;') && nf.includes('role="alert"'));
    });
});

// ---- the page controller --------------------------------------------------------

function nativeLike(impl) {
    return function (...args) {
        if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
        return impl(...args);
    };
}
function fakeEl() {
    const kids = {};
    const e = {
        _html: '', listeners: {},
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = v; for (const k of Object.keys(kids)) delete kids[k]; },
        querySelector(sel) {
            if (!this._html.includes(sel === '#discussion' ? 'id="discussion"' : sel.replace(/^\[|\]$/g, ''))) return null;
            return kids[sel] || (kids[sel] = fakeEl());
        },
        querySelectorAll: () => []
    };
    return e;
}
function pageWorld({ body = refPayload(), status = 200, api = null } = {}) {
    const root = fakeEl();
    const calls = { fetch: [], threads: [], seo: [], scrolled: 0 };
    const intervals = [];
    const timers = { setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval: () => {}, setTimeout: (fn) => { calls.timeout = fn; return 1; }, clearTimeout: () => {} };
    let current = body;
    const fetchFn = nativeLike(async (url, opts) => { calls.fetch.push({ url, opts }); return { ok: status === 200, status, json: async () => JSON.parse(JSON.stringify(current)) }; });
    const page = createGovDetailPage({
        root: () => root, h, fetchFn, timers, visible: () => true,
        loadThread: async (id, el, o) => { calls.threads.push({ id, el, o }); },
        setSeo: (o) => calls.seo.push(o), getApi: () => api, toAddress: (a) => a, account: () => null,
        location: () => ({ search: '', hash: '#discussion', origin: 'https://explorer.example' }), env: {}, scrollTo: () => { calls.scrolled++; }
    });
    return { page, root, calls, intervals, setBody: (b) => { current = b; } };
}
const flush = () => new Promise(r => setImmediate(r));

describe('the page: embedded discussion, live votes, polling', () => {
    test('fetch is called unbound; the board loads the item\'s thread into the page\'s own element', async () => {
        const w = pageWorld();
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        assert.equal(w.calls.fetch[0].url, '/api/democracy/referendum/2');
        assert.equal(w.calls.fetch[0].opts.cache, 'no-store');
        assert.equal(w.calls.threads.length, 1);
        assert.equal(w.calls.threads[0].id, 'referendum-2');
        assert.equal(w.calls.threads[0].el, w.root.querySelector('[data-gd-thread]'), 'rendered inside #discussion on this page');
        assert.equal(w.calls.threads[0].o.focus, false);
        assert.equal(typeof w.calls.threads[0].o.onRendered, 'function', 'the board reports what it drew');
        assert.ok(w.root.innerHTML.includes('id="discussion"'));
        assert.equal(w.calls.scrolled, 1, '#discussion scrolls to the board');
        assert.match(w.calls.seo[0].title, /^Referendum #2: treasury\.spend/);
        assert.equal(w.intervals[0].ms, GOV_DETAIL_POLL_MS);
    });
    test('no thread: a note instead of a board, and no thread fetch', async () => {
        const w = pageWorld({ body: refPayload({ thread: null, status: 'Passed' }) });
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        assert.equal(w.calls.threads.length, 0);
        assert.match(w.root.innerHTML, /no discussion thread for this item/);
    });
    test('404: the not-found state, noindex', async () => {
        const w = pageWorld({ body: { error: 'Referendum #99 was not found.' }, status: 404 });
        w.page.open('democracy/referendum/99');
        await flush(); await flush();
        assert.match(w.root.innerHTML, /This referendum was not found/);
        assert.equal(w.calls.seo[0].noindex, true);
        const bad = pageWorld();
        bad.page.open('democracy/referendum/x');
        assert.match(bad.root.innerHTML, /was not found/);
        assert.equal(bad.calls.fetch.length, 0);
    });
    test('live: a referendumInfoOf delivery redraws the votes; stop() unsubscribes, even when the unsub arrives late', async () => {
        let deliver = null, unsubbed = 0, release;
        const late = new Promise(r => { release = r; });
        const api = { query: { democracy: {
            referendumInfoOf(i, cb) { assert.equal(i, 2); deliver = cb; return late; },
            votingOf() { return Promise.resolve(() => {}); }, depositOf() { return Promise.resolve(() => {}); }
        } } };
        const w = pageWorld({ api });
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        assert.equal(typeof deliver, 'function');
        const info = (ayes, nays, turnout) => ({ isNone: false, isSome: true, unwrap: () => ({ isOngoing: true, asOngoing: { end: 1200, threshold: 'SimpleMajority', tally: { ayes, nays, turnout } } }) });
        deliver(info('900000000000000', '100000000000000', '500000000000000'));
        const summary = w.root.querySelector('[data-gd-summary]');
        assert.ok(summary.innerHTML.includes('90% aye / 10% nay'), 'redrawn from the live tally');
        assert.ok(!w.calls.threads.some((t, i) => i > 0), 'the discussion board is not reloaded by a vote');
        w.page.stop();
        deliver(info('1', '1', '1'));
        assert.ok(summary.innerHTML.includes('90% aye'), 'nothing after stop()');
        release(() => { unsubbed++; });
        await flush();
        assert.equal(unsubbed, 1, 'a subscription that resolves after stop() is released');
    });
    test('live: a council motion vote updates the voters; a closed motion refetches', async () => {
        let deliver = null;
        const api = { query: { council: { proposals() {}, voting: Object.assign((hash, cb) => { assert.equal(hash, M1); deliver = cb; return Promise.resolve(() => {}); }, { multi() {} }) } } };
        const body = { kind: 'motion', collective: 'council', id: M1, hash: M1, index: 8, title: 'Council Motion #8', status: 'proposed', call: null, callNote: 'x',
            ayes: 0, nays: 0, threshold: 2, seats: 3, ayeVoters: [], nayVoters: [], members: [{ address: ALICE, name: 'Alice', vote: null }, { address: BOB, name: 'Bob', vote: null }],
            related: [], timeline: [], threadId: `motion-${M1}`, thread: null, sources: { chain: true } };
        const w = pageWorld({ body, api });
        w.page.open(`council/motion/8`);
        await flush(); await flush();
        deliver({ isNone: false, isSome: true, unwrap: () => ({ index: 8, threshold: 2, end: 1300, ayes: [ALICE], nays: [BOB] }) });
        const html = w.root.querySelector('[data-gd-summary]').innerHTML;
        assert.ok(html.includes('1 of 2 needed'));
        assert.ok(html.includes('gd-vote-aye') && html.includes('gd-vote-nay'));
        deliver({ isNone: true });
        assert.equal(typeof w.calls.timeout, 'function', 'closed: ask the server for the outcome');
        w.calls.timeout();
        await flush();
        assert.match(w.calls.fetch.at(-1).url, /\?fresh=1$/);
    });
    test('the 30 s poll redraws only the summary', async () => {
        const w = pageWorld();
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        const boardBefore = w.root.querySelector('[data-gd-thread]');
        w.setBody(refPayload({ tally: { ayes: 1, nays: 3, turnout: 4, known: true } }));
        w.intervals[0].fn();
        await flush(); await flush();
        assert.ok(w.root.querySelector('[data-gd-summary]').innerHTML.includes('25% aye / 75% nay'));
        assert.equal(w.root.querySelector('[data-gd-thread]'), boardBefore, 'the board (and a half-written post) survives');
        assert.equal(w.calls.threads.length, 1);
    });
});

describe('the header count follows the board (referendum #36: "Discussion (2)" over one message)', () => {
    const withThread = (own, earlier = 0) => refPayload({ thread: { id: 'referendum-2', status: 'open', postCount: own, earlierPostCount: earlier, links: { earlier: [], later: [] } } });
    const headerOf = (w) => (w.root.querySelector('[data-gd-summary]').innerHTML.match(/>(Discussion[^<]*)<\/a>/) || [])[1];
    const post = (id) => ({ id, content: 'p' + id });
    test('the board drew one post while the (cached, polled) API says two: the button says one, and the board is read again', async () => {
        const w = pageWorld({ body: withThread(1) });
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        const first = w.calls.threads[0];
        first.o.onRendered({ id: 'referendum-2' }, [post(1)], []);
        assert.equal(headerOf(w), 'Discussion (1)');
        // Someone posts; the 30 s poll now reports two.
        w.setBody(withThread(2));
        w.intervals[0].fn();
        await flush(); await flush();
        assert.equal(headerOf(w), 'Discussion (1)', 'never ahead of what the board lists');
        assert.equal(w.calls.threads.length, 2, 'the board is read again');
        assert.equal(w.calls.threads[1].o.quiet, true, 'in the background, without the loading placeholder');
        w.calls.threads[1].o.onRendered({ id: 'referendum-2' }, [post(1), post(2)], []);
        assert.equal(headerOf(w), 'Discussion (2)');
        // Nothing changed: the next poll leaves the board alone.
        w.intervals[0].fn();
        await flush(); await flush();
        assert.equal(w.calls.threads.length, 2);
    });
    test('earlier posts are named apart from the item\'s own', async () => {
        const w = pageWorld({ body: withThread(1, 2) });
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        assert.equal(headerOf(w), 'Discussion (1) + 2 earlier', 'before the board has drawn, the API\'s counts');
        w.calls.threads[0].o.onRendered({ id: 'referendum-2' }, [post(1)], [{ thread: { id: 'motion-x' }, posts: [post(7), post(8)] }]);
        assert.equal(headerOf(w), 'Discussion (1) + 2 earlier');
        assert.equal(w.calls.threads.length, 1, 'counts agree: no reload');
    });
    test('a post being written is never thrown away by the refresh: the header holds at the board\'s count until it is sent', async () => {
        const w = pageWorld({ body: withThread(1) });
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        w.calls.threads[0].o.onRendered({ id: 'referendum-2' }, [post(1)], []);
        const board = w.root.querySelector('[data-gd-thread]');
        board.querySelector = (sel) => (sel === '#discuss-post-input' ? { value: 'half a sentence' } : null);
        w.setBody(withThread(2));
        w.intervals[0].fn();
        await flush(); await flush();
        assert.equal(w.calls.threads.length, 1, 'no redraw over the draft');
        assert.equal(headerOf(w), 'Discussion (1)');
        board.querySelector = () => null;   // sent or cleared
        w.intervals[0].fn();
        await flush(); await flush();
        assert.equal(w.calls.threads.length, 2, 'the next poll refreshes');
    });
    test('until the board catches up the header holds at the count of what the board lists, and each poll retries', async () => {
        const w = pageWorld({ body: withThread(1) });
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        w.calls.threads[0].o.onRendered({ id: 'referendum-2' }, [post(1)], []);
        w.setBody(withThread(2));
        w.intervals[0].fn();
        await flush(); await flush();
        assert.equal(headerOf(w), 'Discussion (1)');
        w.intervals[0].fn();
        await flush(); await flush();
        assert.equal(w.calls.threads.length, 3, 'tried again on the next poll');
    });
});

describe('list rows open the item pages', () => {
    test('the row link is a real, escaped link', () => {
        assert.equal(govRowLinkHtml('/democracy/referendum/4', '#4', escapeHtml), '<a href="/democracy/referendum/4" class="gov-item-link" data-gov-row-link="true">#4</a>');
        assert.ok(!govRowLinkHtml('/x"><b>', '<b>', escapeHtml).includes('<b>'));
    });
    function rowWorld() {
        let listener = null;
        const clicked = [], opened = [];
        const link = { getAttribute: () => '/democracy/referendum/4', click: () => clicked.push(1) };
        const row = { querySelector: (s) => (s === 'a[data-gov-row-link]' ? link : null) };
        const target = (interactive) => ({ closest: (s) => (s === '.' + GOV_ROW_CLASS ? row : (interactive && s.includes('button') ? {} : null)) });
        let sel = '';
        wireGovRowClicks({ addEventListener: (t, fn) => { listener = fn; } }, { open: (href) => opened.push(href), selection: () => sel });
        return { fire: (e) => listener({ button: 0, ...e }), target, clicked, opened, setSel: (s) => { sel = s; } };
    }
    test('a click on the row follows its link; buttons, selections and modifiers behave', () => {
        const w = rowWorld();
        w.fire({ target: w.target(false) });
        assert.equal(w.clicked.length, 1);
        w.fire({ target: w.target(true) });
        assert.equal(w.clicked.length, 1, 'a Vote or Second button inside the row does its own job');
        w.setSel('selected text');
        w.fire({ target: w.target(false) });
        assert.equal(w.clicked.length, 1, 'selecting text is not a click');
        w.setSel('');
        w.fire({ target: w.target(false), ctrlKey: true });
        assert.deepEqual(w.opened, ['/democracy/referendum/4']);
        w.fire({ target: w.target(false), button: 1 });
        w.fire({ target: w.target(false), defaultPrevented: true });
        assert.equal(w.clicked.length, 1);
        w.fire({ target: { closest: () => null } });
        assert.equal(w.clicked.length, 1);
    });
});

describe('wiring', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));
    const server = stripComments(readRepo('server.js', import.meta.url));
    const html = readRepo('index.html', import.meta.url);
    test('routeTo: the page, the legacy redirect, stop on every navigation', () => {
        const route = bodyOf(script, 'routeTo');
        assert.match(route, /stopCouncilPolling\(\); democracyView\.stop\(\); govDetailPage\.stop\(\);/);
        assert.match(route, /legacyGovRedirect\(target\.split\(\/\[\?#\]\/\)\[0\], window\.location\.search\)/);
        assert.match(route, /isGovDetailRoute\(target\)\) \{\s*mainTarget = 'governance-details';/);
        assert.match(route, /mainTarget === 'governance-details'\) \{\s*govDetailPage\.open\(detailId\);/);
        assert.ok(route.indexOf('isGovDetailRoute(target)') < route.indexOf("target.startsWith('discussions/')"));
        assert.match(html, /data-page="governance-details"[\s\S]{0,120}id="governance-details-content"/);
        assert.match(script, /'governance-details': \{ title:/);
    });
    test('the embedded board is script.js\'s own thread view, in the page\'s element, with fetch unbound', () => {
        assert.match(script, /loadThread: \(id, el, o\) => fetchDiscussionThread\(id, o\.focus, el, \{ embedded: true, onRendered: o\.onRendered, quiet: o\.quiet \}\)/);
        assert.match(script, /fetchFn: \(u, o\) => fetch\(u, o\)/);
        const render = bodyOf(script, 'renderThread');
        assert.match(render, /root\.querySelector\('#discuss-signin-btn'\)/);
        assert.match(render, /root\.querySelector\('#discuss-post-btn'\)/);
        assert.ok(!/document\.getElementById\('discuss-/.test(render), 'a hidden /discussions page must not capture the buttons');
        assert.match(bodyOf(script, 'submitDiscussionPost'), /root && root\.querySelector\('#discuss-post-input'\)/);
        assert.match(bodyOf(script, 'submitDiscussionPost'), /renderThread\(data\.thread, data\.posts \|\| \[\], root, opts\)/);
    });
    test('Democracy and Council rows link to the pages and are clickable as a whole', () => {
        assert.match(bodyOf(script, 'mountDemocracyReferendaTable'), /govRowLinkHtml\(govItemPath\('referendum', row\.refIndex\)/);
        assert.match(bodyOf(script, 'mountDemocracyReferendaTable'), /rowClass: \(\) => GOV_ROW_CLASS/);
        assert.match(bodyOf(script, 'mountDemocracyProposalsTable'), /govRowLinkHtml\(govItemPath\('proposal', row\.index\)/);
        assert.match(bodyOf(script, 'mountDemocracyProposalsTable'), /govItemPath\('proposal', row\.index\)\}#discussion/);
        assert.match(bodyOf(script, 'renderCollectiveMotions'), /govItemPath\('motion', m\.index, view\.key\)/);
        assert.match(bodyOf(script, 'renderCollectiveMotions'), /class="motion-card \$\{GOV_ROW_CLASS\}"/);
        assert.match(bodyOf(script, 'renderResolvedMotions'), /<tr class="\$\{GOV_ROW_CLASS\}">/);
        assert.match(script, /wireGovRowClicks\(document,/);
        assert.ok(!/data-kind="(referendum|public-proposal|motion)"/.test(script), 'no row still opens the old modal');
    });
    test('server: routes registered with the short tier and ?fresh=1; calendar and emails link to the pages', () => {
        assert.match(server, /registerGovDetailRoutes\(app, \{ db, chain: govChain, cacheShort, isFresh: isFreshRequest, serverError, enactmentTaskId: govEnactmentTaskId \}\)/);
        assert.match(server, /link: '\/democracy\/referendum\/' \+ r\.refIndex/);
        assert.match(server, /\$\{emailSiteOrigin\(\)\}\/council\/motion\/\$\{m\.motionIndex\}/);
        assert.ok(!/democracy\?ref=|council\?motion=/.test(server), 'no new link uses the old query form');
        assert.match(server, /\{ path: '\/help\/governance-item-pages'/);
    });
    test('script.js stays under its ceiling', () => {
        assert.ok(readRepo('script.js', import.meta.url).split('\n').length < 15000);
    });
});

// ---- review fixes (Fable review of 7bafc9a) -----------------------------------------

describe('review fixes: motions', () => {
    const wholeCollectiveForbidden = new Proxy(db, { get(t, k) { if (k === 'getCollectiveMotions') return () => { throw new Error('the whole collective must not be loaded'); }; return t[k]; } });
    test('M1: an open re-proposal with the same hash does not take over an index request', async () => {
        const original = db.getKv('council');
        db.setKv('council', { ...original, motions: [...original.motions, { hash: M1, index: 10, section: 'treasury', method: 'approveProposal', args: [], threshold: 3, ayes: [ALICE], nays: [], end: 1400 }] });
        try {
            const deps = { db: wholeCollectiveForbidden, chain: fakeChain() };
            const seven = await motionDetail('council', '7', deps, { fresh: true });
            assert.equal(seven.status, 200);
            assert.equal(seven.body.index, 7, 'motion /7 is #7, not the open #10 with the same hash');
            assert.equal(seven.body.status, 'executed');
            assert.deepEqual([seven.body.ayes, seven.body.nays], [3, 1]);
            const ten = await motionDetail('council', '10', deps, { fresh: true });
            assert.equal(ten.body.index, 10);
            assert.equal(ten.body.status, 'proposed');
            const byHash = await motionDetail('council', M1, deps, { fresh: true });
            assert.equal(byHash.body.index, 10, 'a hash still lands on the open motion');
        } finally { db.setKv('council', original); }
    });
    test('LOW: one hash\'s motions are one query, equal to that hash\'s slice of the full list', () => {
        const full = db.getCollectiveMotions('council').filter(m => m.hash === M1);
        assert.ok(full.length >= 2);
        assert.deepEqual(db.getCollectiveMotionsByHash('council', M1), full);
        assert.deepEqual(db.getCollectiveMotionsByHash('council', M1.toUpperCase().replace('0X', '0x')), full, 'hash case does not matter');
        assert.deepEqual(db.getCollectiveMotionsByHash('council', '0x' + 'ee'.repeat(32)), []);
        assert.equal(db.getCollectiveMotionHashByIndex('council', 7), M1);
        assert.equal(db.getCollectiveMotionHashByIndex('council', 4242), null);
        assert.equal(db.getCollectiveMotionHashByIndex('technicalCommittee', 7), null, 'collectives are separate');
    });
});

describe('review fixes: unknown ids cost no RPC, and stay unknown for a minute', () => {
    function countingChain() {
        const calls = [];
        const c = fakeChain();
        for (const k of ['consts', 'currentBlock', 'referendum', 'publicProp', 'nextExternal', 'deposit', 'decodeCall', 'referendumAt']) {
            const f = c[k];
            c[k] = async (...a) => { calls.push(k); return f(...a); };
        }
        return { c, calls };
    }
    test('M2: referendum - an unknown id makes one existence read and nothing else; then none for 60 s', async () => {
        const { c, calls } = countingChain();
        let t = 1000000;
        const deps = { db, chain: c, now: () => t };
        const r1 = await referendumDetail('90', deps);
        assert.equal(r1.status, 404);
        assert.deepEqual(calls, ['referendum'], 'no consts or head reads for an id that does not exist');
        calls.length = 0;
        t += 59000;
        assert.equal((await referendumDetail('90', deps)).status, 404);
        assert.deepEqual(calls, [], 'remembered: no RPC');
        t += 2000;
        assert.equal((await referendumDetail('90', deps)).status, 404);
        assert.deepEqual(calls, ['referendum'], 'after 60 s it is asked again');
    });
    test('M2: a far-future index never reaches the node; ?fresh skips the memory and finds an item created since', async () => {
        const { c, calls } = countingChain();
        const deps = { db, chain: c, now: () => 5000000 };
        assert.equal((await referendumDetail('100000', deps)).status, 404);
        assert.deepEqual(calls, []);
        assert.equal((await referendumDetail('50', deps)).status, 404);
        c.referendum = async () => ({ state: 'ongoing', end: 1300, threshold: 'SimpleMajority', delay: 10, ayes: 1, nays: 0, turnout: 1, bounded: null, proposalHash: H2 });
        assert.equal((await referendumDetail('50', deps)).status, 404, 'still remembered');
        const fresh = await referendumDetail('50', deps, { fresh: true });
        assert.equal(fresh.status, 200, 'an item created a block ago is found with ?fresh=1');
        assert.equal(fresh.body.status, 'Ongoing');
    });
    test('M2: a stored referendum is answered without an existence probe (one live read, shared)', async () => {
        const { c, calls } = countingChain();
        const r = await referendumDetail('1', { db, chain: c }, { fresh: true });
        assert.equal(r.status, 200);
        assert.equal(calls.filter(x => x === 'referendum').length, 1, 'the live read is made once, not once to check and once to use');
    });
    test('M2: proposals and external proposals likewise', async () => {
        const { c, calls } = countingChain();
        let t = 1;
        const deps = { db, chain: c, now: () => t };
        assert.equal((await proposalDetail('77', deps)).status, 404);
        assert.deepEqual(calls, ['publicProp']);
        calls.length = 0;
        assert.equal((await proposalDetail('77', deps)).status, 404);
        assert.equal((await proposalDetail('100000', deps)).status, 404);
        assert.deepEqual(calls, []);
        const unknown = '0x' + '98'.repeat(32);
        assert.equal((await externalDetail(unknown, deps)).status, 404);
        assert.deepEqual(calls, ['nextExternal']);
        calls.length = 0;
        assert.equal((await externalDetail(unknown, deps)).status, 404);
        assert.deepEqual(calls, []);
        assert.equal((await externalDetail(H2, deps)).status, 200, 'a stored thread is known without the probe');
        assert.equal(calls.filter(x => x === 'nextExternal').length, 1);
    });
    test('M2: motions - the 404 is remembered too, and is still no-store over HTTP', async () => {
        const deps = { db, chain: fakeChain(), now: () => 1 };
        assert.equal((await motionDetail('council', '4242', deps)).status, 404);
        deps.db = { getKv() { throw new Error('not read again'); } };
        assert.equal((await motionDetail('council', '4242', deps)).status, 404, 'served from memory');
        const r = await get('/api/council/motion/4242');
        assert.equal(r.status, 404);
        assert.equal(r.cache, 'no-store');
    });
});

describe('review fixes: "Enacted" needs this referendum\'s own dispatch', () => {
    const TASK = '0x' + 'ab'.repeat(32);
    const finishedChain = () => fakeChain({
        referendum: async () => ({ state: 'finished', approved: true, end: 1000 }),
        referendumAt: async () => ({ state: 'ongoing', end: 1000, threshold: 'SuperMajorityApprove', delay: 31, ayes: 31, nays: 9, turnout: 26, bounded: null, proposalHash: H2 })
    });
    const enactStep = async (taskId) => (await referendumDetail('1', { db, chain: finishedChain(), enactmentTaskId: taskId }, { fresh: true })).body.timeline.find(s => s.key === 'enact');
    test('another task dispatching in the enactment block is not enough', async () => {
        db.insertEvents([{ hash: 'ev-other-task', block: 1031, eventIndex: 3, section: 'scheduler', method: 'Dispatched', data: { task: ['1031', '0'], id: '0x' + 'cd'.repeat(32), result: { Ok: null } } }]);
        const step = await enactStep(() => TASK);
        assert.equal(step.label, 'Enactment block reached');
        assert.match(step.note, /not confirmed/);
        assert.equal((await enactStep(null)).label, 'Enactment block reached', 'no task id to match: not claimed');
    });
    test('the referendum\'s own task id, as an object or array payload, confirms it', async () => {
        db.insertEvents([{ hash: 'ev-own-task', block: 1031, eventIndex: 4, section: 'scheduler', method: 'Dispatched', data: { task: ['1031', '1'], id: TASK.toUpperCase().replace('0X', '0x'), result: { Ok: null } } }]);
        const step = await enactStep(() => TASK);
        assert.equal(step.label, 'Enacted');
        assert.equal(step.block, 1031);
    });
    test('matching rules: democracy.Executed by index, scheduler.Dispatched by id', () => {
        assert.equal(enactmentEventMatches({ section: 'democracy', method: 'Executed', data: { refIndex: '1,234', result: { Ok: null } } }, 1234, null), true);
        assert.equal(enactmentEventMatches({ section: 'democracy', method: 'Executed', data: ['5', { Ok: null }] }, 5, null), true);
        assert.equal(enactmentEventMatches({ section: 'democracy', method: 'Executed', data: ['6', { Ok: null }] }, 5, null), false);
        assert.equal(enactmentEventMatches({ section: 'scheduler', method: 'Dispatched', data: [['1', '0'], TASK, { Ok: null }] }, 5, TASK), true);
        assert.equal(enactmentEventMatches({ section: 'scheduler', method: 'Dispatched', data: [['1', '0'], null, { Ok: null }] }, 5, TASK), false);
        assert.equal(enactmentEventMatches({ section: 'scheduler', method: 'Dispatched', data: { id: TASK } }, 5, null), false);
        assert.equal(enactmentEventMatches({ section: 'balances', method: 'Transfer', data: { id: TASK } }, 5, TASK), false);
        assert.equal(enactmentEventMatches(null, 5, TASK), false);
    });
});

describe('review fixes: the page', () => {
    const liveApi = (hold) => ({ query: { democracy: {
        referendumInfoOf(i, cb) { hold.deliver = cb; return Promise.resolve(() => {}); },
        votingOf() { return Promise.resolve(() => {}); }, depositOf() { return Promise.resolve(() => {}); }
    } } });
    const info = (ayes, nays, turnout) => ({ isNone: false, isSome: true, unwrap: () => ({ isOngoing: true, asOngoing: { end: 1200, threshold: 'SimpleMajority', tally: { ayes, nays, turnout } } }) });
    test('M3: with a live subscription delivering, the 30 s poll does not overwrite the live tally', async () => {
        const hold = {};
        const w = pageWorld({ api: liveApi(hold) });
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        hold.deliver(info('900000000000000', '100000000000000', '500000000000000'));
        const summary = w.root.querySelector('[data-gd-summary]');
        assert.ok(summary.innerHTML.includes('90% aye / 10% nay'));
        w.setBody(refPayload({ tally: { ayes: 1, nays: 3, turnout: 4, known: true } }));   // a cached, older server answer
        w.intervals[0].fn();
        await flush(); await flush();
        assert.ok(summary.innerHTML.includes('90% aye / 10% nay'), 'the live tally survives the poll');
        assert.ok(!summary.innerHTML.includes('25% aye'));
        assert.deepEqual(w.page.current().tally, { ayes: 900, nays: 100, turnout: 500, known: true });
    });
    test('M3: before any live delivery the poll still refreshes the page; a status change takes the server\'s data', async () => {
        const hold = {};
        const w = pageWorld({ api: liveApi(hold) });
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        w.setBody(refPayload({ tally: { ayes: 1, nays: 3, turnout: 4, known: true } }));
        w.intervals[0].fn();
        await flush(); await flush();
        assert.ok(w.root.querySelector('[data-gd-summary]').innerHTML.includes('25% aye / 75% nay'), 'nothing live yet: the poll is the freshest');
        hold.deliver(info('900000000000000', '100000000000000', '500000000000000'));
        w.setBody(refPayload({ status: 'Passed', tally: { ayes: 30, nays: 10, turnout: 25, known: true } }));
        w.intervals[0].fn();
        await flush(); await flush();
        assert.equal(w.page.current().status, 'Passed');
        assert.deepEqual(w.page.current().tally, { ayes: 30, nays: 10, turnout: 25, known: true }, 'status changed: the server\'s final numbers');
    });
    test('M3: a live council vote also survives the poll (voters and members)', async () => {
        let deliver = null;
        const api = { query: { council: { proposals() {}, voting: Object.assign((hash, cb) => { deliver = cb; return Promise.resolve(() => {}); }, { multi() {} }) } } };
        const body = { kind: 'motion', collective: 'council', id: M1, hash: M1, index: 8, title: 'Council Motion #8', status: 'proposed', call: null, callNote: 'x',
            ayes: 0, nays: 0, threshold: 2, seats: 3, ayeVoters: [], nayVoters: [], members: [{ address: ALICE, name: 'Alice', vote: null }, { address: BOB, name: 'Bob', vote: null }],
            related: [], timeline: [], threadId: `motion-${M1}`, thread: null, sources: { chain: true } };
        const w = pageWorld({ body, api });
        w.page.open('council/motion/8');
        await flush(); await flush();
        deliver({ isNone: false, isSome: true, unwrap: () => ({ index: 8, threshold: 2, end: 1300, ayes: [ALICE], nays: [BOB] }) });
        w.intervals[0].fn();
        await flush(); await flush();
        const d = w.page.current();
        assert.deepEqual([d.ayes, d.nays], [1, 1]);
        assert.deepEqual(d.members.map(m => m.vote), ['aye', 'nay']);
        assert.equal(d.ayeVoters.length, 1);
    });
    test('LOW: the status badge is escaped', () => {
        const html = renderGovDetailSummary(refPayload({ status: '<img src=x onerror=alert(1)>' }), h);
        assert.ok(!html.includes('<img src=x'));
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    });
    test('LOW: the canonical path is the index form, for a motion opened by hash too', async () => {
        const w = pageWorld();
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        assert.equal(w.calls.seo[0].canonicalPath, '/democracy/referendum/2');
        const body = { kind: 'motion', collective: 'technicalCommittee', id: M1, hash: M1, index: 8, title: 'Technical Committee Motion #8', status: 'executed', call: null, callNote: 'x',
            ayes: 2, nays: 0, threshold: 2, seats: 3, ayeVoters: null, nayVoters: null, members: null, related: [], timeline: [], threadId: null, thread: null, sources: { chain: true } };
        const m = pageWorld({ body });
        m.page.open(`council/tc-motion/${M1}`);
        await flush(); await flush();
        assert.equal(m.calls.seo[0].canonicalPath, '/council/tc-motion/8');
        const script = stripComments(readRepo('script.js', import.meta.url));
        assert.match(script, /setSeo: \(o\) => updateSeoMeta\('governance-details', \{ canonicalPath: window\.location\.pathname, \.\.\.o \}\)/, 'the page\'s own path is only the default');
    });
});

describe('review fixes: server', () => {
    test('LOW: pruned archive reads are cached as misses for 10 minutes, hits for good', async () => {
        const src = readRepo('server.js', import.meta.url);
        const body = bodyOf(src, 'govHist');
        const clock = { now: 1000 };
        const make = new Function('govHistCache', 'GOV_HIST_MISS_MS', 'Date', `return async ${body}`);
        const cache = new Map();
        const govHist = make(cache, 10 * 60 * 1000, { now: () => clock.now });
        let reads = 0, answer = null;
        const read = async () => { reads++; return answer; };
        assert.equal(await govHist('k', read), null);
        assert.equal(await govHist('k', read), null);
        assert.equal(reads, 1, 'a pruned read is not repeated on every page view');
        clock.now += 9 * 60 * 1000;
        await govHist('k', read);
        assert.equal(reads, 1);
        clock.now += 2 * 60 * 1000;
        answer = { state: 'ongoing' };
        assert.deepEqual(await govHist('k', read), { state: 'ongoing' });
        assert.equal(reads, 2, 'after 10 minutes it is asked again');
        assert.deepEqual(await govHist('k', read), { state: 'ongoing' });
        assert.equal(reads, 2, 'a hit is kept');
    });
    test('the enactment task id is the padded democracy name, not a hash', () => {
        const server = stripComments(readRepo('server.js', import.meta.url));
        const body = bodyOf(server, 'govEnactmentTaskId');
        assert.match(body, /democracyEnactmentTaskIds\(index\)/);
        assert.doesNotMatch(body, /blake2/);
    });
});

describe('democracy enactment task id (pallet-democracy encode_into, not a hash)', () => {
    const pad = '0'.repeat(40);
    test('index 0, 5 and 300 (multi-byte little-endian): padded form then unpadded form', () => {
        assert.deepEqual(democracyEnactmentTaskIds(0), ['0x64656d6f63726163' + '00000000' + pad, '0x64656d6f6372616300000000']);
        assert.deepEqual(democracyEnactmentTaskIds(5), ['0x64656d6f6372616305000000' + pad, '0x64656d6f6372616305000000']);
        // 300 = 0x012c, little-endian u32 = 2c 01 00 00
        assert.deepEqual(democracyEnactmentTaskIds(300), ['0x64656d6f637261632c010000' + pad, '0x64656d6f637261632c010000']);
        assert.deepEqual(democracyEnactmentTaskIds('5'), democracyEnactmentTaskIds(5));
        assert.equal(democracyEnactmentTaskIds(5)[0].length, 2 + 64, 'padded id is 32 bytes');
        assert.equal(democracyEnactmentTaskIds(5)[1].length, 2 + 24, 'unpadded id is 12 bytes');
    });
    test('an index that is not a u32 gives no id', () => {
        for (const bad of [-1, 1.5, NaN, 'x', 2 ** 32, undefined, null]) assert.deepEqual(democracyEnactmentTaskIds(bad), []);
        assert.equal(democracyEnactmentTaskIds(2 ** 32 - 1)[1], '0x64656d6f63726163ffffffff');
    });
    const dispatched = (id) => ({ section: 'scheduler', method: 'Dispatched', data: [['1', '0'], id, { Ok: null }] });
    test('scheduler.Dispatched matches the padded and the unpadded id, case-insensitively', () => {
        for (const index of [0, 5, 300]) {
            const [padded, unpadded] = democracyEnactmentTaskIds(index);
            const ids = democracyEnactmentTaskIds(index);
            assert.equal(enactmentEventMatches(dispatched(padded), index, ids), true, `padded ${index}`);
            assert.equal(enactmentEventMatches(dispatched(unpadded), index, ids), true, `unpadded ${index}`);
            assert.equal(enactmentEventMatches(dispatched('0x' + padded.slice(2).toUpperCase()), index, ids), true, `upper ${index}`);
            assert.equal(enactmentEventMatches({ section: 'scheduler', method: 'Dispatched', data: { id: unpadded.toUpperCase().replace('0X', '0x') } }, index, ids), true, `object ${index}`);
        }
    });
    test('another referendum\'s id never matches; the old blake2 formula never matches', () => {
        const ids5 = democracyEnactmentTaskIds(5);
        assert.equal(enactmentEventMatches(dispatched(democracyEnactmentTaskIds(6)[0]), 5, ids5), false);
        assert.equal(enactmentEventMatches(dispatched(democracyEnactmentTaskIds(6)[1]), 5, ids5), false);
        assert.equal(enactmentEventMatches(dispatched(democracyEnactmentTaskIds(300)[0]), 5, ids5), false);
        assert.equal(enactmentEventMatches(dispatched(blake2AsHex(new Uint8Array([100, 101, 109, 111, 99, 114, 97, 99, 5, 0, 0, 0]), 256)), 5, ids5), false);
    });
    test('a null id never matches, and an empty id list matches nothing', () => {
        const ids5 = democracyEnactmentTaskIds(5);
        assert.equal(enactmentEventMatches(dispatched(null), 5, ids5), false);
        assert.equal(enactmentEventMatches({ section: 'scheduler', method: 'Dispatched', data: { id: null } }, 5, ids5), false);
        assert.equal(enactmentEventMatches({ section: 'scheduler', method: 'Dispatched', data: [['1', '0']] }, 5, ids5), false);
        assert.equal(enactmentEventMatches(dispatched(ids5[0]), 5, []), false);
        assert.equal(enactmentEventMatches(dispatched(null), 5, [null]), false);
    });
});
