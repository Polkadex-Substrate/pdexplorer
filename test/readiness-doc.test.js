// docs/392-readiness.md must keep the rollback truth and the gate order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = readFileSync(new URL('../docs/392-readiness.md', import.meta.url), 'utf8');
const flat = doc.replace(/\s+/g, ' ');

test('rollback is stated as valid only before enactment, fix forward after', () => {
    assert.match(flat, /Rollback to the previous image is valid ONLY before mainnet enacts 392/);
    assert.match(flat, /10\.13\.1, which cannot decode blocks produced under 392/);
    assert.match(flat, /the only path is fix forward/);
});

test('new scan_failures keys are documented as inert to the old code', () => {
    assert.match(flat, /`extrinsic_decode:<index>` and `block_decode_recovered`\) are inert to the old code/);
});

test('deploy gate comes before the wallet extras and carries the deadline', () => {
    const gate = doc.indexOf('## Gate to deploy this branch to the mainnet explorer');
    const rollback = doc.indexOf('## Rollback');
    assert.ok(gate > 0 && rollback > gate);
    assert.match(flat, /live and healthy on the mainnet explorer BEFORE the referendum enacts 392/);
    const list = doc.slice(doc.indexOf('## Mainnet checklist'), rollback);
    const at = (needle) => { const i = list.indexOf(needle); assert.ok(i >= 0, needle); return i; };
    assert.ok(at('fetch-metadata.mjs') < at('Deploy this build to mainnet'));
    assert.ok(at('polkadot{.js} extension: one transfer') < at('Deploy this build to mainnet'));
    assert.ok(at('Deploy this build to mainnet') < at('Talisman and SubWallet'));
    assert.ok(at('Talisman and SubWallet') < at('Nova Wallet in-app browser, one balance transfer'));
    assert.match(flat, /drops Polkadex staking on 25 Oct/);
});

test('no em or en dashes, ASCII only', () => {
    assert.doesNotMatch(doc, /[^\x00-\x7F]/);
});
