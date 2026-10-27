#!/usr/bin/env node
//
// Link council motion discussion threads to the democracy proposal they
// queued, now, instead of waiting for the backend's next democracy tick. The
// repair for a motion thread whose proposal_hash is empty (motion #140 on
// 2026-10-27: its posts did not show under "Earlier discussion" on the
// referendum it became).
//
// How: a motion that queued an external proposal has the call
// democracy.externalPropose*(B), and B is the same bounded call the external
// proposal and the referendum carry. So the motion's hash is recomputed from B
// with the running runtime's call encoding, and a motion thread with that hash
// gets B's proposal hash. Same code as the backend
// (lib/discussion-threads.js linkMotionThreadsByCallHash). Only empty
// proposal_hash values are filled; a thread holding a different hash is
// reported, never changed.
//
// B comes from the chain: every ongoing referendum and the queued external
// proposal, plus any referendum named with --referendum (a finished one is
// read from the state one block before it ended, which needs an archive node).
//
// Dry run by default: the database is opened READ-ONLY and nothing is written.
// --apply writes the links and clears those threads' retired backfill
// attempts. Safe to repeat.
//
// Usage, on the explorer box (inside the backend container, so it sees the
// same DATA_DIR and POLKADEX_WS):
//   docker compose exec backend node --experimental-sqlite tools/link-motion-threads.mjs
//   docker compose exec backend node --experimental-sqlite tools/link-motion-threads.mjs --apply
//
//   --referendum  comma-separated referendum indices to read even if finished
//   --ws          RPC endpoint; defaults to the first of $POLKADEX_WS, then
//                 wss://rpc.polkadex.ee
//   --data-dir    defaults to $DATA_DIR, then ./data

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { linkMotionThreadsByCallHash } from '../lib/discussion-threads.js';
import { proposalHashOf, normalizeHash } from '../lib/discussion-lifecycle.js';

export const ATTEMPTS_KEY = 'discussion:motion-hash-attempts';

// The two thread reads/writes the linker needs, over a node:sqlite handle.
export function sqliteThreadStore(sqlite) {
    return {
        getThread(id) {
            const r = sqlite.prepare('SELECT id, kind, title, status, proposal_hash FROM discussion_threads WHERE id = ?').get(id);
            return r ? { id: r.id, kind: r.kind, title: r.title, status: r.status, proposalHash: r.proposal_hash ?? null } : null;
        },
        setThreadProposalHash(id, hash) {
            if (!hash) return false;
            const r = sqlite.prepare('UPDATE discussion_threads SET proposal_hash = ? WHERE id = ? AND proposal_hash IS NULL').run(String(hash).toLowerCase(), id);
            return Number(r.changes) > 0;
        }
    };
}

export function linkMotionThreads(store, items, makeCall, { apply = false } = {}) {
    return linkMotionThreadsByCallHash(store, items, makeCall, { apply });
}

function readKv(sqlite, key) {
    const row = sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch (_) { return null; }
}

// Every motion thread with no proposal hash, with what the backend knows about
// it: the collective_motions rows for its hash, the first resolving event, the
// posts, and how many backfill tries it has used (3 = retired).
export function motionThreadDiagnostics(sqlite) {
    const attempts = readKv(sqlite, ATTEMPTS_KEY) || {};
    const threads = sqlite.prepare(`SELECT t.id, t.ref_key AS hash, t.title, t.status,
            (SELECT COUNT(*) FROM discussion_posts p WHERE p.thread_id = t.id) AS posts
        FROM discussion_threads t WHERE t.kind = 'motion' AND t.proposal_hash IS NULL ORDER BY t.created_at`).all();
    const motions = sqlite.prepare(`SELECT collective, motion_index AS motionIndex, section, method, proposed_block AS proposedBlock
        FROM collective_motions WHERE hash = ? ORDER BY motion_index`);
    const resolved = sqlite.prepare('SELECT MIN(block) AS b FROM collective_motion_events WHERE hash = ?');
    return threads.map(t => ({
        id: t.id, hash: t.hash, title: t.title, status: t.status, posts: Number(t.posts),
        attempts: Number(attempts[t.id] || 0),
        motions: motions.all(t.hash).map(m => ({ ...m })),
        resolvedBlock: resolved.get(t.hash).b ?? null
    }));
}

// Drop the backfill's try counter for threads that are now linked.
export function clearAttempts(sqlite, ids) {
    const attempts = readKv(sqlite, ATTEMPTS_KEY);
    if (!attempts || !ids.length) return;
    let changed = false;
    for (const id of ids) if (id in attempts) { delete attempts[id]; changed = true; }
    if (changed) sqlite.prepare('INSERT OR REPLACE INTO kv(key, value, updated_at) VALUES(?,?,?)').run(ATTEMPTS_KEY, JSON.stringify(attempts), Date.now());
}

// The bounded calls to recompute from: ongoing referenda, the queued external
// proposal, and the named referenda at the block before they ended.
async function chainItems(api, extraIndices, blake2AsHex) {
    const dem = api.query.democracy;
    const items = [];
    const push = (bounded, source) => {
        const proposalHash = proposalHashOf(bounded, blake2AsHex);
        if (proposalHash) items.push({ proposalHash, bounded, source });
    };
    for (const [key, opt] of await dem.referendumInfoOf.entries()) {
        if (!opt || !opt.isSome || !opt.unwrap().isOngoing) continue;
        push(opt.unwrap().asOngoing.proposal, `referendum #${key.args[0].toString()}`);
    }
    if (dem.nextExternal) {
        const ne = await dem.nextExternal();
        if (ne && ne.isSome) push(ne.unwrap()[0], 'the external proposal');
    }
    for (const index of extraIndices) {
        const opt = await dem.referendumInfoOf(index);
        if (!opt || !opt.isSome) { console.log(`referendum #${index}: not in storage, skipped`); continue; }
        const info = opt.unwrap();
        if (info.isOngoing) continue;   // already read above
        const end = info.asFinished.end.toNumber();
        try {
            const hist = await dem.referendumInfoOf.at(await api.rpc.chain.getBlockHash(end - 1), index);
            if (hist && hist.isSome && hist.unwrap().isOngoing) push(hist.unwrap().asOngoing.proposal, `referendum #${index} (finished, state at ${end - 1})`);
            else console.log(`referendum #${index}: no ongoing state at ${end - 1}, skipped`);
        } catch (e) {
            console.log(`referendum #${index}: state at ${end - 1} not readable (${e.message}); this needs an archive node`);
        }
    }
    return items;
}

async function main(argv) {
    const flag = (name, fallback = null) => {
        const eq = argv.find(a => a.startsWith(name + '='));
        if (eq) return eq.slice(name.length + 1) || fallback;
        const i = argv.indexOf(name);
        return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
    };
    const has = (name) => argv.includes(name);
    const die = (msg) => { console.error(msg); process.exit(1); };
    if (has('--help') || has('-h')) {
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n')
            .filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
        return;
    }
    const apply = has('--apply');
    const dataDir = flag('--data-dir', process.env.DATA_DIR || './data');
    const dbPath = path.join(dataDir, 'explorer.db');
    if (!fs.existsSync(dbPath)) die(`No database at ${dbPath}. Pass --data-dir, or set DATA_DIR.`);
    const extra = String(flag('--referendum', '') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (extra.some(s => !/^\d+$/.test(s))) die('--referendum takes referendum indices, e.g. --referendum 36');
    const ws = flag('--ws', String(process.env.POLKADEX_WS || 'wss://rpc.polkadex.ee').split(',').map(s => s.trim()).filter(Boolean)[0]);

    const sqlite = new DatabaseSync(dbPath, { readOnly: !apply });
    sqlite.exec('PRAGMA busy_timeout = 5000');
    console.log(apply ? 'APPLY: links will be written.' : 'DRY RUN: database opened read-only, nothing is written. Add --apply to write.');

    const diag = motionThreadDiagnostics(sqlite);
    console.log(`\nMotion threads with no proposal hash: ${diag.length}`);
    for (const d of diag) {
        const m = d.motions.map(x => `${x.collective} #${x.motionIndex} ${x.section || '?'}.${x.method || '?'} proposed at ${x.proposedBlock ?? 'unknown'}`).join('; ') || 'no collective_motions row';
        console.log(`  ${d.id} [${d.status}, ${d.posts} posts] ${d.title || ''}\n      ${m}; first resolving event ${d.resolvedBlock ?? 'unknown'}; backfill tries ${d.attempts}/3`);
    }

    const { ApiPromise, WsProvider } = await import('@polkadot/api');
    const { blake2AsHex } = await import('@polkadot/util-crypto');
    const provider = new WsProvider(ws, false);
    await provider.connect();
    const api = await ApiPromise.create({ provider, throwOnConnect: true });
    try {
        const items = await chainItems(api, extra.map(Number), blake2AsHex);
        console.log(`\nDemocracy items read from ${ws}: ${items.length}`);
        for (const it of items) console.log(`  ${it.source}: proposal hash ${it.proposalHash}`);
        const d = api.tx.democracy;
        const makeCall = (method, bounded) => (d && typeof d[method] === 'function' ? d[method](bounded).method : null);
        const result = linkMotionThreads(sqliteThreadStore(sqlite), items, makeCall, { apply });
        console.log(`\n${apply ? 'Result' : 'Plan'}:`);
        if (!result.length) console.log('  nothing to link (every matching motion thread already has its hash, or none matches).');
        for (const r of result) {
            const related = sqlite.prepare('SELECT id FROM discussion_threads WHERE proposal_hash = ? AND id != ?').all(normalizeHash(r.proposalHash), r.id).map(x => x.id);
            const tail = r.status === 'conflict' ? ` (thread holds ${r.current}; left as it is)` : '';
            console.log(`  ${r.status}: ${r.id} -> ${r.proposalHash} from ${r.source}; shares it with ${related.join(', ') || 'no other thread yet'}${tail}`);
        }
        if (apply) clearAttempts(sqlite, result.filter(r => r.status === 'linked').map(r => r.id));
    } finally {
        await api.disconnect();
        sqlite.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch(e => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}
