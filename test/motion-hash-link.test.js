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
    externalProposeCallHashes, EXTERNAL_PROPOSE_METHODS, AUTO_CLOSE_REASON,
    preimageStatusLen, preimageLength, preimageStatusReads, fallbackItemsFromThreads
} from '../lib/discussion-threads.js';
import { proposalHashOf, lifecycleLinks, earlierPostCount, referendumThreadId } from '../lib/discussion-lifecycle.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { sqliteThreadStore, motionThreadDiagnostics, linkMotionThreads, clearAttempts,
    sqliteDemocracyThreads, fallbackChainItems } from '../tools/link-motion-threads.mjs';

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
        assert.match(src, /docker compose exec -T backend node --experimental-sqlite tools\/link-motion-threads\.mjs --apply/);
    });
});

// Referendum #36 finishes (Ongoing ends ~29 Oct 2026): referendumInfoOf(36)
// then has no proposal and the archive read behind the load balancer may be
// pruned. The referendum thread stored the proposal hash; the preimage length
// comes from current state, and B is rebuilt as Lookup { hash, len }.
sources.forEach((src, n) => {
    describe(`no-archive fallback from the stored proposal hash: ${src.label}`, () => {
        const { registry, tx, makeCall } = chainFor(src.hex);
        const HASH = '0x' + (0xd0 + n).toString(16).repeat(32);
        const REFN = 70 + n;
        const refId = referendumThreadId(REFN);
        const motionOf = () => tx.democracy.externalProposeMajority({ Lookup: { hash: HASH, len: LEN } }).hash.toHex();
        const MOTION = motionOf();
        const threadId = `motion-${MOTION}`;

        // The preimage status storage the runtime has: StatusFor (373 and 392,
        // deposit/len) and RequestStatusFor (392, ticket/len). Real codecs.
        const pallet = registry.metadata.pallets.find(p => p.name.toString() === 'Preimage');
        const storageType = (name) => {
            const item = pallet && pallet.storage.unwrap().items.find(i => i.name.toString() === name);
            return item ? registry.createLookupType(item.type.asMap.value) : null;
        };
        const optStatus = (name, v) => registry.createType(`Option<${storageType(name)}>`, v);
        const acct = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
        const reads = (map) => ({ requestStatusFor: map.request ? async () => map.request : null, statusFor: map.status ? async () => map.status : null });

        before(() => {
            // The thread rows as production has them after the referendum finished.
            reconcileThreads(db, 'motion', [{ id: threadId, refKey: MOTION, title: 'democracy.externalProposeMajority' }], { trusted: true });
            reconcileThreads(db, 'motion', [], { trusted: true });
            reconcileReferendumThreads(db, [{ id: refId, refKey: String(REFN), state: 'ongoing', title: `Referendum #${REFN}`, proposalHash: HASH }], { trusted: true });
            reconcileReferendumThreads(db, [{ id: refId, refKey: String(REFN), state: 'passed', title: `Referendum #${REFN}`, proposalHash: HASH }], { trusted: true });
        });

        test('the preimage status of this runtime yields the length (Unrequested and Requested)', () => {
            assert.equal(preimageStatusLen(optStatus('StatusFor', { Unrequested: { deposit: [acct, 1], len: LEN } })), LEN);
            assert.equal(preimageStatusLen(optStatus('StatusFor', { Requested: { deposit: null, count: 1, len: LEN } })), LEN);
            assert.equal(preimageStatusLen(optStatus('StatusFor', null)), null, 'None');
            assert.equal(preimageStatusLen(optStatus('StatusFor', { Requested: { deposit: null, count: 1, len: null } })), null, 'Requested without a length');
            if (storageType('RequestStatusFor')) {
                assert.equal(preimageStatusLen(optStatus('RequestStatusFor', { Unrequested: { ticket: [acct, null], len: LEN } })), LEN);
                assert.equal(preimageStatusLen(optStatus('RequestStatusFor', { Requested: { maybeTicket: null, count: 2, maybeLen: LEN } })), LEN);
            }
        });

        test('finished referendum: the thread row alone rebuilds B and links the motion', async () => {
            const stored = db.getDemocracyThreadsWithProposalHash().filter(t => t.id === refId);
            assert.deepEqual(stored.map(t => [t.kind, t.refKey, t.status, t.proposalHash]), [['referendum', String(REFN), 'closed', HASH]]);
            const { items, notes } = await fallbackItemsFromThreads(stored, [], (h) => preimageLength(h, reads({ status: optStatus('StatusFor', { Unrequested: { deposit: [acct, 1], len: LEN } }) })));
            assert.deepEqual(notes, []);
            assert.equal(items.length, 1);
            assert.equal(items[0].proposalHash, HASH);
            assert.match(items[0].source, new RegExp(`^referendum #${REFN} `));
            // Same call hash as the live path (and as the motion the council stored).
            assert.ok(externalProposeCallHashes(items[0].bounded, makeCall).includes(MOTION));
            assert.equal(db.getThread(threadId).proposalHash, null);
            const r = linkMotionThreadsByCallHash(db, items, makeCall);
            assert.deepEqual(r.map(x => [x.id, x.status, x.proposalHash]), [[threadId, 'linked', HASH]]);
            assert.equal(db.getThread(threadId).proposalHash, HASH);
            assert.deepEqual(linkMotionThreadsByCallHash(db, items, makeCall), [], 'idempotent');
        });

        test('RequestStatusFor is preferred where the runtime has it, StatusFor otherwise', async () => {
            if (storageType('RequestStatusFor')) {
                const got = await preimageLength(HASH, reads({
                    request: optStatus('RequestStatusFor', { Unrequested: { ticket: [acct, null], len: 4321 } }),
                    status: optStatus('StatusFor', { Unrequested: { deposit: [acct, 1], len: 1234 } }) }));
                assert.deepEqual(got, { len: 4321 });
            }
            assert.deepEqual(await preimageLength(HASH, reads({ status: optStatus('StatusFor', { Unrequested: { deposit: [acct, 1], len: 1234 } }) })), { len: 1234 });
            // The newer item empty, the older one still holds it.
            if (storageType('RequestStatusFor')) {
                assert.deepEqual(await preimageLength(HASH, reads({ request: optStatus('RequestStatusFor', null), status: optStatus('StatusFor', { Unrequested: { deposit: [acct, 1], len: 777 } }) })), { len: 777 });
            }
        });

        test('live referendum: the proposal hash is already covered, nothing is rebuilt (and nothing is read)', async () => {
            let reads_ = 0;
            const { items, notes } = await fallbackItemsFromThreads(
                [{ id: refId, kind: 'referendum', refKey: String(REFN), proposalHash: HASH }], [HASH], async () => { reads_++; return LEN; });
            assert.deepEqual([items, notes, reads_], [[], [], 0]);
        });

        test('preimage status missing: nothing is linked, and the skip says why', async () => {
            const stored = [{ id: refId, kind: 'referendum', refKey: String(REFN), proposalHash: HASH }];
            const none = await fallbackItemsFromThreads(stored, [], (h) => preimageLength(h, reads({ status: optStatus('StatusFor', null) })));
            assert.deepEqual(none.items, []);
            assert.match(none.notes[0], new RegExp(`referendum #${REFN} \\(${HASH}\\): not rebuilt, preimage status is empty`));
            const noStorage = await fallbackItemsFromThreads(stored, [], (h) => preimageLength(h, {}));
            assert.match(noStorage.notes[0], /no preimage status storage/);
            const down = await fallbackItemsFromThreads(stored, [], (h) => preimageLength(h, { statusFor: async () => { throw new Error('rpc down'); } }));
            assert.match(down.notes[0], /could not be read/);
            const thrown = await fallbackItemsFromThreads(stored, [], async () => { throw new Error('boom'); });
            assert.deepEqual(thrown.items, []);
        });

        test('the tool: dry run reads the stored threads, rebuilds B from a fake api, and plans the link', async () => {
            const M = `motion-${tx.democracy.externalProposeMajority({ Lookup: { hash: '0x' + (0xe0 + n).toString(16).repeat(32), len: 55 } }).hash.toHex()}`;
            const P = '0x' + (0xe0 + n).toString(16).repeat(32);
            db.createThreadIfMissing({ id: M, kind: 'motion', refKey: M.slice(7), title: 't' });
            for (const state of ['ongoing', 'passed']) reconcileReferendumThreads(db, [{ id: referendumThreadId(90 + n), refKey: String(90 + n), state, title: 'r', proposalHash: P }], { trusted: true });
            const file = path.join(DIR, 'explorer.db');
            const ro = new DatabaseSync(file, { readOnly: true });
            const logs = [];
            const api = { query: { preimage: { statusFor: async (h) => (h === P ? optStatus('StatusFor', { Unrequested: { deposit: [acct, 1], len: 55 } }) : optStatus('StatusFor', null)) } } };
            const rebuilt = await fallbackChainItems(api, [], sqliteDemocracyThreads(ro), (m) => logs.push(m));
            const plan = linkMotionThreads(sqliteThreadStore(ro), rebuilt, makeCall, { apply: false });
            ro.close();
            assert.deepEqual(plan.map(x => [x.id, x.status]), [[M, 'would-link']]);
            assert.equal(db.getThread(M).proposalHash, null, 'dry run wrote nothing');
            // Every other stored referendum has no status on this fake chain: listed, not guessed.
            assert.ok(logs.length >= 1 && logs.every(l => /not rebuilt/.test(l)), logs.join('\n'));
        });
    });
});

describe('server.js: the tick wiring and the review follow-ups', () => {
    const code = stripComments(readRepo('server.js', import.meta.url));
    test('the democracy tick adds the fallback items to the live ones', () => {
        const pass = bodyOf(code, 'syncDemocracyPass');
        assert.match(pass, /linkMotionThreadsFromDemocracy\(\[\.\.\.liveItems, \.\.\.await fallbackMotionItems\(liveItems\)\]\)/);
        const fb = bodyOf(code, 'fallbackMotionItems');
        assert.match(fb, /countMotionThreadsWithoutProposalHash\(\)/, 'only while a motion thread has no hash');
        assert.match(fb, /fallbackItemsFromThreads\(db\.getDemocracyThreadsWithProposalHash\(\), liveItems\.map/);
    });
    test('a motion linked by the tick leaves no backfill counter behind', () => {
        const fn = bodyOf(code, 'linkMotionThreadsFromDemocracy');
        assert.match(fn, /forgetMotionBackfill\(r\.id\)/);
        const forget = bodyOf(code, 'forgetMotionBackfill');
        assert.match(forget, /MOTION_HASH_ATTEMPTS_KEY, MOTION_HASH_TRIED_KEY/);
        assert.match(forget, /delete m\[id\]; db\.setKv\(key, m\)/);
    });
    test('the backfill writes kv only when it changed', () => {
        const fn = bodyOf(code, 'backfillMotionProposalHashes');
        assert.doesNotMatch(fn, /changed = true/);
        assert.match(fn, /JSON\.stringify\(\[attempts, tried\]\) !== before/);
    });
    test('the image ships what the tool needs', () => {
        const df = readRepo('Dockerfile.backend', import.meta.url);
        assert.match(df, /^COPY --chown=node:node lib \.\/lib$/m);
        assert.match(df, /^COPY --chown=node:node tools \.\/tools$/m);
        const tool = readRepo('tools/link-motion-threads.mjs', import.meta.url);
        for (const m of tool.matchAll(/from '(\.\.?\/[^']+)'/g)) assert.match(m[1], /^\.\.\/lib\//, 'the tool imports only lib/ relatively');
        assert.match(tool, /docker compose exec -T backend node --experimental-sqlite tools\/link-motion-threads\.mjs --apply/);
    });
});
