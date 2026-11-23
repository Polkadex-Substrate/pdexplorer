// Locked balances redesign, work package 1: model, markup, copy and the .ui-action button
// (designer spec cto-team/plans/2026-11-22-locked-balances-redesign.md, section 7, tests 1 to 12).
//
//   lib/lock-rows.js          pure: every locked amount as a row (group, chip, line, action, Details)
//   lib/balance-locks-view.js the list, the in-row confirm and the pressed button (never `disabled`)
//
// Rendered in happy-dom from real model snapshots (lib/balance-locks.js describeAccountLocks); actions run
// through the real click handler with a fake submit. Addresses are made-up (0x11..11 and 0x22..22).

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describeAccountLocks } from '../lib/balance-locks.js';
import { lockActionSpec } from '../lib/lock-actions.js';
import { renderBalanceLocks, mountBalanceLocks } from '../lib/balance-locks-view.js';
import { lockDisplay, lockRowState, splitStaking, linkedRows, lockSummary, whenText, LOCK_COPY } from '../lib/lock-rows.js';
import { trackSignedTx } from '../lib/tx-submit.js';
import { buildTxModel, successCopy } from '../lib/tx-status.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { parseRules, rootProps } from './helpers/css-rules.js';
import { loadFixture, registryFromMetadata } from './helpers/extrinsic-builders.js';

const PDEX = 10n ** 12n;
const s = (v) => v.toString();
const P = (x) => BigInt(Math.round(x * 1e4)) * 10n ** 8n;
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const BLOCK = 1_000_000;
const PERIOD = 216000;
const ME = 'esm9mgCefMrQ2EbGGyMNXGAFA3vnRGDid7GheURpcFRTjyokX';
const OTHER = 'esmY9ZU5xPLb8urxWNBq89tPvEAG3CZm4KboeysfVgQuEw1io';
const same = (a, b) => String(a) === String(b);

function snap(over = {}) {
    return {
        address: ME, now: NOW,
        free: s(100n * PDEX), reserved: '0', frozen: '0', ed: s(PDEX),
        block: BLOCK, blockMs: 12000, bondingDays: 28, eraMs: DAY,
        locks: [], freezes: [], holds: [], reserves: [],
        staking: { bonded: false, total: '0', active: '0', unlocking: '0', chunks: [], currentEra: null, activeEra: null, activeEraStart: null, spans: 0, controller: null, stash: null },
        democracy: null, elections: null, identity: null, proxy: null,
        pallets: { vesting: false, ormlVesting: false },
        ...over
    };
}
const lock = (id, amount) => ({ id, amount: s(amount), reasons: 'All' });
const model = (over) => ({ address: ME, ...describeAccountLocks(snap(over)) });
const bonded = (total, chunks, over = {}) => ({ bonded: true, total: s(total), active: s(total), unlocking: '0', chunks, currentEra: 120, activeEra: 120, activeEraStart: NOW, spans: 0, controller: ME, stash: ME, ...over });

// The CEO's account: a council vote backing 5 candidates (15,000 PDEX and a 13.59 PDEX deposit), and a
// staking hold with one chunk still unbonding (280.0586 PDEX, about 2026-12-16, 24 days from now).
const CEO = () => model({
    free: s(20_000n * PDEX), reserved: s(5_000n * PDEX + P(13.59)), frozen: s(15_000n * PDEX),
    locks: [lock('phrelect', 15_000n * PDEX)], holds: [{ id: 'Staking.Staking', amount: s(5_000n * PDEX) }],
    staking: bonded(5_000n * PDEX, [{ value: s(P(280.0586)), era: 144 }]),
    elections: { voter: { votes: 5, stake: s(15_000n * PDEX), deposit: s(P(13.59)) }, candidacy: null }
});

const dom = (html) => { const w = new Window(); w.document.body.innerHTML = html; return w.document; };
const qa = (root, sel) => Array.from(root.querySelectorAll(sel));
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const rowByName = (doc, name) => { const li = qa(doc, '.lock-row').find(x => text(x.querySelector('.lock-name')) === name); assert.ok(li, `a row named "${name}"`); return li; };
// A row's own visible words, Details left out.
const visible = (li) => { const c = li.cloneNode(true); for (const d of qa(c, 'details')) d.remove(); return text(c); };

describe('(1) every row kind of section 4: chip role, icon, word, group and line', () => {
    const one = (over, pick = (d) => d.groups.flatMap(g => g.rows)[0]) => { const r = pick(lockDisplay(model(over), { canSign: true, connected: ME, now: NOW })); assert.ok(r, 'a row'); return r; };
    // [name, snapshot, kind, group, chip (role, icon, word), line]: section 4.2, verbatim.
    const DEP = ['neutral', 'bx-lock-alt', 'Deposit'], NR = ['neutral', 'bx-help-circle', 'Not recognised'], TEAM = ['wait', 'bx-error', 'Needs the team'];
    const cases = [
        ['K01 staked (hold, no chunks)', { holds: [{ id: 'Staking.Staking', amount: s(50n * PDEX) }], reserved: s(50n * PDEX), staking: bonded(50n * PDEX, []) }, 'K01', 'rest', ['neutral', 'bx-lock-alt', 'Staked'],
            'Earning staking rewards. To get it back: unstake, wait 28 days, then withdraw here.'],
        ['K04 leftover staking lock', { locks: [lock('staking ', 60n * PDEX)], frozen: s(60n * PDEX) }, 'K04', 'act', ['positive', 'bx-check', 'Can remove now'],
            'Nothing is staked, but an old staking lock was left behind. Removing it makes this PDEX transferable. Any account can send it, and the fee is refunded.'],
        ['K05 hold with no ledger', { holds: [{ id: 'Staking.Staking', amount: s(PDEX) }], reserved: s(PDEX) }, 'K05', 'rest', TEAM,
            'This hold has no staking record behind it, so you cannot release it today. Contact the Polkadex team.'],
        ['K09 council vote', { locks: [lock('phrelect', 9n * PDEX)], elections: { voter: { votes: 2, stake: s(9n * PDEX), deposit: '0' }, candidacy: null } }, 'K09', 'act', ['neutral', 'bx-lock-alt', 'Vote active'],
            'Backs 2 candidates. Removing the vote releases 9 PDEX.'],
        ['K10 voting deposit alone', { reserved: s(PDEX), elections: { voter: { votes: 1, stake: '0', deposit: s(PDEX) }, candidacy: null } }, 'K10', 'act', ['neutral', 'bx-link', 'Returns with the vote'],
            'Deposit for having a council vote on record. Returns when the vote is removed.'],
        ['K11 vesting', { locks: [lock('vesting ', PDEX)], pallets: { vesting: true } }, 'K11', 'rest', ['wait', 'bx-time-five', 'Unlocks over time'],
            'Unlocks gradually on a schedule. Releasing the unlocked part needs a wallet app; the explorer has no button for it yet.'],
        ['K12 vesting, no module', { locks: [lock('vesting ', PDEX)] }, 'K12', 'rest', TEAM,
            'The chain no longer has a vesting module, so you cannot remove this yourself. Contact the Polkadex team and mention the lock id shown in Details.'],
        ['K13 old module lock', { locks: [lock('ormlvest', PDEX)] }, 'K13', 'rest', TEAM,
            'Left over from a module that was removed in an earlier upgrade. You cannot remove it yourself. Contact the Polkadex team and mention the lock id shown in Details.'],
        ['K14 unknown lock', { locks: [lock('zzzzzzzz', PDEX)] }, 'K14', 'rest', NR,
            'The explorer does not recognise this lock. Only the module that set it can release it. Contact the Polkadex team and mention the lock id shown in Details.'],
        ['K15 freeze', { freezes: [{ id: 'X', amount: s(PDEX) }] }, 'K15', 'rest', NR, 'Placed by a chain module. Only that module can release it.'],
        ['K16 preimage', { holds: [{ id: 'Preimage.Preimage', amount: s(PDEX) }], reserved: s(PDEX) }, 'K16', 'rest', DEP,
            'Deposit for proposal data stored on chain. Returns when the data is removed: by you if it is unused, or after its proposal is enacted or dropped.'],
        ['K17 council motion', { holds: [{ id: 'Council.ProposalSubmission', amount: s(PDEX) }], reserved: s(PDEX) }, 'K17', 'rest', DEP,
            'Deposit for a council motion you submitted. Returns after the motion is closed or disapproved and the deposit is claimed back.'],
        ['K18 committee motion', { holds: [{ id: 'TechnicalCommittee.ProposalSubmission', amount: s(PDEX) }], reserved: s(PDEX) }, 'K18', 'rest', DEP,
            'Deposit for a technical committee motion you submitted. Returns after the motion is closed or disapproved and the deposit is claimed back.'],
        ['K19 session keys', { holds: [{ id: 'Session.Keys', amount: s(PDEX) }], reserved: s(PDEX) }, 'K19', 'rest', DEP, 'Deposit for registered validator session keys. Returns when the keys are removed.'],
        ['K20 delegated staking', { holds: [{ id: 'DelegatedStaking.StakingDelegation', amount: s(PDEX) }], reserved: s(PDEX) }, 'K20', 'rest', ['neutral', 'bx-lock-alt', 'Staked'],
            'Delegated to a staking agent. Withdraw from that agent; it returns after the unbonding period.'],
        ['K21 safe mode', { holds: [{ id: 'SafeMode.EnterOrExtend', amount: s(PDEX) }], reserved: s(PDEX) }, 'K21', 'rest', DEP,
            'Deposit for entering or extending safe mode. After safe mode ends, governance returns it or takes it as a penalty.'],
        ['K22 unknown hold', { holds: [{ id: 'X.Y', amount: s(PDEX) }], reserved: s(PDEX) }, 'K22', 'rest', NR, 'The explorer does not recognise this hold. Only the module that placed it can release it.'],
        ['K23 named reserve', { reserves: [{ id: 'abcdefgh', amount: s(PDEX) }], reserved: s(PDEX) }, 'K23', 'rest', NR, 'Reserved by a chain module. That module releases it.'],
        ['K24 identity', { identity: { deposit: s(PDEX), subsDeposit: '0', subs: 0 }, reserved: s(PDEX) }, 'K24', 'rest', DEP, 'Deposit for your on-chain identity. Returns when you clear your identity.'],
        ['K25 subs alone', { identity: { deposit: '0', subsDeposit: s(PDEX), subs: 2 }, reserved: s(PDEX) }, 'K25', 'rest', DEP, 'Deposit for 2 sub-accounts. Returns when you remove them.'],
        ['K26 proxies', { proxy: { deposit: s(PDEX), count: 1, announcementDeposit: '0' }, reserved: s(PDEX) }, 'K26', 'rest', DEP, 'Deposit for 1 proxy. Returns when you remove them.'],
        ['K27 announcements', { proxy: { deposit: '0', count: 0, announcementDeposit: s(PDEX) }, reserved: s(PDEX) }, 'K27', 'rest', DEP,
            'Deposit for announced proxy calls. Returns when the call is executed or the announcement is removed.'],
        ['K28 candidacy', { elections: { voter: null, candidacy: { role: 'Candidate', deposit: s(PDEX) } }, reserved: s(PDEX) }, 'K28', 'rest', ['neutral', 'bx-lock-alt', 'Bond'],
            'Bond for standing as a council candidate. Returns if you withdraw before the election. A candidate who loses the election loses this bond.'],
        ['K29 member', { elections: { voter: null, candidacy: { role: 'Member', deposit: s(PDEX) } }, reserved: s(PDEX) }, 'K29', 'rest', ['neutral', 'bx-lock-alt', 'Bond'],
            'Bond held while you are a council member. Returns when you renounce on the Council page, or when you leave the council and runner-up list at an election.'],
        ['K30 other deposits', { reserved: s(PDEX) }, 'K30', 'rest', ['neutral', 'bx-help-circle', 'Not itemised'],
            'Reserved PDEX the explorer could not itemise, for example a multisig deposit, a democracy proposal deposit, or a treasury or bounty bond. Each returns through the action that created it.']
    ];
    for (const [name, over, kind, group, chip, line] of cases) {
        test(name, () => {
            const r = one(over);
            assert.equal(r.kindId, kind);
            assert.equal(r.group, group);
            assert.deepEqual([r.chip.role, r.chip.icon, r.chip.word], chip, `${kind} chip`);
            assert.equal(r.line, line);
        });
    }
    const st = bonded(30n * PDEX, [{ value: s(15n * PDEX), era: 110 }, { value: s(5n * PDEX), era: 124 }]);
    test('K02 and K03, derived from the ledger: finished and still unbonding', () => {
        const d = lockDisplay(model({ holds: [{ id: 'Staking.Staking', amount: s(30n * PDEX) }], reserved: s(30n * PDEX), staking: st }), { canSign: true, connected: ME, now: NOW });
        const rows = d.groups.flatMap(g => g.rows);
        const k02 = rows.find(r => r.kindId === 'K02'), k03 = rows.find(r => r.kindId === 'K03');
        assert.ok(k02 && k03, 'a Finished unstaking and an Unstaking row');
        assert.deepEqual([k02.group, k02.chip.role, k02.chip.icon, k02.chip.word, k02.line], ['act', 'positive', 'bx-check', 'Ready to withdraw', 'The unbonding period is over. Withdraw it to move it out of staking.']);
        assert.deepEqual([k03.group, k03.chip.role, k03.chip.icon, k03.chip.word], ['rest', 'wait', 'bx-time-five', 'Until about 2026-11-26']);
        assert.equal(k03.line, 'You can withdraw it here from about 2026-11-26 (4 days).');
    });
    const dem = (votes, referenda, prior = { until: 0, amount: '0' }, extra = {}) => ({ locks: [lock('democrac', 40n * PDEX)], frozen: s(40n * PDEX),
        democracy: { delegating: false, lockingPeriod: PERIOD, votes, referenda, prior, ...extra } });
    const demRow = (over, canSign = true) => { const r = lockDisplay(model(over), { canSign, connected: canSign ? ME : null, now: NOW }).groups.flatMap(g => g.rows).find(x => x.kindId === 'K06'); assert.ok(r, 'a democracy row'); return r; };
    test('D1 delegating: neutral, Delegated, the undelegate sentence verbatim, B6', () => {
        const r = demRow({ locks: [lock('democrac', 30n * PDEX)], democracy: { delegating: true, target: OTHER, conviction: 'Locked1x', balance: s(30n * PDEX), prior: { until: 0, amount: '0' }, lockingPeriod: PERIOD } });
        assert.deepEqual([r.name, r.chip.role, r.chip.icon, r.chip.word, r.action.id], ['Delegated votes', 'neutral', 'bx-lock-alt', 'Delegated', 'B6']);
        assert.match(r.line, /^Undelegating keeps 30 PDEX locked until block 1,216,000 \(about \d{4}-\d{2}-\d{2}\); then unlock it here\.$/);
    });
    test('D2 can unlock now: positive, the unlock sentence, B2 (no removes) or B3 (removes and unlock)', () => {
        const r = demRow(dem([{ index: 4, aye: false, conviction: 'None', balance: s(40n * PDEX) }], { 4: { finished: true, approved: true, end: 900_000 } }));
        assert.deepEqual([r.chip.role, r.chip.icon, r.chip.word, r.action.id, r.action.label], ['positive', 'bx-check', 'Can unlock now', 'B3', 'Remove votes and unlock']);
        assert.equal(r.line, 'About 39 PDEX becomes spendable now.', 'the existential deposit stays');
        const u = demRow(dem([], {}, { until: BLOCK - 1, amount: s(40n * PDEX) }));
        assert.deepEqual([u.chip.word, u.action.id, u.action.label], ['Can unlock now', 'B2', 'Unlock voted PDEX']);
    });
    test('D3 removes only: amber, the date the lock stays to, B4', () => {
        const r = demRow(dem([{ index: 4, aye: false, conviction: 'None', balance: s(10n * PDEX) }], { 4: { finished: true, approved: true, end: 900_000 } }, { until: BLOCK + 7200, amount: s(40n * PDEX) }));
        assert.deepEqual([r.chip.role, r.chip.icon, r.action.id, r.action.label], ['wait', 'bx-time-five', 'B4', 'Remove finished votes']);
        assert.match(r.chip.word, /^Until about 2026-11-2\d$/);
        assert.match(r.line, /^Finished votes can be removed now\. That frees nothing yet: the lock stays until about 2026-11-2\d\.$/);
    });
    test('D4 the period unreadable: End date unknown, no action', () => {
        const r = demRow({ locks: [lock('democrac', 10n * PDEX)], frozen: s(10n * PDEX), democracy: { delegating: false, lockingPeriod: undefined, votes: [{ index: 7, aye: true, conviction: 'Locked6x', balance: s(10n * PDEX) }], referenda: { 7: { finished: true, approved: true, end: 900_000 } }, prior: { until: 0, amount: '0' } } });
        assert.deepEqual([r.chip.role, r.chip.icon, r.chip.word, r.line, r.action], ['wait', 'bx-error', 'End date unknown', 'The lock period could not be read, so the end date is unknown. Reload this section to see it.', null]);
    });
    test('D5 with D8: a running referendum, its child with B5; D6 and D7 children with their dates', () => {
        const r = demRow(dem([{ index: 9, aye: true, conviction: 'None', balance: s(40n * PDEX) }], { 9: { ongoing: true, end: 1_100_000 } }));
        assert.deepEqual([r.chip.role, r.chip.icon, r.group], ['wait', 'bx-time-five', 'act']);
        assert.equal(r.line, 'Locked by your democracy votes. It can be unlocked here after that date.');
        const c = r.children[0];
        assert.deepEqual([c.kindId, c.chip.word, c.line, c.action.id, c.action.label], ['D8', 'Until about 2026-12-06', 'Referendum #9 is still running. Your vote stays locked until it ends.', 'B5', 'Cancel vote on referendum #9']);
        const held = demRow(dem([{ index: 7, aye: true, conviction: 'Locked1x', balance: s(10n * PDEX) }], { 7: { finished: true, approved: true, end: 950_000 } }, { until: BLOCK + 100, amount: s(40n * PDEX) }), false);
        assert.deepEqual(held.children.map(x => x.kindId), ['D6', 'D7']);
        assert.equal(held.children[0].line, '40 PDEX, earlier vote lock (conviction lock).');
        assert.equal(held.children[1].line, '10 PDEX, referendum #7. Your side won with conviction. Remove this vote after its own lock ends; removing it earlier frees nothing.');
        assert.deepEqual([held.group, held.action], ['rest', null]);
        const none = demRow({ locks: [lock('democrac', 40n * PDEX)], frozen: s(40n * PDEX) });
        assert.deepEqual([none.chip.role, none.chip.icon, none.chip.word, none.line], ['neutral', 'bx-lock-alt', 'Vote lock', 'Locked by your democracy votes. It can be unlocked here once the lock period is over.']);
    });
    test('SUM1 to SUM4: one chip and one sentence, never a summed figure', () => {
        const sum = (over) => lockDisplay(model(over), { canSign: true, connected: ME, now: NOW }).summary;
        const one = sum({ locks: [lock('staking ', 60n * PDEX)], frozen: s(60n * PDEX) });
        assert.ok(one, 'a summary line');
        assert.deepEqual([one.id, one.chip.role, one.chip.icon, one.chip.word, one.text], ['SUM1', 'positive', 'bx-check', '1 ready now', 'Ready now: 60 PDEX, leftover staking lock.']);
        const two = sum({ locks: [lock('staking ', 60n * PDEX), lock('democrac', 40n * PDEX)], frozen: s(60n * PDEX), democracy: { delegating: false, lockingPeriod: PERIOD, votes: [], referenda: {}, prior: { until: BLOCK - 1, amount: s(40n * PDEX) } } });
        assert.deepEqual([two.id, two.chip.word, two.text], ['SUM2', '2 ready now', '2 items are ready now. They are listed first.']);
        const next = sum({ holds: [{ id: 'Staking.Staking', amount: s(30n * PDEX) }], reserved: s(30n * PDEX), staking: bonded(30n * PDEX, [{ value: s(5n * PDEX), era: 124 }]) });
        assert.deepEqual([next.id, next.chip.role, next.chip.icon, next.chip.word, next.text], ['SUM3', 'neutral', 'bx-time-five', 'Nothing ready yet', 'Next: 5 PDEX, about 2026-11-26.']);
        const quiet = sum({ reserved: s(PDEX), identity: { deposit: s(PDEX), subsDeposit: '0', subs: 0 } });
        assert.deepEqual([quiet.id, quiet.chip.icon, quiet.text], ['SUM4', 'bx-lock-alt', 'Nothing here needs you right now.']);
        assert.ok(lockSummary({ groups: [] }) == null);
    });
    test('whenText: about a UTC day, with the days left, or under a day', () => {
        assert.equal(whenText(NOW + 24 * DAY, NOW), 'about 2026-12-16 (24 days)');
        assert.equal(whenText(NOW + DAY, NOW), 'about 2026-11-23 (1 day)');
        assert.equal(whenText(NOW + 3600000, NOW), 'about 2026-11-22 (under a day)');
        assert.ok(whenText(null, NOW) == null);
    });
});

describe('(2) the CEO\'s account', () => {
    const render = (page, canSign = true) => dom(renderBalanceLocks(CEO(), { helpIcon: () => '', canSign, connected: canSign ? ME : null, page, unstake: true, now: NOW }));
    test('G1 holds Council vote with the deposit as its child and Remove council vote; Staked has Unstake PDEX on My Account only', () => {
        const d = render('wallet');
        const act = d.querySelector('[data-lock-group="act"]');
        assert.ok(act, 'the group of rows you can act on');
        assert.equal(text(act.querySelector('h3')), 'You can act on these');
        const council = rowByName(d, 'Council vote');
        assert.equal(council.closest('[data-lock-group]').getAttribute('data-lock-group'), 'act');
        assert.equal(text(council.querySelector('.lock-amount')), '15,000 PDEX');
        assert.equal(text(council.querySelector('.lock-line')), 'Backs 5 candidates. Removing the vote releases 15,000 PDEX and the 13.59 PDEX deposit together.');
        const child = council.querySelector('.lock-children .lock-child');
        assert.equal(text(child.querySelector('.lock-child-head')), '+ also 13.59 PDEX Voting deposit');
        assert.equal(text(child.querySelector('.ui-chip')), 'Returns with the vote');
        assert.ok(child.querySelector('.ui-chip .bx-link'));
        const b7 = council.querySelector('.lock-row-action .ui-action');
        assert.equal(text(b7), 'Remove council vote');
        assert.equal(b7.getAttribute('data-lock-action'), 'elections-remove');
        assert.equal(b7.getAttribute('aria-describedby'), council.querySelector('h4').id);
        assert.equal(qa(d, '.lock-row').filter(li => /Voting deposit/.test(text(li.querySelector('.lock-name')))).length, 0, 'the deposit is not a row of its own');
        const staked = rowByName(d, 'Staked');
        assert.equal(staked.closest('[data-lock-group]').getAttribute('data-lock-group'), 'act');
        assert.equal(text(staked.querySelector('.lock-amount')), '4,719.9414 PDEX');
        const b9 = staked.querySelector('.ui-action');
        assert.equal(text(b9), 'Unstake PDEX');
        assert.equal(b9.getAttribute('data-lock-open'), 'unstake');
        const looked = render('account');
        assert.ok(rowByName(looked, 'Staked').querySelector('.ui-action') == null, 'no Unstake on the account page');
        assert.equal(rowByName(looked, 'Staked').closest('[data-lock-group]').getAttribute('data-lock-group'), 'rest');
    });
    test('Unstaking is in G2 with its date; the summary says what is next', () => {
        const d = render('wallet');
        const u = rowByName(d, 'Unstaking');
        assert.equal(u.closest('[data-lock-group]').getAttribute('data-lock-group'), 'rest');
        assert.equal(text(u.querySelector('.lock-amount')), '280.0586 PDEX');
        assert.equal(text(u.querySelector('.ui-chip')), 'Until about 2026-12-16');
        assert.equal(text(u.querySelector('.lock-line')), 'You can withdraw it here from about 2026-12-16 (24 days).');
        assert.equal(text(d.querySelector('[data-lock-group="rest"] h3')), 'Nothing to do right now');
        assert.equal(text(d.querySelector('.lock-summary')), 'Nothing ready yet Next: 280.0586 PDEX, about 2026-12-16.');
    });
    test('no row shows phrelect, Staking.Staking or a call name outside Details; Details still holds the id', () => {
        const d = render('wallet');
        for (const li of qa(d, '.lock-row')) assert.doesNotMatch(visible(li), /phrelect|Staking\.Staking|removeVoter|elections\.|withdrawUnbonded|\(\)/, text(li.querySelector('.lock-name')));
        const council = rowByName(d, 'Council vote');
        assert.equal(text(council.querySelector('details summary')), 'Details for Council vote');
        assert.match(text(council.querySelector('details')), /On chain: lock phrelect/);
        assert.match(text(rowByName(d, 'Staked').querySelector('details')), /On chain: hold Staking\.Staking/);
    });
});

describe('(3) splitStaking: the parts always add up to the chain amount', () => {
    const item = { kind: 'hold', id: 'Staking.Staking', amount: s(100n * PDEX) };
    const sum = (rows) => rows.reduce((a, r) => a + BigInt(r.amount), 0n);
    test('ready, unbonding and the rest, for many splits', () => {
        for (const [ready, pending] of [[0n, [5n]], [10n, []], [10n, [5n, 7n]], [0n, [100n]], [60n, [40n]], [1n, [1n, 1n, 1n]]]) {
            const w = { withdrawable: s(ready * PDEX), pending: pending.map((v, i) => ({ value: s(v * PDEX), era: 130 + i, eta: NOW + (i + 1) * DAY })) };
            const rows = splitStaking(item, w);
            assert.equal(sum(rows), 100n * PDEX, `ready ${ready} pending ${pending}`);
            assert.ok(rows.every(r => BigInt(r.amount) > 0n), 'no empty part');
            assert.deepEqual(rows.map(r => r.kindId), [...(ready ? ['K02'] : []), ...(pending.length ? ['K03'] : []), ...(ready + pending.reduce((a, b) => a + b, 0n) < 100n ? ['K01'] : [])]);
        }
    });
    test('not split when the two exceed the row, or there is no ledger schedule', () => {
        assert.deepEqual(splitStaking(item, { withdrawable: s(90n * PDEX), pending: [{ value: s(20n * PDEX), era: 130 }] }).map(r => [r.kindId, r.amount]), [['K01', s(100n * PDEX)]]);
        assert.deepEqual(splitStaking(item, null).map(r => [r.kindId, r.amount]), [['K01', s(100n * PDEX)]]);
    });
    test('with both a staking lock and a staking hold, only the hold is split', () => {
        const d = lockDisplay(model({ locks: [lock('staking ', 30n * PDEX)], frozen: s(30n * PDEX), holds: [{ id: 'Staking.Staking', amount: s(30n * PDEX) }], reserved: s(30n * PDEX),
            staking: bonded(30n * PDEX, [{ value: s(10n * PDEX), era: 124 }]) }), { canSign: true, connected: ME, now: NOW });
        const rows = d.groups.flatMap(g => g.rows).map(r => [r.key, r.kindId, r.amount]);
        assert.deepEqual(rows.filter(r => r[0].startsWith('lock:')), [['lock:staking ', 'K01', s(30n * PDEX)]]);
        assert.deepEqual(rows.filter(r => r[0].startsWith('hold:')).map(r => r[1]).sort(), ['K01', 'K03']);
    });
});

describe('(4) linkedRows: a deposit folded under the row that releases it', () => {
    test('K10 under K09, K25 under K24; an orphan child stays a row of its own', () => {
        const rows = linkedRows([{ kindId: 'K09', key: 'a' }, { kindId: 'K10', key: 'b' }, { kindId: 'K24', key: 'c' }, { kindId: 'K25', key: 'd' }]);
        assert.deepEqual(rows.map(r => [r.key, (r.children || []).map(c => c.key)]), [['a', ['b']], ['c', ['d']]]);
        assert.deepEqual(linkedRows([{ kindId: 'K10', key: 'b' }]).map(r => r.key), ['b']);
    });
    test('the voting deposit alone (no phrelect lock): a G1 row with Remove council vote', () => {
        const d = lockDisplay(model({ reserved: s(PDEX), elections: { voter: { votes: 1, stake: '0', deposit: s(PDEX) }, candidacy: null } }), { canSign: true, connected: ME, now: NOW });
        assert.equal(d.groups.length, 1, 'one group');
        const r = d.groups[0].rows[0];
        assert.deepEqual([d.groups[0].id, r.kindId, r.action.id, r.action.label], ['act', 'K10', 'B7', 'Remove council vote']);
    });
    test('the sub-account deposit under the identity deposit, chip "Returns with the identity"', () => {
        const d = lockDisplay(model({ reserved: s(3n * PDEX), identity: { deposit: s(PDEX), subsDeposit: s(2n * PDEX), subs: 2 } }), { canSign: true, connected: ME, now: NOW });
        const rows = d.groups.flatMap(g => g.rows);
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].children.map(c => [c.kindId, c.chip.icon, c.chip.word, c.line]), [['K25', 'bx-link', 'Returns with the identity', 'Deposit for 2 sub-accounts. Returns when you remove them.']]);
    });
    // The fold is safe only if clearing the identity returns the sub-account deposit too: the runtime says so.
    test('the runtime: identity.clear_identity returns all deposits, the sub-accounts\' included (mainnet 394 metadata)', () => {
        const reg = registryFromMetadata(loadFixture('metadata-mainnet-394.json').metadata);
        const pallet = reg.metadata.pallets.find(p => p.name.toString() === 'Identity');
        const v = reg.lookup.getSiType(pallet.calls.unwrap().type).def.asVariant.variants.find(x => x.name.toString() === 'clear_identity');
        const docs = v.docs.map(d => d.toString()).join(' ');
        assert.match(docs, /Clear an account's identity info and all sub-accounts and return all deposits\./);
    });
});

describe('(5) order: green, neutral, amber in G1; dated amber first in G2', () => {
    test('G1 and G2 orders', () => {
        const d = lockDisplay(model({
            locks: [lock('democrac', 40n * PDEX), lock('phrelect', 9n * PDEX), lock('staking ', 60n * PDEX), lock('zzzzzzzz', PDEX), lock('vesting ', PDEX)],
            frozen: s(60n * PDEX), reserved: s(2n * PDEX), identity: { deposit: s(PDEX), subsDeposit: '0', subs: 0 },
            democracy: { delegating: false, lockingPeriod: PERIOD, votes: [{ index: 9, aye: true, conviction: 'None', balance: s(40n * PDEX) }], referenda: { 9: { ongoing: true, end: 1_100_000 } }, prior: { until: 0, amount: '0' } },
            elections: { voter: { votes: 1, stake: s(9n * PDEX), deposit: '0' }, candidacy: null },
            holds: [{ id: 'Staking.Staking', amount: s(PDEX) }]
        }), { canSign: true, connected: ME, now: NOW });
        assert.equal(d.groups.length, 2, 'both groups');
        const [act, rest] = d.groups;
        assert.deepEqual(act.rows.map(r => r.kindId), ['K04', 'K09', 'K06']);
        assert.deepEqual(rest.rows.map(r => r.kindId), ['K24', 'K14', 'K12', 'K05'], 'the team and not-recognised rows last, in model order');
        const dated = lockDisplay(model({ holds: [{ id: 'Staking.Staking', amount: s(30n * PDEX) }], reserved: s(31n * PDEX), identity: { deposit: s(PDEX), subsDeposit: '0', subs: 0 },
            locks: [lock('vesting ', PDEX)], pallets: { vesting: true }, staking: bonded(30n * PDEX, [{ value: s(5n * PDEX), era: 124 }]) }), { canSign: true, connected: ME, now: NOW });
        assert.deepEqual(dated.groups.find(g => g.id === 'rest').rows.map(r => r.kindId), ['K03', 'K11', 'K01', 'K24']);
    });
});

// Every kind at once, own account connected.
const EVERYTHING = () => model({
    free: s(1000n * PDEX), frozen: s(60n * PDEX), reserved: s(40n * PDEX),
    locks: [lock('staking ', 60n * PDEX), lock('phrelect', 9n * PDEX), lock('vesting ', PDEX), lock('ormlvest', PDEX), lock('zzzzzzzz', PDEX), lock('democrac', 40n * PDEX)],
    freezes: [{ id: 'F', amount: s(PDEX) }],
    holds: ['Preimage.Preimage', 'Council.ProposalSubmission', 'TechnicalCommittee.ProposalSubmission', 'Session.Keys', 'DelegatedStaking.StakingDelegation', 'SafeMode.EnterOrExtend', 'X.Y'].map(id => ({ id, amount: s(PDEX) })),
    reserves: [{ id: 'abcdefgh', amount: s(PDEX) }],
    identity: { deposit: s(PDEX), subsDeposit: s(PDEX), subs: 2 }, proxy: { deposit: s(PDEX), count: 1, announcementDeposit: s(PDEX) },
    democracy: { delegating: false, lockingPeriod: PERIOD, votes: [{ index: 9, aye: true, conviction: 'None', balance: s(40n * PDEX) }, { index: 4, aye: false, conviction: 'None', balance: s(30n * PDEX) }],
        referenda: { 9: { ongoing: true, end: 1_100_000 }, 4: { finished: true, approved: true, end: 900_000 } }, prior: { until: 0, amount: '0' } },
    elections: { voter: { votes: 3, stake: s(9n * PDEX), deposit: s(PDEX) }, candidacy: { role: 'Candidate', deposit: s(PDEX) } }
});
// B1 to B9, section 4.4, verbatim.
const LABELS = ['Withdraw unstaked PDEX', 'Unlock voted PDEX', 'Remove votes and unlock', 'Remove finished votes', 'Cancel vote on referendum #{n}', 'Undelegate votes', 'Remove council vote', 'Remove leftover staking lock', 'Unstake PDEX'];
const labelOk = (l) => LABELS.some(x => new RegExp(`^${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{n\\}', '\\d+')}$`).test(l));

describe('(6) the rendered panel', () => {
    test('no table; every action is one .ui-action with one icon and a B1 to B9 label; no primary; every chip has an icon and a word', () => {
        for (const [canSign, connected] of [[true, ME], [false, OTHER], [false, null]]) {
            const d = dom(renderBalanceLocks(EVERYTHING(), { helpIcon: () => '', canSign, connected, page: 'wallet', unstake: true, now: NOW }));
            assert.equal(qa(d, 'table, [role="table"]').length, 0);
            const buttons = qa(d, '.balance-locks button');
            assert.ok(buttons.length >= (canSign ? 4 : connected ? 1 : 0), 'actions drawn');
            for (const b of buttons) {
                assert.ok(b.classList.contains('ui-action'), b.outerHTML);
                assert.equal(qa(b, 'i.bx').length, 1, 'one icon');
                assert.equal(b.querySelector('i.bx').getAttribute('aria-hidden'), 'true');
                assert.ok(labelOk(text(b)), `label "${text(b)}"`);
                assert.doesNotMatch(text(b), /\d[\d,.]* PDEX/, 'no amount on a button (Q2)');
                assert.equal(b.hasAttribute('disabled'), false);
            }
            assert.equal(qa(d, '.validate-primary, .staking-download-btn, .lock-action-btn, [class*="gradient"]').length, 0);
            for (const c of qa(d, '.ui-chip')) {
                assert.ok(c.querySelector('i.bx'), `chip without icon: ${c.outerHTML}`);
                assert.ok(text(c).length > 0, 'chip without a word');
            }
            assert.ok(d.querySelector('section.balance-locks[aria-labelledby="balance-locks-h"] h2#balance-locks-h'));
            for (const g of qa(d, '.lock-group')) assert.ok(g.querySelector('h3') && g.querySelector('ul.lock-list > li'));
        }
    });
    test('the empty state: the green tile and the unchanged sentence', () => {
        const d = dom(renderBalanceLocks(model({}), { helpIcon: () => '' }));
        assert.equal(text(d.querySelector('.lock-empty')), 'Nothing is locked or reserved on this account.');
        assert.ok(d.querySelector('.lock-empty .ui-tile.is-green.is-sm .bx-check'));
        assert.ok(d.querySelector('.lock-summary') == null);
    });
});

// A mounted panel with a fake submit: what the click handler does.
async function mounted(m, { connected = ME, submit = async () => {} } = {}) {
    const w = new Window({ url: 'https://explorer.test/wallet' });
    const doc = w.document;
    doc.body.innerHTML = '<div id="slot"></div>';
    const el = doc.getElementById('slot');
    const calls = [];
    await mountBalanceLocks(el, ME, { fetchJson: async () => m, helpIcon: () => '', page: 'wallet',
        actions: { submit: async (o) => { calls.push(o); return submit(o); }, connected: () => connected, isSame: same, api: () => ({}) } });
    const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
    const key = (k) => new w.KeyboardEvent('keydown', { key: k, bubbles: true });
    return { w, doc, el, calls, flush, key };
}
const DELEGATING = () => model({ locks: [lock('democrac', 30n * PDEX)], frozen: s(30n * PDEX),
    democracy: { delegating: true, target: OTHER, conviction: 'Locked1x', balance: s(30n * PDEX), prior: { until: 0, amount: '0' }, lockingPeriod: PERIOD } });
const RUNNING = () => model({ locks: [lock('democrac', 40n * PDEX)], frozen: s(40n * PDEX),
    democracy: { delegating: false, lockingPeriod: PERIOD, votes: [{ index: 9, aye: true, conviction: 'None', balance: s(40n * PDEX) }], referenda: { 9: { ongoing: true, end: 1_100_000 } }, prior: { until: 0, amount: '0' } } });

describe('(7) Remove council vote, Cancel vote and Undelegate ask once inside the row', () => {
    const cases = [
        ['B7', CEO, '[data-lock-action="elections-remove"]', 'Remove your council vote? Your 5 candidates lose your backing of 15,000 PDEX. You can vote again later, which locks PDEX and a deposit again.', 'Remove council vote', 'Keep my vote'],
        ['B5', RUNNING, '[data-lock-action="democracy-cancel"][data-ref="9"]', 'Cancel your vote on referendum #9? It stops counting at once. About 39 PDEX becomes spendable now.', 'Cancel vote on referendum #9', 'Keep my vote'],
        ['B6', DELEGATING, '[data-lock-action="democracy-undelegate"]', null, 'Undelegate votes', 'Keep delegating']
    ];
    for (const [id, m, sel, sentence, confirmLabel, keepLabel] of cases) {
        test(`${id}: the first press submits nothing and shows the consequence; keep and Escape restore; the confirm submits once`, async () => {
            const p = await mounted(m());
            const first = p.el.querySelector(sel);
            first.focus();
            first.click();
            await p.flush();
            assert.equal(p.calls.length, 0, 'no wallet on the first press');
            const strip = p.el.querySelector('.lock-confirm');
            assert.ok(strip && strip.classList.contains('ui-panel') && strip.classList.contains('is-warn'));
            assert.equal(strip.getAttribute('role'), 'group');
            assert.equal(strip.getAttribute('tabindex'), '-1');
            assert.ok(p.doc.activeElement === strip, 'focus on the strip');
            const said = text(p.doc.getElementById(strip.getAttribute('aria-labelledby')));
            if (sentence) assert.equal(said, sentence);
            else assert.match(said, /^Undelegate your votes\? Your delegate stops voting with your PDEX\. Undelegating keeps 30 PDEX locked until block 1,216,000 \(about \d{4}-\d{2}-\d{2}\); then unlock it here\.$/);
            assert.equal(strip.closest('li').querySelector('.lock-row-action').hidden, true, 'the action is swapped for the strip');
            const keep = strip.querySelector('.validate-text-btn');
            assert.equal(text(keep), keepLabel);
            keep.click();
            assert.ok(p.el.querySelector('.lock-confirm') == null);
            assert.ok(p.doc.activeElement === p.el.querySelector(sel), 'focus back on the action');
            p.el.querySelector(sel).click();
            p.el.querySelector('.lock-confirm').dispatchEvent(p.key('Escape'));
            assert.ok(p.el.querySelector('.lock-confirm') == null, 'Escape restores');
            assert.ok(p.doc.activeElement === p.el.querySelector(sel));
            p.el.querySelector(sel).click();
            const yes = p.el.querySelector('.lock-confirm .ui-action');
            assert.equal(text(yes), confirmLabel);
            yes.click();
            yes.click();
            await p.flush();
            assert.equal(p.calls.length, 1, 'one submit');
        });
    }
    test('collect actions go straight to the wallet', async () => {
        const p = await mounted(model({ locks: [lock('staking ', 60n * PDEX)], frozen: s(60n * PDEX) }), { connected: OTHER });
        p.el.querySelector('[data-lock-action="migrate-currency"]').click();
        await p.flush();
        assert.equal(p.calls.length, 1);
        assert.ok(p.el.querySelector('.lock-confirm') == null);
    });
});

describe('(8) a viewer who cannot sign: no button, the sentence that says why', () => {
    test('V1 on a looked-up account; no confirm strips', () => {
        const d = dom(renderBalanceLocks(CEO(), { helpIcon: () => '', canSign: false, connected: OTHER, now: NOW }));
        assert.equal(qa(d, '.ui-action').length, 0);
        assert.equal(text(d.querySelector('[data-lock-group="act"] h3')), 'The owner can act on these');
        const c = rowByName(d, 'Council vote').querySelector('.lock-connect');
        assert.equal(text(c), 'Connect this account to do this.');
        assert.ok(c.querySelector('.bx-wallet'));
    });
    test('the leftover lock: V2 with no wallet, B8 itself with any wallet', () => {
        const m = model({ locks: [lock('staking ', 60n * PDEX)], frozen: s(60n * PDEX) });
        const none = dom(renderBalanceLocks(m, { helpIcon: () => '', canSign: false, connected: null }));
        assert.equal(text(none.querySelector('.lock-connect')), 'Connect any wallet to remove it. It does not have to be this account.');
        assert.equal(qa(none, '.ui-action').length, 0);
        const any = dom(renderBalanceLocks(m, { helpIcon: () => '', canSign: false, connected: OTHER }));
        assert.equal(text(any.querySelector('.ui-action')), 'Remove leftover staking lock');
        assert.equal(text(any.querySelector('.lock-hint')), 'Anyone can submit this; the fee is refunded.');
    });
    test('Finished unstaking with another controller: V3 names it; the controller itself gets B1 and the hint', () => {
        const m = model({ holds: [{ id: 'Staking.Staking', amount: s(30n * PDEX) }], reserved: s(30n * PDEX), staking: bonded(30n * PDEX, [{ value: s(15n * PDEX), era: 110 }], { controller: OTHER }) });
        const owner = dom(renderBalanceLocks(m, { helpIcon: () => '', canSign: true, connected: ME }));
        assert.equal(text(rowByName(owner, 'Finished unstaking').querySelector('.lock-connect')), 'Only the controller account esmY9ZU5...uEw1io can withdraw. Connect it to continue.');
        const ctl = dom(renderBalanceLocks(m, { helpIcon: () => '', canSign: false, connected: OTHER }));
        const row = rowByName(ctl, 'Finished unstaking');
        assert.equal(text(row.querySelector('.ui-action')), 'Withdraw unstaked PDEX');
        assert.equal(text(row.querySelector('.lock-hint')), 'Signed by the controller account.');
        const visitor = dom(renderBalanceLocks(model({ holds: [{ id: 'Staking.Staking', amount: s(30n * PDEX) }], reserved: s(30n * PDEX), staking: bonded(30n * PDEX, [{ value: s(15n * PDEX), era: 110 }]) }), { helpIcon: () => '', canSign: false, connected: OTHER }));
        assert.equal(text(rowByName(visitor, 'Finished unstaking').querySelector('.lock-connect')), 'Connect this account to do this.');
    });
});

describe('(9) the pressed button keeps its icon and focus and is never disabled (F5)', () => {
    test('busy while the wallet is open, held for the others, back to rest after a failure', async () => {
        let job = null;
        const p = await mounted(CEO(), { submit: (o) => new Promise((res) => { job = { o, res }; }) });
        p.el.querySelector('[data-lock-action="elections-remove"]').click();
        const yes = p.el.querySelector('.lock-confirm .ui-action');
        assert.ok(yes, 'the confirm strip and its action');
        yes.focus();
        yes.click();
        await p.flush();
        assert.equal(p.calls.length, 1);
        assert.equal('button' in p.calls[0], false, 'no button handed to submit');
        assert.equal('idleText' in p.calls[0], false);
        assert.equal(yes.getAttribute('aria-busy'), 'true');
        assert.equal(yes.getAttribute('aria-disabled'), 'true');
        assert.equal(yes.disabled, false);
        assert.ok(yes.querySelector('i.bx-loader-alt.bx-spin'));
        assert.equal(text(yes), 'Remove council vote', 'label unchanged');
        assert.ok(p.doc.activeElement === yes, 'focus stays');
        const other = p.el.querySelector('[data-lock-open="unstake"]') || p.el.querySelector('.ui-action:not([aria-busy])');
        for (const b of qa(p.el, '.ui-action')) if (b !== yes) { assert.equal(b.getAttribute('aria-disabled'), 'true'); assert.equal(b.getAttribute('title'), 'Another action is in progress.'); assert.equal(b.disabled, false); }
        void other;
        job.o.onError('Nope.');
        job.res();
        await p.flush();
        assert.equal(yes.disabled, false);
        assert.equal(yes.hasAttribute('aria-busy'), false);
        assert.equal(yes.hasAttribute('aria-disabled'), false);
        assert.ok(yes.querySelector('i.bx.bx-user-minus'), 'its own icon back');
        assert.equal(text(yes), 'Remove council vote');
        assert.ok(p.doc.activeElement === yes);
        for (const b of qa(p.el, '.ui-action')) assert.equal(b.hasAttribute('aria-disabled'), false);
    });
    // F5's other half: tx-submit runs the whole path with no button (its `button` parameter is optional).
    test('lib/tx-submit.js runs without a button: busy, In block, Finalized, onSuccess once, nothing thrown', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const api = { registry: {}, on() {}, off() {}, rpc: { chain: { getHeader: async () => ({ number: { toNumber: () => 42 } }) } } };
            let cb = null, ok = 0;
            const errors = [];
            const run = trackSignedTx({ api, action: { id: 'a', key: 'elections.removeVoter', params: {} }, show: (a, st, ev, err, ex) => buildTxModel(a, st, ev, err, ex),
                onError: (t) => errors.push(t), onSuccess: () => { ok++; }, onStage: () => {} });
            run.start();
            await run.send({ signAndSend: (addr, o, f) => { cb = f; return Promise.resolve(() => {}); } }, ME, {});
            const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
            const evs = [{ event: { section: 'system', method: 'ExtrinsicSuccess', data: [] } }];
            cb({ status: { type: 'Ready' }, events: [], txHash: { toHex: () => '0x' + 'ab'.repeat(32) } }); await flush();
            cb({ status: { type: 'InBlock', asInBlock: '0xb1' }, events: evs, txHash: { toHex: () => '0x' + 'ab'.repeat(32) } }); await flush();
            cb({ status: { type: 'Finalized', asFinalized: '0xb1' }, events: evs, txHash: { toHex: () => '0x' + 'ab'.repeat(32) } }); await flush();
            assert.equal(ok, 1);
            assert.deepEqual(errors, []);
        } finally { mock.timers.reset(); }
    });
});

describe('(10) the copy: LOCK_COPY', () => {
    const strings = [];
    const walk = (o) => { for (const v of Object.values(o)) { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') walk(v); } };
    test('no pallet or call name, no "below", no exclamation mark, no em or en dash', () => {
        walk(LOCK_COPY);
        assert.ok(strings.length > 100);
        for (const t of strings) {
            assert.doesNotMatch(t, /\b[a-z]+[A-Z]?[a-z]*\.[a-z][A-Za-z]+\b|\(\)|phrelect|democrac\b|Staking\.Staking|withdrawUnbonded|removeVoter|migrateCurrency|clearIdentity/, t);
            assert.doesNotMatch(t, /\bbelow\b/, t);
            assert.doesNotMatch(t, /!/, t);
            assert.doesNotMatch(t, /[–—]/, t);
        }
    });
    test('frozen all the way down', () => {
        const frozen = (o) => Object.isFrozen(o) && Object.values(o).every(v => !v || typeof v !== 'object' || frozen(v));
        assert.ok(frozen(LOCK_COPY));
    });
    test('the view writes no sentence that points at a button "below"', () => {
        const d = dom(renderBalanceLocks(EVERYTHING(), { helpIcon: () => '', canSign: true, connected: ME, page: 'wallet', now: NOW }));
        assert.ok(qa(d, '.lock-row').length >= 10, 'every kind drawn as a row');
        for (const li of qa(d, '.lock-row')) assert.doesNotMatch(visible(li), /\bbelow\b/);
    });
});

// ── colour maths (WCAG 2.1), alpha composited on the surface, as test/colour-roles.test.js ──
const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const RULES = parseRules(CSS);
const find = (sel, prop, media = '') => { let v; for (const r of RULES) if ((media ? media.test(r.media) : !r.media) && r.selectors.includes(sel) && prop in r.decls) v = r.decls[prop]; return v; };
const SURFACE = [0x12, 0x12, 0x1A];
function parseColour(v, props) {
    v = String(v).trim();
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (ref) return parseColour(props[ref[1]], props);
    let m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(v);
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}
const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]));
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe('(11) the .ui-action button in the real stylesheet', () => {
    test('44 px high at every width (outside any media query), the spec look, hover and focus', () => {
        assert.equal(find('.ui-action', 'min-height'), '44px');
        assert.equal(find('.ui-action', 'padding'), '0 16px');
        assert.equal(find('.ui-action', 'border-radius'), 'var(--radius-sm)');
        assert.equal(find('.ui-action', 'font-size'), '0.9rem');
        assert.equal(find('.ui-action', 'font-weight'), '600');
        assert.equal(find('.ui-action', 'gap'), '8px');
        assert.equal(find('.ui-action', 'background'), 'var(--accent-violet-tint)');
        assert.equal(find('.ui-action', 'border'), '1px solid var(--accent-violet-text)');
        assert.equal(find('.ui-action', 'color'), 'var(--text-primary)');
        assert.equal(find('.ui-action .bx', 'color'), 'var(--accent-violet-text)');
        assert.equal(find('.ui-action .bx', 'font-size'), '18px');
        assert.equal(find('.ui-action:hover', 'box-shadow'), '0 0 0 3px var(--accent-violet-tint)');
        assert.equal(find('.ui-action:focus-visible', 'outline'), '2px solid var(--brand-primary)');
        assert.equal(find('.ui-action[aria-disabled="true"]:not([aria-busy="true"])', 'opacity'), '0.55');
        assert.equal(find('.ui-action', 'border', /forced-colors/), '1px solid ButtonText');
        for (const r of RULES) if (r.media && r.selectors.includes('.ui-action')) assert.ok(!('min-height' in r.decls) || r.decls['min-height'] === '44px', 'no media query shrinks it');
        assert.equal(RULES.filter(r => r.selectors.some(x => /\.lock-action-btn|\.balance-locks-badge\.balance-locks-legacy|\.lock-withdraw/.test(x))).length, 0, 'the old grey button and table parts are gone');
    });
    test('contrast, recomputed: label 16.3:1 on the tint, border 6.8:1 on the surface and 5.9:1 on the tint', () => {
        const { props } = rootProps(CSS);
        const tint = over(parseColour('var(--accent-violet-tint)', props), SURFACE);
        const border = parseColour('var(--accent-violet-text)', props).slice(0, 3);
        const label = parseColour('var(--text-primary)', props).slice(0, 3);
        assert.equal(ratio(label, tint).toFixed(1), '16.3');
        assert.equal(ratio(border, SURFACE).toFixed(1), '6.8');
        assert.equal(ratio(border, tint).toFixed(1), '5.9');
        assert.ok(ratio(label, tint) >= 4.5 && ratio(border, SURFACE) >= 3 && ratio(border, tint) >= 3);
    });
});

describe('(12) the status card uses the button\'s words', () => {
    test('lockActionSpec labels equal the button labels (B1 to B8)', () => {
        for (const [id, label] of [['B1', 'Withdraw unstaked PDEX'], ['B2', 'Unlock voted PDEX'], ['B5', 'Cancel vote on referendum #{n}'], ['B6', 'Undelegate votes'], ['B7', 'Remove council vote']]) assert.equal((LOCK_COPY[id] || {}).label, label, id);
        const w = { withdrawable: s(15n * PDEX), readyCount: 1, pending: [], spans: 0, signer: ME, controller: ME, controllerDiffers: false };
        assert.equal(lockActionSpec('withdraw', { actions: { withdraw: w } }, ME, { connected: ME, isSame: same }).label, 'Withdraw unstaked PDEX');
        const dem = (d) => ({ actions: { democracy: { mode: 'direct', remove: [], cancel: [], unlock: false, rejigFirst: false, lockNow: '0', lockAfter: '0', freed: '0', ...d } } });
        assert.equal(lockActionSpec('democracy-unlock', dem({ unlock: true }), ME, { connected: ME, isSame: same }).label, 'Unlock voted PDEX');
        assert.equal(lockActionSpec('democracy-unlock', dem({ unlock: true, remove: [{ index: 4 }] }), ME, { connected: ME, isSame: same }).label, 'Remove votes and unlock');
        assert.equal(lockActionSpec('democracy-unlock', dem({ remove: [{ index: 4 }] }), ME, { connected: ME, isSame: same }).label, 'Remove finished votes');
        assert.equal(lockActionSpec('democracy-cancel', dem({ cancel: [{ index: 9, end: 1 }] }), ME, { connected: ME, isSame: same, ref: 9 }).label, 'Cancel vote on referendum #9');
        assert.equal(lockActionSpec('democracy-undelegate', { actions: { democracy: { mode: 'delegating', undelegate: {} } } }, ME, { connected: ME, isSame: same }).label, 'Undelegate votes');
        assert.equal(lockActionSpec('elections-remove', { actions: { elections: { votes: 1 } } }, ME, { connected: ME, isSame: same }).label, 'Remove council vote');
        assert.equal(lockActionSpec('migrate-currency', { actions: { orphan: { stash: ME } } }, ME, { connected: OTHER, isSame: same }).label, 'Remove leftover staking lock');
    });
    test('the status card and /help/locked-balance use the new button names', () => {
        assert.match(successCopy('democracy.undelegate', {}, {}).body, /; then press Unlock voted PDEX\.$/);
        const t = HELP_TOPICS.find(x => x.slug === 'locked-balance').body;
        for (const w of ['The list below the figures', '<b>Withdraw unstaked PDEX</b> button', '<b>Undelegate votes</b> first', 'The list marks it "Can remove now"']) assert.ok(t.includes(w), w);
        assert.doesNotMatch(t, /The table/);
    });
    test('lockRowState and the B9 page rule agree with the display', () => {
        const m = CEO();
        const staked = m.items.find(i => i.kind === 'hold');
        assert.equal(lockRowState(staked, m, NOW).group, 'rest', 'Staked has no action of its own');
        const wallet = lockDisplay(m, { canSign: true, connected: ME, page: 'wallet', unstake: true, now: NOW });
        assert.equal(wallet.groups[0].rows.find(r => r.kindId === 'K01').action.id, 'B9');
        assert.equal(lockDisplay(m, { canSign: true, connected: ME, page: 'wallet', unstake: false, now: NOW }).groups.flatMap(g => g.rows).find(r => r.kindId === 'K01').action, null);
    });
});
