// Paying out an approved treasury spend from the Treasury page's Spends tab.
//
// The rules, from the source (pallet-treasury 44.0.0, polkadot-stable2512-3,
// substrate/frame/treasury/src/lib.rs) and the runtime (polkadex-node, branch
// mainnet, runtimes/mainnet/src/lib.rs, spec 393):
//   payout(index), any signed account:
//     ensure!(now >= spend.valid_from, EarlyPayout);
//     ensure!(spend.expire_at > now, SpendExpired);
//     ensure!(matches!(spend.status, Pending | Failed), AlreadyAttempted);
//     then Paymaster::pay, status = Attempted { id }, event Paid. DispatchResult, so the fee is kept.
//   check_status(index), any signed account:
//     now > expire_at and not Attempted: removed, SpendProcessed, Pays::No;
//     not Attempted: NotAttempted; Attempted: check_payment, and on Success or
//     Unknown removed, SpendProcessed, Pays::No; Failure: Failed, PaymentFailed, Pays::Yes.
//   now is BlockNumberProvider = System::block_number(): the block the
//   transaction executes in, the best head + 1.
//   Paymaster = PayFromAccount<Balances, TreasuryAccount>: pay() is a
//   synchronous Balances transfer (an error fails the call with PayoutError) and
//   check_payment() always returns Success.
//   PayoutPeriod = SpendPeriod = 24 days of 12 s blocks (172,800).

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ApiPromise } from '@polkadot/api';
import { encodeAddress } from '@polkadot/util-crypto';
import { u8aConcat, compactToU8a, u8aToHex } from '@polkadot/util';
import * as payoutLib from '../lib/treasury-payout.js';
import { trackSignedTx } from '../lib/tx-submit.js';
import { WATCHDOG_MS } from '../lib/tx-status.js';

const {
    classifySpend, formatSpendAmount, blockEta, buildSpendTx, readSpends, readSpend, readPot, treasuryPotAccount, spendVerdict, spendFromChain,
    findPaidEvent, PAID_SCAN_MAX_BLOCKS, PAYOUT_FEE_TEXT, CHECK_FEE_TEXT
} = payoutLib;
import { registerTreasurySpendsRoute, SPENDS_ROUTE } from '../lib/treasury-payout-api.js';
import { spendColumns, createSpendPayoutUI } from '../lib/treasury-payout-view.js';
import { evaluateEvents, successCopy, buildTxModel, decodeDispatchError, ERROR_COPY, PENDING_TITLE } from '../lib/tx-status.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { allRoutes, CACHE_TIERS } from '../lib/api-reference.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { loadFixture } from './helpers/extrinsic-builders.js';
import { mockProvider } from './helpers/mock-provider.js';

// Made-up accounts (public repo).
const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const BEN = addr(9), ME = addr(1), OTHER = addr(2);
const tick = () => new Promise(resolve => setImmediate(resolve));
const spend = (over = {}) => ({ index: 7, amount: '1500000000000000', beneficiary: BEN, validFrom: 1000, expireAt: 2000, status: 'Pending', ...over });

describe('what a spend allows in the block a transaction would run in', () => {
    const at = (now, over) => classifySpend(spend(over), now);
    test('before valid_from: no action, "Payable from block N"', () => {
        const c = at(999);
        assert.equal(c.action, null);
        assert.equal(c.phase, 'scheduled');
        assert.match(c.note, /^Payable from block 1,000/);
    });
    test('at valid_from: Pay out (now >= valid_from)', () => {
        const c = at(1000);
        assert.equal(c.action, 'payout');
        assert.equal(c.actionLabel, 'Pay out');
        assert.equal(c.phase, 'payable');
    });
    test('the last block before expire_at: no button, "Expires next block" (a transaction that slips one block lands at expire_at and fails)', () => {
        for (const status of ['Pending', 'Failed']) {
            const c = at(1999, { status });
            assert.equal(c.phase, 'expiring', status);
            assert.equal(c.action, null, status);
            assert.equal(c.note, 'Expires next block; paying now may fail', status);
        }
        assert.equal(at(1998).action, 'payout', 'two blocks before expire_at is still payable');
    });
    test('at expire_at: expired, and nothing can be submitted yet (check_status needs now > expire_at)', () => {
        const c = at(2000);
        assert.equal(c.phase, 'expired');
        assert.equal(c.action, null);
        assert.equal(c.note, 'Expired: can no longer be paid');
    });
    test('after expire_at: expired, and Check status clears it with the fee refunded', () => {
        const c = at(2001);
        assert.equal(c.phase, 'expired');
        assert.equal(c.action, 'checkStatus');
        assert.match(c.actionLabel, /Clear/);
        assert.equal(c.note, 'Expired: can no longer be paid');
    });
    test('Attempted: paid (PayFromAccount transfers at payout), Check status at any block', () => {
        for (const now of [500, 1500, 2000, 99999]) {
            const c = at(now, { status: 'Attempted' });
            assert.equal(c.phase, 'paid', String(now));
            assert.equal(c.statusText, 'Paid');
            assert.equal(c.action, 'checkStatus');
            assert.equal(c.actionLabel, 'Check status');
        }
    });
    test('the treasury pot cannot cover the amount: no button, "unfunded", the pot in the note (PayFromAccount::pay would fail with PayoutError and the fee is kept)', () => {
        for (const status of ['Pending', 'Failed']) {
            const c = classifySpend(spend({ status }), 1500, { pot: '1000000000000000' });
            assert.equal(c.phase, 'unfunded', status);
            assert.equal(c.action, null, status);
            assert.equal(c.note, 'The treasury holds 1,000 PDEX, less than this spend; it cannot be paid until the pot is refilled', status);
        }
        assert.equal(classifySpend(spend(), 1500, { pot: '1500000000000000' }).action, 'payout', 'a pot of exactly the amount pays it');
        assert.equal(classifySpend(spend(), 1500, { pot: null }).action, 'payout', 'an unknown pot does not hold the button');
        assert.match(classifySpend(spend(), 1500, { pot: '15000000000000', decimals: 10 }).note, /holds 1,500 PDEX/);
        assert.equal(classifySpend(spend(), 999, { pot: '0' }).phase, 'scheduled', 'scheduled before valid_from whatever the pot');
        assert.equal(classifySpend(spend({ status: 'Attempted' }), 1500, { pot: '0' }).action, 'checkStatus', 'a paid spend is checked whatever the pot');
    });
    test('Failed: retried with payout inside the window, expired after it', () => {
        assert.equal(at(1500, { status: 'Failed' }).action, 'payout');
        assert.equal(at(1500, { status: 'Failed' }).actionLabel, 'Retry payout');
        assert.equal(at(1500, { status: 'Failed' }).statusText, 'Payment failed');
        assert.equal(at(2000, { status: 'Failed' }).action, null);
        assert.equal(at(2001, { status: 'Failed' }).action, 'checkStatus');
    });
    test('an unknown block or an unknown status offers nothing', () => {
        assert.equal(classifySpend(spend(), null).action, null);
        assert.equal(classifySpend(spend(), NaN).action, null);
        assert.equal(classifySpend(spend({ status: 'Weird' }), 1500).action, null);
        assert.equal(classifySpend(null, 1500).action, null);
    });
    test('the estimated date is appended to "Payable from" when a formatter is given', () => {
        assert.equal(classifySpend(spend(), 999, { eta: (b) => `day of ${b}` }).note, 'Payable from block 1,000 (~day of 1000)');
    });
    test('the fee texts follow the dispatch Pays of each call', () => {
        assert.match(PAYOUT_FEE_TEXT, /anyone can submit/i);
        assert.match(PAYOUT_FEE_TEXT, /not refunded/);
        assert.match(CHECK_FEE_TEXT, /anyone can submit/i);
        assert.match(CHECK_FEE_TEXT, /refunded/);
    });
});

describe('amounts and dates', () => {
    test('12 decimals, every digit kept, thousands separated', () => {
        assert.equal(formatSpendAmount('1500000000000000'), '1,500 PDEX');
        assert.equal(formatSpendAmount('1'), '0.000000000001 PDEX');
        assert.equal(formatSpendAmount('1234567890123456789'), '1,234,567.890123456789 PDEX');
        assert.equal(formatSpendAmount('340282366920938463463374607431768211455'), '340,282,366,920,938,463,463,374,607.431768211455 PDEX');
        assert.equal(formatSpendAmount('1500000000000000', 10), '150,000 PDEX');
    });
    test('anything not a whole planck number is a dash', () => {
        for (const x of [null, undefined, '', 'abc', '1.5', '-1']) assert.equal(formatSpendAmount(x), '-', String(x));
    });
    test('blockEta counts blocks from a known block and time, both ways', () => {
        assert.equal(blockEta(110, { block: 100, at: 1_000_000, blockMs: 12000 }), 1_120_000);
        assert.equal(blockEta(90, { block: 100, at: 1_000_000, blockMs: 12000 }), 880_000);
        assert.equal(blockEta(110, { block: null, at: 1, blockMs: 12000 }), null);
        assert.equal(blockEta(110, { block: 100, at: 1, blockMs: 0 }), null);
    });
});

// A storage value as polkadot-js gives it, for the chain readers.
const codecSpend = (s) => ({
    assetKind: { toJSON: () => null }, amount: { toString: () => s.amount }, beneficiary: { toString: () => s.beneficiary },
    validFrom: { toNumber: () => s.validFrom }, expireAt: { toNumber: () => s.expireAt }, status: { type: s.status }
});
const some = (v) => ({ isSome: true, isNone: false, unwrap: () => v });
const NONE = { isSome: false, isNone: true, unwrap: () => { throw new Error('none'); } };

// A fake api with a spends map; entriesPaged pages by index order.
const PALLET_ID = new Uint8Array([...'py/trsry'].map(ch => ch.charCodeAt(0)));
const accountData = ({ free, frozen, miscFrozen, feeFrozen }) => ({ data: {
    free: { toString: () => free }, reserved: { toString: () => '0' },
    ...(frozen != null ? { frozen: { toString: () => frozen } } : {}),
    ...(miscFrozen != null ? { miscFrozen: { toString: () => miscFrozen }, feeFrozen: { toString: () => feeFrozen } } : {})
} });
// events: block number -> [[section, method, index], ...], the System.Events
// of that block (raw storage read, decoded with the registry), for the
// payment evidence (#72); a block in `unreadable` fails to read.
function fakeChain({ head = 1500, count = 9, spends = [spend()], blockTime = 12000, pot = { free: '1000000000000000000' }, ed = '1000000000000', events = {}, unreadable = [] } = {}) {
    const calls = { pages: [], accounts: [], eventBlocks: [] };
    const byIndex = new Map(spends.map(s => [s.index, s]));
    const key = (i) => ({ args: [{ toNumber: () => i }], toHex: () => '0x' + i.toString(16).padStart(8, '0') });
    const record = ([section, method, index]) => ({ phase: { isApplyExtrinsic: true }, event: { section, method, data: [{ toString: () => String(index) }] } });
    const api = {
        registry: {
            chainDecimals: [12],
            createType: (type, bytes) => { assert.equal(type, 'Vec<EventRecord>'); return (c.events[bytes.block] || []).map(record); }
        },
        rpc: {
            chain: {
                getHeader: async () => ({ number: { toNumber: () => head } }),
                getBlockHash: async (n) => ({ block: Number(n), toHex: () => `0xb${Number(n)}` })
            },
            state: {
                getStorage: async (k, hash) => {
                    assert.equal(k, 'system-events-key');
                    calls.eventBlocks.push(hash.block);
                    if (c.unreadable.includes(hash.block)) throw new Error('state_getStorage failed');
                    return some({ block: hash.block });
                }
            }
        },
        consts: {
            babe: { expectedBlockTime: { toNumber: () => blockTime } },
            treasury: { payoutPeriod: { toNumber: () => 172800 }, palletId: { toU8a: () => PALLET_ID } },
            balances: { existentialDeposit: { toString: () => ed } }
        },
        query: {
            system: { number: async () => ({ toNumber: () => head }), account: async (who) => { calls.accounts.push(who); return accountData(c.pot); },
                events: { key: () => 'system-events-key' } },
            treasury: {
                spendCount: async () => ({ toNumber: () => count }),
                spends: Object.assign(async (i) => byIndex.has(Number(i)) ? some(codecSpend(byIndex.get(Number(i)))) : NONE, {
                    entriesPaged: async ({ pageSize, startKey }) => {
                        calls.pages.push({ pageSize, startKey });
                        const all = [...byIndex.keys()].sort((a, b) => a - b);
                        const from = startKey ? all.findIndex(i => key(i).toHex() === startKey) + 1 : 0;
                        return all.slice(from, from + pageSize).map(i => [key(i), some(codecSpend(byIndex.get(i)))]);
                    }
                })
            }
        },
        tx: { treasury: { payout: (i) => ({ method: { toHex: () => `payout(${i})` } }), checkStatus: (i) => ({ method: { toHex: () => `check(${i})` } }) } }
    };
    const c = { api, calls, byIndex, pot, events: { ...events }, unreadable: [...unreadable], set head(h) { head = h; } };
    return c;
}

describe('reading the spends from the chain', () => {
    test('spendFromChain keeps planck strings, block numbers and the status variant', () => {
        assert.deepEqual(spendFromChain(3, codecSpend(spend({ status: 'Attempted' }))),
            { index: 3, amount: '1500000000000000', beneficiary: BEN, validFrom: 1000, expireAt: 2000, status: 'Attempted' });
    });
    test('readSpends: head, next block, count, payout period, block time; newest first; each row classified for the next block', async () => {
        const c = fakeChain({ head: 1999, spends: [spend({ index: 2 }), spend({ index: 8, status: 'Attempted' }), spend({ index: 5, validFrom: 3000, expireAt: 4000 })] });
        const r = await readSpends(c.api);
        assert.equal(r.block, 1999);
        assert.equal(r.nextBlock, 2000);
        assert.equal(r.spendCount, 9);
        assert.equal(r.payoutPeriod, 172800);
        assert.equal(r.blockTimeMs, 12000);
        assert.equal(r.decimals, 12);
        assert.equal(r.truncated, false);
        assert.deepEqual(r.pot, { free: '1000000000000000000', available: '999999000000000000' }, 'the pot: free balance less the existential deposit');
        assert.deepEqual(r.spends.map(s => s.index), [8, 5, 2]);
        assert.deepEqual(r.spends.map(s => [s.phase, s.action]), [['paid', 'checkStatus'], ['scheduled', null], ['expired', null]],
            'classified for block 2000, where expire_at 2000 is already past payout');
    });
    test('bounded: pages of pageSize, at most maxEntries, and says when there may be more', async () => {
        const many = Array.from({ length: 12 }, (_, i) => spend({ index: i }));
        const c = fakeChain({ spends: many });
        const r = await readSpends(c.api, { pageSize: 5, maxEntries: 10 });
        assert.equal(r.spends.length, 10);
        assert.equal(r.truncated, true);
        assert.ok(c.calls.pages.length <= 3, 'one page past the cap at most');
        assert.ok(c.calls.pages.every(p => p.pageSize === 5));
        const all = await readSpends(fakeChain({ spends: many.slice(0, 7) }).api, { pageSize: 5, maxEntries: 10 });
        assert.equal(all.spends.length, 7);
        assert.equal(all.truncated, false);
    });
    test('truncated only when entries exist beyond the cap: exactly maxEntries in storage is not truncated', async () => {
        const many = (n) => Array.from({ length: n }, (_, i) => spend({ index: i }));
        for (const [n, pageSize] of [[10, 5], [10, 10], [10, 3]]) {
            const r = await readSpends(fakeChain({ spends: many(n) }).api, { pageSize, maxEntries: 10 });
            assert.equal(r.spends.length, 10, `${n}/${pageSize}`);
            assert.equal(r.truncated, false, `${n} spends, pages of ${pageSize}, cap 10`);
        }
        for (const [n, pageSize] of [[11, 5], [11, 10], [11, 3], [11, 11]]) {
            const r = await readSpends(fakeChain({ spends: many(n) }).api, { pageSize, maxEntries: 10 });
            assert.equal(r.spends.length, 10, `${n}/${pageSize}`);
            assert.equal(r.truncated, true, `${n} spends, pages of ${pageSize}, cap 10`);
        }
    });
    test('the treasury pot: the pallet account (modl + palletId, zero padded), free less max(existential deposit, frozen)', async () => {
        const c = fakeChain();
        assert.deepEqual(await readPot(c.api), { free: '1000000000000000000', available: '999999000000000000' });
        const want = new Uint8Array(32); want.set([109, 111, 100, 108]); want.set(PALLET_ID, 4);
        assert.deepEqual([...c.calls.accounts[0]], [...want]);
        assert.deepEqual([...treasuryPotAccount(c.api)], [...want]);
        c.pot = { free: '5000000000000', frozen: '3000000000000' };
        assert.deepEqual(await readPot(c.api), { free: '5000000000000', available: '2000000000000' }, 'a freeze above the deposit is kept back');
        c.pot = { free: '5000000000000', miscFrozen: '4000000000000', feeFrozen: '0' };
        assert.deepEqual(await readPot(c.api), { free: '5000000000000', available: '1000000000000' }, 'older AccountData: miscFrozen / feeFrozen');
        c.pot = { free: '500000000000' };
        assert.deepEqual(await readPot(c.api), { free: '500000000000', available: '0' }, 'never below zero');
    });
    test('the pot unknown (no palletId, no system.account, or a failed read) is null and holds nothing', async () => {
        const c = fakeChain();
        delete c.api.consts.treasury.palletId;
        assert.equal(await readPot(c.api), null);
        const d = fakeChain();
        d.api.query.system.account = async () => { throw new Error('rpc gone'); };
        assert.equal(await readPot(d.api), null);
        const r = await readSpends(d.api);
        assert.equal(r.pot, null);
        assert.equal(r.spends[0].action, 'payout');
    });
    test('readSpends classifies against the pot: a spend larger than it is unfunded', async () => {
        const c = fakeChain({ spends: [spend({ index: 1, amount: '1000000000000' }), spend({ index: 2, amount: '1500000000000000' })], pot: { free: '101000000000000' } });
        const r = await readSpends(c.api);
        assert.deepEqual(r.spends.map(s => [s.index, s.phase, s.action]), [[2, 'unfunded', null], [1, 'payable', 'payout']]);
    });
    test('a runtime without spends says so', async () => {
        await assert.rejects(readSpends({ query: { treasury: {} } }), /not available on this runtime/);
    });
    test('readSpend: one spend and the block a transaction would run in', async () => {
        const c = fakeChain({ head: 1200 });
        const pot = { free: '1000000000000000000', available: '999999000000000000' };
        assert.deepEqual(await readSpend(c.api, 7), { next: 1201, spend: spend(), pot });
        assert.deepEqual(await readSpend(c.api, 99), { next: 1201, spend: null, pot });
    });
    // #72: "gone" is not proof of payment. check_status also removes an
    // expired unpaid spend (SpendProcessed) and void_spend a Pending one
    // (AssetSpendVoided), so an absent spend is applied only with a Paid
    // event for it; without one it is 'unverified'. The old expectation here
    // was spendVerdict('payout', null) === 'applied'.
    test('the watchdog verdict: payout is on chain once Attempted, or gone with a Paid event for it; check_status once gone', () => {
        assert.equal(spendVerdict('payout', spend()), 'pending');
        assert.equal(spendVerdict('payout', spend({ status: 'Attempted' })), 'applied');
        // No scan result at all, or one that could not read every block (or was over the bound), is 'unchecked':
        // not "found no payment" (Fable low on #72).
        assert.equal(spendVerdict('payout', null), 'unchecked');
        assert.equal(spendVerdict('payout', null, { paid: false, complete: false }), 'unchecked');
        assert.equal(spendVerdict('payout', null, { paid: false, complete: true }), 'unverified');
        assert.equal(spendVerdict('payout', null, { paid: true, block: 1501, complete: true }), 'applied');
        assert.equal(spendVerdict('checkStatus', spend({ status: 'Attempted' })), 'pending');
        assert.equal(spendVerdict('checkStatus', null), 'applied');
        assert.equal(spendVerdict('checkStatus', null, { paid: false, complete: true }), 'applied', 'check_status clears paid and expired spends alike');
        assert.equal(spendVerdict('checkStatus', null, { paid: false, complete: false }), 'applied');
        assert.equal(spendVerdict('payout', null, { paid: true, block: 1501, complete: false }), 'applied', 'a Paid event is evidence even when other blocks were unreadable');
    });
});

// #72: the payment evidence for a spend that is no longer on chain. On
// Polkadex (PayFromAccount) payout pays synchronously and emits
// treasury.Paid { index, payment_id } in the block it runs in; check_status
// on an expired unpaid spend emits only SpendProcessed { index }, and
// void_spend only AssetSpendVoided { index }. So a Paid event for the index,
// in the blocks since the spend was last seen Pending, is the evidence.
describe('payment evidence: a treasury.Paid event for the spend (#72)', () => {
    test('a Paid event for this index in the scanned blocks is evidence, with its block', async () => {
        const c = fakeChain({ head: 1503, events: { 1501: [['treasury', 'Paid', 7]], 1502: [['treasury', 'SpendProcessed', 7]] } });
        assert.deepEqual(await findPaidEvent(c.api, 7, 1499), { paid: true, block: 1501, complete: true });
        assert.deepEqual([...c.calls.eventBlocks].sort((a, b) => a - b), [1499, 1500, 1501, 1502, 1503], 'from..head, every block read');
    });
    test('an expired spend cleared by check_status (SpendProcessed only) is not evidence of payment', async () => {
        const c = fakeChain({ head: 1503, events: { 1502: [['treasury', 'SpendProcessed', 7]] } });
        assert.deepEqual(await findPaidEvent(c.api, 7, 1499), { paid: false, complete: true });
    });
    test('a voided spend (AssetSpendVoided) is not evidence of payment', async () => {
        const c = fakeChain({ head: 1503, events: { 1500: [['treasury', 'AssetSpendVoided', 7]] } });
        assert.deepEqual(await findPaidEvent(c.api, 7, 1499), { paid: false, complete: true });
    });
    test('a Paid event for another spend, or another pallet\'s Paid, is not evidence for this one', async () => {
        const c = fakeChain({ head: 1503, events: { 1500: [['treasury', 'Paid', 8]], 1501: [['bounties', 'Paid', 7]] } });
        assert.deepEqual(await findPaidEvent(c.api, 7, 1499), { paid: false, complete: true });
    });
    test('a block that cannot be read makes the scan incomplete; a Paid found elsewhere still counts', async () => {
        const gap = fakeChain({ head: 1503, unreadable: [1501] });
        assert.deepEqual(await findPaidEvent(gap.api, 7, 1499), { paid: false, complete: false });
        const found = fakeChain({ head: 1503, unreadable: [1501], events: { 1502: [['treasury', 'Paid', 7]] } });
        assert.deepEqual(await findPaidEvent(found.api, 7, 1499), { paid: true, block: 1502, complete: false });
    });
    test('bounded: more than maxBlocks to scan, or no start block, reads nothing and is incomplete', async () => {
        assert.ok(PAID_SCAN_MAX_BLOCKS >= 20 && PAID_SCAN_MAX_BLOCKS <= 200, 'covers the 90 s watch with margin, and stays bounded');
        const far = fakeChain({ head: 1500 + PAID_SCAN_MAX_BLOCKS, events: { 1600: [['treasury', 'Paid', 7]] } });
        assert.deepEqual(await findPaidEvent(far.api, 7, 1500), { paid: false, complete: false });
        assert.deepEqual(far.calls.eventBlocks, []);
        assert.deepEqual(await findPaidEvent(far.api, 7, 1500, { maxBlocks: PAID_SCAN_MAX_BLOCKS + 1 }), { paid: false, complete: true });
        assert.deepEqual(await findPaidEvent(far.api, 7, null), { paid: false, complete: false });
        assert.deepEqual(await findPaidEvent(far.api, 7, undefined), { paid: false, complete: false });
    });
    test('the head unreadable: incomplete, never a throw', async () => {
        const c = fakeChain();
        c.api.rpc.chain.getHeader = async () => { throw new Error('no link'); };
        assert.deepEqual(await findPaidEvent(c.api, 7, 1499), { paid: false, complete: false });
        assert.deepEqual(await findPaidEvent({}, 7, 1499), { paid: false, complete: false });
    });
});

const fx = loadFixture('metadata-testnet-393.json');
describe('the calls on the real codec (spec 393 metadata fixture)', () => {
    let api;
    before(async () => { api = await ApiPromise.create({ provider: mockProvider({ metadataHex: fx.metadata, specVersion: fx.specVersion }).provider, noInitWarn: true }); });
    after(async () => { await api?.disconnect(); });

    test('treasury.payout(index) and treasury.checkStatus(index), decoded back from their bytes', () => {
        for (const [action, method] of [['payout', 'payout'], ['checkStatus', 'checkStatus']]) {
            const call = api.registry.createType('Call', buildSpendTx(api, action, 42).method.toHex());
            assert.equal(`${call.section}.${call.method}`, `treasury.${method}`);
            assert.equal(call.args[0].toRawType(), 'u32');
            assert.equal(call.args[0].toNumber(), 42);
        }
        assert.throws(() => buildSpendTx(api, 'voidSpend', 1), /Unknown spend action/);
    });
    test('the metadata matches what the page assumes: PayoutPeriod 172,800 blocks, Null asset kind, u32 index, the three payment states', () => {
        assert.equal(api.consts.treasury.payoutPeriod.toNumber(), 172800);
        const t = api.registry.createType('PalletTreasurySpendStatus');
        assert.equal(t.assetKind.toRawType(), 'Null');
        assert.deepEqual(api.registry.createType('PalletTreasuryPaymentState').defKeys, ['Pending', 'Attempted', 'Failed']);
    });
    test('the pot account derived from the metadata palletId is the Polkadex treasury account', () => {
        assert.equal(encodeAddress(treasuryPotAccount(api), 88), 'esoEt6uZ9vs23yW8aqTACLf1tViGpSLZKnhPXt5Nq7vQwHGew');
    });
    test('the module errors decode to the page\'s copy', () => {
        const err = (n) => api.registry.createType('DispatchError', { Module: { index: 16, error: `0x${n.toString(16).padStart(2, '0')}000000` } });
        const cases = { 0: 'treasury.InvalidIndex', 5: 'treasury.SpendExpired', 6: 'treasury.EarlyPayout', 7: 'treasury.AlreadyAttempted', 8: 'treasury.PayoutError', 9: 'treasury.NotAttempted', 10: 'treasury.Inconclusive' };
        for (const [n, key] of Object.entries(cases)) {
            const d = decodeDispatchError(err(Number(n)), api.registry);
            assert.equal(d.key, key);
            assert.equal(d.text, ERROR_COPY[key], key);
        }
    });
});

// The same evidence read through a real ApiPromise on the spec 393 metadata:
// raw System.Events storage per block, decoded with the registry.
describe('payment evidence on the real codec (spec 393 metadata fixture, #72)', () => {
    const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
    // EventRecord: Phase::ApplyExtrinsic(1), RuntimeEvent [pallet 16 = Treasury, variant], data, no topics.
    const record = (variant, index) => u8aConcat(new Uint8Array([0]), u32le(1), new Uint8Array([16, variant]), u32le(index), new Uint8Array([0]));
    const PAID = 9, VOIDED = 8, PROCESSED = 11;
    const blocks = { 15: [record(VOIDED, 7), record(PAID, 8)], 16: [record(PROCESSED, 7)] };
    const hashOf = (n) => '0x' + n.toString(16).padStart(64, '0');
    let api, current = blocks;
    before(async () => {
        const ext = {
            chain_getHeader: () => ({ parentHash: '0x' + '22'.repeat(32), number: '0x10', stateRoot: '0x' + '00'.repeat(32), extrinsicsRoot: '0x' + '00'.repeat(32), digest: { logs: [] } }),
            chain_getBlockHash: ([n]) => hashOf(n == null ? 16 : Number(n)),
            state_getStorage: ([, hash]) => { const n = parseInt(hash, 16); const recs = current[n] || []; return u8aToHex(u8aConcat(compactToU8a(recs.length), ...recs)); }
        };
        api = await ApiPromise.create({ provider: mockProvider({ metadataHex: fx.metadata, specVersion: fx.specVersion, extra: ext }).provider, noInitWarn: true });
    });
    after(async () => { await api?.disconnect(); });

    test('the fixture event indices are treasury.Paid, AssetSpendVoided and SpendProcessed', () => {
        const all = api.registry.createType('Vec<EventRecord>', u8aConcat(compactToU8a(3), record(PAID, 7), record(VOIDED, 7), record(PROCESSED, 7)));
        assert.deepEqual(all.map(r => `${r.event.section}.${r.event.method}(${r.event.data[0].toString()})`),
            ['treasury.Paid(7)', 'treasury.AssetSpendVoided(7)', 'treasury.SpendProcessed(7)']);
    });
    test('voided then cleared, and a Paid for another spend: no evidence for spend 7; Paid(8) is evidence for spend 8', async () => {
        assert.deepEqual(await findPaidEvent(api, 7, 15), { paid: false, complete: true });
        assert.deepEqual(await findPaidEvent(api, 8, 15), { paid: true, block: 15, complete: true });
    });
    test('a Paid(7) in the range is evidence', async () => {
        current = { ...blocks, 16: [record(PAID, 7), record(PROCESSED, 7)] };
        try { assert.deepEqual(await findPaidEvent(api, 7, 15), { paid: true, block: 16, complete: true }); } finally { current = blocks; }
    });
});

describe('error copy', () => {
    test('each payout and check_status error says what happened and what to do', () => {
        assert.match(ERROR_COPY['treasury.EarlyPayout'], /not payable yet/);
        assert.match(ERROR_COPY['treasury.SpendExpired'], /expired/);
        assert.match(ERROR_COPY['treasury.AlreadyAttempted'], /already paid out/);
        assert.match(ERROR_COPY['treasury.PayoutError'], /could not make the transfer/);
        assert.match(ERROR_COPY['treasury.NotAttempted'], /not been paid out/);
        assert.match(ERROR_COPY['treasury.Inconclusive'], /still in progress/);
        assert.match(ERROR_COPY['treasury.InvalidIndex'], /spend/);
    });
});

describe('success is read from the events', () => {
    const ev = (section, method, data = []) => ({ event: { section, method, data } });
    const PAID = ev('treasury', 'Paid', [7, null]);
    const p = { index: 7, amount: '1,500', beneficiary: BEN };
    const card = (key, events) => buildTxModel({ id: 't', key, params: p }, 'finalized', events, null, { blockNumber: 5, txHash: '0xab' });
    test('payout with Paid for this spend: paid', () => {
        const o = evaluateEvents([PAID], null, { actionKey: 'treasury.payout', params: p });
        assert.equal(o.ok, true);
        assert.equal(o.tone, 'ok');
        assert.equal(o.spendResult, 'paid');
        const c = successCopy('treasury.payout', p, o);
        assert.equal(c.title, 'Spend paid');
        assert.match(c.body, /Spend #7: 1,500 PDEX was transferred from the treasury to/);
        assert.match(c.next, /Check status/);
        assert.equal(card('treasury.payout', [PAID]).tone, 'ok');
    });
    test('payout included without a Paid event for this spend: a warning, not success', () => {
        for (const events of [[], [ev('treasury', 'Paid', [8, null])]]) {
            const o = evaluateEvents(events, null, { actionKey: 'treasury.payout', params: p });
            assert.equal(o.ok, true);
            assert.equal(o.tone, 'warn');
            assert.equal(o.spendResult, null);
            assert.match(successCopy('treasury.payout', p, o).title, /not confirmed/);
            assert.equal(card('treasury.payout', events).tone, 'warn');
        }
    });
    test('check_status: SpendProcessed clears it, PaymentFailed is a warning, neither is unconfirmed', () => {
        const done = evaluateEvents([ev('treasury', 'SpendProcessed', [7])], null, { actionKey: 'treasury.checkStatus', params: p });
        assert.equal(done.spendResult, 'processed');
        assert.equal(done.tone, 'ok');
        assert.equal(successCopy('treasury.checkStatus', p, done).title, 'Spend cleared');
        assert.match(successCopy('treasury.checkStatus', p, done).body, /refunded/);
        const failed = evaluateEvents([ev('treasury', 'PaymentFailed', [7, null])], null, { actionKey: 'treasury.checkStatus', params: p });
        assert.equal(failed.spendResult, 'failed');
        assert.equal(failed.tone, 'warn');
        assert.equal(successCopy('treasury.checkStatus', p, failed).title, 'Payment failed');
        const none = evaluateEvents([], null, { actionKey: 'treasury.checkStatus', params: p });
        assert.equal(none.tone, 'warn');
        assert.match(successCopy('treasury.checkStatus', p, none).title, /not confirmed/);
    });
    test('an ExtrinsicFailed still fails, with the decoded error', () => {
        const registry = { findMetaError: () => ({ section: 'treasury', name: 'EarlyPayout', docs: [] }) };
        const o = evaluateEvents([PAID, ev('system', 'ExtrinsicFailed', [{ isModule: true, asModule: {} }])], registry, { actionKey: 'treasury.payout', params: p });
        assert.equal(o.ok, false);
        assert.equal(o.text, ERROR_COPY['treasury.EarlyPayout']);
    });
    test('other actions are unaffected by treasury events', () => {
        assert.equal(evaluateEvents([PAID], null, { actionKey: 'balances.transfer' }).tone, 'ok');
    });
    test('pending titles', () => {
        assert.equal(PENDING_TITLE['treasury.payout'], 'Paying out a treasury spend');
        assert.equal(PENDING_TITLE['treasury.checkStatus'], 'Checking a treasury spend');
    });
});

describe(`GET ${'/api/treasury/spends'}`, () => {
    let server, base, chain, ready = true;
    const SHORT = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
    before(async () => {
        chain = fakeChain({ head: 1499, spends: [spend({ index: 3 }), spend({ index: 4, status: 'Attempted' })] });
        const app = express();
        registerTreasurySpendsRoute(app, {
            api: () => chain.api,
            ready: (res) => { if (ready) return true; res.set('Cache-Control', 'no-store'); res.status(503).json({ code: 'RPC_NOT_READY' }); return false; },
            cacheShort: (res) => res.set('Cache-Control', SHORT),
            isFresh: (q) => q.fresh === '1',
            normalize: (a) => 'n:' + a,
            serverError: (res) => { res.set('Cache-Control', 'no-store'); res.status(500).json({ error: 'Internal error.' }); }
        });
        await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => { if (server) server.close(); });
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }; };

    test('the route path constant', () => assert.equal(SPENDS_ROUTE, '/api/treasury/spends'));
    test('200: the spends, newest first, classified, short cache tier', async () => {
        const r = await get('/api/treasury/spends');
        assert.equal(r.status, 200);
        assert.equal(r.cache, SHORT);
        assert.equal(r.body.block, 1499);
        assert.equal(r.body.nextBlock, 1500);
        assert.equal(r.body.spendCount, 9);
        assert.equal(r.body.truncated, false);
        assert.deepEqual(r.body.pot, { free: '1000000000000000000', available: '999999000000000000' }, 'the treasury pot, planck strings');
        assert.deepEqual(r.body.spends.map(s => [s.index, s.status, s.phase, s.action]), [[4, 'Attempted', 'paid', 'checkStatus'], [3, 'Pending', 'payable', 'payout']]);
        assert.equal(r.body.spends[0].beneficiary, 'n:' + BEN, 'beneficiaries are normalised to the Polkadex prefix');
        assert.equal(r.body.spends[0].amount, '1500000000000000', 'planck strings, never floats');
    });
    test('?fresh=1 is no-store', async () => {
        assert.equal((await get('/api/treasury/spends?fresh=1')).cache, 'no-store');
    });
    test('503 when the node is not connected', async () => {
        ready = false;
        try { const r = await get('/api/treasury/spends'); assert.equal(r.status, 503); assert.equal(r.cache, 'no-store'); }
        finally { ready = true; }
    });
    test('500 no-store when a chain read fails', async () => {
        const saved = chain.api.query.treasury.spendCount;
        chain.api.query.treasury.spendCount = async () => { throw new Error('rpc gone'); };
        try { const r = await get('/api/treasury/spends'); assert.equal(r.status, 500); assert.equal(r.cache, 'no-store'); }
        finally { chain.api.query.treasury.spendCount = saved; }
    });
});

describe('the Spends table cells', () => {
    const deps = (over = {}) => ({ connected: true, held: new Set(), data: { block: 1499, nextBlock: 1500, blockTimeMs: 12000, decimals: 12, pot: { free: '9000000000000000', available: '8000000000000000' } }, fetchedAt: 1_000_000, formatTime: (ms) => `T${ms}`, ...over });
    const cells = (row, over) => Object.fromEntries(spendColumns(deps(over)).map(c => [c.key, c.format(row)]));
    test('index, amount, linked beneficiary, blocks with estimated dates, status, action', () => {
        const c = cells({ ...spend(), phase: 'payable', action: 'payout' });
        assert.match(c.index, /#7/);
        assert.match(c.amount, /1,500 PDEX/);
        assert.match(c.beneficiary, new RegExp(`href="/account/${BEN}"`));
        assert.match(c.validFrom, /href="\/block\/1000"/);
        assert.match(c.validFrom, /~T/);
        assert.doesNotMatch(c.expireAt, /href=/, 'a future block is not linked');
        assert.match(c.expireAt, /2,000/);
        assert.match(c.action, /<button[^>]*data-spend-action="payout"[^>]*data-spend-index="7"[^>]*>Pay out<\/button>/);
        assert.doesNotMatch(c.action, /disabled/);
    });
    test('text instead of a button when nothing can be submitted', () => {
        assert.match(cells({ ...spend({ validFrom: 3000, expireAt: 4000 }) }).action, /Payable from block 3,000 \(~T/);
        assert.match(cells({ ...spend({ validFrom: 100, expireAt: 1500 }) }).action, /Expired: can no longer be paid/);
        assert.doesNotMatch(cells({ ...spend({ validFrom: 100, expireAt: 1500 }) }).action, /<button/);
        assert.match(cells({ ...spend({ status: 'Attempted' }) }).status, /Paid/);
        assert.match(cells({ ...spend({ status: 'Attempted' }) }).action, />Check status</);
    });
    test('a spend the pot cannot cover, or one in its last block, shows why instead of a button', () => {
        const poor = cells(spend(), { data: { ...deps().data, pot: { free: '1000000000000000', available: '999000000000000' } } });
        assert.match(poor.action, /The treasury holds 999 PDEX, less than this spend; it cannot be paid until the pot is refilled/);
        assert.doesNotMatch(poor.action, /<button/);
        const last = cells(spend({ expireAt: 1501 }));
        assert.match(last.action, /Expires next block; paying now may fail/);
        assert.doesNotMatch(last.action, /<button/);
        assert.match(cells(spend(), { data: { ...deps().data, pot: null } }).action, /<button[^>]*>Pay out</, 'no pot in the response: the button stays');
    });
    test('buttons are disabled without a wallet and while a submission for that spend is held', () => {
        assert.match(cells(spend(), { connected: false }).action, /disabled/);
        assert.match(cells(spend(), { held: new Set([7]) }).action, /disabled/);
        assert.doesNotMatch(cells(spend({ index: 8 }), { held: new Set([7]) }).action, /disabled/);
    });
    test('everything from the API is escaped', () => {
        const evil = '<img src=x onerror=alert(1)>"';
        const c = cells(spend({ beneficiary: evil, amount: '<b>1</b>', index: '7"><script>' }));
        for (const v of Object.values(c)) {
            assert.doesNotMatch(v, /<img|<script|<b>1/, v);
        }
        assert.match(c.beneficiary, /href="\/account\/%3Cimg/);
    });
});

// The Spends tab, driven through its delegated click handler with fakes for
// the fetch, the table and submitSignedTx.
function spendsWorld({ connected = ME, rows = [spend()], head = 1499 } = {}) {
    const chain = fakeChain({ head, spends: rows.map(r => ({ ...r })) });
    const el = { innerHTML: '', handlers: {}, addEventListener(t, fn) { this.handlers[t] = fn; }, querySelector() { return table; } };
    const table = { innerHTML: '' };
    const w = { chain, el, table, selected: connected, fetches: [], submitted: [], api: chain.api, multisig: false, tables: [] };
    w.respond = async (url) => { w.fetches.push(url); return readSpends(chain.api).then(r => JSON.parse(JSON.stringify(r))); };
    w.submitWith = async (opts) => { w.submitted.push(opts); w.lastTx = await opts.buildTx(chain.api); };
    w.ui = createSpendPayoutUI({
        api: () => w.api, selected: () => w.selected, isMultisig: () => w.multisig,
        submit: (o) => w.submitWith(o), fetchJson: (u) => w.respond(u),
        makeTable: (config) => {
            const { container, rows: rs, columns } = config;
            container.innerHTML = rs.map(r => columns.map(c => c.format(r)).join(' | ')).join('\n');
            const t = { config, state: config.state ? { ...config.state } : { sortKey: 'index', sortDir: 'desc', colFilters: {}, globalSearch: '' } };   // like makeTable: starts from config.state
            w.tables.push(t);
            return { getState: () => ({ ...t.state, colFilters: { ...t.state.colFilters } }), setData() {}, refresh() {} };
        },
        formatTime: (ms) => `T${ms}`, helpIcon: () => '<i>?</i>'
    });
    const button = (index, action) => ({ disabled: false, getAttribute: (k) => ({ 'data-spend-index': String(index), 'data-spend-action': action })[k] });
    w.click = async (index, action = 'payout') => {
        const btn = button(index, action);
        await w.el.handlers.click({ target: { closest: () => btn } });
        await tick();
        return btn;
    };
    return w;
}

describe('the Spends tab', () => {
    test('mount reads /api/treasury/spends and renders the table and the fee note', async () => {
        const w = spendsWorld();
        await w.ui.mount(w.el);
        assert.deepEqual(w.fetches, ['/api/treasury/spends']);
        assert.match(w.el.innerHTML, /Anyone can submit/i);
        assert.match(w.el.innerHTML, /not refunded/);
        assert.match(w.table.innerHTML, /data-spend-action="payout"/);
    });
    test('Pay out signs treasury.payout(index) through submit, after re-reading the spend at signing', async () => {
        const w = spendsWorld();
        await w.ui.mount(w.el);
        await w.click(7);
        assert.equal(w.submitted.length, 1);
        const s = w.submitted[0];
        assert.equal(s.expectedWallet, ME);
        assert.equal(s.action.key, 'treasury.payout');
        assert.deepEqual(s.action.params, { index: 7, amount: '1,500', beneficiary: BEN });
        assert.equal(w.lastTx.method.toHex(), 'payout(7)');
        assert.equal(typeof s.verify, 'function');
        assert.equal(await s.verify(w.chain.api), 'pending');
    });
    test('no double submit: a second click while the first is held does nothing', async () => {
        const w = spendsWorld();
        await w.ui.mount(w.el);
        w.submitWith = async (opts) => { w.submitted.push(opts); };   // stays in flight
        await w.click(7);
        await w.click(7);
        assert.equal(w.submitted.length, 1);
        assert.match(w.table.innerHTML, /data-spend-index="7"[^>]*disabled/);
    });
    test('held until the list is read again after success; then the new state shows', async () => {
        const w = spendsWorld();
        await w.ui.mount(w.el);
        let release;
        w.respond = async (url) => { w.fetches.push(url); await new Promise(r => { release = r; }); return JSON.parse(JSON.stringify(await readSpends(w.chain.api))); };
        await w.click(7);
        w.chain.byIndex.set(7, spend({ status: 'Attempted' }));
        w.submitted[0].onSuccess();
        await tick();
        assert.deepEqual(w.fetches.slice(-1), ['/api/treasury/spends?fresh=1']);
        assert.match(w.table.innerHTML, /data-spend-index="7"[^>]*disabled/, 'held while the refresh runs');
        await w.click(7);
        assert.equal(w.submitted.length, 1, 'a click while the refresh runs submits nothing');
        release(); await tick(); await tick();
        assert.match(w.table.innerHTML, /data-spend-action="checkStatus"[^>]*data-spend-index="7"(?![^>]*disabled)/);
    });
    test('settle re-renders at once, before the fresh read: the button submit restored is disabled again in the same tick', async () => {
        const w = spendsWorld();
        await w.ui.mount(w.el);
        w.respond = async (url) => { w.fetches.push(url); await new Promise(() => {}); };   // the fresh read never answers
        await w.click(7);
        for (const fire of [(s) => s.onStage('waiting'), (s) => s.onStage('processed'), (s) => s.onSuccess()]) {
            w.table.innerHTML = '<button data-spend-action="payout" data-spend-index="7">Pay out</button>';   // submit's restore()
            fire(w.submitted[0]);
            assert.match(w.table.innerHTML, /data-spend-index="7"[^>]*disabled/, 'held, synchronously');
        }
    });
    test('sort, search and filters survive every re-render (hold, settle, wallet change)', async () => {
        const w = spendsWorld({ rows: [spend(), spend({ index: 8 })] });
        await w.ui.mount(w.el);
        const first = w.tables[w.tables.length - 1];
        first.state = { sortKey: 'amount', sortDir: 'asc', colFilters: { beneficiary: 'es' }, globalSearch: '#8' };
        w.submitWith = async (opts) => { w.submitted.push(opts); };
        await w.click(7);
        const held = w.tables[w.tables.length - 1];
        assert.notEqual(held, first, 'the hold re-rendered');
        assert.deepEqual(held.config.state, { sortKey: 'amount', sortDir: 'asc', colFilters: { beneficiary: 'es' }, globalSearch: '#8' });
        held.state = { sortKey: 'expireAt', sortDir: 'desc', colFilters: {}, globalSearch: 'x' };
        w.submitted[0].onSuccess();
        await tick(); await tick();
        const settled = w.tables[w.tables.length - 1];
        assert.deepEqual(settled.config.state, { sortKey: 'expireAt', sortDir: 'desc', colFilters: {}, globalSearch: 'x' });
        w.ui.accountChanged();
        assert.deepEqual(w.tables[w.tables.length - 1].config.state, { sortKey: 'expireAt', sortDir: 'desc', colFilters: {}, globalSearch: 'x' });
    });
    test('the first render has no carried state', async () => {
        const w = spendsWorld();
        await w.ui.mount(w.el);
        assert.equal(w.tables[0].config.state, undefined);
    });
    test('a spend the pot no longer covers at signing is refused before the wallet is asked', async () => {
        const w = spendsWorld();
        await w.ui.mount(w.el);
        w.chain.pot = { free: '1000000000000000' };
        let thrown = null;
        w.submitWith = async (opts) => { w.submitted.push(opts); try { await opts.buildTx(w.chain.api); } catch (e) { thrown = e; opts.onError(e.message); } };
        await w.click(7);
        assert.match(String(thrown && thrown.message), /Spend #7 cannot be paid out now: The treasury holds 999 PDEX, less than this spend/);
    });
    test('a spend in its last block at signing is refused before the wallet is asked', async () => {
        const w = spendsWorld();
        await w.ui.mount(w.el);
        w.chain.head = 1998;   // signed now, it runs in 1999, the last block before expire_at 2000
        let thrown = null;
        w.submitWith = async (opts) => { w.submitted.push(opts); try { await opts.buildTx(w.chain.api); } catch (e) { thrown = e; opts.onError(e.message); } };
        await w.click(7);
        assert.match(String(thrown && thrown.message), /Spend #7 cannot be paid out now: Expires next block; paying now may fail/);
    });
    test('an unfunded spend has no button and a click submits nothing', async () => {
        const w = spendsWorld({ rows: [spend()] });
        w.chain.pot = { free: '1000000000000' };
        await w.ui.mount(w.el);
        assert.match(w.table.innerHTML, /less than this spend/);
        await w.click(7);
        assert.equal(w.submitted.length, 0);
    });
    test('an error releases the button for a retry', async () => {
        const w = spendsWorld();
        await w.ui.mount(w.el);
        w.submitWith = async (opts) => { w.submitted.push(opts); opts.onError('Cancelled'); };
        await w.click(7);
        await w.click(7);
        assert.equal(w.submitted.length, 2);
    });
    test('a spend that changed since the list was read is refused before the wallet is asked', async () => {
        const w = spendsWorld();
        await w.ui.mount(w.el);
        w.chain.head = 5000;   // now expired
        let thrown = null;
        w.submitWith = async (opts) => { w.submitted.push(opts); try { await opts.buildTx(w.chain.api); } catch (e) { thrown = e; opts.onError(e.message); } };
        await w.click(7);
        assert.match(String(thrown && thrown.message), /Spend #7 cannot be paid out now: Expired: can no longer be paid/);
        w.chain.byIndex.delete(7);
        await w.click(7);
        assert.match(String(thrown && thrown.message), /Spend #7 is no longer on chain/);
    });
    test('a wallet switch between click and signing stops the signature', async () => {
        const w = spendsWorld();
        await w.ui.mount(w.el);
        let thrown = null;
        w.submitWith = async (opts) => { w.submitted.push(opts); w.selected = OTHER; try { await opts.buildTx(w.chain.api); } catch (e) { thrown = e; } };
        await w.click(7);
        assert.match(String(thrown && thrown.message), /wallet changed/);
    });
    test('without a wallet the buttons are disabled and a click submits nothing', async () => {
        const w = spendsWorld({ connected: null });
        await w.ui.mount(w.el);
        assert.match(w.table.innerHTML, /disabled/);
        assert.match(w.el.innerHTML, /Connect a wallet/);
        await w.click(7);
        assert.equal(w.submitted.length, 0);
    });
    test('Check status signs treasury.checkStatus(index)', async () => {
        const w = spendsWorld({ rows: [spend({ status: 'Attempted' })] });
        await w.ui.mount(w.el);
        await w.click(7, 'checkStatus');
        assert.equal(w.submitted[0].action.key, 'treasury.checkStatus');
        assert.equal(w.lastTx.method.toHex(), 'check(7)');
    });
    test('a failed read says so, with nothing to click', async () => {
        const w = spendsWorld();
        w.respond = async () => { throw new Error('Request failed (503)'); };
        await w.ui.mount(w.el);
        assert.match(w.el.innerHTML, /Could not load the spends: Request failed \(503\)/);
    });
    test('no spends: an empty message', async () => {
        const w = spendsWorld({ rows: [] });
        await w.ui.mount(w.el);
        assert.match(w.el.innerHTML, /No approved spends are waiting/);
    });
});

// #72, through the real tracker (lib/tx-submit.js) and status model
// (lib/tx-status.js): a payout is Sent, the status updates stop, and the
// watchdog finds the spend gone. Only payment evidence (Attempted, or a Paid
// event for the spend since it was signed) may end it "paid" with onSuccess;
// an expired or voided spend that is gone ends neutral and unverified, with a
// link to look the transaction up.
const TX_HASH = '0x' + 'ab'.repeat(32);
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
function trackedWorld(opts) {
    const w = spendsWorld(opts);
    const api = w.chain.api;
    Object.assign(api, { on() {}, off() {} });
    Object.assign(w, { shown: [], successes: 0, errors: [], stages: [] });
    w.last = () => w.shown[w.shown.length - 1];
    w.submitWith = async (o) => {
        w.submitted.push(o);
        const button = { disabled: false, innerHTML: o.idleText, setAttribute() {}, removeAttribute() {} };
        const run = trackSignedTx({
            api, button, idleText: o.idleText, verify: o.verify,
            action: { ...o.action, label: o.label, id: 'tx-72' },
            onError: (t, m) => { w.errors.push(t); if (o.onError) o.onError(t, m); },
            onSuccess: () => { w.successes++; if (o.onSuccess) o.onSuccess(); },
            onStage: (st, m) => { w.stages.push(st); if (o.onStage) o.onStage(st, m); },
            show: (a, st, ev, err, ex) => { const m = buildTxModel(a, st, ev, err, ex); w.shown.push(m); return m; }
        });
        run.start();
        const tx = await o.buildTx(api);
        tx.signAndSend = (addr, so, cb) => { w.emit = (status) => cb({ status, events: [], txHash: { toHex: () => TX_HASH } }); return Promise.resolve(() => {}); };
        await run.send(tx, ME, {});
    };
    // Sent, then the subscription goes silent; `change` is what the chain does
    // meanwhile; then one watchdog check.
    w.silentThen = async (change) => {
        w.emit({ type: 'Ready' });
        await flush();
        change(w.chain);
        mock.timers.tick(WATCHDOG_MS);
        await flush();
    };
    return w;
}

describe('the payout watchdog needs payment evidence (#72)', () => {
    before(() => mock.timers.enable({ apis: ['setTimeout'] }));
    after(() => mock.timers.reset());

    const gone = (c, head, events) => { c.byIndex.delete(7); c.head = head; Object.assign(c.events, events); };
    // incomplete: the scan could not read every block, so the card must not say
    // "found no payment" (it did not look everywhere).
    const unverified = (w, { incomplete = false } = {}) => {
        const m = w.last();
        assert.equal(m.stage, 'unverified', `ended ${m.stage}: ${m.title}`);
        assert.equal(m.tone, 'neutral');
        assert.doesNotMatch(m.title, /is paid/i);
        assert.match(m.body, /no longer on chain/i);
        if (incomplete) {
            assert.equal(m.stageText, 'Payment could not be checked');
            assert.match(m.title, /Spend #7 cleared; payment could not be checked/);
            assert.match(m.body, /could not (read|check)/i);
            assert.doesNotMatch(m.title + m.body + m.stageText, /found no payment|no payment|unverified/i);
        } else {
            assert.equal(m.stageText, 'Payment unverified');
            assert.match(m.title, /Spend #7 cleared; payment unverified/);
            assert.match(m.body, /found no payment/i);
        }
        assert.ok(m.links.some(l => l.href === `/tx/1499/${TX_HASH}` && /transaction/i.test(l.label)), 'a way to inspect the transaction');
        assert.equal(w.successes, 0, 'payout onSuccess ran without payment evidence');
        assert.deepEqual(w.errors, []);
        assert.ok(!w.shown.some(x => /is paid/i.test(x.title)), 'a paid title was shown');
    };

    test('the watchdog verify reads the spend, then the Paid events since the block it was signed at', async () => {
        const w = spendsWorld({ head: 1499 });
        await w.ui.mount(w.el);
        await w.click(7);
        const verify = w.submitted[0].verify;
        assert.equal(await verify(w.chain.api), 'pending', 'still Pending: no event read needed');
        assert.deepEqual(w.chain.calls.eventBlocks, []);
        w.chain.byIndex.set(7, spend({ status: 'Attempted' }));
        assert.equal(await verify(w.chain.api), 'applied', 'Attempted is paid (PayFromAccount pays inside payout)');
        gone(w.chain, 1503, {});
        assert.equal(await verify(w.chain.api), 'unverified');
        assert.equal(Math.min(...w.chain.calls.eventBlocks), 1498, 'scanned from the head at signing, less one block of margin');
        assert.equal(Math.max(...w.chain.calls.eventBlocks), 1503);
        w.chain.events[1501] = [['treasury', 'Paid', 7]];
        assert.equal(await verify(w.chain.api), 'applied');
    });

    test('an expired unpaid spend cleared by check_status is not reported paid', async () => {
        const w = trackedWorld({ head: 1499 });
        await w.ui.mount(w.el);
        await w.click(7);
        await w.silentThen((c) => gone(c, 1503, { 1502: [['treasury', 'SpendProcessed', 7]] }));
        unverified(w);
    });

    test('a voided spend is not reported paid', async () => {
        const w = trackedWorld({ head: 1499 });
        await w.ui.mount(w.el);
        await w.click(7);
        await w.silentThen((c) => gone(c, 1503, { 1500: [['treasury', 'AssetSpendVoided', 7]] }));
        unverified(w);
    });

    test('unreadable event blocks are no evidence either, and the card says the payment could not be checked', async () => {
        const w = trackedWorld({ head: 1499 });
        await w.ui.mount(w.el);
        await w.click(7);
        await w.silentThen((c) => { gone(c, 1503, {}); c.unreadable.push(1500, 1501, 1502); });
        unverified(w, { incomplete: true });
    });

    test('a range over the 60 block bound is not read, so the card says the payment could not be checked', async () => {
        const w = trackedWorld({ head: 1499 });
        await w.ui.mount(w.el);
        await w.click(7);
        await w.silentThen((c) => gone(c, 1499 + 200, {}));
        assert.deepEqual(w.chain.calls.eventBlocks, [], 'nothing should be read over the bound');
        unverified(w, { incomplete: true });
    });

    test('a complete scan with no payment keeps "found no payment" and both cards keep the transaction lookup link', async () => {
        const w = trackedWorld({ head: 1499 });
        await w.ui.mount(w.el);
        await w.click(7);
        await w.silentThen((c) => gone(c, 1503, { 1502: [['treasury', 'SpendProcessed', 7]] }));
        unverified(w);
        assert.ok(w.last().links.some(l => l.href === `/tx/1499/${TX_HASH}`));
    });

    test('the incomplete card still never reports paid and still releases the spend button', async () => {
        const w = trackedWorld({ head: 1499 });
        await w.ui.mount(w.el);
        await w.click(7);
        await w.silentThen((c) => gone(c, 1499 + 200, {}));
        assert.equal(w.stages[w.stages.length - 1], 'unverified');
        assert.equal(w.successes, 0);
        assert.deepEqual(w.fetches.slice(-1), ['/api/treasury/spends?fresh=1']);
    });

    test('unverified ends the watch: the spend button is released after the list is read again, and nothing fires later', async () => {
        const w = trackedWorld({ head: 1499 });
        await w.ui.mount(w.el);
        await w.click(7);
        await w.silentThen((c) => gone(c, 1503, {}));
        assert.equal(w.stages[w.stages.length - 1], 'unverified');
        assert.deepEqual(w.fetches.slice(-1), ['/api/treasury/spends?fresh=1'], 'the list was not read again');
        const n = w.shown.length;
        mock.timers.tick(WATCHDOG_MS * 6);
        await flush();
        assert.equal(w.shown.length, n, 'the watchdog kept running after the end');
    });

    test('a Paid event for the spend still confirms it: "Spend #7 is paid" and onSuccess once', async () => {
        const w = trackedWorld({ head: 1499 });
        await w.ui.mount(w.el);
        await w.click(7);
        await w.silentThen((c) => gone(c, 1503, { 1500: [['treasury', 'Paid', 7]], 1502: [['treasury', 'SpendProcessed', 7]] }));
        assert.equal(w.last().stage, 'confirmed');
        assert.equal(w.last().title, 'Spend #7 is paid');
        assert.equal(w.successes, 1);
        assert.deepEqual(w.errors, []);
    });

    test('an Attempted spend still confirms it', async () => {
        const w = trackedWorld({ head: 1499 });
        await w.ui.mount(w.el);
        await w.click(7);
        await w.silentThen((c) => { c.byIndex.set(7, spend({ status: 'Attempted' })); c.head = 1501; });
        assert.equal(w.last().stage, 'confirmed');
        assert.equal(w.last().title, 'Spend #7 is paid');
        assert.equal(w.successes, 1);
    });

    test('Check status keeps its own meaning: the spend gone is cleared (paid or expired), confirmed, onSuccess', async () => {
        const w = trackedWorld({ head: 1499, rows: [spend({ status: 'Attempted' })] });
        await w.ui.mount(w.el);
        await w.click(7, 'checkStatus');
        await w.silentThen((c) => gone(c, 1503, {}));
        assert.equal(w.last().stage, 'confirmed');
        assert.equal(w.last().title, 'Spend #7 is cleared');
        assert.equal(w.successes, 1);
        assert.deepEqual(w.chain.calls.eventBlocks, [], 'check_status needs no payment evidence');
    });
});

describe('help', () => {
    test('the treasury article explains paying out and checking a spend, and who pays the fee', () => {
        const t = HELP_TOPICS.find(x => x.slug === 'treasury').body;
        assert.match(t, /<b>Spends<\/b>/);
        assert.match(t, /<b>Pay out<\/b>/);
        assert.match(t, /<b>Check status<\/b>/);
        assert.match(t, /treasury\.payout/);
        assert.match(t, /not refunded/);
        assert.match(t, /refunded/);
        assert.match(t, /expires/);
        assert.doesNotMatch(t, /The explorer has no button for that yet/);
    });
    test('the transaction status article explains "Payment unverified" without calling it paid (#72)', () => {
        const t = HELP_TOPICS.find(x => x.slug === 'transaction-status').body;
        const item = (t.match(/<li><b>Payment unverified<\/b>[\s\S]*?<\/li>/) || [''])[0];
        assert.ok(item, 'no Payment unverified entry');
        assert.match(item, /no payment/i);
        assert.match(item, /expired|voided/i);
        assert.match(item, /Look up the transaction/);
    });
});

describe('wiring', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));
    const server = stripComments(readRepo('server.js', import.meta.url));
    test('script.js mounts the Spends tab and signs through submitSignedTx', () => {
        assert.match(script, /import \{ createSpendPayoutUI \} from '\.\/lib\/treasury-payout-view\.js'/);
        assert.match(script, /createSpendPayoutUI\(\{[^}]*submit: submitSignedTx/);
        assert.match(script, /createSpendPayoutUI\(\{[^}]*makeTable/);
        const fn = bodyOf(script, 'renderTreasury');
        assert.match(fn, /tabBtn\('spends'/);
        assert.match(fn, /spendPayoutUI\.mount\(/);
        assert.match(bodyOf(script, 'onWalletChanged'), /spendPayoutUI\.accountChanged\(\)/);
    });
    test('makeTable starts from config.state (a previous getState()) so a rebuilt table keeps sort, search and filters', () => {
        const fn = bodyOf(script, 'makeTable');
        assert.match(fn, /config\.state/);
        assert.match(fn, /sortKey = [^;]*config\.state\.sortKey/);
        assert.match(fn, /sortDir = [^;]*config\.state\.sortDir/);
        assert.match(fn, /globalSearch = [^;]*config\.state\.globalSearch/);
        assert.match(fn, /Object\.assign\(colFilters, [^)]*config\.state\.colFilters/);
        assert.match(fn, /getState\(\)\s*\{ return \{ sortKey, sortDir, colFilters: \{ \.\.\.colFilters \}, globalSearch \}; \}/);
    });
    test('server.js registers the route with requireRpc, cacheShort, isFreshRequest and serverError', () => {
        assert.match(server, /registerTreasurySpendsRoute\(app, \{[^}]*requireRpc[^}]*cacheShort[^}]*isFreshRequest[^}]*serverError[^}]*\}\)/s);
    });
    test('the API reference, README and llms.txt document it in the short tier', () => {
        assert.ok(allRoutes().some(r => r.method === 'GET' && r.path === '/api/treasury/spends'));
        assert.ok(CACHE_TIERS.find(t => t.name === 'Short').routes.includes('/api/treasury/spends'));
        assert.match(readRepo('README.md', import.meta.url), /\/api\/treasury\/spends/);
        assert.match(readRepo('public/llms.txt', import.meta.url), /\/api\/treasury\/spends/);
    });
});
