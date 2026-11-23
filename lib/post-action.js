// The post-action core (design cto-team/plans/2026-11-22-post-action-refresh-design.md, sections 2.1, 2.3, 2.4,
// 2.5 and 4). Import-free, no DOM. It watches every submission through two wrappers that script.js
// submitSignedTx adds at its one trackSignedTx line; nothing in lib/tx-submit.js changes.
//
//   seen.show(fn):  returns (...args) => { m = fn(...args); note(args); return m }. The SAME model object,
//                   synchronously; note() only copies events, block number, tx hash and signer, in try/catch.
//   seen.stage(fn): calls fn(s, m) FIRST (a throw there is the caller's, as before), then queues the core's
//                   own handling as a microtask, in try/catch. Button, card, onError and onSuccess order inside
//                   tx-submit is unchanged; the core runs after the existing success point.
//
// Stage handling (2.4): an inclusion with clean events records what the events prove (lib/action-effects.js)
// in the known-results store and tells the subscribed components to reload; a Retracted withdraws it and
// leaves a reorg marker; any failure end withdraws everything of that transaction. Nothing is ever recorded
// before inclusion. In R1 the server cannot yet say "I have indexed block N" (that is R2), so there is no
// polling: subscribers repaint from the store, and one deadline per hold repaints when the hold ends. No timer
// is armed while the tab is hidden; resume() repaints at once on return.

const CHAIN_FALLBACK = ['balance', 'staking.ledger', 'staking.nominations', 'locks', 'proxies', 'multisig.pending', 'treasury.spends'];

export function createPostAction({ effects, known, same = (a, b) => a === b, now = Date.now, visible = () => true,
    setTimer = null, clearTimer = null, log = () => {}, defer = (f) => queueMicrotask(f), chainDomains = CHAIN_FALLBACK } = {}) {
    const subs = new Set();
    let seq = 0;
    let deadline = null;      // { timer, at }
    let dueWhileHidden = false;
    const safe = (fn, ...a) => { try { return fn(...a); } catch (e) { try { log(e); } catch (_) { /* never */ } return undefined; } };
    const sameAccount = (a, b) => { if (a == null || b == null) return a == null && b == null; try { return a === b || !!same(a, b); } catch (e) { return false; } };

    function notify({ account = null, domains = [], block = null, reason = 'notify', origin = 'self', info = null } = {}) {
        for (const sub of Array.from(subs)) {
            if (!domains.includes(sub.domain)) continue;
            const shown = safe(sub.account);
            if (account != null && !sameAccount(shown, account)) continue;
            safe(sub.reload, { block, fresh: true, reason, origin, info });
        }
    }
    const notifyAll = (reason, origin = 'self') => { for (const sub of Array.from(subs)) safe(sub.reload, { block: null, fresh: true, reason, origin, info: null }); };
    const notifyChanges = (eff, block, reason, filter = null) => {
        for (const c of (eff && eff.changes) || []) {
            const domains = filter ? c.domains.filter(filter) : c.domains;
            if (domains.length) notify({ account: c.account, domains, block, reason });
        }
    };

    function fireDeadline() {
        deadline = null;
        if (!safe(visible)) { dueWhileHidden = true; return; }
        notifyAll('deadline');
    }
    function armDeadline(ms) {
        if (!setTimer) return;
        if (!safe(visible)) { dueWhileHidden = true; return; }
        const at = safe(now) + ms;
        if (deadline && deadline.at >= at) return;
        if (deadline && clearTimer) safe(clearTimer, deadline.timer);
        deadline = { at, timer: safe(setTimer, fireDeadline, ms) };
    }

    // Other tabs: the store's storage event. Own writes are already followed by our own notify.
    if (known && typeof known.onChange === 'function') safe(() => known.onChange((ev) => { if (ev && ev.origin === 'other-tab') notifyAll('other-tab', 'other-tab'); }));

    function onStage(run, s, m) {
        const ref = run.txHash || run.id;
        if (s === 'inBlock' || s === 'unconfirmed') {
            if (s === 'unconfirmed' && run.retracted) {
                // The block it was in was replaced, then the link dropped: it may still land, so its rows
                // are neither claimed nor offered again; they are held for the bounded hold (UX U7).
                const keys = ((run.effects && run.effects.known) || []);
                safe(() => known.withdraw(ref, 'reorg-unknown'));
                if (keys.length) safe(() => known.add(keys.map(k => ({ ...k, op: 'hold', block: null, txHash: ref }))));
                run.retracted = false;
                notifyChanges(run.effects, null, 'held');
                if (keys.length) armDeadline(known.holdMs + 1);
                return;
            }
            if (!m || m.stage === 'failed' || !m.outcome || m.outcome.ok === false || !Array.isArray(run.events) || !run.events.length) return;
            if (s === 'inBlock') run.retracted = false;
            const mark = `${ref}@${run.blockNumber}`;
            if (run.applied === mark) return;
            const eff = safe(effects, { key: run.key, params: run.params, stage: s, events: run.events, blockNumber: run.blockNumber,
                txHash: run.txHash, signer: run.signer, outcome: m.outcome, same });
            if (!eff) return;
            run.applied = mark;
            run.effects = eff;
            if (eff.known.length) safe(() => known.add(eff.known.map(k => ({ ...k, block: run.blockNumber, txHash: ref }))));
            const info = { removed: eff.known.filter(k => k.op === 'remove').length, held: eff.known.filter(k => k.op === 'hold').length, key: run.key };
            for (const c of eff.changes) notify({ account: c.account, domains: c.domains, block: run.blockNumber, reason: 'inBlock', info });
            if (info.held) armDeadline(known.holdMs + 1);
            return;
        }
        if (s === 'resent') {
            const eff = run.effects;
            run.events = null; run.blockNumber = null; run.applied = null; run.retracted = true;
            safe(() => known.withdraw(ref, 'reorg'));
            if (eff && eff.known.length) {
                const seen = new Set();
                const markers = [];
                for (const k of eff.known) {
                    const id = `${k.account}|${k.domain}`;
                    if (seen.has(id)) continue;
                    seen.add(id);
                    markers.push({ account: k.account, domain: k.domain, op: 'reorg', key: ref, value: run.key, txHash: ref });
                }
                safe(() => known.add(markers));
            }
            notifyChanges(eff, null, 'reorg');
            return;
        }
        if (s === 'confirmed') { notifyChanges(chainChanges(run), null, 'recheck'); return; }
        if (s === 'failed' || s === 'cancelled' || s === 'waiting' || s === 'processed' || s === 'unverified') {
            safe(() => known.withdraw(ref, 'failed'));
            if (run.effects) notifyChanges(run.effects, null, 'failed');
            run.effects = null; run.retracted = false;
            if (s === 'processed' || s === 'unverified') notifyChanges(chainChanges(run), null, 'recheck');
        }
        // signing, broadcast, finalized, stalled: nothing new.
    }
    // The action's chain domains for a re-read that claims nothing (confirmed, processed, unverified).
    function chainChanges(run) {
        const ctx = { key: run.key, params: run.params, stage: 'inBlock', events: [], blockNumber: null, txHash: run.txHash, signer: run.signer, outcome: { ok: true }, same };
        const eff = safe(effects, ctx);
        if (!eff) return null;
        return { changes: eff.changes.map(c => ({ account: c.account, domains: c.domains.filter(d => chainDomains.includes(d)) })) };
    }

    return {
        observe(action) {
            const run = { id: `run-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`, key: action && action.key, params: (action && action.params) || {},
                events: null, blockNumber: null, txHash: null, signer: null, effects: null, applied: null, retracted: false };
            const note = (ev, x) => {
                if (Array.isArray(ev)) run.events = ev;
                if (x && typeof x === 'object') {
                    run.blockNumber = x.blockNumber == null ? null : x.blockNumber;
                    if (x.txHash) run.txHash = String(x.txHash);
                    if (x.address) run.signer = x.address;
                }
            };
            return {
                show(fn) { return (...args) => { const m = fn(...args); try { note(args[2], args[4]); } catch (e) { safe(log, e); } return m; }; },
                stage(inner) {
                    return (s, m) => {
                        const r = typeof inner === 'function' ? inner(s, m) : undefined;
                        try { defer(() => safe(onStage, run, s, m)); } catch (e) { safe(log, e); }
                        return r;
                    };
                }
            };
        },
        subscribe(domain, { account = () => null, reload = () => null, state = null } = {}) {
            const sub = { domain, account, reload, state };
            subs.add(sub);
            return () => subs.delete(sub);
        },
        notify: (o) => { try { notify(o); } catch (e) { safe(log, e); } },
        resume() { dueWhileHidden = false; notifyAll('resume'); },
        accountChanged() { notifyAll('account'); }
    };
}
