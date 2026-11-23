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
// polling: subscribers repaint from the store, and ONE deadline repaints when the next hold or reorg bound
// passes. The deadline is armed from the STORE (known.nextBound(): the earliest savedAt + holdMs of any hold
// or reorg entry), so it is right after a reload, another tab's write or a hidden spell: on creation, on
// resume(), after a hold, on resent, on another tab's change and after each deadline (the next bound). The
// earliest bound is kept. No timer is armed while the tab is hidden; resume() repaints at once on return.
//
// R2, layer (c) (design 2.5): with caughtUp(domain, freshness, block) and deadlineMs(domain, freshness)
// injected (lib/freshness.js), an inclusion polls instead of repainting once. For each subscribed component
// that shows an affected account and domain, its reload is called with { poll: true } at inclusion, then
// after 2, 4, 8, 16, 30, 30... s; reload returns (or resolves to) the server's freshness, and the poll
// stops when every affected domain of that component has caught up with the block. A domain past its
// deadline (60 s chain, 180 s indexed, longer for a slower indexer) is given up: the component is told
// could-not-refresh. One poll per (component, account): a later inclusion merges in, the highest block wins,
// and one read is in flight at a time. No attempt and no timer while hidden; resume() runs what is due, and
// a poll past its deadline still makes that one attempt before it gives up. The component showing another
// account (or accountChanged) cancels the poll. A component may be told:
//   state('updating', { since, block, domains })              the first read was behind
//   state('current', { since, block, domains })               every affected domain caught up
//   state('could-not-refresh', { since, block, domains, gaveUp })
// Without caughtUp the core is exactly R1's.

const CHAIN_FALLBACK = ['balance', 'staking.ledger', 'staking.nominations', 'locks', 'proxies', 'multisig.pending', 'treasury.spends'];
const BACKOFF_FALLBACK = [2000, 4000, 8000, 16000, 30000];

export function createPostAction({ effects, known, same = (a, b) => a === b, now = Date.now, visible = () => true,
    setTimer = null, clearTimer = null, log = () => {}, defer = (f) => queueMicrotask(f), chainDomains = CHAIN_FALLBACK,
    caughtUp = null, deadlineMs = null, backoffMs = BACKOFF_FALLBACK } = {}) {
    const subs = new Set();
    const polls = new Set();
    const polling = typeof caughtUp === 'function' && typeof setTimer === 'function';
    let seq = 0;
    let deadline = null;      // { timer, at }
    let dueWhileHidden = false;
    const safe = (fn, ...a) => { try { return fn(...a); } catch (e) { try { log(e); } catch (_) { /* never */ } return undefined; } };
    const sameAccount = (a, b) => { if (a == null || b == null) return a == null && b == null; try { return a === b || !!same(a, b); } catch (e) { return false; } };

    function notify({ account = null, domains = [], block = null, reason = 'notify', origin = 'self', info = null } = {}) {
        for (const sub of Array.from(subs)) {
            const mine = sub.domains.filter(d => domains.includes(d));
            if (!mine.length) continue;
            const shown = safe(sub.account);
            if (account != null && !sameAccount(shown, account)) continue;
            const pollable = polling && block != null && Number.isFinite(Number(block)) ? mine.filter(d => !safe(caughtUp, d, null, block) && deadlineOf(d, null) > 0) : [];
            if (pollable.length) startPoll(sub, account != null ? account : shown, pollable, Number(block), reason, origin, info);
            else safe(sub.reload, { block, fresh: true, reason, origin, info });
        }
    }

    // --- layer (c): polls (R2) ---
    function deadlineOf(d, f) { const ms = typeof deadlineMs === 'function' ? Number(safe(deadlineMs, d, f)) : 180_000; return Number.isFinite(ms) && ms > 0 ? ms : 0; }
    function stopTimer(p) { if (p.timer && clearTimer) safe(clearTimer, p.timer); p.timer = null; }
    function endPoll(p, s) {
        stopTimer(p);
        p.done = true;
        polls.delete(p);
        if (s && typeof p.sub.state === 'function') safe(p.sub.state, s, { since: p.since, block: p.block, domains: [...p.domains], gaveUp: [...p.gaveUp] });
    }
    function startPoll(sub, account, domains, block, reason, origin, info) {
        const t = safe(now);
        let p = Array.from(polls).find(x => x.sub === sub && sameAccount(x.account, account));
        if (p) {
            p.block = Math.max(p.block, block);
            for (const d of domains) { p.domains.add(d); p.caught.delete(d); p.gaveUp.delete(d); p.startedAt.set(d, t); }
            if (p.inFlight) { p.again = true; return; }
        } else {
            p = { sub, account, block, domains: new Set(domains), caught: new Set(), gaveUp: new Set(), startedAt: new Map(domains.map(d => [d, t])),
                since: t, attempt: 0, timer: null, dueAt: null, inFlight: false, again: false, done: false, said: false };
            polls.add(p);
        }
        attempt(p, reason, origin, info);
    }
    function attempt(p, reason = 'poll', origin = 'self', info = null) {
        if (p.done) return;
        stopTimer(p);
        if (!safe(visible)) { p.dueAt = safe(now); return; }
        if (p.inFlight) { p.again = true; return; }
        if (!sameAccount(safe(p.sub.account), p.account)) { endPoll(p, null); return; }   // the component moved on
        p.inFlight = true; p.dueAt = null; p.attempt++;
        let r;
        try { r = p.sub.reload({ block: p.block, fresh: true, reason, origin, info, poll: true }); } catch (e) { safe(log, e); r = null; }
        Promise.resolve(r).then((f) => f, (e) => { safe(log, e); return null; }).then((f) => settle(p, f === undefined ? null : f));
    }
    function settle(p, f) {
        p.inFlight = false;
        if (p.done) return;
        if (!sameAccount(safe(p.sub.account), p.account)) { endPoll(p, null); return; }
        const t = safe(now);
        for (const d of p.domains) {
            if (p.caught.has(d) || p.gaveUp.has(d)) continue;
            if (safe(caughtUp, d, f, p.block)) p.caught.add(d);
            else if (t - p.startedAt.get(d) >= deadlineOf(d, f)) p.gaveUp.add(d);
        }
        if (p.again) { p.again = false; attempt(p); return; }
        const waiting = [...p.domains].filter(d => !p.caught.has(d) && !p.gaveUp.has(d));
        if (!waiting.length) { endPoll(p, p.gaveUp.size ? 'could-not-refresh' : 'current'); return; }
        if (!p.said && typeof p.sub.state === 'function') { p.said = true; safe(p.sub.state, 'updating', { since: p.since, block: p.block, domains: waiting }); }
        const steps = Array.isArray(backoffMs) && backoffMs.length ? backoffMs : BACKOFF_FALLBACK;
        const step = Number(steps[Math.min(p.attempt - 1, steps.length - 1)]) || 30_000;
        const nextDeadline = Math.min(...waiting.map(d => p.startedAt.get(d) + deadlineOf(d, f)));
        const delay = Math.max(0, Math.min(step, nextDeadline - t));
        p.dueAt = t + delay;
        if (!safe(visible)) return;
        p.timer = safe(setTimer, () => { p.timer = null; attempt(p); }, delay);
    }
    // Back on screen: every poll that is due runs now; the others are re-armed for what is left.
    function resumePolls() {
        const t = safe(now);
        for (const p of Array.from(polls)) {
            if (p.inFlight || p.done || p.dueAt == null) continue;
            if (t >= p.dueAt) attempt(p, 'resume');
            else if (!p.timer && setTimer) p.timer = safe(setTimer, () => { p.timer = null; attempt(p); }, p.dueAt - t);
        }
    }
    function cancelPolls(address) {
        for (const p of Array.from(polls)) if (address === undefined || !sameAccount(p.account, address)) endPoll(p, null);
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
        arm();   // the next bound, if another hold or reorg entry is still inside its hold
    }
    // One timer, at the earliest bound in the store (+1 ms: a hold is active while age < holdMs).
    function arm() {
        if (!setTimer || !known || typeof known.nextBound !== 'function') return;
        if (!safe(visible)) { dueWhileHidden = true; return; }
        const bound = safe(() => known.nextBound());
        if (bound == null) return;
        const at = bound + 1;
        if (deadline && deadline.at <= at) return;   // keep the EARLIEST bound
        if (deadline && clearTimer) safe(clearTimer, deadline.timer);
        deadline = { at, timer: safe(setTimer, fireDeadline, Math.max(0, at - safe(now))) };
    }

    // Other tabs: the store's storage event. Own writes are already followed by our own notify.
    if (known && typeof known.onChange === 'function') safe(() => known.onChange((ev) => { if (ev && ev.origin === 'other-tab') { notifyAll('other-tab', 'other-tab'); arm(); } }));

    function onStage(run, s, m) {
        const ref = run.txHash || run.id;
        // A Finalized after a Retracted with no second In block is the payout's inclusion (F5).
        const finalAfterReorg = s === 'finalized' && !run.applied;
        if (s === 'inBlock' || s === 'unconfirmed' || finalAfterReorg || (s === 'waiting' && run.retracted)) {
            if ((s === 'unconfirmed' || s === 'waiting') && run.retracted) {
                // The block it was in was replaced, then the link dropped or the finality cap passed: it may
                // still land, so its rows are neither claimed nor offered again; they are held for the bounded
                // hold (UX U7).
                const keys = ((run.effects && run.effects.known) || []);
                safe(() => known.withdraw(ref, 'reorg-unknown'));
                if (keys.length) safe(() => known.add(keys.map(k => ({ ...k, op: 'hold', block: null, txHash: ref }))));
                run.retracted = false;
                notifyChanges(run.effects, null, 'held');
                arm();
                return;
            }
            if (!m || m.stage === 'failed' || !m.outcome || m.outcome.ok === false || !Array.isArray(run.events) || !run.events.length) return;
            // Back in a block after a replaced one: the reorg marker ends here, whatever these events prove.
            if (run.retracted && (s === 'inBlock' || finalAfterReorg)) { safe(() => known.withdraw(ref, 'reincluded')); run.retracted = false; }
            const mark = `${ref}@${run.blockNumber}`;
            if (run.applied === mark) return;
            const eff = safe(effects, { key: run.key, params: run.params, stage: finalAfterReorg ? 'inBlock' : s, events: run.events, blockNumber: run.blockNumber,
                txHash: run.txHash, signer: run.signer, outcome: m.outcome, same });
            if (!eff) return;
            run.applied = mark;
            run.effects = eff;
            if (eff.known.length) safe(() => known.add(eff.known.map(k => ({ ...k, block: run.blockNumber, txHash: ref }))));
            const info = { removed: eff.known.filter(k => k.op === 'remove').length, held: eff.known.filter(k => k.op === 'hold').length, key: run.key };
            for (const c of eff.changes) notify({ account: c.account, domains: c.domains, block: run.blockNumber, reason: 'inBlock', info });
            if (info.held) arm();
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
            arm();
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

    arm();   // on load: a hold or reorg entry from before the reload repaints at its bound
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
        // domain: one domain, or every domain this component draws (R2: one re-read serves them all).
        subscribe(domain, { account = () => null, reload = () => null, state = null } = {}) {
            const sub = { domain, domains: Array.isArray(domain) ? domain.slice() : [domain], account, reload, state };
            subs.add(sub);
            return () => { subs.delete(sub); for (const p of Array.from(polls)) if (p.sub === sub) endPoll(p, null); };
        },
        notify: (o) => { try { notify(o); } catch (e) { safe(log, e); } },
        resume() { dueWhileHidden = false; notifyAll('resume'); arm(); resumePolls(); },
        arm,
        // A wallet switch: polls for any other account are cancelled (their results are never drawn here).
        accountChanged(address) { cancelPolls(address); notifyAll('account'); }
    };
}
