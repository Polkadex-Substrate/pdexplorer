// The wallet stake picker printed "0.0000 PDEX" for every validator while
// /api/validators said stakeDataOk false; the validator list already showed
// "unavailable". Both now go through lib/stake-display.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { validatorsWithStakeState, pickerStakeText } from '../lib/stake-display.js';
import { loadPickerData, validatorRowHtml, CHOICE_URL, FALLBACK_URL } from '../lib/stake-picker-view.js';

const fmt = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const esc = (s) => String(s);
const zeroPayload = { stakeDataOk: false, status: 'Degraded', validators: [{ address: 'a', totalStake: 0, commission: 5 }, { address: 'b', totalStake: 0, commission: 5 }] };

test('stakeDataOk false: every totalStake becomes null and is flagged', () => {
    const out = validatorsWithStakeState(zeroPayload);
    assert.deepEqual(out.map(v => v.totalStake), [null, null]);
    assert.deepEqual(out.map(v => v.stakeUnavailable), [true, true]);
    assert.deepEqual(out.map(v => v.address), ['a', 'b']);
});

test('stakeDataOk true or absent: stake kept, input not mutated', () => {
    const data = { validators: [{ address: 'a', totalStake: 12 }] };
    const out = validatorsWithStakeState(data);
    assert.equal(out[0].totalStake, 12);
    assert.equal(out[0].stakeUnavailable, undefined);
    assert.notEqual(out, data.validators);
    assert.equal(validatorsWithStakeState({ stakeDataOk: true, validators: [{ totalStake: 0 }] })[0].totalStake, 0);
    assert.deepEqual(validatorsWithStakeState(null), []);
    assert.deepEqual(validatorsWithStakeState({}), []);
});

test('picker text: unavailable vs no stake this era vs a number', () => {
    assert.equal(pickerStakeText({ totalStake: null, stakeUnavailable: true }, fmt), 'stake unavailable');
    assert.equal(pickerStakeText({ totalStake: null }, fmt), 'no stake this era');
    assert.equal(pickerStakeText({ totalStake: 0 }, fmt), '0.0000 PDEX');
    assert.equal(pickerStakeText({ totalStake: 1234.5 }, fmt), '1,234.5000 PDEX');
});

test('picker on the /api/validators fallback with stakeDataOk false shows "stake unavailable"', async () => {
    const data = await loadPickerData(async (url) => {
        if (url === CHOICE_URL) return { validators: [], status: 'Initializing' };
        assert.equal(url, FALLBACK_URL);
        return zeroPayload;
    });
    assert.deepEqual(data.validators.map(v => v.totalStake), [null, null]);
    const html = validatorRowHtml(data.validators[0], { esc, shortAddress: (a) => a });
    assert.match(html, /stake unavailable/);
    assert.ok(!/0(\.0+)? PDEX/.test(html), html);
});

test('picker on the snapshot honours stakeDataOk false too', async () => {
    const data = await loadPickerData(async () => zeroPayload);
    assert.equal(data.meta.full, true);
    assert.deepEqual(data.validators.map(v => v.stakeUnavailable), [true, true]);
});

test('script.js: the validator list uses the shared rule', () => {
    const src = readRepo('script.js', import.meta.url);
    const fetchList = stripComments(bodyOf(src, 'fetchValidators'));
    assert.match(fetchList, /currentValidators = validatorsWithStakeState\(data\)/);
    const picker = stripComments(bodyOf(src, 'loadValidatorsForPicker'));
    assert.match(picker, /loadPickerData\(/);
});
