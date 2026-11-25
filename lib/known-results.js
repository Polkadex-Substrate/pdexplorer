// What a block PROVED, kept until the server catches up (design 2.3 and 4; UX U7, U10, U12, U13; hook H1).
// Import-free, no DOM. Backed by localStorage so a reload inside the lag window and a second open tab agree;
// when storage is missing, refused or throwing (private mode, quota) it degrades to memory without an error.
//
// entry: { id, account, domain, op, key, value, block, txHash, savedAt }
//   op 'remove': the row is proven gone (a paid era); filtered out of the server's list.
//   op 'hold':   the row was touched without proof (skipped, or paged out); held out of the next payout for
//                holdMs, then "expired" (the list may be behind) until maxAgeMs, then gone.
//   op 'reorg':  the transaction's block was replaced (Retracted); key is the txHash, value the action noun.
//                Active for holdMs at most; cleared when the same transaction is added again.
//   op 'set':    a proven field value (identity name, council role); R3 and R4 use it.
//   op 'notice': R6, a server action the server CONFIRMED (a label saved, a post made, a sign-in): no overlay,
//                only a signal to the OTHER open tabs (lib/post-action.js server()). value is the signed-in
//                address that made it. Never applied, listed or bounded; not scoped to a genesis (the server's
//                data is the same on any node); kept noticeMs (1 min) and at most maxNotices, and never
//                evicts a proof: over maxEntries the notices go first.
// Every entry stops applying at maxAgeMs (10 min): an overlay never outlives a bound, so it can never hide a
// row for good. A 'remove' is then kept lapseMs longer (default another 10 min) without hiding anything: if
// the server still lists that proven-paid row, the row comes back marked as possibly behind (expired), never
// silently (R2, review follow-up F7). An entry saved "in the future" (the clock was set back) counts as
// expired, so a clock change never stretches a bound. Aged entries are pruned from storage when the store is
// created.
//
// R2, freshness: apply() may be given the server's freshness and caughtUp(domain, freshness, block)
// (lib/freshness.js). Then a hold ends as soon as the server has caught up with its block (listed: a normal
// row again; not listed: gone), a remove the caught-up server still lists is reported `lagging` (still kept
// out: it is proven paid), and an entry whose block the server has not reached after lateMs (the poll
// deadline) is reported `late`. Without them the answer is exactly R1's.
//
// genesis (optional): () => the connected chain's genesis hash, or null while it is not known. When given,
// every entry is stamped with it and only entries of the current genesis apply: one from another network on
// the same origin (a testnet reset, a node switch) never does. While the genesis is unknown nothing applies
// and nothing is pruned; prune() drops the other networks' entries once it is known.

const OPS = new Set(['remove', 'hold', 'reorg', 'set', 'notice']);
const valid = (e) => !!e && typeof e === 'object' && OPS.has(e.op) && typeof e.domain === 'string' && e.key != null && typeof e.savedAt === 'number';

export function createKnownResults({ storage = null, now = Date.now, maxAgeMs = 600_000, holdMs = 180_000, lapseMs = maxAgeMs,
    key = 'pdex_known_results', maxEntries = 200, listen = null, same = (a, b) => a === b, genesis = null, noticeMs = 60_000, maxNotices = 20 } = {}) {
    let mem = [];
    let useStorage = true;
    let seq = 0;
    const listeners = new Set();
    const store = () => { try { return typeof storage === 'function' ? storage() : storage; } catch (e) { return null; } };
    const sameAccount = (a, b) => { if (a == null || b == null) return a == null && b == null; try { return a === b || !!same(a, b); } catch (e) { return false; } };

    function load() {
        if (!useStorage) return mem;
        const s = store();
        if (!s) { useStorage = false; return mem; }
        let raw;
        try { raw = s.getItem(key); } catch (e) { useStorage = false; return mem; }
        if (raw == null) { mem = []; return mem; }
        try { const parsed = JSON.parse(raw); mem = Array.isArray(parsed) ? parsed.filter(valid) : []; } catch (e) { mem = []; }
        return mem;
    }
    function save(list) {
        mem = list;
        if (!useStorage) return;
        const s = store();
        if (!s) { useStorage = false; return; }
        try { s.setItem(key, JSON.stringify(list)); } catch (e) { useStorage = false; }
    }
    const net = () => { if (typeof genesis !== 'function') return undefined; try { const g = genesis(); return g == null ? null : String(g); } catch (e) { return null; } };
    // In age (never from the future) and, with a genesis, of the current network.
    const aged = (e, t) => e.savedAt > t || t - e.savedAt >= (e.op === 'remove' ? maxAgeMs + Math.max(0, Number(lapseMs) || 0) : e.op === 'notice' ? Math.min(maxAgeMs, noticeMs) : maxAgeMs);
    const isNotice = (e) => e.op === 'notice';
    const inForce = (e, t) => e.savedAt <= t && t - e.savedAt < maxAgeMs;
    const ofNet = (list) => { const g = net(); return list.filter(e => !isNotice(e) && (g === undefined || (g !== null && e.genesis === g))); };
    // Retained (a lapsed remove included) and of the current network.
    const retained = (list) => { const t = now(); return ofNet(list.filter(e => !aged(e, t))); };
    // Still applying.
    const fresh = (list) => { const t = now(); return retained(list).filter(e => inForce(e, t)); };
    // What storage keeps: in age, and of the current network once it is known (unknown: other networks kept).
    const keep = (list) => { const t = now(), g = net(); return list.filter(e => !aged(e, t) && (g == null || isNotice(e) || e.genesis === g)); };
    // The proofs only (no notice), as stored: what another tab's write changed besides its notices.
    const proofsOf = (raw) => { try { const p = JSON.parse(raw); return Array.isArray(p) ? JSON.stringify(p.filter(e => !(e && e.op === 'notice'))) : null; } catch (e) { return null; } };
    const onlyNotices = (ev) => { if (!ev || typeof ev.newValue !== 'string') return false; const a = proofsOf(ev.oldValue == null ? '[]' : ev.oldValue), b = proofsOf(ev.newValue); return a !== null && a === b; };
    function emit(ev) { for (const fn of Array.from(listeners)) { try { fn(ev); } catch (e) { /* a listener never breaks the store */ } } }

    if (typeof listen === 'function') {
        try { listen((ev) => { if (ev && ev.key != null && ev.key !== key) return; emit({ origin: 'other-tab', reason: onlyNotices(ev) ? 'notice' : 'storage' }); }); } catch (e) { /* no storage event: single tab */ }
    }

    const api = {
        maxAgeMs, holdMs, lapseMs, key,
        add(entries) {
            const t = now();
            const g = net();
            // The network is not known: a proof could not be scoped to it (a notice needs no network).
            const incoming = (entries || []).filter(e => e && OPS.has(e.op) && e.domain && e.key != null && (g !== null || e.op === 'notice')).map(e => ({
                id: `k${t.toString(36)}${(++seq).toString(36)}`, account: e.account == null ? null : e.account, domain: e.domain, op: e.op,
                key: String(e.key), value: e.value === undefined ? null : e.value, block: e.block == null ? null : e.block,
                txHash: e.txHash == null ? null : String(e.txHash), savedAt: t, ...(g == null || e.op === 'notice' ? {} : { genesis: g }) }));
            if (!incoming.length) return;
            const tx = new Set(incoming.filter(e => e.op !== 'reorg' && e.txHash).map(e => e.txHash));
            let list = keep(load()).filter(old => !incoming.some(n => n.domain === old.domain && n.key === old.key && sameAccount(n.account, old.account))
                && !(old.op === 'reorg' && tx.has(old.key)));
            list = [...list, ...incoming];
            const byAge = (a, b) => a.savedAt - b.savedAt;
            let proofs = list.filter(e => !isNotice(e)), notes = list.filter(isNotice).sort(byAge).slice(-Math.max(0, maxNotices));
            if (proofs.length > maxEntries) proofs = proofs.sort(byAge).slice(-maxEntries);
            const room = Math.max(0, maxEntries - proofs.length);
            notes = room ? notes.slice(-room) : [];
            list = [...proofs, ...notes];
            save(list);
            emit({ origin: 'self', reason: 'add' });
        },
        withdraw(txHash, reason = 'failed') {
            if (txHash == null) return;
            const h = String(txHash);
            const before = load();
            const list = keep(before).filter(e => e.txHash !== h && !(e.op === 'reorg' && e.key === h));
            if (list.length !== before.length) save(list);
            emit({ origin: 'self', reason });
        },
        list(domain, account) {
            return fresh(load()).filter(e => e.domain === domain && sameAccount(e.account, account));
        },
        // R6: the server actions other tabs confirmed in the last noticeMs, oldest first (any network).
        notices() {
            const t = now();
            return load().filter(e => isNotice(e) && !aged(e, t)).sort((a, b) => a.savedAt - b.savedAt);
        },
        // rows: the server's list; keyOf(row) its key. Returns the rows with proven removals filtered out,
        // and what was applied, held, expired (a hold past its bound while the server still lists the row)
        // and the active reorg marker, if any.
        apply(domain, account, rows, { keyOf, freshness, caughtUp, lateMs } = {}) {
            const t = now();
            const all = retained(load()).filter(e => e.domain === domain && sameAccount(e.account, account));
            const list = all.filter(e => inForce(e, t));
            const src = Array.isArray(rows) ? rows : [];
            const k = typeof keyOf === 'function' ? keyOf : (r) => r && r.key;
            const present = new Set(src.map(r => String(k(r))));
            const judged = typeof caughtUp === 'function';
            const caught = (e) => { if (!judged || e.block == null) return false; try { return !!caughtUp(domain, freshness, e.block); } catch (err) { return false; } };
            const lateBound = judged && Number.isFinite(Number(lateMs)) && Number(lateMs) > 0 ? Number(lateMs) : null;
            const byKey = new Map(all.filter(e => e.op !== 'reorg').map(e => [e.key, e]));
            const removed = [], held = [], expired = [], lagging = [], late = [], ended = [];
            for (const e of byKey.values()) {
                const live = inForce(e, t);
                if (live && lateBound !== null && (e.op === 'remove' || e.op === 'hold') && e.block != null && t - e.savedAt >= lateBound && !caught(e)) late.push(e);
                if (!present.has(e.key)) continue;
                if (e.op === 'remove') {
                    if (!live) { expired.push(e); continue; }   // F7: lapsed while the server still lists it
                    removed.push(e);
                    if (caught(e)) lagging.push(e);
                } else if (e.op === 'hold' && live) {
                    if (caught(e)) { ended.push(e); continue; }
                    (t - e.savedAt < holdMs ? held : expired).push(e);
                }
            }
            const gone = new Set(removed.map(e => e.key));
            const marker = list.filter(e => e.op === 'reorg' && e.savedAt <= t && t - e.savedAt < holdMs).sort((a, b) => b.savedAt - a.savedAt)[0] || null;
            return { rows: src.filter(r => !gone.has(String(k(r)))), removed, held, expired, lagging, late, ended, reorg: marker };
        },
        // The earliest time a hold or reorg entry of the current network reaches its hold bound, or null.
        // The core arms its one deadline from this, so a bound repaints after a reload or a hidden tab too.
        nextBound() {
            const t = now();
            const ends = fresh(load()).filter(e => e.op === 'hold' || e.op === 'reorg').map(e => e.savedAt + holdMs).filter(at => at > t);
            return ends.length ? Math.min(...ends) : null;
        },
        // Drop aged entries, and other networks' entries once the genesis is known, from storage.
        prune() {
            const before = load();
            const list = keep(before);
            if (list.length !== before.length) save(list);
        },
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    };
    api.prune();   // F7: aged entries do not wait for the next write
    return api;
}
