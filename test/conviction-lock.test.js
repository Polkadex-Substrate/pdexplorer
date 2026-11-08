// The conviction lock a referendum vote takes, as the vote form, the help and
// the status card state it.
//
// Pallet facts (pallet-democracy as vendored in polkadex-node, branch mainnet):
//   - conviction.rs lock_periods: None 0, Locked1x..6x 1, 2, 4, 8, 16, 32;
//   - vote.rs locked_if: only a Standard vote on the winning side stays locked;
//   - lib.rs: unlock_at = end + VoteLockingPeriod x lock periods, where end is
//     the referendum's end, so a nay vote on a referendum that fails is locked
//     too, and nothing waits for enactment;
//   - VoteLockingPeriod is 30 days of 12 s blocks (216,000) in the runtime.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ApiPromise } from '@polkadot/api';
import { lockPeriodDays, convictionLabel, labelConvictions } from '../lib/conviction-lock.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { loadFixture } from './helpers/extrinsic-builders.js';
import { mockProvider } from './helpers/mock-provider.js';

const CONVICTIONS = ['None', 'Locked1x', 'Locked2x', 'Locked3x', 'Locked4x', 'Locked5x', 'Locked6x'];
const apiWith = (democracy) => ({ consts: { democracy } });

describe('one lock period, from the chain', () => {
    test('VoteLockingPeriod at the explorer block time (12 s), in days', () => {
        assert.equal(lockPeriodDays(apiWith({ voteLockingPeriod: 216000 })), 30);
        assert.equal(lockPeriodDays(apiWith({ voteLockingPeriod: { toString: () => '7200' } })), 1, 'a u32 codec');
    });
    test('null while the constant is not loaded', () => {
        for (const api of [null, undefined, {}, { consts: {} }, apiWith({}), apiWith({ voteLockingPeriod: 0 })]) {
            assert.equal(lockPeriodDays(api), null);
        }
    });
});

describe('conviction labels', () => {
    test('each conviction in days once the period is known; only the winning side is locked', () => {
        assert.deepEqual(CONVICTIONS.map(c => convictionLabel(c, 30)), [
            '0.1× weight, no lock',
            '1× weight, locked 30 days if your side wins',
            '2× weight, locked 60 days if your side wins',
            '3× weight, locked 120 days if your side wins',
            '4× weight, locked 240 days if your side wins',
            '5× weight, locked 480 days if your side wins',
            '6× weight, locked 960 days if your side wins'
        ]);
    });
    test('lock periods when the constant is not loaded', () => {
        assert.deepEqual(CONVICTIONS.map(c => convictionLabel(c, null)), [
            '0.1× weight, no lock',
            '1× weight, locked 1 lock period if your side wins',
            '2× weight, locked 2 lock periods if your side wins',
            '3× weight, locked 4 lock periods if your side wins',
            '4× weight, locked 8 lock periods if your side wins',
            '5× weight, locked 16 lock periods if your side wins',
            '6× weight, locked 32 lock periods if your side wins'
        ]);
    });
});

describe('the referendum vote form', () => {
    const html = readRepo('index.html', import.meta.url);
    const form = html.slice(html.indexOf('id="referendum-vote-modal"'), html.indexOf('<!-- Stake / Nominate Modal -->'));
    const options = () => [...form.matchAll(/<option value="(\w+)"[^>]*>([^<]*)<\/option>/g)].map(m => ({ value: m[1], textContent: m[2] }));

    test('the shipped labels are the fallback, in lock periods', () => {
        assert.deepEqual(options().map(o => o.value), CONVICTIONS);
        for (const o of options()) assert.equal(o.textContent, convictionLabel(o.value, null));
    });
    test('relabelled in days when the constant is loaded, and back to lock periods when it is not', () => {
        const select = { options: options() };
        labelConvictions(select, 30);
        assert.deepEqual(select.options.map(o => o.textContent), CONVICTIONS.map(c => convictionLabel(c, 30)));
        labelConvictions(select, null);
        assert.deepEqual(select.options.map(o => o.textContent), CONVICTIONS.map(c => convictionLabel(c, null)));
        assert.doesNotThrow(() => labelConvictions(null, 30));
    });
    test('the text says winning side only, counted from the referendum end', () => {
        assert.doesNotMatch(form, /Lock starts only after the referendum passes|failed votes don't extend|after enactment/);
        assert.match(form, /only the winning side/);
        assert.match(form, /counted from the referendum's end/);
        assert.match(form, /VoteLockingPeriod/);
    });
    test('script.js relabels on open, and the status card reads the same helper', () => {
        const script = stripComments(readRepo('script.js', import.meta.url));
        assert.match(script, /from '\.\/lib\/conviction-lock\.js'/);
        assert.match(bodyOf(script, 'openReferendumVoteModal'), /labelConvictions\(conv, lockPeriodDays\(globalApi\)\)/);
        assert.match(bodyOf(script, 'submitReferendumVote'), /lockPeriodDays: lockPeriodDays\(globalApi\)/);
        assert.doesNotMatch(script, /voteLockingPeriod\) \* 12/, 'one helper computes the period');
    });
});

describe('help and glossary', () => {
    test('democracy help: lock periods of VoteLockingPeriod, 30 days now, winning side, from the end', () => {
        const t = HELP_TOPICS.find(x => x.slug === 'democracy-and-voting');
        assert.doesNotMatch(t.body, /eras/);
        assert.match(t.body, /1, 2, 4, 8, 16 or 32 lock periods/);
        assert.match(t.body, /<code>VoteLockingPeriod<\/code>, 30 days on mainnet now/);
        assert.match(t.body, /960 days/);
        assert.match(t.body, /only if your side wins/);
        assert.match(t.body, /counted from the referendum's end/);
    });
    test('the conviction glossary entry counts the lock from the referendum end', () => {
        const script = readRepo('script.js', import.meta.url);
        const glossary = script.slice(script.indexOf('const GLOSSARY = {'));
        const entry = glossary.slice(glossary.indexOf('    conviction:'), glossary.indexOf('    motion:'));
        assert.match(entry, /^ {4}conviction: /);
        assert.doesNotMatch(entry, /enactment/);
        assert.match(entry, /after the referendum ends, if your side wins/);
    });
});

const fx = loadFixture('metadata-392.json');
describe('a real ApiPromise on the spec metadata', { skip: fx ? false : 'test/fixtures/metadata-392.json not present' }, () => {
    test('democracy.voteLockingPeriod is one lock period of 30 days', async () => {
        const m = mockProvider({ metadataHex: fx.metadata, specVersion: fx.specVersion });
        const api = await ApiPromise.create({ provider: m.provider, noInitWarn: true });
        try {
            assert.equal(lockPeriodDays(api), 30);
            assert.equal(convictionLabel('Locked6x', lockPeriodDays(api)), '6× weight, locked 960 days if your side wins');
        } finally { await api.disconnect(); }
    });
});
