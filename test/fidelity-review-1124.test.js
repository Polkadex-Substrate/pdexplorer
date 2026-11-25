// The designer's fidelity review of 2026-11-24 (cto-team/plans/2026-11-24-fidelity-review-locks-stake-refresh.md):
// the stylesheet rules (L1, L6, L7, M1, S7, S8), the strings by id from the real modules (R1, C1 lives in
// test/charts-in-place.test.js, S17b and the nouns of R3, table H, table A, S4, S11, L10) and the rendered
// lock rows with a confirm strip open (L1: one button per row, read with the real stylesheet's rules).
// The stake card's states (M2 to M4, rulings b and c, S1, S2, S5) are in test/stake-card-simple.test.js, the
// locks' rows (L2 to L6) in test/lock-rows.test.js and test/lock-refresh.test.js, the wallet sections (R2, R5,
// R6) in test/refresh-r3.test.js, the validator card (S17b) in test/refresh-r5.test.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments } from './helpers/source.js';
import { parseRules, rootProps } from './helpers/css-rules.js';
import { escapeHtml } from '../lib/html-escape.js';
import { STRINGS, say, nounFor } from '../lib/refresh-ui.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { validatorRowHtml, validatorChips, filterBarHtml } from '../lib/stake-picker-view.js';
import { selectionRowsHtml } from '../lib/stake-advanced-view.js';
import { WHY, DEFAULT_FILTERS } from '../lib/stake-filters.js';

const CSS = readRepo('styles.css', import.meta.url);
const RULES = parseRules(CSS);
const HTML = readRepo('index.html', import.meta.url);
const SCRIPT = readRepo('script.js', import.meta.url);
const sections = await import('../lib/wallet-sections.js');
const DASH = /[–—]/;

// The declarations a selector gets outside any @media, the later rule winning (as the cascade does for equal specificity).
function decls(sel, media = null) {
    const out = {};
    for (const r of RULES) {
        const here = media ? r.media.replace(/\s+/g, ' ').startsWith(media) : !r.media;
        if (here && r.selectors.includes(sel)) Object.assign(out, r.decls);
    }
    return out;
}

// ── contrast, recomputed from :root (WCAG 2.1 relative luminance) ──
const { props } = rootProps(CSS);
const hex = (h) => { const m = String(h).trim().match(/^#([0-9a-f]{6})$/i); assert.ok(m, `not a hex colour: ${h}`); return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)); };
const lum = (rgb) => { const [r, g, b] = rgb.map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const token = (v) => { const m = String(v).match(/^var\((--[a-z-]+)\)$/); return m ? props[m[1]] : v; };

describe('L1: an action whose row shows the confirm strip is drawn once', () => {
    test('the stylesheet hides .lock-row-action[hidden] (its display: flex outranks the attribute otherwise)', () => {
        assert.equal(decls('.lock-row-action').display, 'flex', 'the rule the [hidden] attribute loses to');
        assert.equal(decls('.lock-row-action[hidden]').display, 'none');
    });
    // An element is drawn unless it or an ancestor has [hidden] AND the stylesheet lets the attribute win: no author rule
    // on one of its classes sets a display other than none, or a rule ".class[hidden]" sets display: none.
    const hiddenWins = (el) => {
        const classes = Array.from(el.classList || []);
        const shows = classes.some(c => { const d = decls('.' + c).display; return d && d !== 'none'; });
        return !shows || classes.some(c => decls(`.${c}[hidden]`).display === 'none');
    };
    const drawn = (el) => { for (let e = el; e; e = e.parentElement) if (e.hasAttribute && e.hasAttribute('hidden') && hiddenWins(e)) return false; return true; };
    const sceneWorld = async (id) => (await import('../tools/preview-scenes.mjs')).sceneWorld('locks', id);
    for (const id of ['confirm-open', 'busy', 'failed']) {
        test(`scene locks-${id}: every row with a confirm strip shows one [data-lock-action], not the old one as well`, async () => {
            const w = await sceneWorld(id);
            const rows = Array.from(w.doc.querySelectorAll('#wallet-locks-slot li.lock-row')).filter(li => li.querySelector('.lock-confirm, .lock-row-msg[role="alert"], [aria-busy="true"]'));
            assert.ok(rows.length >= 1, 'no row with a strip in the scene');
            for (const li of rows) {
                const n = Array.from(li.querySelectorAll('[data-lock-action]')).filter(drawn).length;
                assert.equal(n, 1, `${li.querySelector('.lock-name')?.textContent.trim()}: ${n} visible [data-lock-action] buttons`);
            }
        });
    }
});

describe('L7: a confirm strip inside a child row takes the full width', () => {
    test('.lock-child > .lock-confirm { flex: 1 1 100%; }', () => {
        assert.equal(decls('.lock-child > .lock-confirm').flex, '1 1 100%');
    });
});

describe('M1: the Stake card hints and figures are --text-secondary, 4.5:1 or better', () => {
    const SEL = ['.stake-hint', '.stake-val-meta', '.stake-apr-note', '.stake-empty', '.stake-clear-btn'];
    for (const sel of SEL) {
        test(`${sel}: color var(--text-secondary)`, () => {
            assert.equal(decls(sel).color, 'var(--text-secondary)');
        });
    }
    for (const sel of SEL.slice(0, 3)) {
        test(`${sel}: font-size 0.82rem`, () => {
            assert.equal(decls(sel)['font-size'], '0.82rem');
        });
    }
    test('contrast on the surface: each colour the five rules use is at least 4.5:1 on --bg-surface', () => {
        const surface = hex(props['--bg-surface']);
        for (const sel of SEL) {
            const c = token(decls(sel).color);
            const r = ratio(hex(c), surface);
            assert.ok(r >= 4.5, `${sel}: ${decls(sel).color} (${c}) is ${r.toFixed(2)}:1 on ${props['--bg-surface']}`);
        }
        assert.ok(ratio(hex(props['--text-muted']), surface) < 4.5, 'the guard measures: --text-muted is the failing colour of the review (3.85:1)');
    });
});

describe('S7, S8: no pink on Max or the preset; 44 px add and remove on a phone, a neutral hover', () => {
    const PINK = /brand-primary|230,\s*0,\s*122/;
    test('S7: Max is not drawn in the primary\'s pink, at rest or on hover', () => {
        for (const sel of ['.stake-max-btn', '.stake-max-btn:hover']) assert.doesNotMatch(JSON.stringify(decls(sel)), PINK, sel);
    });
    test('S7: "Suggested filters" is a violet line', () => {
        const d = decls('.stake-chip[data-preset="recommended"]');
        assert.equal(d['border-color'], 'var(--accent-violet-line)');
        assert.equal(d.color, 'var(--accent-violet-text)');
    });
    test('S8: add and remove are 44 px at 640 px and below', () => {
        for (const sel of ['.stake-val-add', '.stake-val-remove']) {
            const d = decls(sel, '@media (max-width: 640px)');
            assert.equal(d.width, '44px', sel);
            assert.equal(d.height, '44px', sel);
        }
    });
    test('S8: their hover is neutral (no green, no pink)', () => {
        for (const sel of ['.stake-val-add:hover:not(:disabled)', '.stake-val-remove:hover']) {
            const d = JSON.stringify(decls(sel));
            assert.ok(d !== '{}', `no ${sel} rule`);
            assert.doesNotMatch(d, /brand-secondary|brand-primary|0,\s*230,\s*118|230,\s*0,\s*122/, sel);
        }
    });
});

describe('R1: the dash rule in the moved strings, and one constant for the closed buttons', () => {
    test('the closed signing buttons say one sentence, from one constant', () => {
        assert.equal(sections.WALLET_ACTIONS_CLOSED, 'Balances could not be refreshed. Reload before sending or staking.');
        const code = stripComments(SCRIPT);
        assert.equal((code.match(/disableWalletActions\(WALLET_ACTIONS_CLOSED\)/g) || []).length, 3, 'the three places that close the buttons');
        assert.ok(!code.includes('Balances could not be refreshed —'), 'the old sentence with its dash is still in script.js');
    });
    test('the price card sentence is one constant with no dash', () => {
        assert.equal(sections.PRICE_COLLECTING, 'Collecting price history. The chart fills in as data arrives.');
        assert.ok(!stripComments(SCRIPT).includes('Collecting price history —'), 'the old sentence with its dash is still in script.js');
        const f = sections.createWalletSections({ doc: null, data: () => null, setData() {}, fmt: { pdex: (v) => String(v), number: (v) => String(v), esc: escapeHtml, short: (a) => a, duration: () => '' } });
        const html = f.frameHtml({ address: 'a', balance: {}, staking: {}, rewards: {}, network: {} }, { price: { history: [], configured: true } });
        assert.ok(html.includes('Collecting price history. The chart fills in as data arrives.'), 'the frame does not say the sentence');
        assert.doesNotMatch(html, DASH);
    });
});

describe('R3: S17b for a card that is not a list, and the two nouns', () => {
    test('S17b, verbatim, and say() fills it', () => {
        assert.equal(STRINGS.S17b, 'The block with your {payout} was replaced by the network. It is being sent again, so this card shows the earlier state until it is back in a block.');
        assert.equal(say('S17b', { payout: 'validator change' }), 'The block with your validator change was replaced by the network. It is being sent again, so this card shows the earlier state until it is back in a block.');
    });
    test('staking.validate is a "validator change", session.setKeys a "keys change"', () => {
        assert.equal(nounFor('staking.validate'), 'validator change');
        assert.equal(nounFor('session.setKeys'), 'keys change');
        assert.equal(nounFor('balances.transfer'), 'transfer', 'the others stay');
    });
});

const topic = (slug) => HELP_TOPICS.find(t => t.slug === slug);
const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

describe('ruling d (table H): the nominating topic speaks to a person', () => {
    test('the title is "Staking PDEX from My Account", the slug unchanged', () => {
        assert.equal(topic('nominating').title, 'Staking PDEX from My Account');
    });
    const H = {
        H1: 'The Stake PDEX card asks for one thing, the amount. It chooses validators for you by the rule below; open the line that says how many were chosen to see them.',
        H2: 'On a first stake, rewards are added to your stake, so they earn too. If you already stake, your rewards setting stays as it is and the card says what it is.',
        H3: 'Under What happens the card says what is locked, when it starts earning and how long it takes to get back.',
        H5: 'The card signs only what you change. Adding PDEX leaves your validators as they are. The card never replaces them by itself: when some are not earning it offers a replacement and shows what is kept, removed and added before you sign.',
        H6: 'You can choose as many validators as the network allows; the limit is shown beside Your selection. Switching views keeps the amount and the selection. A change to where rewards go is signed only from Advanced.'
    };
    for (const [id, text] of Object.entries(H)) test(`${id}: the final words`, () => { assert.ok(plain(topic('nominating').body).includes(text), `missing ${id}: ${text}`); });
    // H4 is not built: the sentence it rewrites ("It is never the commission-only Est. APY of the Validators page.") left
    // this topic when main's #95 made Est. APY a measured return, and the review's words ("a projection from commission
    // alone") would now be false. Neither is in the topic.
    test('H4: no sentence calls Est. APY a projection from commission (it is measured since #95)', () => {
        const b = plain(topic('nominating').body);
        assert.ok(!b.includes('which is a projection from commission alone'), 'H4 is false on this head');
        assert.ok(!b.includes('commission-only Est. APY'));
    });
    test('the old joining sentences are gone', () => {
        const b = plain(topic('nominating').body);
        for (const old of ['The simple view of the Stake PDEX card has one field, the amount.', 'Validators are chosen by a stated rule and shown behind one disclosure.',
            'It is never the commission-only Est. APY of the Validators page.', 'The card signs only what changed:', 'You can choose up to the chain\'s nominations quota.']) assert.ok(!b.includes(old), `still there: ${old}`);
    });
    test('H8: choosing-validators says stakers, Pay Out and Accepting new stake', () => {
        const b = plain(topic('choosing-validators').body);
        for (const now of ['paid its stakers nothing', 'who staked with them', 'every staker of a validator', 'Above 256 stakers', 'at most 256 stakers', 'needs its own Pay Out', 'Accepting new stake']) assert.ok(b.includes(now), `missing: ${now}`);
        for (const old of ['nominators nothing', 'who backed them', 'backer', 'payout claim', 'Accepting nominations']) assert.ok(!b.includes(old), `still there: ${old}`);
    });
});

describe('L10: the locked-balance topic names the chip and the button', () => {
    test('"shown as old locks with the chip Needs the team"; "Cancel vote on referendum"', () => {
        const b = plain(topic('locked-balance').body);
        assert.ok(b.includes('are shown as old locks with the chip Needs the team.'), 'the old-locks sentence');
        assert.ok(!b.includes('are marked legacy'));
        assert.ok(b.includes('Cancel vote on referendum is refused before signing'));
    });
});

describe('ruling e (table A): "past return", not "APR", in the picker\'s words and the cookies table', () => {
    const v = (perf) => ({ address: 'a1', name: 'Node One', active: true, commission: 5, blocked: false, totalStake: 50000, selfStake: 1001, exposureNominators: 12,
        identity: { hasIdentity: false, verified: false, parent: null }, slashEras: [], commissionHistory: null, perf: { 28: perf } });
    test('stake-picker-view.js 74: the title of a validator with too little history', () => {
        const h = validatorRowHtml(v({ status: 'new', apr: null, erasUsed: 3, electedEras: 3, reliability: 100, missedEras: 0 }), { esc: escapeHtml, shortAddress: (a) => a, window: 28 });
        assert.match(h, /Elected history for only 3 of the last 28 eras; \d+ are needed to show a past return\. Past rewards over the last 28 completed eras/);
        assert.ok(!/for an APR/.test(h));
    });
    test('184 and 186: the preset title and the help title', () => {
        const asked = [];
        const h = filterBarHtml(DEFAULT_FILTERS, { esc: escapeHtml, helpIcon: (slug, title) => { asked.push([slug, title]); return ''; } });
        assert.match(h, /title="[^"]*one pick per identity; sorted by past return"/);
        assert.deepEqual(asked, [['choosing-validators', 'How past return and these filters work']]);
        assert.ok(!/APR/.test(h), `APR in the filter bar: ${(h.match(/[^>]{0,40}APR[^<]{0,40}/) || [''])[0]}`);
    });
    test('stake-filters.js 78, 79: the window and sort tooltips', () => {
        assert.equal(WHY.aprWindow, 'Past return is measured from rewards actually paid in past eras. A longer window is steadier; a shorter one reacts faster.');
        assert.equal(WHY.sort, 'Changes the order only. Past return is history, not a guarantee.');
    });
    test('index.html cookies table: pdex_stake_filters_v1', () => {
        const row = HTML.split('\n').find(l => l.includes('pdex_stake_filters_v1'));
        assert.ok(row, 'no cookies row');
        assert.ok(plain(row).includes('The filters, past return window and sort order you last used in the Stake PDEX validator picker (no addresses, no amounts).'), plain(row));
    });
    test('S4: the filters and the blocked chip say "new stake" and "stakers"', () => {
        const h = filterBarHtml(DEFAULT_FILTERS, { esc: escapeHtml });
        assert.match(h, /Accepting new stake/);
        assert.match(h, /Room on one payout page \(at most 256 stakers\)/);
        assert.ok(!/Accepting nominations|at most 256 backers/.test(h), 'the old labels');   // the why tooltips have no final text in the review: unchanged
        const chips = validatorChips({ ...v({ status: 'ok', apr: 10, erasUsed: 28, electedEras: 28, reliability: 100, missedEras: 0 }), blocked: true });
        assert.deepEqual(chips.find(([k]) => k === 'blocked'), ['blocked', 'This validator does not accept new stake']);
    });
    test('S3: the row labels the total stake and gives the own stake its unit, grouped', () => {
        const h = validatorRowHtml(v({ status: 'ok', apr: 10, erasUsed: 28, electedEras: 28, reliability: 100, missedEras: 0 }), { esc: escapeHtml, shortAddress: (a) => a, window: 28 });
        assert.match(h, /total stake 50\.0K PDEX/);
        assert.match(h, /own stake 1,001 PDEX/);
    });
});

describe('S9: no separator before a chip in Your selection', () => {
    test('"19.42% a year" then the chip, with no middle dot between', () => {
        const row = { address: 'a1', name: 'Node One', chosen: true, v: { address: 'a1', name: 'Node One', active: true, commission: 5, blocked: false, totalStake: 50000, selfStake: 1000,
            exposureNominators: 12, identity: { hasIdentity: false, verified: false, parent: null }, slashEras: [], commissionHistory: null,
            perf: { 28: { status: 'ok', apr: 19.42, erasUsed: 28, electedEras: 28, reliability: 100, missedEras: 0 } } } };
        const h = selectionRowsHtml({ rows: [row] }, escapeHtml, { full: true });
        assert.match(h, /data-chip="chosen"/, 'the chip is drawn');
        assert.ok(!/&middot;\s*<span class="ui-chip/.test(h), `a middle dot before the chip: ${h}`);
    });
});

describe('S11: the help icon on the card title', () => {
    test('aria-label "Help: staking PDEX"', () => {
        const line = HTML.split('\n').find(l => l.includes('id="stake-title"'));
        assert.ok(line && line.includes('aria-label="Help: staking PDEX"'), line);
    });
});

describe('L8: the G2 chip sits beside the name at 641 px and up', () => {
    test('row 1 is name, chip, amount; below 641 px the chip keeps its own line', () => {
        const wide = '@media (min-width: 641px)';
        assert.equal(decls('.lock-row.is-rest .lock-row-top', wide)['grid-template-columns'], 'auto minmax(0, 1fr) auto');
        const chip = decls('.lock-row.is-rest .lock-row-top .ui-chip', wide);
        assert.deepEqual([chip['grid-column'], chip['grid-row']], ['2', '1'], 'the chip is not in row 1 after the name');
        assert.equal(decls('.lock-row.is-rest .lock-amount', wide)['grid-column'], '3');
        assert.equal(decls('.lock-row.is-rest .lock-row-top .ui-chip')['grid-column'], '1 / 3', 'the phone layout changed');
    });
});

describe('S10: the Advanced card has two columns from 900 px, one below', () => {
    test('the grid starts at 900 px; from 641 to 899 px the card is one column', () => {
        const grid = (m) => decls('.stake-modal-body.is-advanced', m).display;
        assert.equal(grid('@media (min-width: 900px)'), 'grid');
        assert.equal(grid('@media (min-width: 641px)'), undefined, 'two columns still start at 641 px (about 110 px per picker)');
        assert.equal(grid('@media (max-width: 899px)'), 'flex');
        assert.equal(decls('.stake-modal-body.is-advanced .stake-row', '@media (max-width: 899px)').order, '4', 'the one-column order rules follow the breakpoint');
    });
});
