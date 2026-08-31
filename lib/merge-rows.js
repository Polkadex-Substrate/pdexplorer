// Fold a REST snapshot into a locally-held list without throwing away rows the
// snapshot has not caught up to.
//
// Audit F-017. The home feed and /transactions hold arrays that two sources
// write into: the browser's own WebSocket subscription `unshift`es freshly
// imported heads onto the front, and "Load Older 100" appends paged history to
// the back. Every 12 seconds the REST poll then did
//
//     transactions = financialTransactionRows(data.transactions);
//     fullBlocks   = data.blocks;
//
// — a plain assignment. Both extras were wiped. In practice that meant a user's
// transaction appeared the moment it was included and then vanished on the next
// tick because the indexer was a few blocks behind, and paged-in history snapped
// back to the hot cache. "My transfer disappeared from the explorer" is a
// frightening thing to see right after signing one, and the transfer was fine
// every time.
//
// Merge rules, in order:
//   1. An empty or missing snapshot changes NOTHING. A failed fetch that
//      returned `{}` used to blank the table (this is also F-068's shape).
//   2. Where both sides hold a row, the SNAPSHOT wins. Server rows carry the
//      real timestamp, author and event count; the WS-built rows fill some of
//      those with placeholders (F-064), so the server copy is the better one.
//   3. A local row the snapshot lacks survives only if it sits OUTSIDE the
//      snapshot's FULLY-COVERED range. A local row missing from the middle of
//      that range is genuinely gone — dropped by a reorg or a filter change —
//      and keeping it would be inventing data.
//
//      The boundary ranks are NOT fully covered, which is why the comparisons
//      below are `>=` and `<=` rather than `>` and `<`. Many transactions
//      share a block, and `/api/transactions` is `ORDER BY block DESC …
//      LIMIT n`, so the page can cut through the middle of a block: the
//      snapshot holds some of that block's rows and not others. With strict
//      comparisons every locally-held row in the boundary block was discarded
//      on each 12s poll — a row vanishing from the middle of the user's view,
//      which is precisely the bug this module exists to prevent.
//
//      The cost is that a row reorged out of exactly the boundary block
//      lingers until the boundary moves. Showing one stale row briefly is a
//      far better failure than deleting real ones every 12 seconds. Block rows
//      are unaffected either way, since their key IS the height, so a
//      replacement at the same height collides under rule 2.
//   4. Sort by rank descending, then apply the cap, so the array cannot grow
//      without bound as WS rows accumulate.

// Audit F-186 (round 2). `keyOf` alone cannot de-duplicate across these two
// sources, because they name the same transfer differently:
//
//   live WS row   hash = ex.hash.toHex()              (the EXTRINSIC hash)
//   indexer row   hash = event-<blockHash>-<index>    (the EVENT coordinates)
//
// So rule 2 never fired between them and rule 3 then dropped the live row as
// "reorged out" whenever its block sat inside the snapshot span — or, when it
// did not, showed the user the same transfer twice. The round-1 close test
// missed it by using the same `0xMINE` key on both sides of the merge, so the
// two key SCHEMES were never actually exercised against each other.
//
// `identityOf` is the fix: an optional second function returning what the row
// IS rather than what it is called. Two rows with the same identity are the
// same transfer whatever their ids say, and the snapshot's version wins.
export function mergeRows({ local, snapshot, keyOf, rankOf, cap, identityOf = null }) {
    const snap = Array.isArray(snapshot) ? snapshot : [];
    const mine = Array.isArray(local) ? local : [];

    // Rule 1 — never let a failed or empty poll blank the view.
    if (snap.length === 0) return cap ? mine.slice(0, cap) : mine.slice();

    const snapKeys = new Set(snap.map(keyOf));
    const ranks = snap.map(rankOf).filter(n => Number.isFinite(n));
    // A snapshot with no usable ranks gives us nothing to compare against;
    // fall back to the snapshot alone rather than guessing.
    if (ranks.length === 0) return cap ? snap.slice(0, cap) : snap.slice();

    const newest = Math.max(...ranks);
    const oldest = Math.min(...ranks);

    // F-186: identities present in the snapshot, so a local row describing the
    // same transfer under a different id scheme is recognised as a duplicate
    // rather than kept alongside it or discarded as a reorg.
    const snapIdentities = identityOf
        ? new Set(snap.map(identityOf).filter(v => v != null))
        : null;

    const kept = mine.filter(row => {
        if (snapKeys.has(keyOf(row))) return false;                     // rule 2 (same id)
        if (snapIdentities) {
            const id = identityOf(row);
            if (id != null && snapIdentities.has(id)) return false;     // rule 2b (same thing)
        }
        const rank = rankOf(row);
        if (!Number.isFinite(rank)) return false;
        return rank >= newest || rank <= oldest;      // rule 3 (boundary inclusive)
    });

    // Rule 4, with unconfirmed rows pinned above confirmed ones at the same
    // rank. A live row and its indexed twin share a block height, so a plain
    // rank sort leaves their relative order to Array.prototype.sort — the row
    // the user just watched arrive could jump below older ones on every poll.
    const merged = snap.concat(kept).sort((a, b) => {
        const d = rankOf(b) - rankOf(a);
        if (d !== 0) return d;
        return (b.unconfirmed ? 1 : 0) - (a.unconfirmed ? 1 : 0);
    });
    return cap ? merged.slice(0, cap) : merged;
}

// Cross-source identity for a transfer (F-186).
//
// A transfer is identified by WHAT IT DID — which block, from whom, to whom,
// how much — not by whichever id the source that saw it happens to mint. Both
// sides carry all four fields, so this matches across the extrinsic-hash and
// event-id schemes.
//
// Returns null when any component is missing, and a null identity never
// matches: an incomplete row must not silently collapse into an unrelated one.
export function txIdentity(row) {
    if (!row) return null;
    const block = numericOrNaN(row.block);
    if (!Number.isFinite(block)) return null;
    const from = row.from == null ? '' : String(row.from);
    const to = row.to == null ? '' : String(row.to);
    const amount = row.amount == null ? '' : String(row.amount);
    if (!from || !to || !amount) return null;
    return `${block}|${from}|${to}|${amount}`;
}

// Rank helpers. Block height is the correct ordering key when present — it is
// monotonic and agreed on by both sources — and wall-clock timestamps are the
// fallback, since WS rows stamp Date.now() locally rather than reading the
// block's own timestamp.
// NOTE the explicit `!row` guards. `Number(row && row.number)` looks
// equivalent and is not: for a null row the `&&` short-circuits to `null` and
// `Number(null)` is 0 — a finite rank. A null row would then read as block 0,
// i.e. "older than the snapshot's oldest", and be kept forever at the bottom of
// the list. Caught by test/merge-rows.test.js, not by inspection.
// Number('') is 0 too, and 0 is a legitimate block height (genesis), so an
// empty value can't be filtered out downstream — reject it here.
function numericOrNaN(value) {
    if (value === null || value === undefined || value === '') return NaN;
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
}

export function blockRank(row) {
    if (!row) return NaN;
    return numericOrNaN(row.number);
}

export function txRank(row) {
    if (!row) return NaN;
    const block = numericOrNaN(row.block);
    if (Number.isFinite(block)) return block;
    return numericOrNaN(row.timestamp);
}
