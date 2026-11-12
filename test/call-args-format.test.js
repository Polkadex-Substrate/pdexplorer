// lib/call-args-format.js: the human-readable form of a decoded call's
// arguments (the CEO's request: council motion 142 showed a treasury spend as
// raw planck). Amounts are BigInt arithmetic (no float), only fields typed as
// a balance of the native currency are PDEX, everything user-controlled is
// escaped. Mixes hand-made trees (to pin each rule) with trees decoded from
// REAL codecs (Substrate metadata) so the two halves agree.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { encodeAddress } from '@polkadot/util-crypto';
import { registryFromMetadata } from './helpers/extrinsic-builders.js';
import { callToTree } from '../lib/call-tree.js';
import {
    formatPlanck, formatAmount, isNativeBalanceField, renderCallHtml, callSummaryText, rawCallJson, shortHash
} from '../lib/call-args-format.js';

const registry = registryFromMetadata(substrateMetadata);
registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 88, tokenDecimals: 12, tokenSymbol: 'PDEX' }));
const ex = decorateExtrinsics(registry, registry.metadata, 15);
const A = encodeAddress(new Uint8Array(32).fill(7), 88);
const B = encodeAddress(new Uint8Array(32).fill(9), 88);
const real = (c) => callToTree(registry.createType('Call', c.toHex()));
const PDEX = 10n ** 12n;

const num = (v, t = 'u128') => ({ k: 'num', t, v: String(v) });
const acct = (v) => ({ k: 'enum', t: 'Enum', e: 'Id', v: { k: 'acct', v } });
const mk = (section, method, args) => ({ section, method, args });
const a = (name, typeName, node) => ({ name, type: typeName, typeName, node });

describe('formatPlanck / formatAmount (BigInt, 12 decimals, no float)', () => {
    test('whole, fractional, zero, trailing zeros trimmed, separators', () => {
        assert.equal(formatPlanck('0'), '0');
        assert.equal(formatPlanck('1'), '0.000000000001');
        assert.equal(formatPlanck('1234567890000'), '1.23456789');
        assert.equal(formatPlanck('1234500000000000'), '1,234.5');
        assert.equal(formatPlanck('50000000000000000'), '50,000');
        assert.equal(formatPlanck('1000000000000'), '1');
    });
    test('never rounds and never goes through a float', () => {
        assert.equal(formatPlanck('1999999999999'), '1.999999999999');
        assert.equal(formatPlanck('9007199254740993'), '9,007.199254740993');
        assert.equal(formatPlanck('999999999999999999999999'), '999,999,999,999.999999999999');
        assert.equal(formatPlanck((2n ** 100n).toString()), '1,267,650,600.228229401496703205376');
        assert.equal(formatPlanck(2n ** 64n), '18,446,744.073709551616');
    });
    test('another number of decimals (an asset)', () => {
        assert.equal(formatPlanck('1500000', 6), '1.5');
        assert.equal(formatPlanck('7', 0), '7');
        assert.equal(formatAmount('1500000', { decimals: 6, symbol: 'USDT' }), '1.5 USDT');
        assert.equal(formatAmount('50000000000000000'), '50,000 PDEX');
    });
    test('anything that is not a whole non-negative number is null, not a guess', () => {
        for (const bad of ['abc', '-5', '1.5', '', null, undefined, '0x10', 1.5, NaN]) assert.equal(formatPlanck(bad), null, String(bad));
    });
});

describe('isNativeBalanceField: only a balance of the native currency is PDEX', () => {
    const none = { k: 'none' };
    test('Balance and BalanceOf in a native pallet', () => {
        assert.equal(isNativeBalanceField('balances', 'transferKeepAlive', 'value', 'Balance', []), true);
        assert.equal(isNativeBalanceField('staking', 'bond', 'value', 'BalanceOf', []), true);
        assert.equal(isNativeBalanceField('staking', 'bondExtra', 'maxAdditional', 'T::Balance', []), true);
        assert.equal(isNativeBalanceField('democracy', 'propose', 'value', '<T as Config>::Balance', []), true);
    });
    test('an arbitrary u128 or id is not', () => {
        assert.equal(isNativeBalanceField('assets', 'transfer', 'id', 'AssetIdParameter', []), false);
        assert.equal(isNativeBalanceField('x', 'y', 'value', 'u128', []), false);
        assert.equal(isNativeBalanceField('x', 'y', 'value', null, []), false);
        assert.equal(isNativeBalanceField('x', 'y', 'value', 'MemberCount', []), false);
    });
    test('the assets pallet and Polkadex asset pallets carry asset balances, not PDEX', () => {
        for (const s of ['assets', 'poolAssets', 'ocex', 'thea', 'theaExecutor', 'assetHandler']) {
            assert.equal(isNativeBalanceField(s, 'transfer', 'amount', 'Balance', []), false, s);
        }
    });
    test('treasury.spend amount is PDEX only when the asset kind is the native one', () => {
        assert.equal(isNativeBalanceField('treasury', 'spend', 'amount', 'AssetBalanceOf', [a('assetKind', 'AssetKind', none)]), true);
        assert.equal(isNativeBalanceField('treasury', 'spend', 'amount', 'AssetBalanceOf', [a('assetKind', 'AssetKind', { k: 'null' })]), true);
        assert.equal(isNativeBalanceField('treasury', 'spend', 'amount', 'AssetBalanceOf', [a('assetKind', 'AssetKind', { k: 'enum', e: 'Native', v: null })]), true);
        assert.equal(isNativeBalanceField('treasury', 'spend', 'amount', 'AssetBalanceOf', [a('assetKind', 'AssetKind', { k: 'enum', e: 'WithId', v: num(7, 'u32') })]), false);
        assert.equal(isNativeBalanceField('treasury', 'spend', 'amount', 'AssetBalanceOf', []), false);
        assert.equal(isNativeBalanceField('x', 'y', 'amount', 'AssetBalanceOf', []), false);
    });
});

describe('renderCallHtml: the CEO case, treasury.spend', () => {
    const spend = () => real(ex.treasury.spend(null, 50_000n * PDEX, { Id: A }, null));

    test('the amount reads 50,000 PDEX with the exact planck value on hover and in a muted line', () => {
        const html = renderCallHtml(spend(), {});
        assert.match(html, /50,000 PDEX/);
        assert.match(html, /title="50000000000000000 planck"/);
        assert.match(html, /<span class="[^"]*ca-raw[^"]*">[^<]*50000000000000000 planck[^<]*<\/span>/);
        assert.doesNotMatch(html.replace(/title="[^"]*"/g, '').replace(/<span class="[^"]*ca-raw[^"]*">[^<]*<\/span>/g, ''), /50000000000000000/);
    });

    test('the beneficiary is a link to the account, with the name when one is known', () => {
        const plain = renderCallHtml(spend(), {});
        assert.match(plain, new RegExp(`href="/account/${A}"`));
        const named = renderCallHtml(spend(), { nameOf: (x) => (x === A ? 'Treasury <Fund>' : null) });
        assert.match(named, /Treasury &lt;Fund&gt;/);
        assert.doesNotMatch(named, /Treasury <Fund>/);
    });

    test('valid-from: none says so; a block shows #N and an estimated date from the head', () => {
        assert.match(renderCallHtml(spend(), {}), /none/i);
        const t = real(ex.treasury.spend(null, 5n, { Id: A }, 1_000_100));
        const html = renderCallHtml(t, { head: 1_000_000, blockMs: 12000, now: Date.UTC(2026, 10, 11, 12, 0, 0), fmtDate: (ms) => `D${ms}` });
        assert.match(html, /#1,000,100/);
        assert.match(html, new RegExp(`~D${Date.UTC(2026, 10, 11, 12, 0, 0) + 100 * 12000}`));
        const noHead = renderCallHtml(t, {});
        assert.match(noHead, /#1,000,100/);
        assert.doesNotMatch(noHead, /~/);
    });

    test('a past block is "~date" too', () => {
        const t = real(ex.treasury.spend(null, 5n, { Id: A }, 900));
        const html = renderCallHtml(t, { head: 1000, blockMs: 1000, now: 1_000_000, fmtDate: (ms) => `D${ms}` });
        assert.match(html, /#900/);
        assert.match(html, /~D900000/);
    });

    test('the call name and the argument names are shown, and the raw JSON stays one click away', () => {
        const html = renderCallHtml(spend(), {});
        assert.match(html, /treasury\.spend/);
        for (const n of ['assetKind', 'amount', 'beneficiary', 'validFrom']) assert.match(html, new RegExp(`<code>${n}</code>`));
        assert.match(html, /<details class="ca-raw-view">\s*<summary>[^<]*raw[^<]*<\/summary>\s*<pre/i);
    });
});

describe('renderCallHtml: other calls', () => {
    test('balances.transferKeepAlive and staking.bond', () => {
        assert.match(renderCallHtml(real(ex.balances.transferKeepAlive(A, 12_345_678n * 10n ** 5n)), {}), /1,234.5678 PDEX/);
        assert.match(renderCallHtml(real(ex.staking.bond(2_500n * PDEX, 'Staked')), {}), /2,500 PDEX/);
    });

    test('nested utility.batch: every inner amount is formatted, inner call names shown', () => {
        const html = renderCallHtml(real(ex.utility.batch([ex.balances.transferKeepAlive(A, 3n * PDEX), ex.balances.transferKeepAlive(B, PDEX / 2n)])), {});
        assert.match(html, /3 PDEX/);
        assert.match(html, /0\.5 PDEX/);
        assert.equal((html.match(/balances\.transferKeepAlive/g) || []).length, 2);
    });

    test('proxy.proxy, sudo-style single wrappers and council.propose recurse', () => {
        const proxy = renderCallHtml(real(ex.proxy.proxy(A, null, ex.balances.transferKeepAlive(B, 9n * PDEX))), {});
        assert.match(proxy, /9 PDEX/);
        const prop = renderCallHtml(real(ex.council.propose(3, ex.treasury.spend(null, 7n * PDEX, { Id: A }, null), 40)), {});
        assert.match(prop, /7 PDEX/);
        assert.match(prop, /<code>lengthBound<\/code>/);
        assert.doesNotMatch(prop, /40 PDEX/);
        assert.doesNotMatch(prop, /3 PDEX/);
    });

    test('a democracy external proposal wrapping a call', () => {
        const inner = ex.treasury.spend(null, 100n * PDEX, { Id: A }, null);
        const html = renderCallHtml(real(ex.democracy.externalProposeMajority({ Inline: inner.toHex() })), {});
        assert.match(html, /treasury\.spend/);
        assert.match(html, /100 PDEX/);
    });

    test('a Lookup (hash only) shows a shortened hash with a copy control holding the full one', () => {
        const hash = '0x' + 'ab'.repeat(32);
        const html = renderCallHtml(real(ex.democracy.externalProposeMajority({ Lookup: { hash, len: 40 } })), {});
        assert.match(html, /0xabab…abab/);
        assert.match(html, new RegExp(`data-ca-copy="${hash}"`));
    });
});

describe('renderCallHtml: type rules', () => {
    test('asset amounts use the asset decimals and symbol when the asset is known', () => {
        const t = real(ex.assets.transfer(7n, { Id: A }, 1_500_000n));
        const html = renderCallHtml(t, { assets: { 7: { symbol: 'USDT', decimals: 6 } } });
        assert.match(html, /1\.5 USDT/);
        assert.doesNotMatch(html, /PDEX/);
        assert.match(html, /title="1500000 units"/);
    });

    test('an asset amount with no asset info is raw with "units", never PDEX', () => {
        const html = renderCallHtml(real(ex.assets.transfer(7n, { Id: A }, 1_500_000n)), {});
        assert.match(html, /1500000 units/);
        assert.doesNotMatch(html, /PDEX/);
    });

    test('a u128 that is not a balance stays raw, as does a u128 inside a struct', () => {
        const big = '12345678901234567890';
        const t = mk('foo', 'bar', [
            a('id', 'AssetIdParameter', num(big, 'Compact<u128>')),
            a('data', 'Foo', { k: 'struct', t: 'Foo', v: { amount: num(big) } })
        ]);
        const html = renderCallHtml(t, {});
        assert.match(html, new RegExp(`>${big}<`));
        assert.doesNotMatch(html, /PDEX|units/);
        assert.doesNotMatch(html, /12,345/);
    });

    test('Perbill, Percent and Permill are percentages', () => {
        const html = renderCallHtml(mk('staking', 'setx', [
            a('a', 'Perbill', num('250000000', 'Perbill')), a('b', 'Percent', num('7', 'Percent')), a('c', 'Permill', num('5000', 'Permill'))
        ]), {});
        assert.match(html, /25%/);
        assert.match(html, /7%/);
        assert.match(html, /0\.5%/);
    });

    test('Moment is a date, bool and enums are words', () => {
        const html = renderCallHtml(mk('timestamp', 'set', [
            a('now', 'Moment', num('1700000000000', 'Compact<u64>')),
            a('flag', 'bool', { k: 'bool', v: true }),
            a('mode', 'Mode', { k: 'enum', t: 'Enum', e: 'Fast', v: null })
        ]), { fmtDate: (ms) => `D${ms}` });
        assert.match(html, /D1700000000000/);
        assert.match(html, /Yes/);
        assert.match(html, /Fast/);
    });

    test('a count or index keeps its plain number', () => {
        const html = renderCallHtml(mk('council', 'vote', [a('index', 'ProposalIndex', num('142', 'Compact<u32>'))]), {});
        assert.match(html, />142</);
        assert.doesNotMatch(html, /PDEX|#142/);
    });

    test('hashes: shortened, full value in the copy control and title', () => {
        const h = '0x' + '12'.repeat(32);
        assert.equal(shortHash(h), '0x1212…1212');
        assert.equal(shortHash('0x1234'), '0x1234');
        const html = renderCallHtml(mk('x', 'y', [a('hash', 'H256', { k: 'hex', v: h })]), {});
        assert.match(html, new RegExp(`data-ca-copy="${h}"`));
        assert.match(html, /<button type="button"[^>]*>Copy<\/button>/);
    });
});

describe('renderCallHtml: escaping and legacy input', () => {
    const evil = '<img src=x onerror=alert(1)>';
    test('decoded strings, argument names, section names, labels and hashes are escaped', () => {
        const t = mk(evil, '"><script>1</script>', [
            a(evil, evil, { k: 'text', v: evil }),
            a('who', 'AccountId', { k: 'acct', v: evil }),
            a('h', 'H256', { k: 'hex', v: evil }),
            a('e', 'E', { k: 'enum', e: evil, v: { k: 'raw', v: evil } }),
            a('s', 'S', { k: 'struct', v: { [evil]: { k: 'text', v: evil } } })
        ]);
        const html = renderCallHtml(t, { nameOf: () => evil });
        assert.doesNotMatch(html, /<img/i);
        assert.doesNotMatch(html, /<script/i);
        assert.doesNotMatch(html, /onerror=alert\(1\)>/);
        assert.match(html, /&lt;img/);
    });

    test('the raw JSON view is escaped too', () => {
        const html = renderCallHtml(mk('a', 'b', [a('t', 'Text', { k: 'text', v: evil })]), {});
        assert.doesNotMatch(html, /<img/i);
    });

    test('arguments without a typed node (older data) render their value as escaped text', () => {
        const html = renderCallHtml({ section: 'x', method: 'y', args: [{ name: 'amount', value: '1000000000000' }, { name: 'n', value: evil }] }, {});
        assert.match(html, /1000000000000/);
        assert.doesNotMatch(html, /PDEX/);
        assert.doesNotMatch(html, /<img/i);
    });

    test('no call, no html', () => {
        assert.equal(renderCallHtml(null, {}), '');
        assert.equal(renderCallHtml({}, {}), '');
    });
});

describe('summary text and raw JSON', () => {
    test('callSummaryText: one line with the human amount, for meta descriptions and titles', () => {
        const s = callSummaryText(real(ex.treasury.spend(null, 50_000n * PDEX, { Id: A }, null)), {});
        assert.match(s, /^treasury\.spend/);
        assert.match(s, /50,000 PDEX/);
        assert.match(s, new RegExp(A.slice(0, 6)));
        assert.doesNotMatch(s, /50000000000000000/);
    });
    test('callSummaryText sums up a batch by its inner calls', () => {
        const s = callSummaryText(real(ex.utility.batch([ex.balances.transferKeepAlive(A, PDEX), ex.balances.transferKeepAlive(B, 2n * PDEX)])), {});
        assert.match(s, /utility\.batch/);
        assert.match(s, /1 PDEX/);
        assert.match(s, /2 PDEX/);
    });
    test('callSummaryText of nothing is empty and never throws', () => {
        assert.equal(callSummaryText(null, {}), '');
        assert.equal(callSummaryText({ section: 'a', method: 'b', args: [{ name: 'x', value: '1' }] }, {}), 'a.b');
    });
    test('rawCallJson is the machine form: names and exact planck strings, valid JSON', () => {
        const j = JSON.parse(rawCallJson(real(ex.treasury.spend(null, 50_000n * PDEX, { Id: A }, null))));
        assert.equal(j.section, 'treasury');
        assert.equal(j.method, 'spend');
        const amount = j.args.find(x => x.name === 'amount');
        assert.equal(amount.value, '50000000000000000');
    });
});
