// Multisig definitions contain public information only. Never persist a signer
// or a key. Re-derive the account whenever a definition is read from storage.
import { createKeyMulti, decodeAddress, encodeAddress, sortAddresses, blake2AsHex } from '@polkadot/util-crypto';
import { isValidPolkadexAddress } from './wallet-safety.js';

export const MULTISIG_STORAGE_KEY = 'pdex_multisigs_v1';
export const sameAccount = (a, b) => {
    try { return encodeAddress(decodeAddress(a), 88) === encodeAddress(decodeAddress(b), 88); }
    catch { return false; }
};

export function normalizeMultisig(input) {
    const raw = Array.isArray(input.signers) ? input.signers : String(input.signers || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    if (raw.length < 2 || raw.length > 100) throw new Error('Enter between 2 and 100 signer addresses.');
    const signers = raw.map(a => {
        try {
            if (!isValidPolkadexAddress(a)) throw new Error();
            const key = decodeAddress(a);
            if (key.length !== 32) throw new Error();
            return encodeAddress(key, 88);
        } catch { throw new Error('One of the signer addresses is invalid.'); }
    });
    if (new Set(signers).size !== signers.length) throw new Error('Each signer must be a different account (including alternate address prefixes).');
    const threshold = Number(input.threshold);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > signers.length) throw new Error('The approval threshold must be a whole number between 1 and the number of signers.');
    const sorted = sortAddresses(signers, 88);
    const address = encodeAddress(createKeyMulti(sorted, threshold), 88);
    if (input.address && !sameAccount(input.address, address)) throw new Error('These signers and threshold do not match the multisig address. Check the full signer list.');
    return { address, signers: sorted, threshold, name: String(input.name || 'Multisig wallet').trim().slice(0, 80) || 'Multisig wallet' };
}

export function createMultisigStore(storage) {
    function list() {
        let rows;
        try { rows = JSON.parse(storage.getItem(MULTISIG_STORAGE_KEY) || '[]'); } catch { return []; }
        if (!Array.isArray(rows)) return [];
        const valid = new Map();
        for (const row of rows) {
            try { const m = normalizeMultisig(row); valid.set(m.address, m); } catch { /* skip damaged definitions */ }
        }
        return [...valid.values()];
    }
    function save(input) {
        const m = normalizeMultisig(input);
        const rows = list().filter(r => r.address !== m.address);
        rows.push(m);
        try { storage.setItem(MULTISIG_STORAGE_KEY, JSON.stringify(rows)); }
        catch { throw new Error('This browser could not save the multisig. Enable site storage and try again.'); }
        return m;
    }
    return { list, save, find: address => list().find(m => sameAccount(m.address, address)) || null };
}

export function decodeMultisigCall(api, hex, expectedHash) {
    if (typeof hex !== 'string' || !/^0x(?:[a-f\d]{2}){2,}$/i.test(hex) || hex.length > 262146) throw new Error('Paste the complete encoded call (0x…), up to 128 KiB.');
    let call;
    try { call = api.registry.createType('Call', hex); }
    catch { throw new Error('The call cannot be decoded with this network’s current runtime.'); }
    if (call.toHex().toLowerCase() !== hex.toLowerCase()) throw new Error('The call contains trailing or non-canonical data.');
    const callHash = blake2AsHex(call.toU8a());
    if (expectedHash && callHash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error('The call data does not match this pending transaction’s hash.');
    return { call, callHash, callHex: call.toHex() };
}

export function pendingMultisig(option) {
    if (!option || option.isNone) return null;
    const value = option.unwrap();
    return {
        when: { height: value.when.height.toString(), index: value.when.index.toString() },
        approvals: Array.from(value.approvals, a => encodeAddress(decodeAddress(a.toString()), 88)),
        depositor: encodeAddress(decodeAddress(value.depositor.toString()), 88),
        deposit: value.deposit.toString()
    };
}

// Recover a preimage supplied in the first approval (including inside a batch
// or proxy). Some existing proposals were created with only a hash; those
// legitimately require the proposer to share the original call data.
export async function recoverMultisigCall(api, pending, callHash) {
    const blockHash = await api.rpc.chain.getBlockHash(pending.when.height);
    const signed = await api.rpc.chain.getBlock(blockHash);
    const tx = signed.block.extrinsics[Number(pending.when.index)];
    let visited = 0;
    function find(value, depth = 0) {
        if (!value || depth > 16 || ++visited > 1000) return '';
        if (value.section && value.method && value.args) {
            if (blake2AsHex(value.toU8a()).toLowerCase() === callHash.toLowerCase()) return value.toHex();
            return find(value.args, depth + 1);
        }
        if (value.isSome) return find(value.unwrap(), depth + 1);
        const items = Array.isArray(value) ? value : typeof value.toArray === 'function' ? value.toArray() : [];
        for (const item of items) { const hex = find(item, depth + 1); if (hex) return hex; }
        return '';
    }
    return find(tx?.method);
}

// Always read live storage. REST/indexer data is useful for a list, but cannot
// supply the timepoint or decide whether an approval will execute a call.
export async function prepareMultisig({ api, multisig, signer, callHex, callHash, mode = 'initiate' }) {
    if (!['initiate', 'approve', 'cancel'].includes(mode)) throw new Error('Unknown multisig action.');
    const genesis = api.genesisHash.toHex();
    const specVersion = api.runtimeVersion.specVersion.toString();
    const m = normalizeMultisig(multisig);
    if (!m.signers.some(a => sameAccount(a, signer))) throw new Error('Choose one of this multisig’s signers.');
    if (!api.tx.multisig || !api.query.multisig?.multisigs) throw new Error('The multisig pallet is not available on this network.');
    const max = Number(api.consts.multisig.maxSignatories.toString());
    if (m.signers.length > max) throw new Error(`This network allows at most ${max} signers.`);
    const others = m.signers.filter(a => !sameAccount(a, signer));
    const decoded = mode === 'cancel' ? null : decodeMultisigCall(api, callHex, callHash);
    const hash = decoded?.callHash || callHash;
    if (!/^0x[a-f\d]{64}$/i.test(hash || '')) throw new Error('Invalid multisig call hash.');
    const pending = m.threshold === 1 ? null : pendingMultisig(await api.query.multisig.multisigs(m.address, hash));
    if (mode !== 'initiate' && !pending) throw new Error('This transaction is no longer pending. Refresh the list.');
    if (mode === 'initiate' && pending) throw new Error('This call is already pending. Open it from Pending multisig transactions.');
    let tx, kind;
    if (mode === 'cancel') {
        if (!sameAccount(pending.depositor, signer)) throw new Error('Only the account that paid the deposit can cancel this transaction.');
        tx = api.tx.multisig.cancelAsMulti(m.threshold, others, pending.when, hash);
        kind = 'cancel';
    } else if (m.threshold === 1) {
        tx = api.tx.multisig.asMultiThreshold1(others, decoded.call);
        kind = 'execute';
    } else {
        const approved = pending?.approvals.some(a => sameAccount(a, signer));
        const count = (pending?.approvals.length || 0) + (approved ? 0 : 1);
        if (approved && count < m.threshold) throw new Error('This signer has already approved. Choose another signer.');
        const inner = api.tx(decoded.call);
        const info = await inner.paymentInfo(m.address);
        if (!info?.weight) throw new Error('Could not estimate the call’s execution weight.');
        kind = count >= m.threshold ? 'execute' : 'approve';
        // Include the full preimage on the first approval so other signers can
        // recover it from the originating block even on another browser.
        tx = kind === 'execute' || !pending
            ? api.tx.multisig.asMulti(m.threshold, others, pending?.when || null, decoded.call, info.weight)
            : api.tx.multisig.approveAsMulti(m.threshold, others, pending?.when || null, hash, info.weight);
    }
    const fee = (await tx.paymentInfo(signer)).partialFee.toString();
    const deposit = !pending && m.threshold > 1
        ? (BigInt(api.consts.multisig.depositBase.toString()) + BigInt(api.consts.multisig.depositFactor.toString()) * BigInt(m.threshold)).toString() : '0';
    if (api.genesisHash.toHex() !== genesis || api.runtimeVersion.specVersion.toString() !== specVersion) throw new Error('The network or runtime changed while preparing this transaction. Review it again.');
    // Fee estimates can drift slightly with block fullness. The reviewed call,
    // runtime, approvals, deposit and outer method must remain identical.
    const fingerprint = JSON.stringify({ genesis, specVersion, address: m.address, signer: encodeAddress(decodeAddress(signer), 88), hash, pending, kind, deposit, tx: tx.method.toHex() });
    return { tx, kind, fee, deposit, pending, callHash: hash, callHex: decoded?.callHex || null,
        call: decoded?.call || null, multisig: m, fingerprint, genesis, specVersion };
}
