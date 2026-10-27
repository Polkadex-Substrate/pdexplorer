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
//   stateAt(block)     -> the call, or null (state pruned on a non-archive node)
//   blockCalls(block)  -> the block's extrinsic calls; THROWS when the RPC is
//                         down or the read fails
//   hashOf(call)       -> the proposal hash of an externalPropose* call
// Result:
//   { outcome: 'found', hash }
//   { outcome: 'miss' }        the block body WAS read and holds no such call
//                              (or there is no proposing block to read): one try
//   { outcome: 'unavailable' } the RPC was down or a read threw: not a try, the
//                              row is left for a later pass
// Only 'miss' may count against the three tries (2026-10-26 review: an RPC
// outage used to burn all three and leave the motion unlinked for good).
export async function recoverMotionProposalHash(row, io) {
    const hasProposed = !!row && row.proposedBlock !== null && row.proposedBlock !== undefined && Number(row.proposedBlock) > 0;
    let call = null;
    let bodyRead = false;
    try {
        if (hasProposed) call = await io.stateAt(Number(row.proposedBlock));
        if (!call && hasProposed) {
            const calls = await io.blockCalls(Number(row.proposedBlock));
            if (!Array.isArray(calls)) return { outcome: 'unavailable' };
            bodyRead = true;
            call = findCallByHash(calls, row.hash);
        }
        if (!call && row && row.resolvedBlock !== null && row.resolvedBlock !== undefined && Number(row.resolvedBlock) > 1) {
            call = await io.stateAt(Number(row.resolvedBlock) - 1);
        }
    } catch (_) {
        return { outcome: 'unavailable' };
    }
    if (call && isExternalProposeCall(call.section, call.method)) {
        let hash = null;
        try { hash = normalizeHash(io.hashOf(call)); } catch (_) { hash = null; }
        if (hash) return { outcome: 'found', hash };
    }
    // A call was found and is not an external proposal, or the body was read
    // and the call is not in it, or there is no proposing block at all.
    if (call || bodyRead || !hasProposed) return { outcome: 'miss' };
    return { outcome: 'unavailable' };
}
