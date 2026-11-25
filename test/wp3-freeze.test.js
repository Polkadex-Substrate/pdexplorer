// The Work Package 3 freeze (cto-team/plans/2026-11-21-validate-redesign-and-colour-roles.md, section 5
// and test 15 and 16 of section 8). The setup wizard, the separate steps view and the manage panel are
// money paths: the restyle may change classes, wrap markup and add decorative icons, never a word, a
// field, an action or the logic.
//
// (a) Every string the money-path modules export, and the text a person reads in every state the views
//     can render (test/helpers/wp3-world.js, the real mounts on fake chains), with the fields and the
//     data-*-action values in order, equal the snapshot test/snapshots/wp3-frozen-text.json taken on the
//     code BEFORE the restyle. The only parts left out are the ones the spec adds, by name (see
//     frozenText in the world helper).
//     (In test/snapshots/: test/fixtures/ holds only chain metadata, named by test/fixture-name.test.js.)
// (b) The pure logic modules are byte for byte the files before the restyle (SHA-256).
//
// Written and committed green on the code before WP3, and not edited after.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { collectTables, collectStates } from './helpers/wp3-freeze-collect.js';

const SNAP = JSON.parse(readFileSync(new URL('./snapshots/wp3-frozen-text.json', import.meta.url), 'utf8'));

// Where two strings first differ, so a failure says which words moved.
function firstDiff(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return `at character ${i}: snapshot "...${b.slice(Math.max(0, i - 40), i + 40)}..." now "...${a.slice(Math.max(0, i - 40), i + 40)}..."`;
}

describe('WP3 freeze (a): the words, fields and actions of every view state', () => {
    test('the exported string tables equal the snapshot', async () => {
        const now = await collectTables();
        const keys = new Set([...Object.keys(now), ...Object.keys(SNAP.tables)]);
        const bad = [...keys].filter(k => now[k] !== SNAP.tables[k]).map(k => `${k}: ${k in now ? (k in SNAP.tables ? firstDiff(now[k], SNAP.tables[k]) : 'new string') : 'string removed'}`);
        assert.deepEqual(bad, [], 'a frozen string changed:\n' + bad.join('\n'));
        assert.ok(Object.keys(SNAP.tables).length > 100, 'the snapshot holds the tables');
    });
    test('every state renders the same text, the same fields and the same actions, in order', async () => {
        const now = await collectStates();
        assert.deepEqual(Object.keys(now), Object.keys(SNAP.states), 'the same states');
        const bad = [];
        for (const [id, s] of Object.entries(SNAP.states)) {
            const n = now[id];
            if (n.text !== s.text) bad.push(`${id}: text ${firstDiff(n.text, s.text)}`);
            if (JSON.stringify(n.fields) !== JSON.stringify(s.fields)) bad.push(`${id}: fields ${JSON.stringify(s.fields)} became ${JSON.stringify(n.fields)}`);
            if (JSON.stringify(n.actions) !== JSON.stringify(s.actions)) bad.push(`${id}: actions ${JSON.stringify(s.actions)} became ${JSON.stringify(n.actions)}`);
        }
        assert.deepEqual(bad, [], 'a frozen view changed:\n' + bad.join('\n'));
        assert.ok(Object.keys(SNAP.states).length >= 80, 'the snapshot holds every state');
    });
});

// SHA-256 of each pure module as it was before WP3. A change here is not a restyle: stop and report.
const HASHED = {
    'lib/validator-setup-steps.js': '4ad3e541678fcfdd13c972b0093347cfa16ffbd7801a0c5ec01a176913f95d12',
    'lib/validator-setup.js': 'aaf17f814c6a034824d7664a8db14fe3d751633b7b71738e38b48e8a71c4a447',
    'lib/validator-setup-chain.js': '9fbe94f5721400638d7201e36ee8e6194868da0505ad9a6fc3521cab5fad1c64',
    'lib/validator-manage.js': 'cd1fc7cae7587318075e96f92d85a167343132907da23cc8248891cc4ad45c56',
    'lib/validator-manage-chain.js': 'd3de9f260db4c62f9f9e2c270f21cec8bc12bb8f74e8639761cb6243b1963019',
    'lib/validator-delegate.js': 'ecbd376003238af103bdb198e605128a0ed642ba0d3042bc5f000d3896fa0f3d',
    'lib/validator-delegate-chain.js': '8db6e24bdef45e7e3cf21268f3eea15f7d37e73b73f8eae26ad0eb198a37e701',
    'lib/tx-submit.js': '11ed4abe0df4cb4f536cfdd61c54a44cf4910b87e86ee54b4e3d618e5a5d2567',
    'lib/fee-preflight.js': '0dc171b6c86ebeaabd883554c04ddbea245374b110e1c36137ee96b055c75b27'
};
describe('WP3 freeze (b): the pure logic modules are unchanged', () => {
    for (const [file, want] of Object.entries(HASHED)) {
        test(`${file} is byte for byte the file before the restyle`, () => {
            const got = createHash('sha256').update(readFileSync(new URL('../' + file, import.meta.url))).digest('hex');
            assert.equal(got, want, `${file} changed (sha256 ${got}); the restyle may not touch it`);
        });
    }
});
