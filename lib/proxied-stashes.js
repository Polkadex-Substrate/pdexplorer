// Validator onboarding, Sprint 7 (rollout gap A1): the stashes the connected
// account is a proxy for, so /validate can offer them to manage.
//
// Proxy.Proxies is keyed by the delegator (the stash), so "who am I a proxy
// for" cannot be read from storage without scanning every entry. Instead:
//   1. the explorer's event index (db.getProxyEventsFor): proxy.ProxyAdded
//      events naming the account as the delegatee, and proxy.PureCreated
//      naming it as the spawner (it holds an Any proxy of the pure account),
//      newest first, at most PROXY_EVENT_LIMIT rows;
//   2. at most MAX_CANDIDATES distinct delegators from those rows;
//   3. Proxy.Proxies of each candidate read live: only a stash whose list
//      still names the account is returned, with every proxy type and delay
//      (a removed proxy drops out here, so ProxyRemoved is not needed).
// Limits, said plainly: a proxy added before the indexed range, or in a block
// the index has not scanned, is not found; more than MAX_CANDIDATES
// delegators are cut to the newest (capped: true, and the list says so). A
// Proxy.Proxies read that fails is not "not a proxy": the answer is partial
// (partial: true), is not kept, goes out no-store, and the list offers a retry.
//
// GET /api/proxied-stashes/:address: kept PROXIED_TTL_MS per address in
// memory, concurrent requests share one read, per-IP rate limited (the status
// route's window). Read-only, so it exists with FEATURE_FLAGS.validate off.
// No server state is imported: server.js passes the api, gates and lookups.
// Tested in test/validator-rollout-s7.test.js.

import { sameAccount } from './multisig.js';
import { canManage } from './validator-manage-link.js';

export const PROXIED_STASHES_ROUTE = '/api/proxied-stashes/:address';
export const MAX_CANDIDATES = 16;
export const PROXY_EVENT_LIMIT = 200;
export const PROXIED_TTL_MS = 60_000;
const MEMO_MAX = 500;

const parse = (data) => {
    if (typeof data !== 'string') return data;
    try { return JSON.parse(data); } catch (e) { return null; }
};
// [candidate, named account] of one event, from named fields or the legacy array.
function pairOf(e) {
    const d = parse(e.data);
    if (!d || typeof d !== 'object') return null;
    if (e.method === 'ProxyAdded') return Array.isArray(d) ? [d[0], d[1]] : [d.delegator, d.delegatee];
    if (e.method === 'PureCreated') return Array.isArray(d) ? [d[0], d[1]] : [d.pure, d.who];
    return null;
}

// rows: stored events, newest first. Returns the distinct candidate stashes, newest first, at most max.
export function proxyCandidates(rows, me, { isSame = sameAccount, max = MAX_CANDIDATES } = {}) {
    const out = [];
    for (const e of rows || []) {
        if (!e || e.section !== 'proxy') continue;
        const p = pairOf(e);
        if (!p || typeof p[0] !== 'string' || typeof p[1] !== 'string') continue;
        if (!isSame(p[1], me) || isSame(p[0], me)) continue;
        if (out.some(c => isSame(c, p[0]))) continue;
        out.push(p[0]);
        if (out.length >= max) break;
    }
    return out;
}
const countCandidates = (rows, me, isSame) => proxyCandidates(rows, me, { isSame, max: MAX_CANDIDATES + 1 }).length;

const num = (x) => { const v = Number(x != null && typeof x.toNumber === 'function' ? x.toNumber() : x); return Number.isFinite(v) ? v : 0; };

// One Proxy.Proxies read per candidate (and one Staking.Validators size read
// for each kept stash). A read that fails drops only that candidate and makes
// the answer partial.
export async function readProxiedStashesChecked(api, me, candidates, { isSame = sameAccount } = {}) {
    const q = api && api.query;
    if (!q || !q.proxy || typeof q.proxy.proxies !== 'function') return { stashes: [], partial: false };
    const size = q.staking && q.staking.validators && typeof q.staking.validators.size === 'function' ? q.staking.validators.size : null;
    let partial = false;
    const rows = await Promise.all((candidates || []).slice(0, MAX_CANDIDATES).map(async (stash) => {
        try {
            const r = await q.proxy.proxies(String(stash));
            const defs = r && r[0] ? Array.from(r[0]) : [];
            const mine = defs.filter(p => isSame(String(p.delegate), me)).map(p => ({ type: String(p.proxyType), delay: num(p.delay) }));
            if (!mine.length) return null;
            let validating = null;
            if (size) { try { validating = num(await size(String(stash))) > 0; } catch (e) { validating = null; } }
            return { stash: String(stash), proxies: mine, validating };
        } catch (e) {
            partial = true;
            return null;
        }
    }));
    return { stashes: rows.filter(Boolean), partial };
}
export async function readProxiedStashes(api, me, candidates, opts) {
    return (await readProxiedStashesChecked(api, me, candidates, opts)).stashes;
}

export function registerProxiedStashesRoute(app, { api, ready, gate, events, cacheShort, serverError, rateOk = () => true, isSame = sameAccount, now = () => Date.now() }) {
    const memo = new Map();      // address -> { at, body }
    const reading = new Map();   // address -> the read in flight
    app.get(PROXIED_STASHES_ROUTE, async (req, res) => {
        const g = gate(req, res);
        if (!g) return;
        if (!rateOk(req)) { res.set('Cache-Control', 'no-store'); return res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many lookups from this address. Wait a minute and try again.' }); }
        const hit = memo.get(g.address);
        if (hit && now() - hit.at < PROXIED_TTL_MS) { cacheShort(res); return res.json(hit.body); }
        if (!ready(res)) return;
        try {
            let read = reading.get(g.address);
            if (!read) {
                read = (async () => {
                    const got = await events(g.address, PROXY_EVENT_LIMIT);
                    // events() gives rows, or { rows, partial, limited, reason }. limited = a standing limit (index missing),
                    // which no retry changes; partial = a read failed, which a retry can fix.
                    const rows = Array.isArray(got) ? got : (got && got.rows) || [];
                    const indexPartial = !Array.isArray(got) && !!(got && got.partial);
                    const limited = !Array.isArray(got) && !!(got && got.limited);
                    const candidates = proxyCandidates(rows, g.address, { isSame });
                    const { stashes, partial } = await readProxiedStashesChecked(api(), g.address, candidates, { isSame });
                    const body = { address: g.address, stashes, capped: countCandidates(rows, g.address, isSame) > MAX_CANDIDATES, partial: partial || indexPartial };
                    if (limited) body.limited = true;
                    if ((limited || indexPartial) && got.reason) body.reason = got.reason;
                    memo.delete(g.address);
                    // A failed read is not kept: it must not stand as "not a proxy" for a minute.
                    if (!body.partial) {
                        memo.set(g.address, { at: now(), body });
                        if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
                    }
                    return body;
                })().finally(() => { reading.delete(g.address); });
                reading.set(g.address, read);
            }
            const body = await read;
            if (body.partial) res.set('Cache-Control', 'no-store'); else cacheShort(res);
            res.json(body);
        } catch (err) { serverError(res, err, req.path); }
    });
}

// ── the list on /validate (lib/validator-status-view.js) ──
// Text links only: the view's one primary stays the state CTA (BRAND.md).
export const PROXIED_ALWAYS_LINE = 'Found from indexed proxy events, so an older proxy may be missing. To open an account not listed, enter its address under Any validator stash above.';
const typesText = (proxies) => [...new Set((proxies || []).map(p => String(p.type)))].join(' and ') + ' proxy';
const stateText = (v) => (v === true ? 'Validating' : v === false ? 'Not validating' : '');
// "Manage" only when this proxy could make a change now: no announcement delay and a type that passes canManage.
const canActNow = (proxies) => (proxies || []).some(p => Number(p.delay || 0) === 0 && canManage(p.type));
export function proxiedStashesHtml(r, { esc, shortAddr = (a) => a } = {}) {
    const list = r && Array.isArray(r.stashes) ? r.stashes : [];
    const partial = r && r.partial === true
        ? '<p class="validate-msg" data-proxied-partial="true">Could not check every account. <button type="button" class="item-link" data-proxied-retry="true">Try again.</button></p>' : '';
    const always = `<p class="validate-msg">${esc(PROXIED_ALWAYS_LINE)}</p>`;
    if (!list.length) return partial + always;
    const rows = list.map(s => {
        const state = stateText(s.validating);
        const label = canActNow(s.proxies) ? 'Manage' : 'View status';
        return `<li><span class="mono">${esc(shortAddr(s.stash))}</span> <span class="validate-text">${esc(typesText(s.proxies))}${state ? '. ' + esc(state) : ''}.</span> `
            + `<a href="/validate/${encodeURIComponent(s.stash)}" class="item-link" data-spa-link="true" aria-label="${esc(label + (label === 'Manage' ? ' ' : ' of ') + s.stash)}">${label}</a></li>`;
    }).join('');
    return '<section class="validate-proxied" aria-labelledby="validate-proxied-title">'
        + '<h3 id="validate-proxied-title">Accounts you are a proxy for</h3>'
        + '<p class="validate-msg">This account is a proxy for the accounts below. Open one to see its validator status and what this proxy can do there.</p>'
        + `<ul class="validate-proxied-list">${rows}</ul>`
        + partial
        + (r.capped ? `<p class="validate-msg">Only the ${MAX_CANDIDATES} most recent proxy grants were checked.</p>` : '')
        + always
        + '</section>';
}
