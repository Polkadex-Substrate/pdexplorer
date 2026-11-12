// Watches one signed submission from Sent to Finalized and keeps the status
// card, the button, the motion card (onStage) and the modal (onError,
// onSuccess) in step. The browser half of txStep (lib/tx-status.js): txStep
// decides, this carries it out. Split out of script.js's submitSignedTx so the
// whole path runs in test/tx-submit.test.js against a fake api, button and
// transaction; script.js keeps the wallet lookup and the buildTx call.
//
// The rules (Checker round 2 on the council feedback branch):
//   - success is decided from the events, never from inclusion (F-056), and
//     the subscription is kept until Finalized, capped at FINALITY_CAP_MS
//     after the first clean In block;
//   - a dropped link or FinalityTimeout after a clean In block is
//     "unconfirmed": neutral card, no onError, onSuccess has already run;
//     the same after a Retracted (no onError after onSuccess);
//   - a drop while the In block header is being read waits for that read
//     (bounded by HEADER_READ_MS): clean events end "unconfirmed" with the
//     block number when the read got it, never "failed";
//   - Retracted puts the card back to Sent with the buttons enabled and the
//     block number cleared; onSuccess never runs twice;
//   - a button is restored only by the submission that last made it busy,
//     so an older one ending (stalled, unconfirmed) cannot re-enable it
//     under a newer one still in flight;
//   - not in a block PRE_INBLOCK_CAP_MS after Sent is "waiting": neutral
//     card, buttons enabled, no onError, and watching stops;
//   - what buildTx throws (the explorer's own guards) is shown as written.
//
// The status subscription is not the only source of truth (CEO report,
// 3 Nov 2026: "Leave council" on an iPhone wallet's in-app browser stayed on
// Broadcasting). An iOS page that is backgrounded or locked suspends its
// timers and loses its socket, and polkadot-js does not resubscribe author_*
// subscriptions after a reconnect, so no further status may ever arrive.
// Between Sent and In block a watchdog therefore asks the chain every
// WATCHDOG_MS, on page wake (recheckSignedTxs, wired to visibilitychange and
// pageshow in script.js), on reconnect, and once more when the 90 s cap is due:
//   - verify(api), optional and action-specific, returning 'applied' when the
//     effect is on chain (the council seat is gone): "Confirmed on chain";
//   - the account's on-chain nonce (System.Account, not the pool-aware
//     accountNextIndex) past the transaction's nonce without that: something
//     with this nonce was processed but this one is not confirmed: neutral,
//     "check your account";
//   - a drop before inclusion is not a failure while either check is possible.
// A failed read of an In block result clears `reading`, so the caps apply
// again; a wallet that never answers releases the button after SIGNING_CAP_MS.
//
// Before the wallet is asked, send() checks that the account can pay the
// network fee (lib/fee-preflight.js): free balance above the existential
// deposit and any locks; reserved PDEX never pays. Skipped when the fee is
// paid in another asset (opts.assetId). Short: a failed card and
// onError with how much to send, the address to fund on the model
// (fundAddress), the button enabled for a retry, and the wallet never asked.
// Fee estimation failing: the wallet still gets to try and the signing card
// says the fee could not be checked. A pool rejection (the send rejects)
// and an Invalid, Dropped or Usurped status end the card at once.
//
// deps = { api, action, button, idleText, onError, onSuccess, onStage, show, verify }
// where show is showTxStatus (lib/tx-status-card.js) and onStage never throws.

import { stageOf, BUTTON_STAGE_TEXT, initialTxTrack, txStep, asPreflight, PRE_INBLOCK_CAP_MS, FINALITY_CAP_MS, HEADER_READ_MS, WATCHDOG_MS, SIGNING_CAP_MS } from './tx-status.js';
import { feePreflight } from './fee-preflight.js';

// Options for signAndSend. withSignedTransaction: a wallet may return the
// whole signed transaction (Ledger metadata-hash flows, newer wallet builds);
// without this flag @polkadot/api 17.0.2 throws on it
// (submittable/createClass.js:206). allowCallDataAlteration: false makes the
// library refuse a returned transaction whose call data differs from the one
// built here (createClass.js:230, :265-269); its default is true (:194).
// The library also requires the returned transaction to be signed (:225) and
// then submits the wallet's bytes (:182, :187).
// assetId: the fee is paid in that asset (ChargeAssetTxPayment), passed on
// to signAndSend; send() then skips the native PDEX fee preflight.
export function signAndSendOptions(signer, assetId) {
    const o = { signer, withSignedTransaction: true, allowCallDataAlteration: false };
    if (assetId != null) o.assetId = assetId;
    return o;
}

// send() refusing because the active wallet is no longer the one the action
// was opened for (stillValid below).
export const WALLET_CHANGED_UNSIGNED = 'Your wallet changed; nothing was signed.';
export const WALLET_CHANGED_SIGNED = 'Your wallet changed after signing; nothing was sent.';

// Which submission last made each button busy. A submission restores the
// button only while it still owns it; the first restore gives it up.
const buttonOwner = new WeakMap();

// The chain checks of every tracker between Sent and In block. Page wake
// (iOS resume) runs them at once instead of waiting for a suspended timer.
const watching = new Set();
export function recheckSignedTxs() {
    for (const check of Array.from(watching)) { try { check(); } catch (e) { /* each check guards itself */ } }
}

// A promise's value, or null when it rejects or takes over ms.
function within(ms, make) {
    return new Promise((resolve) => {
        const cut = setTimeout(() => resolve(null), ms);
        Promise.resolve().then(make).then(v => v, () => null).then((v) => { clearTimeout(cut); resolve(v); });
    });
}
const toNum = (x) => {
    if (x == null) return null;
    const n = Number(typeof x.toNumber === 'function' ? x.toNumber() : typeof x.toString === 'function' ? x.toString() : x);
    return Number.isFinite(n) ? n : null;
};

export function trackSignedTx({ api, action, button, idleText, onError, onSuccess, onStage, show, verify }) {
    const stage = onStage || (() => {});
    const idleHtml = button ? button.innerHTML : '';
    const token = {};
    const setBusy = (s) => { if (button) { buttonOwner.set(button, token); button.disabled = true; button.setAttribute('aria-busy', 'true'); button.innerHTML = `<i class='bx bx-loader-alt bx-spin' aria-hidden="true"></i> ${BUTTON_STAGE_TEXT[s]}`; } };
    const restore = () => {
        if (!button || buttonOwner.get(button) !== token) return;
        buttonOwner.delete(button);
        button.disabled = false; button.removeAttribute('aria-busy'); if (idleText) button.textContent = idleText; else button.innerHTML = idleHtml;
    };

    let track = initialTxTrack();
    const step = (ev) => { const r = txStep(track, ev); track = r.state; return r; };
    let unsub = null, preTimer = null, capTimer = null, dogTimer = null, signTimer = null, txHash = null, blockNumber = null, sentBlock = null, lastEvents = null;
    let address = null, txRef = null, txNonce = null, checking = null;
    const extra = () => ({ registry: api.registry, txHash, blockNumber, sentBlock, address });
    const stopDog = () => { clearTimeout(dogTimer); dogTimer = null; watching.delete(checkChain); };
    const stopWatching = () => {
        clearTimeout(preTimer); clearTimeout(capTimer); clearTimeout(signTimer); stopDog();
        try { api.off('disconnected', onDrop); } catch (e) { /* already off */ }
        try { api.off('connected', checkChain); } catch (e) { /* already off */ }
        if (typeof unsub === 'function') { try { unsub(); } catch (e) { /* a dead link may refuse */ } }
    };
    const failed = (m) => { stopWatching(); restore(); stage(m.stage, m); if (onError) onError(m.text, m); };
    // Ends tracking without an error: the card says what is known, nothing red.
    const settle = (m) => { stopWatching(); restore(); stage(m.stage, m); };
    // The on-chain nonce (System.Account at the best head), never
    // rpc.system.accountNextIndex: that one counts transactions still waiting
    // in the pool, so a pending transaction would look "processed".
    const canReadNonce = () => txNonce != null && !!address && typeof api.query?.system?.account === 'function';
    const canCheck = () => typeof verify === 'function' || canReadNonce();
    const onDrop = () => {
        const r = step({ type: 'disconnected', canCheck: canCheck() });
        if (r.act === 'unconfirmed') settle(show(action, 'unconfirmed', lastEvents, null, extra()));
        else if (r.act === 'fail') failed(show(action, 'failed', null, new Error('WebSocket disconnected'), extra()));
    };
    const onTimer = (type) => () => {
        const r = step({ type });
        if (r.act === 'waiting') settle(show(action, 'waiting', null, null, extra()));
        else if (r.act === 'stalled') settle(show(action, 'stalled', lastEvents, null, extra()));
        else if (r.act === 'walletSilent') settle(show(action, 'waiting', null, null, { ...extra(), walletSilent: true }));
    };
    // Ask the chain whether a sent transaction landed. One check at a time;
    // every RPC bounded by HEADER_READ_MS, and a failed or slow check is
    // simply "pending". Returns the running check so the cap can wait on it.
    function checkChain() {
        if (checking) return checking;
        if (track.done || !track.sent || track.reading || track.inBlockSeen) return Promise.resolve();
        checking = (async () => {
            const [verdict, next] = await Promise.all([
                typeof verify === 'function' ? within(HEADER_READ_MS, () => verify(api)) : null,
                canReadNonce()
                    ? within(HEADER_READ_MS, () => api.query.system.account(address)).then(a => toNum(a && a.nonce)) : null
            ]);
            const found = verdict === 'applied' ? 'applied' : next != null && next > txNonce ? 'processed' : 'pending';
            const r = step({ type: 'check', found });
            if (r.act === 'confirmed') {
                settle(show(action, 'confirmed', null, null, extra()));
                if (r.firstOk && onSuccess) onSuccess();
            } else if (r.act === 'processed') settle(show(action, 'processed', null, null, extra()));
        })().catch(e => console.warn('[tx-status] chain check', e)).finally(() => { checking = null; });
        return checking;
    }
    const armDog = () => {
        clearTimeout(dogTimer);
        if (track.done || track.inBlockSeen) return;
        dogTimer = setTimeout(() => { checkChain().then(armDog); }, WATCHDOG_MS);
    };
    // The 90 s cap: one last look at the chain when it can be asked, then
    // "still waiting".
    const onPreCap = () => { if (canCheck()) checkChain().then(onTimer('preCap')); else onTimer('preCap')(); };
    // The block number, or null if the read fails or takes over HEADER_READ_MS.
    const blockOf = (hash) => new Promise((resolve) => {
        const cut = setTimeout(() => resolve(null), HEADER_READ_MS);
        Promise.resolve().then(() => api.rpc.chain.getHeader(hash)).then(x => x.number.toNumber()).catch(() => null)
            .then((n) => { clearTimeout(cut); resolve(n); });
    });

    const onResult = async ({ status, events, dispatchError, txHash: h }) => {
        if (h) txHash = h.toHex();
        const r = step({ type: 'status', status });
        if (r.act === 'sent') {
            setBusy('broadcast');
            show(action, status, null, null, extra());
            stage('broadcast');
            if (r.armPreCap) {
                clearTimeout(signTimer);
                // Signed by now: the nonce the watchdog compares against.
                txNonce = toNum(txRef && txRef.nonce);
                preTimer = setTimeout(onPreCap, PRE_INBLOCK_CAP_MS);
                watching.add(checkChain);
                armDog();
                // Where the "waiting" card's lookup link starts.
                blockOf().then(n => { sentBlock = n; });
            }
            return;
        }
        if (r.act === 'resent') {
            blockNumber = null;
            restore();
            return stage('resent', show(action, status, null, null, extra()));
        }
        if (r.act === 'fail') return failed(show(action, status, null, null, extra()));
        if (r.act === 'unconfirmed') return settle(show(action, 'unconfirmed', lastEvents, null, extra()));
        if (r.act !== 'read') return;
        const s = stageOf(status);
        if (blockNumber == null) blockNumber = await blockOf(s === 'inBlock' ? status.asInBlock : status.asFinalized);
        if (track.done) return;
        // F-056: a failed extrinsic is still included in a block. So are a
        // forceBatch with failed items and a motion whose inner call failed;
        // show() reads those from the events and reports them as failed.
        let m;
        if (dispatchError) m = show(action, status, events, dispatchError, extra());
        else m = show(action, status, events, null, extra());
        const o = step({ type: 'outcome', stage: s, ok: m.stage !== 'failed' });
        if (o.act === 'fail') return failed(m);
        lastEvents = events;
        // The link dropped while the header was being read: clean events, so
        // included, finality unknown. onSuccess once if it has not run yet.
        if (o.act === 'unconfirmed') {
            settle(show(action, 'unconfirmed', events, null, extra()));
            if (o.firstOk && onSuccess) onSuccess();
            return;
        }
        if (o.act === 'firstOk') {
            clearTimeout(preTimer); stopDog();
            restore();
            stage('inBlock', m);
            if (onSuccess) onSuccess();
            if (!o.final) capTimer = setTimeout(onTimer('finalityCap'), FINALITY_CAP_MS);
        } else if (!o.final) stage('inBlock', m);   // back in a block after a Retracted
        if (o.final) { stopWatching(); stage('finalized', m); }
    };

    // A result that could not be read (show threw, say) must not leave
    // `reading` set: that switched off the 90 s cap and froze the button.
    const onReadError = (e) => {
        console.warn('[tx-status]', e);
        if (!track.reading) return;
        const r = step({ type: 'readError' });
        if (r.act === 'waiting') settle(show(action, 'waiting', null, null, extra()));
        else checkChain();
    };

    return {
        start() {
            setBusy('signing'); show(action, 'signing'); stage('signing');
            signTimer = setTimeout(onTimer('signingCap'), SIGNING_CAP_MS);
        },
        // buildTx threw: an explorer guard, shown as written, no support code.
        buildFailed(e) { if (step({ type: 'thrown' }).act === 'fail') failed(show(action, 'failed', null, asPreflight(e), extra())); },
        // Sign with the extension's address (its native SS58 format) so the
        // injected signer recognises the account. Results are handled one at
        // a time, in order, because reading the block number is async.
        //
        // stillValid() (submitSignedTx gives one to every caller): is the
        // account this was opened for still the active wallet? Asked after the
        // fee check, before the wallet is, and again after the wallet signed,
        // before anything is broadcast, so a switch during either wait signs
        // or sends nothing. With it, signing and sending are split (signAsync,
        // check, send) with the same options, so the signedTransaction and
        // call-data rules above hold on this path too.
        async send(tx, signingAddress, signer, { assetId, stillValid } = {}) {
            address = signingAddress; txRef = tx;
            const refuse = (message) => { if (step({ type: 'thrown' }).act === 'fail') failed(show(action, 'failed', null, { preflight: true, message }, extra())); };
            // A fee paid in another asset is not a PDEX question.
            const pre = assetId != null ? { status: 'skipped' } : await feePreflight(api, tx, signingAddress);
            if (track.done) return;   // the signing cap ended it while the fee was being checked
            if (stillValid && !stillValid()) return refuse(WALLET_CHANGED_UNSIGNED);
            if (pre.status === 'short') {
                if (step({ type: 'thrown' }).act === 'fail') failed(show(action, 'failed', null, { preflight: true, message: pre.text, fundAddress: pre.fundAddress }, extra()));
                return;
            }
            if (pre.status === 'unknown') show(action, 'signing', null, null, { ...extra(), feeWarning: pre.warning });
            try {
                let queue = Promise.resolve();
                const onStatus = (result) => { queue = queue.then(() => onResult(result)).catch(onReadError); };
                if (stillValid) {
                    const signed = await tx.signAsync(signingAddress, signAndSendOptions(signer, assetId));
                    if (track.done) return;   // the signing cap already ended the card: send nothing
                    if (!stillValid()) return refuse(WALLET_CHANGED_SIGNED);
                    txRef = signed;   // the wallet's own bytes when it returned them
                    unsub = await signed.send(onStatus);
                } else unsub = await tx.signAndSend(signingAddress, signAndSendOptions(signer, assetId), onStatus);
                if (track.done) unsub();
                else { api.on('disconnected', onDrop); api.on('connected', checkChain); }
            } catch (e) {
                if (step({ type: 'thrown' }).act === 'fail') failed(show(action, 'failed', null, e, extra()));
            }
        }
    };
}
