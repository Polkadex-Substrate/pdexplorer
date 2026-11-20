// Validator onboarding, Sprint 7 (launch readiness), group A: the two rollout
// gaps named at the end of Sprint 5.
//
//   A1. The connected account is a proxy for one or more stashes. Proxy.Proxies
//       is keyed by the delegator, so "who am I a proxy for" comes from the
//       explorer's event index (proxy.ProxyAdded naming the account as the
//       delegatee, proxy.PureCreated naming it as the spawner), bounded, then
//       checked against Proxy.Proxies of each candidate on the live chain:
//       lib/proxied-stashes.js, GET /api/proxied-stashes/:address, and a list
//       on /validate to pick a stash to manage.
//   A2. "Manage this validator" on the public validator page, only when the
//       connected account is the stash, its controller, a qualifying proxy or
//       a member of the multisig that is the stash: lib/validator-manage-link.js.
//
// Addresses are synthetic. No chain, no network: a hand-built api and app.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import * as db from '../db.js';
import { proxyCandidates, readProxiedStashes, registerProxiedStashesRoute, PROXIED_STASHES_ROUTE, MAX_CANDIDATES, PROXY_EVENT_LIMIT, PROXIED_TTL_MS, proxiedStashesHtml, readProxiedStashesChecked } from '../lib/proxied-stashes.js';
import { manageRole, mountManageLink, MANAGE_LINK_TEXT } from '../lib/validator-manage-link.js';
import { mountValidatePage } from '../lib/validator-status-view.js';
import { validatorStatusModel } from '../lib/validator-status.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, bodyOf } from './helpers/source.js';

const addr = (n, prefix = 88) => encodeAddress(new Uint8Array(32).fill(n), prefix);
const ME = addr(1), S1 = addr(11), S2 = addr(12), S3 = addr(13), OTHER = addr(20), CTRL = addr(21), M2 = addr(22);
const short = (a) => String(a).slice(0, 6) + '...' + String(a).slice(-4);
const flush = (n = 5) => new Promise(r => setTimeout(r, n));
async function settle() { for (let i = 0; i < 6; i++) await flush(); }

// ── A1: candidates from the event index ──
const added = (delegator, delegatee, proxyType = 'Staking', delay = '0', block = 100) => ({ section: 'proxy', method: 'ProxyAdded', block, data: { delegator, delegatee, proxyType, delay } });
const pure = (pureAcc, who, block = 100) => ({ section: 'proxy', method: 'PureCreated', block, data: { pure: pureAcc, who, proxyType: 'Any', disambiguationIndex: '0' } });

describe('A1 proxyCandidates: who might this account be a proxy for (event index)', () => {
    test('ProxyAdded naming the account as delegatee gives the delegator; named and legacy array data', () => {
        const rows = [added(S1, ME), { section: 'proxy', method: 'ProxyAdded', block: 90, data: [S2, ME, 'Any', '0'] }];
        assert.deepEqual(proxyCandidates(rows, ME), [S1, S2]);
    });
    test('PureCreated naming the account as spawner gives the pure account', () => {
        assert.deepEqual(proxyCandidates([pure(S3, ME)], ME), [S3]);
        assert.deepEqual(proxyCandidates([{ section: 'proxy', method: 'PureCreated', block: 1, data: [S3, ME, 'Any', '0'] }], ME), [S3]);
    });
    test('the account as delegator, another delegatee, other events and bad data are ignored', () => {
        const rows = [added(ME, S1), added(S2, OTHER), { section: 'balances', method: 'Transfer', data: { from: S1, to: ME } },
            { section: 'proxy', method: 'ProxyAdded', data: 'not json' }, { section: 'proxy', method: 'ProxyAdded', data: null }, null];
        assert.deepEqual(proxyCandidates(rows, ME), []);
    });
    test('another SS58 prefix for the same key matches; each candidate once, newest first', () => {
        const rows = [added(S1, addr(1, 42), 'Staking', '0', 300), added(S2, ME, 'Any', '0', 200), added(S1, ME, 'Any', '0', 100)];
        assert.deepEqual(proxyCandidates(rows, ME), [S1, S2]);
    });
    test('capped at MAX_CANDIDATES: the chain is never asked about more', () => {
        const rows = Array.from({ length: MAX_CANDIDATES + 9 }, (_, i) => added(addr(100 + i), ME, 'Staking', '0', 1000 - i));
        const c = proxyCandidates(rows, ME);
        assert.equal(c.length, MAX_CANDIDATES);
        assert.equal(c[0], addr(100));
    });
});

// ── A1: the live check ──
function proxyApi({ defs = {}, validators = [], fail = [] } = {}) {
    const reads = [];
    const api = {
        query: {
            proxy: {
                proxies: async (a) => {
                    reads.push(String(a));
                    if (fail.includes(String(a))) throw new Error('rpc');
                    const list = (defs[String(a)] || []).map(([delegate, proxyType, delay]) => ({ delegate, proxyType, delay }));
                    return [list, 0n];
                }
            },
            staking: { validators: { size: async (a) => (validators.includes(String(a)) ? 5 : 0) } }
        }
    };
    return { api, reads };
}

describe('A1 readProxiedStashes: Proxy.Proxies of each candidate, read live', () => {
    test('keeps a stash whose proxy list still names the account, with every type and delay; drops a removed one', async () => {
        const { api } = proxyApi({ defs: { [S1]: [[ME, 'Staking', 0], [ME, 'Governance', 0], [OTHER, 'Any', 0]], [S2]: [[OTHER, 'Staking', 0]] }, validators: [S1] });
        const r = await readProxiedStashes(api, ME, [S1, S2]);
        assert.deepEqual(r, [{ stash: S1, proxies: [{ type: 'Staking', delay: 0 }, { type: 'Governance', delay: 0 }], validating: true }]);
    });
    test('a delegate stored in another SS58 prefix still matches; validating false when not in Staking.Validators', async () => {
        const { api } = proxyApi({ defs: { [S2]: [[addr(1, 42), 'Any', 10]] } });
        assert.deepEqual(await readProxiedStashes(api, ME, [S2]), [{ stash: S2, proxies: [{ type: 'Any', delay: 10 }], validating: false }]);
    });
    test('a read that fails for one candidate leaves the others; never more reads than candidates', async () => {
        const { api, reads } = proxyApi({ defs: { [S1]: [[ME, 'Staking', 0]], [S2]: [[ME, 'Staking', 0]] }, fail: [S1] });
        const r = await readProxiedStashes(api, ME, [S1, S2]);
        assert.deepEqual(r.map(x => x.stash), [S2]);
        assert.equal(reads.length, 2);
    });
    test('no proxy pallet: nothing, no throw', async () => {
        assert.deepEqual(await readProxiedStashes({ query: {} }, ME, [S1]), []);
    });
});

// ── A1: the route ──
function fakeApp() {
    const routes = {};
    return { routes, get: (p, fn) => { routes[p] = fn; } };
}
function fakeRes() {
    const r = { statusCode: 200, body: null, headers: {} };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.set = (k, v) => { r.headers[k] = v; return r; };
    return r;
}
function routeWorld(over = {}) {
    const app = fakeApp();
    let t = 1000;
    const calls = { events: [] };
    const { api, reads } = proxyApi({ defs: { [S1]: [[ME, 'Staking', 0]] }, validators: [S1] });
    const gate = (req, res) => { const a = req.params.address; if (!/^[1-9A-HJ-NP-Za-km-z]{46,50}$/.test(a)) { res.status(400).json({ error: 'Invalid Polkadex address.' }); return null; } return { address: a }; };
    registerProxiedStashesRoute(app, {
        api: () => api, ready: () => true, gate, cacheShort: (res) => res.set('Cache-Control', 'short'), serverError: (res, e) => res.status(500).json({ error: String(e && e.message) }),
        events: (a, limit) => { calls.events.push([a, limit]); return [added(S1, ME), added(S2, OTHER)]; },
        now: () => t, ...over
    });
    const get = async (address) => { const res = fakeRes(); await app.routes[PROXIED_STASHES_ROUTE]({ params: { address }, path: '/x' }, res); return res; };
    return { get, calls, reads, tick: (ms) => { t += ms; } };
}

describe('A1 GET /api/proxied-stashes/:address: bounded, cached', () => {
    test('one bounded index read, the live check, the answer with the stash and its proxy type', async () => {
        const w = routeWorld();
        const res = await w.get(ME);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(w.calls.events, [[ME, PROXY_EVENT_LIMIT]]);
        assert.deepEqual(res.body.stashes, [{ stash: S1, proxies: [{ type: 'Staking', delay: 0 }], validating: true }]);
        assert.equal(res.body.address, ME);
        assert.equal(res.body.capped, false);
        assert.equal(res.headers['Cache-Control'], 'short');
    });
    test('kept PROXIED_TTL_MS per address: a second request reads neither the index nor the chain', async () => {
        const w = routeWorld();
        await w.get(ME); await w.get(ME);
        assert.equal(w.calls.events.length, 1);
        assert.equal(w.reads.length, 1);
        w.tick(PROXIED_TTL_MS + 1);
        await w.get(ME);
        assert.equal(w.calls.events.length, 2);
    });
    test('concurrent requests for one address share one read', async () => {
        const w = routeWorld();
        await Promise.all([w.get(ME), w.get(ME), w.get(ME)]);
        assert.equal(w.calls.events.length, 1);
    });
    test('a bad address is refused by the gate; rate limited answers 429 without reading', async () => {
        const w = routeWorld();
        assert.equal((await w.get('nope')).statusCode, 400);
        const limited = routeWorld({ rateOk: () => false });
        const res = await limited.get(ME);
        assert.equal(res.statusCode, 429);
        assert.equal(limited.calls.events.length, 0);
    });
    test('more candidates than the cap: capped true, the chain asked MAX_CANDIDATES times', async () => {
        const many = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => added(addr(100 + i), ME));
        const w = routeWorld({ events: () => many });
        const res = await w.get(ME);
        assert.equal(res.body.capped, true);
        assert.equal(w.reads.length, MAX_CANDIDATES);
    });
    test('a failed live read is partial: not cached, no-store, and the next request reads again', async () => {
        const { api } = proxyApi({ defs: { [S1]: [[ME, 'Staking', 0]] }, validators: [S1], fail: [S1] });
        const w = routeWorld({ api: () => api });
        const res = await w.get(ME);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.partial, true);
        assert.equal(res.headers['Cache-Control'], 'no-store');
        await w.get(ME);
        assert.equal(w.calls.events.length, 2, 'not kept as "not a proxy"');
    });
    test('readProxiedStashesChecked: partial only when a read failed, not when the account is simply not a proxy', async () => {
        const ok = proxyApi({ defs: { [S1]: [[OTHER, 'Any', 0]] } }).api;
        assert.deepEqual(await readProxiedStashesChecked(ok, ME, [S1]), { stashes: [], partial: false });
        const bad = proxyApi({ defs: {}, fail: [S1] }).api;
        assert.deepEqual(await readProxiedStashesChecked(bad, ME, [S1, S2]), { stashes: [], partial: true });
    });
    test('a clean answer says partial false and is still cached', async () => {
        const w = routeWorld();
        const res = await w.get(ME);
        assert.equal(res.body.partial, false);
    });
    test('server.js registers the route with the event index lookup and the status rate limit', () => {
        const src = readRepo('server.js', import.meta.url);
        assert.match(src, /registerProxiedStashesRoute\(app, \{[^}]*events: \(address, limit\) => db\.getProxyEventsChecked\(address, limit\)/);
        assert.match(src, /registerProxiedStashesRoute\(app, \{[^}]*rateOk: validatorStatusRateOk/);
    });
});

describe('A1 db.getProxyEventsFor: ProxyAdded and PureCreated naming or signed by the account, bounded', () => {
    const dirs = [];
    after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });
    test('linked and signed proxy events, newest first, at most limit; other events left out', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-proxied-'));
        dirs.push(dir);
        db.initDb(dir, false, { awaitMigrator: false });
        const ev = (hash, block, section, method, data, accounts, signerAddress = null) => ({ hash, block, eventIndex: 0, section, method, data, accounts, signerAddress });
        db.insertEvents([
            ev('0x01', 100, 'proxy', 'ProxyAdded', { delegator: S1, delegatee: ME, proxyType: 'Staking', delay: '0' }, [ME], S1),
            ev('0x02', 200, 'proxy', 'PureCreated', { pure: S3, who: ME, proxyType: 'Any', disambiguationIndex: '0' }, [S3], ME),
            ev('0x03', 300, 'balances', 'Transfer', { from: S1, to: ME, amount: '1' }, [ME], S1),
            ev('0x04', 400, 'proxy', 'ProxyRemoved', { delegator: S2, delegatee: ME, proxyType: 'Any', delay: '0' }, [ME], S2),
            ev('0x05', 500, 'proxy', 'ProxyAdded', { delegator: S2, delegatee: ME, proxyType: 'Any', delay: '0' }, [ME], S2)
        ]);
        const rows = db.getProxyEventsFor(ME, 10);
        assert.deepEqual(rows.map(r => [r.block, r.method]), [[500, 'ProxyAdded'], [200, 'PureCreated'], [100, 'ProxyAdded']]);
        assert.equal(rows[0].data.delegator, S2);
        assert.equal(db.getProxyEventsFor(ME, 2).length, 2);
        assert.deepEqual(proxyCandidates(rows, ME), [S2, S3, S1]);
    });
});

describe('A1 getProxyEventsFor: the signer branch is seeked by idx_events_signer_block and bounded', () => {
    test('plan uses the index, the 5,000-row window is stated in db.js and the API reference', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-proxied-plan-'));
        try {
            const h = db.initDb(dir, true, { awaitMigrator: false });
            const src = readRepo('db.js', import.meta.url);
            const plan = h.prepare("EXPLAIN QUERY PLAN SELECT rowid, * FROM events WHERE signer_address = ? ORDER BY block DESC, rowid DESC LIMIT 5000").all(ME).map(r => r.detail).join(' | ');
            assert.match(plan, /USING INDEX idx_events_signer_block \(signer_address=\?\)/);
            assert.doesNotMatch(plan, /USE TEMP B-TREE/);
            assert.match(src, /5,000-row window/);
            assert.match(readRepo('lib/api-reference.js', import.meta.url), /newest 5,000/);
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
    });
});

describe('A1 getProxyEventsChecked: a missing idx_events_signer_block skips the signer branch, never scans events, never builds the index', () => {
    const seed = (dir) => {
        const h = db.initDb(dir, true, { awaitMigrator: false });
        db.insertEvents([
            { hash: '0x11', block: 100, eventIndex: 0, section: 'proxy', method: 'ProxyAdded', data: { delegator: S1, delegatee: ME, proxyType: 'Staking', delay: '0' }, accounts: [ME], signerAddress: S1 },
            { hash: '0x12', block: 200, eventIndex: 0, section: 'proxy', method: 'ProxyAdded', data: { delegator: S2, delegatee: ME, proxyType: 'Any', delay: '0' }, accounts: [S2], signerAddress: ME }
        ]);
        return h;
    };
    // Runs fn with every executed statement (sql + args) recorded; returns the EXPLAIN QUERY PLAN details of each.
    const plansOf = (h, fn) => {
        const seen = [];
        const orig = h.prepare.bind(h);
        h.prepare = (sql) => {
            const st = orig(sql);
            const all = st.all.bind(st), get = st.get.bind(st);
            st.all = (...a) => { seen.push([sql, a]); return all(...a); };
            st.get = (...a) => { seen.push([sql, a]); return get(...a); };
            return st;
        };
        try { fn(); } finally { delete h.prepare; }
        return seen.map(([sql, a]) => ({ sql, plan: orig('EXPLAIN QUERY PLAN ' + sql).all(...a).map(r => r.detail).join(' | ') }));
    };
    const unindexedEventsScan = (plan) => /\bSCAN (events|e)\b(?! USING)/.test(plan);

    test('index present: both branches run, the signer branch uses the index, no unindexed scan of events', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-proxied-idx-'));
        try {
            const h = seed(dir);
            let got;
            const plans = plansOf(h, () => { got = db.getProxyEventsChecked(ME, 10); });
            assert.equal(got.partial, false);
            assert.equal(got.reason, undefined);
            assert.deepEqual(got.rows.map(r => r.block), [200, 100]);
            assert.ok(plans.some(p => /USING INDEX idx_events_signer_block/.test(p.plan)), plans.map(p => p.plan).join('\n'));
            assert.ok(plans.every(p => !unindexedEventsScan(p.plan)), plans.map(p => p.plan).join('\n'));
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
    });

    test('index missing: only the event_accounts branch runs, partial with a reason code, one warning, no CREATE INDEX, no events scan', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-proxied-noidx-'));
        const warns = [];
        const origWarn = console.warn;
        try {
            const h = seed(dir);
            h.exec('DROP INDEX idx_events_signer_block');
            console.warn = (...a) => { warns.push(a.join(' ')); };
            let got, got2;
            const plans = plansOf(h, () => { got = db.getProxyEventsChecked(ME, 10); got2 = db.getProxyEventsChecked(ME, 10); });
            assert.equal(got.partial, true);
            assert.equal(got.reason, 'SIGNER_INDEX_MISSING');
            assert.deepEqual(got.rows.map(r => r.block), [100], 'the linked branch still answers; the signer-only event is not seen');
            assert.equal(got2.partial, true);
            assert.ok(plans.every(p => !/signer_address/.test(p.sql) || /sqlite_master|index_list/.test(p.sql)), 'no executed statement filters by signer_address');
            assert.ok(plans.every(p => !/CREATE INDEX/i.test(p.sql)));
            assert.ok(plans.every(p => !unindexedEventsScan(p.plan)), plans.map(p => p.plan).join('\n'));
            assert.ok(plans.some(p => /event_accounts/.test(p.plan) && /USING (COVERING )?INDEX|PRIMARY KEY/.test(p.plan)), plans.map(p => p.plan).join('\n'));
            assert.equal(warns.length, 1, 'one warning per process, not one per request');
            assert.match(warns[0], /idx_events_signer_block/);
            assert.match(warns[0], /migrate-add-indexes\.mjs/);
            assert.equal(h.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_events_signer_block'").get(), undefined, 'never built from the request path');
        } finally { console.warn = origWarn; try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
    });

    test('every query of getProxyEventsFor has a LIMIT', () => {
        const src = readRepo('db.js', import.meta.url);
        const body = bodyOf(src, 'getProxyEventsChecked');
        assert.ok(body, 'getProxyEventsChecked exists');
        const sqls = body.match(/SELECT[\s\S]*?\.all\(/g) || [];
        assert.ok(sqls.length >= 1);
        for (const q of sqls) assert.match(q, /LIMIT/);
        assert.match(body, /LIMIT \$\{PROXY_SCAN_ROWS\}/);
    });
});

describe('A1 route: an index-missing answer is partial with the reason, not kept, no-store', () => {
    test('events() returning { rows, partial, reason } makes the body partial with reason', async () => {
        let calls = 0;
        const handlers = {};
        const app = { get: (_p, h) => { handlers.get = h; } };
        const sent = {};
        registerProxiedStashesRoute(app, {
            api: () => ({ query: { proxy: { proxies: async () => [[{ delegate: ME, proxyType: 'Staking', delay: 0 }]] } } }),
            ready: () => true, gate: () => ({ address: ME }),
            events: async () => { calls++; return { rows: [added(S1, ME)], partial: true, reason: 'SIGNER_INDEX_MISSING' }; },
            cacheShort: () => {}, serverError: (_r, e) => { throw e; }
        });
        const res = { set: (k, v) => { sent[k] = v; return res; }, json: (b) => { sent.body = b; return res; }, status: () => res };
        await handlers.get({ path: '/x', ip: '1' }, res);
        await handlers.get({ path: '/x', ip: '1' }, res);
        assert.equal(sent.body.partial, true);
        assert.equal(sent.body.reason, 'SIGNER_INDEX_MISSING');
        assert.equal(sent['Cache-Control'], 'no-store');
        assert.equal(calls, 2, 'not kept');
    });
});

// ── A1: the list on /validate ──
function pageDom() {
    const w = new Window({ url: 'http://localhost/validate' });
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    return { w, el, doc: w.document };
}
const params = () => ({ specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 }, minValidatorBond: '1', minCommission: 0, activeEra: 500, currentEra: 500 });
function pageDeps(proxied, over = {}) {
    const urls = [];
    return {
        urls,
        account: { status: 'connected', address: ME }, urlAddress: '', isSame: (a, b) => a === b,
        fetchJson: async (u) => {
            urls.push(u);
            if (u === '/api/validator/params') return params();
            if (u.startsWith('/api/proxied-stashes/')) { if (proxied instanceof Error) throw proxied; return proxied; }
            const m = /^\/api\/validator\/([^/]+)\/status$/.exec(u);
            if (m) return { ...validatorStatusModel({ address: decodeURIComponent(m[1]) }, params()), address: decodeURIComponent(m[1]) };
            throw new Error('unexpected ' + u);
        },
        helpIcon: () => '', esc: escapeHtml, shortAddr: short, navigate: () => {},
        ...over
    };
}

describe('A1 /validate: stashes you are a proxy for, pick one to manage', () => {
    test('one row per stash with its proxy type and state, a link to that stash; no extra primary button', async () => {
        const { el } = pageDom();
        const d = pageDeps({ address: ME, capped: false, stashes: [
            { stash: S1, proxies: [{ type: 'Staking', delay: 0 }], validating: true },
            { stash: S2, proxies: [{ type: 'Any', delay: 0 }, { type: 'Governance', delay: 0 }], validating: false }] });
        await mountValidatePage(el, d); await settle();
        assert.ok(d.urls.includes('/api/proxied-stashes/' + encodeURIComponent(ME)));
        const sec = el.querySelector('#validate-proxied-slot section');
        assert.ok(sec, 'the list is shown');
        assert.equal(sec.querySelector('h3').textContent, 'Accounts you are a proxy for');
        assert.ok(sec.textContent.includes('This account is a proxy for the accounts below. Open one to see its validator status and what this proxy can do there.'));
        const rows = Array.from(sec.querySelectorAll('li'));
        assert.equal(rows.length, 2);
        assert.match(rows[0].textContent, /Staking proxy/);
        assert.match(rows[0].textContent, /Validating/);
        assert.match(rows[1].textContent, /Any and Governance proxy/);
        assert.match(rows[1].textContent, /Not validating/);
        const links = Array.from(sec.querySelectorAll('a'));
        assert.deepEqual(links.map(a => a.getAttribute('href')), ['/validate/' + S1, '/validate/' + S2]);
        assert.ok(links.every(a => a.classList.contains('item-link') && !a.classList.contains('validate-primary')));
        assert.equal(links[0].textContent, 'Manage');
        assert.match(links[0].getAttribute('aria-label'), new RegExp('Manage ' + S1));
        assert.ok(el.querySelectorAll('.validate-primary').length <= 1, 'at most one primary in the view');
    });
    const ALWAYS = 'Found from indexed proxy events, so an older proxy may be missing. To open an account not listed, enter its address under Any validator stash above.';
    test('nothing found: the always-line alone, no empty heading; a failed fetch: nothing', async () => {
        const a = pageDom();
        await mountValidatePage(a.el, pageDeps({ address: ME, stashes: [], capped: false })); await settle();
        const slot = a.el.querySelector('#validate-proxied-slot');
        assert.equal(slot.textContent.trim(), ALWAYS);
        assert.equal(slot.querySelector('h3'), null);
        const b = pageDom();
        await mountValidatePage(b.el, pageDeps(new Error('503'))); await settle();
        assert.equal(b.el.querySelector('#validate-proxied-slot').innerHTML, '');
    });
    test('a list always carries the always-line; the cap line only when the cap was hit, in the approved words', async () => {
        const stashes = [{ stash: S1, proxies: [{ type: 'Staking', delay: 0 }], validating: true }];
        const a = pageDom();
        await mountValidatePage(a.el, pageDeps({ address: ME, capped: false, stashes })); await settle();
        const ta = a.el.querySelector('#validate-proxied-slot').textContent;
        assert.ok(ta.includes(ALWAYS));
        assert.ok(!ta.includes('Only the 16 most recent proxy grants were checked.'));
        const b = pageDom();
        await mountValidatePage(b.el, pageDeps({ address: ME, capped: true, stashes })); await settle();
        const tb = b.el.querySelector('#validate-proxied-slot').textContent;
        assert.ok(tb.includes(ALWAYS) && tb.includes('Only the 16 most recent proxy grants were checked.'));
    });
    test('Manage only for a proxy with no delay whose type can make a change; otherwise View status', () => {
        const link = (proxies) => /<a [^>]*>([^<]*)<\/a>/.exec(proxiedStashesHtml({ stashes: [{ stash: S1, proxies, validating: null }] }, { esc: escapeHtml, shortAddr: short }))[1];
        assert.equal(link([{ type: 'Staking', delay: 0 }]), 'Manage');
        assert.equal(link([{ type: 'Governance', delay: 0 }]), 'View status');
        assert.equal(link([{ type: 'Staking', delay: 5 }]), 'View status');
        assert.equal(link([{ type: 'Governance', delay: 0 }, { type: 'Any', delay: 0 }]), 'Manage');
        assert.equal(link([{ type: 'Any', delay: 10 }, { type: 'Governance', delay: 0 }]), 'View status');
    });
    test('a partial answer says so with a retry; the retry asks again', async () => {
        const { el } = pageDom();
        let calls = 0;
        const d = pageDeps(null, { fetchJson: async (u) => {
            if (u === '/api/validator/params') return params();
            if (u.startsWith('/api/proxied-stashes/')) { calls++; return calls === 1 ? { address: ME, stashes: [], capped: false, partial: true } : { address: ME, capped: false, partial: false, stashes: [{ stash: S1, proxies: [{ type: 'Staking', delay: 0 }], validating: true }] }; }
            const m = /^\/api\/validator\/([^/]+)\/status$/.exec(u);
            return { ...validatorStatusModel({ address: decodeURIComponent(m[1]) }, params()), address: decodeURIComponent(m[1]) };
        } });
        await mountValidatePage(el, d); await settle();
        const slot = el.querySelector('#validate-proxied-slot');
        assert.ok(slot.textContent.includes('Could not check every account. Try again.'));
        const btn = slot.querySelector('button');
        assert.ok(btn, 'a retry control');
        btn.click(); await settle();
        assert.equal(calls, 2);
        assert.ok(el.querySelector('#validate-proxied-slot').querySelectorAll('li').length === 1);
        assert.ok(!el.querySelector('#validate-proxied-slot').textContent.includes('Could not check'));
    });
    test('viewing another stash (/validate/<address>) or nothing connected: not asked', async () => {
        const a = pageDeps({ address: ME, stashes: [] }, { urlAddress: S1 });
        await mountValidatePage(pageDom().el, a); await settle();
        assert.ok(!a.urls.some(u => u.startsWith('/api/proxied-stashes/')));
        const b = pageDeps({ address: ME, stashes: [] }, { account: { status: 'disconnected', address: '' } });
        await mountValidatePage(pageDom().el, b); await settle();
        assert.ok(!b.urls.some(u => u.startsWith('/api/proxied-stashes/')));
    });
    test('chain text is escaped', () => {
        const html = proxiedStashesHtml({ stashes: [{ stash: '<b>x</b>', proxies: [{ type: '<i>T</i>', delay: 0 }], validating: null }] }, { esc: escapeHtml, shortAddr: (a) => a });
        assert.doesNotMatch(html, /<b>x<\/b>|<i>T<\/i>/);
    });
});

// ── A2: "Manage this validator" on the validator page ──
describe('A2 manageRole: who may manage this validator', () => {
    const same = (a, b) => a === b;
    test('the stash, its controller', () => {
        assert.deepEqual(manageRole({ stash: S1, controller: S1, me: S1, isSame: same }), { role: 'stash' });
        assert.deepEqual(manageRole({ stash: S1, controller: CTRL, me: CTRL, isSame: same }), { role: 'controller' });
    });
    test('a qualifying proxy: a type that can make a validator change, no announcement delay', () => {
        for (const type of ['Staking', 'NonTransfer', 'Any']) assert.deepEqual(manageRole({ stash: S1, me: ME, proxies: [{ delegate: ME, type, delay: 0 }], isSame: same }), { role: 'proxy', type });
        assert.deepEqual(manageRole({ stash: S1, me: ME, proxies: [{ delegate: ME, type: 'Governance', delay: 0 }], isSame: same }), { role: null });
        assert.deepEqual(manageRole({ stash: S1, me: ME, proxies: [{ delegate: ME, type: 'Staking', delay: 5 }], isSame: same }), { role: null });
        assert.deepEqual(manageRole({ stash: S1, me: ME, proxies: [{ delegate: OTHER, type: 'Any', delay: 0 }], isSame: same }), { role: null });
    });
    test('a member of the multisig that is the stash', () => {
        const m = { address: S1, signers: [ME, M2], threshold: 2 };
        assert.deepEqual(manageRole({ stash: S1, me: ME, multisig: m, isSame: same }), { role: 'multisig' });
        assert.deepEqual(manageRole({ stash: S1, me: OTHER, multisig: m, isSame: same }), { role: null });
        assert.deepEqual(manageRole({ stash: S2, me: ME, multisig: m, isSame: same }), { role: null });
    });
    test('anyone else, or nothing connected', () => {
        assert.deepEqual(manageRole({ stash: S1, controller: CTRL, me: OTHER, isSame: same }), { role: null });
        assert.deepEqual(manageRole({ stash: S1, me: '', isSame: same }), { role: null });
    });
});

function linkDeps(over = {}) {
    const log = { selected: [], routes: [], proxyReads: 0 };
    const d = {
        log, enabled: true, stash: S1, controller: CTRL,
        account: { status: 'connected', address: ME },
        readProxies: async () => { log.proxyReads++; return []; },
        findMultisig: () => null, isSame: (a, b) => a === b, esc: escapeHtml,
        selectMultisig: (a) => log.selected.push(a), navigate: (r) => log.routes.push(r),
        ...over
    };
    return d;
}

describe('A2 mountManageLink: the secondary button on the validator page', () => {
    test('the stash: a secondary link to its own dashboard', async () => {
        const { el } = pageDom();
        await mountManageLink(el, linkDeps({ account: { status: 'connected', address: S1 } }));
        const a = el.querySelector('a');
        assert.equal(a.textContent, MANAGE_LINK_TEXT);
        assert.equal(MANAGE_LINK_TEXT, 'Manage this validator');
        assert.equal(a.getAttribute('href'), '/validate');
        assert.ok(a.classList.contains('validate-secondary'));
        assert.equal(el.querySelectorAll('.validate-primary').length, 0);
    });
    test('the controller and a Staking proxy: a link to /validate/<stash>', async () => {
        const c = pageDom();
        await mountManageLink(c.el, linkDeps({ account: { status: 'connected', address: CTRL } }));
        assert.equal(c.el.querySelector('a').getAttribute('href'), '/validate/' + S1);
        const p = pageDom();
        await mountManageLink(p.el, linkDeps({ readProxies: async () => [{ delegate: ME, type: 'Staking', delay: 0 }] }));
        assert.equal(p.el.querySelector('a').getAttribute('href'), '/validate/' + S1);
    });
    test('a multisig member: the button switches to the multisig wallet, then opens its dashboard', async () => {
        const { el } = pageDom();
        const d = linkDeps({ findMultisig: (a) => (a === S1 ? { address: S1, signers: [ME, M2], threshold: 2 } : null) });
        await mountManageLink(el, d);
        const b = el.querySelector('button');
        assert.equal(b.textContent, MANAGE_LINK_TEXT);
        assert.ok(b.classList.contains('validate-secondary'));
        b.click(); await settle();
        assert.deepEqual(d.log.selected, [S1]);
        assert.deepEqual(d.log.routes, ['validate']);
    });
    test('nobody with a role, a Governance proxy, the flag off, nothing connected, or a proxy read that fails: nothing', async () => {
        const cases = [
            linkDeps({ account: { status: 'connected', address: OTHER } }),
            linkDeps({ readProxies: async () => [{ delegate: ME, type: 'Governance', delay: 0 }] }),
            linkDeps({ enabled: false, account: { status: 'connected', address: S1 } }),
            linkDeps({ account: { status: 'disconnected', address: '' } }),
            linkDeps({ readProxies: async () => { throw new Error('rpc'); } })
        ];
        for (const d of cases) {
            const { el } = pageDom();
            await mountManageLink(el, d);
            assert.equal(el.innerHTML, '');
        }
        const off = linkDeps({ enabled: false });
        await mountManageLink(pageDom().el, off);
        assert.equal(off.log.proxyReads, 0, 'with the flag off the chain is not asked');
    });
    test('a proxy read that fails still gives the multisig member the button, and the stash its link', async () => {
        const boom = async () => { throw new Error('rpc'); };
        const { el } = pageDom();
        await mountManageLink(el, linkDeps({ readProxies: boom, findMultisig: (a) => (a === S1 ? { address: S1, signers: [ME, M2], threshold: 2 } : null) }));
        assert.ok(el.querySelector('button'), 'the multisig button survives a failed proxy read');
        const c = pageDom();
        await mountManageLink(c.el, linkDeps({ readProxies: boom, account: { status: 'connected', address: CTRL } }));
        assert.equal(c.el.querySelector('a').getAttribute('href'), '/validate/' + S1);
    });
    test('a newer mount wins over a slower earlier one (wallet changed while reading)', async () => {
        const { el } = pageDom();
        let release; const gate = new Promise(r => { release = r; });
        const slow = mountManageLink(el, linkDeps({ readProxies: async () => { await gate; return [{ delegate: ME, type: 'Staking', delay: 0 }]; } }));
        await mountManageLink(el, linkDeps({ account: { status: 'connected', address: OTHER } }));
        release(); await slow;
        assert.equal(el.innerHTML, '');
    });
    test('script.js mounts it on the validator page, behind the validate flag, and again on a wallet change', () => {
        const src = readRepo('script.js', import.meta.url);
        const body = bodyOf(src, 'fetchValidatorDetails');
        assert.match(body, /id="validator-manage-link-slot"/);
        assert.match(body, /mountValidatorManageLink\(/);
        const mount = bodyOf(src, 'mountValidatorManageLink');
        assert.match(mount, /enabled: VALIDATE_ON/);
        assert.match(mount, /onActiveAccountChange/);
    });
});
