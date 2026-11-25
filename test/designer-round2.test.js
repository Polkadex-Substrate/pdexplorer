// The designer's second-round findings (F1 to F4, C1, S6, P1, P2), tested on the real stylesheet, the real lock rows, the
// real tooltip strings and the real scenes built by tools/preview-scenes.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { parseRules } from './helpers/css-rules.js';
import { describeAccountLocks } from '../lib/balance-locks.js';
import { renderBalanceLocks } from '../lib/balance-locks-view.js';
import { WHY } from '../lib/stake-filters.js';
import * as plan from '../lib/stake-plan.js';

// An Advanced scene opens a live ApiPromise that keeps this process alive, so those scenes are read in a child that exits.
const ROOT = new URL('..', import.meta.url).pathname;
const inChild = (body) => JSON.parse(execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e',
    `const tool = await import(${JSON.stringify(ROOT + 'tools/preview-scenes.mjs')});
     const t = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : null);
     const out = await (async () => { ${body} })();
     console.log('@@' + JSON.stringify(out)); process.exit(0);`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }).split('@@').pop());

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const RULES = parseRules(CSS);
const ruleFor = (sel, { media = null } = {}) => RULES.find(r => r.selectors.includes(sel) && (media === null ? !r.media : media.test(r.media)));
const M640 = /max-width:\s*640px/;
const CARDS = ['#wsec-recent-tx', '#wsec-rewards', '#wallet-apr-card'];

describe('F1: Claimed Rewards label is laid out like Unpaid Rewards', () => {
    test('#wallet-claimed-label is a flex row with a gap, the same as #wallet-unpaid-label', () => {
        const r = ruleFor('#wallet-claimed-label');
        assert.ok(r, 'no rule for #wallet-claimed-label');
        assert.deepEqual([r.decls.display, r.decls['align-items'], r.decls['justify-content'], r.decls.gap], ['flex', 'center', 'space-between', '8px']);
    });
    test('the bare chip and its icon in the Claimed Rewards label get the unpaid size', () => {
        const chip = ruleFor('#wallet-claimed-label .ui-chip.is-bare');
        const icon = ruleFor('#wallet-claimed-label .ui-chip.is-bare .bx');
        assert.ok(chip && icon, 'no chip or icon rule for #wallet-claimed-label');
        assert.equal(chip.decls['font-size'], '0.72rem');
        assert.equal(icon.decls['font-size'], '14px');
    });
});

describe('F2: the "could not refresh" line is not flush with the card edge', () => {
    const lines = CARDS.map(c => `${c} > .ui-panel.is-line`);
    test('wallet cards: padding 12px 24px 0, and 12px 16px 0 at 640px', () => {
        for (const sel of lines) {
            assert.equal((ruleFor(sel) || { decls: {} }).decls.padding, '12px 24px 0', sel);
            assert.equal((ruleFor(sel, { media: M640 }) || { decls: {} }).decls.padding, '12px 16px 0', `${sel} at 640px`);
        }
    });
    test('council, democracy, treasury and validator status cards host the same line and get the same padding', () => {
        const hosts = ['.council-page .list-container', '#democracy-content .list-container', '#treasury-content .list-container', '.validate-dash'].map(c => `${c} > .ui-panel.is-line`);
        for (const sel of hosts) {
            assert.equal((ruleFor(sel) || { decls: {} }).decls.padding, '12px 24px 0', sel);
            assert.equal((ruleFor(sel, { media: M640 }) || { decls: {} }).decls.padding, '12px 16px 0', `${sel} at 640px`);
        }
    });
});

describe('F4: the card header wraps at 640px so "Updating" and the range buttons do not overflow at 375', () => {
    test('.list-header wraps with gap 8px 12px, and its h2 wraps', () => {
        const head = CARDS.map(c => `${c} .list-header`);
        const h2 = CARDS.map(c => `${c} .list-header h2`);
        for (const sel of head) {
            const r = ruleFor(sel, { media: M640 });
            assert.ok(r, `${sel} has no rule at 640px`);
            assert.equal(r.decls['flex-wrap'], 'wrap', sel);
            assert.equal(r.decls.gap, '8px 12px', sel);
        }
        for (const sel of h2) assert.equal((ruleFor(sel, { media: M640 }) || { decls: {} }).decls['flex-wrap'], 'wrap', sel);
    });
});

// ── F3: the Staked row never contradicts its Details ──
const PDEX = 10n ** 12n;
const P = (x) => BigInt(Math.round(x * 1e4)) * 10n ** 8n;
const ME = 'esm9mgCefMrQ2EbGGyMNXGAFA3vnRGDid7GheURpcFRTjyokX';
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const sv = (v) => v.toString();
const snap = (over) => ({ address: ME, now: NOW, free: sv(5000n * PDEX), reserved: '0', frozen: '0', ed: sv(PDEX), block: 1_000_000, blockMs: 12000, bondingDays: 28, eraMs: 86400000,
    locks: [], freezes: [], holds: [], reserves: [], democracy: null, elections: null, identity: null, proxy: null, pallets: { vesting: false, ormlVesting: false }, ...over });
const ledger = (total, chunks) => ({ bonded: true, total: sv(total), active: sv(total - chunks.reduce((a, c) => a + BigInt(c.value), 0n)), unlocking: '0', chunks,
    currentEra: 120, activeEra: 120, activeEraStart: NOW, spans: 0, controller: ME, stash: ME });
const stakedDetails = (chunks) => {
    const total = 1000n * PDEX;
    const m = { address: ME, ...describeAccountLocks(snap({ reserved: sv(total), holds: [{ id: 'Staking.Staking', amount: sv(total) }], staking: ledger(total, chunks) })) };
    const w = new Window(); w.document.body.innerHTML = renderBalanceLocks(m, { helpIcon: () => '', canSign: true, connected: ME, page: 'wallet', unstake: true, now: NOW });
    const rows = Array.from(w.document.querySelectorAll('.lock-row'));
    const row = rows.find(r => r.querySelector('.lock-name').textContent.trim() === 'Staked');
    assert.ok(row, 'a Staked row');
    return Array.from(row.querySelectorAll('.lock-details > p')).map(p => p.textContent.replace(/\s+/g, ' ').trim());
};
describe('F3: a Staked row beside a ready-to-withdraw row says how the parts add up', () => {
    test('staked, unstaking and ready: the three-part sentence', () => {
        const d = stakedDetails([{ value: sv(150n * PDEX), era: 110 }, { value: sv(P(280.0586)), era: 144 }]);
        assert.ok(d.includes('Of 1,000 PDEX in staking, 569.9414 is staked, 280.0586 is unstaking and 150 is ready to withdraw.'), JSON.stringify(d));
        assert.ok(!d.some(t => /1,000 PDEX bonded/.test(t)), 'the bonded total stated as if it were this row');
    });
    test('staked and ready only: the two-part sentence', () => {
        const d = stakedDetails([{ value: sv(150n * PDEX), era: 110 }]);
        assert.ok(d.includes('Of 1,000 PDEX in staking, 850 is staked and 150 is ready to withdraw.'), JSON.stringify(d));
        assert.ok(!d.some(t => /1,000 PDEX bonded/.test(t)));
    });
    test('staked and unstaking only keeps its sentence', () => {
        const d = stakedDetails([{ value: sv(150n * PDEX), era: 144 }]);
        assert.ok(d.includes('Of 1,000 PDEX in staking, 850 is staked and 150 is unstaking.'), JSON.stringify(d));
    });
    test('scene locks-ready-withdraw: 569.9414 staked is never shown against "1,000 PDEX bonded" without the split', async () => {
        const w = await (await import('../tools/preview-scenes.mjs')).sceneWorld('locks', 'ready-withdraw');
        const row = Array.from(w.doc.querySelectorAll('.lock-row')).find(r => /569\.9414 PDEX/.test(r.querySelector('.lock-amount').textContent));
        assert.ok(row, 'the Staked row with 569.9414 PDEX');
        const text = row.querySelector('.lock-details').textContent.replace(/\s+/g, ' ');
        assert.match(text, /Of 1,000 PDEX in staking, 569\.9414 is staked, 280\.0586 is unstaking and 150 is ready to withdraw\./);
    });
});

describe('C1: validator tooltips say "stakers" and "Pay Out"', () => {
    test('the five strings, verbatim', () => {
        assert.equal(WHY.noRecentRaise, 'Some validators lower commission to attract stakers, then raise it. A recent or pending raise is a warning sign.');
        assert.equal(WHY.notBlocked, 'A validator can stop accepting new stake. If you pick one that has, your stake with it will not count.');
        assert.equal(WHY.reliability, 'Era points measure blocks produced. A validator far below the median, or with zero points, earned less for its stakers.');
        assert.equal(WHY.singlePage, 'Every staker is paid, but more than 256 stakers splits payouts into pages and each page needs its own Pay Out.');
        assert.equal(WHY.noSlash, 'A slash is a penalty for misbehaviour that also takes from stakers. A recent one can be a sign of operational trouble.');
    });
    test('no tooltip still says nominator, nomination or backer', () => {
        for (const [k, v] of Object.entries(WHY)) assert.doesNotMatch(v, /nominat|backer/i, k);
    });
});

// ── S6: grouped for the eye only ──
describe('S6: thousands separators on display figures, never on what is typed, filled or parsed', () => {
    const world = async (id) => (await import('../tools/preview-scenes.mjs')).sceneWorld('stake', id);
    const t = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    test('the helper groups the integer part of planckToPdexText output only', () => {
        assert.equal(typeof plan.groupPdexText, 'function', 'lib/stake-plan.js exports groupPdexText');
        assert.equal(plan.groupPdexText('1203.35'), '1,203.35');
        assert.equal(plan.groupPdexText('1234567'), '1,234,567');
        assert.equal(plan.groupPdexText('999.12345'), '999.12345');
        assert.equal(plan.groupPdexText('0.5'), '0.5');
        assert.equal(plan.groupPdexText('-1500.25'), '-1,500.25');
        assert.equal(plan.planckToPdexText(1203350000000000n), '1203.35', 'planckToPdexText itself stays plain');
    });
    test('a grouped string is never parsed into an amount', () => {
        assert.equal(plan.parseAmountPlanck('1,203.35'), null);
        assert.equal(plan.parseAmountPlanck('1203.35'), 1203350000000000n);
    });
    test('SC-04 is grouped, and Max still puts the ungrouped value in the field', async () => {
        const w = await world('stake-simple-first-empty');
        assert.equal(t(w.q('[data-sc="SC-04"]')), 'You can stake up to 1,203.35 PDEX.');
        w.q('#stake-max-btn').click();
        assert.equal(w.q('#stake-amount-input').value, '1203.35');
        const over = await world('stake-simple-over-limit');
        over.q('[data-stake-action="use-max"]').click();
        assert.equal(over.q('#stake-amount-input').value, '1203.35', 'the "use the most" offer also fills the plain value');
    });
    test('a typed amount is stated grouped in "What happens", and the field keeps what was typed', async () => {
        const w = await world('stake-simple-low-reserve');
        assert.equal(w.q('#stake-amount-input').value, '1203.45');
        assert.match(w.q('#stake-modal').textContent.replace(/\s+/g, ' '), /You stake 1,203\.45 PDEX\. It is locked while staked\./);
    });
    test('typing a grouped number signs and states nothing', async () => {
        const w = await world('stake-simple-first-empty');
        w.type('1,203.35');
        assert.equal(w.q('#stake-amount-input').value, '1,203.35');
        assert.doesNotMatch(w.q('#stake-modal').textContent, /You stake/);
    });
    test('Advanced figures: Currently staked, You can stake up to, and the review line are grouped', async () => {
        const r = inChild(`
            const a = await tool.sceneWorld('stake', 'stake-advanced-existing-unchanged');
            const b = await tool.sceneWorld('stake', 'stake-advanced-first');
            b.type('1203.45');
            return { current: t(a.q('#stake-current')), max: t(b.q('#stake-max-figure')), field: b.q('#stake-amount-input').value, review: t(b.q('.stake-plan-lines')) };`);
        assert.equal(r.current, '1,150 PDEX');
        assert.equal(r.max, '1,203.35 PDEX');
        assert.equal(r.field, '1203.45');
        assert.match(r.review, /Stake 1,203\.45 PDEX/);
    });
});

// ── P1, P2: the scene tool ──
describe('P1 and P2: the preview scenes', () => {
    const world = async (id) => (await import('../tools/preview-scenes.mjs')).sceneWorld('stake', id);
    const t = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    test('P1: stake-advanced-list-failed draws the list line the app draws, with "Try again"', async () => {
        const r = inChild(`
            const w = await tool.sceneWorld('stake', 'stake-advanced-list-failed');
            const box = w.q('#stake-validator-list .stake-empty');
            return { box: !!box, msg: box && t(box.querySelector('[data-sc="SC-112"]')), btn: box && t(box.querySelector('button[data-stake-action="retry"][data-sc="SC-113"]')) };`);
        assert.ok(r.box, 'the failed list line');
        assert.equal(r.msg, 'Could not load the validator list.');
        assert.equal(r.btn, 'Try again');
    });
    test('P2: stake-simple-bonded-unknown shows SC-109b under the primary and SC-109c in the figure slot', async () => {
        const w = await world('stake-simple-bonded-unknown');
        assert.ok(t(w.q('#stake-modal')).includes(plan.STAKE_COPY['SC-109b']));
        assert.ok(w.q('[data-sc="SC-109b"]'), 'SC-109b is marked');
        assert.equal(t(w.q('#stake-current')), 'Could not be read');
    });
    test('P2: stake-simple-account-changed shows SC-39b', async () => {
        const w = await world('stake-simple-account-changed');
        assert.equal(t(w.q('[data-sc="SC-39b"]')), plan.STAKE_COPY['SC-39b']);
    });
    test('P2: stake-simple-rewards-pending shows SC-14f', async () => {
        const w = await world('stake-simple-rewards-pending');
        assert.equal(t(w.q('[data-sc="SC-14f"]')), plan.STAKE_COPY['SC-14f']);
    });
    test('P2: each new scene is written at 1280 and 375', () => {
        const out = mkdtempSync(join(tmpdir(), 'pdx-scenes-'));
        for (const id of ['stake-simple-bonded-unknown', 'stake-simple-account-changed', 'stake-simple-rewards-pending']) {
            execFileSync(process.execPath, ['--experimental-sqlite', 'tools/preview-scenes.mjs', '--out', out, '--scene', id], { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
            for (const w of [1280, 375]) assert.ok(existsSync(join(out, `${id}-${w}.html`)), `${id}-${w}.html`);
        }
    });
});
