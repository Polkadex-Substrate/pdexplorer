// GET /api/telemetry/node?name=NAME (design section 6, "Check my node").
//
// Answers from the in-memory snapshot of the Polkadex chain on the telemetry
// feed (lib/telemetry-relay.js): the nodes whose --name is NAME (exact, else
// the same name in another case), with best and finalized block, peers, client
// version, the GRANDPA flag, the libp2p peer id and how long ago the feed last
// said anything about the node. When nothing matches, up to five similar names
// (names containing NAME). Plus the explorer's own chain head (from its RPC
// node, not from telemetry, where heights are self-declared) for the sync
// gap, and the official release from lib/validator-node-release.js.
//
//   200  { feed: 'ok' | 'down' | 'connecting' | 'off', name, feedHost, head, release,
//          count, nodes: [...], similar: [...] }       Short cache tier
//   400  BAD_NAME (empty, longer than 64, control characters)   no-store
//   429  RATE_LIMITED (TELEMETRY_LOOKUP_PER_MIN per IP)           no-store
//
// 'ok' is only reported once the feed has said SubscribedTo for the chain (its
// node list arrives with it). Before that, after every reconnect, a real node
// would read "Not found", so the answer is 'connecting' and is not cached.
//
// The browser never contacts telemetry; this route is how it learns anything
// about it. Node names are untrusted text: cleaned here, escaped by the view.

import { findNodes, cleanText } from './telemetry-feed.js';
import { NODE_RELEASE, releaseState, compareNodeVersion } from './validator-node-release.js';
import { NAME_MAX } from './node-check.js';

export const TELEMETRY_NODE_ROUTE = '/api/telemetry/node';
export { NAME_MAX };
export const HEAD_TTL_MS = 5_000;
export const HEAD_TIMEOUT_MS = 3_000;

// The ?name= value: { ok: true, name } or { ok: false, code, error }.
export function parseNodeName(raw) {
    const bad = (error) => ({ ok: false, code: 'BAD_NAME', error });
    if (typeof raw !== 'string') return bad('Give the node name, the value of --name.');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) return bad('A node name has no control characters.');
    const name = raw.trim();
    if (!name) return bad('Give the node name, the value of --name.');
    if (name.length > NAME_MAX) return bad(`A node name is at most ${NAME_MAX} characters.`);
    return { ok: true, name };
}

const noStore = (res) => res.set('Cache-Control', 'no-store');

// enabled and release may be values or functions (read per request).
export function registerTelemetryRoute(app, { enabled, source, head, rateOk = () => true, cacheShort, serverError, release = NODE_RELEASE, feedHost = null, now = () => Date.now() }) {
    const isOn = typeof enabled === 'function' ? enabled : () => !!enabled;
    const hostNow = () => (typeof feedHost === 'function' ? feedHost() : feedHost) || null;
    const releaseNow = () => (typeof release === 'function' ? release() : release) || NODE_RELEASE;
    let headMemo = null, headAt = 0, headInflight = null;
    // The chain head from the explorer's own node, kept 5 s; null when it cannot be read in 3 s.
    async function chainHead() {
        if (headMemo != null && now() - headAt < HEAD_TTL_MS) return headMemo;
        if (!headInflight) {
            headInflight = Promise.race([
                Promise.resolve().then(() => head()),
                new Promise((resolve) => { const t = setTimeout(() => resolve(null), HEAD_TIMEOUT_MS); if (t.unref) t.unref(); })
            ]).then((h) => {
                const v = Number.isSafeInteger(h) && h >= 0 ? h : null;
                if (v != null) { headMemo = v; headAt = now(); }
                return v;
            }, () => null).finally(() => { headInflight = null; });
        }
        return headInflight;
    }

    app.get(TELEMETRY_NODE_ROUTE, async (req, res) => {
        const parsed = parseNodeName(req.query.name);
        if (!parsed.ok) { noStore(res); return res.status(400).json({ code: parsed.code, error: parsed.error }); }
        if (!rateOk(req)) { noStore(res); return res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many lookups from this address. Wait a minute and try again.' }); }
        const name = cleanText(parsed.name, NAME_MAX);
        const relData = releaseNow();
        const rs = releaseState(relData);
        const rel = { state: rs.published ? 'published' : 'pending', version: rs.published ? relData.version : null };
        try {
            if (!isOn()) {
                cacheShort(res);
                return res.json({ feed: 'off', name, feedHost: hostNow(), head: null, release: rel, count: 0, nodes: [], similar: [] });
            }
            const snap = (typeof source === 'function' ? source() : null) || { feed: 'connecting', nodes: [], at: now() };
            const connecting = snap.feed === 'ok' && snap.subscribed !== true;
            const feedState = connecting ? 'connecting' : snap.feed;
            const feedOk = feedState === 'ok';
            const found = feedOk ? findNodes(snap.nodes, name) : { matches: [], similar: [], count: 0 };
            const h = feedOk && found.count ? await chainHead() : null;
            const t = now();
            const nodes = found.matches.map(n => ({
                name: n.name, version: n.version, best: n.best, finalized: n.finalized, peers: n.peers,
                validator: !!n.validator, networkId: n.networkId, stale: !!n.stale,
                secondsAgo: Number.isFinite(n.updatedAt) ? Math.max(0, Math.round((t - n.updatedAt) / 1000)) : null,
                behind: h != null && n.best != null ? Math.max(0, h - n.best) : null,
                versionVsRelease: rel.version ? compareNodeVersion(n.version, rel.version) : null
            }));
            if (connecting) noStore(res); else cacheShort(res);
            res.json({ feed: feedState, name, feedHost: hostNow(), head: h, release: rel, count: found.count, nodes, similar: found.similar });
        } catch (err) { serverError(res, err, req.path); }
    });
}
