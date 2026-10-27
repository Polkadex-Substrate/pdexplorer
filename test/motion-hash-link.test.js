// Production, 2026-10-27: the council motion that queued the runtime upgrade
// (motion #140, democracy.externalProposeMajority) concluded before the
// lifecycle threads shipped, the external proposal was fast-tracked straight
// to a referendum by the Technical Committee (so no external-* thread ever
// existed), and the motion thread's proposal_hash stayed empty. The referendum
// page therefore showed earlierPostCount 0 although the motion thread had two
// posts.
//
// The only writer for a concluded motion was the historical backfill, which
// needs the motion's proposing block (or its resolving block) AND a node that
// still serves state and bodies at that height. Behind the public load
// balancer neither is guaranteed, and the backfill turned "could not read"
// into a counted try (state errors were swallowed to null, and a row with no
// block known was a miss), so three ticks retired the thread for good; one
// unreadable row also stopped the pass for every row behind it.
//
// The fix links the motion from data the explorer HAS on every tick: the
// motion's call is democracy.externalPropose*(B), where B is the same bounded
// call the external proposal and the referendum carry, so its hash is
// recomputed from B and the current runtime's call encoding, with no history.
//
// Real SQLite (db.js), the real lib code, and real @polkadot/types codecs from
// runtime metadata (Substrate's, always; Polkadex 373/392 when the fixtures
// exist) so the recomputed hash is the one the collective pallet stores.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { blake2AsHex } from '@polkadot/util-crypto';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import * as db from '../db.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import {
    reconcileThreads, reconcileReferendumThreads, recoverMotionProposalHash, linkMotionThreadsByCallHash,
    externalProposeCallHashes, EXTERNAL_PROPOSE_METHODS, AUTO_CLOSE_REASON
} from '../lib/discussion-threads.js';
import { proposalHashOf, lifecycleLinks, earlierPostCount, referendumThreadId } from '../lib/discussion-lifecycle.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { sqliteThreadStore, motionThreadDiagnostics, linkMotionThreads, clearAttempts } from '../tools/link-motion-threads.mjs';

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-motion-link-')); dirs.push(d); return d; }
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

// The upgrade preimage the referendum and the motion share (placeholder bytes).
const PREIMAGE = '0x' + 'c7'.repeat(32);
const LEN = 1_048_576;

const sources = [{ label: 'substrate (types-support)', hex: substrateMetadata }];
for (const f of ['metadata-373.json', 'metadata-392.json']) {
    const fx = loadFixture(f);
    if (fx) sources.push({ label: `Polkadex spec ${fx.specVersion} (${f})`, hex: fx.metadata });
}

function chainFor(hex) {
    const registry = registryFromMetadata(hex);
    const tx = decorateExtrinsics(registry, registry.metadata, registry.metadata.version);
    const makeCall = (method, bounded) => tx.democracy[method](bounded);
    const pallet = registry.metadata.pallets.find(p => p.name.toString() === 'Democracy');
    const item = pallet.storage.unwrap().items.find(i => i.name.toString() === 'ReferendumInfoOf');
    const RI = (v) => registry.createType(`Option<${registry.createLookupType(item.type.asMap.value)}>`, v);
    return { registry, tx, makeCall, RI };
}

let DIR;
before(() => { DIR = tmp(); db.initDb(DIR, true); });

sources.forEach((src, n) => {
    describe(`motion -> referendum (TC fast-track, no external thread): ${src.label}`, () => {
        const { tx, makeCall, RI } = chainFor(src.hex);
        // One preimage and referendum per metadata source: they share a database.
        const PREIMAGE = '0x' + (0xc7 + n).toString(16).repeat(32);
        const REF = 36 + n;
        // Referendum #36 as the chain holds it: Ongoing, the upgrade as a Lookup.
        const info = RI({ Ongoing: { end: 13_400_000, proposal: { Lookup: { hash: PREIMAGE, len: LEN } },
            threshold: 'SimpleMajority', delay: 100, tally: { ayes: 0, nays: 0, turnout: 0 } } }).unwrap().asOngoing;
        const bounded = info.proposal;
        // Motion #140 as the council stored it: externalProposeMajority(the same bounded call).
        const motionCall = tx.democracy.externalProposeMajority({ Lookup: { hash: PREIMAGE, len: LEN } });
        const MOTION = motionCall.hash.toHex();
        const proposalHash = proposalHashOf(bounded, blake2AsHex);
        const threadId = `motion-${MOTION}`;
        const refId = referendumThreadId(REF);

        test('the recomputed hashes include the motion hash the pallet stored', () => {
            assert.equal(proposalHash, PREIMAGE);
            const hashes = externalProposeCallHashes(bounded, makeCall);
            assert.ok(hashes.includes(MOTION), 'externalProposeMajority(bounded) hashes to the stored motion hash');
            assert.equal(hashes.length, new Set(hashes).size, 'no duplicates');
            assert.deepEqual(EXTERNAL_PROPOSE_METHODS, ['externalPropose', 'externalProposeMajority', 'externalProposeDefault']);
        });

        test('production shape: closed motion, no hash, no external thread; the democracy tick links it', () => {
            // The motion thread from when #140 was open: two posts, closed when
            // the motion executed (before the lifecycle feature was deployed).
            reconcileThreads(db, 'motion', [{ id: threadId, refKey: MOTION, title: 'democracy.externalProposeMajority' }], { trusted: true });
            db.createPost({ threadId, author: 'e' + 'a'.repeat(47), content: 'first' });
            db.createPost({ threadId, author: 'e' + 'b'.repeat(47), content: 'second' });
            reconcileThreads(db, 'motion', [], { trusted: true });
            assert.equal(db.getThread(threadId).status, 'closed');
            assert.equal(db.getThread(threadId).proposalHash, null);
            // The referendum read: thread created with its proposal hash.
            reconcileReferendumThreads(db, [{ id: refId, refKey: String(REF), state: 'ongoing', title: `Referendum #${REF}`, proposalHash }], { trusted: true });
            assert.equal(db.getThread(`external-${proposalHash}`), null, 'fast-tracked: no external thread');
            // Before the link: the referendum sees no earlier stage.
            const before = lifecycleLinks(db.getThread(refId), db.getThreadsByProposalHash(proposalHash));
            assert.equal(earlierPostCount(before), 0);

            // What the democracy pass now does with the referendum it just read.
            const r = linkMotionThreadsByCallHash(db, [{ proposalHash, bounded, source: 'referendum #36' }], makeCall);
            assert.deepEqual(r.map(x => [x.id, x.status, x.proposalHash]), [[threadId, 'linked', proposalHash]]);
            assert.equal(db.getThread(threadId).proposalHash, proposalHash);

            const links = lifecycleLinks(db.getThread(refId), db.getThreadsByProposalHash(proposalHash));
            assert.deepEqual(links.earlier.map(t => t.id), [threadId]);
            assert.equal(earlierPostCount(links), 2, 'the motion posts show under Earlier discussion');
            assert.deepEqual(lifecycleLinks(db.getThread(threadId), db.getThreadsByProposalHash(proposalHash)).later.map(t => t.id), [refId]);

            // Idempotent: the next tick changes nothing.
            assert.deepEqual(linkMotionThreadsByCallHash(db, [{ proposalHash, bounded, source: 'referendum #36' }], makeCall), []);
        });

        test('no motion thread, no bounded call, or a codec that will not build: nothing happens', () => {
            const other = { Lookup: { hash: '0x' + '5e'.repeat(32), len: 7 } };
            assert.deepEqual(linkMotionThreadsByCallHash(db, [{ proposalHash: '0x' + '5e'.repeat(32), bounded: other }], makeCall), []);
            assert.deepEqual(linkMotionThreadsByCallHash(db, [{ proposalHash, bounded: null }], makeCall), []);
            assert.deepEqual(linkMotionThreadsByCallHash(db, [{ proposalHash, bounded }], () => { throw new Error('no democracy pallet'); }), []);
            assert.deepEqual(externalProposeCallHashes(bounded, () => null), []);
        });
    });
});

describe('link guards', () => {
    const fakeCall = (h) => ({ hash: { toHex: () => h } });
    test('a motion thread that already has a different hash is reported, never overwritten', () => {
        const M = '0x' + '3a'.repeat(32), P1 = '0x' + '3b'.repeat(32), P2 = '0x' + '3c'.repeat(32);
        db.createThreadIfMissing({ id: `motion-${M}`, kind: 'motion', refKey: M, title: 't' });
        db.setThreadProposalHash(`motion-${M}`, P1);
        const r = linkMotionThreadsByCallHash(db, [{ proposalHash: P2, bounded: {} }], () => fakeCall(M));
        assert.deepEqual(r.map(x => [x.id, x.status, x.current]), [[`motion-${M}`, 'conflict', P1]]);
        assert.equal(db.getThread(`motion-${M}`).proposalHash, P1);
    });
    test('dry run plans, writes nothing', () => {
        const M = '0x' + '4a'.repeat(32), P = '0x' + '4b'.repeat(32);
        db.createThreadIfMissing({ id: `motion-${M}`, kind: 'motion', refKey: M, title: 't' });
        const r = linkMotionThreadsByCallHash(db, [{ proposalHash: P, bounded: {} }], () => fakeCall(M), { apply: false });
        assert.deepEqual(r.map(x => [x.id, x.status]), [[`motion-${M}`, 'would-link']]);
        assert.equal(db.getThread(`motion-${M}`).proposalHash, null);
    });
    test('only motion threads are linked', () => {
        const M = '0x' + '6a'.repeat(32), P = '0x' + '6b'.repeat(32);
        db.createThreadIfMissing({ id: `motion-${M}`, kind: 'proposal', refKey: M, title: 'odd row' });
        assert.deepEqual(linkMotionThreadsByCallHash(db, [{ proposalHash: P, bounded: {} }], () => fakeCall(M)), []);
    });
});

// The historical backfill stays as the second path (a motion whose referendum
// already finished); these are the three ways it lost #140.
describe('backfill: an unreadable history is not a try', () => {
    const external = { section: 'democracy', method: 'externalProposeMajority', args: [JSON.stringify({ lookup: { hash: PREIMAGE, len: LEN } })], hash: { toHex: () => '0x' + 'aa'.repeat(32) } };
    const io = (o = {}) => ({ stateAt: async () => null, blockCalls: async () => [], hashOf: (c) => proposalHashOf(c.args[0], blake2AsHex), ...o });
    const row = (o = {}) => ({ id: 'motion-x', hash: '0x' + 'aa'.repeat(32), collective: 'council', proposedBlock: null, resolvedBlock: 13_321_483, ...o });
    const pruned = async () => { throw new Error('State already discarded'); };

    test('no proposing block and the state at the resolving block is pruned: unavailable (was a miss)', async () => {
        assert.deepEqual(await recoverMotionProposalHash(row(), io({ stateAt: pruned })), { outcome: 'unavailable' });
    });
    test('no block known at all yet (the locator has not placed it): unavailable (was a miss)', async () => {
        assert.deepEqual(await recoverMotionProposalHash(row({ resolvedBlock: null }), io()), { outcome: 'unavailable' });
    });
    test('pruned state at the proposing block still reads the body', async () => {
        const propose = { section: 'council', method: 'propose', args: [3, external, 120], hash: { toHex: () => '0x' + '33'.repeat(32) } };
        const r = await recoverMotionProposalHash(row({ proposedBlock: 13_300_000 }), io({ stateAt: pruned, blockCalls: async () => [propose] }));
        assert.deepEqual(r, { outcome: 'found', hash: PREIMAGE });
    });
    test('a state read that answered None at the resolving block is a miss', async () => {
        assert.deepEqual(await recoverMotionProposalHash(row(), io({ stateAt: async () => null })), { outcome: 'miss' });
    });
    test('server.js: state errors are not swallowed into null, and one unreadable row does not stop the pass', () => {
        const fn = bodyOf(stripComments(readRepo('server.js', import.meta.url)), 'backfillMotionProposalHashes');
        assert.doesNotMatch(fn, /catch \(e\) \{ return null; \}/, 'a pruned-state error must reach recoverMotionProposalHash as a throw');
        assert.doesNotMatch(fn, /if \(r\.outcome === 'unavailable'\) break;/);
        assert.match(fn, /if \(r\.outcome === 'unavailable'\) \{\s*if \(!isRpcReady\(\)\) break;/);
        assert.match(fn, /\.sort\(\(a, b\) => \(tried\[a\.id\] \|\| 0\) - \(tried\[b\.id\] \|\| 0\)\)/, 'least recently tried first');
    });
    test('server.js: the democracy pass links motions from the referenda and the external it read', () => {
        const pass = bodyOf(stripComments(readRepo('server.js', import.meta.url)), 'syncDemocracyPass');
        assert.match(pass, /linkMotionThreadsFromDemocracy\(/);
        const fn = bodyOf(stripComments(readRepo('server.js', import.meta.url)), 'linkMotionThreadsFromDemocracy');
        assert.match(fn, /linkMotionThreadsByCallHash\(db, items, makeCall\)/);
        assert.match(fn, /globalApi\.tx\.democracy\[method\]\(bounded\)\.method/);
    });
});

describe('operator tool: tools/link-motion-threads.mjs', () => {
    test('dry run on a copy of the production shape, then apply, then idempotent', () => {
        const { tx, makeCall } = chainFor(substrateMetadata);
        const bounded = { Lookup: { hash: '0x' + '7c'.repeat(32), len: 99 } };
        const M = tx.democracy.externalProposeMajority(bounded).hash.toHex();
        const P = '0x' + '7c'.repeat(32);
        const id = `motion-${M}`;
        db.createThreadIfMissing({ id, kind: 'motion', refKey: M, title: 'democracy.externalProposeMajority' });
        db.closeThread(id, AUTO_CLOSE_REASON.motion);
        db.upsertCollectiveMotion('council', { hash: M, motionIndex: 140, section: 'democracy', method: 'externalProposeMajority', proposedBlock: 13_300_000 });
        db.setKv('discussion:motion-hash-attempts', { [id]: 3, 'motion-other': 1 });

        const file = path.join(DIR, 'explorer.db');

        const ro = new DatabaseSync(file, { readOnly: true });
        const diag = motionThreadDiagnostics(ro).find(d => d.id === id);
        assert.equal(diag.attempts, 3, 'shows the retired backfill');
        assert.deepEqual(diag.motions.map(m => [m.collective, m.motionIndex, m.section, m.method, m.proposedBlock]),
            [['council', 140, 'democracy', 'externalProposeMajority', 13_300_000]]);
        const plan = linkMotionThreads(sqliteThreadStore(ro), [{ proposalHash: P, bounded, source: 'referendum #36' }], makeCall, { apply: false });
        assert.deepEqual(plan.map(x => [x.id, x.status]), [[id, 'would-link']]);
        ro.close();
        assert.equal(db.getThread(id).proposalHash, null, 'dry run wrote nothing');

        const rw = new DatabaseSync(file);
        const done = linkMotionThreads(sqliteThreadStore(rw), [{ proposalHash: P, bounded, source: 'referendum #36' }], makeCall, { apply: true });
        assert.deepEqual(done.map(x => [x.id, x.status]), [[id, 'linked']]);
        clearAttempts(rw, done.filter(x => x.status === 'linked').map(x => x.id));
        assert.deepEqual(linkMotionThreads(sqliteThreadStore(rw), [{ proposalHash: P, bounded, source: 'referendum #36' }], makeCall, { apply: true }), []);
        rw.close();
        assert.equal(db.getThread(id).proposalHash, P);
        assert.deepEqual(db.getKv('discussion:motion-hash-attempts'), { 'motion-other': 1 });
    });
    test('the tool is read-only unless --apply, and prints how to run it on the box', () => {
        const src = readRepo('tools/link-motion-threads.mjs', import.meta.url);
        assert.match(src, /new DatabaseSync\(dbPath, \{ readOnly: !apply \}\)/);
        assert.match(src, /docker compose exec backend node --experimental-sqlite tools\/link-motion-threads\.mjs --apply/);
    });
});
