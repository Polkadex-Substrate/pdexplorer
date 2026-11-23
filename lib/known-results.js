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
// Every entry ages out at maxAgeMs (10 min): an overlay never outlives a bound, so it can never hide a row
// for good.

const OPS = new Set(['remove', 'hold', 'reorg', 'set']);
const valid = (e) => !!e && typeof e === 'object' && OPS.has(e.op) && typeof e.domain === 'string' && e.key != null && typeof e.savedAt === 'number';

export function createKnownResults({ storage = null, now = Date.now, maxAgeMs = 600_000, holdMs = 180_000,
    key = 'pdex_known_results', maxEntries = 200, listen = null, same = (a, b) => a === b } = {}) {
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
    const fresh = (list) => { const t = now(); return list.filter(e => t - e.savedAt < maxAgeMs); };
    function emit(ev) { for (const fn of Array.from(listeners)) { try { fn(ev); } catch (e) { /* a listener never breaks the store */ } } }

    if (typeof listen === 'function') {
        try { listen((ev) => { if (ev && ev.key != null && ev.key !== key) return; emit({ origin: 'other-tab', reason: 'storage' }); }); } catch (e) { /* no storage event: single tab */ }
    }

    const api = {
        maxAgeMs, holdMs, key,
        add(entries) {
            const t = now();
            const incoming = (entries || []).filter(e => e && OPS.has(e.op) && e.domain && e.key != null).map(e => ({
                id: `k${t.toString(36)}${(++seq).toString(36)}`, account: e.account == null ? null : e.account, domain: e.domain, op: e.op,
                key: String(e.key), value: e.value === undefined ? null : e.value, block: e.block == null ? null : e.block,
                txHash: e.txHash == null ? null : String(e.txHash), savedAt: t }));
            if (!incoming.length) return;
            const tx = new Set(incoming.filter(e => e.op !== 'reorg' && e.txHash).map(e => e.txHash));
            let list = fresh(load()).filter(old => !incoming.some(n => n.domain === old.domain && n.key === old.key && sameAccount(n.account, old.account))
                && !(old.op === 'reorg' && tx.has(old.key)));
            list = [...list, ...incoming];
            if (list.length > maxEntries) list = list.slice().sort((a, b) => a.savedAt - b.savedAt).slice(-maxEntries);
            save(list);
            emit({ origin: 'self', reason: 'add' });
        },
        withdraw(txHash, reason = 'failed') {
            if (txHash == null) return;
            const h = String(txHash);
            const before = load();
            const list = fresh(before).filter(e => e.txHash !== h && !(e.op === 'reorg' && e.key === h));
            if (list.length !== before.length) save(list);
            emit({ origin: 'self', reason });
        },
        list(domain, account) {
            return fresh(load()).filter(e => e.domain === domain && sameAccount(e.account, account));
        },
        // rows: the server's list; keyOf(row) its key. Returns the rows with proven removals filtered out,
        // and what was applied, held, expired (a hold past its bound while the server still lists the row)
        // and the active reorg marker, if any.
        apply(domain, account, rows, { keyOf } = {}) {
            const t = now();
            const list = api.list(domain, account);
            const src = Array.isArray(rows) ? rows : [];
            const k = typeof keyOf === 'function' ? keyOf : (r) => r && r.key;
            const present = new Set(src.map(r => String(k(r))));
            const byKey = new Map(list.filter(e => e.op !== 'reorg').map(e => [e.key, e]));
            const removed = [], held = [], expired = [];
            for (const e of byKey.values()) {
                if (!present.has(e.key)) continue;
                if (e.op === 'remove') removed.push(e);
                else if (e.op === 'hold') (t - e.savedAt < holdMs ? held : expired).push(e);
            }
            const gone = new Set(removed.map(e => e.key));
            const marker = list.filter(e => e.op === 'reorg' && t - e.savedAt < holdMs).sort((a, b) => b.savedAt - a.savedAt)[0] || null;
            return { rows: src.filter(r => !gone.has(String(k(r)))), removed, held, expired, reorg: marker };
        },
        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    };
    return api;
}
