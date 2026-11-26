// Sprint 11 site sweep, WP2 (cto-team/plans/2026-11-26-sprint11-site-sweep.md, 2.2 P4 to P6, P9, 2.3 rows I14, I17 to I19, I41
// to I43, 7 S3, and 6.2 T12): the parts of lib/ and the helpers of script.js that the pages are built from, called as they
// are in the page, and the chart colours read from the stylesheet's tokens at draw time. Rendered markup, not text scans of
// the sources (statusBadge is lifted out of script.js and run, as test/account-transfers.test.js does, because script.js has
// no export surface).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { escapeHtml } from '../lib/html-escape.js';
import { chipHtml } from '../lib/ui-parts.js';
import { transferValueCell } from '../lib/account-transfers.js';
import { mountAccountLoadOlder } from '../lib/account-load-older.js';
import { democracyCells } from '../lib/democracy-patch.js';
import { renderPostHtml, EMPTY_THREAD_HTML, renderEarlierDiscussion } from '../lib/discussion-edit.js';
import { renderLifecycleLinks, discussLinkHtml, referendumDiscussCell, externalSummaryHtml } from '../lib/discussion-lifecycle.js';
import { renderCopyLinkButton, wirePermalinks } from '../lib/discussion-links.js';
import { discussComposerHtml } from '../lib/discussion-auth.js';
import { spendColumns } from '../lib/treasury-payout-view.js';
import { rewardsChartConfig } from '../lib/chart-update.js';

const COLOUR = /(^|;)\s*(color|background(-color|-image)?|border(?!-radius)(-[a-z]+)*)\s*:/i;
const docOf = (html) => {
    const win = new Window({ url: 'https://explorer.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    win.document.body.innerHTML = html;
    return win.document;
};
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const inline = (root) => Array.from(root.querySelectorAll('[style]')).filter(e => COLOUR.test(';' + e.getAttribute('style'))).map(e => `<${e.tagName.toLowerCase()} class="${e.className}" style="${e.getAttribute('style')}">`);
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const SRC = stripComments(readRepo('script.js', import.meta.url));
const { statusBadge } = new Function('stakingEscapeHtml', 'chipHtml', `${bodyOf(SRC, 'statusBadge')} return { statusBadge };`)(escapeHtml, chipHtml);

describe('T12, I14: statusBadge in its three states and both forms, with no style', () => {
    test('the badge form is a chip: Success (is-positive, check), Failed (is-error, x), the unknown word (is-neutral, dash, with its title)', () => {
        const d = docOf(statusBadge('success') + statusBadge('failed') + statusBadge(null) + statusBadge('pending'));
        const chips = Array.from(d.querySelectorAll('.ui-chip'));
        assert.deepEqual(chips.map(e => [e.className.replace('ui-chip ', ''), text(e)]), [['is-positive', 'Success'], ['is-error', 'Failed'], ['is-neutral', 'unknown'], ['is-neutral', 'pending']]);
        assert.ok(chips[0].querySelector('.bx-check') && chips[1].querySelector('.bx-x') && chips[2].querySelector('.bx-minus'));
        assert.match(chips[2].getAttribute('title'), /dispatch result has not been read yet/);
        assert.equal(chips[0].hasAttribute('title'), false);
        assert.deepEqual(inline(d), []);
        assert.equal(d.querySelectorAll('[style]').length, 0, 'a style attribute is left on a badge');
    });
    test('the icon form: bxs-check-circle .is-success, bxs-x-circle .is-failed, bx-minus .is-unknown, each .tx-status with its title and no style', () => {
        const d = docOf(statusBadge('success', '', { icon: true }) + statusBadge('failed', '', { icon: true }) + statusBadge(undefined, '', { icon: true }));
        const icons = Array.from(d.querySelectorAll('i'));
        assert.deepEqual(icons.map(e => [e.classList.contains('bxs-check-circle'), e.classList.contains('bxs-x-circle'), e.classList.contains('bx-minus'), e.getAttribute('title')]),
            [[true, false, false, 'Success'], [false, true, false, 'Failed'], [false, false, true, 'unknown']]);
        assert.deepEqual(icons.map(e => ['is-success', 'is-failed', 'is-unknown'].filter(c => e.classList.contains(c)).join()), ['is-success', 'is-failed', 'is-unknown']);
        for (const i of icons) assert.ok(i.classList.contains('tx-status'));
        assert.equal(d.querySelectorAll('[style]').length, 0);
    });
    test('extraStyle is now extraClass: the second argument is a class added to the element, never a style', () => {
        const d = docOf(statusBadge('success', 'is-small'));
        const chip = d.querySelector('.ui-chip');
        assert.ok(chip.classList.contains('is-small'));
        assert.equal(chip.hasAttribute('style'), false);
    });
    test('the unknown status never wears the success or failed role', () => {
        const d = docOf(statusBadge('whatever') + statusBadge('whatever', '', { icon: true }));
        assert.equal(d.querySelectorAll('.is-positive, .is-error, .is-success, .is-failed').length, 0);
    });
});

describe('I41, P6: the transfers value cell', () => {
    test('decimals and unit are both .ui-quiet (pink is never text under 18 px)', () => {
        const d = docOf(transferValueCell('1.2345 PDEX'));
        const quiet = Array.from(d.querySelectorAll('.ui-quiet')).map(text);
        assert.deepEqual(quiet, ['.2345', 'PDEX']);
        assert.deepEqual(inline(d), []);
    });
});

describe('I42, P4: the load older bar', () => {
    test('the count, done and status lines are captions; the error line is .ui-field-error and starts with its icon when a load fails', async () => {
        const d = docOf('<div id="tab"></div>');
        const tab = d.getElementById('tab');
        const rows = [];
        mountAccountLoadOlder(tab, { address: 'a', list: 'transactions', rows, next: 'c1', total: 10, table: { setData() {} }, fetchJson: async () => { throw new Error('Index offline'); } });
        assert.ok(tab.querySelector('.js-older-count.ui-caption'));
        assert.ok(tab.querySelector('.js-older-done.ui-caption'));
        assert.ok(tab.querySelector('.js-older-status.ui-caption'));
        const err = tab.querySelector('.js-older-error');
        assert.ok(err.classList.contains('ui-field-error'));
        tab.querySelector('.js-older-btn').click();
        await tick(20);
        assert.ok(err.querySelector('.bx-error-circle'), 'no icon: ' + err.innerHTML);
        assert.match(text(err), /Index offline/);
        assert.deepEqual(inline(tab), []);
    });
});

describe('I17, P6: democracy cells', () => {
    test('a finished referendum has no vote buttons: the dash is .ui-quiet', () => {
        const h = { pdex: String, num: String, esc: escapeHtml, pending: () => null, myVote: () => null, canSecond: () => false };
        const d = docOf(democracyCells(h).cell('ref', { refIndex: 3, status: 'Passed', ayes: 1, nays: 0, turnout: 1, tallyKnown: 1 }, 'vote'));
        assert.equal(text(d.querySelector('.ui-quiet')), '—');
        assert.deepEqual(inline(d), []);
    });
});

describe('P4, P9, I43: discussions', () => {
    const o = { esc: escapeHtml, shortAddr: (a) => String(a).slice(0, 6), fmtDate: (ms) => `T${ms}` };
    const post = { id: 5, author: 'esAuthor', authorName: 'Ann', content: 'Hi', createdAt: 100, editedAt: 200 };
    test('a post: the author is a plain .item-link; the date, the edited tag are .ui-caption; Edit and Copy link are the shared one-rule buttons', () => {
        const d = docOf(renderPostHtml(post, { ...o, editable: true, actions: renderCopyLinkButton }));
        const a = d.querySelector('.discussion-post-head a.item-link');
        assert.ok(a && !a.hasAttribute('style'));
        assert.ok(d.querySelector('.discussion-edited-tag.ui-caption'));
        assert.ok(d.querySelector('.discussion-post-head > .ui-caption'));
        assert.ok(d.querySelector('button.discussion-edit-btn:not([style])'));
        assert.ok(d.querySelector('button.discussion-link-btn:not([style])'));
        assert.deepEqual(inline(d), []);
    });
    test('an empty thread is .ui-state (the same words)', () => {
        const d = docOf(EMPTY_THREAD_HTML);
        assert.equal(d.querySelector('.ui-state').textContent.trim(), 'No posts yet - be the first to comment.');
        assert.deepEqual(inline(d), []);
    });
    test('the earlier discussion block: the summary is a caption-level heading, the link a plain .item-link, no inline colour', () => {
        const d = docOf(renderEarlierDiscussion([{ thread: { id: 'motion-1', title: 'Motion 1', kind: 'motion', status: 'closed' }, posts: [post] }], { ...o, hrefOf: () => '/discussions/motion-1' }));
        assert.ok(d.querySelector('summary.discussion-earlier-head .ui-quiet'));
        assert.ok(d.querySelector('a.item-link:not([style])'));
        assert.deepEqual(inline(d), []);
    });
    test('the lifecycle links: plain .item-link, the kind label is .ui-caption, the group heading .ui-strong', () => {
        const d = docOf(renderLifecycleLinks({ earlier: [{ id: 'motion-1', title: 'Motion 1', kind: 'motion', status: 'closed' }], later: [{ id: 'referendum-2', title: 'Ref 2', kind: 'referendum' }] }, escapeHtml));
        assert.equal(d.querySelectorAll('a.item-link:not([style])').length, 2);
        assert.equal(d.querySelectorAll('li .ui-caption').length, 2);
        assert.ok(d.querySelector('.discussion-lifecycle-group > .ui-strong'));
        assert.deepEqual(inline(d), []);
    });
    test('Discuss links, the finished-referendum dash and the external summary link carry no colour', () => {
        const d = docOf(discussLinkHtml('t-1') + referendumDiscussCell({ refIndex: 4, status: 'Passed' }) + externalSummaryHtml({ proposalHash: '0x' + '12'.repeat(32), threshold: 'SimpleMajority' }, escapeHtml));
        assert.ok(d.querySelectorAll('a.item-link:not([style])').length >= 3);
        assert.equal(text(d.querySelector('.ui-quiet')), '-');
        assert.deepEqual(inline(d), []);
    });
    test('I43 the copy link feedback: the class, not a colour, says copied (.is-ok); a refusal shows the link as plain text', async () => {
        const d = docOf('<div id="r"><button type="button" data-copy-post="5">c</button><span class="discussion-link-feedback"></span></div>');
        const fb = d.querySelector('.discussion-link-feedback');
        const mk = (ok) => ({ threadId: '7', origin: 'https://explorer.test', env: { navigator: { clipboard: { writeText: async () => { if (!ok) throw new Error('no'); } } }, document: null }, setTimeout: () => 0, clearTimeout: () => {} });
        wirePermalinks(d.getElementById('r'), mk(true));
        d.querySelector('[data-copy-post]').click();
        await tick(10);
        assert.equal(text(fb), 'Link copied');
        assert.ok(fb.classList.contains('is-ok'));
        assert.equal(fb.hasAttribute('style'), false);
        const d2 = docOf('<div id="r"><button type="button" data-copy-post="5">c</button><span class="discussion-link-feedback"></span></div>');
        const fb2 = d2.querySelector('.discussion-link-feedback');
        wirePermalinks(d2.getElementById('r'), mk(false));
        d2.querySelector('[data-copy-post]').click();
        await tick(10);
        assert.match(text(fb2), /^Copy this link: /);
        assert.equal(fb2.classList.contains('is-ok'), false);
        assert.equal(fb2.hasAttribute('style'), false);
    });
    test('the composer: "Connect a wallet to comment." is .ui-lede; the head is .ui-caption; the address is a plain span.mono; the sign note is .ui-caption', () => {
        const base = { thread: null, esc: escapeHtml, shortAddr: (a) => a.slice(0, 6), returnTo: '/discussions/7' };
        const out = docOf(discussComposerHtml({ ...base, wallet: null, session: null }));
        assert.ok(out.querySelector('p.ui-lede'));
        const inn = docOf(discussComposerHtml({ ...base, wallet: 'esWalletAddr', session: null, composer: '<textarea></textarea>' }));
        assert.ok(inn.querySelector('.discussion-composer > .ui-caption'));
        assert.ok(inn.querySelector('span.mono[title="esWalletAddr"]'));
        assert.ok(inn.querySelector('.discussion-sign-note.ui-caption'));
        for (const x of [out, inn]) assert.deepEqual(inline(x), []);
    });
});

describe('P9: the treasury spends table', () => {
    test('the beneficiary is a plain .item-link with no colour', () => {
        const cols = spendColumns({ connected: false, held: new Set(), data: { block: 100, nextBlock: 101, blockTimeMs: 6000, decimals: 12, spends: [] }, fetchedAt: 0, formatTime: () => 't' });
        const html = cols.find(c => c.key === 'beneficiary').format({ index: 1, beneficiary: 'esBeneficiary0000000000000000000000' });
        const d = docOf(html);
        assert.ok(d.querySelector('a.item-link:not([style])'));
        assert.deepEqual(inline(d), []);
    });
});

// The chart colours are the stylesheet's tokens, read when the chart is drawn (spec 2.3, last paragraph): script.js and lib/
// hold no hex of their own. The stylesheet is stubbed as a map of token names to values nothing else uses.
describe('chart series: colours come from the tokens at draw time', () => {
    test('lib/chart-update.js: Claimed is --accent-green, Unpaid is --brand-primary, the ticks are --text-secondary, the grid --border-color', () => {
        const TOK = { '--accent-green': '#T1G', '--brand-primary': '#T2P', '--text-secondary': '#T3S', '--border-color': '#T4B' };
        const keep = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
        globalThis.document = { documentElement: {} };
        globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => TOK[n] || '' });
        try {
            const cfg = rewardsChartConfig({ labels: ['1'], datasets: [{ data: [1] }, { data: [2] }] }, { duration: 0 });
            const [claimed, unpaid] = cfg.data.datasets;
            assert.equal(claimed.borderColor, '#T1G');
            assert.equal(unpaid.borderColor, '#T2P');
            assert.ok(String(claimed.backgroundColor).startsWith('#T1G'), claimed.backgroundColor);
            assert.ok(String(unpaid.backgroundColor).startsWith('#T2P'), unpaid.backgroundColor);
            assert.equal(cfg.options.scales.x.ticks.color, '#T3S');
            assert.equal(cfg.options.scales.y.ticks.color, '#T3S');
            assert.equal(cfg.options.scales.x.grid.color, '#T4B');
            assert.equal(cfg.options.scales.y.grid.color, '#T4B');
        } finally {
            for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
        }
    });
});
