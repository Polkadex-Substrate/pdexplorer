// Transaction status card and council motion logic (lib/tx-status.js).
//
// Why this exists: after tabling a council motion the CEO got a browser popup
// reading "Propose treasury.rejectProposal(#72) was included on-chain." That
// text fired at InBlock, ignored failed batch items and failed inner council
// calls, and never decoded Token or Arithmetic errors. Every rule the new
// status card relies on is pure and lives in lib/tx-status.js, so it is
// checked here without a browser or a chain.
//
// Run: npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    stageOf, BUTTON_STAGE_TEXT,
    defaultThreshold, checkThreshold, THRESHOLD_ONE_WARNING,
    decodeDispatchError, classifyThrownError, evaluateEvents,
    motionState, overlayLiveMotions, pendingChipText, pendingSettled,
    successCopy, txCardHtml, supportCode, formatPlanck, buildTxModel, ACTION_KEYS, PENDING_TITLE
} from '../lib/tx-status.js';

const HEX = /0x[0-9a-f]{12,}/i;

// A fake registry: findMetaError maps a module error to section/name/docs the
// way polkadot-js does (section lower camel case, as the metadata names it).
const registryWith = (map) => ({
    findMetaError: (m) => {
        const hit = map[m.key];
        if (!hit) throw new Error('findMetaError: unknown error ' + m.key);
        return hit;
    }
});
const moduleErr = (key) => ({ isModule: true, asModule: { key, index: 7, error: '0x05000000' }, type: 'Module' });
const tokenErr = (t) => ({ isToken: true, asToken: { type: t }, type: 'Token' });
const arithErr = (t) => ({ isArithmetic: true, asArithmetic: { type: t }, type: 'Arithmetic' });
const badOrigin = { isBadOrigin: true, type: 'BadOrigin' };
const REG = registryWith({
    notMember: { section: 'council', name: 'NotMember', docs: ['Account is not a member'] },
    tcNotMember: { section: 'technicalCommittee', name: 'NotMember', docs: ['Account is not a member'] },
    alreadyClaimed: { section: 'staking', name: 'AlreadyClaimed', docs: ['Rewards for this era have already been claimed for this validator.'] },
    unmapped: { section: 'nominationPools', name: 'SomethingNew', docs: ['The pool is blocked. Extra words that should not show.'] },
    hexDocs: { section: 'mystery', name: 'Thing', docs: ['Bad key 0xdeadbeefdeadbeefdeadbeef was given.'] },
    noDocs: { section: 'mystery', name: 'Silent', docs: [] }
});
const ev = (section, method, data = []) => ({ event: { section, method, data } });
const ok = { isErr: false, isOk: true };
const err = (e) => ({ isErr: true, isOk: false, asErr: e });

describe('threshold default from the live seat count', () => {
    test('a majority of the seats when the seat count is known', () => {
        assert.equal(defaultThreshold(5), 3, '3 of 5 is the CEO case');
        assert.equal(defaultThreshold(4), 3);
        assert.equal(defaultThreshold(3), 2);
        assert.equal(defaultThreshold(1), 1);
    });
    test('no default at all without seats (never silently 1)', () => {
        // The old councilSimpleMajority() fell back to 1 when council data had
        // not loaded, which is how the Treasury page's modal proposed a
        // threshold-1 motion that ran with no vote.
        for (const s of [0, null, undefined, NaN, -2, '']) {
            assert.equal(defaultThreshold(s), null, `seats=${String(s)}`);
        }
    });
});

describe('threshold 1 needs an explicit confirmation', () => {
    test('1 shows the exact warning and blocks submit until confirmed', () => {
        const r = checkThreshold('1', 5, false);
        assert.equal(r.error, null);
        assert.equal(r.needsConfirm, true);
        assert.equal(r.canSubmit, false);
        assert.ok(r.warning.startsWith(THRESHOLD_ONE_WARNING));
        assert.equal(THRESHOLD_ONE_WARNING,
            'A threshold of 1 runs the call immediately when you propose it, with no council vote');
    });
    test('1 can be submitted once the box is ticked', () => {
        assert.equal(checkThreshold('1', 5, true).canSubmit, true);
    });
    test('a majority threshold needs no confirmation', () => {
        const r = checkThreshold('3', 5, false);
        assert.deepEqual([r.error, r.warning, r.needsConfirm, r.canSubmit], [null, null, false, true]);
        assert.equal(r.value, 3);
    });
    test('below a majority warns (treasury needs more than half) but does not block', () => {
        const r = checkThreshold('2', 5, false);
        assert.equal(r.error, null);
        assert.match(r.warning, /more than half/);
        assert.equal(r.canSubmit, true);
    });
    test('invalid values are errors and block submit', () => {
        for (const v of ['0', '-1', '1.5', 'abc', '', ' ', '6']) {
            const r = checkThreshold(v, 5, true);
            assert.ok(r.error, `accepted ${JSON.stringify(v)}`);
            assert.equal(r.canSubmit, false);
        }
        assert.match(checkThreshold('6', 5, true).error, /5 council seats/);
    });
});

describe('status to stage', () => {
    test('signing before the first callback', () => {
        assert.equal(stageOf('signing'), 'signing');
        assert.equal(stageOf(null), 'signing');
    });
    test('pool statuses are broadcast', () => {
        for (const t of ['Future', 'Ready', 'Broadcast', 'Retracted']) assert.equal(stageOf({ type: t }), 'broadcast', t);
    });
    test('InBlock and Finalized', () => {
        assert.equal(stageOf({ type: 'InBlock', isInBlock: true }), 'inBlock');
        assert.equal(stageOf({ type: 'Finalized', isFinalized: true }), 'finalized');
    });
    test('terminal pool failures', () => {
        for (const t of ['Dropped', 'Invalid', 'Usurped', 'FinalityTimeout']) assert.equal(stageOf({ type: t }), 'failed', t);
    });
    test('the button text for each in-flight stage', () => {
        assert.deepEqual(BUTTON_STAGE_TEXT, {
            signing: 'Waiting for wallet', broadcast: 'Broadcasting', inBlock: 'In block', finalized: 'Finalized'
        });
    });
});

describe('dispatch error decoding', () => {
    test('module error: mapped copy, by metadata section', () => {
        const d = decodeDispatchError(moduleErr('notMember'), REG);
        assert.equal(d.key, 'council.NotMember');
        assert.match(d.text, /Only current council members can do this/);
    });
    test('the technical committee shares the collective copy', () => {
        const d = decodeDispatchError(moduleErr('tcNotMember'), REG);
        assert.equal(d.key, 'technicalCommittee.NotMember');
        assert.match(d.text, /Only current council members/);
    });
    test('unmapped module error: first sentence of the docs', () => {
        const d = decodeDispatchError(moduleErr('unmapped'), REG);
        assert.equal(d.text, 'The pool is blocked.');
    });
    test('Token errors (modern FRAME balance failures) are decoded', () => {
        assert.match(decodeDispatchError(tokenErr('FundsUnavailable'), REG).text, /Not enough transferable PDEX/);
        assert.match(decodeDispatchError(tokenErr('NotExpendable'), REG).text, /below the minimum balance/);
        assert.match(decodeDispatchError(tokenErr('BelowMinimum'), REG).text, /minimum balance/);
        assert.equal(decodeDispatchError(tokenErr('FundsUnavailable'), REG).key, 'token.FundsUnavailable');
    });
    test('Arithmetic errors are decoded', () => {
        const d = decodeDispatchError(arithErr('Underflow'), REG);
        assert.equal(d.key, 'arithmetic.Underflow');
        assert.match(d.text, /did not add up/);
        assert.match(decodeDispatchError(arithErr('Overflow'), REG).text, /did not add up/);
    });
    test('BadOrigin explains the treasury majority rule', () => {
        const d = decodeDispatchError(badOrigin, REG);
        assert.equal(d.key, 'system.BadOrigin');
        assert.match(d.text, /more than half of all seats/);
    });
    test('never prints hex, even when the metadata docs contain it', () => {
        const outs = [
            decodeDispatchError(moduleErr('hexDocs'), REG).text,
            decodeDispatchError(moduleErr('noDocs'), REG).text,
            decodeDispatchError(moduleErr('missing'), REG).text,       // findMetaError throws
            decodeDispatchError({ type: 'Other', toString: () => '0x' + 'ab'.repeat(32) }, REG).text
        ];
        for (const t of outs) {
            assert.ok(t && !HEX.test(t), `hex leaked: ${t}`);
        }
    });
});

describe('thrown errors before the chain', () => {
    const cls = (m) => classifyThrownError(new Error(m));
    test('wallet rejection is neutral, not red', () => {
        for (const m of ['Cancelled', 'Rejected by user', 'User denied the request', 'Request declined']) {
            assert.equal(cls(m).stage, 'cancelled', m);
        }
        assert.match(cls('Cancelled').text, /no fee was charged/);
    });
    test('RPC pool errors win over the cancel words', () => {
        assert.match(cls('1010: Invalid Transaction: Inability to pay some fees , e.g. account balance too low').text, /network fee/);
        assert.match(cls('1010: Invalid Transaction: Transaction has a bad signature').text, /did not accept your wallet's signature/);
        assert.match(cls('1014: Priority is too low: (1 vs 1)').text, /another one from your account is pending/);
        assert.match(cls('1010: Invalid Transaction: Transaction is outdated').text, /another one from your account/);
        assert.match(cls('Verification Error: Runtime error: Execution failed: wasm `unreachable` instruction executed').text, /could not validate/);
        assert.match(cls('WebSocket is not connected').text, /Lost connection/);
        assert.equal(cls('1010: Invalid Transaction: Inability to pay some fees').stage, 'failed');
    });
    // Second Checker round (M2): a plain Error's own message is shown
    // (sanitised); the generic text is for engine errors, non-Errors and
    // empty messages. test/tx-lifecycle.test.js has the full set.
    test('an engine error is generic, with no raw text', () => {
        const r = classifyThrownError(new TypeError('Cannot read properties of undefined (reading 0x1234567890abcdef1234)'));
        assert.equal(r.stage, 'failed');
        assert.match(r.text, /could not tell what/);
        assert.ok(!/Cannot read/.test(r.text) && !HEX.test(r.text));
    });
    test('a plain Error keeps its message, hex removed', () => {
        const r = cls('Unknown signed extension CheckFoo at 0x1234567890abcdef1234');
        assert.equal(r.text, 'Unknown signed extension CheckFoo at [data]');
    });
});

describe('inner failures are failures (forceBatch)', () => {
    const batch = [
        ev('utility', 'ItemCompleted'),
        ev('utility', 'ItemFailed', [moduleErr('alreadyClaimed')]),
        ev('utility', 'BatchCompletedWithErrors'),
        ev('system', 'ExtrinsicSuccess')
    ];
    test('stake and nominate with a failed item is Failed, not success', () => {
        const r = evaluateEvents(batch, REG, { actionKey: 'staking.bondNominate' });
        assert.equal(r.ok, false);
        assert.equal(r.failedItems, 1);
        assert.match(r.text, /1 of 2 actions/);
        assert.match(r.text, /already paid out/);
    });
    test('a payout with a skipped item is a warning with the skip count', () => {
        const r = evaluateEvents(batch, REG, { actionKey: 'staking.payout' });
        assert.equal(r.ok, true);
        assert.equal(r.tone, 'warn');
        assert.equal(r.failedItems, 1);
    });
    test('a payout where every item failed is Failed', () => {
        const all = [ev('utility', 'ItemFailed', [moduleErr('alreadyClaimed')]), ev('utility', 'BatchCompletedWithErrors')];
        assert.equal(evaluateEvents(all, REG, { actionKey: 'staking.payout' }).ok, false);
    });
    test('BatchInterrupted names the failing item', () => {
        const r = evaluateEvents([ev('utility', 'BatchInterrupted', [1, tokenErr('FundsUnavailable')])], REG, {});
        assert.equal(r.ok, false);
        assert.match(r.text, /Action 2/);
        assert.match(r.text, /Not enough transferable PDEX/);
    });
    test('ExtrinsicFailed is decoded', () => {
        const r = evaluateEvents([ev('system', 'ExtrinsicFailed', [moduleErr('notMember'), {}])], REG, {});
        assert.equal(r.ok, false);
        assert.equal(r.key, 'council.NotMember');
    });
    test('clean events are success', () => {
        const r = evaluateEvents([ev('balances', 'Transfer'), ev('system', 'ExtrinsicSuccess')], REG, {});
        assert.equal(r.ok, true);
        assert.equal(r.tone, 'ok');
    });
});

describe('council inner call results', () => {
    test('Executed with Err is a failure with the decoded reason', () => {
        const events = [ev('council', 'Closed'), ev('council', 'Approved'), ev('council', 'Executed', ['0xabc', err(badOrigin)]), ev('system', 'ExtrinsicSuccess')];
        const r = evaluateEvents(events, REG, { actionKey: 'council.close' });
        assert.equal(r.ok, false);
        assert.equal(r.executed, 'err');
        assert.match(r.text, /passed but the proposed call failed/);
        assert.match(r.text, /more than half of all seats/);
    });
    test('MemberExecuted with Err (threshold 1 propose) is a failure', () => {
        const events = [ev('council', 'MemberExecuted', ['0xabc', err(moduleErr('notMember'))])];
        const r = evaluateEvents(events, REG, { actionKey: 'council.propose' });
        assert.equal(r.ok, false);
        assert.match(r.text, /recorded but the treasury call failed/);
    });
    test('technical committee Executed Err is caught too', () => {
        const r = evaluateEvents([ev('technicalCommittee', 'Executed', ['0xabc', err(badOrigin)])], REG, {});
        assert.equal(r.ok, false);
    });
    test('Executed Ok and Disapproved are reported as such', () => {
        assert.equal(evaluateEvents([ev('council', 'Approved'), ev('council', 'Executed', ['0xabc', ok])], REG, {}).executed, 'ok');
        const d = evaluateEvents([ev('council', 'Closed'), ev('council', 'Disapproved')], REG, { actionKey: 'council.close' });
        assert.equal(d.ok, true);
        assert.equal(d.disapproved, true);
    });
    test('success copy follows the outcome', () => {
        const exec = evaluateEvents([ev('council', 'Approved'), ev('council', 'Executed', ['0xabc', ok])], REG, {});
        assert.match(successCopy('council.close', { idx: 4 }, exec).body, /closed and executed/);
        const dis = evaluateEvents([ev('council', 'Disapproved')], REG, {});
        assert.match(successCopy('council.close', { idx: 4 }, dis).body, /without enough Ayes/);
        const tabled = successCopy('council.propose', { id: 72, callType: 'treasury.rejectProposal', threshold: 3, seats: 5 }, evaluateEvents([ev('council', 'Proposed')], REG, {}));
        assert.equal(tabled.title, 'Motion tabled');
        assert.match(tabled.body, /Treasury proposal #72 will be rejected if 3 of 5 council members vote Aye/);
        const ran = successCopy('council.propose', { id: 72, callType: 'treasury.approveProposal', threshold: 1, seats: 5 }, evaluateEvents([ev('council', 'MemberExecuted', ['0xabc', ok])], REG, {}));
        assert.equal(ran.title, 'Motion executed');
    });
});

describe('voting record to motion card state', () => {
    const A = 'eAlice', B = 'eBob', C = 'eCarol';
    test('ayes reaching the threshold: decided, closeable', () => {
        const s = motionState({ threshold: 3, ayes: [A, B, C], nays: [], end: 100 }, { seats: 5, currentBlock: 50 });
        assert.equal(s.key, 'approved');
        assert.equal(s.label, 'Threshold met');
        assert.equal(s.decided, true);
        assert.equal(s.closeable, true);
        assert.equal(s.ayes, 3);
        assert.equal(s.ayePct, 100);
    });
    test('nays: the pallet rule (seats - nays < threshold)', () => {
        const rej = motionState({ threshold: 3, ayes: [], nays: [A, B, C], end: 100 }, { seats: 5, currentBlock: 50 });
        assert.equal(rej.key, 'rejected');
        assert.equal(rej.decided, true);
        const open = motionState({ threshold: 3, ayes: [], nays: [A, B], end: 100 }, { seats: 5, currentBlock: 50 });
        assert.equal(open.key, 'voting');
        assert.equal(open.closeable, false);
        // One nay cannot defeat a threshold-1 motion on a 5-seat council; the
        // old "nays >= threshold" rule said Rejected.
        assert.equal(motionState({ threshold: 1, ayes: [], nays: [A], end: 100 }, { seats: 5, currentBlock: 50 }).key, 'voting');
    });
    test('without a seat count the old nays >= threshold rule still applies', () => {
        assert.equal(motionState({ threshold: 2, ayes: [], nays: [A, B], end: 100 }, { currentBlock: 50 }).key, 'rejected');
    });
    test('ended voting period', () => {
        const s = motionState({ threshold: 3, ayes: [A], nays: [], end: 100 }, { seats: 5, currentBlock: 100 });
        assert.equal(s.key, 'expired');
        assert.equal(s.ended, true);
        assert.equal(s.decided, false);
        assert.equal(s.closeable, true);
    });
    test('your own vote is found with the address comparator', () => {
        const same = (x, y) => x.toLowerCase() === y.toLowerCase();
        assert.equal(motionState({ threshold: 3, ayes: [A], nays: [B] }, { you: 'EALICE', isSame: same }).youVoted, 'aye');
        assert.equal(motionState({ threshold: 3, ayes: [A], nays: [B] }, { you: 'ebob', isSame: same }).youVoted, 'nay');
        assert.equal(motionState({ threshold: 3, ayes: [A], nays: [B] }, { you: null }).youVoted, null);
    });
    test('the pending chip stays until the record shows the vote', () => {
        assert.equal(pendingChipText('aye'), 'Your Aye is being recorded');
        assert.equal(pendingChipText('nay'), 'Your Nay is being recorded');
        assert.equal(pendingSettled({ kind: 'aye', stage: 'inBlock' }, { youVoted: null }), false);
        assert.equal(pendingSettled({ kind: 'aye', stage: 'inBlock' }, { youVoted: 'aye' }), true);
        assert.equal(pendingSettled({ kind: 'aye', stage: 'signing' }, { youVoted: 'aye' }), false,
            'an old Aye must not settle a vote that has not been sent yet (vote change)');
        assert.equal(pendingSettled({ kind: 'close', stage: 'finalized' }, null), true);
    });
});

describe('live overlay of motions', () => {
    const rest = [
        { hash: '0xa', index: 5, threshold: 3, ayes: ['x'], nays: [], end: 100, section: 'treasury', method: 'approveProposal' },
        { hash: '0xb', index: 4, threshold: 3, ayes: [], nays: [], end: 90, section: 'treasury', method: 'rejectProposal' }
    ];
    test('no live data: the REST list is unchanged', () => {
        assert.deepEqual(overlayLiveMotions(rest, null), rest);
        assert.deepEqual(overlayLiveMotions(rest, { hashes: null }), rest);
    });
    test('live votes patch the tallies; closed motions drop out; new ones appear', () => {
        const live = {
            hashes: ['0xa', '0xc'],
            votings: {
                '0xa': { index: 5, threshold: 3, ayes: ['x', 'y'], nays: ['z'], end: 100 },
                '0xc': { index: 6, threshold: 3, ayes: ['y'], nays: [], end: 120 }
            },
            stubs: { '0xc': { section: 'treasury', method: 'approveProposal', args: [], lengthBound: 7 } }
        };
        const out = overlayLiveMotions(rest, live);
        assert.deepEqual(out.map(m => m.hash), ['0xc', '0xa'], 'newest first, 0xb closed');
        assert.deepEqual(out.find(m => m.hash === '0xa').ayes, ['x', 'y']);
        assert.equal(out.find(m => m.hash === '0xa').method, 'approveProposal', 'REST fields kept');
        const c = out.find(m => m.hash === '0xc');
        assert.equal(c.title, 'treasury.approveProposal');
        assert.equal(c.lengthBound, 7);
        assert.equal(c.live, true);
    });
    test('a live hash with no voting record yet keeps what REST had', () => {
        const out = overlayLiveMotions(rest, { hashes: ['0xa'], votings: {}, stubs: {} });
        assert.deepEqual(out.map(m => m.hash), ['0xa']);
        assert.deepEqual(out[0].ayes, ['x']);
    });
});

describe('the card never shows hex and escapes what it prints', () => {
    test('support code is short', () => {
        assert.equal(supportCode('0x' + 'ab'.repeat(32)), '0xabababab');
        assert.equal(supportCode(null, 'council.NotMember'), 'council.NotMember');
    });
    test('card html', () => {
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const html = txCardHtml({
            id: 't1', stage: 'failed', tone: 'error', title: '<b>x</b>', body: 'Bad 0x' + 'cd'.repeat(20),
            code: '0xabababab', links: [{ href: '/council', label: 'Council' }]
        }, esc);
        assert.ok(!HEX.test(html), 'hex in card');
        assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
        assert.match(html, /aria-label="Close transaction status"/);
        assert.ok(!/role="status"/.test(html), 'the zone is the live region, not each card');
        assert.match(html, /Copy details/);
    });
    test('planck formatting for fees and amounts', () => {
        assert.equal(formatPlanck('1500000000000'), '1.5');
        assert.equal(formatPlanck('123456789'), '0.0001');
        assert.equal(formatPlanck('0'), '0');
        assert.equal(formatPlanck(null), null);
    });
});

describe('one model per card update', () => {
    const act = (key, params) => ({ id: 't', key, label: 'Propose treasury.rejectProposal(#72)', params });
    test('the developer label never becomes the title', () => {
        const m = buildTxModel(act('council.propose', {}), 'signing');
        assert.equal(m.title, 'Tabling a council motion');
        assert.equal(m.stageText, 'Waiting for your wallet');
    });
    test('InBlock with a failed batch item is Failed, with the block', () => {
        const events = [ev('utility', 'ItemFailed', [tokenErr('FundsUnavailable')]), ev('utility', 'BatchCompletedWithErrors')];
        const m = buildTxModel(act('staking.bondNominate', { n: 2 }), { type: 'InBlock' }, events, null, { registry: REG, blockNumber: 9, txHash: '0x' + '12'.repeat(32) });
        assert.equal(m.stage, 'failed');
        assert.equal(m.tone, 'error');
        assert.equal(m.stageText, 'Failed in block #9');
        assert.equal(m.code, '0x12121212');
    });
    test('Finalized success gets the copy, the tx link and the ok tone', () => {
        const m = buildTxModel(act('council.vote', { aye: true, idx: 4, body: 'council' }), { type: 'Finalized' }, [ev('system', 'ExtrinsicSuccess')], null, { registry: REG, blockNumber: 9, txHash: '0xfeed' });
        assert.equal(m.tone, 'ok');
        assert.equal(m.title, 'Vote recorded');
        assert.equal(m.links[0].href, '/tx/9/0xfeed');
    });
    test('a wallet rejection is a neutral Cancelled card', () => {
        const m = buildTxModel(act('balances.transfer', {}), 'failed', null, new Error('Cancelled'));
        assert.equal(m.stage, 'cancelled');
        assert.equal(m.tone, 'neutral');
    });
    test('pre-flight sentences are shown verbatim', () => {
        const m = buildTxModel(act('council.vote', {}), 'failed', null, 'Please connect your wallet first.');
        assert.equal(m.body, 'Please connect your wallet first.');
        assert.equal(m.code, null, 'nothing was signed, so no support code');
    });
    test('pool statuses Dropped/Invalid/Usurped are failures with plain text', () => {
        for (const t of ['Dropped', 'Invalid', 'Usurped', 'FinalityTimeout']) {
            const m = buildTxModel(act('balances.transfer', {}), { type: t });
            assert.equal(m.stage, 'failed', t);
            assert.ok(m.body.length > 20);
        }
    });
    test('stalled keeps the success copy and says it is still waiting', () => {
        const m = buildTxModel(act('council.vote', { aye: true, idx: 1 }), 'stalled', [ev('system', 'ExtrinsicSuccess')], null, { registry: REG, blockNumber: 5 });
        assert.equal(m.tone, 'warn');
        assert.match(m.next, /Still waiting for finality.*block #5/);
    });
    test('all 18 action keys have success copy and a pending title, with no hex', () => {
        assert.equal(ACTION_KEYS.length, 18);
        for (const k of ACTION_KEYS) {
            assert.ok(PENDING_TITLE[k], `no pending title for ${k}`);
            const c = successCopy(k, { id: 1, idx: 1, n: 2, amount: '1', to: 'e' + 'x'.repeat(47), delegate: 'e' + 'y'.repeat(47), beneficiary: 'e' + 'z'.repeat(47), type: 'Any', stake: '1', ref: 1, conviction: 'Locked1x', lockPeriodDays: 30 }, {});
            assert.ok(c.title && c.body, k);
            assert.ok(!HEX.test(c.title + c.body + c.next), k);
        }
    });
});
