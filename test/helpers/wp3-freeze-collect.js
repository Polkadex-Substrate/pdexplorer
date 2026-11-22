// The two collectors behind the WP3 freeze (test/wp3-freeze.test.js and test/helpers/wp3-freeze-snapshot.mjs).
//
// collectTables(): every string the money-path modules export (plain strings, arrays of strings, the SW and
// STEP_WORDS tables), and the SW functions called with fixed arguments, keyed module.name[.key].
// collectStates(): for every state in test/helpers/wp3-world.js, the text a person reads, the fields and
// the data-*-action values in order.

import * as STEPS from '../../lib/validator-setup-steps.js';
import * as SETUP from '../../lib/validator-setup.js';
import * as MANAGE from '../../lib/validator-manage.js';
import * as DELEGATE from '../../lib/validator-delegate.js';
import { SETUP_STEPS } from '../../lib/validator-setup-view.js';
import { buildState, ALL_STATE_IDS, snapshotOf } from './wp3-world.js';

const ARGS = [[], [1], [1, 3], [2, 3, 'X'], [2n, 3, 'X', 4]];
function fromValue(out, key, v) {
    if (typeof v === 'string') out[key] = v;
    else if (Array.isArray(v)) v.forEach((x, i) => { if (typeof x === 'string') out[`${key}[${i}]`] = x; });
    else if (typeof v === 'function') {
        ARGS.forEach((a, i) => { try { const r = v(...a); if (typeof r === 'string') out[`${key}(${i})`] = r; } catch (e) { /* not callable with these */ } });
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (typeof x !== 'function' || key.endsWith('.SW')) fromValue(out, `${key}.${k}`, x);
}
export async function collectTables() {
    const out = {};
    for (const [mod, ns] of [['steps', STEPS], ['setup', SETUP], ['manage', MANAGE], ['delegate', DELEGATE]]) {
        for (const [name, v] of Object.entries(ns)) {
            if (typeof v === 'function') continue;   // logic, covered by the file hashes
            fromValue(out, `${mod}.${name}`, v);
        }
    }
    fromValue(out, 'view.SETUP_STEPS', SETUP_STEPS);
    return out;
}
export async function collectStates() {
    const out = {};
    for (const id of ALL_STATE_IDS) {
        const w = await buildState(id);
        out[id] = snapshotOf(w.el);
        if (w.release) w.release();
    }
    return out;
}
