// Validator onboarding, Sprint 6 (optional): email alerts for a validator a
// person follows. Spec: cto-team/plans/2026-11-17-validator-onboarding-design.md,
// "Sprint 6 (optional): alerts".
//
//   lib/validator-alerts.js       pure: observation, event detection, the mail text
//   lib/validator-alerts-run.js   one tick: read, detect, mail each confirmed follower once
//   db.js                         validator_alert_follows (a follow hangs off an email_subscribers row)
//
// Acceptance covered here: each event fires once per occurrence on a replay of
// recorded observations (also across a restart, whose state is the database);
// no missing-heartbeat alert in the first 85% of a session; nothing is sent with
// the server switch off. The subscribe, confirm and unsubscribe routes are in
// test/validator-alerts-api.test.js.
//
// Every account is 32 bytes of one repeated value at prefix 88 and belongs to no
// one; every email address is on example.com.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeAddress } from '@polkadot/util-crypto';
import * as db from '../db.js';
import {
    ALERT_KINDS, HEARTBEAT_ALERT_PROGRESS, MAX_FOLLOWS_PER_EMAIL, validatorAlertsSendEnabled,
    observationFromStatus, detectValidatorEvents, mergeBaseline, alertMail, confirmMail
} from '../lib/validator-alerts.js';
import { runValidatorAlertsTick } from '../lib/validator-alerts-run.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const S1 = addr(81), S2 = addr(82);
const ORIGIN = 'https://explorer.example.com';

const dirs = [];
function fresh() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-val-alerts-'));
    dirs.push(d);
    db.initDb(d, true);
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });

const obs = (o = {}) => ({
    stash: S1, block: 1000, era: 10, session: 60, progress: 0.1, intent: true, elected: true, inSession: true, disabled: false,
    heartbeat: true, blocks: 3, lastSlashEra: 'none', commission: 50_000_000, keys: 'k1', ...o
});
const kinds = (events) => events.map(e => e.kind);

describe('the server switch', () => {
    test('sending is off unless VALIDATOR_ALERTS_SEND is exactly 1', () => {
        assert.equal(validatorAlertsSendEnabled({}), false);
        assert.equal(validatorAlertsSendEnabled({ VALIDATOR_ALERTS_SEND: '' }), false);
        assert.equal(validatorAlertsSendEnabled({ VALIDATOR_ALERTS_SEND: '0' }), false);
        assert.equal(validatorAlertsSendEnabled({ VALIDATOR_ALERTS_SEND: 'true' }), false);
        assert.equal(validatorAlertsSendEnabled({ VALIDATOR_ALERTS_SEND: '1' }), true);
    });
    test('the six kinds and the 85 percent rule are the spec ones', () => {
        assert.deepEqual([...ALERT_KINDS].sort(), ['commission-changed', 'disabled', 'keys-changed', 'no-heartbeat', 'not-elected', 'slashed']);
        assert.equal(HEARTBEAT_ALERT_PROGRESS, 0.85);
        assert.equal(MAX_FOLLOWS_PER_EMAIL, 5);
    });
});

describe('observationFromStatus: the chain snapshot reduced to what the detector reads', () => {
    const snap = {
        address: S1, activeEra: 10, sessionIndex: 60, sessionProgress: 0.4, intent: true, inSession: true, exposure: { total: '5' },
        disabled: false, heartbeat: true, blocks: 2, lastSlashEra: null, prefs: { commission: 100_000_000, blocked: false },
        nextKeys: { grandpa: '0xaa', babe: '0xbb' }
    };
    test('the slash field has three states: the era, the known-none marker (read succeeded) and null (failed read)', () => {
        assert.equal(observationFromStatus({ ...snap, lastSlashEra: 7, slashRead: true }).lastSlashEra, 7);
        assert.equal(observationFromStatus({ ...snap, lastSlashEra: null, slashRead: true }).lastSlashEra, 'none', 'no slashing spans record');
        assert.equal(observationFromStatus({ ...snap, lastSlashEra: 0, slashRead: true }).lastSlashEra, 'none', 'lastNonzeroSlash 0');
        assert.equal(observationFromStatus({ ...snap, lastSlashEra: null, slashRead: false }).lastSlashEra, null, 'failed read');
        assert.equal(observationFromStatus({ ...snap, lastSlashEra: null }).lastSlashEra, null, 'a snapshot without the flag is unknown');
    });
    test('copies the fields and takes the block from the caller', () => {
        const o = observationFromStatus(snap, { block: 4242 });
        assert.deepEqual(o, { stash: S1, block: 4242, era: 10, session: 60, progress: 0.4, intent: true, elected: true, inSession: true,
            disabled: false, heartbeat: true, blocks: 2, lastSlashEra: null, commission: 100_000_000, keys: o.keys });
        assert.equal(typeof o.keys, 'string');
    });
    test('elected: in the session set or holding an exposure; false when validating and neither; null when not validating', () => {
        assert.equal(observationFromStatus({ ...snap, inSession: false, exposure: null }).elected, false);
        assert.equal(observationFromStatus({ ...snap, inSession: false, exposure: { total: '1' } }).elected, true);
        assert.equal(observationFromStatus({ ...snap, intent: false, inSession: false, exposure: null }).elected, null);
        assert.equal(observationFromStatus({ ...snap, intent: null, inSession: false, exposure: null }).elected, null);
    });
    test('the keys string does not depend on the order of the map', () => {
        const a = observationFromStatus({ ...snap, nextKeys: { babe: '0xbb', grandpa: '0xaa' } }).keys;
        const b = observationFromStatus(snap).keys;
        assert.equal(a, b);
        assert.notEqual(observationFromStatus({ ...snap, nextKeys: { babe: '0xbc', grandpa: '0xaa' } }).keys, b);
        assert.equal(observationFromStatus({ ...snap, nextKeys: null }).keys, null);
    });
    test('unknown reads stay null, never a guess', () => {
        const o = observationFromStatus({ address: S1, prefs: null, nextKeys: null }, {});
        assert.equal(o.heartbeat, null); assert.equal(o.blocks, null); assert.equal(o.commission, null); assert.equal(o.progress, null);
        assert.equal(o.block, null);
    });
});

describe('detectValidatorEvents: one function per rule, over two observations', () => {
    test('no previous observation: state changes are baseline, nothing is announced', () => {
        const cur = obs({ elected: false, disabled: true, lastSlashEra: 9 });
        assert.deepEqual(detectValidatorEvents(null, cur), []);
    });

    test('not elected: a validating stash outside the elected set, once per era', () => {
        const ev = detectValidatorEvents(obs(), obs({ elected: false }));
        assert.deepEqual(kinds(ev), ['not-elected']);
        assert.equal(ev[0].occurrence, 'not-elected:e10');
        assert.equal(ev[0].stash, S1);
        assert.deepEqual(kinds(detectValidatorEvents(obs(), obs({ elected: null }))), []);
        assert.deepEqual(kinds(detectValidatorEvents(obs(), obs({ intent: false, elected: false }))), []);
        assert.deepEqual(kinds(detectValidatorEvents(obs(), obs({ era: null, elected: false }))), [], 'no era, no occurrence to name');
        assert.equal(detectValidatorEvents(obs({ elected: false }), obs({ era: 11, elected: false }))[0].occurrence, 'not-elected:e11');
    });

    test('heartbeat: nothing in the first 85% of a session, then no heartbeat and no authored block', () => {
        const quiet = { heartbeat: false, blocks: 0 };
        assert.deepEqual(detectValidatorEvents(obs(), obs({ ...quiet, progress: 0 })), []);
        assert.deepEqual(detectValidatorEvents(obs(), obs({ ...quiet, progress: 0.5 })), []);
        assert.deepEqual(detectValidatorEvents(obs(), obs({ ...quiet, progress: 0.8499999 })), []);
        const at = detectValidatorEvents(obs(), obs({ ...quiet, progress: 0.85 }));
        assert.deepEqual(kinds(at), ['no-heartbeat']);
        assert.equal(at[0].occurrence, 'no-heartbeat:s60');
        assert.deepEqual(kinds(detectValidatorEvents(obs(), obs({ ...quiet, progress: 0.99 }))), ['no-heartbeat']);
    });

    test('heartbeat: a heartbeat, an authored block, an unknown read or a stash outside the session set is no alert', () => {
        const late = { progress: 0.95 };
        assert.deepEqual(detectValidatorEvents(obs(), obs({ ...late, heartbeat: true, blocks: 0 })), []);
        assert.deepEqual(detectValidatorEvents(obs(), obs({ ...late, heartbeat: false, blocks: 1 })), []);
        assert.deepEqual(detectValidatorEvents(obs(), obs({ ...late, heartbeat: null, blocks: 0 })), []);
        assert.deepEqual(detectValidatorEvents(obs(), obs({ ...late, heartbeat: false, blocks: null })), []);
        assert.deepEqual(detectValidatorEvents(obs(), obs({ ...late, heartbeat: false, blocks: 0, inSession: false })), []);
        assert.deepEqual(detectValidatorEvents(obs(), obs({ ...late, heartbeat: false, blocks: 0, progress: null })), []);
        assert.deepEqual(detectValidatorEvents(obs(), obs({ ...late, heartbeat: false, blocks: 0, session: null })), []);
    });

    test('heartbeat at a session boundary: the new session starts clean and its own 85% is a new occurrence', () => {
        const quiet = { heartbeat: false, blocks: 0 };
        const lateOld = obs({ ...quiet, session: 60, progress: 0.9 });
        const earlyNew = obs({ ...quiet, session: 61, progress: 0.02 });
        const lateNew = obs({ ...quiet, session: 61, progress: 0.86 });
        assert.deepEqual(detectValidatorEvents(lateOld, earlyNew), []);
        assert.equal(detectValidatorEvents(earlyNew, lateNew)[0].occurrence, 'no-heartbeat:s61');
        assert.equal(detectValidatorEvents(lateOld, lateOld)[0].occurrence, 'no-heartbeat:s60');
    });

    test('disabled: the change to disabled, not the state', () => {
        const ev = detectValidatorEvents(obs(), obs({ disabled: true }));
        assert.deepEqual(kinds(ev), ['disabled']);
        assert.equal(ev[0].occurrence, 'disabled:e10');
        assert.deepEqual(detectValidatorEvents(obs({ disabled: true }), obs({ disabled: true })), []);
        assert.deepEqual(detectValidatorEvents(obs({ disabled: true }), obs({ disabled: false })), []);
    });

    test('slashed: a new slash era, never an older or the same one', () => {
        const ev = detectValidatorEvents(obs(), obs({ lastSlashEra: 9 }));
        assert.deepEqual(kinds(ev), ['slashed']);
        assert.equal(ev[0].occurrence, 'slashed:e9');
        assert.deepEqual(detectValidatorEvents(obs({ lastSlashEra: 9 }), obs({ lastSlashEra: 9 })), []);
        assert.equal(detectValidatorEvents(obs({ lastSlashEra: 9 }), obs({ lastSlashEra: 12 }))[0].occurrence, 'slashed:e12');
        assert.deepEqual(detectValidatorEvents(obs({ lastSlashEra: 9 }), obs({ lastSlashEra: 7 })), []);
        assert.deepEqual(detectValidatorEvents(obs({ lastSlashEra: 9 }), obs({ lastSlashEra: null })), []);
    });

    test('commission changed: both values known and different; the same pair at another block is another occurrence', () => {
        const up = detectValidatorEvents(obs(), obs({ commission: 100_000_000, block: 1500 }));
        assert.deepEqual(kinds(up), ['commission-changed']);
        assert.equal(up[0].occurrence, 'commission:50000000>100000000@1500');
        assert.equal(up[0].detail.from, 50_000_000);
        assert.equal(up[0].detail.to, 100_000_000);
        assert.deepEqual(detectValidatorEvents(obs(), obs({ commission: 50_000_000 })), []);
        assert.deepEqual(detectValidatorEvents(obs(), obs({ commission: null })), []);
        assert.deepEqual(detectValidatorEvents(obs({ commission: null }), obs({ commission: 1 })), []);
        const again = detectValidatorEvents(obs(), obs({ commission: 100_000_000, block: 2500 }));
        assert.notEqual(again[0].occurrence, up[0].occurrence);
    });

    test('keys changed: the next session keys differ; cleared keys are not an alert', () => {
        const ev = detectValidatorEvents(obs(), obs({ keys: 'k2', block: 1200 }));
        assert.deepEqual(kinds(ev), ['keys-changed']);
        assert.match(ev[0].occurrence, /^keys:.+@1200$/);
        assert.deepEqual(detectValidatorEvents(obs(), obs({ keys: 'k1' })), []);
        assert.deepEqual(detectValidatorEvents(obs(), obs({ keys: null })), []);
        assert.deepEqual(detectValidatorEvents(obs({ keys: null }), obs({ keys: 'k2' })), [], 'an unknown previous value is not a change');
    });

    test('several events in one step are all returned, each with its own occurrence', () => {
        const ev = detectValidatorEvents(obs(), obs({ disabled: true, lastSlashEra: 10, commission: 1, keys: 'k9', elected: false }));
        assert.deepEqual(kinds(ev).sort(), ['commission-changed', 'disabled', 'keys-changed', 'not-elected', 'slashed']);
        assert.equal(new Set(ev.map(e => e.occurrence)).size, ev.length);
    });
});

describe('the mail text', () => {
    const unsub = `${ORIGIN}/api/validator-alerts/unsubscribe?token=tok`;
    const ctx = { origin: ORIGIN, unsubscribeUrl: unsub, name: 'Example Validator' };
    const events = detectValidatorEvents(obs(), obs({ elected: false, disabled: true, lastSlashEra: 10, commission: 100_000_000, keys: 'k9', progress: 0.9, heartbeat: false, blocks: 0 }));

    test('every kind has a subject, a plain text body and a simple HTML body with the explorer link and the unsubscribe link', () => {
        assert.deepEqual(kinds(events).sort(), [...ALERT_KINDS].sort());
        for (const e of events) {
            const m = alertMail(e, ctx);
            assert.ok(m.subject.length > 10 && m.subject.length < 90, m.subject);
            assert.match(m.subject, /Example Validator|e[1-9A-HJ-NP-Za-km-z]{6}/);
            for (const body of [m.text, m.html]) {
                assert.ok(body.includes(`${ORIGIN}/validate/${S1}`), `${e.kind}: explorer link`);
                assert.ok(body.includes(unsub), `${e.kind}: unsubscribe link`);
            }
            assert.match(m.text, /You asked for alerts about this validator/);
            assert.match(m.html, /<!doctype html>/i);
            assert.ok(!/[\u2013\u2014]/.test(m.subject + m.text + m.html), `${e.kind}: a dash character`);
        }
    });

    test('the commission mail names both values; the heartbeat mail says what the rule is', () => {
        const c = alertMail(events.find(e => e.kind === 'commission-changed'), ctx);
        assert.match(c.text, /5%/);
        assert.match(c.text, /10%/);
        const h = alertMail(events.find(e => e.kind === 'no-heartbeat'), ctx);
        assert.match(h.text, /85%/);
    });

    test('the validator name is escaped in HTML', () => {
        const m = alertMail(events[0], { ...ctx, name: '<script>x</script>' });
        assert.ok(!m.html.includes('<script>'));
    });

    test('the confirmation mail names the validator, what is sent, the 24 hour link and how to stop', () => {
        const m = confirmMail({ stash: S1, name: null, confirmUrl: `${ORIGIN}/api/validator-alerts/confirm?token=c`, unsubscribeUrl: unsub, origin: ORIGIN });
        assert.match(m.subject, /Confirm/i);
        for (const body of [m.text, m.html]) {
            assert.ok(body.includes('/api/validator-alerts/confirm?token=c'));
            assert.ok(body.includes(unsub));
            assert.match(body, /24 hours/);
            assert.match(body, /elected/);
            assert.match(body, /slashed/);
            assert.match(body, /ignore this email|If you did not ask/i);
        }
    });
});

// ---------------------------------------------------------------- the database

let seq = 0;
const mail = () => `person${++seq}@example.com`;
function follow(email, stash, { confirm = true, maxPerEmail = 5 } = {}) {
    const r = db.addValidatorAlertFollow({ email, stash, subscriberConfirmationToken: `sc${seq}${stash.slice(-4)}${Math.random()}`, subscriberUnsubscribeToken: `su${seq}${stash.slice(-4)}${Math.random()}`,
        confirmationToken: `c${Math.random()}`.slice(0, 20), unsubscribeToken: `u${Math.random()}`.slice(0, 20), maxPerEmail });
    if (confirm && r.follow) db.confirmValidatorAlertFollow(r.follow.confirmationToken);
    return r;
}

describe('validator_alert_follows: a follow hangs off an email_subscribers row', () => {
    test('a first follow creates an unconfirmed email-only subscriber (no governance mail) and a pending follow', () => {
        fresh();
        const e = mail();
        const r = follow(e, S1, { confirm: false });
        assert.equal(r.status, 'pending');
        assert.equal(r.follow.stash, S1);
        assert.equal(r.follow.confirmedAt, null);
        assert.equal(db.getConfirmedEmailSubscribers().length, 0, 'the general mailing list gains nobody');
        assert.deepEqual(db.getActiveValidatorAlertFollows(), []);
    });

    test('confirming makes it active; a second follow of the same stash is "exists" and sends no new token', () => {
        fresh();
        const e = mail();
        const a = follow(e, S1);
        assert.equal(db.getActiveValidatorAlertFollows().length, 1);
        assert.equal(db.getActiveValidatorAlertFollows()[0].email, e);
        const b = follow(e, S1, { confirm: false });
        assert.equal(b.status, 'exists');
        assert.equal(db.getValidatorAlertFollowByConfirmationToken(a.follow.confirmationToken).confirmedAt > 0, true, 'the old confirmation token is not rotated for a live follow');
    });

    test('resending to a pending follow rotates the confirmation token and the old one stops working', () => {
        fresh();
        const e = mail();
        const a = follow(e, S1, { confirm: false });
        const b = follow(e, S1, { confirm: false });
        assert.equal(b.status, 'pending');
        assert.notEqual(a.follow.confirmationToken, b.follow.confirmationToken);
        assert.equal(db.getValidatorAlertFollowByConfirmationToken(a.follow.confirmationToken), null);
        assert.ok(db.getValidatorAlertFollowByConfirmationToken(b.follow.confirmationToken));
    });

    test('a cap on live follows per address; unsubscribing one frees a place', () => {
        fresh();
        const e = mail();
        const stashes = [1, 2, 3].map(n => addr(90 + n));
        for (const s of stashes) assert.equal(follow(e, s, { maxPerEmail: 3 }).status, 'pending');
        assert.equal(follow(e, addr(99), { maxPerEmail: 3 }).status, 'cap');
        assert.equal(db.getActiveValidatorAlertFollows().length, 3);
        const f = db.getActiveValidatorAlertFollows()[0];
        db.unsubscribeValidatorAlertFollow(f.unsubscribeToken);
        assert.equal(follow(e, addr(99), { maxPerEmail: 3 }).status, 'pending');
        // resending to one already counted is not blocked by the cap
        assert.equal(follow(e, stashes[1], { maxPerEmail: 3, confirm: false }).status, 'exists');
    });

    test('unsubscribe is by the follow token, idempotent, and ends the follow without touching other follows', () => {
        fresh();
        const e = mail();
        const a = follow(e, S1);
        follow(e, S2);
        const r = db.unsubscribeValidatorAlertFollow(a.follow.unsubscribeToken);
        assert.ok(r.unsubscribedAt > 0);
        assert.ok(db.unsubscribeValidatorAlertFollow(a.follow.unsubscribeToken).unsubscribedAt);
        assert.equal(db.unsubscribeValidatorAlertFollow('nope'), null);
        assert.deepEqual(db.getActiveValidatorAlertFollows().map(f => f.stash), [S2]);
    });

    test('following again after unsubscribing needs a fresh confirmation', () => {
        fresh();
        const e = mail();
        const a = follow(e, S1);
        db.unsubscribeValidatorAlertFollow(a.follow.unsubscribeToken);
        const b = follow(e, S1, { confirm: false });
        assert.equal(b.status, 'pending');
        assert.deepEqual(db.getActiveValidatorAlertFollows(), []);
        db.confirmValidatorAlertFollow(b.follow.confirmationToken);
        assert.equal(db.getActiveValidatorAlertFollows().length, 1);
    });

    test('an address that unsubscribed from all explorer mail is blocked, and its follows stop sending', () => {
        fresh();
        const e = mail();
        follow(e, S1);
        const sub = db.createEmailSubscriberIfMissing({ email: e, confirmationToken: 'x1', unsubscribeToken: 'x2', eventPrefs: {}, source: 'x' }).subscriber;
        db.unsubscribeEmailSubscriber(sub.unsubscribeToken);
        assert.deepEqual(db.getActiveValidatorAlertFollows(), [], 'a global unsubscribe wins');
        assert.equal(follow(e, S2, { confirm: false }).status, 'blocked');
    });

    test('the confirmation token is good for 24 hours', () => {
        fresh();
        const a = follow(mail(), S1, { confirm: false });
        assert.equal(db.isValidatorAlertConfirmationFresh(a.follow), true);
        assert.equal(db.isValidatorAlertConfirmationFresh({ ...a.follow, updatedAt: Date.now() - 25 * 3600_000 }), false);
        assert.equal(db.isValidatorAlertConfirmationFresh(null), false);
    });

    test('the reads never expose the subscriber tokens', () => {
        fresh();
        const a = follow(mail(), S1, { confirm: false });
        const f = db.getValidatorAlertFollowByConfirmationToken(a.follow.confirmationToken);
        assert.deepEqual(Object.keys(f).filter(k => /subscriber.*token/i.test(k)), []);
    });
});

// ------------------------------------------------------------------ the tick

function harness(observations, { enabled = true, failFirstRead = false } = {}) {
    const sent = [];
    const reads = [];
    let ok = !failFirstRead;
    const queue = observations.slice();
    const readObservation = async (stash) => {
        reads.push(stash);
        if (!ok) { ok = true; throw new Error('rpc down'); }
        const next = queue.length ? queue.shift() : null;
        if (!next) throw new Error('replay exhausted');
        return { ...next, stash };
    };
    const send = async (m) => { sent.push(m); return { providerId: 'p' }; };
    const tick = () => runValidatorAlertsTick({ db, readObservation, send, origin: ORIGIN, enabled: () => enabled, nameOf: async () => null });
    return { sent, reads, tick, queue };
}
const toOf = (sent, email) => sent.filter(m => m.to === email);

describe('runValidatorAlertsTick: a replay of recorded observations', () => {
    const replay = [
        obs(),                                                           // baseline
        obs({ block: 1010 }),                                            // nothing happened
        obs({ block: 1020, commission: 100_000_000 }),                   // commission changed
        obs({ block: 1030, commission: 100_000_000 }),                   // same again
        obs({ block: 1040, commission: 100_000_000, keys: 'k2' }),       // keys changed
        obs({ block: 1050, commission: 100_000_000, keys: 'k2', progress: 0.5, heartbeat: false, blocks: 0 }),   // too early to alert
        obs({ block: 1060, commission: 100_000_000, keys: 'k2', progress: 0.9, heartbeat: false, blocks: 0 }),   // no heartbeat at 90%
        obs({ block: 1061, commission: 100_000_000, keys: 'k2', progress: 0.95, heartbeat: false, blocks: 0 }),  // still none
        obs({ block: 1070, commission: 100_000_000, keys: 'k2', progress: 0.95, heartbeat: false, blocks: 0, disabled: true }),
        obs({ block: 1080, commission: 100_000_000, keys: 'k2', progress: 0.97, heartbeat: false, blocks: 0, disabled: true, lastSlashEra: 10 }),
        obs({ block: 1090, era: 11, session: 66, progress: 0.01, commission: 100_000_000, keys: 'k2', elected: false, lastSlashEra: 10 }),
        obs({ block: 1100, era: 11, session: 66, progress: 0.2, commission: 100_000_000, keys: 'k2', elected: false, lastSlashEra: 10 }),
        obs({ block: 1110, era: 11, session: 67, progress: 0.3, commission: 100_000_000, keys: 'k2', elected: false, lastSlashEra: 10 })
    ];

    test('each of the six events mails each confirmed follower exactly once, and a restart in the middle changes nothing', async () => {
        fresh();
        const a = mail(), b = mail();
        follow(a, S1); follow(b, S1);
        const c = mail();
        follow(c, S2);   // a follow of another stash must not receive S1 mail
        const h = harness(replay.slice(0, 7));
        for (let i = 0; i < 7; i++) await h.tick();
        // "restart": a brand new harness (no in-memory state) over the same database
        const h2 = harness(replay.slice(7));
        for (let i = 0; i < replay.length - 7; i++) await h2.tick();
        const all = [...h.sent, ...h2.sent];
        assert.equal(toOf(all, a).length, 6, toOf(all, a).map(m => m.subject).join(' | '));
        assert.equal(toOf(all, b).length, 6);
        for (const k of ALERT_KINDS) assert.equal(all.filter(m => m.to === a && m.tag === `validator.${k}`).length, 1, k);
    });

    test('replaying the same recorded sequence again after it was processed mails nothing more', async () => {
        fresh();
        follow(mail(), S1);
        const first = harness(replay);
        for (let i = 0; i < replay.length; i++) await first.tick();
        assert.equal(first.sent.length, 6);
        // the state a restart reads is the database: forget the stored observation and replay
        db.setKv(`validator-alerts:obs:${S1}`, null);
        const second = harness(replay);
        for (let i = 0; i < replay.length; i++) await second.tick();
        assert.equal(second.sent.length, 0, 'the sent log stops a second send of the same occurrence');
    });

    test('the first observation of a stash is a baseline: no state-change mail, however bad it looks', async () => {
        fresh();
        follow(mail(), S1);
        const h = harness([obs({ disabled: true, lastSlashEra: 3, elected: false })]);
        await h.tick();
        assert.equal(h.sent.length, 0);
    });

    test('the 85 percent rule on a tick: 84.9% sends nothing, 85% sends one', async () => {
        fresh();
        follow(mail(), S1);
        const q = { heartbeat: false, blocks: 0 };
        const h = harness([obs(), obs({ ...q, progress: 0.849 }), obs({ ...q, progress: 0.85 })]);
        await h.tick(); await h.tick();
        assert.equal(h.sent.length, 0);
        await h.tick();
        assert.equal(h.sent.length, 1);
        assert.equal(h.sent[0].tag, 'validator.no-heartbeat');
    });

    test('every mail carries the explorer link, the unsubscribe link and the one-click header', async () => {
        fresh();
        const a = mail();
        follow(a, S1);
        const h = harness([obs(), obs({ disabled: true })]);
        await h.tick(); await h.tick();
        const m = h.sent[0];
        assert.equal(m.to, a);
        const f = db.getActiveValidatorAlertFollows()[0];
        const url = `${ORIGIN}/api/validator-alerts/unsubscribe?token=${f.unsubscribeToken}`;
        assert.ok(m.text.includes(url) && m.html.includes(url));
        assert.equal(m.headers['List-Unsubscribe'], `<${url}>`);
        assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
        assert.ok(m.text.includes(`${ORIGIN}/validate/${S1}`));
    });

    test('with the switch off nothing is read, sent or stored', async () => {
        fresh();
        follow(mail(), S1);
        const h = harness([obs(), obs({ disabled: true })], { enabled: false });
        const r1 = await h.tick(); await h.tick();
        assert.equal(r1.skipped, 'off');
        assert.equal(h.sent.length, 0);
        assert.equal(h.reads.length, 0);
        assert.equal(db.getKv(`validator-alerts:obs:${S1}`), null);
    });

    test('turning the switch on later does not mail what happened while it was off', async () => {
        fresh();
        follow(mail(), S1);
        const off = harness([obs({ disabled: true })], { enabled: false });
        await off.tick();
        const on = harness([obs({ disabled: true }), obs({ disabled: true })]);
        await on.tick(); await on.tick();
        assert.equal(on.sent.length, 0);
    });

    test('unconfirmed and unsubscribed follows get nothing, and a stash with no live follow is not read', async () => {
        fresh();
        follow(mail(), S1, { confirm: false });
        const u = follow(mail(), S2);
        db.unsubscribeValidatorAlertFollow(u.follow.unsubscribeToken);
        const h = harness([obs(), obs({ disabled: true })]);
        await h.tick(); await h.tick();
        assert.equal(h.sent.length, 0);
        assert.equal(h.reads.length, 0);
    });

    test('a failed read keeps the last observation and the next tick carries on', async () => {
        fresh();
        follow(mail(), S1);
        const h = harness([obs(), obs({ disabled: true })], { failFirstRead: true });
        await h.tick();                       // read fails
        assert.equal(db.getKv(`validator-alerts:obs:${S1}`), null);
        await h.tick();                       // baseline
        await h.tick();                       // the change
        assert.equal(h.sent.length, 1);
    });

    test('a failed send does not stop another follower getting the mail, and is not retried within the same tick or before its back-off (retry rules: validator-alerts-retry.test.js)', async () => {
        fresh();
        const a = mail(), b = mail();
        follow(a, S1); follow(b, S1);
        const sent = [];
        const queue = [obs(), obs({ disabled: true })];
        const readObservation = async (s) => ({ ...queue.shift(), stash: s });
        const send = async (m) => { if (m.to === a) throw new Error('smtp down'); sent.push(m); return { providerId: 'p' }; };
        const run = () => runValidatorAlertsTick({ db, readObservation, send, origin: ORIGIN, enabled: () => true, nameOf: async () => null });
        await run(); await run();
        assert.deepEqual(sent.map(m => m.to), [b]);
        queue.push(obs({ disabled: true }));
        await run();
        assert.deepEqual(sent.map(m => m.to), [b], 'the same occurrence is not reserved again');
    });

    test('a stash is read once per tick however many people follow it', async () => {
        fresh();
        follow(mail(), S1); follow(mail(), S1); follow(mail(), S1);
        const h = harness([obs()]);
        await h.tick();
        assert.deepEqual(h.reads, [S1]);
    });

    test('the sent log is the existing email_dispatches table, keyed by the stash and the occurrence', async () => {
        fresh();
        follow(mail(), S1);
        const h = harness([obs(), obs({ disabled: true })]);
        await h.tick(); await h.tick();
        const sub = db.getActiveValidatorAlertFollows()[0];
        assert.equal(db.reserveEmailDispatch({ eventKind: 'validator.disabled', eventId: `${S1}:disabled:e10`, subscriberId: sub.subscriberId }), false);
    });

    test('the source holds no em or en dash', () => {
        for (const f of ['lib/validator-alerts.js', 'lib/validator-alerts-run.js']) {
            const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
            assert.ok(!/[\u2013\u2014]/.test(src), f);
        }
    });
});

describe('a follower who later signs up through the general alerts button gets the default preferences', () => {
    const existingSub = (e) => db.createEmailSubscriberIfMissing({ email: e, confirmationToken: 'x', unsubscribeToken: 'y', eventPrefs: { never: true }, source: 'general' }).subscriber;
    const DEFAULTS = { governance: { referenda: true }, network: { upgrades: true } };
    test('an email-only subscriber made by a follow has empty prefs; the general signup fills them and leaves the follows alone', () => {
        fresh();
        const e = mail();
        follow(e, S1);
        follow(e, S2, { confirm: false });
        const before = existingSub(e);
        assert.deepEqual(before.eventPrefs, {});
        const after = db.adoptDefaultPrefsIfEmpty(before, DEFAULTS);
        assert.deepEqual(after.eventPrefs, DEFAULTS);
        assert.deepEqual(existingSub(e).eventPrefs, DEFAULTS);
        const live = db.getActiveValidatorAlertFollows().filter(f => f.email === e || f.subscriberId === after.id);
        assert.equal(live.length, 1, 'the confirmed follow is untouched');
        assert.equal(live[0].stash, S1);
    });
    test('a subscriber who already has preferences keeps them', () => {
        fresh();
        const e = mail();
        follow(e, S1);
        const sub = existingSub(e);
        db.setEmailSubscriberPrefs(sub.unsubscribeToken, { governance: { referenda: false } });
        const again = db.adoptDefaultPrefsIfEmpty(existingSub(e), DEFAULTS);
        assert.deepEqual(again.eventPrefs, { governance: { referenda: false } });
    });
    test('the general subscribe route calls it for an existing row', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
        const i = src.indexOf("app.post('/api/email/subscribe'");
        const route = src.slice(i, src.indexOf("app.", i + 10));
        assert.match(route, /db\.adoptDefaultPrefsIfEmpty\(\w+, prefs\)/);
    });
});

// ---------------------------------------------------------------- Sprint 6 check fixes

import { MAX_OBSERVATION_AGE_MS } from '../lib/validator-alerts-run.js';

const withClock = (offsetMs, fn) => {
    const real = Date.now;
    Date.now = () => real() + offsetMs;
    try { return fn(); } finally { Date.now = real; }
};
const obsKey = `validator-alerts:obs:${S1}`;

describe('partial reads never alert (null guards)', () => {
    test('keys: a null on either side is no alert; two known and different keys still are', () => {
        assert.deepEqual(detectValidatorEvents(obs({ keys: null }), obs({ keys: 'k2' })), []);
        assert.deepEqual(detectValidatorEvents(obs({ keys: 'k1' }), obs({ keys: null })), []);
        assert.deepEqual(kinds(detectValidatorEvents(obs({ keys: 'k1' }), obs({ keys: 'k2' }))), ['keys-changed']);
    });
    test('slashed: three states. known none or a lower era then a higher era alerts, however old that era is', () => {
        assert.deepEqual(kinds(detectValidatorEvents(obs({ lastSlashEra: 'none' }), obs({ lastSlashEra: 3 }))), ['slashed'], 'a first slash that names an older era is still news');
        assert.equal(detectValidatorEvents(obs({ lastSlashEra: 'none' }), obs({ lastSlashEra: 3 }))[0].occurrence, 'slashed:e3');
        assert.deepEqual(kinds(detectValidatorEvents(obs({ lastSlashEra: 2 }), obs({ lastSlashEra: 3 }))), ['slashed']);
        assert.deepEqual(detectValidatorEvents(obs({ lastSlashEra: 'none' }), obs({ lastSlashEra: 'none' })), []);
        assert.deepEqual(detectValidatorEvents(obs({ lastSlashEra: 3 }), obs({ lastSlashEra: 3 })), []);
    });
    test('slashed: an unknown previous value (failed read, or a baseline stored in the old shape) adopts the current value and never alerts', () => {
        assert.deepEqual(detectValidatorEvents(obs({ lastSlashEra: null }), obs({ lastSlashEra: 10 })), [], 'even a slash of the current era');
        assert.deepEqual(detectValidatorEvents(obs({ lastSlashEra: null }), obs({ lastSlashEra: 3 })), []);
        assert.deepEqual(detectValidatorEvents(obs({ lastSlashEra: null }), obs({ lastSlashEra: 'none' })), []);
    });
    test('slashed: a failed read now (null) is never an alert', () => {
        assert.deepEqual(detectValidatorEvents(obs({ lastSlashEra: 9 }), obs({ lastSlashEra: null })), []);
        assert.deepEqual(detectValidatorEvents(obs({ lastSlashEra: 'none' }), obs({ lastSlashEra: null })), []);
    });
    test('slashed: the first observation ever is a baseline, no alert', () => {
        assert.deepEqual(detectValidatorEvents(null, obs({ lastSlashEra: 5 })), []);
    });
    test('slashed: a failed read keeps the known-none baseline, so a slash seen after it alerts once', () => {
        const kept = mergeBaseline(obs({ lastSlashEra: 'none' }), obs({ lastSlashEra: null }));
        assert.equal(kept.lastSlashEra, 'none');
        assert.deepEqual(kinds(detectValidatorEvents(kept, obs({ lastSlashEra: 4 }))), ['slashed']);
    });
    test('slashed: an old-shape stored baseline (null) in the kv table adopts the current value without mail', async () => {
        fresh();
        follow(mail(), S1);
        db.setKv(obsKey, { obs: obs({ lastSlashEra: null }), at: Date.now() });
        const h = harness([obs({ block: 1010, lastSlashEra: 6 }), obs({ block: 1020, lastSlashEra: 6 }), obs({ block: 1030, lastSlashEra: 8 })]);
        await h.tick();
        assert.equal(h.sent.length, 0, 'adopted, not alerted');
        assert.equal(db.getKv(obsKey).obs.lastSlashEra, 6);
        await h.tick();
        assert.equal(h.sent.length, 0);
        await h.tick();
        assert.equal(h.sent.length, 1, 'a later slash alerts');
    });
    test('not-elected: an unknown previous election state is no alert', () => {
        assert.deepEqual(detectValidatorEvents(obs({ elected: null, intent: null }), obs({ elected: false })), []);
        assert.deepEqual(kinds(detectValidatorEvents(obs({ elected: true }), obs({ elected: false }))), ['not-elected']);
    });
    test('commission: a null on either side is no alert', () => {
        assert.deepEqual(detectValidatorEvents(obs({ commission: null }), obs({ commission: 9 })), []);
        assert.deepEqual(detectValidatorEvents(obs({ commission: 9 }), obs({ commission: null })), []);
    });
});

describe('runValidatorAlertsTick: stale baselines and flaky reads', () => {
    test('the age limit is 2 hours', () => { assert.equal(MAX_OBSERVATION_AGE_MS, 2 * 3600_000); });

    test('a restart after 3 hours sends nothing and rebases; the next change after that does alert', async () => {
        fresh();
        follow(mail(), S1);
        const h = harness([obs(), obs({ commission: 100_000_000, block: 1500 }), obs({ commission: 100_000_000, block: 1501 }), obs({ commission: 1, block: 1600 })]);
        await h.tick();
        const stored = db.getKv(obsKey);
        db.setKv(obsKey, { ...stored, at: Date.now() - 3 * 3600_000 });
        await h.tick();
        assert.equal(h.sent.length, 0, 'a change seen after downtime is not mailed');
        const rebased = db.getKv(obsKey);
        assert.equal(rebased.obs.commission, 100_000_000);
        assert.ok(Date.now() - rebased.at < 60_000, 'the baseline is fresh');
        await h.tick();
        assert.equal(h.sent.length, 0);
        await h.tick();
        assert.deepEqual(h.sent.map(m => m.tag), ['validator.commission-changed']);
    });

    test('an observation just under 2 hours old is still a baseline', async () => {
        fresh();
        follow(mail(), S1);
        const h = harness([obs(), obs({ commission: 100_000_000 })]);
        await h.tick();
        db.setKv(obsKey, { ...db.getKv(obsKey), at: Date.now() - (2 * 3600_000 - 60_000) });
        await h.tick();
        assert.equal(h.sent.length, 1);
    });

    test('a stored observation with no timestamp is treated as stale', async () => {
        fresh();
        follow(mail(), S1);
        const h = harness([obs(), obs({ commission: 100_000_000 })]);
        await h.tick();
        db.setKv(obsKey, { obs: db.getKv(obsKey).obs });
        await h.tick();
        assert.equal(h.sent.length, 0);
    });

    test('a null read between two good reads sends nothing and keeps the good baseline', async () => {
        fresh();
        follow(mail(), S1);
        const good = { keys: 'k1', commission: 50_000_000, lastSlashEra: 9, elected: true };
        const bad = { keys: null, commission: null, lastSlashEra: null, elected: null, intent: null };
        const h = harness([obs(good), obs({ ...bad, block: 1010 }), obs({ ...good, block: 1020 })]);
        await h.tick();
        await h.tick();
        const kept = db.getKv(obsKey).obs;
        assert.equal(kept.keys, 'k1');
        assert.equal(kept.commission, 50_000_000);
        assert.equal(kept.lastSlashEra, 9);
        assert.equal(kept.elected, true);
        await h.tick();
        assert.equal(h.sent.length, 0, 'the return of the same values is not a change');
    });

    test('after a null read, a real change against the kept baseline still alerts', async () => {
        fresh();
        follow(mail(), S1);
        const h = harness([obs({ keys: 'k1' }), obs({ keys: null }), obs({ keys: 'k2', block: 1100 })]);
        await h.tick(); await h.tick(); await h.tick();
        assert.deepEqual(h.sent.map(m => m.tag), ['validator.keys-changed']);
    });
});

describe('validator_alert_follows: pending expiry and the cap on reconfirming', () => {
    test('a pending follow older than 24 hours stops counting toward the cap, and is cleaned up on the next follow', () => {
        fresh();
        const e = mail();
        follow(e, addr(91), { confirm: false, maxPerEmail: 2 });
        follow(e, addr(92), { confirm: false, maxPerEmail: 2 });
        assert.equal(follow(e, addr(93), { maxPerEmail: 2 }).status, 'cap');
        withClock(25 * 3600_000, () => {
            assert.equal(follow(e, addr(93), { maxPerEmail: 2, confirm: false }).status, 'pending');
            assert.equal(follow(e, addr(94), { maxPerEmail: 2, confirm: false }).status, 'pending');
            assert.equal(db.getValidatorAlertFollowByConfirmationToken('nothing'), null);
        });
    });

    test('an expired pending row is removed, so its old link is gone; a confirmed follow is never expired', () => {
        fresh();
        const e = mail();
        const p = follow(e, addr(91), { confirm: false });
        const c = follow(e, addr(92));
        withClock(26 * 3600_000, () => { follow(e, addr(93), { confirm: false }); });
        assert.equal(db.getValidatorAlertFollowByConfirmationToken(p.follow.confirmationToken), null);
        assert.equal(db.getActiveValidatorAlertFollows().length, 1);
        assert.equal(db.getActiveValidatorAlertFollows()[0].stash, c.follow.stash);
    });

    test('a pending follow younger than 24 hours still counts', () => {
        fresh();
        const e = mail();
        follow(e, addr(91), { confirm: false, maxPerEmail: 1 });
        withClock(23 * 3600_000, () => { assert.equal(follow(e, addr(92), { maxPerEmail: 1 }).status, 'cap'); });
    });

    test('re-confirming an unsubscribed follow re-checks the cap', () => {
        fresh();
        const e = mail();
        const first = follow(e, addr(91), { maxPerEmail: 2 });
        db.unsubscribeValidatorAlertFollow(first.follow.unsubscribeToken);
        const again = follow(e, addr(91), { maxPerEmail: 2, confirm: false });
        assert.equal(again.status, 'pending');
        follow(e, addr(92), { maxPerEmail: 2 });
        follow(e, addr(93), { maxPerEmail: 2 });
        const r = db.confirmValidatorAlertFollow(again.follow.confirmationToken, { maxPerEmail: 2 });
        assert.equal(r.capReached, true);
        assert.equal(db.getActiveValidatorAlertFollows().filter(f => f.stash === addr(91)).length, 0, 'it stays off');
    });

    test('re-confirming with a free place works; a first confirmation is not blocked by its own row', () => {
        fresh();
        const e = mail();
        const a = follow(e, addr(91), { confirm: false, maxPerEmail: 1 });
        const ok = db.confirmValidatorAlertFollow(a.follow.confirmationToken, { maxPerEmail: 1 });
        assert.ok(!ok.capReached);
        assert.ok(ok.confirmedAt);
        db.unsubscribeValidatorAlertFollow(a.follow.unsubscribeToken);
        const b = follow(e, addr(91), { confirm: false, maxPerEmail: 1 });
        const back = db.confirmValidatorAlertFollow(b.follow.confirmationToken, { maxPerEmail: 1 });
        assert.ok(!back.capReached);
        assert.equal(db.getActiveValidatorAlertFollows().length, 1);
    });
});
