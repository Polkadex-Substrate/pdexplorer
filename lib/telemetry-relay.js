// Where the telemetry connection lives, and how the HTTP workers see it.
//
// server.js runs as a node:cluster. One connection to the feed per explorer,
// not one per worker, so it lives in the cluster PRIMARY (which only forks and
// supervises workers and never blocks on SQLite) and the primary sends a
// compact snapshot to every worker over the cluster IPC channel: every 5 s
// when something changed, at least every 30 s, and at once to a worker that
// has just come online. A worker that has heard nothing for 90 s reports the
// feed as down rather than serving old nodes as current. With WORKERS=1 the
// single process holds the reader itself (startLocalTelemetry).
//
// Off unless TELEMETRY_FEED_URL is set (design section 6): with it unset no
// socket is opened anywhere and GET /api/telemetry/node answers feed: 'off'.
// A telemetry outage or a change of mind costs nothing.

import { createTelemetryReader } from './telemetry-reader.js';
import { POLKADEX_GENESIS, GENESIS_RE, LIMITS, cleanText } from './telemetry-feed.js';

export const TELEMETRY_MESSAGE = 'pdex-telemetry';
export const RELAY_INTERVAL_MS = 5_000;
export const RELAY_HEARTBEAT_MS = 30_000;
export const SNAPSHOT_STALE_MS = 90_000;
// The recommended value for TELEMETRY_FEED_URL (CEO decision D3): Parity's public feed.
export const PARITY_FEED_URL = 'wss://feed.telemetry.polkadot.io/feed';

// { enabled, url, genesis, reason } from the environment. Only ws:// and
// wss:// URLs are accepted; a genesis override must be a 0x 32-byte hash.
export function telemetryConfig(env = {}) {
    const raw = String(env.TELEMETRY_FEED_URL || '').trim();
    const genesisRaw = String(env.TELEMETRY_GENESIS || '').trim().toLowerCase();
    const genesis = genesisRaw ? genesisRaw : POLKADEX_GENESIS;
    if (!raw) return { enabled: false, url: '', genesis, reason: 'TELEMETRY_FEED_URL is not set' };
    let u;
    try { u = new URL(raw); } catch (e) { return { enabled: false, url: '', genesis, reason: 'TELEMETRY_FEED_URL is not a URL' }; }
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return { enabled: false, url: '', genesis, reason: 'TELEMETRY_FEED_URL must be ws:// or wss://' };
    if (!GENESIS_RE.test(genesis)) return { enabled: false, url: '', genesis: POLKADEX_GENESIS, reason: 'TELEMETRY_GENESIS must be a 0x hash of 32 bytes' };
    return { enabled: true, url: u.href, genesis, reason: '' };
}

// Snapshot <-> IPC message. Nodes travel as short arrays.
export function encodeSnapshot(s) {
    return {
        type: TELEMETRY_MESSAGE, v: 1, feed: s.feed, reason: s.reason || '', at: s.at, chainSeen: !!s.chainSeen,
        nodes: (s.nodes || []).map(n => [n.name, n.version, n.best, n.finalized, n.peers, n.validator ? 1 : 0, n.networkId, n.updatedAt, n.stale ? 1 : 0])
    };
}

const num = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);
const FEEDS = new Set(['ok', 'down', 'connecting', 'off']);

// A message from the primary, checked (it crossed a process boundary), or null.
export function decodeSnapshot(m, { maxNodes = LIMITS.maxNodes } = {}) {
    if (!m || m.type !== TELEMETRY_MESSAGE || m.v !== 1 || !FEEDS.has(m.feed) || !Number.isFinite(m.at) || !Array.isArray(m.nodes)) return null;
    const nodes = [];
    for (const a of m.nodes.slice(0, maxNodes)) {
        if (!Array.isArray(a)) continue;
        const name = cleanText(a[0]);
        if (!name) continue;
        nodes.push({ name, version: cleanText(a[1]), best: num(a[2]), finalized: num(a[3]), peers: num(a[4]), validator: a[5] === 1, networkId: cleanText(a[6]), updatedAt: Number.isFinite(a[7]) ? a[7] : null, stale: a[8] === 1 });
    }
    return { feed: m.feed, reason: cleanText(m.reason || ''), at: m.at, chainSeen: !!m.chainSeen, nodes };
}

// In the primary: the reader, and the snapshots it sends to the workers.
export function startTelemetryRelay({ config, cluster, createReader = createTelemetryReader, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(), log = () => {}, readerOptions = {} }) {
    if (!config || !config.enabled) return null;
    let dirty = true, lastSent = 0, timer = null;
    const reader = createReader({ url: config.url, genesis: config.genesis, onChange: () => { dirty = true; }, log, ...readerOptions });
    const workers = () => Object.values((cluster && cluster.workers) || {}).filter(Boolean);
    const sendTo = (w, msg) => { try { if (w.isConnected ? w.isConnected() : true) w.send(msg); } catch (e) { /* the worker is exiting */ } };
    function tick() {
        timer = null;
        if (dirty || now() - lastSent >= RELAY_HEARTBEAT_MS) {
            const msg = encodeSnapshot(reader.snapshot());
            for (const w of workers()) sendTo(w, msg);
            dirty = false;
            lastSent = now();
        }
        timer = setTimer(tick, RELAY_INTERVAL_MS);
        if (timer && typeof timer.unref === 'function') timer.unref();
    }
    const onOnline = (w) => sendTo(w, encodeSnapshot(reader.snapshot()));
    if (cluster && typeof cluster.on === 'function') cluster.on('online', onOnline);
    reader.start();
    tick();
    return {
        reader,
        stop() {
            if (timer) clearTimer(timer);
            timer = null;
            if (cluster && typeof cluster.off === 'function') cluster.off('online', onOnline);
            reader.stop();
        }
    };
}

// In a worker: the latest snapshot from the primary.
export function receiveTelemetry({ proc = process, now = () => Date.now(), staleMs = SNAPSHOT_STALE_MS } = {}) {
    let latest = null, receivedAt = 0;
    const onMessage = (m) => {
        if (!m || m.type !== TELEMETRY_MESSAGE) return;
        const s = decodeSnapshot(m);
        if (s) { latest = s; receivedAt = now(); }
    };
    proc.on('message', onMessage);
    return {
        snapshot() {
            if (!latest) return { feed: 'connecting', reason: 'no snapshot yet', at: now(), chainSeen: false, nodes: [] };
            if (now() - receivedAt > staleMs) return { ...latest, feed: 'down', reason: 'stale snapshot', nodes: [] };
            return latest;
        },
        stop() { if (typeof proc.off === 'function') proc.off('message', onMessage); }
    };
}

// WORKERS=1: this process holds the reader.
export function startLocalTelemetry({ config, createReader = createTelemetryReader, log = () => {}, readerOptions = {} }) {
    if (!config || !config.enabled) return null;
    const reader = createReader({ url: config.url, genesis: config.genesis, log, ...readerOptions });
    reader.start();
    return { snapshot: () => reader.snapshot(), stop: () => reader.stop() };
}
