// Validator alerts: a safety alert that was not handed to the mail provider is not final.
//
// Found in review of the live Sprint 6 code: the per-recipient limiter in email.js returns
// { rateLimited: true } WITHOUT sending, and a thrown send was recorded 'failed'; both were
// final, so a slash arriving in the same tick as `disabled` was silently dropped. These tests
// pin the repaired behaviour:
//   - not accepted by the provider (rate-limited or thrown) means retried on later ticks,
//     bounded by attempts and age, then one console.error line that names the kind and stash
//   - the pending alert lives in the database, so it does not depend on the baseline,
//     survives a restart, and is never sent twice once the provider accepted it
//   - within a tick the most important kind goes first
//   - an observation older than 2 hours still yields the slash alert when the era moved
// Every account is 32 bytes of one repeated value and belongs to no one; addresses are example.com.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeAddress } from '@polkadot/util-crypto';

// email.js reads its provider settings at import time, so they are set before it is loaded.
process.env.EMAIL_PROVIDER = 'postmark';
process.env.EMAIL_FROM = 'alerts@example.com';
process.env.POSTMARK_TOKEN = 'test-token-not-real';
const { sendEmail, _setEmailClockForTests } = await import('../email.js');
const db = await import('../db.js');
const run = await import('../lib/validator-alerts-run.js');
const { runValidatorAlertsTick, MAX_OBSERVATION_AGE_MS } = run;

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const S1 = addr(91);
const ORIGIN = 'https://explorer.example.com';
const MIN = 60_000, HOUR = 3600_000;

const dirs = [];
function fresh() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-val-retry-'));
    dirs.push(d);
    db.initDb(d, true);
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });

let seq = 0;
const mail = () => `retry${++seq}@example.com`;
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

// A clock the tests move by hand, and a reader that replays a queue of observations
// (the last one repeats once the queue is used up).
function rig(observations, send) {
    const clock = { t: Date.now() };
    const queue = observations.slice();
    let last = null;
    const readObservation = async (stash) => { if (queue.length) last = queue.shift(); return { ...last, stash }; };
    const tick = () => runValidatorAlertsTick({ db, readObservation, send, origin: ORIGIN, enabled: () => true, nameOf: async () => null, now: () => clock.t });
    return { clock, tick, queue };
}

// Capture console.error and console.warn during a function.
async function quiet(fn) {
    const errs = [], warns = [];
    const e = console.error, w = console.warn;
    console.error = (...a) => errs.push(a.join(' '));
    console.warn = (...a) => warns.push(a.join(' '));
    try { await fn(); } finally { console.error = e; console.warn = w; }
    return { errs, warns };
}

describe('B1: the real per-recipient limiter in email.js, with a fake transport', () => {
    test('a slash and a disable in one tick both reach the recipient, the slash first; a real limiter refusal is retried', async () => {
        fresh();
        const a = mail();
        follow(a, S1);
        const posted = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            const body = JSON.parse(init.body);
            posted.push({ to: body.To, tag: body.Tag });
            return { ok: true, status: 200, text: async () => JSON.stringify({ MessageID: `m${posted.length}` }) };
        };
        const h = rig([obs(), obs({ disabled: true, lastSlashEra: 10 })], sendEmail);
        // The limiter runs on the test's clock, so its 10 s window is moved by hand, not waited for.
        _setEmailClockForTests(() => h.clock.t);
        try {
            await quiet(async () => {
                await h.tick();                       // baseline
                h.clock.t += 5 * MIN;
                // Another mail to the same recipient just went out: the REAL limiter refuses the next one.
                assert.ok(!(await sendEmail({ to: a, subject: 's', text: 't', tag: 'other' })).rateLimited);
                await h.tick();                       // disabled + slashed detected; the slash is refused by the limiter
                assert.deepEqual(posted.map(p => p.tag), ['other'], 'the real limiter dropped the alert mail');
                assert.equal(db.getDueValidatorAlerts({ now: h.clock.t + 1 }).find(r => r.eventKind === 'validator.slashed').attempts, 0, 'a limiter refusal is not an attempt');
                h.clock.t += 5 * MIN;
                await h.tick();
                h.clock.t += 5 * MIN;
                await h.tick();
            });
            assert.deepEqual(posted.map(p => p.tag), ['other', 'validator.slashed', 'validator.disabled'], 'nothing is dropped, the slash first');
            assert.ok(posted.every(p => p.to === a));
        } finally { _setEmailClockForTests(null); globalThis.fetch = realFetch; }
    });

    test('two validators followed by one address: neither alert is lost', async () => {
        fresh();
        const S2 = addr(92);
        const a = mail();
        follow(a, S1); follow(a, S2);
        const sent = [];
        // A limiter like the real one: one mail per recipient per tick, the rest refused without sending.
        let allowed = true;
        const send = async (m) => { if (!allowed) return { rateLimited: true, providerId: null }; allowed = false; sent.push(m.text); return { providerId: 'p' }; };
        const clock = { t: Date.now() };
        const reads = { [S1]: [obs({ stash: S1 }), obs({ stash: S1, disabled: true })], [S2]: [obs({ stash: S2 }), obs({ stash: S2, disabled: true })] };
        const readObservation = async (s) => (reads[s].length > 1 ? reads[s].shift() : reads[s][0]);
        const tick = () => { allowed = true; return runValidatorAlertsTick({ db, readObservation, send, origin: ORIGIN, enabled: () => true, nameOf: async () => null, now: () => clock.t }); };
        await quiet(async () => {
            await tick(); clock.t += 5 * MIN;
            await tick(); clock.t += 5 * MIN;
            await tick(); clock.t += 5 * MIN;
            await tick();
        });
        assert.equal(sent.length, 2, 'both validators reached the one address');
        assert.ok(sent.some(s => s.includes(S1)) && sent.some(s => s.includes(S2)));
    });
});

describe('B2: a thrown send is retried, bounded, and then reported once', () => {
    test('a send that throws once is sent on a later tick, once, and the baseline moving on changes nothing', async () => {
        fresh();
        follow(mail(), S1);
        let fail = true;
        const sent = [];
        const send = async (m) => { if (fail) { fail = false; throw new Error('provider 500'); } sent.push(m.tag); return { providerId: 'p' }; };
        const h = rig([obs(), obs({ disabled: true }), obs({ disabled: true, block: 1100 }), obs({ disabled: true, block: 1200 }), obs({ disabled: true, block: 1300 })], send);
        await quiet(async () => {
            await h.tick(); h.clock.t += 5 * MIN;
            await h.tick();
            assert.deepEqual(sent, [], 'the first attempt threw');
            h.clock.t += 30 * MIN;
            await h.tick();
            assert.deepEqual(sent, ['validator.disabled'], 'retried and delivered');
            h.clock.t += 30 * MIN;
            await h.tick(); await h.tick();
        });
        assert.deepEqual(sent, ['validator.disabled'], 'delivered exactly once');
    });

    test('a retry reuses the reserved row: one dispatch row, and it is not reserved a second time', async () => {
        fresh();
        follow(mail(), S1);
        let n = 0;
        const send = async () => { if (++n === 1) throw new Error('boom'); return { providerId: 'p9' }; };
        const h = rig([obs(), obs({ disabled: true })], send);
        await quiet(async () => {
            await h.tick(); h.clock.t += 5 * MIN; await h.tick(); h.clock.t += 30 * MIN; await h.tick();
        });
        const sub = db.getActiveValidatorAlertFollows()[0];
        assert.equal(db.reserveEmailDispatch({ eventKind: 'validator.disabled', eventId: `${S1}:disabled:e10`, subscriberId: sub.subscriberId }), false);
        assert.equal(n, 2);
    });

    test('gives up after the attempt limit with one console.error naming the kind and the stash, never the address', async () => {
        fresh();
        const a = mail();
        follow(a, S1);
        let calls = 0;
        const send = async () => { calls++; throw new Error('provider down'); };
        const h = rig([obs(), obs({ disabled: true })], send);
        const out = await quiet(async () => {
            await h.tick(); h.clock.t += 5 * MIN;
            await h.tick();
            for (let i = 0; i < 60; i++) { h.clock.t += 2 * HOUR + 1; await h.tick(); }
        });
        assert.equal(calls, run.MAX_ALERT_ATTEMPTS, 'bounded number of attempts');
        assert.equal(out.errs.length, 1, 'one final-failure line');
        assert.ok(out.errs[0].includes('disabled') && out.errs[0].includes(S1), out.errs[0]);
        assert.ok(!out.errs.concat(out.warns).some(l => l.includes(a)), 'no address in any log line');
        const callsAfter = calls;
        h.clock.t += 6 * HOUR; await quiet(() => h.tick());
        assert.equal(calls, callsAfter, 'a final failure is not retried');
    });

    test('an alert still rate-limited after the age limit is a final failure with one console.error', async () => {
        fresh();
        follow(mail(), S1);
        let calls = 0;
        const send = async () => { calls++; return { rateLimited: true, providerId: null }; };
        const h = rig([obs(), obs({ lastSlashEra: 10 })], send);
        const out = await quiet(async () => {
            await h.tick(); h.clock.t += 5 * MIN;
            await h.tick();
            const start = h.clock.t;
            while (h.clock.t < start + 30 * HOUR) { h.clock.t += 5 * MIN; await h.tick(); }
        });
        assert.equal(out.errs.length, 1);
        assert.ok(out.errs[0].includes('slashed') && out.errs[0].includes(S1));
        assert.ok(calls >= 1);
    });
});

describe('the pending alert does not depend on the baseline', () => {
    test('it survives a restart and a lease handover: a new tick with fresh closures sends it', async () => {
        fresh();
        follow(mail(), S1);
        const first = rig([obs(), obs({ lastSlashEra: 10 })], async () => { throw new Error('down'); });
        await quiet(async () => { await first.tick(); first.clock.t += 5 * MIN; await first.tick(); });
        const sent = [];
        // A different process: new reader, new sender, a baseline that has moved on by itself.
        const second = rig([obs({ lastSlashEra: 10 })], async (m) => { sent.push(m.tag); return { providerId: 'p' }; });
        second.clock.t = first.clock.t + 40 * MIN;
        await second.tick();
        assert.deepEqual(sent, ['validator.slashed']);
        second.clock.t += 40 * MIN;
        await second.tick();
        assert.deepEqual(sent, ['validator.slashed'], 'not sent twice');
    });

    test('a follower who unsubscribed meanwhile is not mailed', async () => {
        fresh();
        const f = follow(mail(), S1);
        const sent = [];
        let fail = true;
        const send = async (m) => { if (fail) throw new Error('down'); sent.push(m.tag); return { providerId: 'p' }; };
        const h = rig([obs(), obs({ lastSlashEra: 10 })], send);
        await quiet(async () => { await h.tick(); h.clock.t += 5 * MIN; await h.tick(); });
        db.unsubscribeValidatorAlertFollow(f.unsubscribeToken);
        fail = false;
        h.clock.t += HOUR;
        await quiet(() => h.tick());
        assert.deepEqual(sent, []);
    });
});

describe('within one tick the most important kind goes first', () => {
    test('slashed, then disabled, then not-elected, whatever order the events were found in', async () => {
        fresh();
        follow(mail(), S1);
        const order = [];
        let open = true;
        const send = async (m) => { if (!open) return { rateLimited: true, providerId: null }; open = false; order.push(m.tag); return { providerId: 'p' }; };
        const clock = { t: Date.now() };
        const queue = [obs(), obs({ disabled: true, elected: false, lastSlashEra: 10 })];
        let last;
        const readObservation = async (s) => { if (queue.length) last = queue.shift(); return { ...last, stash: s }; };
        const tick = () => { open = true; return runValidatorAlertsTick({ db, readObservation, send, origin: ORIGIN, enabled: () => true, nameOf: async () => null, now: () => clock.t }); };
        await quiet(async () => {
            await tick(); clock.t += 5 * MIN;
            await tick(); clock.t += 5 * MIN;
            await tick(); clock.t += 5 * MIN;
            await tick();
        });
        assert.deepEqual(order, ['validator.slashed', 'validator.disabled', 'validator.not-elected']);
    });
});

describe('B3: a slash during a stale gap is still mailed; the transient kinds are not', () => {
    const key = `validator-alerts:obs:${S1}`;
    const stale = (rec) => ({ ...rec, at: Date.now() - MAX_OBSERVATION_AGE_MS - HOUR });

    test('the era moved forward from a known-none baseline: slashed is sent, a commission change in the gap is not', async () => {
        fresh();
        follow(mail(), S1);
        const sent = [];
        const h = rig([obs(), obs({ lastSlashEra: 12, commission: 1, disabled: true, elected: false })], async (m) => { sent.push(m.tag); return { providerId: 'p' }; });
        await h.tick();
        db.setKv(key, stale(db.getKv(key)));
        h.clock.t = Date.now();
        await h.tick();
        assert.deepEqual(sent, ['validator.slashed']);
        assert.equal(db.getKv(key).obs.lastSlashEra, 12, 'the baseline is replaced');
    });

    test('the era moved forward from an older era: slashed is sent', async () => {
        fresh();
        follow(mail(), S1);
        const sent = [];
        const h = rig([obs({ lastSlashEra: 5 }), obs({ lastSlashEra: 9 })], async (m) => { sent.push(m.tag); return { providerId: 'p' }; });
        await h.tick();
        db.setKv(key, stale(db.getKv(key)));
        h.clock.t = Date.now();
        await h.tick();
        assert.deepEqual(sent, ['validator.slashed']);
    });

    test('an old baseline whose slash state was unknown (a failed read, or the old shape) sends nothing', async () => {
        for (const old of [null, undefined]) {
            fresh();
            follow(mail(), S1);
            const sent = [];
            const h = rig([obs({ lastSlashEra: old }), obs({ lastSlashEra: 9 })], async (m) => { sent.push(m.tag); return { providerId: 'p' }; });
            await h.tick();
            db.setKv(key, stale(db.getKv(key)));
            h.clock.t = Date.now();
            await h.tick();
            assert.deepEqual(sent, [], `old baseline ${old}`);
        }
    });

    test('an unchanged era, or a failed read now, sends nothing and a failed read never becomes known-none', async () => {
        fresh();
        follow(mail(), S1);
        const sent = [];
        const h = rig([obs({ lastSlashEra: 5 }), obs({ lastSlashEra: 5 }), obs({ lastSlashEra: null })], async (m) => { sent.push(m.tag); return { providerId: 'p' }; });
        await h.tick();
        db.setKv(key, stale(db.getKv(key)));
        h.clock.t = Date.now();
        await h.tick();
        assert.deepEqual(sent, []);
        db.setKv(key, stale(db.getKv(key)));
        await h.tick();
        assert.deepEqual(sent, []);
        assert.equal(db.getKv(key).obs.lastSlashEra, 5, 'the known era is kept through a failed read in a stale gap');
    });

    test('a stored observation with no timestamp is stale and follows the same rule', async () => {
        fresh();
        follow(mail(), S1);
        const sent = [];
        const h = rig([obs(), obs({ lastSlashEra: 3 })], async (m) => { sent.push(m.tag); return { providerId: 'p' }; });
        await h.tick();
        db.setKv(key, { obs: db.getKv(key).obs });
        await h.tick();
        assert.deepEqual(sent, ['validator.slashed']);
    });
});
