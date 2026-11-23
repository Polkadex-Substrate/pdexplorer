// Locked balances redesign, work package 2: the self-updating panel on the R2 core
// (designer spec cto-team/plans/2026-11-22-locked-balances-redesign.md, sections 4.5, 5 and 6, and section 7
// tests 13 to 22; timings and strings lib/refresh-ui.js).
//
// The real view (lib/balance-locks-view.js) in happy-dom, the real post-action core (lib/post-action.js with
// lib/action-effects.js, lib/known-results.js and lib/freshness.js), and a fake submit that walks a
// transaction the way script.js submitSignedTx does (observe, show, stage, onSuccess). One manual clock drives
// the core and the view. Addresses are made-up (0x11..11 and 0x22..22).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { describeAccountLocks } from '../lib/balance-locks.js';
import { mountBalanceLocks } from '../lib/balance-locks-view.js';
import { diffRows, focusAfterLeave, rowMessage, LOCK_COPY } from '../lib/lock-rows.js';
import { createPostAction } from '../lib/post-action.js';
import { createKnownResults } from '../lib/known-results.js';
import { effectsFor } from '../lib/action-effects.js';
import { caughtUp, pollDeadlineMs } from '../lib/freshness.js';
import { readRepo, stripComments } from './helpers/source.js';
import { parseRules } from './helpers/css-rules.js';

const PDEX = 10n ** 12n;
const s = (v) => v.toString();
const P = (x) => BigInt(Math.round(x * 1e4)) * 10n ** 8n;
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const ME = 'esm9mgCefMrQ2EbGGyMNXGAFA3vnRGDid7GheURpcFRTjyokX';
const OTHER = 'esmY9ZU5xPLb8urxWNBq89tPvEAG3CZm4KboeysfVgQuEw1io';
const same = (a, b) => String(a) === String(b);
const OK_EVENTS = [{ event: { section: 'system', method: 'ExtrinsicSuccess', data: [] } }];

function snap(over = {}) {
    return {
        address: ME, now: NOW, free: s(20_000n * PDEX), reserved: '0', frozen: '0', ed: s(PDEX),
        block: 1_000_000, blockMs: 12000, bondingDays: 28, eraMs: DAY,
        locks: [], freezes: [], holds: [], reserves: [],
        staking: { bonded: false, total: '0', active: '0', unlocking: '0', chunks: [], currentEra: null, activeEra: null, activeEraStart: null, spans: 0, controller: null, stash: null },
        democracy: null, elections: null, identity: null, proxy: null, pallets: { vesting: false, ormlVesting: false }, ...over
    };
}
const lock = (id, amount) => ({ id, amount: s(amount), reasons: 'All' });
const bonded = (total, chunks) => ({ bonded: true, total: s(total), active: s(total), unlocking: '0', chunks, currentEra: 120, activeEra: 120, activeEraStart: NOW, spans: 0, controller: ME, stash: ME });
const at = (head, over) => ({ address: ME, ...describeAccountLocks(snap(over)), freshness: { v: 1, chainHead: head } });
const STAKE = { holds: [{ id: 'Staking.Staking', amount: s(5_000n * PDEX) }], staking: bonded(5_000n * PDEX, [{ value: s(P(280.0586)), era: 144 }]) };
// The CEO's account before and after Remove council vote.
const CEO = (head = 41, over = {}) => at(head, { ...STAKE, reserved: s(5_000n * PDEX + P(13.59)), frozen: s(15_000n * PDEX), locks: [lock('phrelect', 15_000n * PDEX)],
    elections: { voter: { votes: 5, stake: s(15_000n * PDEX), deposit: s(P(13.59)) }, candidacy: null }, ...over });
const CEO_AFTER = (head = 42) => at(head, { ...STAKE, reserved: s(5_000n * PDEX) });
const ORPHAN = (head = 41) => at(head, { locks: [lock('staking ', 60n * PDEX)], frozen: s(60n * PDEX) });
const ORPHAN_GONE = (head = 42) => at(head, {});

// A manual clock for the core and the view.
function makeClock() {
    let t = 0, seq = 0;
    const timers = new Map();
    return {
        now: () => t,
        set: (f, ms) => { const id = ++seq; timers.set(id, { at: t + Math.max(0, Number(ms) || 0), f }); return id; },
        clear: (id) => { timers.delete(id); },
        async advance(ms) {
            const end = t + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]);
                t = due[1].at;
                due[1].f();
                await flush();
            }
            t = end;
            await flush();
        }
    };
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

// A page: the slot, the core, the server answers (a queue; the last one repeats), a fake submit.
async function page({ models, page: where = 'wallet', connected = ME, reduced = false, api = () => ({}), submit = null, core = true } = {}) {
    const w = new Window({ url: 'https://explorer.test/wallet' });
    const doc = w.document;
    doc.body.innerHTML = '<main><div id="slot"></div></main>';
    const el = doc.getElementById('slot');
    const clock = makeClock();
    const queue = models.slice();
    const reads = [];
    let gate = null;
    const fetchJson = async (url, o) => {
        reads.push([url, o]);
        if (gate) await gate.promise;
        const m = queue.length > 1 ? queue.shift() : queue[0];
        if (m instanceof Error) throw m;
        return m;
    };
    const known = createKnownResults({ storage: null, now: clock.now });
    const post = core ? createPostAction({ effects: effectsFor, known, same, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, caughtUp, deadlineMs: pollDeadlineMs }) : null;
    const subs = [];
    const spy = post ? { ...post, subscribe: (d, sub) => { subs.push(sub); return post.subscribe(d, sub); } } : null;
    const jobs = [];
    const defaultSubmit = async (o) => {
        const seen = post.observe({ key: o.action.key, params: o.action.params });
        const show = seen.show((a, st) => ({ stage: st, outcome: { ok: true } }));
        const stage = seen.stage(o.onStage);
        const job = {
            o,
            async inBlock(block) {
                show({}, 'inBlock', OK_EVENTS, null, { blockNumber: block, txHash: '0x' + 'ab'.repeat(32), address: connected });
                stage('inBlock', { stage: 'inBlock', outcome: { ok: true } });
                await o.onSuccess();
                await flush();
            }
        };
        jobs.push(job);
    };
    const opts = { fetchJson, helpIcon: () => '', page: where, post: spy, unstake: () => true, openUnstake: () => {},
        now: clock.now, setTimer: clock.set, clearTimer: clock.clear, reducedMotion: () => reduced,
        actions: { submit: submit || defaultSubmit, connected: () => connected, isSame: same, api } };
    await mountBalanceLocks(el, ME, opts);
    await flush();
    const row = (name) => Array.from(el.querySelectorAll('li.lock-row')).find(li => text(li.querySelector('.lock-name')) === name) || null;
    const press = async (sel) => {
        el.querySelector(sel).click();
        const yes = el.querySelector('.lock-confirm .ui-action');
        if (yes) { yes.focus(); yes.click(); }
        await flush();
    };
    const hold = () => { let r; const p = new Promise(x => { r = x; }); gate = { promise: p }; return () => { gate = null; r(); }; };
    return { w, doc, el, clock, reads, jobs, subs, post, known, opts, row, press, hold, models: queue, remount: () => mountBalanceLocks(el, ME, opts) };
}

describe('pure parts: diffRows, focusAfterLeave, rowMessage', () => {
    test('diffRows: leave, enter and stay, in order', () => {
        assert.deepEqual(diffRows(['a', 'b', 'c'], ['b', 'd', 'c']), { leave: ['a'], enter: ['d'], stay: ['b', 'c'] });
        assert.deepEqual(diffRows([], ['x']), { leave: [], enter: ['x'], stay: [] });
    });
    test('focusAfterLeave: the next row\'s action, else the previous, else the heading (null)', () => {
        assert.equal(focusAfterLeave(['a', 'b', 'c'], 'b'), 'c');
        assert.equal(focusAfterLeave(['a', 'b', 'c'], 'c'), 'b');
        assert.ok(focusAfterLeave(['a'], 'a') == null);
    });
    test('rowMessage: M2 to M12 by stage, verbatim, each an icon and a role', () => {
        const row = { amount: s(10n * PDEX), date: '2026-12-01' };
        const m = (k, st, o) => { const x = rowMessage(k, st, o); return x && [x.id, x.role, x.icon, x.text]; };
        assert.deepEqual(m('democracy-unlock', 'done', { block: 42, row }), ['M2', 'positive', 'bx-check-circle', 'Unlocked in block #42. 10 PDEX stays locked until about 2026-12-01.']);
        assert.deepEqual(m('democracy-unlock', 'done', { block: 42, row, unlock: false }), ['M3', 'positive', 'bx-check-circle', 'Finished votes removed in block #42. The lock stays until about 2026-12-01.']);
        assert.deepEqual(m('democracy-cancel', 'done', { block: 42, row, ref: '9' }), ['M4', 'positive', 'bx-check-circle', 'Vote on referendum #9 cancelled in block #42.']);
        assert.deepEqual(m('democracy-undelegate', 'done', { block: 42, row }), ['M5', 'positive', 'bx-check-circle', 'Undelegated in block #42.']);
        assert.ok(rowMessage('elections-remove', 'done', { block: 42, row: null }) == null, 'a released row settles with S8, no message');
        assert.deepEqual(m('migrate-currency', 'check-ok', { text: 'The leftover staking lock is gone. The PDEX it held is transferable again.' }), ['M6', 'positive', 'bx-check-circle', 'The leftover staking lock is gone. The PDEX it held is transferable again.']);
        assert.deepEqual(m('migrate-currency', 'check-bad', { text: 'x' }), ['M7', 'wait', 'bx-error', 'x']);
        assert.deepEqual(m('withdraw', 'reread-failed'), ['M8', 'wait', 'bx-error', 'Included in a block, but this section could not be re-read.']);
        assert.deepEqual(m('withdraw', 'unconfirmed'), ['M9', 'wait', 'bx-time-five', 'Sent, but not confirmed yet. The status card is tracking it. Do not send it again until this section updates.']);
        assert.deepEqual(m('withdraw', 'multisig', { text: 'Approval submitted; waiting for the other signers.' }), ['M10', 'info', 'bx-info-circle', 'Approval submitted; waiting for the other signers.']);
        assert.deepEqual(m('democracy-unlock', 'refused', { text: 'Your votes or locks changed since this page loaded. Reload to see the safe options.' }), ['M11', 'wait', 'bx-error', 'Your votes or locks changed since this page loaded. Reload to see the safe options.']);
        assert.equal(rowMessage('democracy-unlock', 'refused', { text: 'Reload to see.' }).reload, true, 'S12 beside a refusal that says reload');
        assert.deepEqual(m('withdraw', 'failed', { text: 'Nope.' }), ['M12', 'error', 'bx-error-circle', 'Nope.']);
        assert.equal(rowMessage('withdraw', 'failed', { text: 'Nope.' }).alert, true);
    });
});

describe('(13) a re-read keeps the painted panel and the nodes of unchanged rows', () => {
    test('first load: two static bars, aria-busy, the loading words for screen readers only', async () => {
        const w = new Window();
        w.document.body.innerHTML = '<div id="slot"></div>';
        const el = w.document.getElementById('slot');
        let go;
        const p = mountBalanceLocks(el, OTHER, { fetchJson: () => new Promise(r => { go = r; }), helpIcon: () => '' });
        const card = el.querySelector('section.balance-locks');
        assert.ok(card, 'the card is drawn at once');
        assert.equal(card.getAttribute('aria-busy'), 'true');
        assert.equal(el.querySelectorAll('.lock-skeleton span').length, 2);
        assert.equal(text(el.querySelector('.sr-only')), 'Loading the balance breakdown');
        const shown = el.cloneNode(true);
        for (const x of shown.querySelectorAll('.sr-only')) x.remove();
        assert.doesNotMatch(text(shown), /Loading/);
        go(CEO());
        await p;
        assert.equal(el.querySelector('section.balance-locks').hasAttribute('aria-busy'), false);
    });
    test('a second mount with content present never writes the loading words; unchanged rows keep their nodes', async () => {
        const pg = await page({ models: [CEO()] });
        const council = pg.row('Council vote'), unstaking = pg.row('Unstaking');
        const card = pg.el.querySelector('section.balance-locks');
        pg.models.length = 0;
        pg.models.push(CEO(41, { holds: [{ id: 'Staking.Staking', amount: s(5_100n * PDEX) }], staking: bonded(5_100n * PDEX, [{ value: s(P(280.0586)), era: 144 }]) }));
        const open = pg.hold();
        const again = pg.remount();
        await flush();
        assert.doesNotMatch(pg.el.textContent, /Loading the balance breakdown/);
        assert.ok(pg.el.querySelector('.lock-skeleton') == null);
        assert.ok(pg.el.querySelector('section.balance-locks') === card, 'the card stays');
        open();
        await again;
        await flush();
        assert.ok(pg.row('Council vote') === council, 'unchanged row: same node');
        assert.ok(pg.row('Unstaking') === unstaking, 'unchanged row: same node');
        assert.equal(text(pg.row('Staked').querySelector('.lock-amount')), '4,819.9414 PDEX', 'the changed row repainted');
        assert.ok(pg.row('Staked').querySelector('.lock-amount').classList.contains('is-value-changed'), 'with the wash');
    });
});

describe('(14) "Updating" only after T1, then for at least T2', () => {
    test('a quick re-read shows nothing; a slow one shows the chip at 600 ms and keeps it 900 ms', async () => {
        const pg = await page({ models: [CEO()] });
        const chip = () => pg.el.querySelector('.list-header .ui-chip.is-wait.lock-updating');
        let open = pg.hold();
        let again = pg.remount();
        await pg.clock.advance(500);
        assert.ok(chip() == null, 'nothing under 600 ms');
        open(); await again; await pg.clock.advance(1000);
        assert.ok(chip() == null, 'never shown');
        open = pg.hold();
        again = pg.remount();
        await pg.clock.advance(600);
        assert.ok(chip(), 'shown at 600 ms');
        assert.equal(text(chip()), 'Updating');
        assert.ok(chip().querySelector('.bx'));
        await pg.clock.advance(100);
        open(); await again; await flush();
        await pg.clock.advance(799);
        assert.ok(chip(), 'still there before 900 ms');
        await pg.clock.advance(1);
        assert.ok(chip() == null, 'gone at 900 ms');
        assert.equal(text(pg.el.querySelector('.lock-actions-msg')), '', 'nothing announced when Updating appears');
    });
});

describe('(15) a released row settles: Released in block #N for T3, then gone with its children', () => {
    test('this tab: S8, the hold, the collapse, then gone; the summary recomputed', async () => {
        const pg = await page({ models: [CEO(), CEO_AFTER()] });
        await pg.press('[data-lock-action="elections-remove"]');
        assert.equal(pg.jobs.length, 1);
        await pg.jobs[0].inBlock(42);
        const council = pg.row('Council vote');
        assert.ok(council, 'held on screen');
        const chip = council.querySelector('.lock-row-top > .ui-chip');
        assert.equal(text(chip), 'Released in block #42');
        assert.ok(chip.classList.contains('is-positive') && chip.querySelector('.bx-check'));
        assert.ok(council.querySelector('.lock-child'), 'its deposit with it');
        assert.ok(council.querySelector('.ui-action') == null, 'no action on a settled row');
        await pg.clock.advance(1599);
        assert.ok(pg.row('Council vote') && !pg.row('Council vote').classList.contains('is-leaving'));
        await pg.clock.advance(1);
        assert.ok(pg.row('Council vote').classList.contains('is-leaving'), 'collapses after T3');
        await pg.clock.advance(240);
        assert.ok(pg.row('Council vote') == null, 'gone after T4');
        assert.doesNotMatch(pg.el.textContent, /Voting deposit/);
        assert.match(text(pg.el.querySelector('.lock-summary')), /Next: 280\.0586 PDEX/);
        assert.equal(pg.reads.filter(r => /\?fresh=1$/.test(r[0])).length >= 1, true, 'the core re-read it fresh');
    });
    test('another tab\'s action: the row goes at once, nothing announced', async () => {
        const pg = await page({ models: [CEO(), CEO_AFTER()] });
        assert.ok(pg.subs.length, 'the panel subscribed to the core');
        await pg.subs[0].reload({ block: null, fresh: true, reason: 'other-tab', origin: 'other-tab' });
        await flush();
        assert.ok(pg.row('Council vote') == null);
        assert.equal(text(pg.el.querySelector('.lock-actions-msg')), '');
    });
});

describe('(16) the message is inside the pressed row and survives a repaint', () => {
    test('a failure: M12 in the row, an alert; a repaint keeps it; the next press clears it', async () => {
        const pg = await page({ models: [CEO()], submit: async (o) => { o.onError('Nope.'); } });
        await pg.press('[data-lock-action="elections-remove"]');
        const msg = () => pg.row('Council vote').querySelector('.lock-row-msg');
        assert.equal(text(msg()), 'Nope.');
        assert.equal(msg().getAttribute('role'), 'alert');
        assert.ok(msg().querySelector('.bx-error-circle'));
        assert.equal(pg.el.querySelectorAll('.lock-row-msg').length, 1, 'one message, in that row only');
        await pg.remount();
        await flush();
        assert.equal(text(msg()), 'Nope.', 'a repaint never wipes it');
        pg.row('Council vote').querySelector('[data-lock-action]').click();
        assert.ok(msg() == null, 'the next press on the row clears it');
    });
    test('a refusal before the wallet opens (tx-submit\'s pre-flight): M11 verbatim in the row, amber, with Reload this section', async () => {
        const STALE = 'Your votes or locks changed since this page loaded. Reload to see the safe options.';
        const pg = await page({ models: [CEO()], submit: async (o) => { o.onError(STALE, { stage: 'failed', key: 'preflight', text: STALE }); } });
        await pg.press('[data-lock-action="elections-remove"]');
        const msg = pg.row('Council vote').querySelector('.lock-row-msg');
        assert.ok(msg, 'a message in the row');
        assert.equal(text(msg.querySelector('span')), STALE);
        assert.ok(msg.classList.contains('is-wait') && msg.querySelector('.bx-error'));
        assert.ok(msg.getAttribute('role') == null, 'not an alert: nothing was sent');
        assert.equal(text(msg.querySelector('button.validate-secondary')), 'Reload this section');
    });
    test('not confirmed: M9 in the row', async () => {
        const pg = await page({ models: [ORPHAN()], connected: OTHER, submit: async (o) => { o.onStage('unconfirmed'); } });
        await pg.press('[data-lock-action="migrate-currency"]');
        assert.equal(text(pg.row('Leftover staking lock').querySelector('.lock-row-msg')), 'Sent, but not confirmed yet. The status card is tracking it. Do not send it again until this section updates.');
    });
});

describe('(17) focus: never on a replaced node', () => {
    test('the released row had focus: it goes to the next row\'s action', async () => {
        const pg = await page({ models: [CEO(), CEO_AFTER()] });
        await pg.press('[data-lock-action="elections-remove"]');
        assert.equal(pg.doc.activeElement && pg.doc.activeElement.getAttribute('data-lock-action'), 'elections-remove');
        await pg.jobs[0].inBlock(42);
        await pg.clock.advance(1840);
        assert.ok(pg.doc.activeElement === pg.row('Staked').querySelector('.ui-action'), 'the next row\'s action (Unstake PDEX)');
    });
    test('the last row with an action leaves: focus on the heading', async () => {
        const pg = await page({ models: [ORPHAN(), ORPHAN_GONE()], connected: OTHER, api: () => ({ query: { balances: { locks: async () => [] } } }) });
        await pg.press('[data-lock-action="migrate-currency"]');
        pg.el.querySelector('[data-lock-action="migrate-currency"]').focus();
        await pg.jobs[0].inBlock(42);
        await pg.clock.advance(1840);
        assert.ok(pg.row('Leftover staking lock') == null);
        assert.ok(pg.doc.activeElement === pg.el.querySelector('#balance-locks-h'));
        assert.equal(text(pg.el.querySelector('.lock-empty')), 'Nothing is locked or reserved on this account.');
    });
});

describe('(18) the live region: one message per 5 s; M12 is the only alert', () => {
    test('a released row is announced; a later message waits for T7', async () => {
        const pg = await page({ models: [CEO(), CEO_AFTER()] });
        const live = pg.el.querySelector('.lock-actions-msg');
        assert.equal(live.getAttribute('aria-live'), 'polite');
        assert.equal(live.getAttribute('aria-atomic'), 'true');
        assert.ok(live.classList.contains('sr-only'));
        await pg.press('[data-lock-action="elections-remove"]');
        await pg.jobs[0].inBlock(42);
        assert.equal(text(pg.el.querySelector('.lock-actions-msg')), 'Council vote, 15,000 PDEX: released in block #42.');
        pg.models.length = 0;
        pg.models.push(new Error('down'));
        await pg.remount();
        await flush();
        assert.equal(text(pg.el.querySelector('.lock-actions-msg')), 'Council vote, 15,000 PDEX: released in block #42.', 'not within 5 s');
        await pg.clock.advance(5000);
        assert.equal(text(pg.el.querySelector('.lock-actions-msg')), 'Balance breakdown could not be refreshed. Use Reload this section.');
        assert.equal(pg.el.querySelectorAll('[role="alert"]').length, 0);
    });
});

describe('(19) the leftover lock: Checking until the chain check, then Released with the check\'s words, or the warning', () => {
    test('lock gone: Checking, then S8 and M6', async () => {
        let answer;
        const pg = await page({ models: [ORPHAN(), ORPHAN_GONE()], connected: OTHER, api: () => ({ query: { balances: { locks: () => new Promise(r => { answer = r; }) } } }) });
        await pg.press('[data-lock-action="migrate-currency"]');
        const done = pg.jobs[0].inBlock(42);
        await flush();
        const chip = pg.row('Leftover staking lock').querySelector('.lock-row-top > .ui-chip');
        assert.equal(text(chip), 'Checking');
        assert.ok(chip.classList.contains('is-wait') && chip.classList.contains('is-bare'));
        answer([]);
        await done;
        await flush();
        const row = pg.row('Leftover staking lock');
        assert.equal(text(row.querySelector('.lock-row-top > .ui-chip')), 'Released in block #42');
        assert.equal(text(row.querySelector('.lock-row-msg')), 'The leftover staking lock is gone. The PDEX it held is transferable again.');
    });
    test('lock still there: the check\'s warning in the row, amber, verbatim', async () => {
        const pg = await page({ models: [ORPHAN(), ORPHAN(42)], connected: OTHER, api: () => ({ query: { balances: { locks: async () => [{ id: 'staking ' }] } } }) });
        await pg.press('[data-lock-action="migrate-currency"]');
        await pg.jobs[0].inBlock(42);
        await flush();
        const msg = pg.row('Leftover staking lock').querySelector('.lock-row-msg');
        assert.equal(text(msg), 'The transaction was included, but the staking lock is still there. Refresh in a minute; if it stays, contact the Polkadex team.');
        assert.ok(msg.classList.contains('is-wait') && msg.querySelector('.bx-error'));
        assert.notEqual(text(pg.row('Leftover staking lock').querySelector('.lock-row-top > .ui-chip')), 'Checking');
    });
});

describe('(20) a failed read never looks like "nothing is locked"', () => {
    test('first read failed: X1 and Try again; Try again reads again', async () => {
        const pg = await page({ models: [new Error('down'), CEO()] });
        assert.equal(text(pg.el.querySelector('.lock-failed .ui-panel')), 'The balance breakdown could not be loaded. Your PDEX is not affected.');
        const retry = pg.el.querySelector('.lock-failed button.validate-secondary');
        assert.equal(text(retry), 'Try again');
        assert.doesNotMatch(pg.el.textContent, /Nothing is locked/);
        retry.click();
        await flush();
        assert.ok(pg.row('Council vote'));
    });
    test('a re-read failed: the content stays, S11 and S12 first in the card', async () => {
        const pg = await page({ models: [CEO(), new Error('down')] });
        await pg.remount();
        await flush();
        assert.ok(pg.row('Council vote'), 'content stays');
        const behind = pg.el.querySelector('section.balance-locks > .lock-behind');
        assert.equal(behind.previousElementSibling.className, 'list-header', 'first child after the heading');
        assert.equal(text(behind.querySelector('.ui-panel')), 'This section could not be refreshed. It may be behind the chain.');
        assert.equal(text(behind.querySelector('button')), 'Reload this section');
        assert.doesNotMatch(pg.el.textContent, /Nothing is locked/);
    });
});

describe('(21) no fixed timer: the re-read after an action comes from the core', () => {
    test('nothing re-reads 2.5 s after success; the core\'s inclusion reload reads fresh', async () => {
        let job = null;
        const pg = await page({ models: [CEO(), CEO_AFTER()], submit: async (o) => { job = o; } });
        await pg.press('[data-lock-action="elections-remove"]');
        await job.onSuccess();
        await pg.clock.advance(3000);
        await new Promise(r => setTimeout(r, 2600));
        assert.equal(pg.reads.length, 1, 'no re-read without the core');
        assert.ok(pg.subs.length, 'the panel subscribed to the core');
        await pg.subs[0].reload({ block: 42, fresh: true, reason: 'inBlock', poll: true });
        assert.deepEqual(pg.reads.slice(1).map(r => [r[0], r[1] && r[1].cache]), [[`/api/account/${ME}/locks?fresh=1`, 'no-store']]);
        assert.doesNotMatch(stripComments(readRepo('lib/balance-locks-view.js', import.meta.url)), /2500/);
    });
    test('script.js subscribes both slots to the core', () => {
        const script = stripComments(readRepo('script.js', import.meta.url));
        assert.equal((script.match(/mountBalanceLocks\([^;]*post: postAction/g) || []).length, 2);
        assert.match(script, /mountBalanceLocks\(document\.getElementById\('wallet-locks-slot'\)[\s\S]{0,300}?page: 'wallet'[\s\S]{0,300}?openUnstake: openUnstakeModal \}\);/);
    });
});

describe('(22) reduced motion: no transition, no wash, a still clock for busy', () => {
    test('the settled row leaves after T3 with no collapse class', async () => {
        let job = null;
        const pg = await page({ models: [CEO(), CEO_AFTER()], reduced: true, submit: async (o) => { job = o; } });
        await pg.press('[data-lock-action="elections-remove"]');
        const pressed = pg.el.querySelector('.lock-confirm .ui-action');
        assert.ok(pressed.querySelector('i.bx.bx-time-five'), 'a still icon, no spinner');
        assert.ok(pressed.querySelector('.bx-spin') == null);
        await job.onSuccess();
        assert.ok(pg.subs.length, 'the panel subscribed to the core');
        await pg.subs[0].reload({ block: 42, fresh: true, reason: 'inBlock', poll: true });
        await flush();
        let collapsed = false;
        const obs = setInterval(() => { if (pg.el.querySelector('.is-leaving')) collapsed = true; }, 1);
        await pg.clock.advance(1600);
        clearInterval(obs);
        assert.equal(collapsed, false);
        assert.ok(pg.row('Council vote') == null, 'gone at T3, no T4');
        assert.ok(pg.el.querySelector('.is-value-changed') == null, 'no wash');
    });
});

describe('the stylesheet for the self-updating panel (5, 6)', () => {
    const RULES = parseRules(readRepo('styles.css', import.meta.url));
    const find = (sel, prop, media = null) => { let v; for (const r of RULES) if ((media ? media.test(r.media) : !r.media) && r.selectors.includes(sel) && prop in r.decls) v = r.decls[prop]; return v; };
    test('first-load bars: two static 56 px neutral bars; the row message icons by role; 44 px retry buttons', () => {
        assert.equal(find('.lock-skeleton span', 'height'), '56px');
        assert.equal(find('.lock-skeleton span', 'background'), 'rgba(255, 255, 255, 0.06)');
        assert.equal(find('.lock-skeleton span', 'animation'), undefined, 'static');
        assert.equal(find('.lock-row-msg.is-positive > .bx', 'color'), 'var(--accent-green)');
        assert.equal(find('.lock-row-msg.is-wait > .bx', 'color'), 'var(--accent-amber)');
        assert.equal(find('.lock-row-msg.is-info > .bx', 'color'), 'var(--accent-blue-text)');
        assert.equal(find('.lock-row-msg.is-error > .bx', 'color'), 'var(--accent-red)');
        for (const sel of ['.lock-row-msg .validate-secondary', '.lock-failed .validate-secondary', '.lock-behind .validate-secondary']) assert.equal(find(sel, 'min-height'), '44px', sel);
    });
    test('a leaving row collapses over T4 (240 ms); the amount wash is the shared neutral one; neither moves with reduced motion', () => {
        assert.match(String(find('.lock-row.is-leaving', 'transition')), /max-height 240ms/);
        assert.equal(find('.lock-row.is-leaving', 'transition', /prefers-reduced-motion/), 'none');
        assert.match(String(find('.lock-amount.is-value-changed', 'animation')), /^post-action-wash 1200ms/);
        assert.equal(find('.lock-amount.is-value-changed', 'animation', /prefers-reduced-motion/), 'none');
    });
});
