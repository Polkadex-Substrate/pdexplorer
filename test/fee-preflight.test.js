// An account must be able to pay the network fee before the wallet is asked.
//
// CTO report, 3 Nov 2026: "Leave council" stayed on Broadcasting for a council
// member whose account held 1 PDEX free (exactly the existential deposit) and
// 119.59 PDEX reserved (the candidacy bond and other deposits). Fees are paid
// from free balance with Preservation::Preserve: the account must keep the
// existential deposit, and reserved or frozen PDEX cannot pay. So the pool
// refused the transaction ("Inability to pay some fees") and nothing the user
// saw said why.
//
// Now every signed action (lib/tx-submit.js, used by submitSignedTx for the
// council withdrawal, votes, staking, multisig, transfers) estimates the fee
// first (tx.paymentInfo) and compares it with what the account can spend
// (lib/fee-preflight.js). Short: the wallet is never asked, and the dialog and
// card say how much to send. Estimation failing: the wallet still gets to try,
// with a warning. A pool rejection or an Invalid, Dropped or Usurped status
// ends the card at once with the reason.
//
// Run: npm test

import { test, describe, before, after, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiPromise } from '@polkadot/api';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import metadata from '@polkadot/types-support/metadata/static-substrate';
import { mockProvider } from './helpers/mock-provider.js';
import * as F from '../lib/fee-preflight.js';
import * as T from '../lib/tx-status.js';
import * as S from '../lib/tx-submit.js';
import { createCouncilCandidacyUI } from '../lib/council-candidacy-view.js';

const PDEX = 10n ** 12n;
const ADDR = 'esqZraiLVupqVqpTxGjsH9tdpqGy5a2f9eqTSr7ZLNHSXHDZ4';
const ADDR42 = encodeAddress(decodeAddress(ADDR), 42);
const HASH = '0x' + 'ab'.repeat(32);
const FEE = 15300000000n;                  // 0.0153 PDEX
const RESERVED = 11959n * PDEX / 100n;     // 119.59 PDEX
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const REPORTED = { free: PDEX, reserved: RESERVED, frozen: 0n, ed: PDEX };
const REPORTED_TEXT = 'This account needs at least 1.0153 PDEX free to pay the network fee. It has 1 PDEX free; 119.59 PDEX is reserved (deposits, bonds) and cannot pay fees. Send at least 0.0153 PDEX to this account and try again.';

describe('feeShortfall: what the account can spend on a fee (spec 392 rules)', () => {
    test('the reported account: free equal to the existential deposit cannot pay any fee', () => {
        const s = F.feeShortfall({ ...REPORTED, fee: FEE });
        assert.ok(s, 'free == ED must be short');
        assert.equal(s.needed, PDEX + FEE);
        assert.equal(s.topUp, FEE);
        assert.equal(F.feeShortText(s), REPORTED_TEXT);
    });

    test('enough free balance passes; exactly ED plus the fee passes', () => {
        assert.equal(F.feeShortfall({ ...REPORTED, free: 2n * PDEX, fee: FEE }), null);
        assert.equal(F.feeShortfall({ ...REPORTED, free: PDEX + FEE, fee: FEE }), null);
        assert.ok(F.feeShortfall({ ...REPORTED, free: PDEX + FEE - 1n, fee: FEE }));
    });

    test('reserved PDEX never counts, however large', () => {
        assert.ok(F.feeShortfall({ free: PDEX, reserved: 1000000n * PDEX, frozen: 0n, ed: PDEX, fee: 1n }));
    });

    test('frozen applies to the total: only frozen above reserved is untouchable, and never less than ED', () => {
        // frozen 50, reserved 20: 30 untouchable in free.
        assert.equal(F.feeShortfall({ free: 31n * PDEX, reserved: 20n * PDEX, frozen: 50n * PDEX, ed: PDEX, fee: FEE }), null);
        const s = F.feeShortfall({ free: 30n * PDEX, reserved: 20n * PDEX, frozen: 50n * PDEX, ed: PDEX, fee: FEE });
        assert.ok(s);
        assert.equal(s.needed, 30n * PDEX + FEE);
        assert.match(F.feeShortText(s), /30 PDEX is locked/);
        // frozen below reserved: the ED is the floor.
        assert.equal(F.feeShortfall({ free: PDEX + FEE, reserved: 20n * PDEX, frozen: 10n * PDEX, ed: PDEX, fee: FEE }), null);
    });

    test('a keep-alive transfer adds the amount', () => {
        const base = { free: 10n * PDEX, reserved: 0n, frozen: 0n, ed: PDEX, fee: FEE };
        assert.equal(F.feeShortfall({ ...base, amount: 5n * PDEX, keepAlive: true }), null);
        const s = F.feeShortfall({ ...base, amount: 9n * PDEX, keepAlive: true });
        assert.ok(s);
        assert.equal(s.needed, 10n * PDEX + FEE);
        const text = F.feeShortText(s);
        assert.match(text, /needs at least 10\.0153 PDEX free to send 9 PDEX and pay the network fee/);
        assert.match(text, /Send at least 0\.0153 PDEX to this account/);
        assert.doesNotMatch(text, /reserved/, 'no reserved clause when nothing is reserved');
    });

    test('an allow-death transfer may empty the account but the fee still keeps ED', () => {
        const base = { free: 10n * PDEX, reserved: 0n, frozen: 0n, ed: PDEX, fee: FEE, keepAlive: false };
        assert.equal(F.feeShortfall({ ...base, amount: 10n * PDEX - FEE }), null);
        assert.ok(F.feeShortfall({ ...base, amount: 10n * PDEX }));
    });

    test('amounts to send are rounded up, never down', () => {
        const s = F.feeShortfall({ free: PDEX, reserved: 0n, frozen: 0n, ed: PDEX, fee: 100000001n });
        assert.match(F.feeShortText(s), /Send at least 0\.0002 PDEX/);
        assert.match(F.feeShortText(s), /needs at least 1\.0002 PDEX free/);
    });
});

let chain;
before(async () => { chain = await ApiPromise.create({ provider: mockProvider({ metadataHex: metadata }).provider, noInitWarn: true }); });
after(async () => { await chain?.disconnect(); });

describe('transferOf: which transactions move an amount out of the signer', () => {
    test('reads real balances calls; anything else, a multisig wrapper included, is fee only', () => {
        const dest = encodeAddress(new Uint8Array(32).fill(3), 42);
        assert.deepEqual(F.transferOf(chain.tx.balances.transferKeepAlive(dest, '5000000000000')), { amount: 5n * PDEX, keepAlive: true });
        assert.deepEqual(F.transferOf(chain.tx.balances.transferAllowDeath(dest, '7')), { amount: 7n, keepAlive: false });
        assert.equal(F.transferOf(chain.tx.elections.renounceCandidacy('Member')), null);
        assert.equal(F.transferOf(chain.tx.system.remark('0x00')), null);
        assert.equal(F.transferOf(null), null);
    });
});

// A fake api and transaction for feePreflight and the tracker.
function chainState({ free = PDEX, reserved = RESERVED, frozen = 0n, ed = PDEX, fee = FEE, feeError = null, accountError = null } = {}) {
    const s = { free, reserved, frozen, ed, fee, feeError, accountError, accountReads: [], feeReads: [] };
    s.api = {
        registry: {},
        consts: { balances: { existentialDeposit: { toString: () => String(s.ed) } } },
        query: { system: { account: async (a) => {
            s.accountReads.push(a);
            if (s.accountError) throw s.accountError;
            return { data: { free: { toString: () => String(s.free) }, reserved: { toString: () => String(s.reserved) }, frozen: { toString: () => String(s.frozen) } } };
        } } },
        on() {}, off() {},
        rpc: { chain: { getHeader: async () => ({ number: { toNumber: () => 42 } }) }, system: { accountNextIndex: async () => ({ toNumber: () => 7 }) } }
    };
    s.tx = (method = { section: 'elections', method: 'renounceCandidacy', args: [] }) => ({
        method, nonce: { toNumber: () => 7 },
        paymentInfo: async (a) => { s.feeReads.push(a); if (s.feeError) throw s.feeError; return { partialFee: { toString: () => String(s.fee) } }; },
        signAndSend: null
    });
    return s;
}

describe('feePreflight: estimate, read, decide', () => {
    test('short: the reported account is blocked with the message and a prefix-88 address to fund', async () => {
        const s = chainState();
        const r = await F.feePreflight(s.api, s.tx(), ADDR42);
        assert.equal(r.status, 'short');
        assert.equal(r.text, REPORTED_TEXT);
        assert.equal(r.fundAddress, ADDR);
        assert.deepEqual(s.feeReads, [ADDR42]);
    });

    test('enough: ok', async () => {
        const s = chainState({ free: 3n * PDEX });
        assert.equal((await F.feePreflight(s.api, s.tx(), ADDR)).status, 'ok');
    });

    test('a transfer includes its amount', async () => {
        const s = chainState({ free: 10n * PDEX, reserved: 0n });
        const tx = chain.tx.balances.transferKeepAlive(encodeAddress(new Uint8Array(32).fill(3), 42), String(9n * PDEX));
        tx.paymentInfo = async () => ({ partialFee: { toString: () => String(FEE) } });
        const r = await F.feePreflight(s.api, tx, ADDR);
        assert.equal(r.status, 'short');
        assert.match(r.text, /to send 9 PDEX and pay the network fee/);
    });

    test('fee estimation failing, or the balance read failing, lets the wallet try with a warning', async () => {
        for (const opts of [{ feeError: new Error('1002: Verification Error') }, { accountError: new Error('socket closed') }]) {
            const s = chainState(opts);
            const r = await F.feePreflight(s.api, s.tx(), ADDR);
            assert.equal(r.status, 'unknown');
            assert.match(r.warning, /could not estimate the network fee/i);
            assert.match(r.warning, /wallet/i);
        }
    });

    test('a hung estimate is bounded and counts as unknown', async () => {
        const s = chainState();
        const tx = s.tx();
        tx.paymentInfo = () => new Promise(() => {});
        const r = await F.feePreflight(s.api, tx, ADDR, { timeoutMs: 20 });
        assert.equal(r.status, 'unknown');
    });
});

// --- The tracker: every signed action goes through send() ---------------------
const fakeButton = () => ({ disabled: false, attrs: {}, innerHTML: 'Leave', textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });
function harness(opts = {}) {
    const s = chainState(opts.chain);
    const shown = [];
    const show = (a, st, ev, err, ex) => { const m = T.buildTxModel(a, st, ev, err, ex); shown.push(m); return m; };
    const calls = { onError: [], errorModels: [], onSuccess: 0, stages: [], sends: 0, verify: 0 };
    let cb = null;
    const tx = s.tx(opts.method);
    tx.signAndSend = (addr, o, f) => { calls.sends++; cb = f; return opts.signAndSend ? opts.signAndSend() : Promise.resolve(() => {}); };
    const button = fakeButton();
    const run = S.trackSignedTx({ api: s.api, button, show, idleText: 'Sign & leave council',
        action: { id: 'f1', key: 'elections.withdraw', params: { role: 'Member' } },
        verify: async () => { calls.verify++; return 'pending'; },
        onError: (t, m) => { calls.onError.push(t); calls.errorModels.push(m); }, onSuccess: () => { calls.onSuccess++; }, onStage: (st) => calls.stages.push(st) });
    const emit = async (status) => { cb({ status, events: [], txHash: { toHex: () => HASH } }); await flush(); };
    return { s, run, tx, shown, calls, button, emit, last: () => shown[shown.length - 1] };
}

describe('the tracker checks the fee before the wallet is asked', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());

    test('short: the wallet is never asked; failed card and onError carry the message; the button works again', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, ADDR42, {});
        assert.equal(h.calls.sends, 0, 'the wallet must not be asked');
        const m = h.last();
        assert.equal(m.stage, 'failed');
        assert.equal(m.body, REPORTED_TEXT);
        assert.equal(m.code, null, 'nothing was signed, so no support code');
        assert.equal(m.fundAddress, ADDR);
        assert.deepEqual(h.calls.onError, [REPORTED_TEXT]);
        assert.equal(h.calls.errorModels[0].fundAddress, ADDR);
        assert.equal(h.button.disabled, false);
        assert.equal(h.button.textContent, 'Sign & leave council');
        assert.equal(h.calls.stages[h.calls.stages.length - 1], 'failed');
        const html = T.txCardHtml(m, esc);
        assert.match(html, /class="tx-card-copy-address"[^>]*data-address="esqZrai/);
        assert.match(html, />Copy address</);
    });

    test('enough: signs and sends as before', async () => {
        const h = harness({ chain: { free: 3n * PDEX } });
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        assert.equal(h.calls.sends, 1);
        assert.equal(h.calls.onError.length, 0);
    });

    test('estimation failing: the wallet is still asked, and the signing card warns', async () => {
        const h = harness({ chain: { feeError: new Error('boom') } });
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        assert.equal(h.calls.sends, 1);
        const m = h.last();
        assert.equal(m.stage, 'signing');
        assert.match(m.next, /could not estimate the network fee/i);
    });

    test('the pool refusing the fee ends the card at once with the reason, and no watchdog keeps running', async () => {
        const h = harness({ chain: { free: 3n * PDEX },
            signAndSend: () => Promise.reject(new Error('1010: Invalid Transaction: Inability to pay some fees , e.g. account balance too low')) });
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        const m = h.last();
        assert.equal(m.stage, 'failed');
        assert.equal(m.key, 'pool.Payment');
        assert.match(m.body, /network fee/);
        assert.match(m.body, /reserved/i, 'say that reserved PDEX cannot pay');
        assert.equal(h.calls.onError.length, 1);
        assert.equal(h.button.disabled, false);
        mock.timers.tick(T.WATCHDOG_MS * 6); await flush();
        assert.equal(h.calls.verify, 0);
    });

    for (const type of ['Invalid', 'Dropped', 'Usurped']) {
        test(`${type} after Sent ends the card at once with its reason`, async () => {
            const h = harness({ chain: { free: 3n * PDEX } });
            h.run.start();
            await h.run.send(h.tx, ADDR, {});
            await h.emit({ type: 'Ready' });
            await h.emit({ type });
            const m = h.last();
            assert.equal(m.stage, 'failed');
            assert.equal(m.key, 'pool.' + type);
            assert.equal(m.body, T.STATUS_FAILURE_TEXT[type]);
            assert.equal(h.calls.onError.length, 1);
            assert.equal(h.button.disabled, false);
            mock.timers.tick(T.WATCHDOG_MS * 6); await flush();
            assert.equal(h.calls.verify, 0, 'the watchdog must stop with the failure');
        });
    }
});

// --- The council Leave dialog -------------------------------------------------
function dialog(chainOpts) {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const nodes = new Map([...html.matchAll(/id="((?:council-withdraw|close-council-withdraw|cancel-council-withdraw)[^"]*)"/g)].map(([, id]) => [id, {
        id, style: {}, textContent: '', innerHTML: '', disabled: false, checked: false, handlers: {},
        addEventListener(type, fn) { this.handlers[type] = fn; }, focus() {}, setAttribute() {}, removeAttribute() {},
        async fire(type = 'click') { await this.handlers[type]?.({ target: this }); }
    }]));
    const s = chainState(chainOpts);
    const sends = [];
    const api = {
        ...s.api,
        genesisHash: { toHex: () => '0xg' }, runtimeVersion: { specVersion: { toString: () => '392' } },
        query: { ...s.api.query, elections: { members: () => {}, runnersUp: () => {}, candidates: () => {} } },
        tx: { elections: { renounceCandidacy: () => { const t = s.tx(); t.signAndSend = () => { sends.push(1); return Promise.resolve(() => {}); }; return t; } } },
        rpc: { ...s.api.rpc, chain: { ...s.api.rpc.chain, getBlockHash: async () => '0xh' } },
        at: async () => ({ query: { elections: { members: async () => [{ who: ADDR }], runnersUp: async () => [], candidates: async () => [] } } })
    };
    const copied = [];
    // What script.js's submitSignedTx does, without the wallet lookup.
    const submit = async (o) => {
        const run = S.trackSignedTx({ api, action: { ...o.action, label: o.label, id: 'c1' }, button: o.button, idleText: o.idleText,
            onError: o.onError, onSuccess: o.onSuccess, onStage: o.onStage, verify: o.verify, show: T.buildTxModel });
        run.start();
        try { const tx = await o.buildTx(api); await run.send(tx, ADDR, {}); } catch (e) { run.buildFailed(e); }
    };
    const ui = createCouncilCandidacyUI({ api: () => api, selected: () => ADDR, isMultisig: () => false,
        document: { getElementById: id => nodes.get(id) }, submit, refresh: () => {}, connectPrompt: () => '',
        copyText: async (t) => { copied.push(t); } });
    return { ui, s, get: id => nodes.get(id), sends, copied };
}

describe('the council Leave dialog shows the fee shortfall', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());

    test('blocked inline with the message, the bond note and a Copy address button; Sign stays enabled', async () => {
        const d = dialog();
        await d.ui.open();
        assert.equal(d.get('council-withdraw-copy-address').style.display, 'none');
        d.get('council-withdraw-ack').checked = true;
        await d.get('council-withdraw-ack').fire('change');
        await d.get('council-withdraw-sign').fire();
        await flush();
        assert.equal(d.sends.length, 0, 'the wallet must not be asked');
        const err = d.get('council-withdraw-error').textContent;
        assert.ok(err.startsWith(REPORTED_TEXT), err);
        assert.match(err, /candidacy bond is returned only after the withdrawal succeeds, so it cannot pay this fee/i);
        const copy = d.get('council-withdraw-copy-address');
        assert.notEqual(copy.style.display, 'none');
        await copy.fire();
        assert.deepEqual(d.copied, [ADDR]);
        assert.equal(d.get('council-withdraw-sign').disabled, false, 'Sign must stay enabled to retry after funding');
        assert.equal(d.get('council-withdraw-ack').disabled, false);

        // Funded: the same button now goes to the wallet.
        d.s.free = 2n * PDEX;
        await d.get('council-withdraw-sign').fire();
        await flush();
        assert.equal(d.sends.length, 1);
        assert.equal(d.get('council-withdraw-copy-address').style.display, 'none');
    });

    test('the review copy says the bond is released only after success and cannot pay the fee', () => {
        const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
        const review = html.slice(html.indexOf('id="council-withdraw-review"'), html.indexOf('id="council-withdraw-error"'));
        assert.match(review, /bond is released only after the withdrawal succeeds/i);
        assert.match(review, /cannot pay (?:this|the) (?:transaction|network) fee/i);
        assert.match(review, /free PDEX/);
    });
});

describe('script.js wiring', () => {
    test('the council dialog gets a clipboard writer', () => {
        const src = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
        assert.match(src, /createCouncilCandidacyUI\(\{[\s\S]{0,600}copyText:/);
    });
    test('the status card copies the address to fund', () => {
        const src = readFileSync(new URL('../lib/tx-status-card.js', import.meta.url), 'utf8');
        assert.match(src, /tx-card-copy-address/);
    });
});
