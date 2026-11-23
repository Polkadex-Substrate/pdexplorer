// Post-action refresh copy and timings (designer spec 2026-11-22-post-action-refresh-ux.md, sections 1, 3, 4
// and hook H7): the strings and REFRESH_UI live in one import-free module, frozen here the way WP3 froze
// the wizard. A guard refuses "reload the page", an exclamation mark and an em or en dash, and is shown
// failing on a broken copy with a message that names the string.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { REFRESH_UI, STRINGS, say, nounFor } from '../lib/refresh-ui.js';

// Section 1 of the UX spec, by id.
const TIMINGS = { showDelayMs: 600, minVisibleMs: 900, settleHoldMs: 1600, collapseMs: 240, highlightMs: 1200, fadeMs: 150, announceGapMs: 5000, quietAnnounceMs: 5000 };

// Sections 3 and 4 of the UX spec, verbatim.
const COPY = {
    S1: 'Updating',
    S2: 'Checking',
    S3: 'A payout for this era is in a block. Checking whether your share was in it.',
    S4: 'Paid in block #{n}',
    S4_NONE: 'Paid',
    S5: 'Removed in block #{n}',
    S6: 'Executed in block #{n}',
    S7: 'Cancelled in block #{n}',
    S8: 'Released in block #{n}',
    S9: 'Paid out in block #{n}',
    S10: 'Checking {n} entries',
    S10_ONE: 'Checking 1 entry',
    S10t: 'A payout for these eras is in a block. The list is checking which of them paid your account.',
    S11: 'This section could not be refreshed. It may be behind the chain.',
    S12: 'Reload this section',
    S13: 'Reloading',
    S14: 'May be behind',
    S15: 'This list may be behind the chain. An era that is already paid is skipped, and you still pay the network fee.',
    S16: 'Still could not refresh. Last tried at {HH:MM}.',
    S17: 'The block with your {payout} was replaced by the network. It is being sent again, so the items below are listed until it is back in a block.',
    S18: 'Payout in progress',
    S20: 'Confirming',
    S21: 'Sent {amount} PDEX to {short address}. In block #{n}. This row is replaced when the explorer has indexed it.',
    A1: 'Unpaid rewards updated: {n} paid, {m} left.',
    A1g: '{Section name} updated.',
    A2: '{n} entries are being checked.',
    A3: '{Section name} is up to date.',
    A4: '{Section name} could not be refreshed. Use Reload this section.',
    A5: '{Section name} is up to date.',
    A6: 'The {payout} is not confirmed any more. The items are listed again while it is sent again.'
};

// The copy guard (H7). Exported shape: a list of readable offences, empty when the copy is clean.
function copyOffenders(table) {
    const out = [];
    for (const [id, text] of Object.entries(table)) {
        if (/reload the page/i.test(text)) out.push(`${id} says "reload the page": "${text}"`);
        if (text.includes('!')) out.push(`${id} has an exclamation mark: "${text}"`);
        if (/[–—]/.test(text)) out.push(`${id} has an em or en dash: "${text}"`);
    }
    return out;
}

describe('refresh-ui: timings and copy', () => {
    test('REFRESH_UI holds the eight timings of the UX spec, frozen', () => {
        for (const [k, v] of Object.entries(TIMINGS)) assert.equal(REFRESH_UI[k], v, k);
        assert.ok(Object.isFrozen(REFRESH_UI));
    });
    test('the strings equal the spec, verbatim, and nothing else', () => {
        assert.deepEqual({ ...STRINGS }, COPY);
        assert.ok(Object.isFrozen(STRINGS));
    });
    test('the copy guard passes on the module', () => {
        assert.deepEqual(copyOffenders(STRINGS), [], copyOffenders(STRINGS).join('\n'));
    });
    test('the copy guard fails on a broken copy and names the string', () => {
        const broken = { ...STRINGS, S11: 'Could not refresh! Reload the page — now.' };
        const msg = copyOffenders(broken);
        assert.equal(msg.length, 3);
        assert.match(msg.join('\n'), /S11 says "reload the page"/);
        assert.match(msg.join('\n'), /S11 has an exclamation mark/);
        assert.match(msg.join('\n'), /S11 has an em or en dash/);
    });
    test('say fills the placeholders and picks the one and none forms', () => {
        assert.equal(say('S4', { n: 1234 }), 'Paid in block #1234');
        assert.equal(say('S4', { n: null }), 'Paid');
        assert.equal(say('S10', { n: 2 }), 'Checking 2 entries');
        assert.equal(say('S10', { n: 1 }), 'Checking 1 entry');
        assert.equal(say('A1', { n: 2, m: 1 }), 'Unpaid rewards updated: 2 paid, 1 left.');
        assert.equal(say('A2', { n: 3 }), '3 entries are being checked.');
        assert.equal(say('S17', { payout: nounFor('staking.payout') }), 'The block with your payout was replaced by the network. It is being sent again, so the items below are listed until it is back in a block.');
        assert.equal(say('A6', { payout: nounFor('staking.payout') }), 'The payout is not confirmed any more. The items are listed again while it is sent again.');
    });
    test('the action noun map, default "transaction"', () => {
        assert.equal(nounFor('staking.payout'), 'payout');
        assert.equal(nounFor('balances.transfer'), 'transfer');
        assert.equal(nounFor('democracy.vote'), 'vote');
        assert.equal(nounFor('proxy.add'), 'proxy change');
        assert.equal(nounFor('identity.clear'), 'identity change');
        assert.equal(nounFor('council.close'), 'transaction');
    });
});
