// The routes of the validator alerts (Sprint 6). They follow the general email
// signup in server.js step for step, so the same protections apply:
//
//   GET  /api/validator-alerts/status        { enabled, maxPerEmail }; no-store
//   POST /api/validator-alerts/subscribe     JSON { email, stash } -> double opt-in mail
//   GET  /api/validator-alerts/confirm       a page with a button (read-only: mail scanners open links)
//   POST /api/validator-alerts/confirm       the write; the token is a form field
//   GET  /api/validator-alerts/unsubscribe   a page with a button
//   POST /api/validator-alerts/unsubscribe   the write; also the RFC 8058 one-click target
//
// Abuse controls on subscribe: off unless the server switch is on (503, nothing
// stored or sent); refused without SITE_URL (a link must not name the wrong host);
// a per-IP limit (the existing signup limit plus a validator-alerts bucket); a
// per-address limit, so one mailbox cannot be made to receive more than a few
// confirmation mails an hour from any number of IPs; a cap on live follows per
// address; the confirmation link works 24 hours and each resend replaces it. An
// address that left all explorer mail is refused. Confirm and unsubscribe work
// whatever the switch says: leaving must never depend on a flag.
//
// The response never contains a token. The page and the mail text come from the
// caller (server.js passes its confirm page and button) so they look like the rest.

import { randomBytes } from 'node:crypto';
import { checkWindow } from './rate-limit.js';
import { confirmMail } from './validator-alerts.js';

const HOUR = 60 * 60 * 1000;
const positive = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

export function createValidatorAlertLimiters(db, env = {}) {
    const ipLimit = positive(env.VALIDATOR_ALERT_IP_PER_HOUR, 10);
    const addressLimit = positive(env.VALIDATOR_ALERT_ADDRESS_PER_HOUR, 3);
    const take = (bucket, subject, limit) => db.consumeRateLimit(bucket, String(subject), (hits) => checkWindow(hits, { windowMs: HOUR, limit })).allowed;
    return {
        ip: (ip) => take('validator-alert-ip', ip, ipLimit),
        address: (email) => take('validator-alert-address', String(email).trim().toLowerCase(), addressLimit)
    };
}

const token = () => randomBytes(24).toString('hex');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerValidatorAlertRoutes(app, { db, send, enabled, canMint, origin, parseAddress, clientIp, ipRateOk, addressRateOk, maxPerEmail = 5, page, actionForm, formBody, nameOf = null }) {
    const noStore = (res) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex, nofollow'); };
    const html = (res, status, title, body, isError = false) => { noStore(res); return res.status(status).type('html').send(page({ title, body, isError })); };
    const tokenOf = (req) => String((req.body && req.body.token) || (req.query && req.query.token) || '').trim();
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const invalidConfirm = (res) => html(res, 404, 'Confirmation link not recognised',
        '<p>This confirmation link is invalid or has already been used. If you meant to ask for alerts, request a new link from the validator status page.</p>', true);
    const expiredConfirm = (res) => html(res, 410, 'Confirmation link expired',
        '<p>This confirmation link has expired. Links work for 24 hours. Ask for alerts again from the validator status page to get a new one.</p>', true);
    const invalidUnsub = (res) => html(res, 404, 'Unsubscribe link not recognised',
        '<p>This unsubscribe link is invalid. You may have already unsubscribed, or the link was corrupted in transit. If you continue to receive emails, please contact the explorer team.</p>', true);

    app.get('/api/validator-alerts/status', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ enabled: !!enabled(), maxPerEmail });
    });

    app.post('/api/validator-alerts/subscribe', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!enabled()) return res.status(503).json({ error: 'Validator alerts are not switched on yet.' });
        if (!canMint()) return res.status(503).json({ error: 'Email signup is not configured on this deployment. Please try again later.' });
        if (!ipRateOk(clientIp(req))) return res.status(429).json({ error: 'Too many signup attempts. Please wait an hour.' });
        const email = String((req.body && req.body.email) || '').trim();
        if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Please enter a valid email address.' });
        const stash = parseAddress(String((req.body && req.body.stash) || '').trim());
        if (!stash) return res.status(400).json({ error: 'That is not a Polkadex validator address.' });
        if (!addressRateOk(email)) return res.status(429).json({ error: 'Too many requests for this email address. Please wait an hour.' });

        const r = db.addValidatorAlertFollow({
            email, stash, maxPerEmail,
            subscriberConfirmationToken: token(), subscriberUnsubscribeToken: token(),
            confirmationToken: token(), unsubscribeToken: token()
        });
        if (r.status === 'cap') return res.status(409).json({ error: `You can follow at most ${maxPerEmail} validators with one email address. Unsubscribe from one first.` });
        if (r.status === 'blocked') return res.status(409).json({ error: 'This address unsubscribed from all Polkadex Explorer email. Use the email alerts button to subscribe again first, then ask for validator alerts.' });
        if (r.status === 'exists') return res.json({ status: 'already-confirmed', email: r.follow.email, stash });

        const o = origin();
        const f = r.follow;
        const name = nameOf ? await Promise.resolve(nameOf(stash)).catch(() => null) : null;
        const m = confirmMail({
            stash, name, origin: o,
            confirmUrl: `${o}/api/validator-alerts/confirm?token=${encodeURIComponent(f.confirmationToken)}`,
            unsubscribeUrl: `${o}/api/validator-alerts/unsubscribe?token=${encodeURIComponent(f.unsubscribeToken)}`
        });
        try {
            await send({
                to: f.email, subject: m.subject, text: m.text, html: m.html, tag: 'validator-alert-confirm',
                headers: { 'List-Unsubscribe': `<${o}/api/validator-alerts/unsubscribe?token=${encodeURIComponent(f.unsubscribeToken)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
            });
        } catch (err) {
            console.warn('[validator-alerts] confirmation mail failed:', err && err.message ? err.message : err);
            return res.status(502).json({ error: 'We could not send the confirmation email. Please try again later.' });
        }
        res.json({ status: 'pending', email: f.email, stash });
    });

    app.get('/api/validator-alerts/confirm', (req, res) => {
        const t = tokenOf(req);
        const f = db.getValidatorAlertFollowByConfirmationToken(t);
        if (!f) return invalidConfirm(res);
        if (f.confirmedAt && !f.unsubscribedAt) return html(res, 200, 'Already confirmed', `<p>Alerts for <code>${esc(f.stash)}</code> are already on for <strong>${esc(f.email)}</strong>. Nothing more to do.</p>`);
        if (!db.isValidatorAlertConfirmationFresh(f)) return expiredConfirm(res);
        html(res, 200, 'Confirm validator alerts',
            `<p>Click the button to get email alerts at <strong>${esc(f.email)}</strong> about the validator <code>${esc(f.stash)}</code>.</p>${actionForm('/api/validator-alerts/confirm', t, 'Confirm alerts')}`);
    });

    app.post('/api/validator-alerts/confirm', formBody, (req, res) => {
        const t = tokenOf(req);
        const pending = db.getValidatorAlertFollowByConfirmationToken(t);
        if (!pending) return invalidConfirm(res);
        if ((!pending.confirmedAt || pending.unsubscribedAt) && !db.isValidatorAlertConfirmationFresh(pending)) return expiredConfirm(res);
        const f = db.confirmValidatorAlertFollow(t);
        if (!f) return invalidConfirm(res);
        html(res, 200, 'Alerts are on',
            `<p>You will get an email at <strong>${esc(f.email)}</strong> when the validator <code>${esc(f.stash)}</code> is not elected for a new era, shows no heartbeat by 85% of a session, is disabled, is slashed, or changes its commission or session keys.</p>
<p>Every alert has an unsubscribe link. It is deliberately not repeated on this page: mail scanners fetch these URLs, and the link is a bearer token.</p>`);
    });

    app.get('/api/validator-alerts/unsubscribe', (req, res) => {
        const t = tokenOf(req);
        const f = db.getValidatorAlertFollowByUnsubscribeToken(t);
        if (!f) return invalidUnsub(res);
        if (f.unsubscribedAt) return html(res, 200, 'Already unsubscribed', `<p>We are not sending alerts about <code>${esc(f.stash)}</code> to <strong>${esc(f.email)}</strong>.</p>`);
        html(res, 200, 'Unsubscribe from validator alerts?',
            `<p>This stops alert emails to <strong>${esc(f.email)}</strong> about the validator <code>${esc(f.stash)}</code>. Alerts for other validators and other explorer email are not affected.</p>${actionForm('/api/validator-alerts/unsubscribe', t, 'Unsubscribe')}`);
    });

    app.post('/api/validator-alerts/unsubscribe', formBody, (req, res) => {
        const f = db.unsubscribeValidatorAlertFollow(tokenOf(req));
        if (!f) return invalidUnsub(res);
        html(res, 200, 'You have been unsubscribed',
            `<p>We have stopped sending alerts about <code>${esc(f.stash)}</code> to <strong>${esc(f.email)}</strong>. You can ask for them again from the validator status page.</p>`);
    });
}
