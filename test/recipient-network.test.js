// Send and proxy refuse an address encoded for another network (CTO decision, 2026-11).
//
// A well-formed SS58 address with another prefix is the same key on Polkadex, but it may be an
// exchange deposit address on that network, so the form refuses it and shows the Polkadex encoding
// of the same key with a Copy button. An invalid address is refused with the wording each form
// used before. Keys are generated here; no real address appears in this file.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { encodeAddress, randomAsU8a, cryptoWaitReady } from '@polkadot/util-crypto';
import { checkRecipient, otherNetworkMessage, ss58PrefixOf, sendRecipientProblem, proxyDelegateProblem, renderRecipientRefusal } from '../lib/recipient-network.js';
import { readRepo, stripComments } from './helpers/source.js';

await cryptoWaitReady();
const key = randomAsU8a(32), ownKey = randomAsU8a(32);
const at = (prefix, k = key) => encodeAddress(k, prefix);
const PDEX = at(88), OWN = at(88, ownKey);
// Change one base58 character: still the right length and alphabet, checksum broken.
const badChecksum = (addr) => addr.slice(0, -1) + (addr.endsWith('a') ? 'b' : 'a');
const OTHERS = [[0, 'Polkadot'], [2, 'Kusama'], [42, 'generic Substrate']];

describe('checkRecipient', () => {
    test('a Polkadex address is accepted', () => {
        assert.deepEqual(checkRecipient(PDEX), { ok: true, address: PDEX });
        assert.deepEqual(checkRecipient(`  ${PDEX} `), { ok: true, address: PDEX });
    });
    for (const [prefix, name] of OTHERS) {
        test(`a ${name} (${prefix}) address is refused with the same key re-encoded for Polkadex`, () => {
            const c = checkRecipient(at(prefix));
            assert.equal(c.ok, false);
            assert.equal(c.reason, 'other-network');
            assert.equal(c.prefix, prefix);
            assert.equal(c.reencoded, PDEX);
            assert.equal(c.message, otherNetworkMessage(prefix, PDEX));
        });
    }
    test('an invalid checksum, a hex key, a hash and an empty value are invalid, not other-network', () => {
        for (const v of [badChecksum(PDEX), '0x' + 'ab'.repeat(32), '', 'nope']) assert.deepEqual(checkRecipient(v), { ok: false, reason: 'invalid' }, v);
    });
    test('the chain prefix is honoured: on a 42 registry the 42 address passes and the 88 one is refused', () => {
        assert.equal(checkRecipient(at(42), 42).ok, true);
        const c = checkRecipient(PDEX, 42);
        assert.equal(c.reason, 'other-network');
        assert.equal(c.prefix, 88);
        assert.equal(c.reencoded, at(42));
    });
    test('the message is the agreed wording', () => {
        assert.equal(otherNetworkMessage(0, 'esXYZ'),
            'This address is for another network (prefix 0). The same key on Polkadex is esXYZ. If this is your own key, paste that address instead. Never send PDEX to an exchange deposit address from another network.');
    });
    test('ss58PrefixOf reads the api registry, else 88', () => {
        assert.equal(ss58PrefixOf({ registry: { chainSS58: 42 } }), 42);
        assert.equal(ss58PrefixOf({ registry: {} }), 88);
        assert.equal(ss58PrefixOf(null), 88);
    });
});

// Every input that moves funds or grants control, through the function its form calls.
const INPUTS = [
    { name: 'Send, live hint', problem: (v) => sendRecipientProblem(v, { own: OWN, live: true }), invalid: 'That address is not valid on Polkadex.' },
    { name: 'Send, on Sign (keep-alive, allow-death and multisig-wrapped share this path)', problem: (v) => sendRecipientProblem(v, { own: OWN }), invalid: 'That recipient address is not valid on Polkadex.' },
    { name: 'Proxy add (proxy.addProxy delegate)', problem: (v) => proxyDelegateProblem(v), invalid: 'Delegate address is not a valid Polkadex address.' },
    { name: 'Proxy remove (proxy.removeProxy delegate)', problem: (v) => proxyDelegateProblem(v), invalid: 'Delegate address is not a valid Polkadex address.' }
];
for (const input of INPUTS) {
    describe(input.name, () => {
        test('a Polkadex address is accepted', () => assert.equal(input.problem(PDEX), null));
        for (const [prefix, name] of OTHERS) {
            test(`a ${name} (${prefix}) address is refused with the re-encoded hint`, () => {
                const p = input.problem(at(prefix));
                assert.equal(p.text, otherNetworkMessage(prefix, PDEX));
                assert.equal(p.refusal.reencoded, PDEX);
            });
        }
        test('an invalid checksum is refused as before', () => {
            const p = input.problem(badChecksum(PDEX));
            assert.equal(p.text, input.invalid);
            assert.equal(p.refusal, undefined);
        });
    });
}
describe('Send keeps its own-address rule', () => {
    test('the connected account is refused on either spelling, with the old wording', () => {
        assert.equal(sendRecipientProblem(OWN, { own: OWN, live: true }).text, 'Cannot send to yourself.');
        assert.equal(sendRecipientProblem(at(0, ownKey), { own: OWN }).text, 'You cannot send to your own address.');
    });
});

describe('the refusal on the page', () => {
    test('shows the message and a Copy button that copies the Polkadex encoding', async () => {
        const window = new Window();
        const el = window.document.createElement('div');
        el.innerHTML = '<b>old</b>';
        const copied = [];
        const c = checkRecipient(at(2));
        renderRecipientRefusal(el, c, { clipboard: { writeText: async (t) => { copied.push(t); } } });
        assert.equal(el.querySelector('.js-recipient-refusal-text').textContent, c.message);
        const btn = el.querySelector('button.js-recipient-copy');
        assert.equal(btn.getAttribute('type'), 'button');
        assert.equal(btn.textContent, 'Copy');
        assert.match(btn.getAttribute('aria-label'), /Copy the Polkadex address/);
        btn.click();
        await new Promise(r => setTimeout(r, 0));
        assert.deepEqual(copied, [PDEX]);
        assert.equal(btn.textContent, 'Copied');
        assert.doesNotMatch(el.innerHTML, /<b>old<\/b>/);
        await window.happyDOM.close();
    });
    test('a message with markup in it is text, not HTML', async () => {
        const window = new Window();
        const el = window.document.createElement('div');
        renderRecipientRefusal(el, { reason: 'other-network', prefix: 0, reencoded: '<img src=x>', message: 'x <img src=x> y' }, { clipboard: null });
        assert.equal(el.querySelector('img'), null);
        await window.happyDOM.close();
    });
});

describe('wiring in script.js', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));
    const fn = (name) => { const i = script.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return script.slice(i, script.indexOf('\n}\n', i)); };
    test('script.js imports the helpers', () => {
        assert.match(script, /import \{[^}]*sendRecipientProblem[^}]*\} from '\.\/lib\/recipient-network\.js'/);
        assert.match(script, /import \{[^}]*proxyDelegateProblem[^}]*\} from '\.\/lib\/recipient-network\.js'/);
    });
    test('Send: the live hint and the Sign path both call sendRecipientProblem with the chain prefix and render the refusal', () => {
        for (const name of ['validateSendRecipient', 'submitSendTx']) {
            const body = fn(name);
            assert.match(body, /sendRecipientProblem\([^)]*ss58Prefix:\s*ss58PrefixOf\(globalApi\)/, name);
            assert.match(body, /renderRecipientRefusal\(/, name);
            assert.doesNotMatch(body, /isValidPolkadexAddress\(/, `${name} no longer runs the lenient check on its own`);
        }
    });
    test('Proxy: add and remove both refuse through proxyDelegateProblem before building the call', () => {
        const add = script.slice(script.indexOf("getElementById('proxy-add-delegate')"), script.indexOf('api.tx.proxy.addProxy('));
        assert.match(add, /proxyDelegateProblem\(delegate,\s*\{\s*ss58Prefix:\s*ss58PrefixOf\(globalApi\)/);
        assert.match(add, /renderRecipientRefusal\(/);
        const remove = script.slice(script.indexOf(".proxy-remove-btn').forEach"), script.indexOf('api.tx.proxy.removeProxy('));
        assert.match(remove, /proxyDelegateProblem\(delegate,\s*\{\s*ss58Prefix:\s*ss58PrefixOf\(globalApi\)/);
    });
});
