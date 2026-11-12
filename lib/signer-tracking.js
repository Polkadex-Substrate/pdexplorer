// Relays the wallet signer's optional update(id, result) on the split
// signAsync, re-check, send path (lib/tx-submit.js). Tested in
// test/signer-tracking.test.js.
//
// signAndSend calls signer.update(id, status) for every status of the
// transaction, with the id the wallet's signPayload or signRaw returned, and
// skips it when that id is -1 (@polkadot/api createClass #updateSigner).
// signAsync followed by send() drops the id, so the api never calls update on
// that path. trackingSigner(inner) gives one transaction a wrapper that
// records the id, and relay(result) to call from send()'s status callback.
//
//   - The wrapper defines only the sign methods the inner signer has: the api
//     takes signPayload whenever it is a function, else signRaw.
//   - The wrapper has no update of its own, so an api that someday calls
//     update after signAsync cannot reach the wallet a second time.
//   - What the wallet returns (signedTransaction included) is passed on as
//     it is.
//   - id 0 is a real id; -1 (the api's "no id") and a missing id are not
//     relayed. Signed more than once: the last signature decides, as the
//     api uses the id of the signing that produced what it sends.
//   - update is called as a method of the wallet's signer, never awaited, and
//     whatever it throws or rejects with is dropped: a wallet's update cannot
//     break or hold up a submission.
//   - A signer without update (or no signer) is passed through untouched and
//     relay does nothing.
//
// One wrapper per transaction: ids must never cross between submissions.

const hasId = (r) => r != null && r.id !== undefined && r.id !== null && r.id !== -1;

export function trackingSigner(inner) {
    if (!inner || typeof inner.update !== 'function') return { signer: inner, relay() {} };
    let id;
    let signed = false;
    const record = (r) => { signed = hasId(r); id = signed ? r.id : undefined; return r; };
    const signer = {};
    if (typeof inner.signPayload === 'function') signer.signPayload = (payload) => Promise.resolve(inner.signPayload(payload)).then(record);
    if (typeof inner.signRaw === 'function') signer.signRaw = (raw) => Promise.resolve(inner.signRaw(raw)).then(record);
    const relay = (status) => {
        if (!signed) return;
        try {
            const r = inner.update(id, status);
            if (r && typeof r.then === 'function') r.then(undefined, () => {});
        } catch (e) { /* a wallet's update never affects the submission */ }
    };
    return { signer, relay };
}
