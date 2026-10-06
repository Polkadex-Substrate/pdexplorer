// Collective motions (council AND technical committee): attribution of
// resolving events to the right motion, and the block locator that finds
// motions the event crawler missed.
//
// WHY THIS EXISTS (Oct 2026)
//
// Motions used to be stored one row per PROPOSAL HASH. But the hash is the hash
// of the CALL, and the same call can be proposed again later — a council that
// re-tables an identical treasury approval, a technical committee that
// fast-tracks the same proposal twice. Every re-proposal overwrote or merged
// into the earlier motion's row: 11 council motions (#33, #45, #50, #51, #59,
// #60, #68, #89, #117, #119, #123) vanished from the explorer, and the rows
// they merged into showed a mix of two motions' data.
//
// The pallet's own identity for a motion is its INDEX (ProposalCount is
// monotonic and never reused). So motions are now keyed (collective, index),
// and the resolving events — which carry only the hash — are stored on their
// own and attributed at read time. pallet_collective refuses a proposal whose
// hash is already open (DuplicateProposal), so for any hash the motions are
// strictly sequential and each event belongs to the latest motion with that
// hash proposed at or before it. Everything here is pure so it can be tested
// without a chain or a database.

export const COLLECTIVES = Object.freeze(['council', 'technicalCommittee']);

// Higher wins when a motion has several events (Closed, then Approved, then
// Executed in the same block is the normal "passed" sequence).
export const EVENT_RANK = Object.freeze({ closed: 2, approved: 3, disapproved: 3, executed: 4 });
export const EVENT_KINDS = Object.freeze(Object.keys(EVENT_RANK));

// Position of a chain event: block first, then its index inside the block.
// A motion proposed and an identical one closed in the SAME block are ordered
// by event index. Unknown index sorts first within its block for events and
// last for proposals, which errs toward attributing an event to the older
// motion — the only one that could have been open before that block.
const posOf = (block, idx, unknownIdx) =>
    [Number(block), Number.isFinite(Number(idx)) && idx !== null && idx !== undefined ? Number(idx) : unknownIdx];
const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);

/**
 * motions: [{ motionIndex, hash, proposedBlock, proposedEventIndex, leftStorageAt, liveAyes, liveNays, ... }]
 * events:  [{ hash, block, eventIndex, kind, ayes, nays, at }]
 * Returns new motion objects with status / ayes / nays / resolvedBlock / resolvedAt filled in.
 * Motions with an unknown proposedBlock sort after every known one.
 */
export function attributeMotionEvents(motions, events) {
    const byHash = new Map();
    for (const m of motions) {
        if (!byHash.has(m.hash)) byHash.set(m.hash, []);
        byHash.get(m.hash).push(m);
    }
    for (const list of byHash.values()) {
        list.sort((a, b) => {
            const ka = a.proposedBlock == null ? Infinity : Number(a.proposedBlock);
            const kb = b.proposedBlock == null ? Infinity : Number(b.proposedBlock);
            if (ka !== kb) return ka - kb;
            const ia = a.proposedEventIndex == null ? Infinity : Number(a.proposedEventIndex);
            const ib = b.proposedEventIndex == null ? Infinity : Number(b.proposedEventIndex);
            if (ia !== ib) return ia - ib;
            return Number(a.motionIndex) - Number(b.motionIndex);
        });
    }

    const assigned = new Map();   // motion object -> events[]
    for (const ev of events) {
        if (!EVENT_KINDS.includes(ev.kind)) continue;
        const list = byHash.get(ev.hash);
        if (!list || !list.length) continue;           // e.g. MemberExecuted: no motion, by design
        const evPos = posOf(ev.block, ev.eventIndex, -1);
        let owner = null;
        for (const m of list) {
            if (m.proposedBlock == null) continue;
            if (before(posOf(m.proposedBlock, m.proposedEventIndex, Infinity), evPos)) owner = m;
            else break;
        }
        // The only motion with this hash has no known proposal block yet (the
        // crawler has not reached it): it is still the only candidate.
        if (!owner && list.length === 1) owner = list[0];
        if (!owner) continue;
        if (!assigned.has(owner)) assigned.set(owner, []);
        assigned.get(owner).push(ev);
    }

    return motions.map(m => {
        const evs = assigned.get(m) || [];
        const out = { ...m };
        if (evs.length) {
            let top = evs[0];
            for (const e of evs) if ((EVENT_RANK[e.kind] || 0) > (EVENT_RANK[top.kind] || 0)) top = e;
            const closed = evs.find(e => e.kind === 'closed');
            const resolver = closed || evs.reduce((a, b) => (Number(b.block) > Number(a.block) ? b : a));
            // The tally lives on Closed; rows migrated from the old table carry
            // it on whatever single event they became.
            const tallyEv = closed || evs.find(e => e.ayes != null || e.nays != null) || null;
            out.status = top.kind;
            out.ayes = tallyEv ? (tallyEv.ayes ?? null) : null;
            out.nays = tallyEv ? (tallyEv.nays ?? null) : null;
            out.resolvedBlock = Number(resolver.block);
            out.resolvedAt = resolver.at ?? null;
        } else {
            out.status = m.leftStorageAt ? 'resolved' : 'proposed';
            out.ayes = m.liveAyes ?? null;
            out.nays = m.liveNays ?? null;
            out.resolvedBlock = null;
            out.resolvedAt = null;
        }
        delete out.liveAyes; delete out.liveNays; delete out.leftStorageAt; delete out.proposedEventIndex;
        return out;
    });
}

// ─── locator ────────────────────────────────────────────────────────────────
// Find blocks without scanning them. Both searches are bisections over chain
// STATE at historical heights (needs an archive node), and both verify their
// own bracket before trusting it, so a wrong hint costs a few extra queries,
// never a wrong answer.

/**
 * The block in which motion `index` was proposed: the first block b with
 * proposalCount(b) >= index + 1. countAt(b) -> Promise<number|null> is the
 * collective's ProposalCount at the END of block b.
 * lo/hi are optional hints (e.g. the proposal blocks of the neighbouring
 * indices); they are checked and widened to [0, head] when they do not
 * bracket the answer.
 */
export async function findProposalBlock({ index, countAt, head, lo = null, hi = null }) {
    const target = index + 1;
    const okLo = async (b) => { const c = await countAt(b); return c !== null && c < target; };
    const okHi = async (b) => { const c = await countAt(b); return c !== null && c >= target; };
    let L = (lo !== null && lo >= 0 && lo < head && await okLo(lo)) ? lo : 0;
    let H = (hi !== null && hi > L && hi <= head && await okHi(hi)) ? hi : head;
    if (H === head && !(await okHi(head))) return null;   // not proposed yet (or node lying)
    if (L === 0 && !(await okLo(0))) return 0;            // proposed in genesis state (never, but be total)
    let probes = 0;
    while (H - L > 1) {
        if (++probes > 64) return null;
        const mid = Math.floor((L + H) / 2);
        const c = await countAt(mid);
        if (c === null) return null;
        if (c >= target) H = mid; else L = mid;
    }
    return H;
}

/**
 * The block in which a motion left storage (closed, approved/disapproved, or
 * otherwise removed): the first block b > proposedBlock where isOpenAt(b) is
 * false. isOpenAt(b) -> Promise<boolean|null> checks the collective's Voting
 * entry for the hash. `until` must be a block where the motion is known to be
 * gone: head, or one block before the next proposal of the same hash.
 */
export async function findCloseBlock({ proposedBlock, isOpenAt, until }) {
    let L = proposedBlock;
    let H = until;
    if (H <= L) return null;
    const atProposal = await isOpenAt(L);
    if (atProposal === null) return null;
    // Proposed and resolved in the same block: the resolving events are in the
    // proposal block itself.
    if (atProposal === false) return L;
    if ((await isOpenAt(H)) !== false) return null;       // still open (or unknown): nothing to find yet
    let probes = 0;
    while (H - L > 1) {
        if (++probes > 64) return null;
        const mid = Math.floor((L + H) / 2);
        const open = await isOpenAt(mid);
        if (open === null) return null;
        if (open) L = mid; else H = mid;
    }
    return H;
}

// Which indices are missing from what we store, given the chain's count.
export function missingIndices(known, proposalCount) {
    const have = new Set(known.map(Number));
    const out = [];
    for (let i = 0; i < proposalCount; i++) if (!have.has(i)) out.push(i);
    return out;
}

// Nearest known neighbours of `index`, used as bisection hints.
export function neighbourHints(index, knownRows) {
    let lo = null, hi = null, loIdx = -1, hiIdx = Infinity;
    for (const r of knownRows) {
        const i = Number(r.motionIndex), b = r.proposedBlock;
        if (b == null) continue;
        if (i < index && i > loIdx) { loIdx = i; lo = Number(b); }
        if (i > index && i < hiIdx) { hiIdx = i; hi = Number(b); }
    }
    return { lo, hi };
}
