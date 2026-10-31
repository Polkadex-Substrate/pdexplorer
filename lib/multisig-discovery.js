// Best-effort discovery from the account's recent indexed events. A multisig
// has no creation registry: unused wallets and unindexed history need import.
import { normalizeMultisig, sameAccount } from './multisig.js';

const METHODS = new Set(['NewMultisig', 'MultisigApproval', 'MultisigExecuted', 'MultisigCancelled']);
const HASH = /^0x[\da-f]{64}$/i;
const LIMIT = { pages: 5, events: 1000, blocks: 20 };

function eventAccount(e) {
    let data = e.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return null; } }
    return Array.isArray(data) ? data[e.method === 'NewMultisig' ? 1 : 2] : data?.multisig;
}

// Only walk wrappers whose effective signing origin we know. Matching a
// derived address to an indexed event avoids listing unexecuted inner calls.
// Never infer an origin from the event's outer signer (which may be a proxy).
export function multisigsFromExtrinsic(extrinsic, events) {
    if (!extrinsic?.isSigned) return [];
    const expected = events.filter(e => e.section === 'multisig' && METHODS.has(e.method)).map(eventAccount);
    const found = new Map();
    let visited = 0;
    function visit(call, origin, depth = 0) {
        if (!call || depth > 16 || ++visited > 1000) return;
        const args = call.args;
        if (call.section === 'utility' && ['batch', 'batchAll', 'forceBatch'].includes(call.method)) {
            for (const inner of args[0]) visit(inner, origin, depth + 1);
        } else if (call.section === 'proxy' && ['proxy', 'proxyAnnounced'].includes(call.method)) {
            const offset = call.method === 'proxyAnnounced' ? 1 : 0;
            visit(args[offset + 2], args[offset].toString(), depth + 1);
        } else if (call.section === 'multisig' && ['asMulti', 'approveAsMulti', 'cancelAsMulti', 'asMultiThreshold1'].includes(call.method)) {
            const one = call.method === 'asMultiThreshold1';
            let m;
            try {
                m = normalizeMultisig({ threshold: one ? 1 : args[0].toString(),
                    signers: [origin, ...Array.from(args[one ? 0 : 1], a => a.toString())] });
            } catch { return; }
            if (expected.some(a => sameAccount(a, m.address))) found.set(m.address, m);
            if (one || call.method === 'asMulti') visit(args[one ? 1 : 3], m.address, depth + 1);
        }
    }
    visit(extrinsic.method, extrinsic.signer.toString());
    return [...found.values()];
}

export async function discoverMultisigs({ api, address, fetchJson, signal }) {
    if (!api) throw new Error('Connect to the node, then retry automatic discovery.');
    const candidates = new Map();
    let next = null, scannedEvents = 0, limited = false;
    for (let page = 0; page < LIMIT.pages; page++) {
        signal?.throwIfAborted();
        const suffix = next ? `&before=${encodeURIComponent(next)}` : '';
        const data = await fetchJson(`/api/account/${encodeURIComponent(address)}/history?list=events${suffix}`, { signal });
        if (!Array.isArray(data?.rows)) throw new Error('The account history could not be read. Try again.');
        const rows = data.rows.slice(0, LIMIT.events - scannedEvents);
        scannedEvents += rows.length;
        for (const e of rows) {
            if (!e || e.section !== 'multisig' || !METHODS.has(e.method) || !HASH.test(e.blockHash)
                || !Number.isSafeInteger(e.block) || e.block < 0
                || !Number.isSafeInteger(e.extrinsicIndex) || e.extrinsicIndex < 0) continue;
            if (!candidates.has(e.blockHash)) {
                if (candidates.size >= LIMIT.blocks) { limited = true; continue; }
                candidates.set(e.blockHash, []);
            }
            candidates.get(e.blockHash).push(e);
        }
        const prev = next;
        next = data.next;
        if (!next) break;
        if (!/^\d+:\d+$/.test(next) || next === prev) throw new Error('The account history cursor is invalid. Try again.');
        if (scannedEvents >= LIMIT.events || candidates.size >= LIMIT.blocks) { limited = true; break; }
    }
    limited ||= !!next;
    const wallets = new Map();
    let unavailableBlocks = 0;
    for (const [hash, events] of candidates) {
        signal?.throwIfAborted();
        try {
            // Discard stale index rows from a fork. Fetching the block by hash
            // also uses the historical metadata in Polkadot JS.
            const canonical = await api.rpc.chain.getBlockHash(events[0].block);
            signal?.throwIfAborted();
            if (canonical.toHex().toLowerCase() !== hash.toLowerCase()) { unavailableBlocks++; continue; }
            const signed = await api.rpc.chain.getBlock(hash);
            signal?.throwIfAborted();
            for (const index of new Set(events.map(e => e.extrinsicIndex))) {
                for (const m of multisigsFromExtrinsic(signed.block.extrinsics[index], events.filter(e => e.extrinsicIndex === index))) {
                    if (m.signers.some(a => sameAccount(a, address))) wallets.set(m.address, m);
                }
            }
        } catch { signal?.throwIfAborted(); unavailableBlocks++; }
    }
    signal?.throwIfAborted();
    return { wallets: [...wallets.values()], scannedEvents, limited, unavailableBlocks };
}
