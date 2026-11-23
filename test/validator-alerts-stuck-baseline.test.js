// Validator alerts: a reserve that throws on every tick must not pin a stash's baseline forever
// (it warned every tick and never moved on). After MAX_RESERVE_FAIL_TICKS consecutive failed ticks for
// a stash the baseline advances, with one console.error naming the kind and the stash (never an address).
// Accounts are 32 bytes of one repeated value; emails are example.com.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeAddress } from '@polkadot/util-crypto';

const db = await import('../db.js');
const run = await import('../lib/validator-alerts-run.js');
const { runValidatorAlertsTick, OBS_KEY, MAX_RESERVE_FAIL_TICKS, _resetReserveFailuresForTests } = run;

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const MIN = 60_000;
const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });

const obs = (stash, o = {}) => ({
    stash, block: 1000, era: 10, session: 60, progress: 0.1, intent: true, elected: true, inSession: true, disabled: false,
    heartbeat: true, blocks: 3, lastSlashEra: 'none', commission: 50_000_000, keys: 'k1', ...o
});

function setup(stash) {
    _resetReserveFailuresForTests();
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-val-stuck-'));
    dirs.push(d);
    db.initDb(d, true);
    const r = db.addValidatorAlertFollow({ email: 'stuck@example.com', stash, subscriberConfirmationToken: 'sc-stuck', subscriberUnsubscribeToken: 'su-stuck',
        confirmationToken: 'c-stuck', unsubscribeToken: 'u-stuck', maxPerEmail: 5 });
    db.confirmValidatorAlertFollow(r.follow.confirmationToken);
}

async function captured(fn) {
    const errs = [], warns = [];
    const e = console.error, w = console.warn;
    console.error = (...a) => errs.push(a.join(' '));
    console.warn = (...a) => warns.push(a.join(' '));
    try { await fn(); } finally { console.error = e; console.warn = w; }
    return { errs, warns };
}

describe('a reserve that fails on every tick does not pin the baseline forever', () => {
    test('the baseline advances after the named number of failed ticks, with one error line (kind and stash only)', async () => {
        const S = addr(93);
        setup(S);
        assert.ok(Number.isInteger(MAX_RESERVE_FAIL_TICKS) && MAX_RESERVE_FAIL_TICKS >= 2);
        const clock = { t: Date.now() };
        let current = obs(S);
        const failingDb = { ...db, reserveValidatorAlert: () => { throw new Error('disk I/O error for stuck@example.com'); } };
        const sent = [];
        const tick = (useDb) => runValidatorAlertsTick({ db: useDb, readObservation: async (s) => ({ ...current, stash: s }), send: async (m) => { sent.push(m); return { providerId: 'p' }; },
            origin: 'https://explorer.example.com', enabled: () => true, nameOf: async () => null, now: () => clock.t });
        await tick(db);                                   // baseline: not disabled
        current = obs(S, { disabled: true });
        const all = { errs: [], warns: [] };
        for (let i = 1; i <= MAX_RESERVE_FAIL_TICKS - 1; i++) {
            clock.t += 5 * MIN;
            const r = await captured(() => tick(failingDb));
            all.errs.push(...r.errs); all.warns.push(...r.warns);
            assert.equal(db.getKv(OBS_KEY(S)).obs.disabled, false, `tick ${i}: the baseline is still the old one`);
        }
        assert.equal(all.errs.length, 0, 'no error line before the bound');
        clock.t += 5 * MIN;
        const last = await captured(() => tick(failingDb));
        assert.equal(db.getKv(OBS_KEY(S)).obs.disabled, true, 'the baseline moved on at the bound');
        assert.equal(last.errs.length, 1, last.errs.join('\n'));
        assert.match(last.errs[0], /disabled/);
        assert.ok(last.errs[0].includes(S));
        assert.ok(!/@/.test(last.errs[0]), 'no email address in the error line');
        // The tick after that sees nothing new and is quiet.
        clock.t += 5 * MIN;
        const after1 = await captured(() => tick(failingDb));
        assert.equal(after1.errs.length, 0); assert.equal(after1.warns.length, 0);
        assert.equal(sent.length, 0, 'nothing was reserved, so nothing was mailed');
    });

    test('a tick that reserves fine resets the count, so only CONSECUTIVE failures count', async () => {
        const S = addr(94);
        setup(S);
        const clock = { t: Date.now() };
        let current = obs(S);
        const failingDb = { ...db, reserveValidatorAlert: () => { throw new Error('boom'); } };
        const tick = (useDb) => runValidatorAlertsTick({ db: useDb, readObservation: async (s) => ({ ...current, stash: s }), send: async () => ({ providerId: 'p' }),
            origin: 'https://explorer.example.com', enabled: () => true, nameOf: async () => null, now: () => clock.t });
        await tick(db);
        current = obs(S, { disabled: true });
        for (let i = 0; i < MAX_RESERVE_FAIL_TICKS - 1; i++) { clock.t += 5 * MIN; await captured(() => tick(failingDb)); }
        // one good tick reserves the alert and moves the baseline
        clock.t += 5 * MIN;
        await captured(() => tick(db));
        assert.equal(db.getKv(OBS_KEY(S)).obs.disabled, true);
        // a new problem, failing again: the count starts from zero, so one more failure is not the bound
        current = obs(S, { disabled: true, elected: false });
        clock.t += 5 * MIN;
        const r = await captured(() => tick(failingDb));
        assert.equal(r.errs.length, 0, r.errs.join('\n'));
        assert.equal(db.getKv(OBS_KEY(S)).obs.elected, true, 'baseline still pinned after one failure');
    });
});
