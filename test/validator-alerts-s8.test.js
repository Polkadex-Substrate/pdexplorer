// Validator alerts, review fixes (Sprint 8 review, FIX FIRST):
//   M4  a limiter refusal is not an attempt (the 24 h age bound still ends it), and a recipient
//       already mailed in this tick is skipped without calling send
//   M5  a failed send logs kind, stash and the provider status code only, never an address
//   L8  a pending alert is claimed (compare-and-set on next_attempt_at) before the send, so two
//       drains that read the same row send it once
//   L9  the subscription is checked again just before each send
//   L10 the due list is cut after ordering by kind priority, so a new slash is never behind
//       older low-priority rows
//   L11 the baseline does not move past an occurrence that could not be reserved
// Every account is 32 bytes of one repeated value and belongs to no one; addresses are example.com.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeAddress } from '@polkadot/util-crypto';
import * as db from '../db.js';
import { runValidatorAlertsTick, MAX_ALERT_ATTEMPTS } from '../lib/validator-alerts-run.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const S1 = addr(81), S2 = addr(82);
const ORIGIN = 'https://explorer.example.com';
const MIN = 60_000, HOUR = 3600_000;

const dirs = [];
function fresh() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-val-s8-'));
    dirs.push(d);
    db.initDb(d, true);
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });

let seq = 0;
const mail = () => `s8user${++seq}@example.com`;
function follow(email, stash) {
    const r = db.addValidatorAlertFollow({ email, stash, subscriberConfirmationToken: `sc${seq}${Math.random()}`, subscriberUnsubscribeToken: `su${seq}${Math.random()}`,
        confirmationToken: `c${Math.random()}`.slice(0, 20), unsubscribeToken: `u${Math.random()}`.slice(0, 20), maxPerEmail: 5 });
    db.confirmValidatorAlertFollow(r.follow.confirmationToken);
    return r.follow;
}
const obs = (o = {}) => ({
    stash: S1, block: 1000, era: 10, session: 60, progress: 0.1, intent: true, elected: true, inSession: true, disabled: false,
    heartbeat: true, blocks: 3, lastSlashEra: 'none', commission: 50_000_000, keys: 'k1', ...o
});
async function quiet(fn) {
    const errs = [], warns = [];
    const e = console.error, w = console.warn;
    console.error = (...a) => errs.push(a.join(' '));
    console.warn = (...a) => warns.push(a.join(' '));
    try { await fn(); } finally { console.error = e; console.warn = w; }
    return { errs, warns };
}
function rig(observations, send, extra = {}) {
    const clock = { t: Date.now() };
    const queue = observations.slice();
    let last = null;
    const readObservation = async (stash) => { if (queue.length) last = queue.shift(); return { ...last, stash }; };
    const tick = (over = {}) => runValidatorAlertsTick({ db, readObservation, send, origin: ORIGIN, enabled: () => true, nameOf: async () => null, now: () => clock.t, ...extra, ...over });
    return { clock, tick };
}

describe('M4: limiter refusals are not attempts; one mail per recipient per tick', () => {
    test('refused by the limiter for longer than the attempt limit, the alert is still delivered within the age bound', async () => {
        fresh();
        follow(mail(), S1);
        let refuse = true, sent = 0;
        const send = async () => { if (refuse) return { rateLimited: true, providerId: null }; sent++; return { providerId: 'p' }; };
        const h = rig([obs(), obs({ lastSlashEra: 10 })], send);
        const out = await quiet(async () => {
            await h.tick(); h.clock.t += 5 * MIN;
            for (let i = 0; i < MAX_ALERT_ATTEMPTS + 8; i++) { await h.tick(); h.clock.t += 5 * MIN; }
            const row = db.getDueValidatorAlerts({ now: h.clock.t + HOUR })[0];
            assert.ok(row, 'still pending');
            assert.equal(row.attempts, 0, 'limiter refusals are not counted');
            refuse = false;
            await h.tick();
        });
        assert.equal(sent, 1);
        assert.equal(out.errs.length, 0, 'not given up');
    });

    test('two alerts for one recipient in one tick: send is called once, the second goes on the next tick', async () => {
        fresh();
        follow(mail(), S1);
        const tags = [];
        const send = async (m) => { tags.push(m.tag); return { providerId: 'p' }; };
        const h = rig([obs(), obs({ disabled: true, lastSlashEra: 10 })], send);
        await quiet(async () => {
            await h.tick(); h.clock.t += 5 * MIN;
            await h.tick();
            assert.deepEqual(tags, ['validator.slashed'], 'the second mail to the same recipient is not attempted this tick');
            h.clock.t += 5 * MIN;
            await h.tick();
        });
        assert.deepEqual(tags, ['validator.slashed', 'validator.disabled']);
    });
});

describe('M5: a failed send never logs an address', () => {
    test('the line names kind, stash and the provider status; the response body is not logged', async () => {
        fresh();
        const a = mail();
        follow(a, S1);
        const send = async () => { throw new Error(`Postmark 422: {"ErrorCode":300,"Message":"Invalid 'To' address: '${a}'. other@example.com"}`); };
        const h = rig([obs(), obs({ disabled: true })], send);
        const out = await quiet(async () => { await h.tick(); h.clock.t += 5 * MIN; await h.tick(); });
        const lines = out.warns.concat(out.errs);
        const line = lines.find(l => l.includes('disabled'));
        assert.ok(line, lines.join('\n'));
        assert.ok(line.includes(S1) && /\b422\b/.test(line), line);
        assert.ok(!lines.some(l => /@/.test(l)), lines.join('\n'));
    });
});

describe('L8: a pending alert is claimed before it is sent', () => {
    test('two drains that read the same due row send it once', async () => {
        fresh();
        follow(mail(), S1);
        const sent = [];
        const send = async (m) => { sent.push(m.tag); return { providerId: 'p' }; };
        const h = rig([obs(), obs({ disabled: true })], send);
        await quiet(() => h.tick({ send: async () => { throw new Error('down'); } }));   // baseline
        h.clock.t += 5 * MIN;
        await quiet(() => h.tick({ send: async () => { throw new Error('down'); } }));   // reserved, first send failed
        h.clock.t += 2 * HOUR;
        // Both drains read the due row, then both wait in nameOf until the other has read it too.
        let waiting = 0, release;
        const both = new Promise(r => { release = r; });
        const nameOf = async () => { if (++waiting === 2) release(); await both; return null; };
        await quiet(() => Promise.all([h.tick({ nameOf }), h.tick({ nameOf })]));
        assert.deepEqual(sent, ['validator.disabled'], 'one send for one alert');
    });
});

describe('L9: the subscription is checked again just before the send', () => {
    test('an unsubscribe after the due list was read stops the send', async () => {
        fresh();
        const f = follow(mail(), S1);
        const sent = [];
        const send = async (m) => { sent.push(m.tag); return { providerId: 'p' }; };
        const h = rig([obs(), obs({ disabled: true })], send);
        await quiet(async () => {
            await h.tick();
            h.clock.t += 5 * MIN;
            await h.tick({ nameOf: async () => { db.unsubscribeValidatorAlertFollow(f.unsubscribeToken); return null; } });
        });
        assert.deepEqual(sent, []);
    });
});

describe('L10: the due list is ordered by kind priority before it is cut', () => {
    test('a newer slash is inside the limit ahead of older low-priority rows', () => {
        fresh();
        const f = follow(mail(), S1);
        const sub = db.getActiveValidatorAlertFollows().find(x => x.stash === S1).subscriberId;
        assert.ok(f);
        const t = 1_000_000;
        db.reserveValidatorAlert({ eventKind: 'validator.commission', eventId: `${S1}:c1`, subscriberId: sub, stash: S1, detail: {}, now: t });
        db.reserveValidatorAlert({ eventKind: 'validator.commission', eventId: `${S1}:c2`, subscriberId: sub, stash: S1, detail: {}, now: t + 1 });
        db.reserveValidatorAlert({ eventKind: 'validator.slashed', eventId: `${S1}:s1`, subscriberId: sub, stash: S1, detail: {}, now: t + 2 });
        const due = db.getDueValidatorAlerts({ now: t + 10, limit: 2 });
        assert.equal(due[0].eventKind, 'validator.slashed');
    });
});

describe('L11: the baseline does not move past an occurrence that could not be reserved', () => {
    test('a reserve that threw is detected again on the next tick and sent', async () => {
        fresh();
        follow(mail(), S2);
        let throwOnce = false;
        const wdb = new Proxy(db, { get(t, k) {
            if (k === 'reserveValidatorAlert') return (...a) => { if (throwOnce) { throwOnce = false; throw new Error('database is locked'); } return t.reserveValidatorAlert(...a); };
            return t[k];
        } });
        const sent = [];
        const send = async (m) => { sent.push(m.tag); return { providerId: 'p' }; };
        const h = rig([obs({ stash: S2 }), obs({ stash: S2, disabled: true })], send, { db: wdb });
        await quiet(async () => {
            await h.tick(); h.clock.t += 5 * MIN;
            throwOnce = true;
            await h.tick(); h.clock.t += 5 * MIN;
            await h.tick();
        });
        assert.deepEqual(sent, ['validator.disabled']);
    });
});
