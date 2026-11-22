// Validator onboarding, Sprint 6 (optional): the person-facing side of the alerts.
//
//   lib/validator-alerts-api.js   /api/validator-alerts/{status,subscribe,confirm,unsubscribe}
//   lib/validator-alerts-view.js  the "Get alerts for this validator" control on the status page
//   index.html                    the privacy page says what is stored and what triggers mail
//   lib/api-reference.js          the routes are documented
//
// The routes reuse what the general alert signup does: double opt-in (a confirm
// button page, then a POST), the per-IP signup limit, the 24 hour confirmation
// link, an unsubscribe page with a POST button and the RFC 8058 header. Nothing
// is sent unless the server switch VALIDATOR_ALERTS_SEND=1 is set.
//
// Every account is 32 bytes of one repeated value at prefix 88; every email
// address is on example.com.

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Window } from 'happy-dom';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import * as db from '../db.js';
import { registerValidatorAlertRoutes, createValidatorAlertLimiters } from '../lib/validator-alerts-api.js';
import { renderAlertsControl, mountAlertsControl, ALERTS_HEADING } from '../lib/validator-alerts-view.js';
import { mountValidatePage } from '../lib/validator-status-view.js';
import { validatorStatusModel } from '../lib/validator-status.js';
import { allRoutes } from '../lib/api-reference.js';
import { auditSource } from './helpers/input-audit.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo as readRepoAt, stripComments } from './helpers/source.js';
const readRepo = (f) => readRepoAt(f, import.meta.url);

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const S1 = addr(81), S2 = addr(82);
const ORIGIN = 'https://explorer.example.com';
const parseAddress = (a) => { try { return encodeAddress(decodeAddress(a), 88); } catch (e) { return null; } };

const dirs = [];
function fresh() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-val-alerts-api-'));
    dirs.push(d);
    db.initDb(d, true);
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });

// A real express app on an ephemeral port, the real db, a fake sender.
async function boot(over = {}) {
    fresh();
    const app = express();
    app.use(express.json());
    const sent = [];
    const state = { enabled: true, canMint: true };
    const limiters = over.limiters || createValidatorAlertLimiters(db, { VALIDATOR_ALERT_IP_PER_HOUR: '1000', VALIDATOR_ALERT_ADDRESS_PER_HOUR: '1000' });
    const routes = registerValidatorAlertRoutes(app, {
        db,
        send: async (m) => { if (over.sendGate) await over.sendGate; if (over.sendFail) throw new Error('smtp down'); sent.push(m); return over.sendResult || { providerId: 'p' }; },
        enabled: () => state.enabled,
        canMint: () => state.canMint,
        origin: () => ORIGIN,
        parseAddress,
        clientIp: (req) => String(req.headers['x-test-ip'] || '10.0.0.1'),
        ipRateOk: limiters.ip,
        addressRateOk: limiters.address,
        maxPerEmail: over.maxPerEmail || 5,
        page: ({ title, body, isError }) => `<html><title>${escapeHtml(title)}</title><body data-error="${!!isError}">${body}</body></html>`,
        actionForm: (action, token, label) => `<form method="POST" action="${escapeHtml(action)}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button>${escapeHtml(label)}</button></form>`,
        formBody: express.urlencoded({ extended: false, limit: '4kb' })
    });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    // The mail work runs after the response (so every case answers alike); settle() waits for it.
    const postRaw = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const post = async (p, body, headers = {}) => { const r = await postRaw(p, body, headers); await routes.idle(); return r; };
    const form = (p, token) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(token)}` });
    const get = (p) => fetch(base + p);
    const close = () => new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); });
    return { base, sent, state, post, postRaw, settle: () => routes.idle(), form, get, close };
}
const SAME_MESSAGE = 'If this address can receive alerts, a confirmation email is on its way.';
const tokenFrom = (mailText, route) => new RegExp(`/api/validator-alerts/${route}\\?token=([0-9a-zA-Zx]+)`).exec(mailText)[1];

describe('GET /api/validator-alerts/status', () => {
    test('says whether alerts are switched on, and never caches', async () => {
        const t = await boot();
        let r = await t.get('/api/validator-alerts/status');
        assert.deepEqual(await r.json(), { enabled: true, maxPerEmail: 5 });
        assert.match(r.headers.get('cache-control'), /no-store/);
        t.state.enabled = false;
        r = await t.get('/api/validator-alerts/status');
        assert.equal((await r.json()).enabled, false);
        await t.close();
    });
});

describe('POST /api/validator-alerts/subscribe: double opt-in', () => {
    test('a valid email and stash: a pending follow and one confirmation mail, nothing else', async () => {
        const t = await boot();
        const r = await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        assert.equal(r.status, 200);
        assert.deepEqual(await r.json(), { status: 'requested', message: SAME_MESSAGE });
        assert.equal(t.sent.length, 1);
        const m = t.sent[0];
        assert.equal(m.to, 'a@example.com');
        assert.equal(m.tag, 'validator-alert-confirm');
        assert.ok(m.text.includes(`${ORIGIN}/api/validator-alerts/confirm?token=`));
        assert.ok(m.text.includes(`${ORIGIN}/api/validator-alerts/unsubscribe?token=`));
        assert.deepEqual(db.getActiveValidatorAlertFollows(), [], 'nothing is active until the link is used');
        await t.close();
    });

    test('the response never contains a token', async () => {
        const t = await boot();
        const r = await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        const text = JSON.stringify(await r.json());
        assert.ok(!/token/i.test(text));
        await t.close();
    });

    test('a bad email or a bad address is refused before anything is stored or sent', async () => {
        const t = await boot();
        for (const body of [{ email: 'nope', stash: S1 }, { email: 'a@example.com', stash: 'not-an-address' }, { stash: S1 }, { email: 'a@example.com' }, {}]) {
            const r = await t.post('/api/validator-alerts/subscribe', body);
            assert.equal(r.status, 400, JSON.stringify(body));
        }
        assert.equal(t.sent.length, 0);
        await t.close();
    });

    test('the stash is stored in the chain form even when sent in another prefix', async () => {
        const t = await boot();
        const other = encodeAddress(decodeAddress(S1), 42);
        const r = await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: other });
        assert.equal(r.status, 200);
        assert.ok(t.sent[0].text.includes(S1), 'the mail names the chain-form stash');
        await t.close();
    });

    test('the server switch off: 503, nothing stored, nothing sent', async () => {
        const t = await boot();
        t.state.enabled = false;
        const r = await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        assert.equal(r.status, 503);
        assert.match((await r.json()).error, /not switched on/i);
        assert.equal(t.sent.length, 0);
        assert.equal(db.countEmailSubscribers(), 0);
        const f = await db.getActiveValidatorAlertFollows();
        assert.deepEqual(f, []);
        await t.close();
    });

    test('without SITE_URL the route refuses, as the general signup does (no link naming the wrong host)', async () => {
        const t = await boot();
        t.state.canMint = false;
        const r = await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        assert.equal(r.status, 503);
        assert.equal(t.sent.length, 0);
        await t.close();
    });

    test('a cap on live follows per address, and a clear message', async () => {
        const t = await boot({ maxPerEmail: 2 });
        for (const n of [1, 2]) assert.equal((await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: addr(40 + n) })).status, 200);
        const r = await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: addr(49) });
        assert.equal(r.status, 200, 'the cap answers like every other request');
        assert.deepEqual(await r.json(), { status: 'requested', message: SAME_MESSAGE });
        assert.equal(t.sent.length, 2, 'and sends nothing');
        await t.close();
    });

    test('an address that unsubscribed from all explorer mail gets the same answer and no mail', async () => {
        const t = await boot();
        const sub = db.createEmailSubscriberIfMissing({ email: 'a@example.com', confirmationToken: 'q1', unsubscribeToken: 'q2', eventPrefs: {}, source: 'x' }).subscriber;
        db.unsubscribeEmailSubscriber(sub.unsubscribeToken);
        const r = await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        assert.equal(r.status, 200, 'a blocked address is not told apart');
        assert.deepEqual(await r.json(), { status: 'requested', message: SAME_MESSAGE });
        assert.equal(t.sent.length, 0);
        await t.close();
    });

    test('asking again for a pending follow sends a fresh link and the old link stops working', async () => {
        const t = await boot();
        await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        const first = tokenFrom(t.sent[0].text, 'confirm');
        await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        const second = tokenFrom(t.sent[1].text, 'confirm');
        assert.notEqual(first, second);
        assert.match(await (await t.get(`/api/validator-alerts/confirm?token=${first}`)).text(), /invalid|already been used|expired/i);
        assert.match(await (await t.get(`/api/validator-alerts/confirm?token=${second}`)).text(), /<form method="POST"/);
        await t.close();
    });

    test('a confirmed follow asked for again gets the same answer and sends nothing', async () => {
        const t = await boot();
        await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        await t.form('/api/validator-alerts/confirm', tokenFrom(t.sent[0].text, 'confirm'));
        const r = await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        assert.deepEqual(await r.json(), { status: 'requested', message: SAME_MESSAGE });
        assert.equal(t.sent.length, 1);
        await t.close();
    });
});

describe('subscribe answers every well-formed request alike (no address enumeration)', () => {
    const body = (r) => r.clone().text();
    test('new, pending-again, confirmed, blocked and over-cap: one status, one body, byte for byte', async () => {
        const t = await boot({ maxPerEmail: 1 });
        const seen = [];
        const ask = async (email, stash) => { const r = await t.post('/api/validator-alerts/subscribe', { email, stash }); seen.push([r.status, await body(r), r.headers.get('content-type'), r.headers.get('cache-control')]); };
        await ask('new@example.com', S1);                    // new address: mail
        await ask('new@example.com', S1);                    // pending again: fresh mail
        await t.form('/api/validator-alerts/confirm', tokenFrom(t.sent[1].text, 'confirm'));
        await ask('new@example.com', S1);                    // confirmed: nothing
        await ask('new@example.com', S2);                    // over the cap of 1: nothing
        const sub = db.createEmailSubscriberIfMissing({ email: 'gone@example.com', confirmationToken: 'q1', unsubscribeToken: 'q2', eventPrefs: {}, source: 'x' }).subscriber;
        db.unsubscribeEmailSubscriber(sub.unsubscribeToken);
        await ask('gone@example.com', S1);                   // blocked: nothing
        assert.equal(seen.length, 5);
        for (const row of seen) assert.deepEqual(row, seen[0]);
        assert.equal(seen[0][0], 200);
        assert.deepEqual(JSON.parse(seen[0][1]), { status: 'requested', message: SAME_MESSAGE });
        assert.equal(t.sent.length, 2, 'only the two real requests produced mail');
        assert.ok(t.sent.every(m => m.to === 'new@example.com'));
        await t.close();
    });

    test('the response is decided before the mail is sent: a slow or failing mail server changes nothing', async () => {
        let release; const gate = new Promise(r => { release = r; });
        const t = await boot({ sendGate: gate });
        const r = await t.postRaw('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        assert.equal(r.status, 200, 'answered while the mail is still waiting');
        assert.deepEqual(await r.json(), { status: 'requested', message: SAME_MESSAGE });
        assert.equal(t.sent.length, 0);
        release(); await t.settle();
        assert.equal(t.sent.length, 1);
        await t.close();
        const f = await boot({ sendFail: true });
        const r2 = await f.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        assert.equal(r2.status, 200, 'a failed send is not shown to the asker');
        assert.deepEqual(await r2.json(), { status: 'requested', message: SAME_MESSAGE });
        await f.close();
    });

    test('a blocked address and an already-confirmed follow get no mail at all', async () => {
        const t = await boot();
        const sub = db.createEmailSubscriberIfMissing({ email: 'gone@example.com', confirmationToken: 'q1', unsubscribeToken: 'q2', eventPrefs: {}, source: 'x' }).subscriber;
        db.unsubscribeEmailSubscriber(sub.unsubscribeToken);
        await t.post('/api/validator-alerts/subscribe', { email: 'gone@example.com', stash: S1 });
        assert.equal(t.sent.length, 0);
        await t.close();
    });

    test('the route source no longer names the revealing statuses', () => {
        const src = stripComments(readRepo('lib/validator-alerts-api.js'));
        assert.ok(!/already-confirmed/.test(src));
        assert.ok(!/status\(409\)\.json\(\{ error: `You can follow/.test(src));
    });
});

describe('daily cap on confirmation mails per address', () => {
    test('the limiter defaults to 5 per 24 hours on top of 3 per hour, and the env sets it', () => {
        fresh();
        const l = createValidatorAlertLimiters(db, { VALIDATOR_ALERT_ADDRESS_PER_HOUR: '1000' });
        const r = []; for (let i = 0; i < 7; i++) r.push(l.address('d@example.com'));
        assert.equal(r.filter(Boolean).length, 5);
        const l2 = createValidatorAlertLimiters(db, { VALIDATOR_ALERT_ADDRESS_PER_HOUR: '1000', VALIDATOR_ALERT_ADDRESS_PER_DAY: '2' });
        const r2 = []; for (let i = 0; i < 4; i++) r2.push(l2.address('e@example.com'));
        assert.equal(r2.filter(Boolean).length, 2);
    });
    test('over the route: the sixth request in a day is a 429 even when the hourly cap is not reached, and the hour passing does not reset the day', async () => {
        const t = await boot({ limiters: createValidatorAlertLimiters(db, { VALIDATOR_ALERT_IP_PER_HOUR: '1000', VALIDATOR_ALERT_ADDRESS_PER_HOUR: '1000' }) });
        const codes = [];
        for (let i = 0; i < 6; i++) codes.push((await t.post('/api/validator-alerts/subscribe', { email: 'v@example.com', stash: addr(60 + i) }, { 'x-test-ip': `10.2.0.${i}` })).status);
        assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
        assert.equal(t.sent.length, 5);
        const real = Date.now;
        Date.now = () => real() + 3 * 3600_000;
        try { assert.equal((await t.post('/api/validator-alerts/subscribe', { email: 'v@example.com', stash: addr(70) }, { 'x-test-ip': '10.2.1.1' })).status, 429); } finally { Date.now = real; }
        await t.close();
    });
});

describe('confirm: re-confirming an unsubscribed follow re-checks the cap', () => {
    test('over the cap the confirm is refused with a clear page and the follow stays off', async () => {
        const t = await boot({ maxPerEmail: 2 });
        await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        const c1 = tokenFrom(t.sent[0].text, 'confirm'), u1 = tokenFrom(t.sent[0].text, 'unsubscribe');
        await t.form('/api/validator-alerts/confirm', c1);
        await t.form('/api/validator-alerts/unsubscribe', u1);
        await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });     // a fresh link for the left follow
        const again = tokenFrom(t.sent[1].text, 'confirm');
        for (const n of [1, 2]) await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: addr(40 + n) });
        const r = await t.form('/api/validator-alerts/confirm', again);
        assert.equal(r.status, 409);
        assert.match(await r.text(), /at most 2/i);
        assert.equal(db.getActiveValidatorAlertFollows().filter(f => f.stash === S1).length, 0);
        await t.close();
    });
});

describe('abuse limits on subscribe', () => {
    test('per IP: the limit applies to attempts and is shared by every address from that IP', async () => {
        const limiters = createValidatorAlertLimiters(db, { VALIDATOR_ALERT_IP_PER_HOUR: '3', VALIDATOR_ALERT_ADDRESS_PER_HOUR: '1000' });
        const t = await boot({ limiters: null });
        // boot() calls fresh(), so build the limiters on the live db
        await t.close();
        const t2 = await boot({ limiters: createValidatorAlertLimiters(db, { VALIDATOR_ALERT_IP_PER_HOUR: '3', VALIDATOR_ALERT_ADDRESS_PER_HOUR: '1000' }) });
        const codes = [];
        for (let i = 0; i < 5; i++) codes.push((await t2.post('/api/validator-alerts/subscribe', { email: `p${i}@example.com`, stash: S1 })).status);
        assert.deepEqual(codes, [200, 200, 200, 429, 429]);
        assert.equal(t2.sent.length, 3, 'a refused attempt sends no mail');
        // another IP is not affected
        assert.equal((await t2.post('/api/validator-alerts/subscribe', { email: 'other@example.com', stash: S1 }, { 'x-test-ip': '10.0.0.2' })).status, 200);
        await t2.close();
        assert.ok(limiters);
    });

    test('per address: one mailbox cannot be made to receive more than the limit of confirmation mails an hour, from any IP', async () => {
        const t = await boot({ limiters: createValidatorAlertLimiters(db, { VALIDATOR_ALERT_IP_PER_HOUR: '1000', VALIDATOR_ALERT_ADDRESS_PER_HOUR: '2' }) });
        const codes = [];
        for (let i = 0; i < 4; i++) codes.push((await t.post('/api/validator-alerts/subscribe', { email: 'Victim@Example.com', stash: addr(60 + i) }, { 'x-test-ip': `10.1.0.${i}` })).status);
        assert.deepEqual(codes, [200, 200, 429, 429]);
        assert.equal(t.sent.length, 2);
        // the address is compared case-insensitively
        assert.equal((await t.post('/api/validator-alerts/subscribe', { email: 'victim@example.com', stash: addr(70) }, { 'x-test-ip': '10.1.0.9' })).status, 429);
        await t.close();
    });

    test('the limiters default to 10 per IP and 3 per address an hour', async () => {
        fresh();
        const l = createValidatorAlertLimiters(db, {});
        const ip = []; for (let i = 0; i < 11; i++) ip.push(l.ip('9.9.9.9'));
        assert.equal(ip.filter(Boolean).length, 10);
        const ad = []; for (let i = 0; i < 4; i++) ad.push(l.address('x@example.com'));
        assert.equal(ad.filter(Boolean).length, 3);
    });

    test('a refused invalid request does not use up the address limit', async () => {
        const t = await boot({ limiters: createValidatorAlertLimiters(db, { VALIDATOR_ALERT_IP_PER_HOUR: '1000', VALIDATOR_ALERT_ADDRESS_PER_HOUR: '1' }) });
        assert.equal((await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: 'bad' })).status, 400);
        assert.equal((await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 })).status, 200);
        await t.close();
    });
});

describe('confirm: a button page, then a POST (a mail scanner opening the link changes nothing)', () => {
    test('GET shows the validator and a POST form; it does not confirm', async () => {
        const t = await boot();
        await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        const tok = tokenFrom(t.sent[0].text, 'confirm');
        const page = await (await t.get(`/api/validator-alerts/confirm?token=${tok}`)).text();
        assert.match(page, /<form method="POST" action="\/api\/validator-alerts\/confirm"/);
        assert.ok(page.includes(S1));
        assert.deepEqual(db.getActiveValidatorAlertFollows(), []);
        await t.close();
    });

    test('POST confirms; the page does not print any token; a second POST is refused', async () => {
        const t = await boot();
        await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        const tok = tokenFrom(t.sent[0].text, 'confirm');
        const r = await t.form('/api/validator-alerts/confirm', tok);
        assert.equal(r.status, 200);
        const text = await r.text();
        assert.ok(!text.includes(tok));
        assert.ok(!/unsubscribe\?token/.test(text));
        assert.equal(db.getActiveValidatorAlertFollows().length, 1);
        const again = await t.form('/api/validator-alerts/confirm', tok);
        assert.ok(again.status === 200 || again.status === 404);
        assert.equal(db.getActiveValidatorAlertFollows().length, 1);
        await t.close();
    });

    test('an unknown token is a 404 error page', async () => {
        const t = await boot();
        const r = await t.form('/api/validator-alerts/confirm', 'nope');
        assert.equal(r.status, 404);
        assert.match(await r.text(), /data-error="true"/);
        await t.close();
    });

    test('a link older than 24 hours is refused, on the page and on the POST', async () => {
        const t = await boot();
        await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        const tok = tokenFrom(t.sent[0].text, 'confirm');
        const real = Date.now;
        Date.now = () => real() + 25 * 3600_000;
        try {
            assert.match(await (await t.get(`/api/validator-alerts/confirm?token=${tok}`)).text(), /expired|invalid/i);
            const r = await t.form('/api/validator-alerts/confirm', tok);
            assert.notEqual(r.status, 200);
        } finally { Date.now = real; }
        assert.deepEqual(db.getActiveValidatorAlertFollows(), []);
        await t.close();
    });

    test('confirming still works with the switch off (only sending is off); the pages are noindex and no-store', async () => {
        const t = await boot();
        await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        t.state.enabled = false;
        const r = await t.form('/api/validator-alerts/confirm', tokenFrom(t.sent[0].text, 'confirm'));
        assert.equal(r.status, 200);
        assert.match(r.headers.get('cache-control'), /no-store/);
        assert.match(r.headers.get('x-robots-tag'), /noindex/);
        await t.close();
    });
});

describe('unsubscribe works, always, and by the one-click path', () => {
    async function confirmed(t, email = 'a@example.com', stash = S1) {
        await t.post('/api/validator-alerts/subscribe', { email, stash });
        const m = t.sent[t.sent.length - 1];
        await t.form('/api/validator-alerts/confirm', tokenFrom(m.text, 'confirm'));
        return tokenFrom(m.text, 'unsubscribe');
    }

    test('GET shows a button and changes nothing; POST ends that one follow', async () => {
        const t = await boot();
        const u = await confirmed(t);
        await confirmed(t, 'a@example.com', S2);
        const page = await (await t.get(`/api/validator-alerts/unsubscribe?token=${u}`)).text();
        assert.match(page, /<form method="POST" action="\/api\/validator-alerts\/unsubscribe"/);
        assert.equal(db.getActiveValidatorAlertFollows().length, 2);
        const r = await t.form('/api/validator-alerts/unsubscribe', u);
        assert.equal(r.status, 200);
        assert.deepEqual(db.getActiveValidatorAlertFollows().map(f => f.stash), [S2]);
        await t.close();
    });

    test('the RFC 8058 one-click POST (token in the query, List-Unsubscribe=One-Click in the body) works', async () => {
        const t = await boot();
        const u = await confirmed(t);
        const r = await fetch(`${t.base}/api/validator-alerts/unsubscribe?token=${u}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
        assert.equal(r.status, 200);
        assert.deepEqual(db.getActiveValidatorAlertFollows(), []);
        await t.close();
    });

    test('works with the switch off and with SITE_URL unset', async () => {
        const t = await boot();
        const u = await confirmed(t);
        t.state.enabled = false; t.state.canMint = false;
        assert.equal((await t.form('/api/validator-alerts/unsubscribe', u)).status, 200);
        assert.deepEqual(db.getActiveValidatorAlertFollows(), []);
        await t.close();
    });

    test('an unknown token is a 404; a repeated unsubscribe says already done', async () => {
        const t = await boot();
        assert.equal((await t.form('/api/validator-alerts/unsubscribe', 'nope')).status, 404);
        const u = await confirmed(t);
        await t.form('/api/validator-alerts/unsubscribe', u);
        assert.match(await (await t.get(`/api/validator-alerts/unsubscribe?token=${u}`)).text(), /Already unsubscribed|already/i);
        await t.close();
    });

    test('the confirmation and unsubscribe tokens are different, and long', async () => {
        const t = await boot();
        await t.post('/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 });
        const c = tokenFrom(t.sent[0].text, 'confirm'), u = tokenFrom(t.sent[0].text, 'unsubscribe');
        assert.notEqual(c, u);
        assert.ok(c.length >= 32 && u.length >= 32);
        await t.close();
    });
});

describe('the control on the validator status page', () => {
    const dom = () => {
        const w = new Window({ url: 'http://localhost/validate' });
        const el = w.document.createElement('div');
        w.document.body.appendChild(el);
        return { w, el, doc: w.document };
    };
    const flush = (n = 5) => new Promise(r => setTimeout(r, n));

    test('the markup: a labelled email field with the paste and clear attributes, a submit button, honest copy', () => {
        const html = renderAlertsControl({ esc: escapeHtml, stash: S1, maxPerEmail: 5 });
        const w = new Window(); w.document.body.innerHTML = html;
        const input = w.document.querySelector('input[type="email"]');
        assert.ok(input);
        assert.equal(input.getAttribute('data-input-kind'), 'text');
        assert.equal(input.getAttribute('autocomplete'), 'email');
        const label = w.document.querySelector(`label[for="${input.id}"]`);
        assert.ok(label && /email/i.test(label.textContent));
        assert.ok(input.getAttribute('aria-describedby'));
        assert.ok(w.document.getElementById(input.getAttribute('aria-describedby')));
        const btn = w.document.querySelector('button[type="submit"]');
        assert.ok(btn && /alerts/i.test(btn.textContent));
        const text = w.document.body.textContent;
        for (const phrase of [/not elected/i, /85%/, /disabled/i, /slashed/i, /commission/i, /keys/i, /confirm/i, /unsubscribe/i, /only this validator|this validator/i, /never sold|not shared|no one else/i]) assert.match(text, phrase);
        assert.ok(!/[\u2013\u2014]/.test(html));
        assert.equal(ALERTS_HEADING, 'Get alerts for this validator');
        assert.match(text, new RegExp(ALERTS_HEADING));
    });

    test('the markup passes the input-actions audit (a kind, no opt-out)', () => {
        const html = renderAlertsControl({ esc: escapeHtml, stash: S1, maxPerEmail: 5 });
        const a = auditSource(html, 'alerts.html');
        assert.ok(a.tags.length >= 1);
        assert.deepEqual(a.offenders, []);
    });

    test('mount: when the server has alerts off, nothing is shown', async () => {
        const { el } = dom();
        await mountAlertsControl(el, { stash: S1, esc: escapeHtml, fetchJson: async () => ({ enabled: false, maxPerEmail: 5 }), postJson: async () => { throw new Error('no'); } });
        assert.equal(el.innerHTML.trim(), '');
    });

    test('mount: when the status read fails, nothing is shown and nothing throws', async () => {
        const { el } = dom();
        await mountAlertsControl(el, { stash: S1, esc: escapeHtml, fetchJson: async () => { throw new Error('x'); }, postJson: async () => ({}) });
        assert.equal(el.innerHTML.trim(), '');
    });

    test('submit: a bad email is refused in the page, with aria-invalid, and nothing is posted', async () => {
        const { el, w } = dom(); const posts = [];
        await mountAlertsControl(el, { stash: S1, esc: escapeHtml, fetchJson: async () => ({ enabled: true, maxPerEmail: 5 }), postJson: async (u, b) => { posts.push([u, b]); return {}; } });
        el.querySelector('input[type="email"]').value = 'nope';
        el.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await flush();
        assert.equal(posts.length, 0);
        assert.equal(el.querySelector('input[type="email"]').getAttribute('aria-invalid'), 'true');
        assert.match(el.querySelector('[aria-live="polite"]').textContent, /valid email/i);
    });

    test('submit: posts the email and the stash, then tells the person to check their inbox; the button is disabled while it waits', async () => {
        const { el, w } = dom(); const posts = [];
        let release; const gate = new Promise(r => { release = r; });
        await mountAlertsControl(el, { stash: S1, esc: escapeHtml, fetchJson: async () => ({ enabled: true, maxPerEmail: 5 }),
            postJson: async (u, b) => { posts.push([u, b]); await gate; return { status: 'requested', message: SAME_MESSAGE }; } });
        el.querySelector('input[type="email"]').value = ' a@example.com ';
        el.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await flush();
        assert.equal(el.querySelector('button[type="submit"]').disabled, true);
        release(); await flush();
        assert.deepEqual(posts, [['/api/validator-alerts/subscribe', { email: 'a@example.com', stash: S1 }]]);
        const msg = el.querySelector('[aria-live="polite"]').textContent;
        assert.match(msg, /If this address can receive alerts, a confirmation email is on its way\./);
        assert.match(msg, /24 hours/);
        assert.doesNotMatch(msg, /already/i);
        assert.equal(el.querySelector('button[type="submit"]').disabled, false);
    });

    test('submit: a server refusal is shown in words, and the field keeps its value', async () => {
        const { el, w } = dom();
        await mountAlertsControl(el, { stash: S1, esc: escapeHtml, fetchJson: async () => ({ enabled: true, maxPerEmail: 5 }),
            postJson: async () => { throw new Error('Too many signup attempts. Please wait an hour.'); } });
        el.querySelector('input[type="email"]').value = 'a@example.com';
        el.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await flush();
        assert.match(el.querySelector('[aria-live="polite"]').textContent, /Too many signup attempts/);
        assert.equal(el.querySelector('input[type="email"]').value, 'a@example.com');
    });

    test('the same words are shown whatever the server knows about the address', async () => {
        const { el, w } = dom();
        await mountAlertsControl(el, { stash: S1, esc: escapeHtml, fetchJson: async () => ({ enabled: true, maxPerEmail: 5 }),
            postJson: async () => ({ status: 'requested', message: SAME_MESSAGE }) });
        el.querySelector('input[type="email"]').value = 'a@example.com';
        el.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await flush();
        const msg = el.querySelector('[aria-live="polite"]').textContent;
        assert.match(msg, /confirmation email is on its way/);
        assert.doesNotMatch(msg, /already|at most|unsubscribed/i);
    });

    test('a stash with a script in it is escaped in the markup', () => {
        const html = renderAlertsControl({ esc: escapeHtml, stash: '"><script>x</script>', maxPerEmail: 5 });
        assert.ok(!html.includes('<script>'));
    });

    test('the status page mounts the control for the viewed stash only when a stash is shown (flag gating is the page flag)', async () => {
        const { el } = dom();
        const urls = [];
        // amended (fidelity review 10): a stash that is not bonded gets no alerts card, so the stash here is bonded.
        const model = { ...validatorStatusModel({ address: S1, bonded: true, controller: S1 }, {}), address: S1 };
        assert.notEqual(model.state, 'not-bonded');
        const d = {
            account: { status: 'connected', address: S1 }, urlAddress: '', isSame: (a, b) => a === b,
            fetchJson: async (u) => { urls.push(u); if (u === '/api/validator-alerts/status') return { enabled: true, maxPerEmail: 5 }; if (u === '/api/validator/params') return { specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 } }; if (/\/status$/.test(u)) return model; throw new Error('unexpected ' + u); },
            postJson: async () => ({}), helpIcon: () => '', esc: escapeHtml, shortAddr: (a) => a.slice(0, 8), navigate: () => {}
        };
        await mountValidatePage(el, d); await flush(20);
        assert.ok(urls.includes('/api/validator-alerts/status'));
        assert.ok(el.querySelector('#validate-alerts-slot'));
        assert.ok(el.querySelector('#validate-alerts-slot input[type="email"]'));
        const lone = dom();
        const urls2 = [];
        await mountValidatePage(lone.el, { ...d, account: { status: 'none' }, urlAddress: '', fetchJson: async (u) => { urls2.push(u); if (u === '/api/validator/params') return { specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 } }; throw new Error('unexpected ' + u); } });
        await flush(20);
        assert.ok(!urls2.includes('/api/validator-alerts/status'), 'no stash shown, no alerts control, no read');
    });
});

describe('wiring and documents', () => {
    const server = stripComments(readRepo('server.js'));
    test('server.js registers the routes with the existing email pieces and runs the tick behind the switch', () => {
        assert.match(server, /registerValidatorAlertRoutes\(app,/);
        assert.match(server, /validatorAlertsSendEnabled\(process\.env\)/);
        assert.match(server, /runValidatorAlertsTick\(/);
        assert.match(server, /VALIDATOR_ALERTS_CHECK_MS/);
        assert.match(server, /ipRateOk:[^\n]*emailSignupRateOk/, 'the existing per-IP signup limit applies');
        assert.match(server, /sendEmail/);
    });
    test('the default is off: no code path defaults the switch to on', () => {
        const lib = readRepo('lib/validator-alerts.js');
        assert.match(lib, /=== '1'/);
    });
    test('the four routes are in the API reference', () => {
        const paths = allRoutes().map(r => `${r.method} ${r.path.split('?')[0]}`);
        for (const p of ['GET /api/validator-alerts/status', 'POST /api/validator-alerts/subscribe', 'POST /api/validator-alerts/confirm', 'POST /api/validator-alerts/unsubscribe']) assert.ok(paths.includes(p), p);
    });
    test('.env.example documents both switches, off by default', () => {
        const env = readRepo('.env.example');
        assert.match(env, /^# VALIDATOR_ALERTS_SEND=1/m);
        assert.match(env, /VALIDATOR_ALERTS_CHECK_MS/);
        assert.match(env, /VALIDATOR_ALERT_ADDRESS_PER_HOUR/);
        assert.match(env, /^# VALIDATOR_ALERT_ADDRESS_PER_DAY=5/m);
        assert.match(readRepo('README.md'), /VALIDATOR_ALERT_ADDRESS_PER_DAY/);
    });
    test('the privacy page says an address is stored for validator alerts, what triggers mail and how to stop it', () => {
        const html = readRepo('index.html');
        const i = html.indexOf('data-page="privacy"');
        const j = html.indexOf('data-page="cookies"', i) > 0 ? html.indexOf('data-page="cookies"', i) : html.length;
        const page = html.slice(i, j).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        for (const phrase of [/Validator alerts/, /Get alerts for this validator/, /email address/i, /validator stash/i, /not elected/i, /85%/, /disabled/, /slashed/, /commission/i, /session keys/i, /double opt-in|confirm/i, /unsubscribe link/i, /at most five/i, /ask us to delete|delete/i]) assert.match(page, phrase);
        const para = page.slice(page.indexOf('Validator alerts.'), page.indexOf('validator alerts on.', page.indexOf('Validator alerts.')) + 20);
        assert.ok(para.length > 800, 'the paragraph was not found');
        assert.ok(!/[\u2013\u2014]/.test(para));
    });
    test('no em or en dash in the new source files', () => {
        for (const f of ['lib/validator-alerts-api.js', 'lib/validator-alerts-view.js']) assert.ok(!/[\u2013\u2014]/.test(readRepo(f)), f);
    });
});
