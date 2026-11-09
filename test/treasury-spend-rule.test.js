// Treasury spending from the explorer, after runtime 392.
//
// Up to 373 the Treasury page had a "Submit proposal" form that signed
// treasury.proposeSpend(value, beneficiary) and reserved a proposal bond.
// Runtime 392 (pallet-treasury 44.0.0) removed propose_spend, approve_proposal
// and reject_proposal; the only ways to create a spend are treasury.spend and
// treasury.spend_local, and both start with T::SpendOrigin::ensure_origin.
// The Polkadex runtime (polkadex-node, branch mainnet, runtimes/mainnet/src/
// lib.rs, impl pallet_treasury::Config) sets SpendOrigin to Root with no cap,
// or EnsureProportionAtLeast<_, CouncilCollective, 3, 5> with CouncilSpendCap
// (50,000 PDEX) per spend. A council motion executes as Members(ayes, seats),
// so it needs Ayes from at least three fifths of all seats.
//
// These tests pin: (1) the 392/393 call surface the page depends on, from the
// metadata fixture; (2) that no proposeSpend path or proposal-bond copy is left
// in the shipped sources; (3) that the page and the help state that rule, and
// that no copy of the old "spends are closed" claim is left.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';
import { ERROR_COPY, ACTION_KEYS, PENDING_TITLE } from '../lib/tx-status.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { COUNCIL_SPEND_CAP_PDEX, SPEND_RULE_TEXT } from '../lib/treasury-spend.js';

const fx = loadFixture('metadata-392.json');
const libFiles = readdirSync(new URL('../lib/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `lib/${f}`);

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
        assert.ok(errors.includes('InsufficientPermission'), 'spend/spend_local still check the amount against the SpendOrigin cap');
    });
});

describe('no proposeSpend path is left in the shipped sources', () => {
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

describe('the page and the help state who can spend', () => {
    const topic = (slug) => HELP_TOPICS.find(t => t.slug === slug);
    const RULE = [/at least three fifths of all council seats/, /up to 50,000 PDEX per spend/, /referendum/];
    const CLOSED = /spends are closed|spends closed|accepts no caller|no caller at all|needs a runtime upgrade|could never execute|origin the runtime does not grant/i;

    test('treasury help: a council motion with three fifths of the seats up to 50,000 PDEX, or a referendum with no cap', () => {
        const t = topic('treasury');
        assert.ok(t, 'treasury help topic missing');
        for (const rx of RULE) assert.match(t.body, rx);
        assert.match(t.body, /treasury\.spend/);
        assert.match(t.body, /SpendOrigin/);
        assert.match(t.body, /no cap/);
        assert.match(t.body, /fails as not allowed/, 'says what happens to a motion that passes its own threshold with too few Ayes');
        assert.doesNotMatch(t.body, CLOSED);
        assert.doesNotMatch(t.body, /Submit proposal/);
        assert.doesNotMatch(t.body, /deposit is required|burn the deposit/i);
        assert.match(t.keywords, /spend/);
        assert.doesNotMatch(t.keywords, /closed/);
    });

    test('council help: a spend motion executes under the same rule and links the treasury article', () => {
        const t = topic('council-and-motions');
        assert.doesNotMatch(t.body, CLOSED);
        assert.match(t.body, /at least three fifths of all council seats/);
        assert.match(t.body, /50,000 PDEX/);
        assert.match(t.body, /href="\/help\/treasury"/);
    });

    test('Treasury header states the rule in a few words, with a help icon', () => {
        assert.equal(SPEND_RULE_TEXT, 'Spends by council motion (at least 3/5 of seats, up to 50,000 PDEX) or referendum');
        const script = stripComments(readRepo('script.js', import.meta.url));
        const fn = script.slice(script.indexOf('function renderTreasury()'), script.indexOf('function governanceIndexNote'));
        assert.ok(fn.length > 0);
        assert.match(fn, /\$\{SPEND_RULE_TEXT\} \$\{helpIcon\('treasury', 'Who can spend from the treasury'\)\}/);
        assert.doesNotMatch(fn, /New spends closed|takes no new spends|Submit proposal/);
    });

    test('the cap is one named constant whose comment names CouncilSpendCap on the mainnet branch', () => {
        assert.equal(COUNCIL_SPEND_CAP_PDEX, 50000);
        const src = readRepo('lib/treasury-spend.js', import.meta.url);
        assert.match(src, /CouncilSpendCap/);
        assert.match(src, /branch mainnet/);
    });

    test('a council motion that fails with BadOrigin is explained by the spend rule', () => {
        const text = ERROR_COPY['system.BadOrigin'];
        assert.match(text, /at least three fifths of all council seats/);
        assert.doesNotMatch(text, /more than half/);
    });
});

describe('no copy of the old spend and lock claims is left', () => {
    const OLD = /NeverEnsureOrigin|admits no origin|accepts no caller|spends closed|takes no new spends|32 eras|eras after the referendum|post-enactment lock|lock period after enactment|Lock starts only after the referendum passes/i;
    for (const file of ['script.js', 'index.html', 'server.js', 'README.md', 'test/motion-templates.test.js', ...libFiles]) {
        test(`${file}, comments included`, () => {
            assert.doesNotMatch(readRepo(file, import.meta.url), OLD);
        });
    }
});
