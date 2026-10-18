// Per-extrinsic decoding that survives one bad extrinsic.
//
// `api.rpc.chain.getBlock(hash)` decodes the whole Vec<Extrinsic> eagerly, so a
// single extrinsic the library cannot read (a new extrinsic format, an unknown
// extension shape) throws for the whole block, and the indexer used to lose
// every event in that block with it. This module decodes the raw extrinsics
// one at a time against the block's own registry and stands in a small,
// clearly marked stub for any that fail, so the block and its events are
// still indexed and the failure is reported, not hidden.
//
// No imports: the hash function and the address encoder are passed in.

function hexToBytes(hex) {
    const s = String(hex || '').replace(/^0x/i, '');
    if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('not hex');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function bytesToHex(u8a) {
    let s = '0x';
    for (const b of u8a) s += b.toString(16).padStart(2, '0');
    return s;
}

// SCALE compact prefix: returns [offset, length] or null when malformed.
function readCompact(u8a) {
    if (!u8a.length) return null;
    const mode = u8a[0] & 3;
    if (mode === 0) return [1, u8a[0] >> 2];
    if (mode === 1) return u8a.length >= 2 ? [2, (u8a[0] | (u8a[1] << 8)) >> 2] : null;
    if (mode === 2) return u8a.length >= 4 ? [4, ((u8a[0] | (u8a[1] << 8) | (u8a[2] << 16)) + u8a[3] * 0x1000000) / 4] : null;
    return null;
}

// Extrinsic format byte after the length prefix: 0x04 bare v4, 0x84 signed v4,
// 0x05 bare v5, 0x45 general v5.
export function extrinsicFormat(hex) {
    try {
        const u8a = hexToBytes(hex);
        const c = readCompact(u8a);
        if (!c || c[0] >= u8a.length) return null;
        const b = u8a[c[0]];
        const version = b & 0x3f;
        const kind = (b & 0xc0) === 0x80 ? 'signed' : (b & 0xc0) === 0x40 ? 'general' : (b & 0xc0) === 0 ? 'bare' : 'unknown';
        return { version, kind, byte: b };
    } catch (_) {
        return null;
    }
}

// Best-effort signer for an undecodable signed v4 extrinsic: the address comes
// first after the format byte, so it is readable even when a later field is
// not. Only MultiAddress::Id (0x00 + 32 bytes) is recognised.
export function signerBytesFromV4(hex) {
    try {
        const u8a = hexToBytes(hex);
        const c = readCompact(u8a);
        if (!c) return null;
        const at = c[0];
        if (u8a[at] !== 0x84) return null;
        if (u8a[at + 1] !== 0x00 || u8a.length < at + 2 + 32) return null;
        return u8a.slice(at + 2, at + 2 + 32);
    } catch (_) {
        return null;
    }
}

// A stand-in with the surface the indexer reads (isSigned, signer, hash,
// method), marked `undecoded: true` so nothing mistakes it for a real decode.
export function undecodedExtrinsic(hex, index, error, { hashHex, encodeAddress } = {}) {
    const fmt = extrinsicFormat(hex);
    const signerBytes = signerBytesFromV4(hex);
    let signerText = null;
    if (signerBytes && typeof encodeAddress === 'function') {
        try { signerText = encodeAddress(signerBytes); } catch (_) { signerText = null; }
    }
    let hash = null;
    if (typeof hashHex === 'function') { try { hash = hashHex(hex); } catch (_) { hash = null; } }
    const message = error && error.message ? error.message : String(error || 'decode failed');
    return {
        undecoded: true,
        index,
        format: fmt,
        error: message.split('\n')[0].slice(0, 300),
        isSigned: !!signerText,
        signer: signerText ? { toString: () => signerText } : null,
        method: null,
        hash: { toHex: () => hash || '' },
        toHex: () => String(hex)
    };
}

// Decodes each raw extrinsic hex with `decodeOne(hex)` (normally
// hex => registry.createType('Extrinsic', hex)). Returns every extrinsic in
// order, real or stub, plus the list of failures for the caller to record.
export function decodeExtrinsicsTolerant(rawList, decodeOne, opts = {}) {
    const extrinsics = [];
    const failures = [];
    const list = Array.isArray(rawList) ? rawList : [];
    for (let i = 0; i < list.length; i++) {
        const hex = typeof list[i] === 'string' ? list[i] : bytesToHex(list[i]);
        try {
            extrinsics.push(decodeOne(hex));
        } catch (err) {
            const stub = undecodedExtrinsic(hex, i, err, opts);
            extrinsics.push(stub);
            failures.push({ index: i, error: stub.error, format: stub.format, hash: stub.hash.toHex() });
        }
    }
    return { extrinsics, failures };
}

// The timestamp inherent, skipping stubs. Mirrors server.js getBlockTimestamp.
export function timestampFromExtrinsics(extrinsics) {
    let timestamp = null;
    for (const ex of extrinsics || []) {
        if (!ex || !ex.method) continue;
        if (ex.method.section === 'timestamp' && ex.method.method === 'set') timestamp = ex.method.args[0].toNumber();
    }
    return timestamp;
}

// scan_failures keys. The table's key is (indexer, block), so two bad
// extrinsics in one block under a single 'extrinsic_decode' key collapse into
// one row with attempts = 2. Each bad extrinsic gets its own key instead,
// 'extrinsic_decode:<index>'. None of these keys is ever retried by an
// indexer: they are operator signals, counted by db.countDecodeFailures().
export const EXTRINSIC_DECODE = 'extrinsic_decode';
export const BLOCK_DECODE_RECOVERED = 'block_decode_recovered';
export function extrinsicDecodeIndexer(index) {
    return `${EXTRINSIC_DECODE}:${index}`;
}

function oneLine(err, max) {
    const msg = err && err.message ? err.message : String(err == null ? '' : err);
    const s = msg.replace(/0x[0-9a-f]{8,}/gi, '0x...').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '...' : s;
}

// The error thrown when the fallback fetch fails. The ORIGINAL whole-block
// decode error comes first, because the caller keeps only ~200 characters of
// the message as the scan_failures reason; the fallback error follows, so a
// transport failure there is still recognised as transport
// (lib/rpc-errors.js matches on the message).
export function fallbackFetchError(cause, err) {
    const e = new Error(`whole-block decode failed: ${oneLine(cause, 80)}; per-extrinsic fallback failed: ${oneLine(err, 110)}`);
    e.cause = err;
    e.blockDecodeError = cause;
    return e;
}

// Called after the whole-block decode failed with `cause` for a
// non-transport reason. fetchAndDecode() fetches the block undecoded and
// returns { header, extrinsics, failures } (decodeExtrinsicsTolerant output
// plus the header), or null when the node returns no block. record(indexer,
// block, msg) writes a scan_failures row.
//   - every extrinsic decodes alone: one 'block_decode_recovered' row, so the
//     fault elsewhere in the block (header, digest) is visible;
//   - otherwise one 'extrinsic_decode:<index>' row per bad extrinsic;
//   - fetchAndDecode throws or returns null: throws fallbackFetchError, which
//     keeps the original error.
// A failing record() is warned about and never costs the block.
export async function recoverBlockDecode({ blockNumber, cause, fetchAndDecode, record, warn = () => {} }) {
    let r;
    try {
        r = await fetchAndDecode();
    } catch (err) {
        throw fallbackFetchError(cause, err);
    }
    if (!r) throw fallbackFetchError(cause, new Error('the node returned no block'));
    const { header, extrinsics, failures = [] } = r;
    const why = oneLine(cause, 200);
    const rows = [];
    if (!failures.length) {
        rows.push([BLOCK_DECODE_RECOVERED, `whole-block decode failed but all ${extrinsics.length} extrinsics decoded individually: ${why}`]);
    }
    for (const f of failures) {
        const fmt = f.format ? `v${f.format.version} ${f.format.kind}` : 'unknown format';
        rows.push([extrinsicDecodeIndexer(f.index), `extrinsic ${f.index} (${fmt}, ${f.hash}) undecodable: ${f.error}; whole-block error: ${why}`]);
    }
    for (const [indexer, msg] of rows) {
        warn(`block ${blockNumber}: ${msg}`);
        try { record(indexer, blockNumber, msg); } catch (e) { warn(`block ${blockNumber}: could not record ${indexer}: ${e && e.message ? e.message : e}`); }
    }
    return { block: { header, extrinsics } };
}
