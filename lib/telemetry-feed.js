// The Substrate telemetry feed protocol, read side only, pure (no sockets, no
// timers): frame decoding and the in-memory map of Polkadex nodes. The
// connection lives in lib/telemetry-reader.js. Design: cto-team/plans/
// 2026-11-17-validator-onboarding-design.md, sections 3.5 and 6; CEO decision
// D3 (server side only; the browser never contacts telemetry).
//
// Verified against paritytech/substrate-telemetry (master, read 2026-11-17):
//   backend/telemetry_core/src/feed_message.rs   FEED_VERSION = 33; a frame is
//       ONE JSON array of alternating action codes and payloads,
//       [action, payload, action, payload, ...]; the action numbers below
//   backend/telemetry_core/src/main.rs           /feed sends frames as binary
//       WebSocket messages (UTF-8 JSON); it takes text commands
//   backend/telemetry_core/src/aggregator/inner_loop.rs
//       commands are "subscribe:<genesis hash>" and "ping:<value>"; on connect
//       the feed sends Version, TelemetryInfo and one AddedChain per chain;
//       subscribing to a chain that has no nodes is silently ignored; on
//       subscribe: SubscribedTo, TimeSync, BestBlock, BestFinalized,
//       ChainStatsUpdate, then per node AddedNode + FinalizedBlock (+ StaleNode)
//   backend/telemetry_core/src/state/chain.rs    per node updates: ImportedBlock,
//       FinalizedBlock, NodeStatsUpdate, StaleNode (no new block for 2 min),
//       AddedNode again when the node's GRANDPA authority changes
//   backend/common/src/node_types.rs             NodeStats = [peers, txcount];
//       BlockDetails = [height, hash, block_time, block_timestamp, propagation]
//   frontend/src/Connection.ts                   the official client: a first
//       byte 0x00 means a future binary format; ping every 30 s; reconnect
//       when nothing arrives for 60 s; backoff 5 s doubling to 5 min
//
// AddedNode payload (version 33):
//   [id, [name, implementation, version, validator, network_id, target_os,
//         target_arch, target_env, ip, sysinfo, hwbench],
//    [peers, txcount], io, hardware, blockDetails, location, startup_time]
//
// The feed is not a stable public API. Anything unexpected is ignored and
// counted, never guessed at: a different FEED_VERSION, a binary frame or a
// frame that is not the array above. Every string from the feed is untrusted
// text (self-declared by whoever runs a node): control and bidi characters
// removed, length capped; the view escapes it again when rendering.

export const FEED_VERSION = 33;
export const POLKADEX_GENESIS = '0x3920bcb4960a1eef5580cd5367ff3f430eef052774f78468852f7b9cb39f8a3c';

export const ACTION = Object.freeze({
    Version: 0, BestBlock: 1, BestFinalized: 2, AddedNode: 3, RemovedNode: 4, LocatedNode: 5,
    ImportedBlock: 6, FinalizedBlock: 7, NodeStats: 8, Hardware: 9, TimeSync: 10, AddedChain: 11,
    RemovedChain: 12, SubscribedTo: 13, UnsubscribedFrom: 14, Pong: 15, StaleNode: 20, NodeIO: 21,
    ChainStats: 22, TelemetryInfo: 23
});

export const LIMITS = Object.freeze({
    maxNodes: 2000,              // nodes kept for the chain; more are dropped and counted
    maxFrameBytes: 2 * 1024 * 1024,   // the feed chunks 64 nodes (about 32 KB) per frame
    maxText: 64,                 // name, version, peer id
    maxNodeId: 10_000_000,
    resubscribeMs: 30_000        // a subscribe with no SubscribedTo may be re-sent after this
});

export const GENESIS_RE = /^0x[0-9a-f]{64}$/;
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

// Untrusted text: a string, without C0/C1 controls or bidi overrides, trimmed,
// at most max characters. Anything else is ''.
export function cleanText(v, max = LIMITS.maxText) {
    if (typeof v !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').trim().slice(0, max);
}

// One WebSocket message (string, ArrayBuffer, a typed array or a Buffer) to
// { ok: true, messages: [{ action, payload }] } or { ok: false, reason }.
// Reasons: 'too-large', 'binary-format' (first byte 0x00: the binary feed the
// official client treats as a new version), 'utf8', 'json', 'shape'.
export function decodeFrame(data, { maxBytes = LIMITS.maxFrameBytes } = {}) {
    let text;
    if (typeof data === 'string') {
        if (data.length > maxBytes) return { ok: false, reason: 'too-large' };
        text = data;
    } else {
        let bytes = null;
        if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (!bytes) return { ok: false, reason: 'shape' };
        if (bytes.byteLength > maxBytes) return { ok: false, reason: 'too-large' };
        if (bytes.byteLength && bytes[0] === 0x00) return { ok: false, reason: 'binary-format' };
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { return { ok: false, reason: 'utf8' }; }
    }
    let json;
    try { json = JSON.parse(text); } catch (e) { return { ok: false, reason: 'json' }; }
    if (!Array.isArray(json) || json.length === 0 || json.length % 2 !== 0) return { ok: false, reason: 'shape' };
    const messages = [];
    for (let i = 0; i < json.length; i += 2) {
        if (!Number.isInteger(json[i])) return { ok: false, reason: 'shape' };
        messages.push({ action: json[i], payload: json[i + 1] });
    }
    return { ok: true, messages };
}

function blockHeight(details) {
    return Array.isArray(details) && isCount(details[0]) ? details[0] : null;
}

// The map of nodes for one chain, fed with decoded messages.
//   apply(messages) -> { send: ['subscribe:0x..'], versionMismatch, changed }
//   reset()         after a disconnect: everything is re-sent on the next subscribe
//   list()          the nodes, plain objects
//   status()        { version, chainSeen, subscribed, nodes, malformed, overflow }
export function createNodeStore({ genesis = POLKADEX_GENESIS, maxNodes = LIMITS.maxNodes, now = () => Date.now(), resubscribeMs = LIMITS.resubscribeMs } = {}) {
    const chain = String(genesis).toLowerCase();
    const nodes = new Map();
    let version = null, chainSeen = false, subscribed = false, pendingAt = null;
    let malformed = 0, overflow = 0;

    const ours = (h) => typeof h === 'string' && h.toLowerCase() === chain;
    const nodeId = (id) => (Number.isSafeInteger(id) && id >= 0 && id <= LIMITS.maxNodeId ? id : null);

    function reset() {
        nodes.clear();
        version = null; chainSeen = false; subscribed = false; pendingAt = null;
    }

    function addNode(p) {
        if (!Array.isArray(p) || p.length < 6) return false;
        const id = nodeId(p[0]);
        const d = p[1], stats = p[2];
        if (id == null || !Array.isArray(d)) return false;
        const name = cleanText(d[0]);
        if (!name) return false;
        const prev = nodes.get(id);
        if (!prev && nodes.size >= maxNodes) { overflow++; return 'skip'; }
        const best = blockHeight(p[5]);
        nodes.set(id, {
            id, name,
            version: cleanText(d[2]),
            validator: typeof d[3] === 'string' && cleanText(d[3]).length > 0,
            networkId: cleanText(d[4]),
            best: best != null ? best : (prev ? prev.best : null),
            finalized: prev ? prev.finalized : null,
            peers: Array.isArray(stats) && isCount(stats[0]) ? stats[0] : (prev ? prev.peers : null),
            stale: prev ? prev.stale : false,
            updatedAt: now()
        });
        return true;
    }

    function update(id, fn) {
        const n = nodes.get(nodeId(id));
        if (!n) return false;
        fn(n);
        n.updatedAt = now();
        return true;
    }

    function apply(messages) {
        const out = { send: [], versionMismatch: false, changed: false };
        const subscribe = () => {
            if (subscribed) return;
            if (pendingAt != null && now() - pendingAt < resubscribeMs) return;
            pendingAt = now();
            out.send.push('subscribe:' + chain);
        };
        for (const { action, payload: p } of messages || []) {
            if (action === ACTION.Version) {
                if (p !== FEED_VERSION) { out.versionMismatch = true; return out; }
                version = p;
                continue;
            }
            // Nothing is believed before the feed has said which version it speaks.
            if (version !== FEED_VERSION) continue;
            let ok = true;
            switch (action) {
                case ACTION.AddedChain:
                    if (!Array.isArray(p)) { ok = false; break; }
                    if (ours(p[1])) { chainSeen = true; subscribe(); }
                    break;
                case ACTION.RemovedChain:
                    if (ours(p)) {
                        if (nodes.size) out.changed = true;
                        nodes.clear(); chainSeen = false; subscribed = false; pendingAt = null;
                    }
                    break;
                case ACTION.SubscribedTo:
                    if (ours(p)) { nodes.clear(); subscribed = true; chainSeen = true; pendingAt = null; out.changed = true; }
                    else { subscribed = false; }
                    break;
                case ACTION.UnsubscribedFrom:
                    if (ours(p)) { nodes.clear(); subscribed = false; out.changed = true; }
                    break;
                case ACTION.AddedNode: {
                    if (!subscribed) break;
                    const r = addNode(p);
                    if (r === true) out.changed = true;
                    else if (r === false) ok = false;
                    break;
                }
                case ACTION.RemovedNode:
                    if (!subscribed) break;
                    if (nodeId(p) == null) { ok = false; break; }
                    if (nodes.delete(p)) out.changed = true;
                    break;
                case ACTION.ImportedBlock: {
                    if (!subscribed) break;
                    const h = Array.isArray(p) ? blockHeight(p[1]) : null;
                    if (h == null) { ok = false; break; }
                    if (update(p[0], n => { n.best = h; n.stale = false; })) out.changed = true;
                    break;
                }
                case ACTION.FinalizedBlock:
                    if (!subscribed) break;
                    if (!Array.isArray(p) || !isCount(p[1])) { ok = false; break; }
                    if (update(p[0], n => { n.finalized = p[1]; })) out.changed = true;
                    break;
                case ACTION.NodeStats:
                    if (!subscribed) break;
                    if (!Array.isArray(p) || !Array.isArray(p[1]) || !isCount(p[1][0])) { ok = false; break; }
                    if (update(p[0], n => { n.peers = p[1][0]; })) out.changed = true;
                    break;
                case ACTION.StaleNode: {
                    if (!subscribed) break;
                    const n = nodes.get(nodeId(p));
                    if (!n) break;
                    n.stale = true;
                    out.changed = true;
                    break;
                }
                default:
                    break;   // BestBlock, TimeSync, Pong, LocatedNode, Hardware, NodeIO, ChainStats, TelemetryInfo, and unknown codes
            }
            if (!ok) malformed++;
        }
        return out;
    }

    return {
        apply, reset,
        list: () => Array.from(nodes.values(), n => ({ ...n })),
        status: () => ({ version, chainSeen, subscribed, nodes: nodes.size, malformed, overflow })
    };
}

// Nodes whose name is the query: exact first (names are case sensitive on
// telemetry), else the same name in another case. similar: other names that
// contain the query (3 characters or more), when nothing matched.
export function findNodes(list, query, { limit = 10, similarLimit = 5 } = {}) {
    const q = cleanText(query);
    if (!q) return { matches: [], similar: [], count: 0 };
    let matches = (list || []).filter(n => n.name === q);
    if (!matches.length) matches = (list || []).filter(n => n.name.toLowerCase() === q.toLowerCase());
    let similar = [];
    if (!matches.length && q.length >= 3) {
        const lq = q.toLowerCase();
        similar = [...new Set((list || []).filter(n => n.name.toLowerCase().includes(lq)).map(n => n.name))].sort().slice(0, similarLimit);
    }
    return { matches: matches.slice(0, limit), similar, count: matches.length };
}
