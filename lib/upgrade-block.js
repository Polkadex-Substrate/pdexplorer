// Finds the block that enacted a runtime upgrade, by binary search over
// "spec version in the state after block n". No imports: the caller passes
// specAt(n), so test/upgrade-block.test.js drives it with a fake chain and
// scripts/find-upgrade-block.mjs drives it with plain JSON-RPC.
//
// State after block U is the first to carry the new spec: U is the block in
// which set_code ran (system.CodeUpdated). Block U itself was built and is
// decoded with the OLD runtime; U + 1 is the first block of the new one
// (@polkadot/api reads a block's runtime from its parent's state).

export async function findUpgradeBlock({ specAt, head, target }) {
    if (!Number.isInteger(head) || head < 0) throw new Error('head must be a non-negative integer');
    if (!Number.isInteger(target) || target <= 0) throw new Error('target spec must be a positive integer');
    const atHead = await specAt(head);
    if (atHead < target) return { upgraded: false, headSpec: atHead };
    const atZero = await specAt(0);
    if (atZero >= target) return { upgraded: true, fromGenesis: true, block: 0, firstNewBlock: 0, headSpec: atHead, previousSpec: null };
    // Invariant: specAt(lo) < target <= specAt(hi).
    let lo = 0, hi = head, steps = 0;
    while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if ((await specAt(mid)) >= target) hi = mid; else lo = mid;
        if (++steps > 64) throw new Error('binary search did not converge');
    }
    return { upgraded: true, fromGenesis: false, block: hi, firstNewBlock: hi + 1, headSpec: atHead, previousSpec: await specAt(lo) };
}

// The block range a dev instance should index so it covers both sides of the
// upgrade: `margin` blocks before U to `margin` after, clamped to the chain.
export function proofWindow(result, head, margin = 1000) {
    if (!result || !result.upgraded) return null;
    const from = Math.max(1, result.block - margin);
    const to = Math.min(head, result.block + margin);
    return { from, to, blocks: to - from + 1 };
}
