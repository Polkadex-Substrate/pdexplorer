// The Democracy page's live controller (lib/democracy-view.js) with a fake
// api, fake timers and a fake page: route entry and exit, no duplicate feeds
// or polls on re-entry, the poll as the fallback, the in-place patch versus a
// full render, ?fresh=1 after a transaction, and the in-flight vote cell.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDemocracyView, DEMOCRACY_POLL_MS } from '../lib/democracy-view.js';

const scriptSrc = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const fnBody = (sig) => { const at = scriptSrc.indexOf(sig); assert.ok(at !== -1, sig + ' not found'); return scriptSrc.slice(at, scriptSrc.indexOf('\n}', at)); };

const PDEX = 10n ** 12n;
const codec = (v) => ({ toString: () => String(v), toNumber: () => Number(v) });
const bal = (p) => codec((BigInt(p) * PDEX).toString());
const ongoing = (ayes) => ({ isSome: true, isNone: false, unwrap: () => ({ isOngoing: true, asOngoing: { end: codec(900), threshold: codec('SimpleMajority'), proposal: codec('0xaa'), tally: { ayes: bal(ayes), nays: bal(0), turnout: bal(ayes) } } }) });
const flush = () => new Promise(r => setTimeout(r, 10));

function fakeWorld(opts = {}) {
    const subs = [];
    const cbs = {};
    const args = {};
    let account = 'eAlice';
    let infoCb = null;
    const handlers = {};
    const mk = (name) => (...a) => { cbs[name] = a[a.length - 1]; args[name] = a.slice(0, -1); subs.push(name); return Promise.resolve(() => subs.splice(subs.indexOf(name), 1)); };
    const api = {
        isConnected: true,
        on: (ev, h) => { (handlers[ev] = handlers[ev] || []).push(h); },
        off: (ev, h) => { handlers[ev] = (handlers[ev] || []).filter(x => x !== h); },
        query: { democracy: {
            referendumCount: mk('count'), lowestUnbaked: mk('lowest'), publicProps: mk('props'), votingOf: mk('votingOf'),
            referendumInfoOf: { multi: (k, cb) => { infoCb = cb; subs.push('info'); return Promise.resolve(() => subs.splice(subs.indexOf('info'), 1)); } }
        } }
    };
    let apiNow = opts.noApi ? null : api;
    const intervals = new Map(); const timeouts = new Map(); let seq = 0;
    const timers = {
        setInterval: (fn, ms) => { intervals.set(++seq, { fn, ms }); return seq; },
        clearInterval: (id) => intervals.delete(id),
        setTimeout: (fn, ms) => { timeouts.set(++seq, { fn, ms }); return seq; },
        clearTimeout: (id) => timeouts.delete(id)
    };
    const cells = new Map();   // key -> { innerHTML }
    const root = { querySelectorAll: (sel) => { const k = /data-dem-cell="([^"]+)"/.exec(sel)[1]; return cells.has(k) ? [cells.get(k)] : []; } };
    let rest = { status: 'Synced', referendumCount: 3, referenda: [{ refIndex: 2, status: 'Ongoing', endBlock: 900, ayes: 1, nays: 0, turnout: 1, tallyKnown: 1 }], publicProposals: [] };
    const log = { full: 0, refresh: [], fetched: [] };
    let view;
    const deps = {
        getApi: () => apiNow, account: () => account, toAddress: (a) => a,
        getRest: () => rest, tab: () => 'referenda', extra: () => 'all', root: () => root,
        renderFull: () => { log.full++; const d = view.data(); for (const r of d.referenda) for (const p of ['tally', 'turnout', 'vote']) cells.set(`ref:${r.refIndex}:${p}`, { innerHTML: '' }); view.rendered(d); },
        refresh: (o) => log.refresh.push(o),
        helpers: { pdex: (v) => Number(v || 0).toFixed(1), num: String, esc: String },
        timers, visible: () => true,
        fetch: (url, o) => { log.fetched.push(url); return Promise.resolve({ url, o }); }
    };
    view = createDemocracyView(deps);
    return { api, view, subs, cbs, args, setApi: (a) => { apiNow = a; }, setAccount: (a) => { account = a; }, emitInfo: (l) => infoCb(l), timers, intervals, timeouts, cells, log, handlers, setRest: (r) => { rest = r; } };
}

describe('route entry and exit', () => {
    test('one feed and one poll, however often the route is entered', async () => {
        const w = fakeWorld();
        w.view.start();
        w.view.start();
        await flush();
        assert.equal(w.subs.filter(s => s === 'count').length, 1);
        assert.equal(w.intervals.size, 1);
        assert.equal([...w.intervals.values()][0].ms, DEMOCRACY_POLL_MS);
        w.view.stop();
        await flush();
        assert.deepEqual(w.subs, [], 'subscriptions left after leaving the page');
        assert.equal(w.intervals.size, 0);
        w.view.start();
        await flush();
        assert.equal(w.subs.filter(s => s === 'count').length, 1);
        assert.equal(w.intervals.size, 1);
        w.view.stop();
    });

    test('the poll refreshes quietly; stop() also cancels pending catch-up refetches', async () => {
        const w = fakeWorld();
        w.view.start();
        [...w.intervals.values()][0].fn();
        assert.deepEqual(w.log.refresh, [{ quiet: true }]);
        w.cbs.count(codec(3)); w.cbs.lowest(codec(2));
        w.cbs.count(codec(4));   // a new referendum: catch-up refetch scheduled
        assert.equal(w.timeouts.size, 1);
        w.view.stop();
        assert.equal(w.timeouts.size, 0);
    });

    test('link down: no live data, the REST values show; link up: live again', async () => {
        const w = fakeWorld();
        w.view.start();
        w.cbs.count(codec(3)); w.cbs.lowest(codec(2));
        w.emitInfo([ongoing(50)]);
        assert.equal(w.view.data().referenda[0].ayes, 50);
        w.api.isConnected = false;
        (w.handlers.disconnected || []).forEach(h => h());
        assert.equal(w.view.data().referenda[0].ayes, 1, 'frozen live tally shown over the poll');
        w.view.stop();
    });
});

describe('late node link and wallet changes', () => {
    test('page opened before the api: the feed starts when the api is ready, once', async () => {
        const w = fakeWorld({ noApi: true });
        w.view.start();
        await flush();
        assert.deepEqual(w.subs, [], 'no feed without an api');
        assert.equal(w.intervals.size, 1, 'the REST poll runs meanwhile');
        w.setApi(w.api);
        w.view.start();                     // what adoptChainApi does
        w.view.start();                     // and a second call is harmless
        await flush();
        assert.equal(w.subs.filter(s => s === 'count').length, 1);
        assert.equal(w.intervals.size, 1, 'a second poll was started');
        w.view.stop();
        await flush();
        assert.deepEqual(w.subs, []);
    });

    test('adoptChainApi starts the democracy feed only if the page is open', () => {
        assert.match(fnBody('function adoptChainApi(api)'), /if \(democracyView\.active\(\)\) democracyView\.start\(\);/);
    });

    test('a wallet change restarts the feed on the new account; nothing when the page is closed', async () => {
        const w = fakeWorld();
        w.view.restart();
        await flush();
        assert.deepEqual(w.subs, [], 'restart opened a closed page');
        w.view.start();
        await flush();
        assert.deepEqual(w.args.votingOf, ['eAlice']);
        w.setAccount('eBob');
        w.view.restart();
        await flush();
        assert.deepEqual(w.args.votingOf, ['eBob']);
        assert.equal(w.subs.filter(s => s === 'count').length, 1, 'the old feed was left running');
        assert.equal(w.intervals.size, 1);
        w.setAccount('');
        w.view.restart();
        await flush();
        assert.ok(!w.subs.includes('votingOf'), 'disconnected wallet still watched');
        w.view.stop();
    });

    test('setStoredWallet restarts the democracy view when the wallet actually changes', () => {
        const body = fnBody('function setStoredWallet(addr)');
        assert.match(body, /const before = getStoredWallet\(\);/);
        assert.match(body, /if \(getStoredWallet\(\) !== before\) democracyView\.restart\(\);/);
    });

    test('council catch-up refetches are cleared on leaving the page', () => {
        const live = fnBody('function startCouncilLive()');
        const all = live.split('setTimeout(').length - 1;
        assert.ok(all >= 1);
        assert.equal(live.split('councilCatchup[key] = setTimeout(').length - 1, all, 'a catch-up timer nobody can clear');
        assert.match(fnBody('function stopCouncilPolling()'), /for \(const k in councilCatchup\) clearTimeout\(councilCatchup\[k\]\);/);
    });

    // The referendum and proposal detail modals became pages (lib/gov-detail-view.js,
    // 2026-10-26); a call the server cannot show yet still gets a placeholder, not a blank.
    test('the item pages show a placeholder for a call the server does not have yet', async () => {
        const { renderCall } = await import('../lib/gov-detail-view.js');
        const h = { esc: (s) => String(s).replace(/</g, '&lt;') };
        assert.match(renderCall({ call: null, callNote: null }, h), /The call is not available\./);
        assert.match(renderCall({ call: null, callNote: 'The preimage of this call is not noted on chain.' }, h), /preimage of this call is not noted/);
        assert.ok(!/formatGovHash\(/.test(scriptSrc), 'the modal helper is gone with the modals');
    });
});

describe('patch or full render', () => {
    test('a live tally patches the two cells; a new referendum renders in full', async () => {
        const w = fakeWorld();
        w.view.start();
        w.log.full = 0;
        w.view.update();               // first update: no frame yet -> full
        assert.equal(w.log.full, 1);
        w.cbs.count(codec(3)); w.cbs.lowest(codec(2));
        w.emitInfo([ongoing(7)]);
        await flush();
        assert.equal(w.log.full, 1, 'a tally change redrew the page');
        assert.equal(w.cells.get('ref:2:tally').innerHTML, '7.0 / 0.0');
        assert.equal(w.cells.get('ref:2:turnout').innerHTML, '7.0');
        w.setRest({ status: 'Synced', referendumCount: 4, referenda: [{ refIndex: 2, status: 'Ongoing', endBlock: 900, ayes: 1, nays: 0, turnout: 1, tallyKnown: 1 }, { refIndex: 3, status: 'Ongoing', endBlock: 990, ayes: 0, nays: 0, turnout: 0, tallyKnown: 1 }], publicProposals: [] });
        w.view.update();
        assert.equal(w.log.full, 2);
        w.view.stop();
    });
});

describe('transactions from the page', () => {
    test('?fresh=1 after a transaction and for the next two polls', async () => {
        const w = fakeWorld();
        w.view.start();
        await w.view.fetchRest(true);
        await w.view.fetchRest(false);
        await w.view.fetchRest(false);
        await w.view.fetchRest(false);
        assert.deepEqual(w.log.fetched, ['/api/democracy?fresh=1', '/api/democracy?fresh=1', '/api/democracy?fresh=1', '/api/democracy']);
        w.view.stop();
    });

    test('a vote in flight shows on its row, asks for a fresh copy in a block, and settles on the voting record', async () => {
        const w = fakeWorld();
        w.view.start();
        w.view.update();
        const stage = w.view.stage('ref:2', 'aye');
        stage('broadcast');
        assert.match(w.cells.get('ref:2:vote').innerHTML, /Your Aye is being recorded/);
        stage('inBlock');
        assert.deepEqual(w.log.refresh.pop(), { fresh: true, quiet: true });
        assert.ok(w.view.pending('ref:2'), 'settled before the voting record showed the vote');
        w.cbs.votingOf({ isDirect: true, asDirect: { votes: [[codec(2), { isStandard: true, asStandard: { vote: { isAye: true, conviction: codec('Locked1x') }, balance: bal(3) } }]] } });
        await flush();
        assert.equal(w.view.pending('ref:2'), null);
        assert.match(w.cells.get('ref:2:vote').innerHTML, /You voted Aye with 3\.0 PDEX/);
        w.view.stop();
    });

    test('a failed vote keeps its reason on the row', () => {
        const w = fakeWorld();
        w.view.start();
        w.view.update();
        w.view.stage('ref:2', 'nay')('failed', { text: 'Not enough PDEX' });
        assert.match(w.cells.get('ref:2:vote').innerHTML, /Not enough PDEX/);
        w.view.stop();
    });
});
