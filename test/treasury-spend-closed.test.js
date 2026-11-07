// Treasury spending from the explorer, after runtime 392.
//
// Up to 373 the Treasury page had a "Submit proposal" form that signed
// treasury.proposeSpend(value, beneficiary) and reserved a proposal bond.
// Runtime 392 (pallet-treasury 44.0.0) removed propose_spend, approve_proposal
// and reject_proposal; the only ways to create a spend are treasury.spend and
// treasury.spend_local, and both start with T::SpendOrigin::ensure_origin.
// The Polkadex runtime sets SpendOrigin = NeverEnsureOrigin<u128>
// (polkadex-node runtimes/mainnet/src/lib.rs, impl pallet_treasury::Config),
// which refuses every origin: signed, council motion, and Root alike. So the
// old form fails on every node, and a council-motion replacement would table
// motions whose execution can only end in BadOrigin.
//
// These tests pin: (1) the 392/393 call surface the page depends on, from the
// metadata fixture; (2) that no proposeSpend path or proposal-bond copy is left
// in the shipped sources; (3) that the page and the help article say plainly
// that new spends are closed on this runtime.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';
import { ERROR_COPY, ACTION_KEYS, PENDING_TITLE } from '../lib/tx-status.js';
import { HELP_TOPICS } from '../lib/help-topics.js';

const fx = loadFixture('metadata-392.json');

describe('runtime 392/393 treasury call surface (metadata fixture)', { skip: fx ? false : 'test/fixtures/metadata-392.json not present' }, () => {
    const registry = fx ? registryFromMetadata(fx.metadata) : null;
    const pallet = fx ? registry.metadata.pallets.find(p => p.name.toString() === 'Treasury') : null;
    const calls = () => registry.lookup.getSiType(pallet.calls.unwrap().type).def.asVariant.variants;
    const call = (name) => calls().find(v => v.name.toString() === name);
    const argTypes = (name) => call(name).fields.map(f => [f.name.toString(), registry.createLookupType(f.type), JSON.stringify(registry.lookup.getTypeDef(f.type).type)]);

    test('the fixture is a 392-or-later runtime', () => {
        assert.ok(fx.specVersion >= 392, `fixture is spec ${fx.specVersion}`);
    });

    test('propose_spend, approve_proposal and reject_proposal are gone', () => {
        for (const gone of ['propose_spend', 'approve_proposal', 'reject_proposal']) {
            assert.equal(call(gone), undefined, `${gone} is still in the metadata`);
        }
    });

    test('spend has asset_kind (unit), amount, beneficiary, valid_from; spend_local and payout exist', () => {
        const spend = argTypes('spend');
        assert.deepEqual(spend.map(a => a[0]), ['asset_kind', 'amount', 'beneficiary', 'valid_from']);
        assert.equal(spend[0][2], '"Null"', 'AssetKind = () on Polkadex');
        assert.equal(spend[1][2], '"Compact<u128>"');
        assert.equal(spend[2][2], '"MultiAddress"');
        assert.equal(spend[3][2], '"Option<u32>"');
        assert.deepEqual(argTypes('spend_local').map(a => [a[0], a[2]]), [['amount', '"Compact<u128>"'], ['beneficiary', '"MultiAddress"']]);
        assert.deepEqual(argTypes('payout').map(a => [a[0], a[2]]), [['index', '"u32"']]);
        assert.ok(call('check_status') && call('void_spend'));
    });

    test('no proposal bond: the ProposalBond constants and InsufficientProposersBalance error are gone', () => {
        const consts = pallet.constants.map(c => c.name.toString());
        for (const c of ['ProposalBond', 'ProposalBondMinimum', 'ProposalBondMaximum']) assert.ok(!consts.includes(c), `${c} still present`);
        const errors = registry.lookup.getSiType(pallet.errors.unwrap().type).def.asVariant.variants.map(v => v.name.toString());
        assert.ok(!errors.includes('InsufficientProposersBalance'));
        assert.ok(errors.includes('InsufficientPermission'), 'spend/spend_local still check SpendOrigin');
    });
});

describe('no proposeSpend path is left in the shipped sources', () => {
    const libFiles = readdirSync(new URL('../lib/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `lib/${f}`);
    const files = ['script.js', 'index.html', 'server.js', ...libFiles];
    const BANNED = [/proposeSpend/, /propose_spend/, /submitTreasuryProposal/, /openTreasurySubmitModal/, /treasury-submit-modal/, /treasury-submit-btn/, /submit-treasury-tx-btn/];

    for (const file of files) {
        test(`${file} has no proposeSpend, no submit-proposal form`, () => {
            const src = stripComments(readRepo(file, import.meta.url));
            for (const rx of BANNED) assert.doesNotMatch(src, rx, `${file} still matches ${rx}`);
        });
    }
});

describe('no proposal-bond copy', () => {
    test('tx-status has no treasury.propose action and no proposal-bond error text', () => {
        assert.ok(!ACTION_KEYS.includes('treasury.propose'));
        assert.ok(!('treasury.propose' in PENDING_TITLE));
        assert.ok(!('treasury.InsufficientProposersBalance' in ERROR_COPY));
        assert.doesNotMatch(Object.values(ERROR_COPY).join(' '), /proposal bond/i);
    });

    test('index.html no longer promises a reserved proposal bond', () => {
        const html = readRepo('index.html', import.meta.url);
        assert.doesNotMatch(html, /Submit Treasury Proposal/);
        assert.doesNotMatch(html, /A bond is reserved from your account/);
    });
});

describe('the page and the help say new spends are closed', () => {
    const topic = HELP_TOPICS.find(t => t.slug === 'treasury');

    test('help article: no Submit proposal button, no burnt deposit, says why spends are closed', () => {
        assert.ok(topic, 'treasury help topic missing');
        assert.doesNotMatch(topic.body, /Submit proposal/);
        assert.doesNotMatch(topic.body, /deposit is required|burn the deposit/i);
        assert.match(topic.body, /treasury\.spend/);
        assert.match(topic.body, /SpendOrigin/);
        assert.match(topic.body, /runtime upgrade/i);
        assert.match(topic.keywords, /spend/);
    });

    test('Treasury header shows a closed-spends note with a help icon instead of the form button', () => {
        const script = stripComments(readRepo('script.js', import.meta.url));
        const fn = script.slice(script.indexOf('function renderTreasury()'), script.indexOf('function governanceIndexNote'));
        assert.ok(fn.length > 0);
        assert.match(fn, /New spends closed/);
        assert.match(fn, /helpIcon\('treasury'/);
        assert.doesNotMatch(fn, /Submit proposal/);
    });
});
