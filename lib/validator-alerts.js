// Validator onboarding, Sprint 6 (optional): email alerts for a validator a
// person follows. Spec: cto-team/plans/2026-11-17-validator-onboarding-design.md,
// "Sprint 6 (optional): alerts".
//
// This file is pure: no database, no network, no clock. It holds
//   - the switch (VALIDATOR_ALERTS_SEND, off unless exactly "1"),
//   - observationFromStatus: a readValidatorStatus snapshot reduced to the few
//     fields the rules read,
//   - detectValidatorEvents(prev, cur): the six rules, each returning an event
//     with an `occurrence` id that names that one occurrence (the id is what the
//     sent log is keyed on, so a replay or a restart never mails it twice),
//   - the mail text (alertMail, confirmMail): plain text and simple HTML.
//
// The rules (state changes need a previous observation; the first observation of
// a stash is a baseline, so subscribing never mails history):
//   not-elected        validating (intent) and outside the elected set; once per era
//   no-heartbeat       in the session set, no heartbeat and no authored block, at
//                      85% of the session or later; once per session. Unknown reads
//                      (null) never alert.
//   disabled           the change to disabled; once per era
//   slashed            lastSlashEra became a newer era
//   commission-changed both commissions known and different
//   keys-changed       the queued next session keys differ (cleared keys do not alert)
//
// No dash characters in any text here: plain hyphens and words only.

import { createHash } from 'node:crypto';
import { perbillToPercent } from './validator-status.js';

export const ALERT_KINDS = Object.freeze(['not-elected', 'no-heartbeat', 'disabled', 'slashed', 'commission-changed', 'keys-changed']);
export const HEARTBEAT_ALERT_PROGRESS = 0.85;
export const MAX_FOLLOWS_PER_EMAIL = 5;

// Sending is off unless the server sets VALIDATOR_ALERTS_SEND=1. Nothing else turns it on.
export function validatorAlertsSendEnabled(env = {}) {
    return !!env && env.VALIDATOR_ALERTS_SEND === '1';
}

const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const boolOrNull = (v) => (v === true ? true : v === false ? false : null);

export function observationFromStatus(s = {}, { block = null } = {}) {
    const intent = boolOrNull(s.intent);
    const elected = intent === true ? !!(s.inSession || s.exposure) : null;
    const nk = s.nextKeys && typeof s.nextKeys === 'object' ? Object.entries(s.nextKeys).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : null;
    return {
        stash: String(s.address || ''),
        block: numOrNull(block),
        era: numOrNull(s.activeEra),
        session: numOrNull(s.sessionIndex),
        progress: numOrNull(s.sessionProgress),
        intent,
        elected,
        inSession: !!s.inSession,
        disabled: !!s.disabled,
        heartbeat: boolOrNull(s.heartbeat),
        blocks: numOrNull(s.blocks),
        lastSlashEra: numOrNull(s.lastSlashEra),
        commission: numOrNull(s.prefs && s.prefs.commission),
        keys: nk && nk.length ? JSON.stringify(nk) : null
    };
}

const short = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 12);

export function detectValidatorEvents(prev, cur) {
    const out = [];
    if (!cur || !cur.stash) return out;
    const stash = cur.stash;
    const push = (kind, occurrence, detail = {}) => out.push({ kind, stash, occurrence, detail });

    // Rules that read one observation: no baseline needed, the occurrence is the session.
    if (cur.inSession && cur.heartbeat === false && cur.blocks === 0 && cur.session != null
        && cur.progress != null && cur.progress >= HEARTBEAT_ALERT_PROGRESS) {
        push('no-heartbeat', `no-heartbeat:s${cur.session}`, { session: cur.session, progress: cur.progress });
    }

    // Everything below is a change or a once-per-era fact: the first observation only sets the baseline.
    if (!prev) return out;

    if (cur.intent === true && cur.elected === false && cur.era != null) {
        push('not-elected', `not-elected:e${cur.era}`, { era: cur.era });
    }
    if (cur.disabled === true && prev.disabled !== true) {
        push('disabled', `disabled:e${cur.era == null ? 'x' : cur.era}`, { era: cur.era });
    }
    if (cur.lastSlashEra != null && (prev.lastSlashEra == null || cur.lastSlashEra > prev.lastSlashEra)) {
        push('slashed', `slashed:e${cur.lastSlashEra}`, { era: cur.lastSlashEra });
    }
    if (cur.commission != null && prev.commission != null && cur.commission !== prev.commission) {
        push('commission-changed', `commission:${prev.commission}>${cur.commission}@${cur.block == null ? 'x' : cur.block}`, { from: prev.commission, to: cur.commission });
    }
    if (cur.keys != null && cur.keys !== prev.keys) {
        push('keys-changed', `keys:${short(cur.keys)}@${cur.block == null ? 'x' : cur.block}`, {});
    }
    return out;
}

// ---------------------------------------------------------------- mail text

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const shortAddr = (a) => `${String(a).slice(0, 8)}...${String(a).slice(-6)}`;
const labelOf = (stash, name) => (name && String(name).trim() ? String(name).trim().slice(0, 40) : shortAddr(stash));

function describe(event) {
    const d = event.detail || {};
    switch (event.kind) {
        case 'not-elected': return {
            head: (l) => `Not elected: ${l}`,
            lines: [`This validator is not in the elected set for era ${d.era}. It will not author blocks or earn rewards this era unless it is elected for a later one.`,
                'Common causes: too little total stake behind it, a commission that nominators avoid, or a node that was not ready at the election. The validator status page shows the numbers.']
        };
        case 'no-heartbeat': return {
            head: (l) => `No heartbeat yet: ${l}`,
            lines: [`This validator is in the active set but has sent no heartbeat and authored no block, and the session is ${Math.floor((d.progress || 0) * 100)}% done. The alert waits for 85% of a session so that a slow start is not reported as a fault.`,
                'Check that the node is running, in sync and holds the current session keys. If it stays silent it can be disabled.']
        };
        case 'disabled': return {
            head: (l) => `Disabled: ${l}`,
            lines: ['This validator has been disabled for the rest of the era, usually after an offence. It does not author blocks while disabled.',
                'The validator status page shows the offences the explorer has recorded.']
        };
        case 'slashed': return {
            head: (l, ev) => `Slashed: ${l} (era ${(ev.detail || {}).era})`,
            lines: [`A slash was applied to this validator for era ${d.era}. Its stake, and the stake of nominators backing it, was reduced.`,
                'The validator status page lists the incidents the explorer has recorded.']
        };
        case 'commission-changed': return {
            head: (l, ev) => `Commission changed: ${l}, ${perbillToPercent((ev.detail || {}).from)} to ${perbillToPercent((ev.detail || {}).to)}`,
            lines: [`The commission of this validator changed from ${perbillToPercent(d.from)} to ${perbillToPercent(d.to)}.`,
                'Commission is the share of rewards the validator keeps before nominators are paid.']
        };
        case 'keys-changed': return {
            head: (l) => `Session keys changed: ${l}`,
            lines: ['The session keys registered for this validator changed. The new keys are used from the session after next.',
                'If you did not change them, check who holds the stash or a proxy for it.']
        };
        default: return { head: (l) => `Alert: ${l}`, lines: ['Something changed for this validator.'] };
    }
}

function frame({ title, lines, link, linkText, unsubscribeUrl, origin, footLines }) {
    const text = [title, '', ...lines, '', `${linkText}: ${link}`, '', 'Polkadex Mainnet Explorer', origin, '', ...footLines, `Unsubscribe from alerts for this validator: ${unsubscribeUrl}`, ''].join('\n');
    const html = `<!doctype html><html><body style="font-family:Inter,-apple-system,Segoe UI,Arial,sans-serif;background:#08080c;color:#e8eaed;margin:0;padding:24px;">
<div style="max-width:560px;margin:0 auto;background:#12121a;border-radius:12px;padding:32px;border:1px solid rgba(255,255,255,0.08);">
  <h1 style="margin:0 0 14px;font-size:1.3rem;color:#fff;">${esc(title)}</h1>
  ${lines.map(l => `<p style="line-height:1.55;color:#cfd5e1;margin:0 0 14px;">${esc(l)}</p>`).join('\n  ')}
  <p style="margin:24px 0;text-align:center;"><a href="${esc(link)}" style="display:inline-block;padding:12px 24px;background:#E6007A;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">${esc(linkText)}</a></p>
  <hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:26px 0;">
  ${footLines.map(l => `<p style="font-size:0.78rem;color:#9ca3af;line-height:1.5;margin:0 0 8px;">${esc(l)}</p>`).join('\n  ')}
  <p style="font-size:0.78rem;color:#9ca3af;line-height:1.5;margin:0;">Polkadex Mainnet Explorer, <a href="${esc(origin)}" style="color:#9ca3af;">${esc(String(origin).replace(/^https?:\/\//, ''))}</a><br>
  <a href="${esc(unsubscribeUrl)}" style="color:#9ca3af;">Unsubscribe from alerts for this validator</a></p>
</div>
</body></html>`;
    return { text, html };
}

// { subject, text, html } for one event. ctx: { origin, unsubscribeUrl, name }
export function alertMail(event, { origin, unsubscribeUrl, name = null } = {}) {
    const label = labelOf(event.stash, name);
    const d = describe(event);
    const subject = d.head(label, event);
    const link = `${origin}/validate/${event.stash}`;
    const body = frame({
        title: subject, lines: [...d.lines, `Validator: ${event.stash}`], link, linkText: 'Open the validator status', unsubscribeUrl, origin,
        footLines: ['You asked for alerts about this validator on the Polkadex Explorer. You get one email for each occurrence and nothing else about it.']
    });
    return { subject, ...body };
}

// The double opt-in mail: nothing is sent about the validator until the link is used.
export function confirmMail({ stash, name = null, confirmUrl, unsubscribeUrl, origin } = {}) {
    const label = labelOf(stash, name);
    const subject = `Confirm alerts for validator ${label}`;
    const body = frame({
        title: subject,
        lines: [
            `Someone asked for email alerts about the validator ${stash} on the Polkadex Explorer, using this address. If that was you, confirm below. The link works for 24 hours.`,
            'After you confirm, you get one email each time that validator is not elected for a new era, shows no heartbeat and no authored block by 85% of a session, is disabled, is slashed, changes its commission or changes its session keys. Nothing else is sent.',
            'You can stop at any time with the unsubscribe link in this email and in every alert.'
        ],
        link: confirmUrl, linkText: 'Confirm alerts', unsubscribeUrl, origin,
        footLines: ['If you did not ask for this, ignore this email. Nothing is sent about the validator unless you confirm.']
    });
    return { subject, ...body };
}
