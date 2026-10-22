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
// Known behaviours (intended or accepted):
//   - One-tick flap: the first trusted read after a deploy can reopen a thread
//     that a later trusted read closes again.
//   - A council motion re-proposed with the same call hash reopens its old
//     thread with its old posts (intended).

export const AUTO_CLOSE_REASON = {
    proposal: 'Proposal tabled and moved to a referendum (voting).',
    motion: 'Council motion concluded.'
};

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

// Democracy read. publicPropCount is the total number of proposals ever made,
// so a node that reports fewer than (highest proposal index we have a thread
// for + 1) has not caught up with state we already acted on.
export function proposalReadTrusted({ publicPropCount, currentBlock, highWater, knownRefKeys }) {
    const b = blockCheck(currentBlock, highWater);
    if (!b.trusted) return b;
    if (publicPropCount === null || publicPropCount === undefined) return b;   // runtime without the counter: block check only
    const count = Number(publicPropCount);
    const highest = (knownRefKeys || []).map(Number).filter(Number.isFinite).reduce((m, n) => Math.max(m, n), -1);
    if (!Number.isFinite(count) || highest >= count) {
        return { trusted: false, reason: `node is behind: publicPropCount ${publicPropCount} but proposal ${highest} has a thread` };
    }
    return b;
}

// Council read. listTrusted is the existing readLiveCollectiveMotions flag
// (the proposals list was read and every hash walked without throwing).
export function motionReadTrusted({ listTrusted, currentBlock, highWater }) {
    if (!listTrusted) return { trusted: false, reason: 'motion list incomplete' };
    return blockCheck(currentBlock, highWater);
}

// items: [{ id, refKey, title }] - the chain's active list for `kind`.
// Returns what changed, for the log line and the tests.
export function reconcileThreads(db, kind, items, { trusted } = {}) {
    const out = { created: [], reopened: [], closed: [], skipped: !trusted };
    const activeIds = new Set();
    for (const it of (items || [])) {
        activeIds.add(it.id);
        if (db.createThreadIfMissing({ id: it.id, kind, refKey: it.refKey, title: it.title })) { out.created.push(it.id); continue; }
        if (!trusted) continue;
        const t = db.getThread(it.id);
        if (t && t.status === 'closed' && t.closedReason === AUTO_CLOSE_REASON[kind] && db.reopenThread(it.id)) out.reopened.push(it.id);
    }
    if (!trusted) return out;
    for (const openId of db.getOpenThreadIds(kind)) {
        if (!activeIds.has(openId)) { db.closeThread(openId, AUTO_CLOSE_REASON[kind]); out.closed.push(openId); }
    }
    return out;
}
