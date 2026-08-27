// Which balances calls move money, and which argument holds the amount?
//
// Audit F-045. This table existed twice — `getExtrinsicAmountSummary` in
// server.js and `getLiveExtrinsicAmountSummary` in script.js — as two hand-kept
// copies of the same if/else chain. They were identical except for which
// planck→PDEX converter they called, which is exactly the kind of near-identity
// that stops being identical without anyone noticing.
//
// The cost of the drift is specific: the two functions feed the SAME list. The
// server's version renders rows from the indexer; the client's renders rows
// arriving over the WebSocket. If a runtime upgrade adds a transfer variant and
// only one table learns about it, the same transfer shows an amount when it
// arrives live and "-" after a refresh — or the reverse. A reader would
// conclude the explorer had lost the amount, not that two lists disagreed.
//
// So the SHAPE lives here and the CONVERSION is injected. That split is the
// point: server.js and script.js legitimately need different converters
// (`formatPDEX` reads a chain codec, `formatLivePDEX` reads a live BigInt), and
// pretending otherwise is what would push someone to copy the function again.

// Transfer-shaped calls in pallet_balances, and where their arguments sit.
//
//   destIndex   — which arg is the recipient
//   amountIndex — which arg is the amount, or null when the call moves
//                 everything and there is no amount argument
//   minArgs     — how many args must be present before we trust the indices;
//                 a metadata change that shortens a call should produce "-",
//                 not a crash or a misread of the wrong argument
//
// Keep this list in sync with pallet_balances. Anything absent is not a
// misrepresentation — it renders as the plain method name with amount "-",
// which is honest about what we know.
export const BALANCE_TRANSFER_CALLS = {
    transfer:            { destIndex: 0, amountIndex: 1, minArgs: 2 },
    transferAllowDeath:  { destIndex: 0, amountIndex: 1, minArgs: 2 },
    transferKeepAlive:   { destIndex: 0, amountIndex: 1, minArgs: 2 },
    forceTransfer:       { destIndex: 1, amountIndex: 2, minArgs: 3 },
    transferAll:         { destIndex: 0, amountIndex: null, minArgs: 1 }
};

// Format a PDEX number the way both call sites already did.
export function formatAmountLabel(numericAmount) {
    return `${Number(numericAmount).toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX`;
}

// Summarise one extrinsic.
//
//   ex        — a decoded extrinsic with `.method.section`, `.method.method`,
//               `.method.args`
//   toPdex    — (codecOrBigint) => Number, the caller's planck→PDEX converter
//   methodName— optional override for how the method is labelled; server.js
//               has getExtrinsicMethod() (which unwraps proxy/batch), the
//               client uses plain "section.method"
//
// Returns { method, to, amount, numericAmount } — the exact shape both callers
// already returned, so this is a lift, not a redesign.
export function summarizeExtrinsicAmount(ex, toPdex, methodName = null) {
    const section = ex && ex.method ? ex.method.section : '';
    const call    = ex && ex.method ? ex.method.method  : '';
    const method  = methodName != null ? methodName : `${section}.${call}`;
    const args    = (ex && ex.method && ex.method.args) || [];

    const base = { method, to: method, amount: '-', numericAmount: 0 };
    if (section !== 'balances') return base;

    const spec = BALANCE_TRANSFER_CALLS[call];
    if (!spec || args.length < spec.minArgs) return base;

    const to = args[spec.destIndex].toString();

    // transferAll: the amount is not in the call, it is whatever the account
    // holds at execution time. Saying "All" is the only truthful answer
    // available without replaying state at that block.
    if (spec.amountIndex === null) {
        return { method, to, amount: 'All', numericAmount: 0 };
    }

    const numericAmount = toPdex(args[spec.amountIndex]);
    return { method, to, amount: formatAmountLabel(numericAmount), numericAmount };
}
