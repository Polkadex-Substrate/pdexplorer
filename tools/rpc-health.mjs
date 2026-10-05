#!/usr/bin/env node
// Is the Polkadex RPC load balancer — and every node behind it — actually healthy?
//
//   node tools/rpc-health.mjs                         # LB + the known origins
//   node tools/rpc-health.mjs wss://a wss://b ...     # any endpoints you name
//   node tools/rpc-health.mjs --lb-probes 16          # sample the LB harder
//   node tools/rpc-health.mjs --json                  # machine-readable, for cron
//
// Exits 0 when everything passes, 1 when anything fails — so it can sit in cron
// or an uptime monitor as-is. No dependencies: Node >= 22 ships WebSocket.
//
// WHY THIS IS MORE THAN "CAN I CONNECT"
//
// A load balancer is designed to hide a broken backend. A request to
// rpc.polkadex.ee proves that ONE node answered, once. It does not prove the
// others are up, and it does not prove the one that answered is current. Four
// ways a node can look healthy to a naive check while serving users bad data:
//
//   1. FROZEN. Answers every call instantly, but its best block stopped moving
//      an hour ago. Only visible by sampling twice and comparing.
//   2. BEHIND. Synced to a head 200 blocks old because it lost peers. Wallets
//      on it see stale balances and build transactions against old state.
//   3. WRONG CHAIN. A misconfigured node on a different chain spec answers
//      every method correctly. Only the genesis hash gives it away.
//   4. PRUNED where it should be ARCHIVE. Fine for current state; fails every
//      historical query the explorer makes (old events, old referenda).
//
// So each endpoint is checked for all four, and the LB is additionally sampled
// over several connections, using system_localPeerId to see WHICH backend each
// connection landed on — that is the only way to inspect nodes you cannot
// reach directly.

const DEFAULT_ENDPOINTS = [
    'wss://rpc.polkadex.ee',                    // Cloudflare LB — what users hit
    'wss://so.polkadex.ee',                     // origins, as last recorded;
    'wss://polkadex-rpc.faradaynodes.com',      // pass your own list if changed
];
const LB = 'wss://rpc.polkadex.ee';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const JSON_OUT = args.includes('--json');
const LB_PROBES = Number(flag('--lb-probes', 8));
const SAMPLE_GAP_MS = Number(flag('--wait', 20_000));        // > one block, so a live head MUST move
const CALL_TIMEOUT_MS = Number(flag('--timeout', 10_000));
const MAX_BEHIND = Number(flag('--max-behind', 3));           // blocks behind the best node seen
const MAX_FINALITY_LAG = Number(flag('--max-finality-lag', 20));
const endpoints = args.filter((a, i) => /^wss?:\/\//.test(a) && !/^--/.test(args[i - 1] || ''));
const targets = endpoints.length ? endpoints : DEFAULT_ENDPOINTS;

// ─── minimal JSON-RPC over WebSocket ─────────────────────────────────────────
function connect(url) {
    return new Promise((resolve, reject) => {
        const t0 = performance.now();
        let ws;
        try { ws = new WebSocket(url); } catch (e) { return reject(e); }
        const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('connect timeout')); }, CALL_TIMEOUT_MS);
        const pending = new Map();
        let id = 0;
        ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            const p = pending.get(m.id); if (!p) return;
            pending.delete(m.id); clearTimeout(p.timer);
            m.error ? p.reject(new Error(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result);
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('connection refused / TLS / DNS failure')); };
        ws.onopen = () => {
            clearTimeout(timer);
            const connectMs = performance.now() - t0;
            const call = (method, params = []) => new Promise((res, rej) => {
                const myId = ++id;
                const timer = setTimeout(() => { pending.delete(myId); rej(new Error(`${method} timed out`)); }, CALL_TIMEOUT_MS);
                pending.set(myId, { resolve: res, reject: rej, timer });
                ws.send(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }));
            });
            resolve({ call, close: () => { try { ws.close(); } catch {} }, connectMs });
        };
    });
}
const num = (hex) => parseInt(hex, 16);

async function snapshot(url) {
    const c = await connect(url);
    try {
        const t0 = performance.now();
        const [chain, version, peerId, genesis, health, best, finHash, rt] = await Promise.all([
            c.call('system_chain'), c.call('system_version'), c.call('system_localPeerId'),
            c.call('chain_getBlockHash', [0]), c.call('system_health'),
            c.call('chain_getHeader'), c.call('chain_getFinalizedHead'), c.call('state_getRuntimeVersion'),
        ]);
        const rpcMs = performance.now() - t0;
        const fin = await c.call('chain_getHeader', [finHash]);

        // Archive probe: runtime version AT block 1. A pruned node discarded
        // that state and errors ("State already discarded" or similar).
        let archive = null, archiveErr = null;
        try {
            const h1 = await c.call('chain_getBlockHash', [1]);
            await c.call('state_getRuntimeVersion', [h1]);
            archive = true;
        } catch (e) { archive = false; archiveErr = e.message; }

        return {
            url, ok: true, connectMs: Math.round(c.connectMs), rpcMs: Math.round(rpcMs),
            chain, version, peerId, genesis, specVersion: rt.specVersion,
            peers: health.peers, isSyncing: health.isSyncing,
            best: num(best.number), finalized: num(fin.number), archive, archiveErr,
        };
    } finally { c.close(); }
}

async function probe(url) {
    try { return await snapshot(url); }
    catch (e) { return { url, ok: false, error: e.message }; }
}

// ─── run ─────────────────────────────────────────────────────────────────────
const failures = [];
const fail = (who, why) => failures.push(`${who}: ${why}`);

const first = await Promise.all(targets.map(probe));
await new Promise(r => setTimeout(r, SAMPLE_GAP_MS));
const second = await Promise.all(targets.map(probe));

// LB fan-out: several fresh connections, each may land on a different backend.
const lbSamples = targets.includes(LB) && LB_PROBES > 0
    ? await Promise.all(Array.from({ length: LB_PROBES }, () => probe(LB)))
    : [];

const live = [...first, ...second, ...lbSamples].filter(s => s.ok);
const bestSeen = Math.max(0, ...live.map(s => s.best));
const genesisVotes = {};
for (const s of live) genesisVotes[s.genesis] = (genesisVotes[s.genesis] || 0) + 1;
const canonicalGenesis = Object.entries(genesisVotes).sort((a, b) => b[1] - a[1])[0]?.[0];
const specVotes = {};
for (const s of live) specVotes[s.specVersion] = (specVotes[s.specVersion] || 0) + 1;
const canonicalSpec = Number(Object.entries(specVotes).sort((a, b) => b[1] - a[1])[0]?.[0]);

function judge(s, label) {
    if (!s.ok) { fail(label, `unreachable — ${s.error}`); return; }
    if (s.genesis !== canonicalGenesis) fail(label, `WRONG CHAIN — genesis ${s.genesis.slice(0, 12)}… differs from the majority`);
    if (s.specVersion !== canonicalSpec) fail(label, `runtime spec ${s.specVersion}, others run ${canonicalSpec} — missed or premature upgrade`);
    if (s.isSyncing) fail(label, 'still syncing');
    if (s.peers < 1) fail(label, 'zero peers — isolated, cannot receive new blocks');
    if (bestSeen - s.best > MAX_BEHIND) fail(label, `BEHIND — best #${s.best}, ${bestSeen - s.best} blocks behind the best node seen`);
    if (s.best - s.finalized > MAX_FINALITY_LAG) fail(label, `finality lagging by ${s.best - s.finalized} blocks (GRANDPA stalled?)`);
}

const rows = targets.map((url, i) => {
    const a = first[i], b = second[i];
    judge(b.ok ? b : a, url);
    let moved = null;
    if (a.ok && b.ok) {
        moved = b.best - a.best;
        if (moved <= 0) fail(url, `FROZEN — best block did not move in ${SAMPLE_GAP_MS / 1000}s (stuck at #${b.best})`);
    }
    return { url, first: a, second: b, moved };
});

const backends = {};
for (const s of lbSamples) {
    if (!s.ok) { fail(`${LB} (fan-out)`, `a connection failed — ${s.error}`); continue; }
    (backends[s.peerId] ||= []).push(s);
}
for (const [peer, list] of Object.entries(backends)) {
    const worst = list.reduce((w, s) => (s.best < w.best ? s : w));
    judge(worst, `${LB} → backend …${peer.slice(-8)}`);
}

// ─── report ──────────────────────────────────────────────────────────────────
if (JSON_OUT) {
    console.log(JSON.stringify({ ok: failures.length === 0, bestSeen, canonicalGenesis, canonicalSpec, rows, lbBackends: backends, failures }, null, 2));
} else {
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`\nPolkadex RPC health — best block seen #${bestSeen}, spec ${canonicalSpec}, genesis ${canonicalGenesis?.slice(0, 14)}…\n`);
    console.log(pad('endpoint', 40) + pad('best', 11) + pad('moved', 7) + pad('final', 11) + pad('peers', 6) + pad('archive', 9) + 'latency');
    for (const r of rows) {
        const s = r.second.ok ? r.second : r.first;
        if (!s.ok) { console.log(pad(r.url, 40) + `DOWN — ${s.error}`); continue; }
        console.log(pad(r.url, 40) + pad('#' + s.best, 11) + pad(r.moved == null ? '?' : '+' + r.moved, 7) +
            pad('#' + s.finalized, 11) + pad(s.peers, 6) + pad(s.archive ? 'yes' : 'PRUNED', 9) +
            `${s.connectMs}ms + ${s.rpcMs}ms`);
    }
    if (lbSamples.length) {
        console.log(`\nLoad balancer fan-out: ${lbSamples.length} connections landed on ${Object.keys(backends).length} distinct backend(s)`);
        for (const [peer, list] of Object.entries(backends)) {
            const s = list[0];
            console.log(`  …${peer.slice(-8)}  ×${list.length}  best #${Math.min(...list.map(x => x.best))}  peers ${s.peers}  ${s.version}  archive ${s.archive ? 'yes' : 'PRUNED'}`);
        }
        if (Object.keys(backends).length === 1 && targets.length > 2) {
            console.log('  note: every connection hit ONE backend. Either the pool has one healthy member,');
            console.log('        or the LB uses session affinity — try --lb-probes 32 to be sure.');
        }
    }
    console.log(failures.length ? `\nFAIL (${failures.length}):\n  - ${failures.join('\n  - ')}\n` : '\nPASS — every endpoint is on the right chain, current, moving and finalizing.\n');
}
process.exit(failures.length ? 1 : 0);
