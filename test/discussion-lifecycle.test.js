// Democracy lifecycle threads (2026-10-26, "democracy proposals are not
// showing up in the discussion board"): threads for the queued external
// proposal and for every ongoing referendum, and the read-only links that
// connect a council motion -> external proposal -> referendum, and a public
// proposal -> referendum, by the democracy proposal hash they share.
//
// Real SQLite (db.js), the real reconcile (lib/discussion-threads.js), the real
// link derivation and HTML (lib/discussion-lifecycle.js), and real
// @polkadot/types codecs for the bounded-call shapes.
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TypeRegistry } from '@polkadot/types';
import { blake2AsHex } from '@polkadot/util-crypto';
import * as db from '../db.js';
import {
    reconcileThreads, reconcileReferendumThreads, referendumReadTrusted, externalReadTrusted,
    externalLaunchedReason, isAutoCloseReason, findCallByHash, recoverMotionProposalHash, AUTO_CLOSE_REASON, REFERENDUM_CLOSE_REASON
} from '../lib/discussion-threads.js';
import {
    proposalHashOf, boundedParts, isExternalProposeCall, externalThreadId, referendumThreadId, externalTitle,
    referendumTitle, thresholdLabel, lifecycleLinks, renderLifecycleLinks, discussLinkHtml, referendumDiscussCell,
    externalSummaryHtml, kindLabel, kindFilterOptions, isThreadKind, shortHash
} from '../lib/discussion-lifecycle.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-disc-life-')); dirs.push(d); return d; }
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

const H1 = '0x' + '11'.repeat(32);   // the call the council queued (motion #140's shape)
const H2 = '0x' + '22'.repeat(32);   // a public proposal's call
const MOTION = '0x' + 'aa'.repeat(32);
const ext = (h, extra = {}) => ({ id: externalThreadId(h), refKey: h, proposalHash: h, title: externalTitle({ hash: h, threshold: 'SimpleMajority' }), ...extra });
const ref = (i, state, extra = {}) => ({ id: referendumThreadId(i), refKey: String(i), state, title: referendumTitle({ index: i }), ...extra });

let DIR;
before(() => { DIR = tmp(); db.initDb(DIR, true); });

describe('bounded call shapes (real codecs)', () => {
    const registry = new TypeRegistry();
    registry.register({ BoundedCall: { _enum: { Legacy: { hash: 'H256' }, Inline: 'Bytes', Lookup: { hash: 'H256', len: 'u32' } } } });
    test('Lookup and Legacy give their hash; Inline gives blake2_256 of the bytes', () => {
        const lookup = registry.createType('BoundedCall', { Lookup: { hash: H1, len: 77 } });
        const legacy = registry.createType('BoundedCall', { Legacy: { hash: H2 } });
        const inline = registry.createType('BoundedCall', { Inline: '0x00010203' });
        assert.equal(proposalHashOf(lookup, blake2AsHex), H1);
        assert.deepEqual(boundedParts(lookup), { kind: 'lookup', hash: H1, len: 77 });
        assert.equal(proposalHashOf(legacy, blake2AsHex), H2);
        assert.equal(proposalHashOf(inline, blake2AsHex), blake2AsHex('0x00010203'));
        assert.equal(proposalHashOf(inline), null, 'no hasher, no guess');
    });
    test('the toString() JSON a motion arg carries, a bare H256, and junk', () => {
        assert.equal(proposalHashOf(JSON.stringify({ lookup: { hash: H1, len: 5 } })), H1);
        assert.equal(proposalHashOf(registry.createType('H256', H2)), H2);
        assert.equal(proposalHashOf(H1.toUpperCase().replace('0X', '0x')), H1, 'normalised to lower case');
        for (const junk of [null, undefined, '', '0x12', '{"lookup":{"hash":"0x12"}}', '{"other":1}', 42]) assert.equal(proposalHashOf(junk, blake2AsHex), null);
    });
    test('only democracy.externalPropose* motions carry a proposal hash', () => {
        for (const m of ['externalPropose', 'externalProposeMajority', 'externalProposeDefault']) assert.ok(isExternalProposeCall('democracy', m));
        for (const [s, m] of [['democracy', 'propose'], ['democracy', 'externalProposeX'], ['treasury', 'externalPropose'], ['', '']]) assert.ok(!isExternalProposeCall(s, m));
    });
    test('titles and thresholds', () => {
        assert.equal(externalTitle({ hash: H1, call: 'treasury.spend', threshold: 'SimpleMajority' }), 'External proposal: treasury.spend (simple majority)');
        assert.equal(externalTitle({ hash: H1, threshold: 'SuperMajorityAgainst' }), `External proposal ${shortHash(H1)} (super-majority against)`);
        assert.equal(externalTitle({ hash: H1 }), `External proposal ${shortHash(H1)}`);
        assert.equal(referendumTitle({ index: 4, call: 'system.remark' }), 'Referendum #4: system.remark');
        assert.equal(referendumTitle({ index: 4 }), 'Referendum #4');
        assert.equal(thresholdLabel('SuperMajorityApprove'), 'super-majority approve');
        assert.equal(thresholdLabel(null), '');
    });
});

describe('external proposal threads', () => {
    test('created on any read, keyed by proposal hash, carrying the hash', () => {
        const r = reconcileThreads(db, 'external', [ext(H1)], { trusted: false });
        assert.deepEqual(r.created, [`external-${H1}`]);
        const t = db.getThread(`external-${H1}`);
        assert.equal(t.kind, 'external');
        assert.equal(t.status, 'open');
        assert.equal(t.proposalHash, H1);
        assert.match(t.title, /^External proposal 0x111111…1111 \(simple majority\)$/);
    });
    test('idempotent across repeated calls and across two workers on one database', async () => {
        reconcileThreads(db, 'external', [ext(H1)], { trusted: true });
        reconcileThreads(db, 'external', [ext(H1)], { trusted: true });
        const other = await import('../db.js?second-worker');
        other.initDb(DIR, false, { awaitMigrator: false });
        const r2 = reconcileThreads(other, 'external', [ext(H1)], { trusted: true });
        assert.deepEqual(r2.created, []);
        assert.equal(db.getThreads('external').length, 1);
    });
    test('a decoded title replaces the short-hash placeholder; an undecoded one does not', () => {
        reconcileThreads(db, 'external', [ext(H1, { title: 'External proposal: treasury.spend (simple majority)', titleDecoded: true })], { trusted: false });
        assert.equal(db.getThread(`external-${H1}`).title, 'External proposal: treasury.spend (simple majority)');
        reconcileThreads(db, 'external', [ext(H1)], { trusted: true });
        assert.equal(db.getThread(`external-${H1}`).title, 'External proposal: treasury.spend (simple majority)');
    });
    test('an untrusted read with no external closes nothing', () => {
        const r = reconcileThreads(db, 'external', [], { trusted: false });
        assert.deepEqual(r.closed, []);
        assert.equal(db.getThread(`external-${H1}`).status, 'open');
        assert.equal(externalReadTrusted({ currentBlock: 999, highWater: 1000 }).trusted, false);
        assert.equal(externalReadTrusted({ currentBlock: 1000, highWater: 1000 }).trusted, true);
    });
    test('a trusted read closes it, worded by where it went, and self-heals a wrong close', () => {
        const id = `external-${H1}`;
        reconcileThreads(db, 'external', [], { trusted: true, closeReason: (x) => (x === id ? externalLaunchedReason(12) : null) });
        assert.equal(db.getThread(id).status, 'closed');
        assert.equal(db.getThread(id).closedReason, 'External proposal launched as referendum #12.');
        assert.ok(isAutoCloseReason('external', externalLaunchedReason(12)));
        assert.ok(isAutoCloseReason('external', AUTO_CLOSE_REASON.external));
        assert.ok(!isAutoCloseReason('external', 'Closed by a moderator.'));
        const r = reconcileThreads(db, 'external', [ext(H1)], { trusted: true });
        assert.deepEqual(r.reopened, [id], 'listed again on a trusted read: our own close is undone');
        reconcileThreads(db, 'external', [], { trusted: true });
        assert.equal(db.getThread(id).closedReason, AUTO_CLOSE_REASON.external, 'no closeReason given: the default wording');
    });
});

describe('referendum threads', () => {
    test('one per ongoing referendum; finished ones never get a new thread', () => {
        const r = reconcileReferendumThreads(db, [ref(3, 'ongoing', { proposalHash: H1 }), ref(1, 'passed'), ref(2, 'cancelled')], { trusted: true });
        assert.deepEqual(r.created, ['referendum-3']);
        assert.equal(db.getThread('referendum-1'), null);
        assert.equal(db.getThread('referendum-3').proposalHash, H1);
        assert.equal(db.getThread('referendum-3').kind, 'referendum');
    });
    test('a finished read closes only when trusted', () => {
        reconcileReferendumThreads(db, [ref(3, 'failed')], { trusted: false });
        assert.equal(db.getThread('referendum-3').status, 'open');
        const r = reconcileReferendumThreads(db, [ref(3, 'failed')], { trusted: true });
        assert.deepEqual(r.closed, ['referendum-3']);
        assert.equal(db.getThread('referendum-3').closedReason, REFERENDUM_CLOSE_REASON.failed);
        assert.equal(db.getThread('referendum-3').closedReason, 'Referendum failed.');
    });
    test('passed and cancelled reasons; an index the read could not see is left alone', () => {
        reconcileReferendumThreads(db, [ref(5, 'ongoing'), ref(6, 'ongoing'), ref(7, 'ongoing')], { trusted: true });
        reconcileReferendumThreads(db, [ref(5, 'passed'), ref(6, 'cancelled')], { trusted: true });
        assert.equal(db.getThread('referendum-5').closedReason, 'Referendum passed.');
        assert.equal(db.getThread('referendum-6').closedReason, 'Referendum cancelled.');
        assert.equal(db.getThread('referendum-7').status, 'open', 'absent from the read (RPC error): no change');
    });
    test('idempotent, and a wrongly closed thread reopens on a trusted ongoing read', () => {
        const again = reconcileReferendumThreads(db, [ref(5, 'passed')], { trusted: true });
        assert.deepEqual(again.closed, [], 'already closed: nothing to do');
        db.closeThread('referendum-7', REFERENDUM_CLOSE_REASON.passed);
        assert.deepEqual(reconcileReferendumThreads(db, [ref(7, 'ongoing')], { trusted: false }).reopened, []);
        assert.deepEqual(reconcileReferendumThreads(db, [ref(7, 'ongoing')], { trusted: true }).reopened, ['referendum-7']);
        db.closeThread('referendum-7', 'Closed by a moderator.');
        reconcileReferendumThreads(db, [ref(7, 'ongoing')], { trusted: true });
        assert.equal(db.getThread('referendum-7').status, 'closed', 'a close we did not make is not undone');
    });
    test('trust: a node whose referendumCount does not cover our threads is behind', () => {
        assert.equal(referendumReadTrusted({ referendumCount: 7, currentBlock: 2000, highWater: 1000, knownRefKeys: ['3', '7'] }).trusted, false);
        assert.equal(referendumReadTrusted({ referendumCount: 8, currentBlock: 2000, highWater: 1000, knownRefKeys: ['3', '7'] }).trusted, true);
        assert.equal(referendumReadTrusted({ referendumCount: 8, currentBlock: 999, highWater: 1000, knownRefKeys: [] }).trusted, false);
    });
    test('posts survive every close', () => {
        db.createPost({ threadId: 'referendum-5', author: 'eAuthorA', content: 'kept' });
        reconcileReferendumThreads(db, [ref(5, 'failed')], { trusted: true });
        assert.deepEqual(db.getPosts('referendum-5').map(p => p.content), ['kept']);
    });
});

describe('lifecycle links by proposal hash', () => {
    test('the live case: motion #140 -> external -> referendum', () => {
        // The motion concluded and its thread closed before this feature: no hash.
        db.createThreadIfMissing({ id: `motion-${MOTION}`, kind: 'motion', refKey: MOTION, title: 'democracy.externalProposeMajority' });
        db.closeThread(`motion-${MOTION}`, AUTO_CLOSE_REASON.motion);
        db.upsertCollectiveMotion('council', { hash: MOTION, motionIndex: 140, section: 'democracy', method: 'externalProposeMajority', proposedBlock: 13300000 });
        db.insertCollectiveMotionEvent('council', { hash: MOTION, block: 13321483, eventIndex: 4, kind: 'executed' });
        const missing = db.getMotionThreadsMissingProposalHash();
        assert.deepEqual(missing.map(m => [m.id, m.hash, m.collective, m.proposedBlock, m.resolvedBlock]),
            [[`motion-${MOTION}`, MOTION, 'council', 13300000, 13321483]]);
        // What the backfill does once it has recovered the call.
        assert.equal(db.setThreadProposalHash(`motion-${MOTION}`, H1), true);
        assert.equal(db.setThreadProposalHash(`motion-${MOTION}`, H2), false, 'set once');
        assert.deepEqual(db.getMotionThreadsMissingProposalHash(), []);

        const motion = db.getThread(`motion-${MOTION}`);
        const external = db.getThread(`external-${H1}`);
        const related = db.getThreadsByProposalHash(H1);
        assert.deepEqual(lifecycleLinks(motion, related).later.map(t => t.id), [`external-${H1}`, 'referendum-3']);
        assert.deepEqual(lifecycleLinks(motion, related).earlier, []);
        assert.deepEqual(lifecycleLinks(external, related).earlier.map(t => t.id), [`motion-${MOTION}`]);
        assert.deepEqual(lifecycleLinks(external, related).later.map(t => t.id), ['referendum-3']);
        const r3 = lifecycleLinks(db.getThread('referendum-3'), related);
        assert.deepEqual(r3.earlier.map(t => t.id).sort(), [`external-${H1}`, `motion-${MOTION}`].sort(), 'transitively back to the motion');
        assert.deepEqual(r3.later, []);
    });
    test('public proposal -> referendum', () => {
        reconcileThreads(db, 'proposal', [{ id: 'proposal-9', refKey: '9', title: 'Public Proposal #9', proposalHash: H2 }], { trusted: true });
        reconcileThreads(db, 'proposal', [], { trusted: true });
        assert.equal(db.getThread('proposal-9').closedReason, AUTO_CLOSE_REASON.proposal);
        reconcileReferendumThreads(db, [ref(8, 'ongoing', { proposalHash: H2 })], { trusted: true });
        const related = db.getThreadsByProposalHash(H2);
        assert.deepEqual(lifecycleLinks(db.getThread('proposal-9'), related).later.map(t => t.id), ['referendum-8']);
        assert.deepEqual(lifecycleLinks(db.getThread('referendum-8'), related).earlier.map(t => t.id), ['proposal-9']);
    });
    test('no links without a hash, none to itself, none between unrelated stages', () => {
        assert.deepEqual(lifecycleLinks({ id: 'motion-x', kind: 'motion', proposalHash: null }, db.getThreads()), { earlier: [], later: [] });
        const self = db.getThread('proposal-9');
        assert.deepEqual(lifecycleLinks(self, [self]), { earlier: [], later: [] });
        const fakeExternal = { id: `external-${H2}`, kind: 'external', proposalHash: H2, createdAt: 1 };
        assert.deepEqual(lifecycleLinks(self, [fakeExternal]).later, [], 'a public proposal does not become an external proposal');
        const twin = { id: 'referendum-99', kind: 'referendum', proposalHash: H2, createdAt: 1 };
        assert.deepEqual(lifecycleLinks(db.getThread('referendum-8'), [twin]), { earlier: [], later: [] }, 'same stage: no link');
    });
});

describe('recovering a concluded motion\'s call from its block', () => {
    const call = (section, method, args, hash) => ({ section, method, args, hash: { toHex: () => hash } });
    test('found inside council.propose inside utility.batchAll', () => {
        const inner = call('democracy', 'externalProposeMajority', [JSON.stringify({ lookup: { hash: H1, len: 40 } })], MOTION);
        const propose = call('council', 'propose', [3, inner, 120], '0x' + '33'.repeat(32));
        const batch = call('utility', 'batchAll', [[call('system', 'remark', ['0x00'], '0x' + '44'.repeat(32)), propose]], '0x' + '55'.repeat(32));
        const found = findCallByHash([call('timestamp', 'set', [1], '0x' + '66'.repeat(32)), batch], MOTION);
        assert.equal(found, inner);
        assert.equal(proposalHashOf(found.args[0], blake2AsHex), H1);
    });
    test('absent, malformed or too deep: null', () => {
        assert.equal(findCallByHash([], MOTION), null);
        assert.equal(findCallByHash([call('a', 'b', [], H2)], 'not-a-hash'), null);
        let deep = call('democracy', 'externalPropose', [H1], MOTION);
        for (let i = 0; i < 10; i++) deep = call('proxy', 'proxy', ['e', null, deep], '0x' + String(i).padStart(2, '0').repeat(32));
        assert.equal(findCallByHash([deep], MOTION), null);
    });
});

describe('rendering', () => {
    test('the link block escapes titles and encodes ids', () => {
        const html = renderLifecycleLinks({
            earlier: [{ id: 'motion-<x>', kind: 'motion', title: '<img src=x onerror=alert(1)>', status: 'closed' }],
            later: [{ id: `external-${H1}`, kind: 'external', title: 'External "proposal" & co', status: 'open' }]
        }, escapeHtml);
        assert.ok(html.includes('Earlier discussion') && html.includes('Continued in'));
        assert.ok(!html.includes('<img'), 'title escaped');
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.ok(html.includes('href="/discussions/motion-%3Cx%3E"'));
        assert.ok(html.includes('External &quot;proposal&quot; &amp; co'));
        assert.ok(html.includes('Council Motion, closed'));
        assert.equal(renderLifecycleLinks({ earlier: [], later: [] }, escapeHtml), '');
        assert.equal(renderLifecycleLinks(undefined, escapeHtml), '');
    });
    test('Democracy page Discuss links', () => {
        // Since the item pages (2026-10-26) Discuss opens the referendum's page at its embedded board.
        assert.ok(referendumDiscussCell({ refIndex: 4, status: 'Ongoing' }).includes('href="/democracy/referendum/4#discussion"'));
        assert.ok(referendumDiscussCell({ refIndex: 2, status: 'Passed', threadId: 'referendum-2' }).includes('href="/democracy/referendum/2#discussion"'));
        assert.ok(!referendumDiscussCell({ refIndex: 1, status: 'NotPassed' }).includes('href'), 'finished before threads existed: no dead link');
        assert.equal(referendumDiscussCell({ refIndex: 'x' }), '');
        const e = externalSummaryHtml({ threshold: '<b>SimpleMajority</b>', proposalHash: H1 }, escapeHtml);
        assert.ok(e.includes('>Queued (&lt;b&gt;SimpleMajority&lt;/b&gt;)</a>'));
        assert.ok(e.includes(`href="/democracy/external/${H1}"`), 'the external proposal links to its page');
        assert.ok(e.includes(`href="/democracy/external/${H1}#discussion"`) && e.includes('>Discuss</a>'));
        assert.ok(!externalSummaryHtml({ threshold: 'SimpleMajority', proposal: '{"lookup":{"hash":"0x' }, escapeHtml).includes('href'), 'no hash (an older snapshot): no link');
        assert.equal(externalSummaryHtml(null, escapeHtml), 'None');
        assert.equal(discussLinkHtml(''), '');
        assert.ok(discussLinkHtml('proposal-3').includes('href="/discussions/proposal-3"'), 'default: the thread page');
    });
    test('thread kinds: labels, filter options, API filter', () => {
        assert.deepEqual(kindFilterOptions().map(o => o.value), ['proposal', 'motion', 'external', 'referendum']);
        assert.equal(kindLabel('external'), 'External Proposal');
        assert.equal(kindLabel('referendum'), 'Referendum');
        assert.equal(kindLabel('weird'), 'Discussion');
        assert.ok(isThreadKind('referendum') && !isThreadKind('x') && !isThreadKind(undefined));
    });
});

describe('wiring in server.js and script.js', () => {
    const server = stripComments(readRepo('server.js', import.meta.url));
    const script = stripComments(readRepo('script.js', import.meta.url));
    test('the democracy pass reconciles referenda and the external proposal under trust checks', () => {
        const pass = bodyOf(server, 'syncDemocracyPass');
        assert.match(pass, /reconcileGovThreads\('referendum', refReads, refTrust, currentBlock\)/);
        assert.match(pass, /reconcileGovThreads\('external', extItems, extTrust, currentBlock, \{ closeReason: launchedAs \}\)/);
        assert.match(pass, /referendumReadTrusted\(\{ referendumCount, currentBlock, highWater: demHighWater/);
        assert.match(pass, /!openRefThreads\.has\(i\)/, 'an open referendum thread is read again until it closes');
        assert.match(pass, /dem\.nextExternal && \(!externalProposal \|\| externalProposal\.proposalHash\)/, 'no external reconcile without a readable hash');
        assert.match(pass, /backfillMotionProposalHashes\(\)/);
        assert.match(pass, /proposalHash: propHashes\[/);
    });
    test('live motions carry their proposal hash; the API filters all four kinds and returns links', () => {
        assert.match(bodyOf(server, 'readLiveCollectiveMotions'), /isExternalProposeCall\(section, method\)\) proposalHash = proposalHashOf\(call\.args\[0\], blake2AsHex\)/);
        assert.match(server, /const kind = isThreadKind\(req\.query\.kind\) \? req\.query\.kind : null;/);
        assert.match(server, /res\.json\(\{ thread: withLifecycleLinks\(thread\), posts: db\.getPosts\(thread\.id\) \}\)/);
        assert.match(server, /referenda: withReferendumThreads\(db\.getDemocracyReferenda\(\)\)/);
    });
    test('the SPA renders the links, the Discuss links and the kind labels from the lib', () => {
        assert.match(bodyOf(script, 'renderThread'), /renderLifecycleLinks\(thread\.links, stakingEscapeHtml\)/);
        assert.match(bodyOf(script, 'renderThread'), /onUpdated: d => renderThread\(\{ links: thread\.links, \.\.\.d\.thread \}/, 'an edit keeps the link block');
        assert.match(bodyOf(script, 'renderDemocracyOverview'), /externalSummaryHtml\(ext, stakingEscapeHtml\)/);
        assert.match(bodyOf(script, 'mountDemocracyReferendaTable'), /referendumDiscussCell\(row\)/);
        assert.match(script, /filter: \{ type: 'select', options: kindFilterOptions\(\) \}/);
    });
});

// Review of cd5842b (2026-10-26): the backfill counted a try even when the RPC
// was down, the external reconcile ignored an untrusted referendum read, and
// motions whose call was never decoded were never backfilled.
describe('review fixes: motion hash backfill, external trust, undecoded motions', () => {
    const call = (section, method, args, hash) => ({ section, method, args, hash: { toHex: () => hash } });
    const external = call('democracy', 'externalProposeMajority', [JSON.stringify({ lookup: { hash: H1, len: 40 } })], MOTION);
    const hashOf = (c) => proposalHashOf(c.args[0], blake2AsHex);
    const row = (extra = {}) => ({ id: `motion-${MOTION}`, hash: MOTION, collective: 'council', proposedBlock: 100, resolvedBlock: 200, ...extra });
    const io = (o = {}) => ({ stateAt: async () => null, blockCalls: async () => [], hashOf, ...o });

    test('RPC down while reading the block body: unavailable, not a try', async () => {
        const r = await recoverMotionProposalHash(row(), io({ blockCalls: async () => { throw new Error('rpc not ready (disconnected mid-fetch)'); } }));
        assert.deepEqual(r, { outcome: 'unavailable' });
    });
    test('a state read that throws (not swallowed) is unavailable too; a non-array body is unavailable', async () => {
        assert.deepEqual(await recoverMotionProposalHash(row(), io({ stateAt: async () => { throw new Error('boom'); } })), { outcome: 'unavailable' });
        assert.deepEqual(await recoverMotionProposalHash(row(), io({ blockCalls: async () => null })), { outcome: 'unavailable' });
    });
    test('the body WAS read and the call is not in it: a miss (one try)', async () => {
        const r = await recoverMotionProposalHash(row(), io({ blockCalls: async () => [call('timestamp', 'set', [1], '0x' + '66'.repeat(32))] }));
        assert.deepEqual(r, { outcome: 'miss' });
    });
    test('found in state, in the body, or in the state before the resolving block', async () => {
        assert.deepEqual(await recoverMotionProposalHash(row(), io({ stateAt: async (b) => (b === 100 ? external : null) })), { outcome: 'found', hash: H1 });
        const propose = call('council', 'propose', [3, external, 120], '0x' + '33'.repeat(32));
        assert.deepEqual(await recoverMotionProposalHash(row(), io({ blockCalls: async () => [propose] })), { outcome: 'found', hash: H1 });
        const seen = [];
        const r = await recoverMotionProposalHash(row(), io({ stateAt: async (b) => { seen.push(b); return b === 199 ? external : null; } }));
        assert.deepEqual(r, { outcome: 'found', hash: H1 });
        assert.deepEqual(seen, [100, 199]);
    });
    test('a decoded call that is not an external proposal is a miss; no proposing block is a miss', async () => {
        const other = call('treasury', 'approveProposal', [5], MOTION);
        assert.deepEqual(await recoverMotionProposalHash(row(), io({ stateAt: async () => other })), { outcome: 'miss' });
        assert.deepEqual(await recoverMotionProposalHash(row({ proposedBlock: null, resolvedBlock: null }), io()), { outcome: 'miss' });
    });
    test('server.js counts only a miss, stops the pass on unavailable, and skips the pass while the RPC is down', () => {
        const server = stripComments(readRepo('server.js', import.meta.url));
        const fn = bodyOf(server, 'backfillMotionProposalHashes');
        assert.match(fn, /if \(!isRpcReady\(\)\) return;/);
        assert.match(fn, /if \(r\.outcome === 'unavailable'\) break;/);
        assert.match(fn, /else if \(r\.outcome === 'miss'\) \{\s*attempts\[row\.id\] = \(attempts\[row\.id\] \|\| 0\) \+ 1;/);
        assert.equal((fn.match(/attempts\[row\.id\] = /g) || []).length, 1, 'exactly one place increments the tries');
        assert.match(fn, /if \(!block \|\| !block\.block\) throw new Error/, 'a missing block is unavailable, not an empty body');
    });
    test('the external reconcile is not trusted when the referendum read is not', () => {
        const pass = bodyOf(stripComments(readRepo('server.js', import.meta.url)), 'syncDemocracyPass');
        assert.match(pass, /const extTrust = refTrust\.trusted \? externalReadTrusted\(\{ currentBlock, highWater: demHighWater \}\) : refTrust;/);
    });
    test('motions whose call was never decoded (section NULL) are backfilled; other calls are not', () => {
        const U = '0x' + 'ab'.repeat(32), T = '0x' + 'cd'.repeat(32);
        db.createThreadIfMissing({ id: `motion-${U}`, kind: 'motion', refKey: U, title: 'Council Motion' });
        db.upsertCollectiveMotion('council', { hash: U, motionIndex: 150, proposedBlock: 13400000 });
        db.createThreadIfMissing({ id: `motion-${T}`, kind: 'motion', refKey: T, title: 'treasury.approveProposal' });
        db.upsertCollectiveMotion('council', { hash: T, motionIndex: 151, section: 'treasury', method: 'approveProposal', proposedBlock: 13400001 });
        const ids = db.getMotionThreadsMissingProposalHash().map(m => m.id);
        assert.ok(ids.includes(`motion-${U}`), 'undecoded motion is a candidate');
        assert.ok(!ids.includes(`motion-${T}`), 'a decoded non-external call is not');
    });
});
