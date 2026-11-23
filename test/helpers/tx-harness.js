// The signing tracker (lib/tx-submit.js) against a fake api, button and transaction, the same harness
// as test/tx-submit.test.js, with two additions for the post-action refresh tests:
//   * opts.core: a lib/post-action.js core. The harness then passes show and onStage through
//     core.observe(action) exactly as script.js submitSignedTx does (design 2.1).
//   * a recorder: every callback the tracker makes (show, onStage, onError, onSuccess) appends one
//     entry with the button state and the card stage at that moment, so a wrapped run can be
//     compared with an unwrapped one entry for entry.

import { trackSignedTx } from '../../lib/tx-submit.js';
import { buildTxModel } from '../../lib/tx-status.js';

export const HASH = '0x' + 'ab'.repeat(32);
export const BLOCKS = { '0xb1': 42, '0xb2': 43 };
export const ok = [{ event: { section: 'system', method: 'ExtrinsicSuccess', data: [] } }];
export const bad = [{ event: { section: 'system', method: 'ExtrinsicFailed', data: [{ isBadOrigin: true, type: 'BadOrigin' }] } }];
export const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
export const READY = { type: 'Ready' };
export const IN1 = { type: 'InBlock', asInBlock: '0xb1' };
export const IN2 = { type: 'InBlock', asInBlock: '0xb2' };
export const FIN1 = { type: 'Finalized', asFinalized: '0xb1' };
export const FIN2 = { type: 'Finalized', asFinalized: '0xb2' };

const header = (h) => Promise.resolve({ number: { toNumber: () => (h === undefined ? 99 : BLOCKS[h]) } });
export const fakeButton = () => ({ disabled: false, attrs: {}, innerHTML: 'Vote', textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });

export function harness(opts = {}) {
    const listeners = {};
    const api = {
        registry: opts.registry || {},
        on: (e, f) => { (listeners[e] = listeners[e] || []).push(f); },
        off: (e, f) => { listeners[e] = (listeners[e] || []).filter(x => x !== f); },
        rpc: { chain: { getHeader: opts.getHeader || header } },
        query: opts.query || undefined
    };
    const record = [];
    const btnState = (b) => ({ disabled: b.disabled, busy: b.attrs['aria-busy'] || null, html: b.innerHTML, text: b.textContent });
    const shown = [];
    const button = opts.button || fakeButton();
    const calls = { onError: [], onSuccess: 0, stages: [], unsub: 0 };
    const showInner = (a, st, ev, err, ex) => {
        const m = buildTxModel(a, st, ev, err, ex);
        shown.push(m);
        record.push({ at: 'show', stage: m.stage, tone: m.tone, stageText: m.stageText || null, button: btnState(button) });
        return m;
    };
    const stageInner = (s, m) => { calls.stages.push(s); record.push({ at: 'onStage', stage: s, model: m ? m.stage : null, button: btnState(button) }); };
    const action = opts.action || { id: 'a1', key: 'council.vote', params: { aye: true, idx: 1, body: 'council' } };
    let show = showInner, onStage = stageInner;
    let seen = null;
    if (opts.core) {
        seen = opts.core.observe(action);
        show = seen.show(showInner);
        onStage = seen.stage(stageInner);
    }
    let cb = null;
    const tx = { signAndSend: (addr, o, f) => { cb = f; return Promise.resolve(() => { calls.unsub++; }); }, nonce: opts.nonce };
    const run = trackSignedTx({
        api, button, show, idleText: 'Vote', action, verify: opts.verify,
        onError: (t) => { calls.onError.push(t); record.push({ at: 'onError', text: t, button: btnState(button) }); },
        onSuccess: () => { calls.onSuccess++; record.push({ at: 'onSuccess', button: btnState(button) }); },
        onStage
    });
    const emit = async (status, events) => { cb({ status, events, txHash: { toHex: () => opts.hash || HASH } }); await flush(); };
    const last = () => shown[shown.length - 1];
    const drop = async () => { (listeners.disconnected || []).slice().forEach(f => f()); await flush(); };
    return { run, tx, emit, shown, last, button, calls, drop, listeners, record, seen, api, show, onStage };
}
