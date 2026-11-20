// The explorer's identity cache: bounded, expiring, invalidated by chain events.
//
// The bug this replaces: server.js kept every identity lookup in a plain Map
// with no expiry and nothing ever deleted from it, including the "Unknown"
// answer. A validator stash looked up before its on-chain identity was set
// stayed "Unknown" on the validator list, validator page and account page until
// the backend restarted, and a later identity change or clear never showed.
//
// What this module does instead:
//   - expiry: "no identity" lives 5 minutes, a found name 1 hour;
//   - events: the indexer sees the identity pallet's events and drops the
//     account (and, for a parent, every cached sub-identity) at once;
//   - cluster: the indexer is one worker among several, each with its own
//     cache, so an invalidation goes worker -> primary -> every other worker;
//   - bounds: at most IDENTITY_CACHE_MAX entries, least recently used evicted
//     first (a read refreshes recency, so names that are asked for all the time,
//     such as the validators', outlive one-off public account lookups; plain LRU
//     is enough, a pinned set would need the validator list in here), and the
//     parent index is pruned with the entries so it cannot outgrow them;
//   - one read: concurrent misses for an account share one in-flight chain read,
//     and an invalidation that lands mid-read stops that result being stored;
//   - errors: a read has three outcomes, found / none (confirmed no identity) /
//     failed. A failed read is never cached as an answer and never reported as
//     "no identity": when an expired name is known it is served stale and retried
//     after a short backoff, otherwise the caller is told the read failed.
//
// Pure of express, SQLite and the api handle (the chain reader is injected), so
// it is testable without booting the server.

export const IDENTITY_TTL_UNKNOWN_MS = 5 * 60 * 1000;
export const IDENTITY_TTL_FOUND_MS = 60 * 60 * 1000;
export const IDENTITY_CACHE_MAX = 5000;
export const IDENTITY_STALE_BACKOFF_MS = 30 * 1000;
export const IDENTITY_MESSAGE = 'pdex-identity-invalidate';
const MAX_ACCOUNTS_PER_MESSAGE = 500;
const MAX_ADDRESS_LEN = 200;
const UNKNOWN = 'Unknown';

// Identity pallet events that can change what an account is called or whether
// it is verified. Positions of the account(s) in the event data, per the 393
// metadata: IdentitySet(who) IdentityCleared(who,deposit) IdentityKilled(who,
// deposit) JudgementRequested/Unrequested(who,registrar) JudgementGiven(target,
// registrar) SubIdentityAdded/Removed/Revoked/Renamed(sub,main[,deposit])
// SubIdentitiesSet(main,count,deposit). The 373 mainnet runtime has a subset.
const EVENT_ACCOUNT_SLOTS = {
    IdentitySet: [0], IdentityCleared: [0], IdentityKilled: [0],
    JudgementRequested: [0], JudgementUnrequested: [0], JudgementGiven: [0],
    SubIdentityAdded: [0, 1], SubIdentityRemoved: [0, 1], SubIdentityRevoked: [0, 1], SubIdentityRenamed: [0, 1],
    SubIdentitiesSet: [0]
};
export const IDENTITY_EVENT_METHODS = Object.keys(EVENT_ACCOUNT_SLOTS);

// The accounts whose cached identity an array of event records makes stale.
export function identityEventAccounts(records) {
    const out = new Set();
    for (const rec of records || []) {
        const ev = rec && rec.event;
        if (!ev || String(ev.section).toLowerCase() !== 'identity') continue;
        const slots = EVENT_ACCOUNT_SLOTS[ev.method];
        if (!slots || !ev.data) continue;
        for (const i of slots) {
            const v = ev.data[i];
            if (v === undefined || v === null) continue;
            const s = String(v.toString());
            if (s) out.add(s);
        }
    }
    return [...out];
}

export function createIdentityCache({ ttlFoundMs = IDENTITY_TTL_FOUND_MS, ttlUnknownMs = IDENTITY_TTL_UNKNOWN_MS, max = IDENTITY_CACHE_MAX, now = Date.now } = {}) {
    const entries = new Map();        // key -> { value, expiresAt, parent, negative, stale }, oldest use first
    const subsOf = new Map();         // parent -> Set(sub keys)
    const lastKnown = new Map();      // key -> { value, parent }: expired found names, for stale-while-error

    function unindex(key, parent) {
        if (!parent) return;
        const set = subsOf.get(parent);
        if (!set) return;
        set.delete(key);
        if (!set.size) subsOf.delete(parent);
    }
    function remove(key) {
        const e = entries.get(key);
        if (!e) return false;
        entries.delete(key);
        unindex(key, e.parent);
        return true;
    }
    function keepLastKnown(key, e) {
        lastKnown.delete(key);
        lastKnown.set(key, { value: e.value, parent: e.parent });
        while (lastKnown.size > max) lastKnown.delete(lastKnown.keys().next().value);
    }
    function put(key, value, parent, negative, stale, ttl) {
        remove(key);
        lastKnown.delete(key);
        entries.set(key, { value, parent, negative, stale, expiresAt: now() + ttl });
        if (parent) {
            if (!subsOf.has(parent)) subsOf.set(parent, new Set());
            subsOf.get(parent).add(key);
        }
        while (entries.size > max) remove(entries.keys().next().value);
    }
    // A live entry, touched (moved to most recently used); an expired found
    // name moves to lastKnown; anything else expired is dropped.
    function live(key) {
        const e = entries.get(key);
        if (!e) return undefined;
        if (e.expiresAt <= now()) {
            remove(key);
            if (!e.negative) keepLastKnown(key, e);
            return undefined;
        }
        entries.delete(key);
        entries.set(key, e);
        return e;
    }

    return {
        get(key) {
            const e = live(key);
            return e ? e.value : undefined;
        },
        // { value, status: 'found' | 'none' | 'stale' } for a live entry.
        getEntry(key) {
            const e = live(key);
            if (!e) return undefined;
            return { value: e.value, status: e.stale ? 'stale' : (e.negative ? 'none' : 'found') };
        },
        getLastKnown(key) {
            const k = lastKnown.get(key);
            return k ? { value: k.value, parent: k.parent } : undefined;
        },
        set(key, value, { parent = null, negative = value === UNKNOWN } = {}) {
            put(key, value, parent, negative, false, negative ? ttlUnknownMs : ttlFoundMs);
        },
        // Serve an expired name a little longer after a failed refresh read.
        setStale(key, value, { parent = null, backoffMs = IDENTITY_STALE_BACKOFF_MS } = {}) {
            put(key, value, parent, false, true, backoffMs);
        },
        // Drop the accounts and every cached sub-identity of them (and the last
        // known names, so a cleared identity is never served stale). Returns the
        // accounts asked for plus the subs found, for the derived-name refresh.
        invalidate(keys) {
            const affected = new Set();
            const asked = new Set();
            for (const k of keys || []) {
                const key = String(k);
                asked.add(key);
                affected.add(key);
                remove(key);
                lastKnown.delete(key);
                const subs = subsOf.get(key);
                if (subs) for (const s of [...subs]) { affected.add(s); remove(s); lastKnown.delete(s); }
            }
            for (const [key, k] of [...lastKnown]) {
                if (k.parent && asked.has(k.parent)) { affected.add(key); lastKnown.delete(key); }
            }
            return [...affected];
        },
        size: () => entries.size,
        lastKnownSize: () => lastKnown.size,
        indexSize() { let n = 0; for (const s of subsOf.values()) n += s.size; return n; }
    };
}

// getIdentity as server.js uses it: cache, in-flight sharing, override policy.
//   readChain(api, address, { onParent, onError }) -> display name | 'Unknown'
//   overrides  Map(address -> label) used only when the chain has no name
// resolve() answers { name, status } with status one of
//   found   the chain (or cache of it) has a name
//   none    the read succeeded and there is no identity (name may be an override)
//   failed  the read did not complete; name is only a display fallback, and
//           callers that store names must not store it
//   stale   the read failed but an expired name is known; name is that name
// getIdentity() is resolve() reduced to the name.
export function createIdentityResolver({ cache, readChain, overrides = new Map(), warn = () => {} }) {
    const inflight = new Map();   // key -> { promise, stale }

    async function load(api, address, key, rec) {
        let parent = null, errored = false;
        const name = await readChain(api, address, {
            onParent: (p) => { parent = String(p); },
            onError: (e, addr) => { errored = true; warn(e, addr); }
        });
        if (errored) {
            // Never cached as an answer. A known expired name is served again for
            // a short backoff instead of "Unknown"; an invalidation cleared it.
            const lk = rec.stale ? undefined : cache.getLastKnown(key);
            if (lk) {
                cache.setStale(key, lk.value, { parent: lk.parent });
                return { name: lk.value, status: 'stale' };
            }
            return { name: overrides.get(key) || UNKNOWN, status: 'failed' };
        }
        const found = name !== UNKNOWN;
        const value = found ? name : (overrides.get(key) || UNKNOWN);
        // A result that an invalidation overtook while it was in flight is
        // stale, so not stored.
        if (!rec.stale) cache.set(key, value, { parent, negative: !found });
        return { name: value, status: found ? 'found' : 'none' };
    }

    function resolve(api, address) {
        const key = address.toString();
        const hit = cache.getEntry(key);
        if (hit !== undefined) return Promise.resolve({ name: hit.value, status: hit.status });
        // An unusable api (reconnect window) answers without caching, so a
        // blip cannot pin Unknown for an account that has an identity.
        if (!api || !api.query || !api.query.identity) {
            const lk = cache.getLastKnown(key);
            if (lk) return Promise.resolve({ name: lk.value, status: 'stale' });
            return Promise.resolve({ name: overrides.get(key) || UNKNOWN, status: 'failed' });
        }
        const running = inflight.get(key);
        if (running) return running.promise;
        const rec = { stale: false, promise: null };
        rec.promise = load(api, address, key, rec).finally(() => { if (inflight.get(key) === rec) inflight.delete(key); });
        inflight.set(key, rec);
        return rec.promise;
    }

    return {
        resolve,
        async getIdentity(api, address) { return (await resolve(api, address)).name; },
        invalidate(addresses) {
            const affected = cache.invalidate(addresses);
            for (const key of affected) {
                const rec = inflight.get(key);
                if (rec) { rec.stale = true; inflight.delete(key); }
            }
            return affected;
        },
        inflightCount: () => inflight.size
    };
}

// What crossed the process boundary, checked: the account list, or null.
export function decodeInvalidation(m) {
    if (!m || m.type !== IDENTITY_MESSAGE || m.v !== 1 || !Array.isArray(m.accounts)) return null;
    if (m.accounts.length > MAX_ACCOUNTS_PER_MESSAGE) return null;
    if (!m.accounts.every(a => typeof a === 'string' && a.length > 0 && a.length <= MAX_ADDRESS_LEN)) return null;
    return m.accounts;
}

// In any process: invalidate locally, and tell the primary (when this is a
// cluster worker with an IPC channel) so it can tell the other workers.
export function createIdentityInvalidator({ resolver, proc = process, onAffected } = {}) {
    return {
        invalidate(addresses) {
            const list = [...new Set((addresses || []).map(String))].slice(0, MAX_ACCOUNTS_PER_MESSAGE);
            if (!list.length) return [];
            const affected = resolver.invalidate(list);
            if (proc && typeof proc.send === 'function' && proc.connected !== false) {
                try { proc.send({ type: IDENTITY_MESSAGE, v: 1, accounts: list }); } catch (e) { /* channel closing */ }
            }
            if (onAffected) onAffected(affected);
            return affected;
        }
    };
}

// In the primary: forward a worker's invalidation to every other worker.
export function startIdentityRelay({ cluster }) {
    const onMessage = (worker, m) => {
        const accounts = decodeInvalidation(m);
        if (!accounts) return;
        for (const w of Object.values((cluster && cluster.workers) || {})) {
            if (!w || (worker && w.id === worker.id)) continue;
            try { if (w.isConnected ? w.isConnected() : true) w.send({ type: IDENTITY_MESSAGE, v: 1, accounts }); } catch (e) { /* worker exiting */ }
        }
    };
    cluster.on('message', onMessage);
    return { stop() { cluster.off('message', onMessage); } };
}

// In a worker: apply the primary's invalidations. Local only, never echoed.
export function receiveIdentityInvalidations({ proc = process, resolver }) {
    const onMessage = (m) => {
        const accounts = decodeInvalidation(m);
        if (accounts) resolver.invalidate(accounts);
    };
    proc.on('message', onMessage);
    return { stop() { if (typeof proc.off === 'function') proc.off('message', onMessage); } };
}

// Re-resolve the given accounts and write the names into the stored copies
// (validators table, holders table). setters: [(address, name) -> rowsChanged].
// getName returns a name string, or { name, status } from resolver.resolve; a
// "failed" or "stale" read writes nothing, so a good stored name is kept.
// One failing account does not stop the rest. Returns the rows changed.
export async function refreshDerivedNames(addresses, { getName, setters }) {
    let changed = 0;
    for (const address of addresses || []) {
        try {
            const res = await getName(address);
            let name = res;
            if (res && typeof res === 'object') {
                if (res.status === 'failed' || res.status === 'stale') continue;
                name = res.name;
            }
            for (const set of setters) changed += Number(set(address, name)) || 0;
        } catch (e) { /* leave this one for the periodic sync */ }
    }
    return changed;
}

// Bursts of identity events become one refresh of the union of accounts.
//   delayMs     quiet period; every add restarts it
//   maxWaitMs   the flush happens at most this long after the first pending
//               item, however many more arrive (a steady stream cannot starve it)
//   maxPending  distinct accounts held; past it the set is dropped and refreshAll
//               runs once instead (omit refreshAll to leave the set unbounded)
export function createDebouncedRefresher({ refresh, refreshAll, delayMs = 2000, maxWaitMs = 5000, maxPending = 2000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let pending = new Set(), overflow = false, quiet = null, maxTimer = null;
    const arm = (fn, ms) => {
        const t = setTimer(fn, ms);
        if (t && typeof t.unref === 'function') t.unref();
        return t;
    };
    async function flush() {
        if (quiet) { clearTimer(quiet); quiet = null; }
        if (maxTimer) { clearTimer(maxTimer); maxTimer = null; }
        if (!pending.size && !overflow) return;
        const list = [...pending], all = overflow;
        pending = new Set(); overflow = false;
        try { if (all) await refreshAll(); else await refresh(list); } catch (e) { /* the periodic sync still covers it */ }
    }
    return {
        add(addresses) {
            for (const a of addresses || []) {
                if (overflow) break;
                const key = String(a);
                if (!pending.has(key) && refreshAll && pending.size >= maxPending) { overflow = true; pending = new Set(); break; }
                pending.add(key);
            }
            if (!pending.size && !overflow) return;
            if (quiet) clearTimer(quiet);
            quiet = arm(flush, delayMs);
            if (!maxTimer) maxTimer = arm(flush, maxWaitMs);
        },
        pendingCount: () => pending.size
    };
}
