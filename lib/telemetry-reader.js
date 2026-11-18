// One outbound WebSocket to a Substrate telemetry feed (D3: server side only),
// kept alive the way the official client keeps it (frontend/src/Connection.ts
// in paritytech/substrate-telemetry): binary frames as ArrayBuffer, a ping
// every 30 s, reconnect when nothing has arrived for 60 s, backoff from 5 s
// doubling to 5 min. The node map is lib/telemetry-feed.js.
//
// It never throws into its caller: a bad URL, a refused connection, a frame
// that is not the protocol, a FEED_VERSION it does not know, all end in
// feed 'down' with a reason and a scheduled reconnect. A version it does not
// know waits the longest backoff before trying again (the feed will not change
// in 5 s, and the explorer has to be updated for it).
//
// Everything with a clock or a socket is injected so the tests drive it with a
// fake WebSocket and fake timers (test/telemetry.test.js).

import { createNodeStore, decodeFrame, LIMITS, POLKADEX_GENESIS } from './telemetry-feed.js';

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 300_000;
export const MESSAGE_TIMEOUT_MS = 60_000;
export const PING_INTERVAL_MS = 30_000;
export const HEALTHY_AFTER_MS = 60_000;   // a connection that lived this long resets the backoff

// Delay before reconnect attempt n (0 based), with +/-20% jitter.
export function backoffDelay(attempt, { base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS, random = Math.random } = {}) {
    const raw = Math.min(base * 2 ** Math.max(0, Math.min(attempt, 30)), max);
    return Math.min(max, Math.round(raw * (0.8 + 0.4 * random())));
}

export function createTelemetryReader({
    url, genesis = POLKADEX_GENESIS, WebSocketImpl = globalThis.WebSocket,
    setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(), random = Math.random,
    onChange = () => {}, log = () => {}, maxNodes = LIMITS.maxNodes, maxFrameBytes = LIMITS.maxFrameBytes
} = {}) {
    const store = createNodeStore({ genesis, maxNodes, now });
    let ws = null, state = 'idle', reason = '', attempt = 0, okAt = null, stopped = false;
    let retryTimer = null, idleTimer = null, pingTimer = null, pingId = 0, frames = 0, dropped = 0;

    const notify = () => { try { onChange(); } catch (e) { /* a listener's problem, not ours */ } };
    const setState = (s, r = '') => { if (s !== state || r !== reason) { state = s; reason = r; notify(); } };
    const clear = (t) => { if (t) { try { clearTimer(t); } catch (e) { /* gone */ } } return null; };
    const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };

    function send(text) {
        try { if (ws) ws.send(text); } catch (e) { /* closing; the close handler reconnects */ }
    }

    function armIdle() {
        idleTimer = clear(idleTimer);
        idleTimer = unref(setTimer(() => { log('telemetry: nothing received for 60 s, reconnecting'); drop('timeout'); }, MESSAGE_TIMEOUT_MS));
    }
    function armPing() {
        pingTimer = clear(pingTimer);
        pingTimer = unref(setTimer(() => { pingId += 1; send('ping:' + pingId); armPing(); }, PING_INTERVAL_MS));
    }

    function schedule(delay) {
        retryTimer = clear(retryTimer);
        if (stopped) return;
        retryTimer = unref(setTimer(() => { retryTimer = null; connect(); }, delay));
    }

    // Close this socket (if any), forget its nodes, and try again later.
    function drop(why, { longest = false } = {}) {
        const sock = ws;
        ws = null;
        idleTimer = clear(idleTimer);
        pingTimer = clear(pingTimer);
        if (sock) {
            try { sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null; } catch (e) { /* frozen */ }
            try { sock.close(); } catch (e) { /* already closed */ }
        }
        if (okAt != null && now() - okAt >= HEALTHY_AFTER_MS) attempt = 0;
        okAt = null;
        store.reset();
        if (stopped) return;
        setState('down', why);
        const delay = longest ? BACKOFF_MAX_MS : backoffDelay(attempt, { random });
        attempt += 1;
        schedule(delay);
    }

    function onMessage(ev) {
        armIdle();
        frames += 1;
        const f = decodeFrame(ev && ev.data, { maxBytes: maxFrameBytes });
        if (!f.ok) {
            if (f.reason === 'binary-format') { log('telemetry: binary feed format, the explorer needs an update'); drop('version', { longest: true }); return; }
            dropped += 1;
            return;
        }
        let r;
        try { r = store.apply(f.messages); } catch (e) { dropped += 1; return; }
        if (r.versionMismatch) { log('telemetry: unknown feed version, the explorer needs an update'); drop('version', { longest: true }); return; }
        if (store.status().version != null && state !== 'ok') { okAt = now(); setState('ok'); }
        for (const cmd of r.send) send(cmd);
        if (r.changed) notify();
    }

    function connect() {
        if (stopped) return;
        setState('connecting');
        let sock;
        try {
            sock = new WebSocketImpl(url);
        } catch (e) {
            log('telemetry: cannot open ' + (e && e.message ? e.message : 'the socket'));
            drop('error');
            return;
        }
        ws = sock;
        try { sock.binaryType = 'arraybuffer'; } catch (e) { /* not settable */ }
        sock.onopen = () => { if (ws === sock) { armIdle(); armPing(); } };
        sock.onmessage = (ev) => { if (ws === sock) onMessage(ev); };
        sock.onclose = () => { if (ws === sock) drop('closed'); };
        sock.onerror = () => { if (ws === sock) drop('error'); };
    }

    return {
        start() { stopped = false; if (!ws && !retryTimer) connect(); },
        stop() {
            stopped = true;
            retryTimer = clear(retryTimer);
            drop('stopped');
            state = 'off'; reason = '';
        },
        // What the API serves: feed state, the nodes, and when this was taken.
        snapshot() {
            const s = store.status();
            return { feed: state === 'ok' ? 'ok' : state === 'idle' ? 'connecting' : state, reason, at: now(), chainSeen: s.chainSeen, subscribed: s.subscribed, nodes: store.list() };
        },
        stats: () => ({ state, reason, attempt, frames, dropped, ...store.status() })
    };
}
