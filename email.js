// =============================================================================
// Email transport — pluggable provider behind a single sendEmail() interface.
// =============================================================================
//
// Reads EMAIL_PROVIDER from env to pick the backend:
//
//   postmark   — Postmark transactional email (default). Set POSTMARK_TOKEN.
//   sendgrid   — SendGrid v3 API.                         Set SENDGRID_API_KEY.
//   ses        — AWS Simple Email Service (HTTPS API).   Set AWS_SES_REGION + access keys.
//   disabled   — log-only, no network call. Useful for dev and CI.
//
// All providers use raw HTTPS via undici (built into Node 18+) — no SDK
// dependencies, no npm install, no version-pinning headaches.
//
// EMAIL_FROM is mandatory in all modes except `disabled`. It must be an
// already-verified sender on the chosen provider. EMAIL_FROM_NAME and
// EMAIL_REPLY_TO are optional.
//
// Per-recipient rate limit: one send per 10s by default. Prevents the
// dispatcher from accidentally hammering a recipient (e.g., bug causing
// multiple syncDemocracy ticks to all fire emails). Configurable via
// EMAIL_MIN_INTERVAL_MS.
// =============================================================================

import { createHash } from 'node:crypto';

// Audit F-090: never put a subscriber's mailbox in a log line.
//
// Two lines below did, and both fire on ordinary operation rather than on an
// error: the rate-limit warning on every per-recipient cooldown, and the
// "(disabled) would send" line on EVERY send while EMAIL_PROVIDER is
// `disabled` — which is the DEFAULT. So a stock deployment writes the address
// of everyone who signs up into journald, where it is retained, shipped to
// whatever aggregates the logs, and readable by anyone with host access. The
// subscriber consented to receive mail, not to be catalogued in an ops system.
//
// A truncated SHA-256 is enough for what the log is actually for: correlating
// "this same recipient again" across lines. Being precise about what it is not
// — an unsalted hash of a low-entropy value is a stable pseudonym, not
// anonymisation. Anyone holding a candidate address can confirm a match. That
// is an acceptable trade for a log line and would not be for stored data.
//
// EMAIL_LOG_PLAINTEXT=1 restores the old behaviour, because the disabled-
// provider line is how a developer checks locally that mail would reach the
// right address, and silently removing that would just push people to add
// their own console.log.
const EMAIL_LOG_PLAINTEXT  = process.env.EMAIL_LOG_PLAINTEXT === '1';
function maskEmail(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    if (!v) return '(none)';
    if (EMAIL_LOG_PLAINTEXT) return v;
    return 'sha256:' + createHash('sha256').update(v).digest('hex').slice(0, 12);
}

const EMAIL_PROVIDER       = (process.env.EMAIL_PROVIDER || 'disabled').toLowerCase();
const EMAIL_FROM           = process.env.EMAIL_FROM      || '';
const EMAIL_FROM_NAME      = process.env.EMAIL_FROM_NAME || 'Polkadex Explorer';
const EMAIL_REPLY_TO       = process.env.EMAIL_REPLY_TO  || '';
const EMAIL_MIN_INTERVAL_MS = Number(process.env.EMAIL_MIN_INTERVAL_MS) || 10_000;

// Per-recipient last-send timestamps for the cheap rate limiter. Map<email_lc, ts>.
// In-memory only; on restart we reset (acceptable because the dispatcher's
// SQLite idempotency guard already prevents duplicate sends).
const lastSendByRecipient = new Map();

function isRfc5322Email(s) {
    // Pragmatic check: not full RFC parser, but rejects the obviously-broken
    // shapes (no @, spaces, missing TLD-ish). The provider does the real
    // validation; this is just to fail fast on garbage input.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

function isRateLimited(toEmailLower) {
    const last = lastSendByRecipient.get(toEmailLower) || 0;
    if (Date.now() - last < EMAIL_MIN_INTERVAL_MS) return true;
    lastSendByRecipient.set(toEmailLower, Date.now());
    return false;
}

// Common config check used by every provider before doing network work.
function preflight(opts) {
    if (!opts || !opts.to) return { error: 'sendEmail: `to` is required' };
    // F-090: the address must not ride out in the message either — callers
    // log err.message (server.js does), so this would reintroduce the leak
    // through the error path after the log lines were fixed.
    if (!isRfc5322Email(opts.to)) return { error: `sendEmail: ${maskEmail(opts.to)} is not a valid email address` };
    if (EMAIL_PROVIDER !== 'disabled' && !EMAIL_FROM) {
        return { error: 'EMAIL_FROM is required when EMAIL_PROVIDER is not "disabled"' };
    }
    if (!opts.subject || (!opts.html && !opts.text)) {
        return { error: 'sendEmail: subject + at least one of (html, text) required' };
    }
    return { ok: true };
}

// ----- Postmark -------------------------------------------------------------
async function sendViaPostmark(opts) {
    const token = process.env.POSTMARK_TOKEN;
    if (!token) throw new Error('POSTMARK_TOKEN env var is not set');

    const body = {
        From: EMAIL_FROM_NAME ? `${EMAIL_FROM_NAME} <${EMAIL_FROM}>` : EMAIL_FROM,
        To: opts.to,
        Subject: opts.subject,
        HtmlBody: opts.html || undefined,
        TextBody: opts.text || undefined,
        ReplyTo: EMAIL_REPLY_TO || undefined,
        MessageStream: 'outbound',
        Tag: opts.tag || undefined,
        Headers: Array.isArray(opts.headers)
            ? opts.headers
            : opts.headers
                ? Object.entries(opts.headers).map(([Name, Value]) => ({ Name, Value }))
                : undefined
    };

    const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-Postmark-Server-Token': token
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000)
    });
    const respText = await res.text();
    if (!res.ok) throw new Error(`Postmark ${res.status}: ${respText}`);
    let json = {};
    try { json = JSON.parse(respText); } catch (_) {}
    return { providerId: json.MessageID || null, raw: respText };
}

// ----- SendGrid -------------------------------------------------------------
async function sendViaSendGrid(opts) {
    const key = process.env.SENDGRID_API_KEY;
    if (!key) throw new Error('SENDGRID_API_KEY env var is not set');

    const personalizations = [{ to: [{ email: opts.to }] }];
    const content = [];
    if (opts.text) content.push({ type: 'text/plain', value: opts.text });
    if (opts.html) content.push({ type: 'text/html',  value: opts.html });
    const customArgs = opts.tag ? { tag: String(opts.tag) } : undefined;

    const body = {
        personalizations,
        from: { email: EMAIL_FROM, name: EMAIL_FROM_NAME || undefined },
        reply_to: EMAIL_REPLY_TO ? { email: EMAIL_REPLY_TO } : undefined,
        subject: opts.subject,
        content,
        custom_args: customArgs
    };

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`SendGrid ${res.status}: ${t}`);
    }
    // SendGrid returns 202 Accepted with empty body and a message ID in headers.
    const messageId = res.headers.get('x-message-id') || null;
    return { providerId: messageId, raw: '' };
}

// ----- AWS SES (Signature V4 against ses.<region>.amazonaws.com) -----------
async function sendViaSes(_opts) {
    throw new Error('AWS SES transport not yet implemented — set EMAIL_PROVIDER=postmark or sendgrid');
}

// ----- Public interface -----------------------------------------------------
// sendEmail({ to, subject, html, text, tag, headers }) → { providerId } | throws
//
// Behaviour:
//   - Disabled provider: returns { providerId: null, disabled: true }, logs subject.
//   - Rate-limited recipient: returns { rateLimited: true } without sending.
//   - Network/SMTP error: throws (caller's responsibility to log + record).
export async function sendEmail(opts) {
    const pre = preflight(opts);
    if (pre.error) throw new Error(pre.error);

    const toLower = String(opts.to).trim().toLowerCase();
    if (isRateLimited(toLower)) {
        console.warn(`[email] rate-limited send to ${maskEmail(toLower)} (interval ${EMAIL_MIN_INTERVAL_MS}ms)`);
        return { rateLimited: true, providerId: null };
    }

    if (EMAIL_PROVIDER === 'disabled') {
        console.log(`[email] (disabled) would send to=${maskEmail(opts.to)} subject="${opts.subject}" tag=${opts.tag || '-'}`);
        return { disabled: true, providerId: null };
    }

    if (EMAIL_PROVIDER === 'postmark') return await sendViaPostmark(opts);
    if (EMAIL_PROVIDER === 'sendgrid') return await sendViaSendGrid(opts);
    if (EMAIL_PROVIDER === 'ses')      return await sendViaSes(opts);

    throw new Error(`Unknown EMAIL_PROVIDER: ${EMAIL_PROVIDER}`);
}

// Pure-utility export so the dispatcher can check provider status for the
// /api/diag/email endpoint without trying a send.
export function emailProviderStatus() {
    return {
        provider: EMAIL_PROVIDER,
        from: EMAIL_FROM || null,
        fromName: EMAIL_FROM_NAME || null,
        replyTo: EMAIL_REPLY_TO || null,
        rateLimitMs: EMAIL_MIN_INTERVAL_MS,
        ready:
            (EMAIL_PROVIDER === 'disabled') ||
            (EMAIL_PROVIDER === 'postmark' && !!process.env.POSTMARK_TOKEN && !!EMAIL_FROM) ||
            (EMAIL_PROVIDER === 'sendgrid' && !!process.env.SENDGRID_API_KEY && !!EMAIL_FROM)
    };
}
