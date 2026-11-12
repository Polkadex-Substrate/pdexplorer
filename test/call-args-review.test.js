// Review findings on the human-readable call arguments, each pinned with REAL
// codecs: the Polkadex spec 393 metadata fixture (test/fixtures/metadata-testnet-393.json),
// the spec 373 one for the pallets that left the runtime since (OCEX,
// CrowdSourceLMP, OrmlVesting), and Substrate's own metadata only for the
// pallets Polkadex does not run (vesting, nominationPools).
//
//  1. treasury.spend's AssetKind is () on Polkadex: a Null codec. It decoded to
//     a hex node "0x" and the amount fell back to raw "units".
//  2. Pallets whose Balance is not the native currency (assetConversion,
//     assetRewards, ...) must never read as PDEX; OCEX keeps raw units.
//  3. A long hex value counted its bytes from the CUT text ("128.5 bytes").
//  4. A balance inside a struct or enum variant typed as the native balance
//     reads as PDEX too.
//  5. Closed motions: timeline wording, the "decided" line, and no vote buttons.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { encodeAddress } from '@polkadot/util-crypto';
import { stringCamelCase } from '@polkadot/util';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { callToTree } from '../lib/call-tree.js';
import { renderCallHtml, callSummaryText, isNativeBalanceField, ASSET_PALLETS, RAW_UNIT_PALLETS } from '../lib/call-args-format.js';
import { describeCall } from '../lib/gov-chain-read.js';
import { renderGovDetailSummary, govSeoDescription, renderMotionVotes } from '../lib/gov-detail-view.js';
import { motionTimeline } from '../lib/gov-detail.js';
import { govActionModel, renderGovActions } from '../lib/gov-actions.js';
import { escapeHtml } from '../lib/html-escape.js';

// Made-up accounts (public repo): filler bytes at prefix 88.
const A = encodeAddress(new Uint8Array(32).fill(7), 88);
const B = encodeAddress(new Uint8Array(32).fill(9), 88);
const PDEX = 10n ** 12n;
const h = { esc: escapeHtml, num: (n) => String(n), pdex: (n) => String(n), shortAddr: (a) => String(a).slice(0, 6), fmtDate: (ms) => `T${ms}` };
const arg = (tree, name) => tree.args.find(a => a.name === name);

function chain(file, version) {
    const fx = loadFixture(file);
    const registry = registryFromMetadata(fx.metadata);
    registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 88, tokenDecimals: 12, tokenSymbol: 'PDEX' }));
    return { registry, ex: decorateExtrinsics(registry, registry.metadata, version), decode: (c) => registry.createType('Call', c.toHex()) };
}
const p392 = chain('metadata-testnet-393.json', 15);
const p373 = chain('metadata-mainnet-373.json', 14);
const sub = (() => {
    const registry = registryFromMetadata(substrateMetadata);
    return { registry, ex: decorateExtrinsics(registry, registry.metadata, 15), decode: (c) => registry.createType('Call', c.toHex()) };
})();

const motionPage = (call, over = {}) => ({
    kind: 'motion', collective: 'council', id: '0xaa', index: 142, hash: '0x' + 'aa'.repeat(32), title: 'Council Motion #142: treasury.spend', status: 'executed',
    proposer: null, call, threshold: 3, seats: 5, ayes: 3, nays: 0, currentBlock: 1000, blockMs: 12000, now: 1e12, timeline: [], sources: { chain: true }, ...over
});

describe('1. council motion 142: treasury.spend with Polkadex\'s () asset kind', () => {
    // council.propose(3, treasury.spend((), 1035759400000000, Id(B), None), len), as tabled.
    const proposal = () => {
        const { ex, decode } = p392;
        const spend = ex.treasury.spend(null, 1035759400000000n, { Id: B }, null);
        const motion = decode(ex.council.propose(3, spend, spend.encodedLength));
        return motion.args[1];
    };

    test('the asset kind is a unit node, typed Null, not a hex "0x"', () => {
        const kind = arg(callToTree(proposal()), 'assetKind');
        assert.equal(kind.typeName, 'AssetKind');
        assert.deepEqual(kind.node, { k: 'null', t: 'Null' });
    });

    test('the item page reads 1,035.7594 PDEX, with the planck value kept, and no "units"', () => {
        const html = renderGovDetailSummary(motionPage(describeCall(proposal())), h, {});
        assert.match(html, /<span class="ca-amount" title="1035759400000000 planck">1,035\.7594 PDEX<\/span>/);
        assert.doesNotMatch(html, /1035759400000000 units/);
    });

    test('the meta description reads 1,035.7594 PDEX', () => {
        const d = govSeoDescription(motionPage(describeCall(proposal())));
        assert.match(d, /1,035\.7594 PDEX/);
        assert.doesNotMatch(d, /units/);
    });

    test('an asset kind that is an Option None or a missing node is not taken as native', () => {
        const none = [{ name: 'assetKind', typeName: 'AssetKind', node: { k: 'none' } }];
        assert.equal(isNativeBalanceField('treasury', 'spend', 'amount', 'AssetBalanceOf', none), false);
        assert.equal(isNativeBalanceField('treasury', 'spend', 'amount', 'AssetBalanceOf', [{ name: 'assetKind', typeName: 'AssetKind' }]), false);
    });
});

describe('2. pallets whose Balance is not PDEX', () => {
    test('assetConversion.swapExactTokensForTokens: amounts are raw units, never PDEX, even with Native in the path', () => {
        const { ex, decode } = p392;
        const t = callToTree(decode(ex.assetConversion.swapExactTokensForTokens(['Native', { WithId: 1 }], 5n * PDEX, 4n * PDEX, A, false)));
        const html = renderCallHtml(t, {});
        assert.match(html, /5000000000000 units/);
        assert.match(html, /4000000000000 units/);
        assert.doesNotMatch(html, /PDEX/);
        assert.doesNotMatch(callSummaryText(t), /PDEX/);
    });

    test('assetConversion.addLiquidity: all four amounts are raw units', () => {
        const { ex, decode } = p392;
        const t = callToTree(decode(ex.assetConversion.addLiquidity('Native', { WithId: 1 }, 7n * PDEX, 8n, 6n * PDEX, 7n, A)));
        const html = renderCallHtml(t, { assets: { 1: { symbol: 'USDT', decimals: 6 } } });
        for (const v of ['7000000000000', '8', '6000000000000', '7']) assert.match(html, new RegExp(`>${v} units<`));
        assert.doesNotMatch(html, /PDEX/);
    });

    test('assetRewards and the other asset-side pallets are listed explicitly', () => {
        for (const s of ['assetConversion', 'assetRewards', 'poolAssets', 'assets', 'ocex', 'thea', 'theaExecutor', 'hyperFungibleToken', 'crowdSourceLMP']) {
            assert.ok(ASSET_PALLETS.has(s), s);
            assert.equal(isNativeBalanceField(s, 'any', 'amount', 'T::Balance', []), false, s);
        }
    });

    test('every pallet in the 392 and 373 metadata whose calls name an asset (other than treasury) is an asset pallet', () => {
        const missing = [];
        for (const { registry } of [p392, p373]) {
            for (const p of registry.metadata.pallets) {
                if (p.calls.isNone) continue;
                const name = stringCamelCase(p.name.toString());
                if (name === 'treasury') continue;
                const variants = registry.lookup.getSiType(p.calls.unwrap().type).def.asVariant.variants;
                const named = variants.some(v => v.fields.some(f => f.typeName.isSome && /Asset|TradingPair/.test(f.typeName.unwrap().toString())));
                if (named && !ASSET_PALLETS.has(name)) missing.push(name);
            }
        }
        assert.deepEqual([...new Set(missing)], []);
    });

    test('ocex.deposit (373): raw units even when the asset\'s decimals are known (OCEX keeps its own 12-decimal convention)', () => {
        const { ex, decode } = p373;
        assert.ok(RAW_UNIT_PALLETS.has('ocex'));
        const t = callToTree(decode(ex.ocex.deposit({ Asset: 1 }, 2_500_000n)));
        const html = renderCallHtml(t, { assets: { 1: { symbol: 'USDC', decimals: 6 } } });
        assert.match(html, />2500000 units</);
        assert.doesNotMatch(html, /USDC|PDEX/);
    });

    test('crowdSourceLMP.removeLiquidity (373): shares are not PDEX', () => {
        const { ex, decode } = p373;
        const t = callToTree(decode(ex.crowdSourceLMP.removeLiquidity({ base: 'Polkadex', quote: { Asset: 1 } }, A, 9n * PDEX)));
        assert.doesNotMatch(renderCallHtml(t, {}), /PDEX/);
    });
});

describe('3. long hex values count their bytes from the full value', () => {
    const code = (n) => { const { ex, decode } = p392; return callToTree(decode(ex.system.setCode('0x' + 'ab'.repeat(n)))); };

    test('system.setCode with 1,000 bytes: the node keeps the byte count, the page shows "1,000 bytes" and a short preview', () => {
        const t = code(1000);
        assert.equal(arg(t, 'code').node.b, 1000);
        const html = renderCallHtml(t, {}, { raw: false });
        assert.match(html, /\(1,000 bytes\)/);
        assert.doesNotMatch(html, /\.5 bytes/);
        const shown = /<code class="ca-hex"[^>]*>([^<]*)<\/code>/.exec(html)[1];
        assert.ok(shown.length < 40, shown);
    });

    test('129 bytes (just over the text cap, the "128.5 bytes" case) reads 129 bytes', () => {
        assert.match(renderCallHtml(code(129), {}, { raw: false }), /\(129 bytes\)/);
    });

    test('a short value is shown whole with no count; a cut value of unknown size gets no made-up count', () => {
        assert.match(renderCallHtml(code(4), {}), /<code class="ca-hex" title="0xabababab">0xabababab<\/code>/);
        const legacy = { section: 'system', method: 'setCode', args: [{ name: 'code', typeName: 'Vec<u8>', node: { k: 'hex', v: '0x' + 'ab'.repeat(127) + '...' } }] };
        const html = renderCallHtml(legacy, {}, { raw: false });
        assert.doesNotMatch(html, /bytes\)/);
    });
});

describe('4. native balances nested in structs and enum variants', () => {
    test('democracy.vote Standard { balance } (393): 5 PDEX', () => {
        const { ex, decode } = p392;
        const t = callToTree(decode(ex.democracy.vote(1, { Standard: { vote: { aye: true, conviction: 'Locked1x' }, balance: 5n * PDEX } })));
        assert.match(renderCallHtml(t, {}), /<span class="ca-amount" title="5000000000000 planck">5 PDEX<\/span>/);
    });

    test('vesting.vestedTransfer schedule (Substrate): locked and perBlock in PDEX, startingBlock stays a number', () => {
        const { ex, decode } = sub;
        const t = callToTree(decode(ex.vesting.vestedTransfer(A, { locked: 1000n * PDEX, perBlock: PDEX, startingBlock: 5 })));
        const html = renderCallHtml(t, {}, { raw: false });
        assert.match(html, /1,000 PDEX/);
        assert.match(html, />1 PDEX</);
        assert.match(html, /<span class="ca-key">startingBlock<\/span>: <span class="ca-num">5<\/span>/);
    });

    test('nominationPools.bondExtra FreeBalance (Substrate): 2 PDEX', () => {
        const { ex, decode } = sub;
        const t = callToTree(decode(ex.nominationPools.bondExtra({ FreeBalance: 2n * PDEX })));
        assert.match(renderCallHtml(t, {}), />2 PDEX</);
    });

    test('ormlVesting.vestedTransfer (373): perPeriod in PDEX; period (a duration typed BlockNumber) stays a plain number', () => {
        const { ex, decode } = p373;
        const t = callToTree(decode(ex.ormlVesting.vestedTransfer(A, { start: 10, period: 100, periodCount: 4, perPeriod: 3n * PDEX })));
        const html = renderCallHtml(t, {}, { raw: false });
        assert.match(html, />3 PDEX</);
        assert.match(html, /<span class="ca-key">period<\/span>: <span class="ca-num">100<\/span>/);
    });

    test('a nested Balance in a non-native pallet stays raw: hyperFungibleToken.send amount (393)', () => {
        const { ex, decode } = p392;
        const t = callToTree(decode(ex.hyperFungibleToken.send({ assetId: 1, destination: { Evm: 1 }, recipient: '0x' + '11'.repeat(20), amount: 5n * PDEX, timeout: 0, relayerFee: 0, callData: null })));
        assert.doesNotMatch(renderCallHtml(t, {}), /PDEX/);
    });
});

describe('5. closed motions', () => {
    test('closed before its end block: no "Voting period ended"; the end is what would have been', () => {
        const s = motionTimeline({ status: 'executed', proposedBlock: 10, end: 100, resolvedBlock: 20, currentBlock: 200 });
        assert.ok(!s.some(x => x.label === 'Voting period ended'));
        const end = s.find(x => x.key === 'end');
        assert.equal(end.label, 'Voting period would have ended');
        assert.equal(end.block, 100);
        assert.match(end.note, /closed at block 20/);
        assert.deepEqual(s.find(x => x.key === 'outcome') && [s.find(x => x.key === 'outcome').label, s.find(x => x.key === 'outcome').block], ['Executed', 20]);
    });

    test('closed at or after the end block: "Voting period ended"; unknown close block: a neutral label', () => {
        assert.equal(motionTimeline({ status: 'disapproved', end: 100, resolvedBlock: 150, currentBlock: 200 }).find(x => x.key === 'end').label, 'Voting period ended');
        assert.equal(motionTimeline({ status: 'closed', end: 100, resolvedBlock: null, currentBlock: 200 }).find(x => x.key === 'end').label, 'Voting period end');
        assert.equal(motionTimeline({ status: 'proposed', end: 100, currentBlock: 50 }).find(x => x.key === 'end').label, 'Voting ends');
    });

    test('"takes effect when a member closes the motion" only while the motion is open', () => {
        const decided = { threshold: 3, seats: 5, ayes: 3, nays: 0, ayeVoters: [], nayVoters: [] };
        assert.match(renderMotionVotes({ ...decided, status: 'proposed' }, h), /it takes effect when a member closes the motion/);
        for (const status of ['executed', 'approved', 'disapproved', 'closed']) {
            assert.doesNotMatch(renderMotionVotes({ ...decided, status }, h), /takes effect when a member closes/, status);
        }
    });

    test('a closed motion has no Vote or Close buttons, only "Voting has closed"', () => {
        const members = ['eM1', 'eM2', 'eM3'];
        for (const status of ['executed', 'disapproved', 'closed', 'approved']) {
            const m = govActionModel(motionPage(null, { status, endBlock: 1300, ayeVoters: [], nayVoters: [] }), { account: 'eM1', members });
            assert.deepEqual(m.buttons, [], status);
            assert.match(m.reason, /^Voting has closed: this motion is /);
            const html = renderGovActions(m, h);
            assert.doesNotMatch(html, /data-gd-act=/);
            assert.match(html, /Voting has closed/);
        }
        const open = govActionModel(motionPage(null, { status: 'proposed', endBlock: 1300, ayeVoters: [], nayVoters: [] }), { account: 'eM1', members });
        assert.deepEqual(open.buttons.map(b => b.act), ['aye', 'nay', 'close']);
    });
});
