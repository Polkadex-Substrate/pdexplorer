// Event-driven refresh of the governance snapshots (server side).
//
// The democracy and treasury snapshots renewed only on their own timers, so a
// new referendum, a vote or a treasury approval took minutes to reach the
// explorer. The indexer's forward pass already holds every event of each new
// block, so server.js asks govSyncsForEvents which syncs a block calls for and
// starts them at once. Any governance event refreshes democracy, treasury and
// council together, because their effects cross: a council motion approves a
// treasury proposal or fast-tracks a referendum, an election changes the
// seats that vote on motions. The technical committee refreshes on its own
// events only.
//
// makeSyncRunner keeps that cheap and safe. One forward pass names each sync
// at most once. Two runs of the same sync never overlap (timer and trigger
// share the runner). A trigger that arrives while the sync is running is not
// dropped: it asks for exactly one more run after the current one, because
// the running pass may have read storage before the triggering block.
//
// No imports: test/gov-refresh.test.js drives it directly.

export const GOV_TRIGGER_SECTIONS = Object.freeze([
    'democracy',
    'council', 'councilCollective', 'generalCouncil',
    'technicalCommittee',
    'elections', 'phragmenElection', 'electionsPhragmen',
    'treasury'
]);
const TRIGGERS = new Set(GOV_TRIGGER_SECTIONS.map(s => s.toLowerCase()));
const SHARED = ['council', 'treasury', 'democracy'];

// events: [{ section, method, ... }]. Returns the sync names to run, each once.
export function govSyncsForEvents(events) {
    let gov = false, tc = false;
    for (const e of Array.isArray(events) ? events : []) {
        const s = e && typeof e.section === 'string' ? e.section.toLowerCase() : '';
        if (!TRIGGERS.has(s)) continue;
        gov = true;
        if (s === 'technicalcommittee') tc = true;
        if (tc) break;
    }
    if (!gov) return [];
    return tc ? SHARED.concat('technicalCommittee') : SHARED.slice();
}

// opts.onError(name, err) is called when a run throws; the runner carries on.
export function makeSyncRunner(opts = {}) {
    const onError = typeof opts.onError === 'function' ? opts.onError : () => {};
    const slots = new Map();   // name -> { running: Promise|null, again: boolean }
    const slot = (name) => { let s = slots.get(name); if (!s) slots.set(name, s = { running: null, again: false }); return s; };
    return {
        run(name, fn) {
            const s = slot(name);
            if (s.running) { s.again = true; return s.running; }
            s.running = (async () => {
                try {
                    do {
                        s.again = false;
                        try { await fn(); } catch (e) { onError(name, e); }
                    } while (s.again);
                } finally { s.running = null; }
            })();
            return s.running;
        },
        busy: (name) => !!(slots.get(name) && slots.get(name).running)
    };
}

// ?fresh=1 is the browser's refetch right after its own transaction landed:
// answered with no-store so neither the browser nor the CDN hands back the
// copy from before it.
export function isFreshRequest(query) {
    const v = query && query.fresh;
    return typeof v === 'string' ? v !== '' && v !== '0' : !!v;
}
