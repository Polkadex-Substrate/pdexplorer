// Which stored blocks might belong to a discarded fork, and when do we check?
//
// Audit F-007. `blocks.number` is the primary key and the forward pass never
// revisits a height it has already written, so the indexer follows the BEST
// head (`getHeader()`) and then treats whatever it saw first as permanent. A
// short reorg — routine on any BABE chain — leaves the orphan block, its
// events, its transactions and its reward rows in SQLite forever, presented to
// visitors as canonical. The one place that half-knew this was the tx-detail
// lookup, which does a ±2 neighbour search "in case of reorgs" while the
// tables underneath it keep the fork.
//
// The repair strategy is built on the one hard guarantee the chain gives us:
// a GRANDPA-FINALIZED hash can never change. So:
//
//   FINALITY SWEEP — a kv watermark (`reorg:verified`) records the highest
//   height whose stored hash has been compared against its FINALIZED hash.
//   Each tick sweeps (verified, finalizedHead], repairs mismatches, advances
//   the watermark. Every height therefore gets exactly one guaranteed check
//   against its immutable hash, no matter how the ticks interleave with
//   finalization. Steady state this is 1–2 heights per tick.
//
//   TAIL CHECK — heights in (finalizedHead, bestHead] are not final and can
//   still change, so they are re-checked EVERY tick without moving the
//   watermark. This is what shrinks the window during which a visitor can be
//   looking at an orphan; the sweep alone would still catch it, just up to a
//   finalization lag later.
//
// First run adopts `verified = finalizedHead` and sweeps nothing: verifying
// history would be one RPC call per stored block (12.8M of them), and any
// orphan that old is a display artefact, not a live hazard. The tail check
// still runs from the first tick, so protection going forward is immediate.
//
// This module is the pure arithmetic — ranges and hash comparison — because
// the off-by-ones here decide whether a height is checked twice, once, or
// never, and "never" is silent data corruption.

function num(value) {
    if (value === null || value === undefined || value === '') return NaN;
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
}

// Do a stored hash and a canonical hash disagree in a way that demands repair?
//
// Deliberately conservative about unknowns: a missing/empty stored hash is a
// legacy row, not evidence of a fork, and a missing/zero canonical hash means
// the RPC could not answer — repairing on either would delete real data on
// bad information.
const ZERO_HASH = /^0x0+$/;
export function hashesDiffer(stored, canonical) {
    const a = stored == null ? '' : String(stored).trim().toLowerCase();
    const b = canonical == null ? '' : String(canonical).trim().toLowerCase();
    if (!a || !b) return false;
    if (ZERO_HASH.test(a) || ZERO_HASH.test(b)) return false;
    return a !== b;
}

// Plan the two ranges for this tick.
//
//   verified        — kv watermark, or null/undefined on first run
//   finalizedNumber — height of the GRANDPA-finalized head
//   head            — height of the best head
//   sweepMax        — cap on finality-sweep heights per tick (a node that was
//                     down for a day has thousands of newly-final heights; we
//                     catch up over several ticks rather than stall one)
//   tailMax         — cap on the unfinalized tail (defensive; normally 2–5)
//
// Returns { firstRun, adopt, sweepFrom, sweepTo, tailFrom, tailTo }.
// Ranges are inclusive; from > to means "nothing to do". `adopt` is the
// watermark to store on first run.
export function planReorgSweep({ verified, finalizedNumber, head, sweepMax = 200, tailMax = 64 } = {}) {
    const fin = num(finalizedNumber);
    const best = num(head);
    const none = { sweepFrom: 1, sweepTo: 0, tailFrom: 1, tailTo: 0 };

    // Without a trustworthy finalized height there is nothing safe to do:
    // sweeping against a guess could "verify" heights against a hash that was
    // never final.
    if (!Number.isFinite(fin) || fin < 0) {
        return { firstRun: false, adopt: null, ...none };
    }

    const v = num(verified);
    if (!Number.isFinite(v)) {
        // First run: adopt, sweep nothing, but DO check the live tail.
        return {
            firstRun: true,
            adopt: fin,
            sweepFrom: 1,
            sweepTo: 0,
            tailFrom: fin + 1,
            tailTo: Number.isFinite(best) ? Math.min(best, fin + Math.max(0, num(tailMax) || 0)) : 0
        };
    }

    // The sweep never runs ahead of finality and never re-does verified
    // heights. Cap per tick; the watermark advancing only to sweepTo makes the
    // remainder next tick's work rather than lost work.
    const sweepFrom = v + 1;
    const sweepTo = Math.min(fin, v + Math.max(0, num(sweepMax) || 0));

    return {
        firstRun: false,
        adopt: null,
        sweepFrom,
        sweepTo,
        tailFrom: fin + 1,
        tailTo: Number.isFinite(best) ? Math.min(best, fin + Math.max(0, num(tailMax) || 0)) : 0
    };
}

// The heights actually worth an RPC hash lookup this tick: everything the plan
// covers that we HOLD a row for. A height we never stored can't hold an
// orphan. `storedNumbers` is the set of block numbers present in SQLite for
// the planned ranges.
export function heightsToVerify(plan, storedNumbers) {
    const out = [];
    const have = storedNumbers instanceof Set ? storedNumbers : new Set(storedNumbers || []);
    const push = (from, to) => {
        for (let n = from; n <= to; n++) if (have.has(n)) out.push(n);
    };
    if (plan) {
        push(plan.sweepFrom, plan.sweepTo);
        // The tail may overlap a sweep that just caught up to finality;
        // dedupe so a height is not fetched twice in one tick.
        for (let n = plan.tailFrom; n <= plan.tailTo; n++) {
            if (have.has(n) && (n < plan.sweepFrom || n > plan.sweepTo)) out.push(n);
        }
    }
    return out;
}
