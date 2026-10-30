// verify-deploy.sh's zero-stake check failed the first run after every deploy:
// the payload it judged was still the last sync of the OLD code. It now only
// judges a validator sync that ran after the deploy (or backend) started.
// These tests run the real embedded python block from the script.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readRepo } from './helpers/source.js';

const script = readRepo('tools/verify-deploy.sh', import.meta.url);
const marker = 'pycheck "validator total stake is not all zero (spec 392 exposure read)"';
const at = script.indexOf(marker);
const bodyStart = script.indexOf("<<'PY'\n", at) + "<<'PY'\n".length;
const block = script.slice(bodyStart, script.indexOf('\nPY\n', bodyStart));
const hasPython = spawnSync('python3', ['--version']).status === 0;

function run(payload, startRaw) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-stake-'));
    const f = path.join(dir, 'vals.json');
    fs.writeFileSync(f, JSON.stringify(payload));
    const r = spawnSync('python3', ['-', f, startRaw], { input: block, encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const START = Date.parse('2026-10-30T06:00:00Z');
const zero = (lastSync, stakeDataOk = false) => ({ lastSync, stakeDataOk, validators: [{ address: 'a', totalStake: 0 }, { address: 'b', totalStake: 0 }] });
const good = (lastSync) => ({ lastSync, stakeDataOk: true, validators: [{ address: 'a', totalStake: 10 }] });

describe('verify-deploy zero-stake check timing', { skip: hasPython ? false : 'python3 not installed' }, () => {
    test('the script passes the deploy start to the block', () => {
        assert.ok(at > 0 && block.length > 100);
        assert.match(script.slice(at, bodyStart), /"\$DEPLOY_START_RAW"/);
        assert.match(script, /docker inspect -f '\{\{\.State\.StartedAt\}\}' pdexplorer-backend/);
    });

    test('pre-deploy all-zero rows do not fail the first run', () => {
        const r = run(zero(START - 60_000), String(START));
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /WAIT/);
    });

    test('all-zero after the deploy started fails', () => {
        const r = run(zero(START + 60_000), String(START));
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /every validator reports totalStake 0/);
    });

    test('stakeDataOk false after the deploy started fails', () => {
        const r = run({ ...good(START + 1), stakeDataOk: false }, String(START));
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /zero-stake guard fired/);
    });

    test('docker StartedAt with nanoseconds is understood', () => {
        assert.equal(run(zero(START - 1), '2026-10-30T06:00:00.123456789Z').code, 0);
        assert.equal(run(zero(START + 1000), '2026-10-30T06:00:00.123456789Z').code, 1);
    });

    test('epoch seconds are understood', () => {
        assert.equal(run(zero(START - 1000), String(START / 1000)).code, 0);
        assert.equal(run(zero(START + 1000), String(START / 1000)).code, 1);
    });

    test('unknown start stays strict (the old behaviour)', () => {
        assert.equal(run(zero(START - 60_000), '').code, 1);
        assert.equal(run(zero(START - 60_000), '0001-01-01T00:00:00Z').code, 1);
    });

    test('healthy stake after the deploy passes', () => {
        const r = run(good(START + 60_000), String(START));
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /PASS/);
    });
});
