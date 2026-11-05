// "Handle situations when the nominator's validator is offline" (CEO request,
// Nov 2026). For each validator a nominator backs: is it active this era,
// waiting, gone, blocked, at 100% commission, offline, disabled or recently
// slashed; and two banners: no rewards this era, and some validators offline.
//
//   lib/nomination-status.js        pure: classification, banners
//   lib/nomination-status-chain.js  the chain reads
//   lib/nomination-status-api.js    GET /api/account/:address/staking-status
//   lib/nomination-status-view.js   the panel on the wallet and account pages
//   db.js getValidatorIncidents     recent imOnline.SomeOffline and staking
//                                   slash events naming a validator
//
// Runtime facts (spec 392; polkadex-node runtimes/mainnet/src/lib.rs and
// pallet-im-online 44.0.0): ImOnline is present and reports to Offences
// (ReportUnresponsiveness = Offences, OnOffenceHandler = Staking). A
// validator is online in a session if it sent a heartbeat or authored a
// block; heartbeats go out from 10% of the session and by 80% at the latest;
// at the session end the rest are reported. The unresponsiveness slash is 0
// unless more than n/10 + 1 of the n validators are offline in the same
// session, then 7% x 3(k - (n/10 + 1))/n.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { classifyTarget, nominationModel, offlineSlashThreshold, OFFLINE_PROGRESS } from '../lib/nomination-status.js';
import { readNominationStatus } from '../lib/nomination-status-chain.js';
import { registerStakingStatusRoute, STAKING_STATUS_ROUTE } from '../lib/nomination-status-api.js';
import { renderNominationStatus, mountNominationStatus } from '../lib/nomination-status-view.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { allRoutes } from '../lib/api-reference.js';
import * as db from '../db.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';

const PDEX = 10n ** 12n;
// Made-up accounts (public repo): 0x11.., 0x33.., 0x44.., 0x55.., 0x66.. at prefix 88.
const ME = 'esm9mgCefMrQ2EbGGyMNXGAFA3vnRGDid7GheURpcFRTjyokX';
const V1 = 'esmvXSjXFQpnFb8ejm2Hj3cYgQPjf8uoVXvufVKWP7QLjt9Js';
const V2 = 'esnJuKzxYSJyNGQLy9rkKwLhSadDH5FqvkG1fzmMGYPnEqNp6';
const V3 = 'esnhHDGPqToAUwg3CYhCvq4rCkrgu1btMxb7gWDC9yPDjnXpU';
const V4 = 'eso5f6Xq8VHMbcwjRwXfXinzxw6AWwwvoAvDh1f33QNfEjVcN';
const FULL = 1_000_000_000;   // Perbill 100%

const tgt = (address, over = {}) => ({ address, name: null, intent: true, commission: 50_000_000, blocked: false, elected: true,
    inSession: true, heartbeat: true, blocks: 3, disabled: false, lastSlashEra: null, incidents: [], ...over });
const ctx = (over = {}) => ({ activeEra: 500, sessionProgress: 0.9, imOnline: true, slashRecentEras: 28, ...over });
const flags = (t, c) => classifyTarget(t, ctx(c)).flags;

describe('classifyTarget: one validator, from the nominator\'s side', () => {
    test('active this era', () => {
        const r = classifyTarget(tgt(V1), ctx());
        assert.equal(r.state, 'active');
        assert.match(r.label, /[Aa]ctive/);
        assert.deepEqual(r.flags, []);
    });
    test('waiting: wants to validate but was not elected', () => {
        const r = classifyTarget(tgt(V1, { elected: false, inSession: false, heartbeat: null, blocks: null }), ctx());
        assert.equal(r.state, 'waiting');
        assert.match(r.label, /[Ww]aiting/);
    });
    test('chilled or no longer a validator: no Validators entry', () => {
        const r = classifyTarget(tgt(V1, { intent: false, elected: false, inSession: false }), ctx());
        assert.equal(r.state, 'not-validator');
        assert.match(r.label, /[Cc]hilled|no longer/);
    });
    test('elected this era but chilled since: still active this era, flagged as leaving', () => {
        const r = classifyTarget(tgt(V1, { intent: false }), ctx());
        assert.equal(r.state, 'active');
        assert.ok(r.flags.includes('leaving'));
    });
    test('blocked and 100% commission are flags', () => {
        assert.ok(flags(tgt(V1, { blocked: true })).includes('blocked'));
        assert.ok(flags(tgt(V1, { commission: FULL })).includes('commission100'));
        assert.ok(!flags(tgt(V1, { commission: FULL - 1 })).includes('commission100'));
    });
    test('offline: in the session set, no heartbeat and no block after the heartbeat window', () => {
        assert.ok(flags(tgt(V1, { heartbeat: false, blocks: 0 }), { sessionProgress: OFFLINE_PROGRESS }).includes('offline'));
    });
    test('not offline yet early in the session: no heartbeat is normal before 80%', () => {
        const f = flags(tgt(V1, { heartbeat: false, blocks: 0 }), { sessionProgress: 0.4 });
        assert.ok(!f.includes('offline'));
        assert.ok(f.includes('not-seen-yet'));
    });
    test('a heartbeat or an authored block counts as online', () => {
        assert.ok(!flags(tgt(V1, { heartbeat: true, blocks: 0 })).includes('offline'));
        assert.ok(!flags(tgt(V1, { heartbeat: false, blocks: 2 })).includes('offline'));
    });
    test('without imOnline nothing is called offline', () => {
        assert.ok(!flags(tgt(V1, { heartbeat: null, blocks: null }), { imOnline: false }).includes('offline'));
    });
    test('disabled in this session (an offence)', () => {
        assert.ok(flags(tgt(V1, { disabled: true })).includes('disabled'));
    });
    test('reported offline at a recent session end (imOnline.SomeOffline)', () => {
        const r = classifyTarget(tgt(V1, { incidents: [{ block: 990_000, kind: 'imOnline.SomeOffline' }] }), ctx());
        assert.ok(r.flags.includes('reported-offline'));
        assert.ok(r.notes.some(n => /990,000|990000/.test(n)));
    });
    test('slashed recently: SlashingSpans.lastNonzeroSlash within the lookback, or a slash event', () => {
        assert.ok(flags(tgt(V1, { lastSlashEra: 480 })).includes('slashed'));
        assert.ok(!flags(tgt(V1, { lastSlashEra: 400 })).includes('slashed'), 'older than the lookback');
        assert.ok(!flags(tgt(V1, { lastSlashEra: 0 })).includes('slashed'), 'era 0 is the "never" default');
        assert.ok(flags(tgt(V1, { incidents: [{ block: 1, kind: 'staking.SlashReported' }] })).includes('slashed'));
    });
});

function snap(targets, over = {}) {
    return { address: ME, nominating: true, submittedIn: 400, activeEra: 500, currentEra: 500, sessionIndex: 3000,
        sessionProgress: 0.9, validatorCount: 20, imOnline: true, bondingDuration: 28, block: 1_000_000, targets, ...over };
}

describe('nominationModel: banners', () => {
    test('not nominating: nothing to show', () => {
        const m = nominationModel({ address: ME, nominating: false, targets: [] });
        assert.equal(m.nominating, false);
        assert.deepEqual(m.banners, []);
    });
    test('none active: "You are earning no rewards this era", keep nothing so the picker replaces them all', () => {
        const m = nominationModel(snap([tgt(V1, { elected: false, inSession: false }), tgt(V2, { intent: false, elected: false, inSession: false })]));
        assert.equal(m.earning, false);
        const b = m.banners.find(x => x.kind === 'no-rewards');
        assert.ok(b);
        assert.equal(b.title, 'You are earning no rewards this era');
        assert.deepEqual(b.keep, []);
        assert.equal(b.action, 'change');
    });
    test('active but 100% commission does not count as earning', () => {
        const m = nominationModel(snap([tgt(V1, { commission: FULL })]));
        assert.equal(m.earning, false);
        assert.ok(m.banners.some(b => b.kind === 'no-rewards'));
    });
    test('one active validator is enough to earn: no "no rewards" banner', () => {
        const m = nominationModel(snap([tgt(V1), tgt(V2, { elected: false, inSession: false })]));
        assert.equal(m.earning, true);
        assert.ok(!m.banners.some(b => b.kind === 'no-rewards'));
    });
    test('nominations made this era: the banner says they count from the next election, and offers no change', () => {
        const m = nominationModel(snap([tgt(V1, { elected: false, inSession: false })], { submittedIn: 500 }));
        const b = m.banners.find(x => x.kind === 'no-rewards');
        assert.match(b.text, /next/);
        assert.equal(b.action, null);
    });
    test('some offline: names them, explains the risk, keeps the others for the picker', () => {
        const m = nominationModel(snap([tgt(V1, { name: 'Alpha' }), tgt(V2, { name: 'Beta', heartbeat: false, blocks: 0 }), tgt(V3, { disabled: true })]));
        const b = m.banners.find(x => x.kind === 'offline');
        assert.ok(b);
        assert.match(b.text, /Beta/);
        assert.match(b.text, /missed rewards|miss rewards|no era points/);
        assert.match(b.text, /slash/);
        assert.deepEqual(b.keep, [V1]);
        assert.equal(b.action, 'change');
    });
    test('reported offline at a recent session end also counts', () => {
        const m = nominationModel(snap([tgt(V1), tgt(V4, { incidents: [{ block: 999_000, kind: 'imOnline.SomeOffline' }] })]));
        assert.deepEqual(m.banners.find(x => x.kind === 'offline').keep, [V1]);
    });
    test('no offline source: the model says detection is unavailable', () => {
        const m = nominationModel(snap([tgt(V1, { heartbeat: null, blocks: null })], { imOnline: false }));
        assert.equal(m.offline.source, 'none');
        assert.match(m.offline.note, /not available|cannot/);
    });
    test('imOnline present: the source is named', () => {
        assert.equal(nominationModel(snap([tgt(V1)])).offline.source, 'imOnline');
    });
    test('the offline slash threshold: more than n/10 + 1 of n validators', () => {
        assert.equal(offlineSlashThreshold(20), 3);
        assert.equal(offlineSlashThreshold(5), 1);
        assert.match(nominationModel(snap([tgt(V2, { heartbeat: false, blocks: 0 })])).banners.find(x => x.kind === 'offline').text, /more than 3 of the 20/);
    });
});

// A hand-built api: three nominated validators, V1 active and online, V2
// waiting, V3 gone, V4 active and silent.
function fakeApi({ nominator = { targets: [V1, V2, V3, V4], submittedIn: 400 }, imOnline = true, sizeFn = true } = {}) {
    const num = (n) => ({ toString: () => String(n), toNumber: () => Number(n) });
    const opt = (v) => ({ isSome: v != null, isNone: v == null, unwrap: () => v });
    const prefs = { [V1]: { commission: num(50_000_000), blocked: { isTrue: false, valueOf: () => false } }, [V2]: { commission: num(100_000_000), blocked: { isTrue: true, valueOf: () => true } }, [V4]: { commission: num(0), blocked: { valueOf: () => false } } };
    const validators = async (a) => prefs[a] || { commission: num(0), blocked: { valueOf: () => false } };
    if (sizeFn) validators.size = async (a) => num(prefs[a] ? 6 : 0);
    const api = {
        consts: { staking: { bondingDuration: num(28) }, babe: { epochDuration: num(1200) } },
        query: {
            system: { number: async () => num(1_000_000) },
            staking: {
                nominators: async () => opt(nominator && { targets: nominator.targets, submittedIn: num(nominator.submittedIn) }),
                activeEra: async () => opt({ index: num(500) }),
                currentEra: async () => opt(num(500)),
                validators,
                erasStakersOverview: async (era, a) => opt([V1, V4].includes(a) ? { total: num(1) } : null),
                slashingSpans: async (a) => opt(a === V4 ? { lastNonzeroSlash: num(490), prior: [] } : null)
            },
            session: { validators: async () => [V4, V1], currentIndex: async () => num(3000), disabledValidators: async () => [[num(0), num(1)]] },
            babe: { epochIndex: async () => num(10), genesisSlot: async () => num(1000), currentSlot: async () => num(1000 + 10 * 1200 + 1100) }
        }
    };
    if (imOnline) api.query.imOnline = {
        receivedHeartbeats: async (s, i) => opt(Number(i) === 1 ? true : null),
        authoredBlocks: async (s, a) => num(a === V1 ? 4 : 0)
    };
    return api;
}

describe('readNominationStatus: the chain reads', () => {
    test('not a nominator', async () => {
        const r = await readNominationStatus(fakeApi({ nominator: null }), ME);
        assert.equal(r.nominating, false);
        assert.deepEqual(r.targets, []);
    });
    test('each target: intent, prefs, elected this era, session index, heartbeat, blocks, disabled, last slash', async () => {
        const r = await readNominationStatus(fakeApi(), ME, { now: 0, nameOf: async (a) => (a === V1 ? 'Alpha' : null), incidents: (a) => (a === V4 ? [{ block: 990_000, kind: 'imOnline.SomeOffline' }] : []) });
        assert.equal(r.nominating, true);
        assert.equal(r.activeEra, 500);
        assert.equal(r.sessionIndex, 3000);
        assert.equal(r.validatorCount, 2);
        assert.equal(r.imOnline, true);
        assert.ok(Math.abs(r.sessionProgress - 1100 / 1200) < 1e-9);
        const by = Object.fromEntries(r.targets.map(t => [t.address, t]));
        assert.deepEqual(
            [by[V1].name, by[V1].intent, by[V1].elected, by[V1].inSession, by[V1].heartbeat, by[V1].blocks, by[V1].disabled],
            ['Alpha', true, true, true, true, 4, false]);
        assert.deepEqual([by[V2].intent, by[V2].elected, by[V2].commission, by[V2].blocked], [true, false, 100_000_000, true]);
        assert.deepEqual([by[V3].intent, by[V3].elected, by[V3].inSession], [false, false, false]);
        assert.deepEqual([by[V4].heartbeat, by[V4].blocks, by[V4].disabled, by[V4].lastSlashEra], [false, 0, true, 490]);
        assert.deepEqual(by[V4].incidents, [{ block: 990_000, kind: 'imOnline.SomeOffline' }]);
        const m = nominationModel(r);
        assert.deepEqual(m.banners.find(b => b.kind === 'offline').keep, [V1, V2]);
    });
    test('no imOnline pallet: heartbeat and blocks are null and imOnline false', async () => {
        const r = await readNominationStatus(fakeApi({ imOnline: false }), ME);
        assert.equal(r.imOnline, false);
        assert.ok(r.targets.every(t => t.heartbeat === null && t.blocks === null));
    });
    test('no .size on the validators entry: intent is unknown (null), never guessed', async () => {
        const r = await readNominationStatus(fakeApi({ sizeFn: false }), ME);
        assert.ok(r.targets.every(t => t.intent === null));
    });
    test('an incidents lookup that throws is ignored', async () => {
        const r = await readNominationStatus(fakeApi(), ME, { incidents: () => { throw new Error('db busy'); } });
        assert.ok(r.targets.every(t => Array.isArray(t.incidents) && t.incidents.length === 0));
    });
});

describe('db.getValidatorIncidents: recent offline reports and slashes from the event index', () => {
    const dirs = [];
    after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
    test('returns SomeOffline, SlashReported and Slashed naming the validator since a block, newest first', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-inc-'));
        dirs.push(dir);
        db.initDb(dir, false, { awaitMigrator: false });
        const ev = (hash, block, section, method, accounts) => ({ hash, block, eventIndex: 0, section, method, data: {}, accounts });
        db.insertEvents([
            ev('0x01', 100, 'imOnline', 'SomeOffline', [V1]),
            ev('0x02', 200, 'imOnline', 'SomeOffline', [V1]),
            ev('0x03', 300, 'staking', 'SlashReported', [V1]),
            ev('0x04', 310, 'balances', 'Transfer', [V1]),
            ev('0x05', 320, 'imOnline', 'SomeOffline', [V2])
        ]);
        assert.deepEqual(db.getValidatorIncidents(V1, 150), [{ block: 300, kind: 'staking.SlashReported' }, { block: 200, kind: 'imOnline.SomeOffline' }]);
        assert.deepEqual(db.getValidatorIncidents(V2, 0), [{ block: 320, kind: 'imOnline.SomeOffline' }]);
    });
});

describe(`GET ${'/api/account/:address/staking-status'}`, () => {
    let server, base, api, ready = true, seen = [];
    const SHORT = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
    before(async () => {
        api = fakeApi();
        const app = express();
        registerStakingStatusRoute(app, {
            api: () => api,
            ready: (res) => { if (ready) return true; res.set('Cache-Control', 'no-store'); res.status(503).json({ code: 'RPC_NOT_READY' }); return false; },
            gate: (req, res) => { if (!/^e[1-9A-HJ-NP-Za-km-z]{40,}$/.test(req.params.address)) { res.status(400).json({ error: 'Invalid Polkadex address.' }); return null; } return { address: req.params.address }; },
            cacheShort: (res) => res.set('Cache-Control', SHORT),
            serverError: (res) => { res.set('Cache-Control', 'no-store'); res.status(500).json({ error: 'Internal error.' }); },
            incidents: (a, since) => { seen.push([a, since]); return []; },
            nameOf: async () => null
        });
        await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => { if (server) server.close(); });
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }; };
    test('the route path constant', () => assert.equal(STAKING_STATUS_ROUTE, '/api/account/:address/staking-status'));
    test('200: the model, short cache tier; incidents asked per target since about a week back', async () => {
        seen = [];
        const r = await get(`/api/account/${ME}/staking-status`);
        assert.equal(r.status, 200);
        assert.equal(r.cache, SHORT);
        assert.equal(r.body.address, ME);
        assert.equal(r.body.nominating, true);
        assert.equal(r.body.targets.length, 4);
        assert.ok(Array.isArray(r.body.banners));
        assert.equal(seen.length, 4);
        assert.equal(seen[0][1], 1_000_000 - 7 * 7200);
    });
    test('400 on a bad address', async () => assert.equal((await get('/api/account/nope/staking-status')).status, 400));
    test('503 when the node is not connected', async () => {
        ready = false;
        try { const r = await get(`/api/account/${ME}/staking-status`); assert.equal(r.status, 503); assert.equal(r.cache, 'no-store'); }
        finally { ready = true; }
    });
    test('500 no-store when a chain read fails', async () => {
        const saved = api.query.staking.nominators;
        api.query.staking.nominators = async () => { throw new Error('rpc gone'); };
        try { const r = await get(`/api/account/${ME}/staking-status`); assert.equal(r.status, 500); assert.equal(r.cache, 'no-store'); }
        finally { api.query.staking.nominators = saved; }
    });
});

describe('renderNominationStatus and mountNominationStatus', () => {
    const model = () => nominationModel(snap([tgt(V1, { name: 'Alpha <b>' , elected: false, inSession: false }), tgt(V2, { intent: false, elected: false, inSession: false })]));
    test('not nominating: renders nothing', () => {
        assert.equal(renderNominationStatus(nominationModel({ nominating: false, targets: [] })), '');
    });
    test('the banner, one row per validator, names escaped', () => {
        const html = renderNominationStatus(model(), { canChange: true });
        assert.match(html, /You are earning no rewards this era/);
        assert.match(html, /data-nom-action="change" data-banner="no-rewards"/);
        assert.match(html, /Change validators/);
        assert.match(html, /Alpha &lt;b&gt;/);
        assert.ok(!html.includes('Alpha <b>'));
        assert.match(html, /[Ww]aiting/);
        assert.match(html, /[Cc]hilled|no longer/);
        assert.match(html, /\/help\/staking-status/);
    });
    test('visitors see the banner but no button', () => {
        assert.doesNotMatch(renderNominationStatus(model(), { canChange: false }), /data-nom-action/);
    });
    test('mount: one fetch of /staking-status, and the button opens the picker with the validators to keep', async () => {
        const urls = []; const opened = [];
        const handlers = {};
        const el = { innerHTML: '', isConnected: true, addEventListener: (t, fn) => { handlers[t] = fn; } };
        const m = nominationModel(snap([tgt(V1), tgt(V2, { heartbeat: false, blocks: 0 })]));
        await mountNominationStatus(el, ME, { fetchJson: async (u) => { urls.push(u); return { address: ME, ...m }; }, canChange: () => true, openPicker: (keep) => opened.push(keep) });
        assert.deepEqual(urls, [`/api/account/${encodeURIComponent(ME)}/staking-status`]);
        const button = { getAttribute: (k) => ({ 'data-nom-action': 'change', 'data-banner': 'offline' })[k] };
        handlers.click({ target: { closest: () => button } });
        assert.deepEqual(opened, [[V1]]);
    });
    test('mount: a failed fetch leaves the slot empty (the locks panel already explains the stake)', async () => {
        const el = { innerHTML: 'x', isConnected: true };
        await mountNominationStatus(el, ME, { fetchJson: async () => { throw new Error('boom'); } });
        assert.equal(el.innerHTML, '');
    });
});

describe('wiring: server, docs, help, both pages, the picker', () => {
    const server = stripComments(readRepo('server.js', import.meta.url));
    const script = stripComments(readRepo('script.js', import.meta.url));
    test('server.js registers the route with the shared gate, requireRpc, cacheShort, serverError and the incident lookup', () => {
        assert.match(server, /registerStakingStatusRoute\(app, \{[^}]*requireRpc[^}]*cacheShort[^}]*serverError[^}]*getValidatorIncidents[^}]*\}\)/s);
    });
    test('documented in the API reference (Short tier), README and llms.txt', () => {
        assert.ok(allRoutes().some(r => r.method === 'GET' && r.path === '/api/account/:address/staking-status'));
        assert.match(readRepo('lib/api-reference.js', import.meta.url), /name: 'Short'[\s\S]*?'\/api\/account\/:address\/staking-status'[\s\S]*?name: 'Medium'/);
        assert.match(readRepo('README.md', import.meta.url), /\/api\/account\/:address\/staking-status/);
        assert.match(readRepo('public/llms.txt', import.meta.url), /\/api\/account\/:address\/staking-status/);
        assert.match(readRepo('test/developers-outline.test.js', import.meta.url), /'\/api\/account\/:address\/staking-status'/);
    });
    test('a help article, in the sitemap, without dashes', () => {
        const t = HELP_TOPICS.find(x => x.slug === 'staking-status');
        assert.ok(t);
        for (const w of ['You are earning no rewards this era', 'Waiting', 'Chilled', 'heartbeat', 'offline', 'slash', 'Change validators', '100%']) assert.ok(t.body.includes(w), `article lacks "${w}"`);
        assert.ok(!/[\u2013\u2014]/.test(t.body + t.title));
        assert.match(server, /path: '\/help\/staking-status'/);
    });
    test('both pages mount the panel; the wallet one can open the picker', () => {
        assert.match(script, /import \{ mountNominationStatus \} from '\.\/lib\/nomination-status-view\.js'/);
        assert.match(script, /id="wallet-nominations-slot"/);
        assert.match(script, /id="account-nominations-slot"/);
        assert.equal((script.match(/mountNominationStatus\(/g) || []).length, 2);
        assert.match(script, /openPicker: \(keep\) => openStakeModal\(keep\)/);
    });
    test('openStakeModal(keep) prefills only the validators to keep; a click event still prefills all nominations', () => {
        assert.match(script, /async function openStakeModal\(keep\)/);
        assert.match(script, /Array\.isArray\(keep\)/);
    });
    test('script.js stays under its 15,000 line ceiling', () => {
        assert.ok(readRepo('script.js', import.meta.url).split('\n').length <= 15000);
    });
});

const fx392 = loadFixture('metadata-392.json');
describe('spec 392 metadata: the storage the status reads', { skip: fx392 ? false : 'test/fixtures/metadata-392.json absent' }, () => {
    let registry;
    before(() => { registry = registryFromMetadata(fx392.metadata); registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 88 })); });
    const storage = (p, item) => registry.metadata.pallets.find(x => x.name.toString() === p)?.storage.unwrap().items.find(i => i.name.toString() === item);
    test('every item exists', () => {
        for (const [p, i] of [['Staking', 'Nominators'], ['Staking', 'Validators'], ['Staking', 'ErasStakersOverview'], ['Staking', 'SlashingSpans'], ['Staking', 'ActiveEra'],
            ['Session', 'Validators'], ['Session', 'CurrentIndex'], ['Session', 'DisabledValidators'], ['ImOnline', 'ReceivedHeartbeats'], ['ImOnline', 'AuthoredBlocks'],
            ['Babe', 'EpochIndex'], ['Babe', 'GenesisSlot'], ['Babe', 'CurrentSlot']]) assert.ok(storage(p, i), `${p}.${i}`);
    });
    test('real codecs through the reader', async () => {
        const T = (p, item, v) => {
            const it = storage(p, item);
            const name = registry.createLookupType(it.type.isPlain ? it.type.asPlain : it.type.asMap.value);
            return it.modifier.isOptional ? registry.createType(`Option<${name}>`, v) : registry.createType(name, v);
        };
        const validators = async (a) => T('Staking', 'Validators', a === V1 ? { commission: FULL, blocked: true } : { commission: 0, blocked: false });
        validators.size = async (a) => registry.createType('u64', a === V1 ? 5 : 0);
        const num = (n) => ({ toString: () => String(n) });
        const api = {
            consts: { staking: { bondingDuration: num(28) }, babe: { epochDuration: num(1200) } },
            query: {
                system: { number: async () => T('System', 'Number', 1_000_000) },
                staking: {
                    nominators: async () => T('Staking', 'Nominators', { targets: [V1, V2], submittedIn: 400, suppressed: false }),
                    activeEra: async () => T('Staking', 'ActiveEra', { index: 500, start: 1 }),
                    currentEra: async () => T('Staking', 'CurrentEra', 500),
                    validators,
                    erasStakersOverview: async (e, a) => T('Staking', 'ErasStakersOverview', a === V1 ? { total: 1, own: 1, nominatorCount: 1, pageCount: 1 } : null),
                    slashingSpans: async () => T('Staking', 'SlashingSpans', { spanIndex: 1, lastStart: 480, lastNonzeroSlash: 495, prior: [3] })
                },
                session: {
                    validators: async () => T('Session', 'Validators', [V1]),
                    currentIndex: async () => T('Session', 'CurrentIndex', 3000),
                    disabledValidators: async () => T('Session', 'DisabledValidators', [[0, 1000]])
                },
                imOnline: {
                    receivedHeartbeats: async () => T('ImOnline', 'ReceivedHeartbeats', null),
                    authoredBlocks: async () => T('ImOnline', 'AuthoredBlocks', 0)
                },
                babe: { epochIndex: async () => T('Babe', 'EpochIndex', 10), genesisSlot: async () => T('Babe', 'GenesisSlot', 0), currentSlot: async () => T('Babe', 'CurrentSlot', 10 * 1200 + 1100) }
            }
        };
        const r = await readNominationStatus(api, ME);
        const v1 = r.targets.find(t => t.address === V1), v2 = r.targets.find(t => t.address === V2);
        assert.deepEqual([v1.intent, v1.commission, v1.blocked, v1.elected, v1.inSession, v1.heartbeat, v1.blocks, v1.disabled, v1.lastSlashEra],
            [true, FULL, true, true, true, false, 0, true, 495]);
        assert.deepEqual([v2.intent, v2.elected, v2.inSession], [false, false, false]);
        const m = nominationModel(r);
        const c1 = m.targets.find(t => t.address === V1);
        for (const f of ['commission100', 'blocked', 'offline', 'disabled', 'slashed']) assert.ok(c1.flags.includes(f), f);
        assert.ok(m.banners.some(b => b.kind === 'no-rewards'));
    });
});
