// Validator onboarding, Sprint 1: the session keys checker (Fable design,
// cto-team/plans/2026-11-17-validator-onboarding-design.md, sections 1.1,
// 1.2 and 4.2).
//
//   lib/session-keys.js   pure: the expected layout, the layout read from
//                         metadata, parsing (prefix, hex, length, split, zero
//                         key, secret phrase), the KeyOwner / QueuedKeys result
//
// Runtime facts (polkadex-node mainnet runtimes/mainnet/src/lib.rs,
// impl_opaque_keys!): six keys in this order: grandpa, babe, im_online,
// authority_discovery, mixnet (32 bytes each), beefy (33 bytes, ecdsa). 193
// bytes, 386 hex characters, 388 with 0x. The layout is also read from the
// metadata (the type of session.set_keys' keys argument) and compared; a
// different layout switches the checker off.
//
// Every key below is synthetic (repeated bytes); every account is 32 bytes of
// one repeated value at prefix 88 and belongs to no one.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAddress } from '@polkadot/util-crypto';
import {
    EXPECTED_LAYOUT, layoutTotalBytes, layoutFromRegistry, checkLayout, looksLikeSecret,
    parseSessionKeys, keyPreview, classifyKeyOwners, layoutMismatchText, keyCheckSummary
} from '../lib/session-keys.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(61), OTHER = addr(62), THIRD = addr(63);
const rep = (byte, n) => byte.repeat(n);
// One synthetic key per field: 0x11.. 0x22.. 0x33.. 0x44.. 0x55.. and a 33 byte beefy 0x02 66..
const PARTS = [rep('11', 32), rep('22', 32), rep('33', 32), rep('44', 32), rep('55', 32), '02' + rep('66', 32)];
const BLOB = '0x' + PARTS.join('');
const NAMES = ['grandpa', 'babe', 'im_online', 'authority_discovery', 'mixnet', 'beefy'];

describe('the expected layout (runtime lib.rs, impl_opaque_keys!)', () => {
    test('six keys in order, with their KeyTypeIds and sizes', () => {
        assert.deepEqual(EXPECTED_LAYOUT.map(k => [k.name, k.typeId, k.bytes]), [
            ['grandpa', 'gran', 32], ['babe', 'babe', 32], ['im_online', 'imon', 32],
            ['authority_discovery', 'audi', 32], ['mixnet', 'mixn', 32], ['beefy', 'beef', 33]
        ]);
    });
    test('193 bytes in total: 386 hex characters, 388 with 0x', () => {
        assert.equal(layoutTotalBytes(EXPECTED_LAYOUT), 193);
        assert.equal(BLOB.length, 388);
    });
});

describe('layoutFromRegistry: the layout as the live metadata describes it', () => {
    let registry;
    before(() => { registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata); });
    test('spec 393 metadata: the type of session.set_keys keys, field by field, with the byte length of each', () => {
        assert.deepEqual(layoutFromRegistry(registry), NAMES.map((name, i) => ({ name, bytes: i === 5 ? 33 : 32 })));
    });
    test('and it matches the expected layout', () => {
        const r = checkLayout(layoutFromRegistry(registry));
        assert.equal(r.ok, true);
        assert.equal(r.bytes, 193);
        assert.equal(r.hexLength, 388);
        assert.deepEqual(r.layout.map(k => k.typeId), ['gran', 'babe', 'imon', 'audi', 'mixn', 'beef']);
    });
    test('no registry, no Session pallet or no set_keys: null (unknown, never a guess)', () => {
        assert.equal(layoutFromRegistry(null), null);
        assert.equal(layoutFromRegistry({ metadata: { pallets: [] }, lookup: {} }), null);
    });
});

describe('checkLayout: a layout that differs switches the checker off', () => {
    const live = NAMES.map((name, i) => ({ name, bytes: i === 5 ? 33 : 32 }));
    test('seven keys (an orderbook key brought back): mismatch, with the reason', () => {
        const r = checkLayout([...live.slice(0, 4), { name: 'orderbook', bytes: 32 }, ...live.slice(4)]);
        assert.equal(r.ok, false);
        assert.match(r.reason, /7 keys/);
    });
    test('a key resized or renamed: mismatch', () => {
        assert.equal(checkLayout(live.map((k, i) => (i === 5 ? { ...k, bytes: 32 } : k))).ok, false);
        assert.equal(checkLayout(live.map((k, i) => (i === 0 ? { ...k, name: 'grandpa2' } : k))).ok, false);
    });
    test('an unreadable layout (null) is a mismatch too: never validate against a guess', () => {
        assert.equal(checkLayout(null).ok, false);
    });
    test('the mismatch copy is accurate and points at the node and the chain, not at a change that may not have happened', () => {
        const want = "This network's session key format is different from what this checker knows. Use your node's author_rotateKeys output and the chain's own validation.";
        assert.equal(layoutMismatchText(394), want);
        assert.equal(layoutMismatchText(null), want);
        assert.doesNotMatch(layoutMismatchText(394), /changed|switched off|not been updated/);
    });
});

describe('the layout comes from the metadata where the keys are ones the explorer knows (review finding 2)', () => {
    const KNOWN = { grandpa: 'gran', babe: 'babe', im_online: 'imon', authority_discovery: 'audi', mixnet: 'mixn', beefy: 'beef' };
    test('393 fixture: six keys, 193 bytes, ok, each with its KeyTypeId', () => {
        const r = checkLayout(layoutFromRegistry(registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata)));
        assert.equal(r.ok, true);
        assert.equal(r.bytes, 193);
        assert.deepEqual(r.layout.map(k => [k.name, k.typeId]), Object.entries(KNOWN));
    });
    test('373 fixture (orderbook and thea keys): not ok, the reason names the keys the explorer does not know, no layout is used', () => {
        const live = layoutFromRegistry(registryFromMetadata(loadFixture('metadata-mainnet-373.json').metadata));
        assert.deepEqual(live.map(k => k.name), ['grandpa', 'babe', 'im_online', 'authority_discovery', 'orderbook', 'thea']);
        const r = checkLayout(live);
        assert.equal(r.ok, false);
        assert.match(r.reason, /orderbook/);
        assert.match(r.reason, /thea/);
        assert.equal(r.layout, null);
    });
    test('a future layout of known keys in another order (or one fewer) works automatically, in the metadata order', () => {
        const live = [{ name: 'babe', bytes: 32 }, { name: 'grandpa', bytes: 32 }, { name: 'im_online', bytes: 32 }, { name: 'beefy', bytes: 33 }];
        const r = checkLayout(live);
        assert.equal(r.ok, true);
        assert.equal(r.bytes, 129);
        assert.equal(r.hexLength, 260);
        assert.deepEqual(r.layout.map(k => [k.name, k.typeId, k.bytes]), [['babe', 'babe', 32], ['grandpa', 'gran', 32], ['im_online', 'imon', 32], ['beefy', 'beef', 33]]);
        const blob = '0x' + rep('01', 32) + rep('02', 32) + rep('03', 32) + '02' + rep('04', 32);
        const parsed = parseSessionKeys(blob, { layout: r.layout });
        assert.equal(parsed.ok, true);
        assert.deepEqual(parsed.keys.map(k => k.name), ['babe', 'grandpa', 'im_online', 'beefy']);
    });
    test('a known name at a size the explorer does not know is still not ok (never a guess)', () => {
        assert.equal(checkLayout([{ name: 'grandpa', bytes: 31 }, { name: 'babe', bytes: 32 }]).ok, false);
    });
});

describe('parseSessionKeys: the first failure is shown (section 4.2)', () => {
    const p = (s, o) => parseSessionKeys(s, { specVersion: 393, ...o });
    test('a valid line: six keys split by the layout, each with its name, KeyTypeId, size and hex', () => {
        const r = p(BLOB);
        assert.equal(r.ok, true);
        assert.equal(r.bytes, 193);
        assert.deepEqual(r.keys.map(k => [k.name, k.typeId, k.bytes]), EXPECTED_LAYOUT.map(k => [k.name, k.typeId, k.bytes]));
        assert.deepEqual(r.keys.map(k => k.hex), PARTS.map(x => '0x' + x));
        assert.deepEqual(r.warnings, []);
    });
    test('each type slice is exactly its own bytes (grandpa first, beefy last and 33 bytes)', () => {
        const r = p(BLOB);
        assert.equal(r.keys[0].hex, '0x' + rep('11', 32));
        assert.equal(r.keys[3].hex, '0x' + rep('44', 32));
        assert.equal(r.keys[5].hex, '0x02' + rep('66', 32));
        assert.equal(r.keys[5].hex.length, 2 + 66);
    });
    test('trimmed, and upper case hex is accepted (normalised to lower case)', () => {
        const r = p('  \n' + BLOB.toUpperCase().replace('0X', '0x') + '\n ');
        assert.equal(r.ok, true);
        assert.equal(r.keys[0].hex, '0x' + rep('11', 32));
    });
    test('empty', () => assert.deepEqual([p('').code, p('   ').code], ['empty', 'empty']));
    test('no 0x: "Session keys start with 0x."', () => {
        const r = p(BLOB.slice(2));
        assert.deepEqual([r.ok, r.code, r.message], [false, 'prefix', 'Session keys start with 0x.']);
    });
    test('not hex: "This contains characters that are not hexadecimal."', () => {
        const r = p(BLOB.slice(0, 100) + 'zz' + BLOB.slice(102));
        assert.deepEqual([r.code, r.message], ['hex', 'This contains characters that are not hexadecimal.']);
        assert.equal(p(BLOB.slice(0, 200) + ' ' + BLOB.slice(200)).code, 'hex', 'a space inside the line is not hex');
    });
    test('wrong length: says the bytes, the spec and what the runtime expects', () => {
        const r = p(BLOB.slice(0, -2));
        assert.equal(r.code, 'length');
        assert.equal(r.message, 'This is 192 bytes. The live runtime (spec 393) expects 193. Run author_rotateKeys on a node that is fully synced.');
        assert.equal(p(BLOB + '00').code, 'length');
        assert.match(p(BLOB.slice(0, -2), { specVersion: null }).message, /^This is 192 bytes\. The live runtime expects 193\./);
    });
    test('an odd number of hex characters is a length failure, not a crash', () => {
        assert.equal(p(BLOB.slice(0, -1)).code, 'length');
    });
    test('32 bytes: "This looks like a single key or an account, not the full session keys line."', () => {
        const r = p('0x' + rep('ab', 32));
        assert.deepEqual([r.code, r.message], ['single', 'This looks like a single key or an account, not the full session keys line.']);
    });
    test('an all-zero key: "Key K (name) is empty." for the first such key', () => {
        const zeroBeefy = '0x' + PARTS.slice(0, 5).join('') + rep('00', 33);
        assert.deepEqual([p(zeroBeefy).code, p(zeroBeefy).message], ['zero', 'Key 6 (beefy) is empty.']);
        const zeroBabe = '0x' + PARTS[0] + rep('00', 32) + PARTS.slice(2).join('');
        assert.equal(p(zeroBabe).message, 'Key 2 (babe) is empty.');
        assert.equal(p('0x' + rep('00', 193)).message, 'Key 1 (grandpa) is empty.');
    });
    test('two identical keys inside the blob: a warning, not a failure', () => {
        const dup = '0x' + PARTS[1] + PARTS[1] + PARTS.slice(2).join('');
        const r = p(dup);
        assert.equal(r.ok, true);
        assert.deepEqual(r.warnings, ['Keys 1 (grandpa) and 2 (babe) are identical.']);
    });
    test('a secret phrase: refused before anything else, with the design copy', () => {
        const words = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';
        for (const s of [words, '  ' + words + '\n', words.split(' ').slice(0, 3).join(' '), words + '//stash']) {
            const r = p(s);
            assert.equal(r.code, 'secret', s);
            assert.equal(r.message, 'That looks like a secret phrase. Do not paste it anywhere. Session keys are a single 0x line from your node.');
        }
    });
    test('looksLikeSecret: words yes; a hex line or a line broken in two no', () => {
        assert.equal(looksLikeSecret('one two three'), true);
        assert.equal(looksLikeSecret(BLOB), false);
        assert.equal(looksLikeSecret(BLOB.slice(0, 200) + '\n' + BLOB.slice(200)), false);
        assert.equal(looksLikeSecret('0xabc def bead'), false, 'hex-only words are not a phrase');
    });
    test('a layout given by the caller is used (the live one), not the constant', () => {
        const small = [{ name: 'a', typeId: 'aaaa', bytes: 2 }, { name: 'b', typeId: 'bbbb', bytes: 3 }];
        const r = parseSessionKeys('0x0102030405', { layout: small });
        assert.equal(r.ok, true);
        assert.deepEqual(r.keys.map(k => k.hex), ['0x0102', '0x030405']);
    });
    test('very long input is refused as a length failure without being split', () => {
        const r = p('0x' + 'ab'.repeat(5000));
        assert.equal(r.code, 'length');
    });
    test('keyPreview: first and last 8 hex characters', () => {
        assert.equal(keyPreview('0x' + '0123456789abcdef'.repeat(4)), '01234567...89abcdef');
    });
});

describe('classifyKeyOwners: Session.KeyOwner and Session.QueuedKeys, per key', () => {
    const keys = parseSessionKeys(BLOB).keys;
    const none = keys.map(() => null);
    const same = (a, b) => a === b;
    test('no owner anywhere: every key free, no conflict, the success line', () => {
        const r = classifyKeyOwners(keys, { owners: none, queued: [], stash: STASH, nextKeys: null, isSame: same });
        assert.equal(r.conflict, false);
        assert.ok(r.rows.every(x => x.result === 'free'));
        assert.equal(keyCheckSummary(r, keys), '6 keys, 193 bytes, none registered to another account.');
    });
    test('owned by this stash: fine, and identical to NextKeys means already registered', () => {
        const nextKeys = Object.fromEntries(keys.map(k => [k.name, k.hex]));
        const r = classifyKeyOwners(keys, { owners: keys.map(() => STASH), queued: [], stash: STASH, nextKeys, isSame: same });
        assert.equal(r.conflict, false);
        assert.ok(r.rows.every(x => x.result === 'own'));
        assert.equal(r.sameAsNext, true);
        assert.equal(keyCheckSummary(r, keys), 'These keys are already registered to this stash.');
    });
    test('the grandpa key owned by another account: blocking, with the design copy', () => {
        const owners = none.slice(); owners[0] = OTHER;
        const r = classifyKeyOwners(keys, { owners, queued: [], stash: STASH, nextKeys: null, isSame: same });
        assert.equal(r.conflict, true);
        assert.equal(r.rows[0].result, 'other');
        assert.equal(r.rows[0].owner, OTHER);
        assert.equal(r.rows[0].message, `Key 1 (grandpa) is already registered to ${OTHER}. The chain will reject these keys. If you copied a keystore from another node, stop: running two nodes with the same keys is slashed.`);
        assert.ok(r.rows.slice(1).every(x => x.result === 'free'));
    });
    test('a key queued for the next session by another validator (QueuedKeys) is blocking too', () => {
        const queued = [{ account: THIRD, keys: { grandpa: '0x' + rep('99', 32), babe: keys[1].hex } }];
        const r = classifyKeyOwners(keys, { owners: none, queued, stash: STASH, nextKeys: null, isSame: same });
        assert.equal(r.conflict, true);
        assert.equal(r.rows[1].result, 'other');
        assert.equal(r.rows[1].owner, THIRD);
        assert.equal(r.rows[0].result, 'free');
    });
    test('queued for this stash is fine', () => {
        const queued = [{ account: STASH, keys: { babe: keys[1].hex } }];
        assert.equal(classifyKeyOwners(keys, { owners: none, queued, stash: STASH, nextKeys: null, isSame: same }).conflict, false);
    });
    test('no stash given: any owner is a conflict, named, because the explorer cannot tell it is yours', () => {
        const owners = none.slice(); owners[2] = STASH;
        const r = classifyKeyOwners(keys, { owners, queued: [], stash: '', nextKeys: null, isSame: same });
        assert.equal(r.conflict, true);
        assert.equal(r.rows[2].result, 'other');
    });
});

describe('guards: never a seed, never a node method, never a hard-coded limit', () => {
    test('the client code never calls the unsafe author_* methods (they appear only as copy in quotes)', () => {
        for (const f of ['lib/session-keys.js', 'lib/validator-status.js', 'lib/validator-status-view.js', 'lib/validator-status-chain.js', 'lib/validator-status-api.js']) {
            const src = stripComments(readRepo(f, import.meta.url));
            assert.doesNotMatch(src, /\.(rpc\.author|author)\.(rotateKeys|insertKey|hasSessionKeys)\b/, f);
            assert.doesNotMatch(src, /['"]author_(insertKey|hasSessionKeys)['"]/, f);
        }
    });
});
