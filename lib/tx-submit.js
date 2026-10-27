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
// deps = { api, action, button, idleText, onError, onSuccess, onStage, show }
// where show is showTxStatus (lib/tx-status-card.js) and onStage never throws.

import { stageOf, BUTTON_STAGE_TEXT, initialTxTrack, txStep, asPreflight, PRE_INBLOCK_CAP_MS, FINALITY_CAP_MS, HEADER_READ_MS } from './tx-status.js';

// Options for signAndSend. withSignedTransaction: a wallet may return the
// whole signed transaction (Ledger metadata-hash flows, newer wallet builds);
// without this flag @polkadot/api 17.0.2 throws on it
// (submittable/createClass.js:206). allowCallDataAlteration: false makes the
// library refuse a returned transaction whose call data differs from the one
// built here (createClass.js:230, :265-269); its default is true (:194).
// The library also requires the returned transaction to be signed (:225) and
// then submits the wallet's bytes (:182, :187).
export function signAndSendOptions(signer) {
    return { signer, withSignedTransaction: true, allowCallDataAlteration: false };
}

// Which submission last made each button busy. A submission restores the
// button only while it still owns it; the first restore gives it up.
const buttonOwner = new WeakMap();

export function trackSignedTx({ api, action, button, idleText, onError, onSuccess, onStage, show }) {
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
    let unsub = null, preTimer = null, capTimer = null, txHash = null, blockNumber = null, sentBlock = null, lastEvents = null;
    const extra = () => ({ registry: api.registry, txHash, blockNumber, sentBlock });
    const stopWatching = () => {
        clearTimeout(preTimer); clearTimeout(capTimer);
        try { api.off('disconnected', onDrop); } catch (e) { /* already off */ }
        if (typeof unsub === 'function') { try { unsub(); } catch (e) { /* a dead link may refuse */ } }
    };
    const failed = (m) => { stopWatching(); restore(); stage(m.stage, m); if (onError) onError(m.text, m); };
    // Ends tracking without an error: the card says what is known, nothing red.
    const settle = (m) => { stopWatching(); restore(); stage(m.stage, m); };
    const onDrop = () => {
        const r = step({ type: 'disconnected' });
        if (r.act === 'unconfirmed') settle(show(action, 'unconfirmed', lastEvents, null, extra()));
        else if (r.act === 'fail') failed(show(action, 'failed', null, new Error('WebSocket disconnected'), extra()));
    };
    const onTimer = (type) => () => {
        const r = step({ type });
        if (r.act === 'waiting') settle(show(action, 'waiting', null, null, extra()));
        else if (r.act === 'stalled') settle(show(action, 'stalled', lastEvents, null, extra()));
    };
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
                preTimer = setTimeout(onTimer('preCap'), PRE_INBLOCK_CAP_MS);
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
            clearTimeout(preTimer);
            restore();
            stage('inBlock', m);
            if (onSuccess) onSuccess();
            if (!o.final) capTimer = setTimeout(onTimer('finalityCap'), FINALITY_CAP_MS);
        } else if (!o.final) stage('inBlock', m);   // back in a block after a Retracted
        if (o.final) { stopWatching(); stage('finalized', m); }
    };

    return {
        start() { setBusy('signing'); show(action, 'signing'); stage('signing'); },
        // buildTx threw: an explorer guard, shown as written, no support code.
        buildFailed(e) { if (step({ type: 'thrown' }).act === 'fail') failed(show(action, 'failed', null, asPreflight(e), extra())); },
        // Sign with the extension's address (its native SS58 format) so the
        // injected signer recognises the account. Results are handled one at
        // a time, in order, because reading the block number is async.
        async send(tx, address, signer) {
            try {
                let queue = Promise.resolve();
                unsub = await tx.signAndSend(address, signAndSendOptions(signer), (result) => {
                    queue = queue.then(() => onResult(result)).catch(e => console.warn('[tx-status]', e));
                });
                if (track.done) unsub(); else api.on('disconnected', onDrop);
            } catch (e) {
                if (step({ type: 'thrown' }).act === 'fail') failed(show(action, 'failed', null, e, extra()));
            }
        }
    };
}
