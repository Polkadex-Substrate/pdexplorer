// One tick of the validator alerts (Sprint 6): for every validator stash that has a
// confirmed, live follow, read it once, detect events against the last stored
// observation, and mail each follower once per occurrence.
//
// How the guarantees hold:
//   - Off means off: with enabled() false the tick reads nothing, sends nothing and
//     stores nothing, so turning it on later starts from a clean baseline instead of
//     mailing what happened while it was off.
//   - Once per occurrence, also across a restart: the sent log is the existing
//     email_dispatches table, keyed (validator.<kind>, <stash>:<occurrence>, subscriber).
//     The row is reserved BEFORE the send, together with a validator_alert_pending row
//     (one transaction), so two ticks never reserve the same alert twice.
//   - An alert is final only when the mail provider accepted it. A send that was refused by the
//     per-recipient limiter (email.js returns { rateLimited: true } WITHOUT sending) or that threw
//     stays pending and is retried on later ticks, reusing the reserved row, up to
//     MAX_ALERT_ATTEMPTS attempts within MAX_ALERT_AGE_MS; then it is settled as a final failure
//     with one console.error line naming the kind and the stash (never the address). The pending
//     row lives in the database, not in the baseline, so it survives the baseline moving on, a
//     restart and a lease handover.
//   - Crash window: a crash after the provider accepted a mail but before it was marked sent
//     leaves the row pending, so the alert is sent again (a possible duplicate). The other choice,
//     marking sent before the send, would lose the alert on a crash. For a safety alert a rare
//     duplicate is the lesser evil.
//   - Within one tick pending alerts go most important first (slashed, disabled, not-elected,
//     then the rest), so when the limiter blocks a recipient it is the less important mail that waits.
//   - The last observation per stash lives in the existing kv table
//     (validator-alerts:obs:<stash>), written after the alerts of that step were queued. Losing it
//     only re-baselines; the sent log still blocks a repeat.
//   - A failed read of a stash skips it for this tick and keeps its stored observation (pending
//     alerts are still retried). Fields read as null keep their last known value in the stored
//     observation (mergeBaseline), so a partial read never erases a baseline.
//   - A stored observation older than MAX_OBSERVATION_AGE_MS (or with no timestamp) is replaced
//     and the transient kinds (not elected, disabled, ...) are not sent for the gap. The slash
//     field is a monotonic era number, so a slash that moved it forward since a KNOWN old state
//     (an era, or known none; not a failed read, not the old null shape) is still mailed.
//
// No imports of server state: server.js passes db, the reader, the sender and the origin.

import { detectValidatorEvents, mergeBaseline, alertMail } from './validator-alerts.js';

export const OBS_KEY = (stash) => `validator-alerts:obs:${stash}`;
const MAX_STASHES_PER_TICK = 100;
// An observation older than this is not a baseline: after downtime the tick stores a new
// one and sends nothing transient, so a restart never produces a burst of stale alerts.
export const MAX_OBSERVATION_AGE_MS = 2 * 60 * 60 * 1000;
// Retry policy for an alert the provider did not take. Attempts count every refusal (limiter or
// thrown send); a limiter refusal is retried on the next tick, a thrown send backs off.
export const MAX_ALERT_ATTEMPTS = 12;
export const MAX_ALERT_AGE_MS = 24 * 60 * 60 * 1000;
export const RETRY_BASE_MS = 5 * 60 * 1000;
export const RETRY_MAX_MS = 2 * 60 * 60 * 1000;
const MAX_SENDS_PER_TICK = 500;
// Most important first within a tick (lower sorts first); anything else goes after these.
const KIND_PRIORITY = { slashed: 0, disabled: 1, 'not-elected': 2 };
const priorityOf = (eventKind) => { const k = String(eventKind).replace(/^validator\./, ''); return k in KIND_PRIORITY ? KIND_PRIORITY[k] : 3; };
const retryDelay = (attempts) => Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);

// The events that may be sent for the gap since a stale observation: only a slash whose era moved
// forward (detectValidatorEvents already requires the old state to be known).
const staleEvents = (events) => events.filter(e => e.kind === 'slashed');

// Send the due pending alerts, most important first. Returns the number the provider accepted.
async function drainPending({ db, send, origin, nameOf, now }) {
    const due = db.getDueValidatorAlerts({ now: now(), limit: MAX_SENDS_PER_TICK });
    due.sort((a, b) => priorityOf(a.eventKind) - priorityOf(b.eventKind) || a.createdAt - b.createdAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
    const names = new Map();
    let accepted = 0;
    for (const p of due) {
        const key = { eventKind: p.eventKind, eventId: p.eventId, subscriberId: p.subscriberId };
        const kind = p.eventKind.replace(/^validator\./, '');
        try {
            if (!p.active) { db.settleValidatorAlert({ ...key, providerId: null, result: 'skipped-unsubscribed' }); continue; }
            const giveUp = (reason) => {
                db.settleValidatorAlert({ ...key, providerId: null, result: p.lastResult === 'rate-limited' ? 'rate-limited' : 'failed' });
                // Kind and stash identify the alert; the address stays out of the log (the subscriber id traces it).
                console.error(`[validator-alerts] gave up on the ${kind} alert for ${p.stash} after ${p.attempts} attempts: ${reason}`);
            };
            if (now() - p.createdAt > MAX_ALERT_AGE_MS) { giveUp('too old'); continue; }
            if (!names.has(p.stash)) {
                let name = null;
                try { name = nameOf ? await nameOf(p.stash) : null; } catch (e) { name = null; }
                names.set(p.stash, name);
            }
            const event = { kind, stash: p.stash, occurrence: p.eventId.slice(p.stash.length + 1), detail: p.detail };
            const unsubscribeUrl = `${origin}/api/validator-alerts/unsubscribe?token=${encodeURIComponent(p.unsubscribeToken)}`;
            const m = alertMail(event, { origin, unsubscribeUrl, name: names.get(p.stash) });
            let outcome;
            try {
                const r = await send({
                    to: p.email, subject: m.subject, text: m.text, html: m.html, tag: p.eventKind,
                    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
                });
                outcome = r && r.rateLimited ? { refused: 'rate-limited' } : { providerId: (r && r.providerId) || null, result: r && r.disabled ? 'sent-disabled' : 'sent' };
            } catch (err) {
                outcome = { refused: 'failed' };
                console.warn(`[validator-alerts] send to subscriber #${p.subscriberId} failed (${p.eventKind}):`, err && err.message ? err.message : err);
            }
            if (!outcome.refused) {
                // Marked sent only after the provider accepted it.
                db.settleValidatorAlert({ ...key, providerId: outcome.providerId, result: outcome.result });
                accepted++;
                continue;
            }
            p.attempts += 1;
            p.lastResult = outcome.refused;
            if (p.attempts >= MAX_ALERT_ATTEMPTS) { giveUp(outcome.refused === 'rate-limited' ? 'still rate-limited' : 'send keeps failing'); continue; }
            db.deferValidatorAlert({ ...key, attempts: p.attempts, nextAttemptAt: now() + (outcome.refused === 'rate-limited' ? 0 : retryDelay(p.attempts)), lastResult: outcome.refused });
        } catch (err) {
            console.warn('[validator-alerts] one pending alert skipped after an error:', err && err.message ? err.message : err);
        }
    }
    return accepted;
}

export async function runValidatorAlertsTick({ db, readObservation, send, origin, enabled, nameOf = null, maxStashes = MAX_STASHES_PER_TICK, now = Date.now }) {
    if (typeof enabled === 'function' ? !enabled() : !enabled) return { skipped: 'off', sent: 0, stashes: 0 };
    const follows = db.getActiveValidatorAlertFollows();
    const byStash = new Map();
    for (const f of follows) {
        if (!byStash.has(f.stash)) byStash.set(f.stash, []);
        byStash.get(f.stash).push(f);
    }
    let read = 0;
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
        const detected = detectValidatorEvents(prev, { ...cur, stash });
        const events = stale ? staleEvents(detected) : detected;
        for (const event of events) {
            for (const f of list) {
                try {
                    db.reserveValidatorAlert({ eventKind: `validator.${event.kind}`, eventId: `${stash}:${event.occurrence}`, subscriberId: f.subscriberId, stash, detail: event.detail, now: now() });
                } catch (err) {
                    console.warn('[validator-alerts] one follower skipped after an error:', err && err.message ? err.message : err);
                }
            }
        }
        // After a stale gap the new observation replaces the old one, but a known slash era is kept
        // through a failed read of it (a failed read never becomes "known none").
        const next = stale ? mergeSlashOnly(prev, cur) : mergeBaseline(prev, cur);
        db.setKv(OBS_KEY(stash), { obs: next, at: now() });
    }
    const sent = await drainPending({ db, send, origin, nameOf, now });
    return { skipped: null, sent, stashes: read };
}

function mergeSlashOnly(prev, cur) {
    if (prev && cur && cur.lastSlashEra == null && prev.lastSlashEra != null) return { ...cur, lastSlashEra: prev.lastSlashEra };
    return cur;
}
