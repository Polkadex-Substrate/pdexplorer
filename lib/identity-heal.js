// Healing of names that were stored without a name because the identity read failed.
//
// The rule (lib/identity-cache.js, resolveForStore): a name from a failed read is never
// persisted. A block author, an event signer or a forum author that could not be read is
// stored as NULL (which every reader shows as "Unknown" meanwhile), the address is noted
// here, and this pass fills the rows in once a read works. Rows named by the read are
// never touched (the UPDATEs only match NULL), and a confirmed "no identity" is written as
// 'Unknown', a fact, not a gap.
//
// The pending list is one kv row { address: { from, to } } (the block range in which names
// were left empty), capped, so it survives a restart and costs nothing when empty. Blocks
// are healed by primary-key range and events through the signer index, in bounded chunks;
// the large tables are never scanned. Forum posts are few: their gap is found by query.
//
// Pure of the server: db and the resolver are passed in.

export const HEAL_KEY = 'identity-heal:pending';
export const HEAL_MAX_ADDRESSES = 500;
const BLOCK_CHUNK = 5000;
const EVENT_CHUNK = 1000;
const MAX_CHUNKS_PER_ADDRESS = 20;

// Called by the block scanner for an author or signer whose name could not be read.
// The kv read-modify-write has no await in it, so scans in one process cannot interleave.
export function noteUnnamed(db, address, block) {
    if (!address || address === 'System') return;
    const n = Number(block);
    const pending = db.getKv(HEAL_KEY) || {};
    const cur = pending[address];
    if (!cur && Object.keys(pending).length >= HEAL_MAX_ADDRESSES) return;   // bounded; the rest stay Unknown
    pending[address] = Number.isFinite(n)
        ? { from: cur ? Math.min(cur.from, n) : n, to: cur ? Math.max(cur.to, n) : n }
        : (cur || { from: 0, to: Number.MAX_SAFE_INTEGER });
    db.setKv(HEAL_KEY, pending);
}

// resolve(address) -> { name, status } as identityResolver.resolve answers. A failed or stale read
// writes nothing and the address stays pending. Returns { healed, pending } (rows, addresses left).
export async function healUnnamedNames({ db, resolve, maxAddresses = 50 }) {
    let healed = 0;
    const pending = db.getKv(HEAL_KEY) || {};
    let done = 0;
    for (const address of Object.keys(pending)) {
        if (done >= maxAddresses) break;
        done++;
        try {
            const res = await resolve(address);
            if (!res || res.status === 'failed' || res.status === 'stale') continue;
            const { from, to } = pending[address];
            let complete = true;
            for (let lo = from, chunks = 0; lo <= to; lo += BLOCK_CHUNK, chunks++) {
                if (chunks >= MAX_CHUNKS_PER_ADDRESS) { complete = false; pending[address] = { from: lo, to }; break; }
                healed += db.healBlockAuthorNames(address, res.name, lo, Math.min(to, lo + BLOCK_CHUNK - 1));
            }
            if (complete) {
                for (let i = 0; i < MAX_CHUNKS_PER_ADDRESS; i++) {
                    const n = db.healEventSignerNames(address, res.name, from, to, EVENT_CHUNK);
                    healed += n;
                    if (n < EVENT_CHUNK) break;
                    if (i === MAX_CHUNKS_PER_ADDRESS - 1) complete = false;
                }
            }
            if (complete) delete pending[address];
        } catch (e) { /* this one stays pending for the next pass */ }
    }
    // Forum authors: a small table, found by query.
    try {
        for (const address of db.getUnnamedDiscussionAuthors(20)) {
            const res = await resolve(address);
            if (!res || res.status === 'failed' || res.status === 'stale') continue;
            healed += db.healDiscussionAuthorNames(address, res.name);
        }
    } catch (e) { /* next pass */ }
    if (Object.keys(pending).length) db.setKv(HEAL_KEY, pending); else if (db.getKv(HEAL_KEY)) db.setKv(HEAL_KEY, {});
    return { healed, pending: Object.keys(pending).length };
}
