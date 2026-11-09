// Recipients that move funds or grant control must be encoded for this chain (CTO decision, 2026-11).
//
// A well-formed SS58 address with another network's prefix is the same key on Polkadex, but it may be an
// exchange deposit address on that network, where nobody will ever look for PDEX. Send and proxy refuse it
// and show the Polkadex encoding of the same key with a Copy button, so someone pasting their own key from
// another wallet can continue in one step. Invalid input is refused with each form's existing wording.
//
// Strict (refuse another prefix): Send (keep-alive, allow-death, multisig-wrapped), proxy add (typed; remove re-encodes the chain-read delegate instead),
// the treasury spend beneficiary (lib/treasury-spend.js). Lenient on purpose (any valid prefix, re-encoded):
// search, account lookup, the wallet picker and manual address, multisig signers, the multisig calculator,
// address labels. A 0x public key is not accepted by any recipient input (isValidPolkadexAddress refuses 0x).
// Pure apart from renderRecipientRefusal, which only touches the element it is given.
import { decodeAddress, encodeAddress, checkAddressChecksum, base58Decode } from '@polkadot/util-crypto';
import { isValidPolkadexAddress, isPolkadexPrefixedAddress } from './wallet-safety.js';
import { sameAccount } from './multisig.js';

export const POLKADEX_SS58 = 88;

// The chain's SS58 prefix from the api registry; Polkadex's 88 until the api knows it.
export function ss58PrefixOf(api) {
    const p = api && api.registry && api.registry.chainSS58;
    return Number.isInteger(p) ? p : POLKADEX_SS58;
}

export function otherNetworkMessage(prefix, reencoded) {
    return `This address is for another network (prefix ${prefix}). The same key on Polkadex is ${reencoded}. `
        + 'If this is your own key, paste that address instead. Never send PDEX to an exchange deposit address from another network.';
}

// { ok: true, address } | { ok: false, reason: 'invalid' } | { ok: false, reason: 'other-network', prefix, reencoded, message }
export function checkRecipient(addr, ss58Prefix = POLKADEX_SS58) {
    const s = String(addr == null ? '' : addr).trim();
    if (!isValidPolkadexAddress(s)) return { ok: false, reason: 'invalid' };
    if (isPolkadexPrefixedAddress(s, ss58Prefix)) return { ok: true, address: s };
    try {
        const prefix = checkAddressChecksum(base58Decode(s))[3];
        const reencoded = encodeAddress(decodeAddress(s), ss58Prefix);
        return { ok: false, reason: 'other-network', prefix, reencoded, message: otherNetworkMessage(prefix, reencoded) };
    } catch (e) { return { ok: false, reason: 'invalid' }; }
}

const problemOf = (c, invalidText) => c.ok ? null : c.reason === 'other-network' ? { text: c.message, refusal: c } : { text: invalidText };

// The Send dialog's recipient: null when it can be signed, else { text, refusal? } in the dialog's own words
// (`live` is the hint under the field, otherwise the error on Sign). Every Send variant runs through here.
export function sendRecipientProblem(value, { own, ss58Prefix = POLKADEX_SS58, live = false, isSame = sameAccount } = {}) {
    const c = checkRecipient(value, ss58Prefix);
    if (!c.ok && c.reason === 'invalid') return { text: live ? 'That address is not valid on Polkadex.' : 'That recipient address is not valid on Polkadex.' };
    if (own && isSame(String(value).trim(), own)) return { text: live ? 'Cannot send to yourself.' : 'You cannot send to your own address.' };
    return problemOf(c, '');
}

// proxy.addProxy / proxy.removeProxy delegate: null when it can be signed, else { text, refusal? }.
export function proxyDelegateProblem(value, { ss58Prefix = POLKADEX_SS58 } = {}) {
    return problemOf(checkRecipient(value, ss58Prefix), 'Delegate address is not a valid Polkadex address.');
}

// proxy.removeProxy delegate: read back from the chain, so never refused. Re-encoded to the chain prefix
// (same account bytes) so the call is built for exactly the account the chain holds.
export function chainDelegate(value, ss58Prefix = POLKADEX_SS58) {
    return encodeAddress(decodeAddress(String(value).trim()), ss58Prefix);
}

// Puts the refusal into `el` as text, with a Copy button for the Polkadex encoding.
export function renderRecipientRefusal(el, refusal, { clipboard = globalThis.navigator && globalThis.navigator.clipboard } = {}) {
    if (!el) return;
    const doc = el.ownerDocument;
    el.textContent = '';
    const text = doc.createElement('span');
    text.className = 'js-recipient-refusal-text';
    text.textContent = refusal.message;
    const btn = doc.createElement('button');
    btn.className = 'js-recipient-copy staking-download-btn';
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', `Copy the Polkadex address ${refusal.reencoded}`);
    btn.style.cssText = 'margin-left:8px;padding:2px 10px;font-size:0.75rem;';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
        try {
            if (!clipboard || !clipboard.writeText) throw new Error('no clipboard');
            await clipboard.writeText(refusal.reencoded);
            btn.textContent = 'Copied';
        } catch (e) { btn.textContent = 'Copy failed; select the address above'; }
    });
    el.append(text, btn);
}
