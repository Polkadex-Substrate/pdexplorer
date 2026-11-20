// The walk-back loop of scripts/fetch-metadata.mjs: from a block, read parent after parent and collect
// real extrinsics of the SAME runtime, tallying every extrinsic's format. Pure of the network: the
// caller passes `call(method, params)` (JSON-RPC), so tests drive it with a fake.
//
//   - state pruned after at least one block: the scan stops there and keeps what it has
//   - state pruned on the first block, or any other error at any point: thrown
//   - a different spec version ends the scan; that block is not counted
//   - at most maxWalk blocks, never below block 1
//   - a block counts whole or not at all: its runtime version is read BEFORE its extrinsics are tallied
//   - a v5 runtime (spec 392 or later) scans the whole window so seenFormats counts every extrinsic;
//     an older one stops as soon as `samples` signed extrinsics are in

import { newFormatTally, tallyExtrinsic, sampleLabel } from './extrinsic-formats.js';
import { isStateUnavailableError } from './fetch-guards.js';

export async function walkBackSamples({ call, blockHash, blockNumber, specVersion, maxWalk, samples, log = () => {} }) {
    const wantV5 = specVersion >= 392;
    const extrinsics = [];
    const have = { 'v4-signed': 0, 'v5-general': 0, 'v5-bare': 0 };
    const seenFormats = newFormatTally();
    let hash = blockHash, n = blockNumber, walked = 0, stoppedAtPrunedState = false;
    while (walked < maxWalk && n > 0) {
        if (!wantV5 && have['v4-signed'] >= samples) break;
        const blk = await call('chain_getBlock', [hash]);
        let v;
        try {
            v = (await call('state_getRuntimeVersion', [hash])).specVersion;
        } catch (e) {
            // A pruned node keeps only recent state: end the scan here, keep what is in hand.
            if (walked > 0 && isStateUnavailableError(e)) {
                log(`  state is pruned beyond ${walked} blocks on this node; scan stopped there`);
                stoppedAtPrunedState = true;
                break;
            }
            throw e;
        }
        if (v !== specVersion) break;
        blk.block.extrinsics.forEach((hex, index) => {
            const { version, kind } = tallyExtrinsic(seenFormats, hex);
            const label = sampleLabel({ version, kind });
            if (label && have[label] < samples) {
                have[label] += 1;
                extrinsics.push({ block: n, blockHash: hash, index, specVersion: v, format: label, hex });
            }
        });
        hash = blk.block.header.parentHash;
        n -= 1;
        walked += 1;
    }
    return { extrinsics, have, seenFormats, walked, stoppedAtPrunedState };
}
