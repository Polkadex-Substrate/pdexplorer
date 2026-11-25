// The CEO-approved wordings and the Stop validating style (CEO approval 2026-11-25, in chat: "Approve all 8"
// and "Adopt Fable's style"), cto-team/plans/2026-11-25-explorer-open-followups.md Group B (Q3, Q14, Q15, Q26,
// Q30, Q31, Q32, Q36) and Group C (C-1). Copy, order and look only: what is signed, when, the review, the
// guards and the evidence do not change, and the sign tests below hold the calls to that.
//
// (1) The WP3 snapshot (test/snapshots/wp3-frozen-text.json) was re-baselined for these items only. This
//     file proves it: the snapshot minus the listed entries hashes to the snapshot before the re-baseline
//     minus the same entries, and each listed entry, with its approved edits reversed, hashes to the entry
//     before. The hashes were taken from the snapshot at a0c0361.
// (2) The rendered manage panel and wizard (the real mounts on fake chains, test/helpers/wp3-world.js).
// (3) The sign calls for Stop validating and Change where rewards go: the same pallet, method and arguments.
//
// Synthetic accounts only (the wp3 world's repeated-byte addresses).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildState, closeWorld, PAYEE } from './helpers/wp3-world.js';
import { parseRules } from './helpers/css-rules.js';
import { renderNodeGuide } from '../lib/validator-node-guide.js';
import { escapeHtml } from '../lib/html-escape.js';
import * as M from '../lib/validator-manage.js';

const SNAP = JSON.parse(readFileSync(new URL('./snapshots/wp3-frozen-text.json', import.meta.url), 'utf8'));
const RULES = parseRules(readFileSync(new URL('../styles.css', import.meta.url), 'utf8'));
const sha = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const qa = (el, sel) => Array.from(el.querySelectorAll(sel));
const txt = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
const rulesFor = (sel, media = '') => RULES.filter(r => r.selectors.includes(sel) && (media === '' ? !r.media : r.media.includes(media)));
const decl = (sel, prop, media = '') => { const r = rulesFor(sel, media).filter(x => x.decls[prop] != null); return r.length ? r[r.length - 1].decls[prop] : undefined; };

// ── (1) the re-baseline changed these entries and nothing else ──
// The snapshot before the re-baseline, minus the CHANGED entries (tables and the other 62 states).
const BEFORE_REST = '79fbe3c9cd68168d074b111614aabb3f625779fa017a4f250530f85dab51bb14';
// state id: [the items that change it, the sha256 of the entry before].
const CHANGED = {
    'wiz-restoring': [['Q32'], '059e79377b1caaf649b7365e9abb488e3c6b881e71e6628506a20ed40c1bf30a'],
    'wiz-done-already': [['Q15'], '060ef009b88fbf00fd1d14d709256380abf2b866c989ac33cb1fb14a57b0f0b7'],
    'wiz-step1': [['Q14'], '6a0ac37496c914c2a4f6c467c7692af9669397c644eb4c3ffeb7e839336b23b2'],
    'wiz-step1-node-empty': [['Q14'], '89b0bdcdcec8c115858f07e9f11b780026ec89266fe9ec0c15d50f06f48ddc62'],
    'wiz-step1-node-found': [['Q14'], 'e8dd1c6c206911dd420fef503ecb5b5a911751ab5e08d1be997fda0b637760b4'],
    'wiz-step3-error': [['Q31'], '2d7385e4fc0c0c75ea7607ac3b943d856c8f4b30a1e42a7cb03ede8f94f26e1d'],
    'wiz-step3-payee': [['Q31'], '44daf72bf703b2d292e5bf7343a9c46e00c8da2d5f058c9e95ec2c77f6d07afd'],
    'wiz-result-applied': [['Q36'], 'b70f390a5cada70fae81bb57985cd3f67e9c7b494c0cf592654c486e58620214'],
    'wiz-result-short': [['Q36'], '994a05259c24c4b54e1d35e6ebd4f63e854c4116fe12ab58875b3350f745657f'],
    'man-idle': [['Q3'], 'ad323295bed573750dda682f2f0b6e07a188dd6f7cacf1f424ace995059c2520'],
    'man-offline': [['Q3', 'Q26'], '95bc0303cd0bfce81dff66cb644e107f5718b5533a2726f240d10ee86ccffaa4'],
    'man-unbonding': [['Q3', 'C-1'], 'a4e9b4be8ca5efe143df43b1d5ae71d7e1a1662a1c2236ccc2b3deb501ca240e'],
    'man-legacy': [['Q3'], '9480d48c142686fb3d4f97816a792bbfe280723ee3fab6b599778f8a202f18dd'],
    'man-payee': [['Q3'], '38fcae6793abc52eddfd687ae648d73ac7d4b6ada45582146003dad3bee92df7'],
    'man-result-done': [['Q36'], 'b0af70762a7856a73bbb9f56a345c0b1536b843c9d8866b62584a7ac80f54ba8'],
    'man-proxy': [['Q3'], 'b82d057a4341bcadcea78d8d06180ea5d2371711d7da55ed209df3cae3b619ed'],
    'man-proxy-delay': [['Q3'], '7e81a7e37ac9ac3f198726725e23f433948bbe73ffe58efb2029f265d07048b0'],
    'man-ms-pending': [['Q3'], '0d149947334aa044b7edb9d6bf6d70da61391ed61868beafc611725f7e553489']
};
// Each approved edit, reversed: the new entry back to the old one. Q30 changes no text, field or action.
const swap = (s, now, was) => { assert.ok(s.text.includes(now), `the entry holds "${now}"`); return { ...s, text: s.text.split(now).join(was) }; };
const UNDO = {
    Q3: (s) => swap(s, 'Change where rewards go', 'Change payee'),
    Q14: (s) => swap(s, 'Optional check. The explorer cannot see your server, so it takes your word.', 'The explorer takes your word for this step.'),
    Q15: (s) => swap(s, 'To change commission, keys or bond, use Manage this validator on the status page.', 'Changes to commission, keys and bond come with the manage panel.'),
    Q26: (s) => swap(s, 'Manage this validator Check my node ', 'Manage this validator Open the node checklist '),
    Q32: (s) => ({ ...s, text: s.text + ' Checking for a connected wallet...' }),
    Q36: (s) => swap(s, / Validator set up Submitted/.test(s.text) ? ' Validator set up Submitted' : ' Change confirmed Submitted', ' Submitted'),
    // The bond message moves back from under the amount row and its limits to after the rewards fieldset.
    Q31: (s) => {
        const re = /(Lowest elected backing this era: [\d,]+ PDEX\.) ((?:(?!Where rewards go).)+?) (Where rewards go .*? Rewards account Clear) (Back Continue)$/;
        assert.match(s.text, re);
        return { ...s, text: s.text.replace(re, '$1 $3 $2 $4') };
    },
    // Stop validating moves back before Rebond, in the text and in the action list.
    'C-1': (s) => {
        const a = s.actions.filter(k => k !== 'chill');
        a.splice(a.indexOf('rebond'), 0, 'chill');
        return { ...swap(s, 'Rebond Stop validating', 'Stop validating Rebond'), actions: a };
    }
};

describe('the WP3 snapshot was re-baselined for the approved items only (CEO approval 2026-11-25)', () => {
    test('the snapshot minus the listed entries is byte for byte the snapshot before', () => {
        const rest = { tables: SNAP.tables, states: Object.fromEntries(Object.entries(SNAP.states).filter(([k]) => !(k in CHANGED))) };
        assert.equal(Object.keys(rest.states).length, 62);
        assert.equal(sha(rest), BEFORE_REST, 'an entry outside the approved items changed');
    });
    test('every listed entry changed, and with its approved edits reversed it is the entry before', () => {
        const bad = [];
        for (const [id, [items, before]] of Object.entries(CHANGED)) {
            const now = SNAP.states[id];
            if (!now) { bad.push(`${id}: missing`); continue; }
            if (sha(now) === before) bad.push(`${id}: unchanged, so it should not be listed`);
            let back = now;
            try { for (const q of items) back = UNDO[q](back); } catch (e) { bad.push(`${id}: ${e.message.split('\n')[0]}`); continue; }
            if (sha(back) !== before) bad.push(`${id}: more changed than ${items.join(' and ')}`);
        }
        assert.deepEqual(bad, []);
    });
});

// A state's live world, read and then closed.
async function withState(id, fn) {
    const w = await buildState(id);
    try { return await fn(w); } finally { if (w.release) w.release(); await closeWorld(w); }
}

// ── (2) the manage panel ──
describe('C-1: Stop validating leaves the grid and comes last, alone, under a divider', () => {
    test('idle: the four routine actions are the grid; Stop validating is the one text button after it, with the pause icon', () => withState('man-idle', (w) => {
        const grid = w.el.querySelector('ul.validate-manage-actions');
        assert.deepEqual(qa(grid, '[data-manage-action]').map(b => b.getAttribute('data-manage-action')), ['commission', 'keys', 'bondExtra', 'payee']);
        assert.equal(qa(grid, '[data-manage-action="chill"]').length, 0, 'chill is not in the grid');
        const stop = qa(w.el, '.validate-manage-stop');
        assert.equal(stop.length, 1);
        assert.ok(stop[0].previousElementSibling === grid, 'directly under the grid');
        const btns = qa(stop[0], 'button');
        assert.equal(btns.length, 1, 'alone');
        assert.equal(btns[0].getAttribute('data-manage-action'), 'chill');
        assert.equal(txt(btns[0]), 'Stop validating');
        assert.ok(btns[0].classList.contains('validate-text-btn'));
        assert.ok(!btns[0].classList.contains('validate-secondary') && !btns[0].classList.contains('validate-primary'));
        assert.ok(btns[0].firstElementChild.classList.contains('bx-pause-circle'));
        const all = qa(w.el, '[data-manage-action]').map(b => b.getAttribute('data-manage-action'));
        assert.equal(all[all.length - 1], 'chill', 'the last action');
    }));
    test('with Rebond: the grid holds the five routine actions and Stop validating still comes last', () => withState('man-unbonding', (w) => {
        assert.deepEqual(qa(w.el, 'ul.validate-manage-actions [data-manage-action]').map(b => b.getAttribute('data-manage-action')), ['commission', 'keys', 'bondExtra', 'payee', 'rebond']);
        assert.deepEqual(qa(w.el, '[data-manage-action]').map(b => b.getAttribute('data-manage-action')), ['commission', 'keys', 'bondExtra', 'payee', 'rebond', 'chill']);
    }));
    test('a legacy controller: Stop validating stays disabled with its reason, as before', () => withState('man-legacy', (w) => {
        const b = w.el.querySelector('.validate-manage-stop [data-manage-action="chill"]');
        assert.ok(b.disabled);
        const id = b.getAttribute('aria-describedby');
        assert.ok(id && w.el.querySelector('#' + id), 'the reason it names exists');
    }));
    test('the divider, the 2 by 2 grid, the neutral icon: existing tokens only', () => {
        assert.equal(decl('.validate-manage-stop', 'border-top'), '1px solid var(--border-color)');
        assert.equal(decl('.validate-manage-stop', 'padding-top'), '12px');
        assert.equal(decl('.validate-manage-stop .validate-text-btn .bx', 'color'), 'var(--text-secondary)');
        assert.equal(decl('.validate-manage-stop .validate-text-btn', 'min-height'), '44px');
        assert.match(decl('.validate-manage-actions', 'grid-template-columns'), /^repeat\(2, /);
        assert.deepEqual(RULES.filter(r => r.selectors.includes('.validate-manage-actions') && /repeat\(3,/.test(r.decls['grid-template-columns'] || '')).map(r => r.line), [], 'no three-column grid at any width');
        const stopRules = RULES.filter(r => r.selectors.some(s => s.includes('validate-manage-stop') || s.includes('[data-manage-action="sign"]')));
        assert.ok(stopRules.length >= 3);
        for (const r of stopRules) for (const v of Object.values(r.decls)) assert.doesNotMatch(v, /#[0-9a-f]{3,8}\b|rgba?\(|--error|--accent-red|gradient/i, `line ${r.line}: ${v}`);
    });
    test('the confirm step: the sign button is a 44 px secondary with the same icon, no pink gradient button, the amber facts stay', () => withState('man-chill', (w) => {
        const sign = w.el.querySelector('[data-manage-action="sign"]');
        assert.ok(sign.classList.contains('validate-secondary') && !sign.classList.contains('validate-primary'));
        assert.ok(sign.firstElementChild.classList.contains('bx-pause-circle'));
        assert.equal(txt(sign), 'Stop validating');
        assert.equal(qa(w.el, '.validate-primary').length, 0, 'no pink gradient button in the view');
        assert.ok(w.el.querySelector('.validate-manage-facts').closest('.ui-panel.is-warn'), 'the amber facts panel');
        assert.equal(decl('.validate-manage-panel .validate-secondary[data-manage-action="sign"]', 'min-height'), '44px');
        assert.equal(decl('.validate-manage-panel .validate-secondary[data-manage-action="sign"] .bx', 'color'), 'var(--text-secondary)');
    }));
    test('a multisig stash: the same secondary on its Stop validating review', () => withState('man-ms-review', (w) => {
        const sign = w.el.querySelector('[data-manage-action="sign"]');
        assert.ok(sign.classList.contains('validate-secondary') && txt(sign) === 'Stop validating');
        assert.equal(qa(w.el, '.validate-primary').length, 0);
    }));
});

describe('Q3, Q26, Q36: the manage panel wordings', () => {
    test('Q3: the button and its panel title say Change where rewards go; the action id stays payee', async () => {
        await withState('man-idle', (w) => {
            const b = w.el.querySelector('[data-manage-action="payee"]');
            assert.equal(txt(b), 'Change where rewards go');
            assert.equal(qa(w.el, '[data-manage-action]').filter(x => /payee/i.test(txt(x))).length, 0, 'no Change payee left');
        });
        await withState('man-payee', (w) => {
            assert.equal(txt(w.el.querySelector('#validate-manage-panel-title')), 'Change where rewards go');
        });
        assert.equal(M.manageMenu('active').actions.find(a => a.kind === 'payee').label, 'Change where rewards go');
    });
    test('Q26: offline, the one primary is Check my node, to the node guide check step, and that id exists', async () => {
        await withState('man-offline', (w) => {
            const p = qa(w.el, '.validate-primary');
            assert.deepEqual(p.map(a => [txt(a), a.getAttribute('href')]), [['Check my node', '/validate/node#node-step-check']]);
        });
        const html = renderNodeGuide({ esc: escapeHtml, helpIcon: () => '' });
        assert.match(html, /id="node-step-check"/);
    });
    test('Q36: the green result panel is titled Change confirmed', () => withState('man-result-done', (w) => {
        const ok = w.el.querySelector('.ui-panel.is-ok');
        assert.equal(txt(ok.querySelector('.ui-panel-title')), 'Change confirmed');
        assert.match(txt(ok.querySelector('[role="status"]')), /^Submitted and confirmed in block #8,123,999\./);
    }));
});

// ── (2) the wizard ──
describe('Q14, Q15, Q30, Q31, Q32, Q36: the setup wizard', () => {
    test('Q32: restoring shows the heading only', () => withState('wiz-restoring', (w) => {
        assert.equal(txt(w.el.querySelector('#validate-step-title')), 'Checking for a connected wallet');
        assert.doesNotMatch(w.el.textContent, /Checking for a connected wallet\.\.\./);
        assert.equal(qa(w.el, '.validate-setup-body p').length, 0);
    }));
    test('Q14: the node step note', () => withState('wiz-step1', (w) => {
        assert.ok(qa(w.el, '.validate-setup-note').some(p => txt(p) === 'Optional check. The explorer cannot see your server, so it takes your word.'));
        assert.doesNotMatch(w.el.textContent, /takes your word for this step/);
    }));
    test('Q15: already validating points to Manage this validator', () => withState('wiz-done-already', (w) => {
        assert.ok(qa(w.el, 'p').some(p => txt(p) === 'It is bonded, its session keys are registered and it is asking to validate. To change commission, keys or bond, use Manage this validator on the status page.'));
    }));
    test('Q36: the green result panel is titled Validator set up', async () => {
        for (const id of ['wiz-result-applied', 'wiz-result-short']) {
            await withState(id, (w) => {
                const ok = w.el.querySelector('.ui-panel.is-ok');
                assert.equal(txt(ok.querySelector('.ui-panel-title')), 'Validator set up', id);
            });
        }
    });
    test('Q31: the bond message sits directly under the amount row and its limits, before the rewards fieldset', async () => {
        for (const id of ['wiz-step3-error', 'wiz-step3-payee']) {
            await withState(id, (w) => {
                const msg = w.el.querySelector('#validate-setup-bond-msg');
                assert.ok(txt(msg).length > 0, `${id}: a message is shown`);
                assert.equal(msg.previousElementSibling && msg.previousElementSibling.id, 'validate-setup-bond-limits', id);
                assert.equal(msg.previousElementSibling.previousElementSibling.querySelector('#validate-setup-bond') ? 'row' : '', 'row', `${id}: the amount row is above the limits`);
                assert.ok(msg.nextElementSibling && msg.nextElementSibling.matches('fieldset.validate-setup-payee'), `${id}: the fieldset follows`);
            });
        }
    });
    test('Q31: already bonded, the message sits under the top-up row and its limits', () => withState('wiz-step3-bonded', async (w) => {
        await w.type('#validate-setup-extra', 'abc');
        await w.click('[data-setup-action="next"]');
        const msg = w.el.querySelector('#validate-setup-bond-msg');
        assert.ok(txt(msg).length > 0);
        assert.equal(msg.previousElementSibling.id, 'validate-setup-bond-limits');
        assert.ok(msg.previousElementSibling.previousElementSibling.querySelector('#validate-setup-extra'));
    }));
    test('Q30: guide links and help icons inside the steps open in a new tab; buttons and the forward links do not', async () => {
        const seen = [];
        for (const id of ['wiz-step1', 'wiz-step2', 'wiz-step3']) {
            await withState(id, (w) => {
                const step = w.el.querySelector('.validate-setup-step');
                for (const a of qa(step, 'a')) {
                    seen.push(`${id} ${a.getAttribute('href')}`);
                    assert.equal(a.getAttribute('target'), '_blank', `${id} ${a.getAttribute('href')}`);
                    assert.equal(a.getAttribute('rel'), 'noopener', `${id} ${a.getAttribute('href')}`);
                    assert.ok(!a.hasAttribute('data-spa-link'), 'the new tab is not swallowed by the router');
                }
                for (const b of qa(step, 'button')) assert.ok(!b.hasAttribute('target'));
            });
        }
        assert.deepEqual(seen, ['wiz-step1 /validate/node', 'wiz-step2 /validate/node', 'wiz-step3 /help/validator-setup']);
        // The step that signs and the result keep their links in the same tab.
        for (const id of ['wiz-review', 'wiz-result-applied']) {
            await withState(id, (w) => {
                for (const a of qa(w.el, '.validate-setup-step a')) assert.ok(!a.hasAttribute('target'), `${id} ${a.getAttribute('href')}`);
                assert.ok(!w.el.querySelector('[data-setup-action="sign"][target], [data-setup-action="next"][target]'));
            });
        }
    });
});

// ── (3) the sign calls are unchanged ──
// A recording copy of api.tx: every pallet.method(args) the builder asks for.
function spyTx(api) {
    const calls = [];
    const orig = api.tx;
    api.tx = new Proxy(orig, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => (...args) => { calls.push([String(sec), String(m), JSON.parse(JSON.stringify(args, (k, v) => (typeof v === 'bigint' ? v.toString() : v)))]); return p[m](...args); } }) });
    return { calls, orig };
}
describe('nothing changes in what is signed: the same submit, the same call', () => {
    test('Stop validating: pressing the secondary submits once, and the builder asks for staking.chill() with no arguments', () => withState('man-chill', async (w) => {
        await w.click('[data-manage-action="sign"]');
        assert.equal(w.submits.length, 1);
        const s = w.submits[0];
        assert.equal(s.label, 'Stop validating');
        assert.equal(s.idleText, 'Stop validating');
        assert.equal(s.action.key, M.MANAGE_ACTION);
        assert.equal(s.action.params.kind, 'chill');
        assert.deepEqual(s.action.params.expectEvents, ['staking.Chilled']);
        assert.equal(s.expectedWallet, w.d.account.address);
        assert.equal(typeof s.verify, 'function');
        const { calls, orig } = spyTx(w.api);
        const tx = await s.buildTx(w.api);
        assert.deepEqual(calls, [['staking', 'chill', []]]);
        assert.equal(tx.section, 'staking');
        assert.equal(tx.method, 'chill');
        assert.equal(tx.toHex(), orig.staking.chill().toHex());
    }));
    test('Change where rewards go: the builder asks for staking.setPayee({ Account }) as before', () => withState('man-payee-review', async (w) => {
        await w.click('[data-manage-action="sign"]');
        assert.equal(w.submits.length, 1);
        const s = w.submits[0];
        assert.equal(s.action.params.kind, 'payee');
        assert.equal(s.idleText, 'Sign and submit');
        const { calls, orig } = spyTx(w.api);
        const tx = await s.buildTx(w.api);
        assert.deepEqual(calls, [['staking', 'setPayee', [{ Account: PAYEE }]]]);
        assert.equal(tx.section, 'staking');
        assert.equal(tx.method, 'setPayee');
        assert.equal(tx.toHex(), orig.staking.setPayee({ Account: PAYEE }).toHex());
    }));
});
