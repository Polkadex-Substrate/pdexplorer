// Extrinsic format bookkeeping for scripts/fetch-metadata.mjs. No imports, so
// the script and the tests load it the same way.
//
// An encoded extrinsic is a compact length prefix followed by a version byte:
// bit 7 set = signed, bit 6 set = general (v5), low 6 bits = format version.
// So 0x04 is a bare v4, 0x84 a signed v4, 0x05 a bare v5 and 0x45 a general
// v5. (There is no signed v5: from v5 on, signed transactions are v4 and the
// new shape is "general".)

function hexToByteAt(hex, at) {
    return parseInt(hex.slice(2 + 2 * at, 4 + 2 * at), 16);
}

// Reads the byte offset after the compact length prefix.
export function versionByteOf(hex) {
    const mode = hexToByteAt(hex, 0) & 3;
    const offset = mode === 0 ? 1 : mode === 1 ? 2 : mode === 2 ? 4 : (hexToByteAt(hex, 0) >> 2) + 5;
    return hexToByteAt(hex, offset);
}

// { version, kind: 'bare' | 'signed' | 'general', byte }
export function classifyExtrinsic(hex) {
    const byte = versionByteOf(hex);
    const flags = byte & 0xc0;
    const kind = flags === 0x80 ? 'signed' : flags === 0x40 ? 'general' : 'bare';
    return { version: byte & 0x3f, kind, byte };
}

// The fixture sample label for an extrinsic, or null when it is not sampled.
// 'v5-bare' (0x05) is what every 392 block carries as an inherent, so it must
// be kept: Polkadex emits no General (0x45) extrinsic at all.
export function sampleLabel({ version, kind }) {
    if (version === 4 && kind === 'signed') return 'v4-signed';
    if (version === 5 && kind === 'general') return 'v5-general';
    if (version === 5 && kind === 'bare') return 'v5-bare';
    return null;
}

export function newFormatTally() {
    return {};
}

// seenFormats shape: { "4": { total, bare, signed, general }, "5": {...} }
export function tallyExtrinsic(tally, hex) {
    const { version, kind } = classifyExtrinsic(hex);
    const entry = tally[version] || (tally[version] = { total: 0, bare: 0, signed: 0, general: 0 });
    entry.total += 1;
    entry[kind] += 1;
    return { version, kind };
}

// Returns null when the sampled range contains at least one v5 extrinsic
// (bare or general), else the failure message. `ctx` = { blocks, spec, widen }.
export function v5MissingMessage(tally, ctx) {
    if (tally[5] && tally[5].total > 0) return null;
    return `no v5 extrinsic (0x05 bare or 0x45 general) found in the ${ctx.blocks} block(s) sampled on spec ${ctx.spec}. `
        + `seenFormats=${JSON.stringify(tally)}. The fixture was NOT written, because without a v5 sample the v5 checks in npm test would skip silently. `
        + `Widen the range with --blocks <N> (now ${ctx.widen}), or point --testnet at a node whose recent blocks carry general extrinsics.`;
}
