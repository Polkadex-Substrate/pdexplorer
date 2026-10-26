// The live governance decoders (lib/democracy-live.js, lib/collective-live.js)
// fed REAL @polkadot/types codecs, built from runtime metadata, instead of the
// hand-made fakes in democracy-live.test.js and collective-live.test.js.
//
// Why: those modules landed on main while the explorer was on @polkadot/api
// 10.13.1 and were tested only against fakes shaped like the 10.x codecs.
// This file pins the shapes they rely on (Option isSome/unwrap, enum
// isOngoing/asOngoing, Vec as an Array, tuple indexing, GenericVote isAye and
// conviction, SeatHolder who/stake, Call section/method/meta.args) against the
// library actually installed. On 2026-10-25 the same reads were run against
// 10.13.1 and 17.0.2 with the mainnet 373 metadata and gave identical output.
//
// Sources: Substrate's own metadata shipped in @polkadot/types-support
// (always), plus test/fixtures/metadata-373.json and metadata-392.json when
// scripts/fetch-metadata.mjs has written them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { decodeReferendum, decodeDeposit, decodeVoting, proposalHash } from '../lib/democracy-live.js';
import { votingToRecord } from '../lib/collective-live.js';

const A = '0x' + 'd4'.repeat(32);
const B = '0x' + '8e'.repeat(32);
const H = '0x' + 'ab'.repeat(32);
const PDEX = 10n ** 12n;

const sources = [{ label: 'substrate (types-support)', hex: substrateMetadata }];
for (const f of ['metadata-373.json', 'metadata-392.json']) {
    const fx = loadFixture(f);
    if (fx) sources.push({ label: `Polkadex spec ${fx.specVersion} (${f})`, hex: fx.metadata });
}

function storage(registry, pallet, item) {
    const p = registry.metadata.pallets.find(x => x.name.toString() === pallet);
    const it = p && p.storage.isSome ? p.storage.unwrap().items.find(i => i.name.toString() === item) : null;
    if (!it) return null;
    const name = registry.createLookupType(it.type.isPlain ? it.type.asPlain : it.type.asMap.value);
    return (v) => (it.modifier.isOptional ? registry.createType(`Option<${name}>`, v) : registry.createType(name, v));
}

const noDelegations = { votes: 0, capital: 0 };

for (const src of sources) {
    describe(`live governance decoders on real codecs: ${src.label}`, () => {
        const registry = registryFromMetadata(src.hex);
        registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 88 }));
        const need = (pallet, item) => {
            const f = storage(registry, pallet, item);
            assert.ok(f, `${pallet}.${item} missing from this metadata`);
            return f;
        };

        test('democracy.referendumInfoOf: Ongoing, Finished, None', () => {
            const RI = need('Democracy', 'ReferendumInfoOf');
            const on = decodeReferendum(3, RI({ Ongoing: { end: 100, proposal: { Lookup: { hash: H, len: 10 } },
                threshold: 'SuperMajorityApprove', delay: 5, tally: { ayes: 3n * PDEX / 2n, nays: 2n * PDEX, turnout: 3n * PDEX } } }), null);
            assert.deepEqual(on, { refIndex: 3, status: 'Ongoing', endBlock: 100, ayes: 1.5, nays: 2, turnout: 3,
                tallyKnown: 1, threshold: 'SuperMajorityApprove', proposal: H });
            const legacy = decodeReferendum(4, RI({ Ongoing: { end: 1, proposal: { Legacy: { hash: H } }, threshold: 'SimpleMajority',
                delay: 0, tally: { ayes: 0, nays: 0, turnout: 0 } } }), null);
            assert.equal(legacy.proposal, H);
            const inline = decodeReferendum(5, RI({ Ongoing: { end: 1, proposal: { Inline: '0x0001' }, threshold: 'SimpleMajority',
                delay: 0, tally: { ayes: 0, nays: 0, turnout: 0 } } }), null);
            assert.equal(inline.proposal, null);
            const done = decodeReferendum(3, RI({ Finished: { approved: true, end: 50 } }), on);
            assert.equal(done.status, 'Passed');
            assert.equal(done.endBlock, 50);
            assert.equal(done.ayes, 1.5, 'the last seen tally is kept');
            assert.equal(decodeReferendum(3, RI({ Finished: { approved: false, end: 50 } }), null).status, 'NotPassed');
            assert.equal(decodeReferendum(3, RI(null), null), null);
        });

        test('democracy.depositOf and publicProps', () => {
            const DO = need('Democracy', 'DepositOf');
            assert.deepEqual(decodeDeposit(DO([[A, B], 5n * PDEX / 2n])), { seconds: 2, deposit: 2.5 });
            assert.equal(decodeDeposit(DO(null)), null);
            const PP = need('Democracy', 'PublicProps');
            const [entry] = Array.from(PP([[7, { Lookup: { hash: H, len: 3 } }, A]]));
            assert.ok(Array.isArray(entry), 'a tuple codec is an Array');
            assert.equal(entry[0].toNumber(), 7);
            assert.equal(proposalHash(entry[1]), H);
            assert.ok(String(entry[entry.length - 1]).startsWith('e'), 'proposer prints as an SS58-88 address');
        });

        test('democracy.votingOf: Standard (GenericVote), Split, Delegating', () => {
            const VO = need('Democracy', 'VotingOf');
            // Vote is one byte: high bit aye, low bits conviction. 0x82 = aye, Locked2x.
            const direct = decodeVoting(VO({ Direct: { votes: [
                [3, { Standard: { vote: new Uint8Array([0x82]), balance: 5n * PDEX } }],
                [9, { Standard: { vote: new Uint8Array([0x01]), balance: PDEX } }],
                [4, { Split: { aye: PDEX, nay: 2n * PDEX } }]
            ], delegations: noDelegations, prior: [0, 0] } }));
            assert.deepEqual(direct.votes[3], { aye: true, conviction: 'Locked2x', balance: 5 });
            assert.deepEqual(direct.votes[9], { aye: false, conviction: 'Locked1x', balance: 1 });
            assert.deepEqual(direct.votes[4], { split: true, aye: null, ayeBalance: 1, nayBalance: 2, balance: 3 });
            assert.equal(direct.delegating, false);
            const del = decodeVoting(VO({ Delegating: { balance: 1, target: A, conviction: 'None', delegations: noDelegations, prior: [0, 0] } }));
            assert.deepEqual(del, { delegating: true, votes: {} });
        });

        test('council and technical committee: voting, members, prime', () => {
            for (const pallet of ['Council', 'TechnicalCommittee']) {
                const V = need(pallet, 'Voting');
                const rec = votingToRecord(V({ index: 2, threshold: 3, ayes: [A], nays: [B], end: 999 }), (a) => 'x' + a);
                assert.equal(rec.index, 2);
                assert.equal(rec.threshold, 3);
                assert.equal(rec.end, 999);
                assert.equal(rec.ayes.length, 1);
                assert.ok(rec.ayes[0].startsWith('xe'), rec.ayes[0]);
                assert.equal(votingToRecord(V(null)), null);
                const members = Array.from(need(pallet, 'Members')([A, B])).map(String);
                assert.equal(members.length, 2);
                const prime = need(pallet, 'Prime')(A);
                assert.ok(prime.isSome && String(prime.unwrap()) === members[0]);
            }
        });

        test('elections seats read as who/stake, proposalOf as a Call', () => {
            const EM = need('Elections', 'Members');
            const [seat] = Array.from(EM([{ who: A, stake: 7n * PDEX, deposit: 1 }]));
            assert.ok(String(seat.who).startsWith('e'));
            assert.equal(BigInt(String(seat.stake)), 7n * PDEX);
            const PO = need('Council', 'ProposalOf');
            const remark = registry.createType('Call', { callIndex: findCallIndex(registry, 'system', 'remark'), args: { remark: '0x1234' } });
            const call = PO(remark).unwrap();
            assert.equal(String(call.section), 'system');
            assert.equal(String(call.method), 'remark');
            assert.equal(String(call.meta.args[0].name), 'remark');
            assert.equal(String(call.args[0]), '0x1234');
            assert.ok(Number(call.encodedLength) > 0);
        });
    });
}

function findCallIndex(registry, section, method) {
    for (const p of registry.metadata.pallets) {
        if (p.calls.isNone) continue;
        const variants = registry.lookup.getSiType(p.calls.unwrap().type).def.asVariant.variants;
        const v = variants.find(x => x.name.toString() === method);
        if (v && p.name.toString().toLowerCase() === section) return [p.index.toNumber(), v.index.toNumber()];
    }
    throw new Error(`${section}.${method} not in metadata`);
}
