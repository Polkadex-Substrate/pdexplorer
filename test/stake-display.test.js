// The wallet stake picker printed "0.0000 PDEX" for every validator while
// /api/validators said stakeDataOk false; the validator list already showed
// "unavailable". Both now go through lib/stake-display.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { validatorsWithStakeState, stakeMetaText } from '../lib/stake-display.js';

const fmt = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

test('stakeDataOk false: every totalStake becomes null', () => {
    const out = validatorsWithStakeState({ stakeDataOk: false, validators: [{ address: 'a', totalStake: 0 }, { address: 'b', totalStake: 0 }] });
    assert.deepEqual(out.map(v => v.totalStake), [null, null]);
    assert.deepEqual(out.map(v => v.address), ['a', 'b']);
});

test('stakeDataOk true or absent: stake kept, input not mutated', () => {
    const data = { validators: [{ address: 'a', totalStake: 12 }] };
    const out = validatorsWithStakeState(data);
    assert.equal(out[0].totalStake, 12);
    assert.notEqual(out, data.validators);
    assert.equal(validatorsWithStakeState({ stakeDataOk: true, validators: [{ totalStake: 0 }] })[0].totalStake, 0);
    assert.deepEqual(validatorsWithStakeState(null), []);
    assert.deepEqual(validatorsWithStakeState({}), []);
});

test('picker text: unavailable, never 0.0000 PDEX, for a null stake', () => {
    assert.equal(stakeMetaText(null, fmt), 'stake unavailable');
    assert.equal(stakeMetaText(undefined, fmt), 'stake unavailable');
    assert.equal(stakeMetaText(0, fmt), '0.0000 PDEX');
    assert.equal(stakeMetaText(1234.5, fmt), '1,234.5000 PDEX');
});

test('script.js: the picker and the list both use the shared rule', () => {
    const src = readRepo('script.js', import.meta.url);
    const picker = stripComments(bodyOf(src, 'loadValidatorsForPicker'));
    assert.match(picker, /validatorsCache = validatorsWithStakeState\(data\)/);
    const list = stripComments(bodyOf(src, 'renderStakeValidatorList'));
    assert.match(list, /stakeMetaText\(v\.totalStake, stakingFormatPDEX\)/);
    assert.ok(!/stakingFormatPDEX\(v\.totalStake\)/.test(list), 'picker still formats a null stake as 0.0000 PDEX');
    const fetchList = stripComments(bodyOf(src, 'fetchValidators'));
    assert.match(fetchList, /currentValidators = validatorsWithStakeState\(data\)/);
});
