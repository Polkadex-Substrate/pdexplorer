// One tick of the validator alerts (Sprint 6): for every validator stash that has a
// confirmed, live follow, read it once, detect events against the last stored
// observation, and mail each follower once per occurrence.
//
// How the guarantees hold:
//   - Off means off: with enabled() false the tick reads nothing, sends nothing and
//     stores nothing, so turning it on later starts from a clean baseline instead of
//     mailing what happened while it was off.
//   - Once per occurrence, also across a restart: the sent log is the existing
//     email_dispatches table, keyed (validator.<kind>, <stash>:<occurrence>,
//     subscriber). The row is reserved BEFORE the send, as dispatchToSubscribers does,
//     so a crash mid-send never double sends; a failed send is recorded and not retried.
//   - The last observation per stash lives in the existing kv table
//     (validator-alerts:obs:<stash>), written after the mails of that step. Losing it
//     only re-baselines; the sent log still blocks a repeat.
//   - A failed read of a stash skips it for this tick and keeps its stored observation.
//   - A stored observation older than MAX_OBSERVATION_AGE_MS (or with no timestamp) is
//     replaced without sending anything. Fields read as null keep their last known value
//     in the stored observation (mergeBaseline), so a partial read never erases a baseline.
//
// No imports of server state: server.js passes db, the reader, the sender and the origin.

import { detectValidatorEvents, mergeBaseline, alertMail } from './validator-alerts.js';

export const OBS_KEY = (stash) => `validator-alerts:obs:${stash}`;
const MAX_STASHES_PER_TICK = 100;
// An observation older than this is not a baseline: after downtime the tick stores a new
// one and sends nothing, so a restart never produces a burst of stale alerts.
export const MAX_OBSERVATION_AGE_MS = 2 * 60 * 60 * 1000;

export async function runValidatorAlertsTick({ db, readObservation, send, origin, enabled, nameOf = null, maxStashes = MAX_STASHES_PER_TICK, now = Date.now }) {
    if (typeof enabled === 'function' ? !enabled() : !enabled) return { skipped: 'off', sent: 0, stashes: 0 };
    const follows = db.getActiveValidatorAlertFollows();
    const byStash = new Map();
    for (const f of follows) {
        if (!byStash.has(f.stash)) byStash.set(f.stash, []);
        byStash.get(f.stash).push(f);
    }
    let sentCount = 0, read = 0;
    for (const [stash, list] of byStash) {
        if (read >= maxStashes) break;
        read++;
        let cur;
        try { cur = await readObservation(stash); } catch (e) { continue; }
        if (!cur) continue;
        const rec = db.getKv(OBS_KEY(stash));
        const prev = rec && rec.obs ? rec.obs : null;
        const age = rec && Number.isFinite(rec.at) ? now() - rec.at : Infinity;
        const stale = !!prev && age > MAX_OBSERVATION_AGE_MS;
        const events = stale ? [] : detectValidatorEvents(prev, { ...cur, stash });
        if (events.length) {
            let name = null;
            try { name = nameOf ? await nameOf(stash) : null; } catch (e) { name = null; }
            for (const event of events) {
                for (const f of list) {
                    try {
                        const eventKind = `validator.${event.kind}`;
                        const eventId = `${stash}:${event.occurrence}`;
                        if (!db.reserveEmailDispatch({ eventKind, eventId, subscriberId: f.subscriberId })) continue;
                        const unsubscribeUrl = `${origin}/api/validator-alerts/unsubscribe?token=${encodeURIComponent(f.unsubscribeToken)}`;
                        const m = alertMail(event, { origin, unsubscribeUrl, name });
                        try {
                            const r = await send({
                                to: f.email, subject: m.subject, text: m.text, html: m.html, tag: eventKind,
                                headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
                            });
                            db.recordEmailDispatchResult({ eventKind, eventId, subscriberId: f.subscriberId, providerId: (r && r.providerId) || null,
                                result: r && r.disabled ? 'sent-disabled' : (r && r.rateLimited ? 'rate-limited' : 'sent') });
                            sentCount++;
                        } catch (err) {
                            db.recordEmailDispatchResult({ eventKind, eventId, subscriberId: f.subscriberId, providerId: null, result: 'failed' });
                            // The address stays out of the log; the subscriber id is enough to trace it in email_dispatches.
                            console.warn(`[validator-alerts] send to subscriber #${f.subscriberId} failed (${eventKind}):`, err && err.message ? err.message : err);
                        }
                    } catch (err) {
                        console.warn('[validator-alerts] one follower skipped after an error:', err && err.message ? err.message : err);
                    }
                }
            }
        }
        db.setKv(OBS_KEY(stash), { obs: stale ? cur : mergeBaseline(prev, cur), at: now() });
    }
    return { skipped: null, sent: sentCount, stashes: read };
}
