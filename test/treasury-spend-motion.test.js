// "Propose a spend" on the Treasury page: a council member tables
//   council.propose(threshold, treasury.spend((), amount, beneficiary, validFrom), lengthBound)
// and signs it through submitSignedTx after a review of the decoded call.
//
// The rule the form follows (polkadex-node, branch mainnet, runtimes/mainnet/
// src/lib.rs): SpendOrigin accepts EnsureProportionAtLeast<_, Council, 3, 5>
// up to CouncilSpendCap (50,000 PDEX) per spend. A closed motion dispatches as
// Members(ayes, seats) (pallet-collective 45), so a threshold below
// ceil(3 x seats / 5) can pass the vote and still fail with BadOrigin.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiPromise } from '@polkadot/api';
import { encodeAddress } from '@polkadot/util-crypto';
import { spendThresholdRange, checkSpendForm, buildSpendMotion, decodeSpendMotion, readCouncilSeats, SPEND_CAP_ERROR } from '../lib/treasury-spend.js';
import { createSpendMotionUI } from '../lib/treasury-spend-view.js';
import { MOTION_TEMPLATES } from '../lib/motion-templates.js';
import { successCopy, evaluateEvents } from '../lib/tx-status.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { loadFixture } from './helpers/extrinsic-builders.js';
import { mockProvider } from './helpers/mock-provider.js';

// Made-up accounts (public repo): 0x01.. to 0x09.. at prefix 88.
const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(addr);
const OUTSIDER = addr(8), BEN = addr(9);
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('threshold bounds', () => {
    test('the minimum is ceil(3 x seats / 5) for 3, 4, 5 and 6 seats; the maximum is the seat count', () => {
        assert.deepEqual([3, 4, 5, 6].map(spendThresholdRange), [{ min: 2, max: 3 }, { min: 3, max: 4 }, { min: 3, max: 5 }, { min: 4, max: 6 }]);
    });
    test('the minimum is exactly what EnsureProportionAtLeast<3, 5> accepts: one Aye fewer fails', () => {
        for (let seats = 1; seats <= 12; seats++) {
            const { min } = spendThresholdRange(seats);
            assert.ok(min * 5 >= seats * 3 && (min - 1) * 5 < seats * 3, `seats ${seats}`);
        }
    });
    test('no range while the seats are unknown', () => {
        for (const s of [0, null, undefined, NaN, -1, 2.5, '']) assert.equal(spendThresholdRange(s), null, String(s));
    });
});

describe('the form fields', () => {
    const check = (over = {}, seats = 5, decimals = 12) =>
        checkSpendForm({ beneficiary: BEN, amount: '1500', validFrom: '', threshold: '3', ...over }, { seats, decimals });

    test('a complete form gives the call arguments', () => {
        assert.deepEqual(check(), { ok: true, errors: {}, values: { beneficiary: BEN, planck: '1500000000000000', validFrom: null, threshold: 3 } });
    });
    test('the cap: exactly 50,000 PDEX passes, one planck more needs a referendum', () => {
        assert.equal(check({ amount: '50000' }).values.planck, '50000000000000000');
        for (const amount of ['50000.000000000001', '50001']) {
            const r = check({ amount });
            assert.equal(r.ok, false, amount);
            assert.equal(r.errors.amount, SPEND_CAP_ERROR);
        }
        assert.match(SPEND_CAP_ERROR, /needs a referendum/);
        assert.match(SPEND_CAP_ERROR, /50,000 PDEX/);
    });
    test('the amount converts with the chain decimals and must be a plain positive decimal', () => {
        assert.equal(check({ amount: '1.5' }).values.planck, '1500000000000');
        assert.equal(check({ amount: '1.5' }, 5, 10).values.planck, '15000000000');
        for (const amount of ['', '0', '-1', '1,5', '1e3', 'abc', '1.0000000000001']) assert.ok(check({ amount }).errors.amount, JSON.stringify(amount));
    });
    test('the beneficiary must be a valid Polkadex address', () => {
        const typo = BEN.slice(0, -1) + (BEN.endsWith('a') ? 'b' : 'a');
        for (const beneficiary of ['', 'not-an-address', '0x' + 'ab'.repeat(32), BEN.slice(0, -1), typo]) {
            assert.ok(check({ beneficiary }).errors.beneficiary, beneficiary);
        }
        assert.equal(check({ beneficiary: ` ${BEN} ` }).values.beneficiary, BEN);
    });
    test('valid-from is optional: empty is none, otherwise a whole block number', () => {
        assert.equal(check({ validFrom: '' }).values.validFrom, null);
        assert.equal(check({ validFrom: ' 123456 ' }).values.validFrom, 123456);
        for (const validFrom of ['abc', '-5', '1.5', '4294967296']) assert.ok(check({ validFrom }).errors.validFrom, validFrom);
    });
    test('the threshold must lie between the minimum and the seat count', () => {
        assert.match(check({ threshold: '2' }).errors.threshold, /three fifths/);
        for (const threshold of ['6', '0', '3.5', '']) assert.ok(check({ threshold }).errors.threshold, threshold);
        assert.equal(check({ threshold: '5' }).values.threshold, 5);
        assert.ok(check({}, 0).errors.threshold, 'no seats known');
    });
});

const fx = loadFixture('metadata-392.json');
describe('the built motion on the real codec (metadata fixture)', { skip: fx ? false : 'test/fixtures/metadata-392.json not present' }, () => {
    let api;
    const values = { beneficiary: BEN, planck: '1500000000000000', validFrom: null, threshold: 3 };
    before(async () => { api = await ApiPromise.create({ provider: mockProvider({ metadataHex: fx.metadata, specVersion: fx.specVersion }).provider, noInitWarn: true }); });
    after(async () => { await api?.disconnect(); });

    test('council.propose(threshold, treasury.spend((), amount, beneficiary, validFrom), lengthBound), decoded back from its bytes', () => {
        const call = api.registry.createType('Call', buildSpendMotion(api, 'council', values).method.toHex());
        assert.equal(`${call.section}.${call.method}`, 'council.propose');
        const [threshold, proposal, lengthBound] = call.args;
        assert.equal(threshold.toNumber(), 3);
        assert.equal(`${proposal.section}.${proposal.method}`, 'treasury.spend');
        assert.ok(MOTION_TEMPLATES.some(t => t.key === 'treasury.spend'), 'the call the form builds is a listed motion template');
        const [asset, amount, beneficiary, validFrom] = proposal.args;
        assert.equal(asset.toRawType(), 'Null');
        assert.equal(amount.toString(), '1500000000000000');
        assert.equal(beneficiary.type, 'Id');
        assert.equal(beneficiary.value.toString(), BEN);
        assert.ok(validFrom.isNone);
        assert.equal(lengthBound.toNumber(), proposal.encodedLength);
        const later = api.registry.createType('Call', buildSpendMotion(api, 'council', { ...values, validFrom: 123456 }).method.toHex());
        assert.equal(later.args[1].args[3].unwrap().toNumber(), 123456);
    });
    test('the review rows come from the decoded bytes', () => {
        const tx = buildSpendMotion(api, 'council', values);
        const d = decodeSpendMotion(api, tx, 12);
        assert.equal(`${d.motion.section}.${d.motion.method}`, 'council.propose');
        assert.deepEqual(d.motion.args.map(a => [a.name, a.value]), [['threshold', '3'], ['lengthBound', String(tx.method.args[1].encodedLength)]]);
        assert.equal(`${d.spend.section}.${d.spend.method}`, 'treasury.spend');
        assert.deepEqual(d.spend.args.map(a => [a.name, a.value]), [
            ['assetKind', 'PDEX (the native asset)'],
            ['amount', '1,500 PDEX (1500000000000000 plancks)'],
            ['beneficiary', BEN],
            ['validFrom', 'none: claimable as soon as the motion runs']
        ]);
        assert.equal(d.hash, tx.method.args[1].hash.toHex());
    });
    test('the seats are read from the council collective on this runtime', async () => {
        const council = Object.create(api.query.council, { members: { value: async () => [A, B, C] } });
        assert.deepEqual(await readCouncilSeats({ tx: api.tx, query: { council } }), { pallet: 'council', members: [A, B, C] });
    });
});

// The view, driven through the dialog's real ids. The chain reads and the
// builders are replaced; the codec is covered above.
function viewWorld({ members = [A, B, C, D, E], connected = A } = {}) {
    const html = readRepo('index.html', import.meta.url);
    const node = () => ({ style: {}, textContent: '', innerHTML: '', value: '', disabled: false, attrs: {}, handlers: {},
        addEventListener(type, fn) { this.handlers[type] = fn; }, setAttribute(k, v) { this.attrs[k] = String(v); }, focus() {},
        async fire(type = 'click') { await this.handlers[type]?.({ target: this }); } });
    const nodes = new Map([...html.matchAll(/id="(treasury-spend-[\w-]+)"/g)].map(([, id]) => [id, node()]));
    const w = { slot: node(), submitted: [], built: [], reads: 0, gate: null, selected: connected, seats: { pallet: 'council', members } };
    const api = { registry: { chainDecimals: [12] } };
    w.api = api;
    w.submitWith = async (opts) => { w.submitted.push(opts); return opts.buildTx(api); };
    w.ui = createSpendMotionUI({
        api: () => w.api, selected: () => w.selected, isMultisig: () => false,
        submit: (opts) => w.submitWith(opts), connectPrompt: () => '<a>Connect wallet</a>',
        document: { getElementById: (id) => nodes.get(id) },
        motion: {
            readSeats: async () => { w.reads++; const s = w.seats; if (w.gate) await w.gate; if (w.fail) throw new Error(w.fail); return s; },
            build: (_, pallet, v) => { w.built.push({ pallet, ...v }); return { method: { toHex: () => JSON.stringify(v) } }; },
            decode: () => ({ hash: '0x' + '12'.repeat(32), motion: { section: 'council', method: 'propose', args: [] }, spend: { section: 'treasury', method: 'spend', args: [] } })
        }
    });
    w.get = (id) => nodes.get('treasury-spend-' + id);
    w.fill = (f = {}) => { const v = { beneficiary: BEN, amount: '1500', 'valid-from': '', ...f }; for (const k in v) w.get(k).value = v[k]; };
    w.open = async () => { await w.ui.open(); await tick(); };
    w.reviewed = async () => { await w.open(); w.fill(); await w.get('check').fire(); };
    return w;
}

describe('the Propose a spend action', () => {
    test('disabled without a wallet or without a seat, and says why; enabled for a seat holder', async () => {
        for (const [connected, why] of [[null, /Connect the wallet of a council member/], [OUTSIDER, /holds no council seat/]]) {
            const w = viewWorld({ connected });
            w.ui.mount(w.slot); await tick();
            assert.match(w.slot.innerHTML, /id="treasury-spend-open"[^>]* disabled/);
            assert.match(w.slot.innerHTML, why);
            await w.slot.fire(); await tick();
            assert.notEqual(w.get('modal').style.display, 'flex', 'a disabled action does not open the dialog');
        }
        const m = viewWorld();
        m.ui.mount(m.slot); await tick();
        assert.doesNotMatch(m.slot.innerHTML, / disabled/);
        await m.slot.fire(); await tick();
        assert.equal(m.get('modal').style.display, 'flex');
        assert.equal(m.get('form').style.display, 'block');
        assert.equal(m.get('threshold').value, '3', 'the default is the minimum');
        assert.deepEqual([m.get('threshold').attrs.min, m.get('threshold').attrs.max], ['3', '5']);
        assert.match(m.get('threshold-hint').textContent, /three fifths of all 5 seats/);
    });
    test('a failed seat read says so, and the next render reads again', async () => {
        const w = viewWorld();
        w.fail = 'node unreachable';
        w.ui.mount(w.slot); await tick();
        assert.match(w.slot.innerHTML, /id="treasury-spend-open"[^>]* disabled/);
        assert.match(w.slot.innerHTML, /Could not read the council seats: node unreachable/);
        w.fail = null;
        w.ui.mount(w.slot); await tick();
        assert.doesNotMatch(w.slot.innerHTML, / disabled/, 'a tab switch re-renders the header and retries the read');
    });
    test('the dialog itself refuses a non-member: no form, nothing to review', async () => {
        const w = viewWorld({ connected: OUTSIDER });
        await w.open();
        assert.match(w.get('effect').textContent, /holds no council seat/);
        assert.notEqual(w.get('form').style.display, 'block');
        assert.equal(w.get('check').disabled, true);
        assert.equal(w.get('sign').disabled, true);
    });
});

describe('review, then sign', () => {
    test('a valid form shows the review and signs through submit with the reviewed account', async () => {
        const w = viewWorld();
        await w.reviewed();
        assert.equal(w.get('review').style.display, 'block');
        assert.match(w.get('review').innerHTML, /council\.propose/);
        assert.match(w.get('review').innerHTML, /treasury\.spend/);
        assert.equal(w.get('sign').disabled, false);
        await w.get('sign').fire(); await tick();
        assert.equal(w.submitted.length, 1);
        const s = w.submitted[0];
        assert.equal(s.expectedWallet, A);
        assert.equal(s.action.key, 'council.propose');
        assert.deepEqual(s.action.params, { amount: '1,500', beneficiary: BEN, threshold: 3, seats: 5, hash: '0x' + '12'.repeat(32) });
        assert.equal(w.built.length, 2, 'built for the review and again at signing');
        assert.deepEqual(w.built[1], w.built[0]);
        assert.equal(w.reads, 2, 'the seats are read again at signing');
    });
    test('an invalid field blocks the review; nothing is built or signed', async () => {
        const w = viewWorld();
        await w.open();
        for (const [field, value, rx] of [['amount', '50001', /needs a referendum/], ['beneficiary', 'nope', /Polkadex address/], ['valid-from', 'soon', /block number/], ['threshold', '2', /three fifths/]]) {
            w.fill(); w.get('threshold').value = '3';
            w.get(field).value = value;
            await w.get(field).fire('input');
            await w.get('check').fire();
            assert.match(w.get('error').textContent, rx, field);
            assert.equal(w.get('sign').disabled, true, field);
        }
        await w.get('sign').fire();
        assert.equal(w.built.length, 0);
        assert.equal(w.submitted.length, 0);
    });
    test('editing a field after the review needs a new review', async () => {
        const w = viewWorld();
        await w.reviewed();
        w.get('amount').value = '2000';
        await w.get('amount').fire('input');
        assert.equal(w.get('sign').disabled, true);
        assert.equal(w.get('review').style.display, 'none');
        await w.get('sign').fire();
        assert.equal(w.submitted.length, 0);
    });
    test('a seat change between review and signing refuses to sign', async () => {
        const w = viewWorld();
        await w.reviewed();
        w.seats = { pallet: 'council', members: [A, B, C, D, E, OUTSIDER] };
        await w.get('sign').fire(); await tick();
        assert.equal(w.built.length, 1, 'no call is built for the wallet');
        assert.match(w.get('error').textContent, /council seats changed/);
    });
});

describe('an account switch while the form is open', () => {
    test('accountChanged closes the dialog and the old review cannot be signed', async () => {
        const w = viewWorld();
        w.ui.mount(w.slot); await tick();
        await w.reviewed();
        w.selected = OUTSIDER;
        w.ui.accountChanged(); await tick();
        assert.equal(w.get('modal').style.display, 'none');
        assert.equal(w.get('sign').disabled, true);
        await w.get('sign').fire();
        assert.equal(w.submitted.length, 0);
        assert.match(w.slot.innerHTML, /holds no council seat/, 'the action is re-checked for the new account');
    });
    test('a switch the page has not announced yet still stops the signature', async () => {
        const w = viewWorld();
        await w.reviewed();
        w.selected = B;
        await w.get('sign').fire();
        assert.equal(w.submitted.length, 0);
    });
    test('a switch while the seats are read at signing fails before the wallet is asked', async () => {
        const w = viewWorld();
        await w.reviewed();
        let release; w.gate = new Promise(resolve => { release = resolve; });
        let rejected = null;
        w.submitWith = async (opts) => { w.submitted.push(opts); try { await opts.buildTx(w.api); } catch (e) { rejected = e; opts.onError(e.message); } };
        const signing = w.get('sign').fire();
        await tick();
        w.selected = B;
        release(); await signing; await tick();
        assert.match(String(rejected && rejected.message), /account, network or review changed/);
        assert.equal(w.built.length, 1, 'nothing built for the wallet');
    });
    test('a switch during the seat read at open leaves the form closed', async () => {
        const w = viewWorld();
        let release; w.gate = new Promise(resolve => { release = resolve; });
        const opening = w.ui.open();
        await tick();
        w.selected = B;
        release(); await opening; await tick();
        assert.notEqual(w.get('form').style.display, 'block');
        assert.equal(w.get('check').disabled, true);
    });
});

describe('after inclusion', () => {
    const H1 = '0x' + '34'.repeat(32), H2 = '0x' + '56'.repeat(32);
    const ev = (section, method, data = []) => ({ event: { section, method, data } });
    test('the status card links the new motion page, from the Proposed event or the reviewed hash', () => {
        const p = { amount: '1,500', beneficiary: BEN, threshold: 3, seats: 5, hash: H1 };
        const tabled = successCopy('council.propose', p, evaluateEvents([ev('council', 'Proposed', [A, 7, H2, 3])], null, {}));
        assert.equal(tabled.title, 'Motion tabled');
        assert.match(tabled.body, /The spend of 1,500 PDEX to \S+ is approved if 3 of 5 council members vote Aye/);
        assert.deepEqual(tabled.links[0], { href: `/council/motion/${H2}`, label: 'Open the motion' });
        assert.match(tabled.next, /treasury\.payout/);
        const fallback = successCopy('council.propose', p, evaluateEvents([ev('council', 'Proposed')], null, {}));
        assert.equal(fallback.links[0].href, `/council/motion/${H1}`);
    });
    test('a threshold-1 motion that ran at once says the spend still needs a payout', () => {
        const ran = successCopy('council.propose', { amount: '1', beneficiary: BEN, threshold: 1, seats: 1, hash: H1 }, evaluateEvents([ev('council', 'MemberExecuted', ['0xabc', { isErr: false, isOk: true }])], null, {}));
        assert.equal(ran.title, 'Motion executed');
        assert.match(ran.body, /treasury\.payout/);
    });
});

describe('help', () => {
    const topic = (slug) => HELP_TOPICS.find(t => t.slug === slug);
    test('the treasury article describes the form', () => {
        const t = topic('treasury').body;
        assert.match(t, /<b>Propose a spend<\/b>/);
        assert.match(t, /beneficiary/);
        assert.match(t, /valid-from block/);
        assert.match(t, /the threshold starts at, and cannot go below, three fifths of the seats/i);
        assert.match(t, /needs a referendum/);
        assert.match(t, /<b>Review motion<\/b>/);
        assert.match(t, /treasury\.payout/);
    });
    test('the council article points to it', () => {
        const t = topic('council-and-motions').body;
        assert.match(t, /<b>Propose a spend<\/b> on the Treasury page/);
        assert.match(t, /href="\/help\/treasury"/);
        assert.doesNotMatch(t, /The explorer has no form for tabling a council motion\./);
    });
});

describe('wiring', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));
    test('script.js signs through submitSignedTx, mounts the action on the Treasury header and follows the wallet and the node', () => {
        assert.match(script, /import \{ createSpendMotionUI \} from '\.\/lib\/treasury-spend-view\.js'/);
        assert.match(script, /createSpendMotionUI\(\{[^}]*submit: submitSignedTx/);
        const fn = bodyOf(script, 'renderTreasury');
        assert.match(fn, /id="treasury-spend-action"/);
        assert.match(fn, /spendMotionUI\.mount\(root\.querySelector\('#treasury-spend-action'\)\)/);
        assert.match(bodyOf(script, 'onWalletChanged'), /spendMotionUI\.accountChanged\(\)/);
        assert.match(bodyOf(script, 'adoptChainApi'), /spendMotionUI\.refresh\(\)/);
    });
    test('index.html has the dialog, a labelled close control and every field', () => {
        const html = readRepo('index.html', import.meta.url);
        for (const id of ['modal', 'close', 'account', 'effect', 'connect', 'form', 'beneficiary', 'amount', 'cap', 'valid-from', 'threshold', 'threshold-hint', 'review', 'error', 'check', 'edit', 'sign']) {
            assert.match(html, new RegExp(`id="treasury-spend-${id}"`), id);
        }
        assert.match(html, /<button[^>]*id="treasury-spend-close"[^>]*data-modal-close[^>]*aria-label="Close"/);
    });
});
