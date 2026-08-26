// Turn a stored `balances.Transfer` event row into a transactions-table row.
//
// This logic used to live only inside backfill-transactions-from-events.mjs,
// the one-shot operator script. It moved here because F-008's fix makes the
// LIVE indexer do the same derivation: syncTransactions now walks a
// genesis-ward backfill cursor over the local events table, and two private
// copies of "how do you parse a toHuman() balance" is how the script and the
// indexer would eventually disagree about the same event.
//
// The id is `event-${blockHash}-${eventIndex}` — hash-keyed, matching the
// events table's own PK style (audit F-021). The previous scheme keyed on
// block NUMBER, which made a fork row and its canonical replacement collide:
// with INSERT OR IGNORE, whichever was written first won forever, and after a
// reorg that was the orphan.

const PDEX_DECIMALS = 12;
const PLANCK_PER_PDEX = 10n ** BigInt(PDEX_DECIMALS);

// SI prefixes used by @polkadot/util formatBalance, mapped to their PDEX
// multiplier. Older runtimes typed the Transfer amount as the abstract
// `Balance`, which toHuman() SI-formats ("1.5000 kPDEX"); newer metadata
// yields a comma-grouped planck integer. Both shapes are in the events table.
const SI = {
    y: 1e-24, z: 1e-21, a: 1e-18, f: 1e-15, p: 1e-12, n: 1e-9,
    µ: 1e-6, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9,
    T: 1e12, P: 1e15, E: 1e18, Z: 1e21, Y: 1e24,
};

// Convert a toHuman()-style balance scalar into a PDEX float.
// Returns null only if completely unparseable.
export function parseAmountToPdex(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s) return null;

    // Case A: pure planck integer, optionally comma-grouped — the common case.
    if (/^[\d,]+$/.test(s)) {
        let planck;
        try { planck = BigInt(s.replace(/,/g, '')); } catch { return null; }
        // Full precision through the division: whole tokens via BigInt,
        // fractional remainder as a float, then recombine.
        const whole = planck / PLANCK_PER_PDEX;
        const frac = Number(planck % PLANCK_PER_PDEX) / Number(PLANCK_PER_PDEX);
        return Number(whole) + frac;
    }

    // Case B: SI-formatted with a PDEX unit, e.g. "12.3456 PDEX", "1.5 kPDEX".
    const m = s.match(/^([\d.,]+)\s*([a-zA-Zµ]*)PDEX$/);
    if (m) {
        const num = Number(m[1].replace(/,/g, ''));
        const prefix = m[2] || '';
        const mult = SI[prefix];
        if (Number.isFinite(num) && mult != null) return num * mult;
    }

    // Case C: a bare decimal number with no unit — treat as already-in-PDEX.
    if (/^[\d.,]+$/.test(s.replace(/\s/g, ''))) {
        const num = Number(s.replace(/,/g, ''));
        if (Number.isFinite(num)) return num;
    }

    return null;
}

// Parse the events.data JSON of a balances.Transfer.
// Returns { from, to, amountPdex } or null if the row isn't a usable transfer.
export function parseTransfer(dataJson) {
    let data;
    try { data = JSON.parse(dataJson); } catch { return null; }

    let from, to, rawAmount;
    if (Array.isArray(data)) {
        if (data.length < 3) return null;
        [from, to, rawAmount] = data;
    } else if (data && typeof data === 'object') {
        from = data.from ?? data.who ?? data.source;
        to = data.to ?? data.dest ?? data.destination;
        rawAmount = data.amount ?? data.value;
    } else {
        return null;
    }
    if (from == null || to == null || rawAmount == null) return null;

    const amountPdex = parseAmountToPdex(rawAmount);
    if (amountPdex == null) return null;
    return { from: String(from), to: String(to), amountPdex };
}

// Same display string the live path produces.
export function formatAmountDisplay(amountPdex) {
    return `${amountPdex.toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX`;
}

// The hash-keyed transaction id (F-021). One function, used by the live
// writer, the indexer backfill and the operator script, so the schemes cannot
// drift apart again. A missing hash falls back to the number-keyed legacy id
// rather than minting `event-null-3` — those rows are exactly what the
// startup migration knows how to find.
export function eventTxId(blockHash, blockNumber, eventIndex) {
    const h = blockHash == null ? '' : String(blockHash).trim();
    if (h && h.startsWith('0x')) return `event-${h}-${eventIndex}`;
    return `event-${blockNumber}-${eventIndex}`;
}

// Reward-row id, same rule (F-021, staking_rewards half).
export function rewardId(blockHash, blockNumber, eventIndex) {
    const h = blockHash == null ? '' : String(blockHash).trim();
    if (h && h.startsWith('0x')) return `${h}-${eventIndex}`;
    return `${blockNumber}-${eventIndex}`;
}

// A full transactions-table row from a stored events-table row
// ({ block, eventIndex, data, timestamp, blockHash, status }).
// Returns null when the event isn't a parseable transfer.
// `normalizeAddr` is injected rather than imported: this module is shared with
// the standalone backfill script, which must not pull in @polkadot/util-crypto.
// Callers that have a normaliser pass it; the invariant F-080 asserts ("one
// account, one spelling in the table") only holds when they do.
export function buildTxRowFromEventRow(ev, normalizeAddr = null) {
    if (!ev) return null;
    const t = parseTransfer(ev.data);
    if (!t) return null;
    let from = t.from, to = t.to;
    if (typeof normalizeAddr === 'function') {
        try { from = normalizeAddr(from) || from; } catch (e) { /* keep raw */ }
        try { to = normalizeAddr(to) || to; } catch (e) { /* keep raw */ }
    }
    return {
        hash: eventTxId(ev.blockHash, ev.block, ev.eventIndex),
        from,
        to,
        block: ev.block,
        method: 'balances.Transfer',
        amount: formatAmountDisplay(t.amountPdex),
        numericAmount: t.amountPdex,
        value: '-',
        status: ev.status || 'success',
        timestamp: ev.timestamp,
        eventIndex: ev.eventIndex,
        blockHash: ev.blockHash || '',
        eventDerived: true
    };
}
