// The governance item pages' chain reads (lib/gov-chain-read.js, server.js
// govChain) and the other new governance code from main (proposal hashes,
// enactment matching, the motion-hash backfill, the Actions panel balance)
// fed REAL @polkadot/types codecs built from runtime metadata under the
// installed @polkadot/api 17, not the hand-made fakes in gov-detail.test.js.
//
// Why: those features landed on main while the explorer ran @polkadot/api
// 10.13.1, tested only against fakes, and are merged onto the api 17 branch
// days before runtime spec 392 enacts on mainnet.
//
// Sources: Substrate's metadata shipped in @polkadot/types-support (always; it
// has the newer preimage pallet with RequestStatusFor, as 392 does), plus
// test/fixtures/metadata-373.json and metadata-392.json when
// scripts/fetch-metadata.mjs has written them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { blake2AsHex } from '@polkadot/util-crypto';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import {
    describeCall, readReferendumInfo, readDepositOf, readNextExternal, readPublicProp, readCollectiveVoting,
    preimageLen, notedPreimageLen
} from '../lib/gov-chain-read.js';
import { boundedParts, proposalHashOf, isExternalProposeCall } from '../lib/discussion-lifecycle.js';
import { democracyEnactmentTaskIds, enactmentEventMatches } from '../lib/gov-detail-api.js';
import { findCallByHash, recoverMotionProposalHash } from '../lib/discussion-threads.js';
import { decodeAccountBalance } from '../lib/gov-actions.js';

const A = '0x' + 'd4'.repeat(32);
const B = '0x' + '8e'.repeat(32);
const H = '0x' + 'ab'.repeat(32);
const PDEX = 10n ** 12n;
const toPdex = (b) => Number(BigInt(b.toString())) / 1e12;

const sources = [{ label: 'substrate (types-support)', hex: substrateMetadata }];
for (const f of ['metadata-373.json', 'metadata-392.json']) {
    const fx = loadFixture(f);
    if (fx) sources.push({ label: `Polkadex spec ${fx.specVersion} (${f})`, hex: fx.metadata, spec: fx.specVersion });
}

function storage(registry, pallet, item) {
    const p = registry.metadata.pallets.find(x => x.name.toString() === pallet);
    const it = p && p.storage.isSome ? p.storage.unwrap().items.find(i => i.name.toString() === item) : null;
    if (!it) return null;
    const name = registry.createLookupType(it.type.isPlain ? it.type.asPlain : it.type.asMap.value);
    return (v) => (it.modifier.isOptional ? registry.createType(`Option<${name}>`, v) : registry.createType(name, v));
}

// An event as the chain encodes it: pallet index, variant index, SCALE fields.
function eventBytes(registry, pallet, name, fieldBytes) {
    const p = registry.metadata.pallets.find(x => x.name.toString() === pallet);
    const v = registry.lookup.getSiType(p.events.unwrap().type).def.asVariant.variants.find(x => x.name.toString() === name);
    assert.ok(v, `${pallet}.${name} event missing`);
    return registry.createType('Event', new Uint8Array([p.index.toNumber(), v.index.toNumber(), ...fieldBytes]));
}
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

const BOUNDED = {
    lookup: { Lookup: { hash: H, len: 10 } },
    legacy: { Legacy: { hash: H } },
    inline: { Inline: '0x0000' }
};

for (const src of sources) {
    describe(`governance chain reads on real codecs: ${src.label}`, () => {
        const registry = registryFromMetadata(src.hex);
        registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 88 }));
        const tx = decorateExtrinsics(registry, registry.metadata, 15);
        const need = (pallet, item) => {
            const f = storage(registry, pallet, item);
            assert.ok(f, `${pallet}.${item} missing from this metadata`);
            return f;
        };

        test('Bounded<Call>: Lookup, Legacy and Inline give the democracy proposal hash', () => {
            const NE = need('Democracy', 'NextExternal');
            const lookup = readNextExternal(NE([BOUNDED.lookup, 'SimpleMajority']), { hashBytes: blake2AsHex });
            assert.equal(lookup.proposalHash, H);
            assert.equal(lookup.threshold, 'SimpleMajority');
            assert.deepEqual(boundedParts(lookup.bounded), { kind: 'lookup', hash: H, len: 10 });
            const legacy = readNextExternal(NE([BOUNDED.legacy, 'SuperMajorityApprove']), { hashBytes: blake2AsHex });
            assert.equal(legacy.proposalHash, H);
            assert.deepEqual(boundedParts(legacy.bounded), { kind: 'legacy', hash: H, len: null });
            const inline = readNextExternal(NE([BOUNDED.inline, 'SimpleMajority']), { hashBytes: blake2AsHex });
            assert.equal(inline.proposalHash, blake2AsHex('0x0000'), 'Inline hashes its bytes, as Bounded::hash() does');
            assert.deepEqual(readNextExternal(NE(null)), { absent: true });
        });

        test('referendumInfoOf: Ongoing (tally, delay, bounded), Finished, None', () => {
            const RI = need('Democracy', 'ReferendumInfoOf');
            const o = readReferendumInfo(RI({ Ongoing: { end: 100, proposal: BOUNDED.lookup, threshold: 'SuperMajorityApprove', delay: 5,
                tally: { ayes: 3n * PDEX / 2n, nays: 2n * PDEX, turnout: 3n * PDEX } } }), { toPdex, hashBytes: blake2AsHex });
            assert.equal(o.state, 'ongoing');
            assert.equal(o.end, 100);
            assert.equal(o.delay, 5);
            assert.equal(o.threshold, 'SuperMajorityApprove');
            assert.deepEqual([o.ayes, o.nays, o.turnout], [1.5, 2, 3]);
            assert.equal(o.proposalHash, H);
            const i = readReferendumInfo(RI({ Ongoing: { end: 1, proposal: BOUNDED.inline, threshold: 'SimpleMajority', delay: 0,
                tally: { ayes: 0, nays: 0, turnout: 0 } } }), { toPdex, hashBytes: blake2AsHex });
            assert.equal(i.proposalHash, blake2AsHex('0x0000'));
            assert.deepEqual(boundedParts(i.bounded), { kind: 'inline', bytes: '0x0000' });
            assert.deepEqual(readReferendumInfo(RI({ Finished: { approved: true, end: 50 } }), { toPdex }), { state: 'finished', approved: true, end: 50 });
            assert.deepEqual(readReferendumInfo(RI({ Finished: { approved: false, end: 51 } }), { toPdex }), { state: 'finished', approved: false, end: 51 });
            assert.deepEqual(readReferendumInfo(RI(null), { toPdex }), { state: 'none' });
        });

        test('depositOf (Vec<AccountId>, Balance) and publicProps entries', () => {
            const DO = need('Democracy', 'DepositOf');
            const d = readDepositOf(DO([[A, B], 5n * PDEX / 2n]), { toPdex });
            assert.equal(d.deposit, 2.5);
            assert.equal(d.seconders.length, 2);
            assert.ok(d.seconders.every(s => s.startsWith('e')), 'seconders print as SS58-88');
            assert.equal(readDepositOf(DO(null), { toPdex }), null);
            const PP = need('Democracy', 'PublicProps');
            const list = PP([[7, BOUNDED.lookup, A], [8, BOUNDED.inline, B]]);
            const seven = readPublicProp(list, 7, { hashBytes: blake2AsHex });
            assert.equal(seven.proposalHash, H);
            assert.ok(seven.proposer.startsWith('e'));
            assert.equal(readPublicProp(list, 8, { hashBytes: blake2AsHex }).proposalHash, blake2AsHex('0x0000'));
            assert.deepEqual(readPublicProp(list, 9), { absent: true });
        });

        test('collective voting and proposalOf, described for the item page', () => {
            for (const pallet of ['Council', 'TechnicalCommittee']) {
                const v = readCollectiveVoting(need(pallet, 'Voting')({ index: 4, threshold: 3, ayes: [A], nays: [B], end: 999 }));
                assert.equal(v.index, 4);
                assert.equal(v.threshold, 3);
                assert.equal(v.end, 999);
                assert.ok(v.ayes[0].startsWith('e') && v.nays[0].startsWith('e'));
                assert.equal(readCollectiveVoting(need(pallet, 'Voting')(null)), null);
            }
            const ext = tx.democracy.externalProposeMajority(BOUNDED.lookup);
            const call = need('Council', 'ProposalOf')(ext).unwrap();
            const d = describeCall(call);
            assert.equal(`${d.section}.${d.method}`, 'democracy.externalProposeMajority');
            assert.equal(d.args[0].name, 'proposal');
            assert.match(d.args[0].value, /0xabab/);
            assert.ok(describeCall(call, 10).args[0].value.endsWith('...(truncated)'));
        });

        test('a preimage noted as Bytes decodes back to the Call with the same hash', () => {
            const ext = tx.democracy.externalPropose(BOUNDED.legacy);
            const bytes = registry.createType('Bytes', ext.toHex());   // what preimageFor unwraps to
            const call = registry.createType('Call', bytes);
            assert.equal(call.hash.toHex(), ext.hash.toHex());
            assert.equal(describeCall(call).method, 'externalPropose');
        });

        test('preimage length: StatusFor (373) and RequestStatusFor (392, maybeLen)', async () => {
            const SF = storage(registry, 'Preimage', 'StatusFor');
            const RSF = storage(registry, 'Preimage', 'RequestStatusFor');
            assert.ok(SF || RSF, 'no preimage status storage at all');
            if (SF) {
                assert.equal(preimageLen(SF({ Unrequested: { deposit: [A, 5], len: 77 } }).unwrap().toJSON()), 77);
                assert.equal(preimageLen(SF({ Requested: { deposit: null, count: 1, len: 55 } }).unwrap().toJSON()), 55);
                assert.equal(preimageLen(SF({ Requested: { deposit: null, count: 1, len: null } }).unwrap().toJSON()), null);
            }
            if (RSF) {
                assert.equal(preimageLen(RSF({ Requested: { maybeTicket: null, count: 1, maybeLen: 66 } }).unwrap().toJSON()), 66,
                    'Requested carries its length as maybeLen: reading only `len` misses it');
                const unreq = RSF({ Unrequested: { ticket: [A, 0], len: 44 } }).unwrap();
                assert.equal(preimageLen(unreq.toJSON()), 44);
                // Only RequestStatusFor knows this preimage (noted after the
                // upgrade): the length is found there, not in StatusFor.
                const pre = {
                    requestStatusFor: async () => RSF({ Requested: { maybeTicket: null, count: 1, maybeLen: 66 } }),
                    statusFor: SF ? async () => SF(null) : undefined
                };
                assert.equal(await notedPreimageLen(pre, H), 66);
            }
            if (SF) {
                // Noted before the upgrade: still in StatusFor, RequestStatusFor empty.
                const pre = { requestStatusFor: RSF ? async () => RSF(null) : undefined, statusFor: async () => SF({ Unrequested: { deposit: [A, 5], len: 77 } }) };
                assert.equal(await notedPreimageLen(pre, H), 77);
            }
            assert.equal(await notedPreimageLen({}, H), null);
        });

        test('scheduler.Dispatched as the indexer stores it (toHuman, JSON) matches the referendum enactment task id', () => {
            const index = 36;
            const [padded] = democracyEnactmentTaskIds(index);
            const id = Array.from(Buffer.from(padded.slice(2), 'hex'));
            const ev = eventBytes(registry, 'Scheduler', 'Dispatched', [...u32le(1000), ...u32le(0), 1, ...id, 0]);
            assert.equal(`${ev.section}.${ev.method}`, 'scheduler.Dispatched');
            const stored = JSON.parse(JSON.stringify(ev.data.toHuman()));   // server.js: data: record.event.data.toHuman()
            assert.equal(stored.id, padded, 'the [u8; 32] id prints as hex, not as text');
            const row = { section: 'scheduler', method: 'Dispatched', data: stored };
            assert.equal(enactmentEventMatches(row, index, democracyEnactmentTaskIds(index)), true);
            assert.equal(enactmentEventMatches(row, index + 1, democracyEnactmentTaskIds(index + 1)), false);
            const anon = eventBytes(registry, 'Scheduler', 'Dispatched', [...u32le(1000), ...u32le(1), 0, 0]);
            const anonRow = { section: 'scheduler', method: 'Dispatched', data: JSON.parse(JSON.stringify(anon.data.toHuman())) };
            assert.equal(anonRow.data.id, null);
            assert.equal(enactmentEventMatches(anonRow, index, democracyEnactmentTaskIds(index)), false);
        });

        test('motion-hash backfill: the externalPropose call is found inside council.propose and hashed', async () => {
            const inner = tx.democracy.externalProposeMajority(BOUNDED.lookup);
            const outer = tx.council.propose(2, inner, 100);
            const found = findCallByHash([outer], inner.hash.toHex());
            assert.ok(found, 'nested call found by its hash');
            assert.ok(isExternalProposeCall(found.section, found.method));
            assert.equal(proposalHashOf(found.args[0], blake2AsHex), H);
            const r = await recoverMotionProposalHash({ hash: inner.hash.toHex(), proposedBlock: 10, resolvedBlock: 20 }, {
                stateAt: async () => null,
                blockCalls: async () => [outer],
                hashOf: (call) => proposalHashOf(call.args[0], blake2AsHex)
            });
            assert.deepEqual(r, { outcome: 'found', hash: H });
        });

        test('Actions panel balance from a real AccountInfo', () => {
            const info = need('System', 'Account')({ nonce: 1, data: { free: 5n * PDEX, reserved: 0, frozen: 2n * PDEX } });
            assert.deepEqual(decodeAccountBalance(info), { free: 5, transferable: 3 });
        });
    });
}
