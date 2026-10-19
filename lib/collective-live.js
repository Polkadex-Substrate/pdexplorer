// Live council and technical committee motions, straight from chain storage.
//
// The Council page used to show the backend's snapshot, refreshed by a 30 s
// poll of /api/council, which itself trails the chain by an indexer tick. A
// member watching a live vote saw other members' votes up to a minute late.
// While the page is open this module keeps two storage subscriptions per
// collective on the browser's own node connection:
//
//   <pallet>.proposals()        which motions are open (new and closed ones)
//   <pallet>.voting.multi(...)  the voting record of each open motion
//
// and, once per motion the REST data does not know yet, a one-shot
// <pallet>.proposalOf(hash) so a new motion can be drawn before the backend
// has indexed it. The seats are watched too: <pallet>.members and .prime, and
// for the council the elections pallet's members and runnersUp when the
// runtime has one, so a new member's buttons and role show within a block. The voting subscription is replaced whenever the open set
// changes. stop() releases everything, including subscriptions whose promise
// resolves after stop() was called (navigating away mid-handshake must not
// leave one running).
//
// No DOM and no imports: the api object is passed in, so
// test/collective-live.test.js drives it with a fake.

export const LIVE_COLLECTIVES = Object.freeze([
    { key: 'council', pallets: ['council', 'councilCollective', 'generalCouncil'] },
    { key: 'technicalCommittee', pallets: ['technicalCommittee'] }
]);

const ELECTIONS_PALLETS = ['elections', 'phragmenElection', 'electionsPhragmen'];

export function resolveElectionsPallet(api, names = ELECTIONS_PALLETS) {
    const q = api && api.query;
    if (!q) return null;
    return (names || []).find(n => q[n] && (typeof q[n].members === 'function' || typeof q[n].runnersUp === 'function')) || null;
}

// Balance codec to a PDEX number (12 decimals), as the server's formatPDEX.
function pdexOf(x) {
    try { const p = BigInt(String(x)); return Number(p / 1000000000000n) + Number(p % 1000000000000n) / 1e12; } catch (_) { return 0; }
}
// SeatHolder { who, stake } or the older (AccountId, Balance) tuple.
function seatOf(e, toAddress) {
    if (!e) return null;
    const who = e.who !== undefined ? e.who : e[0];
    const stake = e.stake !== undefined ? e.stake : e[1];
    return who === undefined || who === null ? null : { who: toAddress(String(who)), stake: pdexOf(stake) };
}

// The live seat list decides WHO sits; REST keeps stake, name and the rest.
// same(a, b) compares addresses (isSameAddress in the page).
export function overlayLiveMembers(restMembers, live, same = (a, b) => a === b) {
    if (!live || !Array.isArray(live.members)) return restMembers;
    const list = Array.isArray(restMembers) ? restMembers : [];
    return live.members.map(a => list.find(m => m && same(m.address, a)) || { address: a });
}

export function resolveCollectivePallet(api, names) {
    const q = api && api.query;
    if (!q) return null;
    return (names || []).find(n => q[n] && typeof q[n].proposals === 'function'
        && q[n].voting && typeof q[n].voting.multi === 'function') || null;
}

const num = (x) => (x && typeof x.toNumber === 'function' ? x.toNumber() : Number(x));

// Option<Votes> (or a plain Votes) to { index, threshold, ayes, nays, end }.
export function votingToRecord(opt, toAddress = (a) => a) {
    if (!opt || opt.isNone) return null;
    const v = typeof opt.unwrap === 'function' ? (opt.isSome ? opt.unwrap() : null) : opt;
    if (!v) return null;
    const addrs = (list) => Array.from(list || []).map(a => toAddress(String(a)));
    return { index: num(v.index), threshold: num(v.threshold), end: num(v.end), ayes: addrs(v.ayes), nays: addrs(v.nays) };
}

function callStub(opt) {
    if (!opt || !opt.isSome) return null;
    const call = opt.unwrap();
    const argMeta = (call.meta && call.meta.args) || [];
    const args = Array.from(call.args || []).map((a, i) => {
        let value;
        try { value = String(a); } catch (_) { value = '[unprintable]'; }
        if (value.length > 512) value = value.slice(0, 512) + '...(truncated)';
        return { name: argMeta[i] ? String(argMeta[i].name) : 'arg' + i, value };
    });
    return { section: String(call.section || ''), method: String(call.method || ''), args, lengthBound: Number(call.encodedLength) || 0 };
}

/**
 * opts.onUpdate(key, { kind: 'hashes' | 'voting' | 'stub', initial, state })
 * opts.knownHashes(key) -> hashes the caller already has full data for
 * opts.toAddress(addr)  -> display normalisation for voter addresses
 * Returns { state: { [key]: { pallet, hashes, votings, stubs } }, stop() }.
 */
export function startCollectiveLive(api, opts = {}) {
    const collectives = opts.collectives || LIVE_COLLECTIVES;
    const onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : () => {};
    const onError = typeof opts.onError === 'function' ? opts.onError : () => {};
    const knownHashes = typeof opts.knownHashes === 'function' ? opts.knownHashes : () => [];
    const toAddress = typeof opts.toAddress === 'function' ? opts.toAddress : (a) => a;
    const state = {};
    const stoppers = [];
    let stopped = false;

    // Keep an unsubscribe function, or call it at once if we already stopped.
    const hold = (p, slot) => Promise.resolve(p).then(u => {
        if (typeof u !== 'function') return;
        if (stopped || (slot && slot.dead)) u(); else if (slot) slot.unsub = u; else stoppers.push(u);
    }).catch(onError);

    for (const c of collectives) {
        const pallet = resolveCollectivePallet(api, c.pallets);
        if (!pallet) continue;
        const q = api.query[pallet];
        const st = state[c.key] = { pallet, hashes: null, votings: {}, stubs: {} };
        // Seats. Each item is optional; a runtime without it has less live data.
        const watch = (fn, apply, kind) => {
            let r, initial = true;
            try { r = fn((v) => { if (stopped) return; apply(v); onUpdate(c.key, { kind, initial, state: st }); initial = false; }); } catch (e) { onError(e); return; }
            hold(r, null);
        };
        if (typeof q.members === 'function') watch((cb) => q.members(cb), (v) => { st.members = Array.from(v || []).map(a => toAddress(String(a))); }, 'members');
        if (typeof q.prime === 'function') watch((cb) => q.prime(cb), (v) => { st.prime = v && v.isSome ? toAddress(String(v.unwrap())) : null; }, 'prime');
        const ep = resolveElectionsPallet(api, c.elections || (c.key === 'council' ? ELECTIONS_PALLETS : []));
        if (ep) {
            const eq = api.query[ep];
            const el = st.elections = { members: null, runnersUp: null };
            const seats = (v) => Array.from(v || []).map(e => seatOf(e, toAddress)).filter(Boolean);
            if (typeof eq.members === 'function') watch((cb) => eq.members(cb), (v) => { el.members = seats(v); }, 'elections');
            if (typeof eq.runnersUp === 'function') watch((cb) => eq.runnersUp(cb), (v) => { el.runnersUp = seats(v); }, 'elections');
        }
        let voting = null;   // { unsub, dead } for the current voting.multi
        const dropVoting = () => { if (voting) { voting.dead = true; if (voting.unsub) voting.unsub(); voting = null; } };
        stoppers.push(dropVoting);
        let first = true;
        let sub;
        try {
            sub = q.proposals((codec) => {
                if (stopped) return;
                const hashes = Array.from(codec || []).map(h => String(h));
                if (st.hashes && st.hashes.length === hashes.length && st.hashes.every((h, i) => h === hashes[i])) return;
                st.hashes = hashes;
                for (const h of Object.keys(st.votings)) if (!hashes.includes(h)) delete st.votings[h];
                dropVoting();
                const initial = first; first = false;
                onUpdate(c.key, { kind: 'hashes', initial, state: st });
                if (!hashes.length) return;
                const slot = voting = { unsub: null, dead: false };
                let vsub;
                try {
                    vsub = q.voting.multi(hashes, (list) => {
                        if (stopped || slot.dead) return;
                        Array.from(list || []).forEach((opt, i) => { st.votings[hashes[i]] = votingToRecord(opt, toAddress); });
                        onUpdate(c.key, { kind: 'voting', state: st });
                    });
                } catch (e) { onError(e); return; }
                hold(vsub, slot);
                const known = new Set(knownHashes(c.key) || []);
                for (const h of hashes) {
                    if (known.has(h) || st.stubs[h] || typeof q.proposalOf !== 'function') continue;
                    st.stubs[h] = { pending: true };
                    Promise.resolve(q.proposalOf(h)).then(opt => {
                        if (stopped) return;
                        const stub = callStub(opt);
                        if (stub) { st.stubs[h] = stub; onUpdate(c.key, { kind: 'stub', state: st }); } else delete st.stubs[h];
                    }).catch(e => { delete st.stubs[h]; onError(e); });
                }
            });
        } catch (e) { onError(e); continue; }
        hold(sub, null);
    }

    return {
        state,
        stop() {
            if (stopped) return;
            stopped = true;
            for (const u of stoppers.splice(0)) { try { u(); } catch (e) { onError(e); } }
        }
    };
}

// Keep the live feed only while the node link is up (Checker M3). While it is
// down the subscriptions deliver nothing, so their state is a frozen copy: it
// would hide a motion opened during the outage (the live hash list decides
// which motions are open) and pin old tallies over the poll's newer ones.
// So current() is null while disconnected, the caller falls back to the 30 s
// REST poll, and on reconnect a fresh feed is started whose subscriptions
// deliver current values. start(api) returns a feed with stop();
// opts.onChange(why) runs after each switch so the page can re-render.
export function liveWhileConnected(api, start, opts = {}) {
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    const linkUp = () => api && api.isConnected !== false;
    let feed = null, wanted = false;
    const drop = () => { if (feed) { const f = feed; feed = null; try { f.stop(); } catch (_) { /* a dead link may refuse the unsubscribe */ } } };
    const onDown = () => { if (!feed) return; drop(); onChange('disconnected'); };
    const onUp = () => { if (!wanted || feed || !linkUp()) return; feed = start(api); onChange('connected'); };
    if (api && typeof api.on === 'function') { api.on('disconnected', onDown); api.on('connected', onUp); }
    return {
        start() { wanted = true; if (!feed && linkUp()) feed = start(api); },
        stop() { wanted = false; drop(); },
        current: () => (feed && linkUp() ? feed : null),
        dispose() {
            wanted = false; drop();
            if (api && typeof api.off === 'function') { api.off('disconnected', onDown); api.off('connected', onUp); }
        }
    };
}

// After a ?fresh=1 read (right after a vote, close or propose lands), the next
// FRESH_CARRY polls of the same URL ask for ?fresh=1 too (Checker L7). A plain
// poll can be answered from the CDN copy cached before the transaction for up
// to the short tier's TTL, and would put the old tally back over the fresh
// one. carry is a plain object, url -> polls left. Returns whether this
// request should be fresh.
export const FRESH_CARRY = 2;
export function freshPlan(carry, url, wantFresh) {
    if (wantFresh) { carry[url] = FRESH_CARRY; return true; }
    const left = Number(carry[url]) || 0;
    if (left > 0) { carry[url] = left - 1; return true; }
    return false;
}
