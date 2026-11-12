// The human-readable call arguments, wired into every page that shows a decoded
// call: the governance item pages (council and Technical Committee motions,
// referenda, public and external proposals), the Council list's motion cards,
// the transaction page (decoded call and events), the block decoder, and the
// multisig review. Real codecs where a codec is involved, the real renderers
// with a fake DOM, and source checks only for script.js and server.js (a browser
// bundle and an express app with no export surface).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { encodeAddress } from '@polkadot/util-crypto';
import { registryFromMetadata } from './helpers/extrinsic-builders.js';
import { describeCall } from '../lib/gov-chain-read.js';
import { callStub } from '../lib/collective-live.js';
import { openMotionCall } from '../lib/gov-detail-api.js';
import { renderGovDetailSummary, govSeoDescription } from '../lib/gov-detail-view.js';
import { installCallArgCopy } from '../lib/call-args-format.js';
import { argEntries } from '../lib/call-tree.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, stripComments } from './helpers/source.js';

const registry = registryFromMetadata(substrateMetadata);
registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 88, tokenDecimals: 12, tokenSymbol: 'PDEX' }));
const ex = decorateExtrinsics(registry, registry.metadata, 15);
const A = encodeAddress(new Uint8Array(32).fill(7), 88);
const PDEX = 10n ** 12n;
const spendCall = () => registry.createType('Call', ex.treasury.spend(null, 50_000n * PDEX, { Id: A }, null).toHex());

const h = { esc: escapeHtml, num: (n) => String(n), pdex: (n) => String(n), shortAddr: (a) => String(a).slice(0, 6), fmtDate: (ms) => `T${ms}` };
const motionPage = (call, over = {}) => ({
    kind: 'motion', collective: 'council', id: '0xaa', index: 142, hash: '0x' + 'aa'.repeat(32), title: 'Council Motion #142: treasury.spend', status: 'proposed',
    proposer: null, call, threshold: 3, seats: 5, ayes: 1, nays: 0, currentBlock: 1000, blockMs: 12000, now: 1e12, timeline: [], sources: { chain: true }, ...over
});

describe('the call producers send typed nodes', () => {
    test('describeCall (item pages, archive reads, preimages) keeps its text value and adds typeName and node', () => {
        const d = describeCall(spendCall());
        const amount = d.args.find(x => x.name === 'amount');
        assert.equal(amount.typeName, 'AssetBalanceOf');
        assert.equal(amount.node.v, '50000000000000000');
        assert.equal(typeof amount.value, 'string');
    });

    test('collective-live callStub (new motions seen by the browser) adds them too', () => {
        const stub = callStub(registry.createType('Option<Call>', spendCall()));
        const amount = stub.args.find(x => x.name === 'amount');
        assert.equal(amount.typeName, 'AssetBalanceOf');
        assert.equal(amount.node.v, '50000000000000000');
        assert.equal(typeof amount.value, 'string');
    });

    test('openMotionCall keeps type name and node from the council snapshot', () => {
        const [first, second] = argEntries(spendCall());
        const c = openMotionCall({ section: 'treasury', method: 'spend', args: [{ name: first.name, value: 'Native', typeName: first.typeName, node: first.node }, { name: second.name, value: '5', typeName: second.typeName, node: second.node }] });
        assert.equal(c.args[1].typeName, 'AssetBalanceOf');
        assert.equal(c.args[1].node.v, '50000000000000000');
        assert.equal(c.args[1].value, '5');
        const legacy = openMotionCall({ section: 'a', method: 'b', args: [{ name: 'x', value: '1' }] });
        assert.deepEqual(legacy.args, [{ name: 'x', type: null, value: '1' }]);
    });
});

describe('governance item page', () => {
    test('motion 142: the spend amount reads in PDEX, the raw JSON is one click away', () => {
        const html = renderGovDetailSummary(motionPage(describeCall(spendCall())), h, {});
        assert.match(html, /50,000 PDEX/);
        assert.match(html, /<details class="ca-raw-view">/);
        assert.match(html, /treasury\.spend/);
    });

    test('a call with no typed nodes (older cached payload) still renders its raw table', () => {
        const html = renderGovDetailSummary(motionPage({ section: 'treasury', method: 'spend', args: [{ name: 'amount', type: 'u128', value: '5' }] }), h, {});
        assert.match(html, /<td class="gd-arg-value">5<\/td>/);
    });

    test('block estimates on the page use the payload head and block time', () => {
        const c = registry.createType('Call', ex.treasury.spend(null, 5n, { Id: A }, 1100).toHex());
        const html = renderGovDetailSummary(motionPage(describeCall(c)), h, {});
        assert.match(html, /#1,100/);
        assert.match(html, /~T/);
    });

    test('the meta description carries the human amount, never planck', () => {
        const d = govSeoDescription(motionPage(describeCall(spendCall())));
        assert.match(d, /50,000 PDEX/);
        assert.doesNotMatch(d, /50000000000000000/);
        assert.match(d, /Council Motion #142/);
        assert.equal(govSeoDescription(motionPage(null)), 'Council Motion #142: treasury.spend: status, votes, lifecycle and discussion on the Polkadex Explorer.');
    });

    test('the page controller sets the description from govSeoDescription', () => {
        const src = stripComments(readRepo('lib/gov-detail-view.js', import.meta.url));
        assert.match(src, /description: govSeoDescription\(data\)/);
    });
});

describe('copy control', () => {
    test('one delegated click handler copies the full value held in data-ca-copy', async () => {
        let listener = null;
        const doc = { addEventListener: (t, fn) => { if (t === 'click') listener = fn; } };
        const copied = [];
        installCallArgCopy(doc, { copy: async (v) => { copied.push(v); return true; } });
        const btn = { getAttribute: (n) => (n === 'data-ca-copy' ? '0xfull' : null), textContent: 'Copy' };
        await listener({ target: { closest: (sel) => (sel === '[data-ca-copy]' ? btn : null) }, preventDefault() {} });
        assert.deepEqual(copied, ['0xfull']);
        assert.equal(btn.textContent, 'Copied');
        await listener({ target: { closest: () => null } });
        assert.equal(copied.length, 1);
    });
});

describe('pages that show a decoded call', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));
    const server = stripComments(readRepo('server.js', import.meta.url));
    const multisig = stripComments(readRepo('lib/multisig-view.js', import.meta.url));
    const css = readRepo('styles.css', import.meta.url);

    test('script.js stays under its 15,000-line ceiling', () => {
        assert.ok(readRepo('script.js', import.meta.url).split('\n').length <= 15000);
    });

    test('Council and Technical Committee motion cards render the typed call', () => {
        assert.match(script, /import \{[^}]*renderCallHtml[^}]*\} from '\.\/lib\/call-args-format\.js'/);
        const card = script.slice(script.indexOf("const argsHtml = (m.args && m.args.length)"), script.indexOf("const voterList = (label, addrs)"));
        assert.match(card, /renderCallHtml\(/);
    });

    test('the council snapshot sends type name and node for every argument (server)', () => {
        const at = server.indexOf('collectiveModule.proposalOf(h)');
        const block = server.slice(at, at + 2200);
        assert.match(block, /argEntries\(call/);
        assert.match(block, /typeName/);
    });

    test('the transaction page returns the decoded call and the events as typed trees, and shows them', () => {
        const at = server.indexOf("event: `${targetExt.method.section} -> ${targetExt.method.method}`");
        const block = server.slice(at, at + 900);
        assert.match(server, /callToTree\(targetExt\.method\)/);
        assert.match(block, /call: txCall/);
        assert.match(block, /eventTrees\n/);
        assert.match(script, /renderCallHtml\(data\.call/);
        assert.match(script, /renderCallHtml\(\{ section: ev\.section|eventTrees/);
    });

    test('the block decoder pairs each extrinsic with its typed call', () => {
        assert.match(server, /const tree = callToTree\(call\)[\s\S]*callTree: tree/);
        assert.match(script, /renderCallHtml\(x\.callTree/);
    });

    test('the multisig review shows the decoded call in human form, raw JSON still available', () => {
        assert.match(multisig, /renderCallHtml\(callToTree\(p\.call\)/);
        assert.doesNotMatch(multisig, /amounts are base units unless a unit is shown/);
    });

    test('the copy handler is installed once and the styles exist', () => {
        assert.match(script, /installCallArgCopy\(document/);
        for (const c of ['.ca-amount', '.ca-raw', '.ca-nested', '.ca-hash', '.ca-raw-view']) assert.ok(css.includes(c), c);
    });
});
