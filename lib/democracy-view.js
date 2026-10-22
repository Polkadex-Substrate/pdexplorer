// The Democracy page's live controller: ties the chain feed
// (lib/democracy-live.js), the merge and patch plan (lib/democracy-patch.js)
// and the page's own render functions in script.js together, so script.js
// only supplies callbacks.
//
//   start()  on route entry: one feed on the browser's node link (only while
//            the link is up; liveWhileConnected) and a 30 s REST poll that is
//            the truth while the link is down. A second start() is a no-op,
//            except that it starts the feed if the api arrived since (called
//            from adoptChainApi when the page opened before the node link).
//   restart() the connected wallet changed: a new feed on the new account, so
//            "You voted" follows it. Nothing if the page is not open.
//   stop()   in routeTo, next to stopCouncilPolling: releases the feed, the
//            poll and the pending refetch timers.
//   data()   the REST snapshot with the live state merged over it.
//   update() after a live delivery or a quiet REST refresh: patch the cells
//            that changed, or ask for a full render when the shape changed.
//   stage(key, kind) the onStage callback of a vote or second in flight.
//
// The browser's fetch, timers and document are injected (deps) so
// test/democracy-view.test.js can drive it.

import { startDemocracyLive } from './democracy-live.js';
import { liveWhileConnected, freshPlan } from './collective-live.js';
import { overlayDemocracy, newRowCache, democracyCells, democracyFrame, democracyPatchPlan,
    patchDemocracyCells, demPendingStage, demPendingSettled } from './democracy-patch.js';

export const DEMOCRACY_POLL_MS = 30000;
// After a new referendum or proposal shows live, ask the server again once its
// event-driven sync has had time to run (proposer name, threshold, hash).
export const DEMOCRACY_CATCHUP_MS = 15000;
const REST_URL = '/api/democracy';

export function createDemocracyView(deps) {
    // Wrappers, not the bare natives: T.setTimeout(...) would call the browser's
    // setTimeout with this === T, which throws "Illegal invocation".
    const T = deps.timers || {
        setInterval: (...a) => setInterval(...a), clearInterval: (...a) => clearInterval(...a),
        setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a)
    };
    const visible = deps.visible || (() => typeof document === 'undefined' || document.visibilityState === 'visible');
    const doFetch = deps.fetch || ((...a) => fetch(...a));
    const warn = deps.onError || ((e) => console.warn('[democracy-live]', e && e.message));
    const cache = newRowCache();
    const pending = new Map();
    let carry = {};
    let ctl = null, ctlApi = null, poll = null, frame = null, queued = false;
    const timers = new Set();

    const feed = () => (ctl && ctl.current()) || null;
    const myVote = (i) => {
        const f = feed();
        const v = f && f.state.voting;
        if (!v || f.state.account !== deps.account()) return null;
        return v.votes[i] || null;
    };
    const cells = democracyCells({ ...deps.helpers, pending: (k) => pending.get(k) || null, myVote });

    const later = (fn, ms) => { const t = T.setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
    const settle = () => {
        for (const [k, p] of Array.from(pending)) {
            const i = Number(k.split(':')[1]);
            if (demPendingSettled(p, k.startsWith('ref:') ? myVote(i) : null)) pending.delete(k);
        }
    };
    const data = () => { settle(); const f = feed(); return overlayDemocracy(deps.getRest(), f ? f.state : null, cache); };

    function update() {
        const d = data();
        if (!d) return;
        const next = democracyFrame(deps.tab(), d, cells, deps.extra());
        const plan = democracyPatchPlan(frame, next);
        const root = deps.root();
        if (plan.full || !root) { deps.renderFull(); return; }
        patchDemocracyCells(root, plan.changed, next.cells);
        frame = next;
    }
    // Several deliveries in one tick (count, then refs) make one update.
    const schedule = () => { if (queued) return; queued = true; Promise.resolve().then(() => { queued = false; if (poll) update(); }); };

    const startFeed = (api) => {
        let first = { count: true, props: true };
        return startDemocracyLive(api, {
            account: deps.account(),
            toAddress: deps.toAddress,
            knownOpen: () => ((deps.getRest() || {}).referenda || []).filter(r => r && r.status === 'Ongoing').map(r => r.refIndex),
            restCount: () => Number((deps.getRest() || {}).referendumCount) || 0,
            onUpdate: (kind) => {
                if ((kind === 'count' || kind === 'props') && !first[kind]) later(() => deps.refresh({ fresh: true, quiet: true }), DEMOCRACY_CATCHUP_MS);
                if (kind in first) first[kind] = false;
                schedule();
            },
            onError: warn
        });
    };

    function start() {
        const api = deps.getApi();
        if (api && api !== ctlApi) {
            if (ctl) ctl.dispose();
            ctl = liveWhileConnected(api, startFeed, { onChange: schedule });
            ctlApi = api;
            if (poll) ctl.start();   // the page is already open: the api came late
        }
        if (poll) return;
        carry = {};
        if (ctl) ctl.start();
        poll = T.setInterval(() => { if (visible()) deps.refresh({ quiet: true }); }, DEMOCRACY_POLL_MS);
    }
    function stop() {
        if (ctl) ctl.stop();
        if (poll) { T.clearInterval(poll); poll = null; }
        for (const t of timers) T.clearTimeout(t);
        timers.clear();
        frame = null;
    }

    return {
        start,
        stop,
        restart() { if (!poll) return; stop(); start(); },
        active: () => !!poll,
        data,
        update,
        // After a full render: the frame the next update is compared with.
        rendered(d) { frame = d ? democracyFrame(deps.tab(), d, cells, deps.extra()) : null; },
        cell: (kind, row, part) => cells.cell(kind, row, part),
        // ?fresh=1 after a transaction, and for the next two polls (freshPlan).
        fetchRest(fresh) { return freshPlan(carry, REST_URL, !!fresh) ? doFetch(REST_URL + '?fresh=1', { cache: 'no-store' }) : doFetch(REST_URL); },
        stage(key, kind) {
            return (stage, m) => {
                if (demPendingStage(pending, key, kind, stage, m)) deps.refresh({ fresh: true, quiet: true });
                if (poll) update();
            };
        },
        pending: (key) => pending.get(key) || null
    };
}
