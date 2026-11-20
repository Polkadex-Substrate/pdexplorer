// Healing of names that were stored without a name because the identity read failed.
//
// The rule (lib/identity-cache.js, resolveForStore): a name from a failed read is never
// persisted. A block author, an event signer or a forum author that could not be read is
// stored as NULL (which every reader shows as "Unknown" meanwhile), the address is noted
// here, and this pass fills the rows in once a read works. Rows named by the read are
// never touched (the UPDATEs only match NULL), and a confirmed "no identity" is written as
// 'Unknown', a fact, not a gap. Rows that already hold the literal 'Unknown' from before
// this rule are not healed.
//
// The pending list is one kv row { address: { from, to, at } } (the block range in which
// names were left empty, and when it was last noted), capped, so it survives a restart and
// costs nothing when empty. Blocks and events are healed together by BLOCK WINDOW: blocks by
// primary-key range, events by idx_events_block (always present; the optional
// idx_events_signer_block is never needed). Each statement covers at most one window and a
// pass at most HEAL_MAX_WINDOWS_PER_PASS windows, so a pass never holds a long write lock on
// the large tables. Forum posts are few: their gap is found by query.
//
// Concurrency: the pass awaits identity reads while the block scanner keeps noting addresses.
// The pass therefore never writes back the copy it read: after each address it re-reads the
// row and removes or shrinks that one entry, and only if the entry is unchanged since the pass
// read it (otherwise the next pass heals the new range). A read-modify-write with no await in
// it cannot interleave with another in the same process, and only the indexer worker writes.
//
// The scanner notes an address BEFORE the block and its events are inserted, so an entry noted
// within HEAL_GRACE_MS is healed but kept, not dropped on a pass that found no rows yet.
//
// Pure of the server: db and the resolver are passed in.

export const HEAL_KEY = 'identity-heal:pending';
export const HEAL_MAX_ADDRESSES = 500;
export const HEAL_WINDOW_BLOCKS = 1000;
export const HEAL_MAX_WINDOWS_PER_ADDRESS = 20;
export const HEAL_MAX_WINDOWS_PER_PASS = 200;
export const HEAL_GRACE_MS = 10 * 60 * 1000;
export const HEAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;          // stub for the red commit
export const HEAL_ERROR_WARN_INTERVAL_MS = 10 * 60 * 1000;   // stub
export function _resetHealStateForTests() {}                 // stub
export const HEAL_DROP_WARN_INTERVAL_MS = 10 * 60 * 1000;
// A refresh of `at` alone is written at most this often, so notes in one block do not rewrite the row.
const AT_REFRESH_MS = 60 * 1000;

let dropped = 0;
let lastDropWarnAt = -Infinity;

const sameEntry = (a, b) => !!a && !!b && a.from === b.from && a.to === b.to && (a.at ?? null) === (b.at ?? null);

// Called by the block scanner for an author or signer whose name could not be read.
// Never throws: a failure here must not break the block scan.
export function noteUnnamed(db, address, block, { now = Date.now, warn = console.warn } = {}) {
    try {
        if (!address || address === 'System') return;
        if (typeof block !== 'number' && typeof block !== 'bigint') return;
        const n = Number(block);
        if (!Number.isSafeInteger(n) || n < 0) return;
        const pending = db.getKv(HEAL_KEY) || {};
        const cur = pending[address];
        const t = now();
        if (!cur) {
            if (Object.keys(pending).length >= HEAL_MAX_ADDRESSES) {
                dropped++;
                if (t - lastDropWarnAt >= HEAL_DROP_WARN_INTERVAL_MS) {
                    warn(`[identity-heal] pending list is full (${HEAL_MAX_ADDRESSES} addresses): ${dropped} more address(es) not noted; their names stay Unknown`);
                    dropped = 0;
                    lastDropWarnAt = t;
                }
                return;
            }
            pending[address] = { from: n, to: n, at: t };
        } else {
            const from = Math.min(cur.from, n), to = Math.max(cur.to, n);
            const atOld = Number.isFinite(cur.at) ? cur.at : -Infinity;
            if (from === cur.from && to === cur.to && t - atOld < AT_REFRESH_MS) return;   // nothing changed
            pending[address] = { from, to, at: t };
        }
        db.setKv(HEAL_KEY, pending);
    } catch (e) {
        try { warn('[identity-heal] could not note an unnamed address:', e && e.message ? e.message : e); } catch (_) { /* never */ }
    }
}

// Remove or shrink one entry, only if it is unchanged since `seen` was read. No await inside.
function settleEntry(db, address, seen, next) {
    const cur = db.getKv(HEAL_KEY) || {};
    if (!sameEntry(cur[address], seen)) return;
    if (next) cur[address] = next; else delete cur[address];
    db.setKv(HEAL_KEY, cur);
}

// resolve(address) -> { name, status } as identityResolver.resolve answers. A failed or stale read
// writes nothing and the address stays pending. Returns { healed, pending } (rows, addresses left).
export async function healUnnamedNames({ db, resolve, maxAddresses = 50, maxWindows = HEAL_MAX_WINDOWS_PER_PASS, now = Date.now }) {
    let healed = 0;
    let windows = 0;
    const snapshot = db.getKv(HEAL_KEY) || {};
    let done = 0;
    for (const address of Object.keys(snapshot)) {
        if (done >= maxAddresses || windows >= maxWindows) break;
        done++;
        const seen = snapshot[address];
        try {
            if (!seen || !Number.isFinite(seen.from) || !Number.isFinite(seen.to)) { settleEntry(db, address, seen, null); continue; }
            const res = await resolve(address);
            if (!res || res.status === 'failed' || res.status === 'stale') continue;
            const top = typeof db.getMaxBlockNumber === 'function' ? db.getMaxBlockNumber() : null;
            const end = Number.isFinite(top) ? Math.min(seen.to, top) : seen.to;
            let lo = seen.from;
            for (let w = 0; lo <= end && w < HEAL_MAX_WINDOWS_PER_ADDRESS && windows < maxWindows; w++, windows++) {
                const hi = Math.min(end, lo + HEAL_WINDOW_BLOCKS - 1);
                healed += db.healBlockAuthorNames(address, res.name, lo, hi);
                healed += db.healEventSignerNames(address, res.name, lo, hi);
                lo = hi + 1;
            }
            if (lo <= end) { settleEntry(db, address, seen, { ...seen, from: lo }); continue; }
            const at = Number.isFinite(seen.at) ? seen.at : -Infinity;
            // Healed to the end; dropped once nothing can still be inserted for it.
            if (now() - at > HEAL_GRACE_MS) settleEntry(db, address, seen, null);
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
    return { healed, pending: Object.keys(db.getKv(HEAL_KEY) || {}).length };
}
