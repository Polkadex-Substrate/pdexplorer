// The telemetry reader behind "Check my node" (Sprint 2 of
// cto-team/plans/2026-11-17-validator-onboarding-design.md; CEO decision D3:
// server side only). Synthetic frames in the substrate-telemetry feed format
// (FEED_VERSION 33, backend/telemetry_core/src/feed_message.rs): one JSON
// array of alternating action codes and payloads, sent as binary frames. The
// connection is driven with a fake WebSocket and a fake clock; the route runs
// on a real express app on a random port. Node names here are made up.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import { FEED_VERSION, POLKADEX_GENESIS, ACTION, LIMITS, decodeFrame, cleanText, createNodeStore, findNodes } from '../lib/telemetry-feed.js';
import { createTelemetryReader, backoffDelay, BACKOFF_BASE_MS, BACKOFF_MAX_MS, MESSAGE_TIMEOUT_MS, PING_INTERVAL_MS } from '../lib/telemetry-reader.js';
import { telemetryConfig, telemetryHostName, encodeSnapshot, decodeSnapshot, startTelemetryRelay, receiveTelemetry, startLocalTelemetry, TELEMETRY_MESSAGE, RELAY_INTERVAL_MS, RELAY_HEARTBEAT_MS, SNAPSHOT_STALE_MS, PARITY_FEED_URL } from '../lib/telemetry-relay.js';
import { registerTelemetryRoute, parseNodeName, TELEMETRY_NODE_ROUTE, NAME_MAX } from '../lib/telemetry-api.js';

const G = POLKADEX_GENESIS;
const OTHER = '0x' + 'cd'.repeat(32);
const HASH = '0x' + 'ab'.repeat(32);
const enc = (arr) => Buffer.from(JSON.stringify(arr));
const frame = (...pairs) => enc(pairs.flat(1));
// An AddedNode payload as the feed sends it (version 33).
const node = (id, name, { version = '7.0.0-566b080ba1a', validator = null, peerId = '12D3KooWTestPeer' + id, peers = 8, best = 1000 } = {}) =>
    [id, [name, 'Polkadex Node', version, validator, peerId, 'linux', 'x86_64', 'gnu', null, null, null], [peers, 0], [[]], [[], [], []], [best, HASH, 6000, 1_700_000_000_000, null], null, null];
const V = [ACTION.Version, FEED_VERSION];
const subscribed = (store) => store.apply([{ action: 0, payload: 33 }, { action: ACTION.AddedChain, payload: ['Polkadex', G, 3] }, { action: ACTION.SubscribedTo, payload: G }]);
const msgs = (...pairs) => pairs.map(([action, payload]) => ({ action, payload }));

describe('decodeFrame: the feed wire format', () => {
    test('a binary frame (Buffer, ArrayBuffer) or a text frame decodes to action/payload pairs', () => {
        const want = [{ action: 0, payload: 33 }, { action: ACTION.AddedChain, payload: ['Polkadex', G, 3] }];
        for (const data of [frame(V, [ACTION.AddedChain, ['Polkadex', G, 3]]), new Uint8Array(frame(V, [11, ['Polkadex', G, 3]])).buffer, JSON.stringify([0, 33, 11, ['Polkadex', G, 3]])]) {
            const r = decodeFrame(data);
            assert.equal(r.ok, true);
            assert.deepEqual(r.messages, want);
        }
    });
    test('refused, never guessed: binary format byte, bad UTF-8, bad JSON, not an array, odd length, empty, non-integer action, too large', () => {
        assert.equal(decodeFrame(Buffer.from([0x00, 0x01])).reason, 'binary-format');
        assert.equal(decodeFrame(Buffer.from([0x5b, 0xff, 0x5d])).reason, 'utf8');
        assert.equal(decodeFrame('[0,33').reason, 'json');
        assert.equal(decodeFrame('{"a":1}').reason, 'shape');
        assert.equal(decodeFrame('[0,33,1]').reason, 'shape');
        assert.equal(decodeFrame('[]').reason, 'shape');
        assert.equal(decodeFrame('["0",33]').reason, 'shape');
        assert.equal(decodeFrame(frame(V), { maxBytes: 4 }).reason, 'too-large');
        assert.equal(decodeFrame('x'.repeat(10), { maxBytes: 4 }).reason, 'too-large');
        assert.equal(decodeFrame(42).reason, 'shape');
    });
    test('cleanText: controls and bidi overrides removed, trimmed, capped at 64, non-strings empty', () => {
        assert.equal(cleanText('  my\u0007node‮\u0000  '), 'mynode');
        assert.equal(cleanText('x'.repeat(100)).length, LIMITS.maxText);
        assert.equal(cleanText(12), '');
        assert.equal(cleanText(null), '');
        assert.equal(cleanText('<b>bold</b>'), '<b>bold</b>', 'not HTML-escaped here: the view escapes');
    });
});

describe('createNodeStore: the Polkadex node map', () => {
    test('nothing is believed before Version; an unknown version is a mismatch', () => {
        const s = createNodeStore();
        const r0 = s.apply(msgs([ACTION.AddedChain, ['Polkadex', G, 3]]));
        assert.deepEqual(r0.send, []);
        const r1 = s.apply(msgs([0, 34]));
        assert.equal(r1.versionMismatch, true);
        assert.equal(createNodeStore().apply(msgs([0, 33])).versionMismatch, false);
    });
    test('AddedChain for the Polkadex genesis asks to subscribe, once per 30 s; another chain does not', () => {
        let t = 0;
        const s = createNodeStore({ now: () => t });
        assert.deepEqual(s.apply(msgs([0, 33], [ACTION.AddedChain, ['Other', OTHER, 9]])).send, []);
        assert.deepEqual(s.apply(msgs([ACTION.AddedChain, ['Polkadex', G.toUpperCase().replace('0X', '0x'), 3]])).send, ['subscribe:' + G]);
        assert.deepEqual(s.apply(msgs([ACTION.AddedChain, ['Polkadex', G, 4]])).send, [], 'the node count moved; already asked');
        t += LIMITS.resubscribeMs;
        assert.deepEqual(s.apply(msgs([ACTION.AddedChain, ['Polkadex', G, 4]])).send, ['subscribe:' + G], 'no SubscribedTo came: ask again');
        s.apply(msgs([ACTION.SubscribedTo, G]));
        t += LIMITS.resubscribeMs * 2;
        assert.deepEqual(s.apply(msgs([ACTION.AddedChain, ['Polkadex', G, 5]])).send, [], 'subscribed: never again');
        assert.equal(s.status().subscribed, true);
    });
    test('nodes: added, imported, finalized, peers, stale, removed', () => {
        let t = 1000;
        const s = createNodeStore({ now: () => t });
        subscribed(s);
        const r = s.apply(msgs([ACTION.AddedNode, node(7, 'alpha-node', { best: 500, peers: 2 })], [ACTION.FinalizedBlock, [7, 498, HASH]]));
        assert.equal(r.changed, true);
        assert.deepEqual(s.list(), [{ id: 7, name: 'alpha-node', version: '7.0.0-566b080ba1a', validator: false, networkId: '12D3KooWTestPeer7', best: 500, finalized: 498, peers: 2, stale: false, updatedAt: 1000 }]);
        s.apply(msgs([ACTION.StaleNode, 7]));
        assert.equal(s.list()[0].stale, true);
        t = 5000;
        s.apply(msgs([ACTION.ImportedBlock, [7, [510, HASH, 6000, 1, null]]], [ACTION.NodeStats, [7, [9, 3]]]));
        assert.deepEqual([s.list()[0].best, s.list()[0].peers, s.list()[0].stale, s.list()[0].updatedAt], [510, 9, false, 5000]);
        s.apply(msgs([ACTION.RemovedNode, 7]));
        assert.deepEqual(s.list(), []);
    });
    test('AddedNode again (a GRANDPA authority change) keeps the finalized block; a validator string sets the flag', () => {
        const s = createNodeStore();
        subscribed(s);
        s.apply(msgs([ACTION.AddedNode, node(1, 'beta')], [ACTION.FinalizedBlock, [1, 990, HASH]]));
        s.apply(msgs([ACTION.AddedNode, node(1, 'beta', { validator: '5GrandpaKeyAsReported' })]));
        assert.deepEqual([s.list()[0].finalized, s.list()[0].validator], [990, true]);
        s.apply(msgs([ACTION.AddedNode, node(1, 'beta', { validator: '' })]));
        assert.equal(s.list()[0].validator, false, 'an empty authority id is not a validator');
    });
    test('node messages before SubscribedTo are ignored; SubscribedTo starts from empty', () => {
        const s = createNodeStore();
        s.apply(msgs([0, 33], [ACTION.AddedChain, ['Polkadex', G, 1]], [ACTION.AddedNode, node(1, 'early')]));
        assert.deepEqual(s.list(), []);
        s.apply(msgs([ACTION.SubscribedTo, G], [ACTION.AddedNode, node(2, 'later')]));
        assert.deepEqual(s.list().map(n => n.name), ['later']);
        s.apply(msgs([ACTION.SubscribedTo, G]));
        assert.deepEqual(s.list(), [], 'a re-subscribe sends every node again');
    });
    test('RemovedChain for Polkadex clears and the next AddedChain subscribes again; UnsubscribedFrom clears', () => {
        const s = createNodeStore();
        subscribed(s);
        s.apply(msgs([ACTION.AddedNode, node(1, 'gamma')]));
        assert.equal(s.apply(msgs([ACTION.RemovedChain, OTHER])).changed, false);
        assert.equal(s.list().length, 1);
        s.apply(msgs([ACTION.RemovedChain, G]));
        assert.deepEqual([s.list().length, s.status().subscribed, s.status().chainSeen], [0, false, false]);
        assert.deepEqual(s.apply(msgs([ACTION.AddedChain, ['Polkadex', G, 1]])).send, ['subscribe:' + G]);
        s.apply(msgs([ACTION.SubscribedTo, G], [ACTION.AddedNode, node(1, 'gamma')], [ACTION.UnsubscribedFrom, G]));
        assert.deepEqual([s.list().length, s.status().subscribed], [0, false]);
    });
    test('malformed payloads are counted and skipped, never thrown; unknown action codes are ignored', () => {
        const s = createNodeStore();
        subscribed(s);
        s.apply(msgs([ACTION.AddedNode, node(1, 'delta')]));
        const bad = msgs(
            [ACTION.AddedNode, [2, 'not an array']], [ACTION.AddedNode, [3, ['', 'impl', 'v']]], [ACTION.AddedNode, 'x'],
            [ACTION.ImportedBlock, [1, ['tall', HASH]]], [ACTION.FinalizedBlock, [1, -4, HASH]], [ACTION.NodeStats, [1, 'nine']],
            [ACTION.RemovedNode, 'one'], [ACTION.AddedNode, node(LIMITS.maxNodeId + 1, 'too-far')], [99, { anything: true }], [ACTION.Hardware, [1, [[], [], []]]]
        );
        assert.doesNotThrow(() => s.apply(bad));
        assert.equal(s.status().malformed, 8);
        assert.deepEqual(s.list().map(n => [n.name, n.best]), [['delta', 1000]]);
    });
    test('memory bound: at most maxNodes, the rest counted as overflow; known nodes still update', () => {
        const s = createNodeStore({ maxNodes: 3 });
        subscribed(s);
        s.apply(msgs(...[1, 2, 3, 4, 5].map(i => [ACTION.AddedNode, node(i, 'n' + i)])));
        assert.deepEqual([s.status().nodes, s.status().overflow], [3, 2]);
        s.apply(msgs([ACTION.ImportedBlock, [2, [2000, HASH, 0, 0, null]]]));
        assert.equal(s.list().find(n => n.id === 2).best, 2000);
    });
    test('untrusted names: controls removed and capped in the map', () => {
        const s = createNodeStore();
        subscribed(s);
        s.apply(msgs([ACTION.AddedNode, node(1, 'evil‮<script>' + 'x'.repeat(100))]));
        assert.equal(s.list()[0].name, ('evil<script>' + 'x'.repeat(100)).slice(0, 64));
    });
    test('reset forgets everything (after a disconnect)', () => {
        const s = createNodeStore();
        subscribed(s);
        s.apply(msgs([ACTION.AddedNode, node(1, 'x')]));
        s.reset();
        assert.deepEqual(s.status(), { version: null, chainSeen: false, subscribed: false, nodes: 0, malformed: 0, overflow: 0 });
    });
});

describe('findNodes: exact, then another case, then similar names', () => {
    const list = [{ name: 'Alpha-1' }, { name: 'alpha-1' }, { name: 'Bravo' }, { name: 'bravo-two' }, { name: 'charlie' }];
    test('exact is case sensitive and wins', () => {
        assert.deepEqual(findNodes(list, 'Alpha-1').matches.map(n => n.name), ['Alpha-1']);
    });
    test('no exact: the same name in another case, all of them', () => {
        assert.deepEqual(findNodes(list, 'ALPHA-1').matches.map(n => n.name), ['Alpha-1', 'alpha-1']);
        assert.equal(findNodes(list, 'ALPHA-1').count, 2);
    });
    test('nothing: up to five similar names with the query in them (3 characters or more)', () => {
        assert.deepEqual(findNodes(list, 'brav').similar, ['Bravo', 'bravo-two']);
        assert.deepEqual(findNodes(list, 'br').similar, []);
        assert.deepEqual(findNodes(list, 'Bravo').similar, [], 'a match has no similar list');
        const many = Array.from({ length: 9 }, (_, i) => ({ name: 'node-' + i }));
        assert.equal(findNodes(many, 'node').similar.length, 5);
    });
    test('at most 10 matches; count says how many there are', () => {
        const many = Array.from({ length: 12 }, () => ({ name: 'same' }));
        const r = findNodes(many, 'same');
        assert.deepEqual([r.matches.length, r.count], [10, 12]);
    });
});

// ── the connection ──
class FakeWS {
    static all = [];
    static throwNext = false;
    constructor(url) {
        if (FakeWS.throwNext) { FakeWS.throwNext = false; throw new Error('bad url'); }
        this.url = url; this.sent = []; this.closed = false; FakeWS.all.push(this);
    }
    send(t) { this.sent.push(t); }
    close() { this.closed = true; }
    open() { this.onopen && this.onopen(); }
    msg(data) { this.onmessage && this.onmessage({ data }); }
    drop() { this.onclose && this.onclose(); }
    error() { this.onerror && this.onerror(); }
}
function fakeClock(start = 1_000_000) {
    let t = start, id = 0;
    const timers = new Map();
    return {
        now: () => t,
        setTimer: (fn, ms) => { const h = { id: ++id, at: t + ms, fn }; timers.set(h.id, h); return h; },
        clearTimer: (h) => { if (h) timers.delete(h.id); },
        advance(ms) {
            const end = t + ms;
            for (;;) {
                const due = [...timers.values()].filter(x => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (!due) break;
                t = due.at; timers.delete(due.id); due.fn();
            }
            t = end;
        },
        pending: () => timers.size
    };
}
function reader(over = {}) {
    FakeWS.all = [];
    const c = fakeClock();
    let changes = 0;
    const r = createTelemetryReader({ url: 'wss://feed.example.test/feed', WebSocketImpl: FakeWS, setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now, random: () => 0.5, onChange: () => { changes++; }, ...over });
    return { r, c, ws: () => FakeWS.all[FakeWS.all.length - 1], changes: () => changes };
}
const handshake = (w) => { w.open(); w.msg(frame(V, [ACTION.TelemetryInfo, { git_hash: 'abc' }], [ACTION.AddedChain, ['Polkadex', G, 2]])); };

describe('createTelemetryReader: one socket, kept alive like the official client', () => {
    test('connects to the URL, binary frames as ArrayBuffer; connecting until the feed says its version', () => {
        const { r, ws } = reader();
        r.start();
        assert.equal(ws().url, 'wss://feed.example.test/feed');
        assert.equal(ws().binaryType, 'arraybuffer');
        assert.equal(r.snapshot().feed, 'connecting');
        ws().open();
        assert.equal(r.snapshot().feed, 'connecting');
        ws().msg(frame(V));
        assert.equal(r.snapshot().feed, 'ok');
    });
    test('subscribes by genesis hash when the chain is listed, then fills the map; onChange fires', () => {
        const { r, ws, changes } = reader();
        r.start();
        handshake(ws());
        assert.deepEqual(ws().sent, ['subscribe:' + G]);
        const before = changes();
        ws().msg(frame([ACTION.SubscribedTo, G], [ACTION.TimeSync, 1], [ACTION.BestBlock, [1000, 1, null]], [ACTION.AddedNode, node(0, 'echo')], [ACTION.FinalizedBlock, [0, 998, HASH]]));
        assert.ok(changes() > before);
        const s = r.snapshot();
        assert.deepEqual([s.feed, s.subscribed, s.chainSeen, s.nodes.map(n => [n.name, n.best, n.finalized])], ['ok', true, true, [['echo', 1000, 998]]]);
    });
    test('pings every 30 s once open', () => {
        const { r, c, ws } = reader();
        r.start();
        handshake(ws());
        c.advance(PING_INTERVAL_MS);
        ws().msg(frame([ACTION.Pong, '1']));
        c.advance(PING_INTERVAL_MS);
        assert.deepEqual(ws().sent.filter(x => x.startsWith('ping:')), ['ping:1', 'ping:2']);
    });
    test('nothing for 60 s: closes, forgets the nodes, feed down (timeout), reconnects after 5 s', () => {
        const { r, c, ws } = reader();
        r.start();
        handshake(ws());
        ws().msg(frame([ACTION.SubscribedTo, G], [ACTION.AddedNode, node(0, 'foxtrot')]));
        const first = ws();
        c.advance(MESSAGE_TIMEOUT_MS - 1);
        assert.equal(first.closed, false, 'pings do not count as received');
        c.advance(1);
        assert.equal(first.closed, true);
        assert.deepEqual([r.snapshot().feed, r.snapshot().reason, r.snapshot().nodes.length], ['down', 'timeout', 0]);
        c.advance(BACKOFF_BASE_MS - 1);
        assert.equal(FakeWS.all.length, 1);
        c.advance(1);
        assert.equal(FakeWS.all.length, 2);
    });
    test('a message resets the 60 s timer', () => {
        const { r, c, ws } = reader();
        r.start();
        handshake(ws());
        c.advance(50_000);
        ws().msg(frame([ACTION.Pong, '1']));
        c.advance(50_000);
        assert.equal(ws().closed, false);
    });
    test('backoff: 5, 10, 20, 40, 80, 160 s, then 300 s at most', () => {
        const { r, c } = reader();
        r.start();
        const waits = [];
        for (let i = 0; i < 8; i++) {
            const n = FakeWS.all.length;
            FakeWS.all[n - 1].drop();
            let waited = 0;
            while (FakeWS.all.length === n) { c.advance(1000); waited += 1000; }
            waits.push(waited / 1000);
        }
        assert.deepEqual(waits, [5, 10, 20, 40, 80, 160, 300, 300]);
    });
    test('a connection that lived 60 s or more resets the backoff', () => {
        const { r, c, ws } = reader();
        r.start();
        for (let i = 0; i < 3; i++) { ws().drop(); c.advance(BACKOFF_MAX_MS); }
        handshake(ws());
        c.advance(59_000);
        ws().msg(frame([ACTION.Pong, '1']));
        c.advance(2_000);
        const n = FakeWS.all.length;
        ws().drop();
        c.advance(BACKOFF_BASE_MS);
        assert.equal(FakeWS.all.length, n + 1);
    });
    test('an unknown FEED_VERSION or the binary format: feed down (version), socket closed, retried only after 5 min', () => {
        for (const bad of [frame([ACTION.Version, FEED_VERSION + 1]), Buffer.from([0x00, 0x10, 0x20])]) {
            const { r, c, ws } = reader();
            r.start();
            ws().open();
            ws().msg(bad);
            assert.deepEqual([r.snapshot().feed, r.snapshot().reason, ws().closed], ['down', 'version', true]);
            c.advance(BACKOFF_MAX_MS - 1);
            assert.equal(FakeWS.all.length, 1);
            c.advance(1);
            assert.equal(FakeWS.all.length, 2);
        }
    });
    test('a malformed or oversize frame is dropped and counted; the connection stays', () => {
        const { r, ws } = reader({ maxFrameBytes: 4096 });
        r.start();
        handshake(ws());
        ws().msg('not json');
        ws().msg(Buffer.alloc(5000, 0x20));
        assert.deepEqual([ws().closed, r.stats().dropped, r.snapshot().feed], [false, 2, 'ok']);
    });
    test('a socket that cannot be created: feed down (error), retried', () => {
        const { r, c } = reader();
        FakeWS.throwNext = true;
        r.start();
        assert.deepEqual([r.snapshot().feed, r.snapshot().reason], ['down', 'error']);
        c.advance(BACKOFF_BASE_MS);
        assert.equal(FakeWS.all.length, 1);
    });
    test('error then close schedule one reconnect, not two', () => {
        const { r, c, ws } = reader();
        r.start();
        const w = ws();
        w.error(); w.drop();
        c.advance(BACKOFF_MAX_MS);
        assert.equal(FakeWS.all.length, 2);
    });
    test('stop(): closed, no timers left, never reconnects, feed off', () => {
        const { r, c, ws } = reader();
        r.start();
        handshake(ws());
        r.stop();
        assert.equal(ws().closed, true);
        assert.equal(c.pending(), 0);
        c.advance(BACKOFF_MAX_MS * 2);
        assert.deepEqual([FakeWS.all.length, r.snapshot().feed], [1, 'off']);
    });
    test('a throwing onChange listener does not break the reader', () => {
        const { r, ws } = reader({ onChange: () => { throw new Error('listener'); } });
        r.start();
        assert.doesNotThrow(() => handshake(ws()));
        assert.equal(r.snapshot().feed, 'ok');
    });
    test('backoffDelay: +/-20% jitter, never above the maximum', () => {
        assert.equal(backoffDelay(0, { random: () => 0 }), 4000);
        assert.equal(backoffDelay(0, { random: () => 1 }), 6000);
        assert.equal(backoffDelay(10, { random: () => 1 }), BACKOFF_MAX_MS);
        assert.equal(backoffDelay(1000, { random: () => 0.5 }), BACKOFF_MAX_MS);
    });
});

describe('telemetryConfig: off unless TELEMETRY_FEED_URL is set', () => {
    test('unset: off, with the reason', () => {
        assert.deepEqual(telemetryConfig({}), { enabled: false, url: '', genesis: G, reason: 'TELEMETRY_FEED_URL is not set' });
    });
    test("Parity's public feed (D3) and the Polkadex genesis by default", () => {
        assert.equal(PARITY_FEED_URL, 'wss://feed.telemetry.polkadot.io/feed');
        assert.deepEqual(telemetryConfig({ TELEMETRY_FEED_URL: PARITY_FEED_URL }), { enabled: true, url: PARITY_FEED_URL, genesis: G, reason: '' });
        assert.equal(G, '0x3920bcb4960a1eef5580cd5367ff3f430eef052774f78468852f7b9cb39f8a3c');
    });
    test('only ws:// or wss://; a genesis override must be a 32-byte hash', () => {
        assert.equal(telemetryConfig({ TELEMETRY_FEED_URL: 'https://feed.example.test/feed' }).enabled, false);
        assert.equal(telemetryConfig({ TELEMETRY_FEED_URL: 'not a url' }).enabled, false);
        assert.equal(telemetryConfig({ TELEMETRY_FEED_URL: 'wss://x.test/feed', TELEMETRY_GENESIS: '0x1234' }).enabled, false);
        assert.equal(telemetryConfig({ TELEMETRY_FEED_URL: 'wss://x.test/feed', TELEMETRY_GENESIS: OTHER.toUpperCase().replace('0X', '0x') }).genesis, OTHER);
    });
});

describe('the relay: one connection in the cluster primary, snapshots to the workers', () => {
    const snap = (over = {}) => ({ feed: 'ok', reason: '', at: 5, chainSeen: true, subscribed: true, nodes: [{ id: 1, name: 'golf', version: '7.0.0', best: 10, finalized: 8, peers: 4, validator: true, networkId: 'peer', updatedAt: 3, stale: false }], ...over });
    test('encode and decode round trip; decode refuses anything else and cleans names', () => {
        const back = decodeSnapshot(encodeSnapshot(snap()));
        assert.deepEqual(back, { feed: 'ok', reason: '', at: 5, chainSeen: true, subscribed: true, nodes: [{ name: 'golf', version: '7.0.0', best: 10, finalized: 8, peers: 4, validator: true, networkId: 'peer', updatedAt: 3, stale: false }] });
        for (const bad of [null, {}, { ...encodeSnapshot(snap()), type: 'other' }, { ...encodeSnapshot(snap()), v: 2 }, { ...encodeSnapshot(snap()), feed: 'great' }, { ...encodeSnapshot(snap()), nodes: 'x' }]) assert.equal(decodeSnapshot(bad), null);
        const m = encodeSnapshot(snap());
        m.nodes.push(['\u0007hotel‮', 'v', -1, 'x', 2.5, 0, 'p', 1, 0], 'junk', [''] );
        assert.deepEqual(decodeSnapshot(m).nodes.map(n => [n.name, n.best, n.finalized, n.peers]), [['golf', 10, 8, 4], ['hotel', null, null, null]]);
        assert.equal(decodeSnapshot(m, { maxNodes: 1 }).nodes.length, 1);
    });
    function fakeCluster() {
        const c = new EventEmitter();
        const w = (id) => ({ id, got: [], send(m) { this.got.push(m); } });
        c.workers = { 1: w(1), 2: w(2), 3: { id: 3, got: [], send() { throw new Error('exiting'); } } };
        return c;
    }
    function fakeReader() {
        const r = { started: 0, stopped: 0, opts: null, s: snap() };
        const create = (opts) => { r.opts = opts; return { start() { r.started++; }, stop() { r.stopped++; }, snapshot: () => r.s }; };
        return { r, create };
    }
    test('off: no reader is created', () => {
        const { r, create } = fakeReader();
        assert.equal(startTelemetryRelay({ config: telemetryConfig({}), cluster: fakeCluster(), createReader: create }), null);
        assert.equal(r.opts, null);
    });
    test('on: the reader starts; every worker gets the snapshot now, then every 5 s when changed, at least every 30 s; a failing worker does not stop the others', () => {
        const clock = fakeClock();
        const cluster = fakeCluster();
        const { r, create } = fakeReader();
        const relay = startTelemetryRelay({ config: telemetryConfig({ TELEMETRY_FEED_URL: 'wss://x.test/feed' }), cluster, createReader: create, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
        assert.equal(r.started, 1);
        assert.deepEqual([r.opts.url, r.opts.genesis], ['wss://x.test/feed', G]);
        const w1 = cluster.workers[1], w2 = cluster.workers[2];
        assert.deepEqual([w1.got.length, w2.got.length], [1, 1]);
        assert.equal(w1.got[0].type, TELEMETRY_MESSAGE);
        clock.advance(RELAY_INTERVAL_MS);
        assert.equal(w1.got.length, 1, 'nothing changed');
        r.opts.onChange();
        clock.advance(RELAY_INTERVAL_MS);
        assert.equal(w1.got.length, 2, 'changed: sent at the next tick');
        clock.advance(RELAY_HEARTBEAT_MS);
        assert.equal(w1.got.length, 3, 'the heartbeat');
        relay.stop();
        assert.equal(r.stopped, 1);
        assert.equal(clock.pending(), 0);
    });
    test("a worker that comes online gets the latest snapshot at once", () => {
        const clock = fakeClock();
        const cluster = fakeCluster();
        const { create } = fakeReader();
        startTelemetryRelay({ config: telemetryConfig({ TELEMETRY_FEED_URL: 'wss://x.test/feed' }), cluster, createReader: create, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
        const fresh = { id: 9, got: [], send(m) { this.got.push(m); } };
        cluster.emit('online', fresh);
        assert.equal(fresh.got.length, 1);
    });
    test('receiveTelemetry: connecting until the first snapshot; the snapshot; down when nothing came for 90 s; other messages ignored', () => {
        let t = 0;
        const proc = new EventEmitter();
        const rx = receiveTelemetry({ proc, now: () => t });
        assert.equal(rx.snapshot().feed, 'connecting');
        proc.emit('message', { type: 'something-else' });
        proc.emit('message', { type: TELEMETRY_MESSAGE, v: 1, feed: 'bogus' });
        assert.equal(rx.snapshot().feed, 'connecting');
        proc.emit('message', encodeSnapshot(snap()));
        assert.deepEqual([rx.snapshot().feed, rx.snapshot().nodes.length], ['ok', 1]);
        t += SNAPSHOT_STALE_MS + 1;
        assert.deepEqual([rx.snapshot().feed, rx.snapshot().reason, rx.snapshot().nodes.length], ['down', 'stale snapshot', 0]);
        rx.stop();
        assert.equal(proc.listenerCount('message'), 0);
    });
    test('startLocalTelemetry (WORKERS=1): off means nothing; on starts a reader in this process', () => {
        const { r, create } = fakeReader();
        assert.equal(startLocalTelemetry({ config: telemetryConfig({}), createReader: create }), null);
        const local = startLocalTelemetry({ config: telemetryConfig({ TELEMETRY_FEED_URL: 'wss://x.test/feed' }), createReader: create });
        assert.equal(r.started, 1);
        assert.equal(local.snapshot().feed, 'ok');
    });
});

describe('GET /api/telemetry/node', () => {
    let server, base, enabled = true, allow = true, snapshot = null, headCalls = 0, headValue = 1010, headFails = false, clock = 1_000_000;
    const SHORT = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
    const n = (name, over = {}) => ({ name, version: '7.0.0-566b080ba1a', best: 1008, finalized: 1006, peers: 6, validator: false, networkId: '12D3KooWPeer' + name, updatedAt: clock - 4000, stale: false, ...over });
    let release = undefined;
    before(async () => {
        const app = express();
        registerTelemetryRoute(app, {
            enabled: () => enabled,
            source: () => snapshot,
            head: async () => { headCalls++; if (headFails) throw new Error('rpc down'); return headValue; },
            rateOk: () => allow,
            cacheShort: (res) => res.set('Cache-Control', SHORT),
            serverError: (res) => { res.set('Cache-Control', 'no-store'); res.status(500).json({ error: 'Internal error.' }); },
            release: () => release,
            now: () => clock
        });
        await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => { if (server) server.close(); });
    const get = async (q) => { const r = await fetch(base + TELEMETRY_NODE_ROUTE + q); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }; };

    test('route and name rules', () => {
        assert.equal(TELEMETRY_NODE_ROUTE, '/api/telemetry/node');
        assert.equal(NAME_MAX, 64);
        assert.deepEqual(parseNodeName('  india  '), { ok: true, name: 'india' });
        for (const bad of [undefined, ['a', 'b'], '', '   ', 'x'.repeat(65), 'tab\there', 'bell\u0007']) assert.equal(parseNodeName(bad).code, 'BAD_NAME', JSON.stringify(bad));
        assert.equal(parseNodeName('x'.repeat(64)).ok, true);
    });
    test('400 BAD_NAME for a missing, empty, too long or control-character name; no-store', async () => {
        for (const q of ['', '?name=', '?name=%20%20', '?name=' + 'y'.repeat(65), '?name=a%07b', '?name=a&name=b']) {
            const r = await get(q);
            assert.equal(r.status, 400, q);
            assert.equal(r.body.code, 'BAD_NAME');
            assert.equal(r.cache, 'no-store');
        }
    });
    test('429 when rate limited; no-store', async () => {
        allow = false;
        const r = await get('?name=juliet');
        allow = true;
        assert.deepEqual([r.status, r.body.code, r.cache], [429, 'RATE_LIMITED', 'no-store']);
    });
    test('telemetry switched off (TELEMETRY_FEED_URL unset): feed off, nothing else breaks', async () => {
        enabled = false;
        const r = await get('?name=kilo');
        enabled = true;
        assert.equal(r.status, 200);
        assert.deepEqual({ ...r.body, release: undefined }, { feed: 'off', name: 'kilo', feedHost: null, head: null, release: undefined, count: 0, nodes: [], similar: [] });
        assert.deepEqual(r.body.release, { state: 'pending', version: null });
    });
    test('no snapshot yet: connecting; feed down: no nodes served even if the snapshot had some', async () => {
        snapshot = null;
        assert.equal((await get('?name=lima')).body.feed, 'connecting');
        snapshot = { feed: 'down', reason: 'closed', at: clock, nodes: [n('lima')] };
        const r = await get('?name=lima');
        assert.deepEqual([r.body.feed, r.body.nodes, r.body.count], ['down', [], 0]);
    });
    test('found: one node, blocks behind the explorer head, seconds since the feed last said anything; Short tier', async () => {
        snapshot = { feed: 'ok', subscribed: true, at: clock, nodes: [n('mike'), n('november', { best: 900 })] };
        const r = await get('?name=%20mike%20');
        assert.equal(r.status, 200);
        assert.equal(r.cache, SHORT);
        assert.deepEqual(r.body, { feed: 'ok', name: 'mike', feedHost: null, head: 1010, release: { state: 'pending', version: null }, count: 1, similar: [],
            nodes: [{ name: 'mike', version: '7.0.0-566b080ba1a', best: 1008, finalized: 1006, peers: 6, validator: false, networkId: '12D3KooWPeermike', stale: false, secondsAgo: 4, behind: 2, versionVsRelease: null }] });
    });
    test('the version against a published release', async () => {
        release = { version: '7.0.1', binaryUrl: 'https://github.com/Polkadex-Substrate/polkadex-node/releases/download/v7.0.1/polkadex-node', binarySha256: 'a'.repeat(64),
            image: 'docker.io/polkadex/polkadex-node:7.0.1@sha256:' + 'b'.repeat(64), chainSpecUrl: 'https://github.com/Polkadex-Substrate/polkadex-node/releases/download/v7.0.1/customSpecRaw.json', chainSpecSha256: 'c'.repeat(64),
            releaseNotesUrl: 'https://github.com/Polkadex-Substrate/polkadex-node/releases/tag/v7.0.1' };
        snapshot = { feed: 'ok', subscribed: true, at: clock, nodes: [n('oscar')] };
        const r = await get('?name=oscar');
        release = undefined;
        assert.deepEqual(r.body.release, { state: 'published', version: '7.0.1' });
        assert.equal(r.body.nodes[0].versionVsRelease, 'older');
    });
    test('several nodes with the name; at most 10 served, count says how many', async () => {
        snapshot = { feed: 'ok', subscribed: true, at: clock, nodes: Array.from({ length: 12 }, () => n('papa')) };
        const r = await get('?name=papa');
        assert.deepEqual([r.body.count, r.body.nodes.length], [12, 10]);
    });
    test('not found: similar names', async () => {
        snapshot = { feed: 'ok', subscribed: true, at: clock, nodes: [n('quebec-1'), n('quebec-2'), n('romeo')] };
        const r = await get('?name=quebec');
        assert.deepEqual([r.body.count, r.body.nodes, r.body.similar, r.body.head], [0, [], ['quebec-1', 'quebec-2'], null]);
    });
    test('the head is the explorer node\'s, kept 5 s; unreadable: head and behind null, still 200', async () => {
        snapshot = { feed: 'ok', subscribed: true, at: clock, nodes: [n('sierra')] };
        clock += 10_000;
        snapshot.nodes[0].updatedAt = clock;
        headCalls = 0;
        await get('?name=sierra'); await get('?name=sierra');
        assert.equal(headCalls, 1);
        clock += 6_000;
        headFails = true;
        const r = await get('?name=sierra');
        headFails = false;
        assert.deepEqual([r.status, r.body.head, r.body.nodes[0].behind], [200, null, null]);
    });
});

describe('Fable finding 1: the feed is not ready until SubscribedTo and the node list have arrived', () => {
    test('reader: Version only is feed ok but not subscribed; SubscribedTo plus AddedNode is; a reconnect resets it', () => {
        const { r, c, ws } = reader();
        r.start();
        ws().open();
        ws().msg(frame(V));
        assert.deepEqual([r.snapshot().feed, r.snapshot().subscribed, r.snapshot().nodes.length], ['ok', false, 0]);
        ws().msg(frame([ACTION.TelemetryInfo, { git_hash: 'abc' }], [ACTION.AddedChain, ['Polkadex', G, 2]]));
        assert.equal(r.snapshot().subscribed, false, 'subscribe sent, SubscribedTo not yet received');
        ws().msg(frame([ACTION.SubscribedTo, G], [ACTION.AddedNode, node(0, 'tango')]));
        assert.deepEqual([r.snapshot().subscribed, r.snapshot().nodes.map(n => n.name)], [true, ['tango']]);
        ws().drop();
        assert.deepEqual([r.snapshot().feed, r.snapshot().subscribed], ['down', false]);
        c.advance(BACKOFF_BASE_MS);
        ws().open();
        ws().msg(frame(V));
        assert.deepEqual([r.snapshot().feed, r.snapshot().subscribed, r.snapshot().nodes.length], ['ok', false, 0]);
    });
    test('relay: the flag crosses the process boundary; a message without it decodes as not subscribed; no snapshot yet is not subscribed', () => {
        const base = { feed: 'ok', reason: '', at: 5, chainSeen: true, nodes: [] };
        assert.equal(encodeSnapshot({ ...base, subscribed: true }).subscribed, true);
        assert.equal(encodeSnapshot({ ...base, subscribed: false }).subscribed, false);
        assert.equal(decodeSnapshot(encodeSnapshot({ ...base, subscribed: true })).subscribed, true);
        assert.equal(decodeSnapshot(encodeSnapshot({ ...base, subscribed: false })).subscribed, false);
        const old = encodeSnapshot({ ...base, subscribed: true }); delete old.subscribed;
        assert.equal(decodeSnapshot(old).subscribed, false);
        const proc = new EventEmitter();
        const rx = receiveTelemetry({ proc, now: () => 0 });
        assert.equal(rx.snapshot().subscribed, false);
    });
    describe('route', () => {
        let server, base, snapshot = null;
        const nn = (name) => ({ name, version: '7.0.0', best: 10, finalized: 8, peers: 5, validator: false, networkId: 'p' + name, updatedAt: 1_000_000 - 1000, stale: false });
        before(async () => {
            const app = express();
            registerTelemetryRoute(app, { enabled: true, source: () => snapshot, head: async () => 12, cacheShort: (res) => res.set('Cache-Control', 'public, max-age=5'),
                serverError: (res) => res.status(500).json({}), now: () => 1_000_000, feedHost: 'telemetry.example.org' });
            await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
            base = `http://127.0.0.1:${server.address().port}`;
        });
        after(() => { if (server) server.close(); });
        const get = async (q) => { const r = await fetch(base + TELEMETRY_NODE_ROUTE + q); return { cache: r.headers.get('cache-control'), body: await r.json() }; };
        test('feed ok but not subscribed: connecting, no nodes, never cached as a miss; subscribed: found; reconnect: connecting again', async () => {
            snapshot = { feed: 'ok', subscribed: false, at: 1_000_000, nodes: [nn('uniform')] };
            let r = await get('?name=uniform');
            assert.deepEqual([r.body.feed, r.body.count, r.body.nodes, r.body.similar, r.cache], ['connecting', 0, [], [], 'no-store']);
            snapshot = { feed: 'ok', subscribed: true, at: 1_000_000, nodes: [nn('uniform')] };
            r = await get('?name=uniform');
            assert.deepEqual([r.body.feed, r.body.count, r.body.nodes[0].name, r.cache], ['ok', 1, 'uniform', 'public, max-age=5']);
            snapshot = { feed: 'ok', subscribed: false, at: 1_000_000, nodes: [] };
            assert.equal((await get('?name=uniform')).body.feed, 'connecting');
        });
        test('the feed host the guide names is the configured one', async () => {
            snapshot = { feed: 'ok', subscribed: true, at: 1_000_000, nodes: [] };
            assert.equal((await get('?name=victor')).body.feedHost, 'telemetry.example.org');
        });
    });
});

describe('Fable finding 3: the feed host is derived from the configured URL', () => {
    test('telemetryHostName: the host without the feed. label; nothing for an unusable URL', () => {
        assert.equal(telemetryHostName(PARITY_FEED_URL), 'telemetry.polkadot.io');
        assert.equal(telemetryHostName('wss://feed.telemetry.example.org/feed'), 'telemetry.example.org');
        assert.equal(telemetryHostName('ws://127.0.0.1:8000/feed'), '127.0.0.1');
        assert.equal(telemetryHostName('wss://telemetry.example.org/feed'), 'telemetry.example.org');
        for (const bad of ['', 'nope', undefined, null]) assert.equal(telemetryHostName(bad), null);
    });
});
