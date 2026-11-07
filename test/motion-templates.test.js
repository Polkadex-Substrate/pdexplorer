// Council motion templates and every static extrinsic builder, checked against
// the spec 393 metadata fixture.
//
// The motion form used to offer treasury.approveProposal / rejectProposal.
// Runtime 392 removed both (and SpendOrigin admits no origin), so a motion built
// from them could never execute. Nothing caught that because nothing compared
// the page's builders to the runtime. These tests do: every template in
// lib/motion-templates.js, and every `api.tx.<pallet>.<method>` written in the
// shipped sources, must exist in the metadata fixture; and the two removed
// treasury builders must not come back.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';
import { MOTION_TEMPLATES, REMOVED_CALLS, isRemovedCall, missingFromMetadata } from '../lib/motion-templates.js';
import { renderCall } from '../lib/gov-detail-view.js';

const fx = loadFixture('metadata-392.json');
const snake = (s) => s.replace(/([A-Z])/g, '_$1').toLowerCase();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function callIndex(metadataHex) {
    const registry = registryFromMetadata(metadataHex);
    const out = new Map();
    for (const p of registry.metadata.pallets) {
        if (p.calls.isNone) continue;
        out.set(p.name.toString(), new Set(registry.lookup.getSiType(p.calls.unwrap().type).def.asVariant.variants.map(v => v.name.toString())));
    }
    return out;
}

describe('motion templates exist in the spec 393 metadata', { skip: fx ? false : 'test/fixtures/metadata-392.json not present' }, () => {
    const index = fx ? callIndex(fx.metadata) : null;

    test('the fixture is spec 393', () => assert.equal(fx.specVersion, 393));

    test('every motion template builds a call the runtime has', () => {
        assert.deepEqual(missingFromMetadata(MOTION_TEMPLATES, index), []);
    });

    test('the checker does fail on a template the runtime lost (proof the guard bites)', () => {
        const bad = [{ key: 'treasury.approveProposal', pallet: 'treasury', method: 'approveProposal' }];
        assert.equal(missingFromMetadata(bad, index).length, 1);
        assert.equal(missingFromMetadata([{ key: 'treasury.spend', pallet: 'treasury', method: 'spend' }], index).length, 0);
    });

    test('the removed calls really are absent from the metadata', () => {
        for (const c of REMOVED_CALLS) assert.ok(!index.get(cap(c.pallet))?.has(snake(c.method)), `${c.pallet}.${c.method} is back in the metadata`);
    });

    test('every static api.tx.<pallet>.<method> in the shipped sources exists in the metadata', () => {
        const files = ['script.js', ...readdirSync(new URL('../lib/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `lib/${f}`)];
        const found = [];
        for (const f of files) {
            const src = stripComments(readRepo(f, import.meta.url));
            for (const m of src.matchAll(/api\.tx\.([a-zA-Z]+)\.([a-zA-Z]+)/g)) found.push({ file: f, pallet: m[1], method: m[2] });
        }
        assert.ok(found.length > 10, 'the scan found almost nothing; the pattern has rotted');
        const missing = found.filter(c => !index.get(cap(c.pallet))?.has(snake(c.method))).map(c => `${c.file}: ${c.pallet}.${c.method}`);
        assert.deepEqual(missing, []);
    });
});

describe('the council motion form is gone with its only two templates', () => {
    test('no templates are left', () => assert.deepEqual(MOTION_TEMPLATES, []));

    const files = ['script.js', 'index.html', ...readdirSync(new URL('../lib/', import.meta.url)).filter(f => f.endsWith('.js') && f !== 'motion-templates.js' && f !== 'tx-status.js' && f !== 'gov-detail-view.js' && f !== 'help-topics.js').map(f => `lib/${f}`)];
    const BANNED = [/approveProposal/, /rejectProposal/, /approve_proposal/, /reject_proposal/, /council-propose-modal/, /propose-call-type/, /openProposeMotionModal/, /submitProposeMotion/, /open-propose-motion-btn/, /treasury-propose-/];
    for (const file of files) {
        test(`${file} has no approve/reject proposal builder or motion form`, () => {
            const src = stripComments(readRepo(file, import.meta.url));
            for (const rx of BANNED) assert.doesNotMatch(src, rx, `${file} still matches ${rx}`);
        });
    }
});

describe('motions already on chain whose call no longer exists', () => {
    const h = { esc: (s) => String(s) };
    test('isRemovedCall recognises the treasury approve/reject calls, in either spelling', () => {
        assert.ok(isRemovedCall({ section: 'treasury', method: 'approveProposal' }));
        assert.ok(isRemovedCall({ section: 'treasury', method: 'reject_proposal' }));
        assert.ok(!isRemovedCall({ section: 'treasury', method: 'spend' }));
        assert.ok(!isRemovedCall(null));
    });
    test('the motion page carries the note for a removed call', () => {
        const html = renderCall({ call: { section: 'treasury', method: 'approveProposal', args: [] } }, h);
        assert.match(html, /This call no longer exists on the current runtime; the motion cannot execute\./);
        assert.match(html, /treasury\.approveProposal/);
    });
    test('no note for a call that still exists', () => {
        const html = renderCall({ call: { section: 'treasury', method: 'spend', args: [] } }, h);
        assert.doesNotMatch(html, /no longer exists/);
    });
});
