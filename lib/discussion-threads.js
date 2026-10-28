// Discussion thread lifecycle: one thread per public proposal (democracy) and
// per council motion, opened when the item appears on chain and closed when it
// leaves the chain's active list.
//
// Why this is a module and not two closures in server.js (2026-10-22, "the old
// discussion is lost"): the closures closed EVERY open thread missing from ONE
// read of the chain, with no check that the read was current, and closing was
// one-way - createThreadIfMissing never touches an existing row. The backend's
// RPC is a load balancer over several nodes, and every deploy restarts the
// backend, so the first read after a restart can land on a node that is behind.
// From such a node the proposal list can be shorter or empty, and every live
// discussion was locked for good under the false reason "moved to a
// referendum". Nothing was deleted (no code path deletes discussion rows), but
// the threads were locked and dropped out of the open list.
//
// Three guards, all tested in test/discussion-threads.test.js:
//   1. trust     - close only on a read that is provably current: its block is
//                  not behind the last trusted read, and (for proposals) the
//                  node's publicPropCount covers every proposal we have a
//                  thread for. An untrusted read may create, never close.
//   2. self-heal - a thread that WE auto-closed but whose item is active again
//                  is reopened. This also repairs threads already closed in
//                  production by the old code, with no manual DB edit.
//   3. never delete - closing is a status change; posts are never touched.
//
// Democracy lifecycle threads (2026-10-26, "democracy proposals are not
// showing up in the discussion board"): the queued external proposal
// (external-<proposalHash>) and every ongoing referendum (referendum-<index>)
// get threads under the same three guards. A referendum thread closes on
// positive evidence only: a trusted read that shows it Finished (passed or
// failed) or, below referendumCount, removed (cancelled). Each thread stores
// the democracy proposal hash it is about, and lib/discussion-lifecycle.js
// derives the "Earlier discussion" / "Continued in" links from it.
//
// Known behaviours (intended or accepted):
//   - One-tick flap: the first trusted read after a deploy can reopen a thread
//     that a later trusted read closes again.
//   - A council motion re-proposed with the same call hash reopens its old
//     thread with its old posts (intended).

import { normalizeHash, isExternalProposeCall } from './discussion-lifecycle.js';

export const AUTO_CLOSE_REASON = {
    proposal: 'Proposal tabled and moved to a referendum (voting).',
    motion: 'Council motion concluded.',
    external: 'External proposal is no longer queued.',
    referendum: 'Referendum ended.'
};
export const REFERENDUM_CLOSE_REASON = {
    passed: 'Referendum passed.',
    failed: 'Referendum failed.',
    cancelled: 'Referendum cancelled.'
};
export const externalLaunchedReason = (refIndex) => `External proposal launched as referendum #${refIndex}.`;

// Only a close this module made may be undone by it (self-heal); a reason set
// by anyone else is left alone.
export function isAutoCloseReason(kind, reason) {
    if (!reason) return false;
    if (reason === AUTO_CLOSE_REASON[kind]) return true;
    if (kind === 'external') return /^External proposal launched as referendum #\d+\.$/.test(reason);
    if (kind === 'referendum') return Object.values(REFERENDUM_CLOSE_REASON).includes(reason);
    return false;
}

const finiteBlock = (n) => Number.isFinite(Number(n)) && n !== null && n !== '' ? Number(n) : null;

// The block of the last trusted read only ever moves forward.
export function nextHighWater(prev, currentBlock) {
    const p = finiteBlock(prev) || 0;
    const c = finiteBlock(currentBlock);
    return c === null ? p : Math.max(p, c);
}

function blockCheck(currentBlock, highWater) {
    const c = finiteBlock(currentBlock);
    if (c === null) return { trusted: false, reason: 'read has no block number' };
    const hw = finiteBlock(highWater) || 0;
    if (c < hw) return { trusted: false, reason: `node is behind: block ${c} < last trusted ${hw}` };
    return { trusted: true, reason: '' };
}

// A counter that only grows (publicPropCount, referendumCount): a node that
// reports fewer than (highest index we have a thread for + 1) has not caught
// up with state we already acted on.
function countCheck(label, noun, count, currentBlock, highWater, knownRefKeys) {
    const b = blockCheck(currentBlock, highWater);
    if (!b.trusted) return b;
    if (count === null || count === undefined) return b;   // runtime without the counter: block check only
    const n = Number(count);
    const highest = (knownRefKeys || []).map(Number).filter(Number.isFinite).reduce((m, x) => Math.max(m, x), -1);
    if (!Number.isFinite(n) || highest >= n) {
        return { trusted: false, reason: `node is behind: ${label} ${count} but ${noun} ${highest} has a thread` };
    }
    return b;
}

// Democracy read: public proposals.
export function proposalReadTrusted({ publicPropCount, currentBlock, highWater, knownRefKeys }) {
    return countCheck('publicPropCount', 'proposal', publicPropCount, currentBlock, highWater, knownRefKeys);
}

// Democracy read: referenda.
export function referendumReadTrusted({ referendumCount, currentBlock, highWater, knownRefKeys }) {
    return countCheck('referendumCount', 'referendum', referendumCount, currentBlock, highWater, knownRefKeys);
}

// Democracy read: nextExternal. There is no counter to check, so the block
// check carries it; the caller passes the highest high-water of the democracy
// kinds, so a node behind ANY trusted democracy read is not trusted here.
export function externalReadTrusted({ currentBlock, highWater }) {
    return blockCheck(currentBlock, highWater);
}

// Council read. listTrusted is the existing readLiveCollectiveMotions flag
// (the proposals list was read and every hash walked without throwing).
export function motionReadTrusted({ listTrusted, currentBlock, highWater }) {
    if (!listTrusted) return { trusted: false, reason: 'motion list incomplete' };
    return blockCheck(currentBlock, highWater);
}

// What a listed item may add to its thread on any read, trusted or not: the
// proposal hash (an index or call hash names one call for good, so even a
// lagging node reports the right one) and a decoded title replacing the
// short-hash placeholder (titleDecoded: true).
function annotate(db, it) {
    if (it.proposalHash && typeof db.setThreadProposalHash === 'function') db.setThreadProposalHash(it.id, it.proposalHash);
    if (it.titleDecoded && it.title && typeof db.setThreadTitle === 'function') db.setThreadTitle(it.id, it.title);
}

// items: [{ id, refKey, title, proposalHash?, titleDecoded? }] - the chain's
// active list for `kind`. closeReason(id), when given, words the close.
// Returns what changed, for the log line and the tests.
export function reconcileThreads(db, kind, items, { trusted, closeReason } = {}) {
    const out = { created: [], reopened: [], closed: [], skipped: !trusted };
    const activeIds = new Set();
    for (const it of (items || [])) {
        activeIds.add(it.id);
        const created = db.createThreadIfMissing({ id: it.id, kind, refKey: it.refKey, title: it.title });
        annotate(db, it);
        if (created) { out.created.push(it.id); continue; }
        if (!trusted) continue;
        const t = db.getThread(it.id);
        if (t && t.status === 'closed' && isAutoCloseReason(kind, t.closedReason) && db.reopenThread(it.id)) out.reopened.push(it.id);
    }
    if (!trusted) return out;
    for (const openId of db.getOpenThreadIds(kind)) {
        if (activeIds.has(openId)) continue;
        db.closeThread(openId, (typeof closeReason === 'function' && closeReason(openId)) || AUTO_CLOSE_REASON[kind]);
        out.closed.push(openId);
    }
    return out;
}

// Referenda. reads: [{ id, refKey, state, title?, proposalHash?, titleDecoded? }]
// where state is what THIS read saw for that index: 'ongoing', 'passed',
// 'failed' or 'cancelled' (removed from storage below referendumCount). An
// index the read could not see (an RPC error) is simply absent: its thread is
// left as it is. Threads are created for ongoing referenda only.
export function reconcileReferendumThreads(db, reads, { trusted } = {}) {
    const out = { created: [], reopened: [], closed: [], skipped: !trusted };
    for (const r of (reads || [])) {
        if (r.state === 'ongoing') {
            const created = db.createThreadIfMissing({ id: r.id, kind: 'referendum', refKey: r.refKey, title: r.title });
            annotate(db, r);
            if (created) { out.created.push(r.id); continue; }
            if (!trusted) continue;
            const t = db.getThread(r.id);
            if (t && t.status === 'closed' && isAutoCloseReason('referendum', t.closedReason) && db.reopenThread(r.id)) out.reopened.push(r.id);
            continue;
        }
        const reason = REFERENDUM_CLOSE_REASON[r.state];
        if (!reason || !trusted) continue;
        const t = db.getThread(r.id);
        if (t && t.status === 'open') { db.closeThread(r.id, reason); out.closed.push(r.id); }
    }
    return out;
}

// Find the call with `hash` anywhere in a list of call trees (the extrinsics
// of the block that proposed a council motion: council.propose directly, or
// inside utility.batch, proxy.proxy, multisig.asMulti and the like). A call is
// anything with a string section/method and an args array; a nested call is an
// arg that is itself a call or a list of calls. Used to recover the call of a
// motion that concluded before its proposal hash was recorded.
export function findCallByHash(roots, hash, maxDepth = 6) {
    const want = normalizeHash(hash);
    if (!want) return null;
    const isCall = (c) => !!c && typeof c === 'object' && typeof c.section === 'string' && typeof c.method === 'string' && Array.isArray(c.args);
    const hashOf = (c) => {
        try { const h = c.hash; return normalizeHash(h && typeof h.toHex === 'function' ? h.toHex() : h); } catch (_) { return null; }
    };
    const walk = (node, depth) => {
        if (depth > maxDepth || !node) return null;
        if (Array.isArray(node) && !isCall(node)) {
            for (const n of node) { const f = walk(n, depth + 1); if (f) return f; }
            return null;
        }
        if (!isCall(node)) return null;
        if (hashOf(node) === want) return node;
        for (const a of node.args) { const f = walk(a, depth + 1); if (f) return f; }
        return null;
    };
    return walk(Array.from(roots || []), 0);
}

// One backfill try for a concluded motion's democracy proposal hash: the state
// at the block that proposed it, then that block's body, then the state just
// before the block that resolved it. io (server.js supplies the RPC reads):
//   stateAt(block)     -> the call, or null when the state answered None; THROWS
//                         when the state cannot be read (pruned on a non-archive
//                         node behind the load balancer, or the RPC is down)
//   blockCalls(block)  -> the block's extrinsic calls; THROWS when the RPC is
//                         down or the read fails
//   hashOf(call)       -> the proposal hash of an externalPropose* call
// Result:
//   { outcome: 'found', hash }
//   { outcome: 'miss' }        a read ANSWERED and the call is not an external
//                              proposal: the body was read and does not hold
//                              it, or a decoded call is something else, or the
//                              state before the resolving block holds nothing
//   { outcome: 'unavailable' } nothing answered: no block is known yet (the
//                              motion locator has not placed it), or every read
//                              threw. Not a try; the row is left for later.
// Only 'miss' may count against the three tries. 2026-10-26: an RPC outage
// burned all three. 2026-10-27 (motion #140 on production): a pruned state
// read was swallowed into null and a row with no block known was a miss, so
// "could not read" still retired the thread.
export async function recoverMotionProposalHash(row, io) {
    const at = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
    const proposed = at(row && row.proposedBlock);
    const resolved = at(row && row.resolvedBlock);
    const hasProposed = proposed > 0;
    const hasResolved = resolved > 1;
    let call = null;
    let answered = false;
    // A state read that throws is "could not read", never "not there".
    const stateAt = async (b) => {
        try { const c = await io.stateAt(b); answered = true; return c || null; }
        catch (_) { return null; }
    };
    if (hasProposed) call = await stateAt(proposed);
    if (!call && hasProposed) {
        let calls;
        try { calls = await io.blockCalls(proposed); } catch (_) { return { outcome: 'unavailable' }; }
        if (!Array.isArray(calls)) return { outcome: 'unavailable' };
        answered = true;
        call = findCallByHash(calls, row.hash);
    }
    if (!call && hasResolved) call = await stateAt(resolved - 1);
    if (call && isExternalProposeCall(call.section, call.method)) {
        let hash = null;
        try { hash = normalizeHash(io.hashOf(call)); } catch (_) { hash = null; }
        if (hash) return { outcome: 'found', hash };
    }
    return (call || answered) ? { outcome: 'miss' } : { outcome: 'unavailable' };
}

// The democracy calls a council motion can use to queue an external proposal.
export const EXTERNAL_PROPOSE_METHODS = ['externalPropose', 'externalProposeMajority', 'externalProposeDefault'];

// The call hashes a council motion would have if it queued `bounded`: the
// collective pallet keys a motion by blake2_256 of its encoded call, and that
// call is democracy.externalPropose*(bounded), the SAME bounded call that
// nextExternal and then the referendum carry (a Technical Committee fast-track
// passes it on unchanged). makeCall(method, bounded) builds the call with the
// running runtime's encoding (server.js: globalApi.tx.democracy[method](b).method)
// and may throw or return null when the method does not exist.
export function externalProposeCallHashes(bounded, makeCall) {
    const out = [];
    if (!bounded || typeof makeCall !== 'function') return out;
    for (const method of EXTERNAL_PROPOSE_METHODS) {
        let h = null;
        try {
            const c = makeCall(method, bounded);
            const raw = c && c.hash;
            h = normalizeHash(raw && typeof raw.toHex === 'function' ? raw.toHex() : raw);
        } catch (_) { h = null; }
        if (h && !out.includes(h)) out.push(h);
    }
    return out;
}

// Link council motion threads to the democracy proposal they queued, from data
// the explorer reads on every democracy tick (no block history, no archive
// node): items are the referenda and the external proposal that read saw,
// [{ proposalHash, bounded, source }]. A motion thread (motion-<call hash>)
// whose call hash is one of externalProposeCallHashes(bounded) gets that
// proposalHash, set once (db.setThreadProposalHash only fills NULL); a thread
// already holding a different hash is reported as a conflict and left alone.
// db: { getThread(id), setThreadProposalHash(id, hash) }. apply: false plans
// only (the operator tool's dry run). Returns one entry per thread it would
// change or could not, nothing for threads already linked.
export function linkMotionThreadsByCallHash(db, items, makeCall, { apply = true } = {}) {
    const out = [];
    const seen = new Set();
    for (const it of (items || [])) {
        const proposalHash = normalizeHash(it && it.proposalHash);
        if (!proposalHash || !it.bounded) continue;
        for (const motionHash of externalProposeCallHashes(it.bounded, makeCall)) {
            const id = `motion-${motionHash}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const t = db.getThread(id);
            if (!t || t.kind !== 'motion') continue;
            const current = normalizeHash(t.proposalHash);
            if (current === proposalHash) continue;
            const base = { id, motionHash, proposalHash, source: it.source || null, title: t.title || null, status: null };
            if (current) { out.push({ ...base, status: 'conflict', current }); continue; }
            if (!apply) { out.push({ ...base, status: 'would-link' }); continue; }
            out.push({ ...base, status: db.setThreadProposalHash(id, proposalHash) ? 'linked' : 'unchanged' });
        }
    }
    return out;
}

// ---- No-archive fallback ---------------------------------------------------
//
// The live path above needs the bounded call B from a referendum (or the
// external proposal) that is still readable. Once referendum #36 finishes,
// referendumInfoOf(36) holds no proposal, and the archive read for the state
// before it ended may be pruned behind the load balancer. But the referendum's
// discussion thread stored its proposal hash (discussion_threads.proposal_hash),
// and for a Lookup call that hash IS the preimage hash; the only other part of
// B is the preimage length, which the preimage pallet keeps in current state.
// So B is rebuilt as { Lookup: { hash, len } } and fed to the same
// linkMotionThreadsByCallHash. An Inline proposal has no preimage (its hash is
// the hash of the call bytes, which are not stored), so it cannot be rebuilt
// and is left to the live path.

// The length held by a preimage status (Option<RequestStatus>, codec or JSON):
//   Unrequested { deposit | ticket, len }   Requested { ..., len | maybeLen }
// null for None, for a Requested status with no length, or for anything else.
export function preimageStatusLen(status) {
    if (status === null || status === undefined) return null;
    let j = status;
    if (typeof status === 'object' && typeof status.isSome === 'boolean') {
        if (!status.isSome) return null;
        j = status.unwrap();
    }
    if (j && typeof j === 'object' && typeof j.toJSON === 'function') {
        try { j = j.toJSON(); } catch (_) { return null; }
    }
    if (!j || typeof j !== 'object') return null;
    for (const v of Object.values(j)) {
        if (!v || typeof v !== 'object') continue;
        const len = v.len !== undefined && v.len !== null ? v.len : v.maybeLen;
        const n = len === undefined || len === null ? NaN : Number(len);
        if (Number.isInteger(n) && n > 0) return n;
    }
    return null;
}

// reads: { requestStatusFor?, statusFor? }, each (hash) => Promise<Option>, a
// missing one is null/undefined (the storage item does not exist on that
// runtime). Spec 373 has only StatusFor; 392 has both (RequestStatusFor is the
// current one). First answer with a length wins.
// -> { len } or { len: null, reason } where reason says why, for the log:
//    'no preimage status storage' | 'preimage status is empty' | 'preimage status could not be read'
export async function preimageLength(hash, reads) {
    const readers = [reads && reads.requestStatusFor, reads && reads.statusFor].filter(f => typeof f === 'function');
    if (!readers.length) return { len: null, reason: 'no preimage status storage' };
    let answered = false;
    for (const read of readers) {
        let status;
        try { status = await read(hash); answered = true; } catch (_) { continue; }
        const len = preimageStatusLen(status);
        if (len) return { len };
    }
    return { len: null, reason: answered ? 'preimage status is empty' : 'preimage status could not be read' };
}

// The readers for preimageLength from a polkadot-js api (the query items that
// exist on the running runtime), so the server and the operator tool share them.
export function preimageStatusReads(api) {
    const p = api && api.query && api.query.preimage;
    const pick = (item) => (item && typeof item === 'function' ? (h) => item(h) : null);
    return { requestStatusFor: pick(p && p.requestStatusFor), statusFor: pick(p && p.statusFor) };
}

// Items for linkMotionThreadsByCallHash rebuilt from stored threads that the
// live read did not cover. threads: [{ id, kind, refKey, proposalHash }]
// (referendum and external threads that hold a proposal hash); liveHashes: the
// proposal hashes the live items already carry; lenOf(hash) -> a length or
// { len, reason } (callers cache; this does not). Returns { items, notes }:
// notes say, per thread, why one was skipped.
export async function fallbackItemsFromThreads(threads, liveHashes, lenOf) {
    const items = [];
    const notes = [];
    const live = new Set(Array.from(liveHashes || [], normalizeHash).filter(Boolean));
    const done = new Set();
    for (const t of (threads || [])) {
        const hash = normalizeHash(t && t.proposalHash);
        if (!hash || live.has(hash) || done.has(hash)) continue;
        done.add(hash);
        const what = t.kind === 'external' ? 'the external proposal' : `referendum #${t.refKey}`;
        let r;
        try { r = await lenOf(hash); } catch (_) { r = { len: null, reason: 'preimage status could not be read' }; }
        const len = r && typeof r === 'object' ? r.len : r;
        if (!(Number(len) > 0)) {
            notes.push(`${what} (${hash}): not rebuilt, ${(r && r.reason) || 'preimage length unknown'}`);
            continue;
        }
        items.push({ proposalHash: hash, bounded: { Lookup: { hash, len: Number(len) } }, source: `${what} (stored hash; length from the preimage status)` });
    }
    return { items, notes };
}
