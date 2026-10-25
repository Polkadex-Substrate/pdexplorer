// Which accounts an event names (lib/account-links.js), and the rules that keep fees and staking payouts out.
// Event shapes (sections, methods, fields, phases) follow mainnet events: a treasury payout, a vote and an
// approval through a multisig, a staking payout and legacy array data. Blocks, amounts and accounts are synthetic.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import * as db from '../db.js';
import { addressStrings, attachAccounts } from '../lib/account-links.js';
import { readRepo, stripComments, bodyOf, assertOrder } from './helpers/source.js';

const addr = n => encodeAddress(new Uint8Array(32).fill(n), 88);
const [TREASURY, MULTISIG, OWNER_A, OWNER_B, OTHER, BOT] = [1, 2, 3, 4, 5, 6].map(addr);
const RULES = { normalize: a => encodeAddress(decodeAddress(a), 88), treasury: TREASURY };
const HASH = '0x' + 'ab'.repeat(32);

let seq = 0;
const blockHash = block => '0x' + String(block).padStart(64, '0');
// One event as scanSingleBlock builds it; extrinsicIndex null is the Initialization phase.
const ev = (block, extrinsicIndex, signerAddress, kind, data) => {
    const [section, method] = kind.split('.'), eventIndex = seq++;
    return { hash: `${blockHash(block)}-${eventIndex}`, blockHash: blockHash(block), block, eventIndex, extrinsicIndex, signerAddress, section, method, data };
};
// The accounts each event is linked to, as "section.method: accounts".
const linked = events => attachAccounts(events, RULES).map(e => `${e.section}.${e.method}: ${e.accounts.join(',')}`);

// A signed extrinsic's fee plumbing around its call events, as Polkadex emits it.
const signedExtrinsic = (block, signer, callEvents) => [
    ev(block, 1, signer, 'balances.Withdraw', { who: signer, amount: '10,000,000,000' }),
    ...callEvents.map(([kind, data]) => ev(block, 1, signer, kind, data)),
    ev(block, 1, signer, 'balances.Deposit', { who: TREASURY, amount: '10,000,000,000' }),
    ev(block, 1, signer, 'treasury.Deposit', { value: '10,000,000,000' }),
    ev(block, 1, signer, 'transactionPayment.TransactionFeePaid', { who: signer, actualFee: '10,000,000,000', tip: '0' }),
    ev(block, 1, signer, 'system.ExtrinsicSuccess', { dispatchInfo: { weight: { refTime: '100,000,000', proofSize: '1,000' }, class: 'Normal', paysFee: 'Yes' } })
];

describe('addressStrings finds every account in decoded event data', () => {
    test('named fields, legacy arrays and nested tuples', () => {
        assert.deepEqual(addressStrings({ approving: OWNER_A, timepoint: { height: '100', index: '1' }, multisig: MULTISIG }), [OWNER_A, MULTISIG]);
        assert.deepEqual(addressStrings([OWNER_A, OTHER, '5,000,000,000,000']), [OWNER_A, OTHER]);
        assert.deepEqual(addressStrings({ newMembers: [[OWNER_A, '1,000,000,000,000,000'], [OWNER_B, '2,000,000,000,000,000']] }), [OWNER_A, OWNER_B]);
    });

    test('hashes, amounts, enum names and junk are not accounts', () => {
        assert.deepEqual(addressStrings({ callHash: HASH, authorityId: '0x' + 'be'.repeat(32), amount: '1,000', class: 'Normal', note: 'x'.repeat(48) }), ['x'.repeat(48)]);
        assert.deepEqual(addressStrings(null), []);
        // Shape alone is not enough: normalize() rejects what fails the SS58 checksum.
        assert.deepEqual(attachAccounts([ev(9, null, 'System', 'system.Remarked', { note: 'x'.repeat(48) })], RULES)[0].accounts, []);
    });
});

describe('attachAccounts: the signer, fee plumbing and staking payouts are left out', () => {
    test('a multisig approval links the multisig, not the owner who signed it, and none of the fee events', () => {
        assert.deepEqual(linked(signedExtrinsic(100, OWNER_A, [
            ['balances.Reserved', { who: OWNER_A, amount: '5,000,000,000,000' }],
            ['multisig.NewMultisig', { approving: OWNER_A, multisig: MULTISIG, callHash: HASH }]
        ])), [
            'balances.Withdraw: ', 'balances.Reserved: ', `multisig.NewMultisig: ${MULTISIG}`,
            'balances.Deposit: ', 'treasury.Deposit: ', 'transactionPayment.TransactionFeePaid: ', 'system.ExtrinsicSuccess: '
        ]);
    });

    test('a vote through the multisig links the lock and the reserve to the multisig, the deposit refund to its first approver', () => {
        assert.deepEqual(linked(signedExtrinsic(105, OWNER_B, [
            ['balances.Unreserved', { who: OWNER_A, amount: '5,000,000,000,000' }],
            ['balances.Reserved', { who: MULTISIG, amount: '3,000,000,000,000' }],
            ['balances.Locked', { who: MULTISIG, amount: '1,000,000,000,000,000' }],
            ['multisig.MultisigExecuted', { approving: OWNER_B, timepoint: { height: '100', index: '1' }, multisig: MULTISIG, callHash: HASH, result: { Ok: null } }]
        ])).slice(1, 5), [
            `balances.Unreserved: ${OWNER_A}`, `balances.Reserved: ${MULTISIG}`, `balances.Locked: ${MULTISIG}`, `multisig.MultisigExecuted: ${MULTISIG}`
        ]);
    });

    test('a treasury payout (Initialization phase, no signer) links the beneficiary, the treasury and the returned bond', () => {
        assert.deepEqual(linked([
            ev(250, null, 'System', 'elections.NewTerm', { newMembers: [[OWNER_A, '1,000'], [OWNER_B, '2,000']] }),
            ev(250, null, 'System', 'treasury.Spending', { budgetRemaining: '5,000,000,000,000,000' }),
            ev(250, null, 'System', 'balances.Unreserved', { who: OTHER, amount: '50,000,000,000,000' }),
            ev(250, null, 'System', 'balances.Deposit', { who: MULTISIG, amount: '1,000,000,000,000,000' }),
            ev(250, null, 'System', 'treasury.Awarded', { proposalIndex: '12', award: '1,000,000,000,000,000', account: MULTISIG }),
            ev(250, null, 'System', 'balances.Withdraw', { who: TREASURY, amount: '1,000,000,000,000,000' })
        ]), [
            `elections.NewTerm: ${OWNER_A},${OWNER_B}`, 'treasury.Spending: ', `balances.Unreserved: ${OTHER}`,
            `balances.Deposit: ${MULTISIG}`, `treasury.Awarded: ${MULTISIG}`, `balances.Withdraw: ${TREASURY}`
        ]);
    });

    test('a fee is plumbing even when someone other than the signer pays it', () => {
        assert.deepEqual(linked([ev(9, 1, OWNER_A, 'transactionPayment.TransactionFeePaid', { who: OTHER, actualFee: '1', tip: '0' })]), ['transactionPayment.TransactionFeePaid: ']);
    });

    test('a deposit to the treasury outside a signed extrinsic is income, not a fee, and is kept', () => {
        assert.deepEqual(linked([ev(9, null, 'System', 'balances.Deposit', { who: TREASURY, amount: '5' })]), [`balances.Deposit: ${TREASURY}`]);
    });

    test('a staking payout is left to the rewards page; a transfer in the same batch is not', () => {
        assert.deepEqual(linked(signedExtrinsic(300, BOT, [
            ['staking.PayoutStarted', { eraIndex: '7', validatorStash: OWNER_A }],
            ['balances.Deposit', { who: OTHER, amount: '20,000,000,000,000' }],
            ['staking.Rewarded', { stash: OWNER_A, amount: '20,000,000,000,000' }],
            ['balances.Deposit', { who: OWNER_B, amount: '1,000,000,000,000' }],
            ['balances.Locked', { who: OWNER_B, amount: '1,000,000,000,000' }],
            ['staking.Rewarded', { stash: OWNER_B, amount: '1,000,000,000,000' }],
            ['balances.Transfer', { from: BOT, to: OTHER, amount: '1,000,000,000,000' }],
            ['balances.Deposit', { who: BOT, amount: '1,000' }]
        ])).filter(l => !l.endsWith(': ')), [`balances.Transfer: ${OTHER}`]);
    });

    test('legacy array data and stored JSON give the same links', () => {
        const live = [ev(50, 1, OWNER_A, 'balances.Transfer', [OWNER_A, OTHER, '5,000,000,000,000'])];
        const stored = live.map(e => ({ ...e, data: JSON.stringify(e.data) }));
        assert.deepEqual(linked(live), [`balances.Transfer: ${OTHER}`]);
        assert.deepEqual(linked(stored), linked(live));
    });

    test('an offline report links the offline validators, not every nominator in their exposures', () => {
        const exposure = { total: '5', own: '1', others: [{ who: OWNER_A, value: '2' }, { who: OWNER_B, value: '2' }] };
        assert.deepEqual(linked([
            ev(9, null, 'System', 'imOnline.SomeOffline', { offline: [[OTHER, exposure], [BOT, { total: '1', own: '1', others: [] }]] }),
            ev(9, null, 'System', 'imOnline.SomeOffline', [[[OTHER, exposure]]])
        ]), [`imOnline.SomeOffline: ${OTHER},${BOT}`, `imOnline.SomeOffline: ${OTHER}`]);
    });

    test('another SS58 prefix of the same account is the same account', () => {
        assert.deepEqual(linked([ev(9, null, 'System', 'balances.Deposit', { who: encodeAddress(decodeAddress(OTHER), 42), amount: '1' })]), [`balances.Deposit: ${OTHER}`]);
    });
});

const created = [];
after(() => {
    for (const dir of created) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
});
const freshDb = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-account-links-'));
    created.push(dir);
    db.initDb(dir, true, { awaitMigrator: false });
};

describe('the links of a reorged block', () => {
    test('a reorg repair drops the links of the fork events it deletes', () => {
        freshDb();
        const CANON = '0x' + 'cd'.repeat(32);
        db.insertEvents([
            { hash: `${HASH}-0`, blockHash: HASH, block: 7, eventIndex: 0, section: 'balances', method: 'Deposit', accounts: [OTHER] },
            { hash: `${CANON}-0`, blockHash: CANON, block: 7, eventIndex: 0, section: 'balances', method: 'Deposit', accounts: [OWNER_A] }
        ]);
        assert.equal(db.deleteForkRows(7, CANON).links, 1);
        assert.equal(db.countEventsByAddress(OTHER), 0);
        assert.equal(db.countEventsByAddress(OWNER_A), 1);
    });
});

// Each new event carries its links whichever indexer path stores it.
describe('server.js wiring', () => {
    const server = stripComments(readRepo('server.js', import.meta.url));

    test('scanSingleBlock links every event it builds, so every insertEvents caller stores links', () => {
        assertOrder(assert, bodyOf(server, 'scanSingleBlock'), 'events.push({', 'attachAccounts(events, ACCOUNT_LINK_RULES);', 'links are attached after the events are built');
        assert.match(server, /const ACCOUNT_LINK_RULES = \{ normalize: normalizeAddress, treasury: TREASURY_ACCOUNT \};/);
    });
});
