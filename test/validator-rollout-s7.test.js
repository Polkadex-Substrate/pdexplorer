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
import { proxyCandidates, readProxiedStashes, registerProxiedStashesRoute, PROXIED_STASHES_ROUTE, MAX_CANDIDATES, PROXY_EVENT_LIMIT, PROXIED_TTL_MS, proxiedStashesHtml } from '../lib/proxied-stashes.js';
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
    const gate = (req, res) => { const a = req.params.address; if (!/^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(a)) { res.status(400).json({ error: 'Invalid Polkadex address.' }); return null; } return { address: a }; };
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
    test('server.js registers the route with the event index lookup and the status rate limit', () => {
        const src = readRepo('server.js', import.meta.url);
        assert.match(src, /registerProxiedStashesRoute\(app, \{[^}]*events: \(address, limit\) => db\.getProxyEventsFor\(address, limit\)/);
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
        assert.equal(sec.querySelector('h3').textContent, 'Stashes you are a proxy for');
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
    test('nothing found, a failed read or a capped list: nothing extra, or the cap said in words', async () => {
        for (const proxied of [{ address: ME, stashes: [], capped: false }, new Error('503')]) {
            const { el } = pageDom();
            await mountValidatePage(el, pageDeps(proxied)); await settle();
            assert.equal(el.querySelector('#validate-proxied-slot').innerHTML, '');
        }
        const { el } = pageDom();
        await mountValidatePage(el, pageDeps({ address: ME, capped: true, stashes: [{ stash: S1, proxies: [{ type: 'Staking', delay: 0 }], validating: true }] })); await settle();
        assert.match(el.querySelector('#validate-proxied-slot').textContent, /first 16/);
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
