// Is a nominator's stake earning this era, and is any of its validators
// offline? Pure: lib/nomination-status-chain.js reads the chain into the
// snapshot this takes; lib/nomination-status-view.js renders the model.
// Tested in test/nomination-status.test.js.
//
// One validator, from the nominator's side (classifyTarget):
//   state  active         elected for the active era (ErasStakersOverview)
//          waiting        wants to validate (Validators entry), not elected
//          not-validator  no Validators entry: chilled or stopped
//   flags  leaving        elected this era but no longer wants to validate
//          blocked        ValidatorPrefs.blocked
//          commission100  commission 100%: nothing reaches the nominators
//          offline        in the session set, no heartbeat and no block,
//                         and the session is past OFFLINE_PROGRESS (imOnline
//                         sends heartbeats between 10% and 80% of a session)
//          not-seen-yet   the same before that point: normal, not a warning
//          disabled       Session.DisabledValidators (an offence this era)
//          reported-offline  an imOnline.SomeOffline event named it lately
//          slashed        SlashingSpans.lastNonzeroSlash within the lookback
//                         (era 0 is the "never" default), or a SlashReported
//                         or Slashed event lately
//
// Offline slashing on spec 392 (pallet-im-online 44.0.0, reported through
// pallet-offences to staking): zero unless more than n/10 + 1 of the n
// session validators are offline in one session; then
// 7% x 3(k - (n/10 + 1)) / n of the exposure, nominators included.

export const OFFLINE_PROGRESS = 0.85;
const FULL_COMMISSION = 1_000_000_000;   // Perbill
const OFFLINE_KINDS = new Set(['imOnline.SomeOffline']);
const SLASH_KINDS = new Set(['staking.SlashReported', 'staking.Slashed']);
const PROBLEM = new Set(['offline', 'disabled', 'reported-offline', 'commission100', 'leaving']);

export function offlineSlashThreshold(n) {
    return Math.floor(Number(n) / 10) + 1;
}

const nameOf = (t) => t.name || `${String(t.address).slice(0, 8)}...${String(t.address).slice(-6)}`;
const fmt = (n) => Number(n).toLocaleString('en-US');

export function classifyTarget(t, ctx = {}) {
    const flags = [], notes = [];
    let state, label;
    if (t.elected) { state = 'active'; label = 'Active this era'; }
    else if (t.intent === false) { state = 'not-validator'; label = 'Chilled or no longer a validator'; }
    else if (t.intent === true) { state = 'waiting'; label = 'Waiting (not elected this era)'; }
    else { state = 'unknown'; label = 'Not elected this era'; }
    if (state === 'active' && t.intent === false) { flags.push('leaving'); notes.push('Stopped validating; it leaves the active set at the next election.'); }
    if (t.blocked) { flags.push('blocked'); notes.push('Blocked: accepts no new nominations.'); }
    if (Number(t.commission) >= FULL_COMMISSION) { flags.push('commission100'); notes.push('100% commission: nominators earn nothing through it.'); }
    if (ctx.imOnline && t.inSession && t.heartbeat === false && Number(t.blocks) === 0) {
        if (Number(ctx.sessionProgress) >= OFFLINE_PROGRESS) { flags.push('offline'); notes.push('Offline: no heartbeat and no block this session.'); }
        else { flags.push('not-seen-yet'); notes.push('No heartbeat yet this session (normal before it is 80% through).'); }
    }
    if (t.disabled) { flags.push('disabled'); notes.push('Disabled for this era after an offence.'); }
    const incidents = Array.isArray(t.incidents) ? t.incidents : [];
    const off = incidents.filter(i => OFFLINE_KINDS.has(i.kind));
    if (off.length) { flags.push('reported-offline'); notes.push(`Reported offline at a session end (last at block ${fmt(off[0].block)}).`); }
    const lookback = Number(ctx.slashRecentEras) || 28;
    const spanSlash = Number(t.lastSlashEra) > 0 && ctx.activeEra != null && Number(ctx.activeEra) - Number(t.lastSlashEra) <= lookback;
    const slashEv = incidents.find(i => SLASH_KINDS.has(i.kind));
    if (spanSlash || slashEv) {
        flags.push('slashed');
        notes.push(spanSlash ? `Slashed in era ${t.lastSlashEra}.` : `Slash reported at block ${fmt(slashEv.block)}.`);
    }
    return { address: t.address, name: t.name || null, state, label, flags, notes };
}

export function nominationModel(snap = {}) {
    const ctx = { activeEra: snap.activeEra, sessionProgress: snap.sessionProgress, imOnline: !!snap.imOnline, slashRecentEras: snap.bondingDuration };
    const offline = snap.imOnline
        ? { source: 'imOnline', note: 'Offline means no heartbeat and no block in the current session (imOnline), or an offline report at a recent session end.' }
        : { source: 'none', note: 'Offline detection is not available: this runtime has no imOnline module, so the explorer cannot tell whether a validator is online.' };
    if (!snap.nominating) return { address: snap.address, nominating: false, targets: [], banners: [], earning: null, offline };
    const targets = (snap.targets || []).map(t => classifyTarget(t, ctx));
    const healthy = (c) => !c.flags.some(f => PROBLEM.has(f));
    const earningSet = targets.filter(c => c.state === 'active' && !c.flags.includes('commission100'));
    const banners = [];
    const fresh = snap.submittedIn != null && snap.activeEra != null && Number(snap.submittedIn) >= Number(snap.activeEra);
    if (!earningSet.length) {
        const full = targets.filter(c => c.state === 'active' && c.flags.includes('commission100')).length;
        const text = fresh
            ? `Your nominations were made in era ${snap.submittedIn}; they count from the next election, so this era earns nothing yet.`
            : `None of your ${targets.length} nominated validators is earning this era${full ? ` (${full} active at 100% commission)` : ''}. Replace the inactive ones; rewards start from the era after the new ones are elected.`;
        banners.push({ kind: 'no-rewards', title: 'You are earning no rewards this era', text,
            keep: targets.filter(c => c.state === 'active' && healthy(c)).map(c => c.address), action: fresh ? null : 'change' });
    }
    const bad = targets.filter(c => c.flags.some(f => f === 'offline' || f === 'disabled' || f === 'reported-offline'));
    if (bad.length) {
        const n = Number(snap.validatorCount) || 0;
        const slash = n ? ` If more than ${offlineSlashThreshold(n)} of the ${n} validators are offline in the same session, the offline ones and their nominators are slashed (up to 7% of the stake).` : ' Offline validators are reported as an offence at the end of the session and can be slashed with their nominators.';
        banners.push({ kind: 'offline', title: 'Some of your validators look offline',
            text: `${bad.map(nameOf).join(', ')} ${bad.length === 1 ? 'looks' : 'look'} offline. An offline validator earns no era points, so you miss rewards through it.${slash} Replace ${bad.length === 1 ? 'it' : 'them'} to be safe.`,
            names: bad.map(nameOf),
            keep: targets.filter(c => healthy(c) && c.state !== 'not-validator').map(c => c.address), action: 'change' });
    }
    return { address: snap.address, nominating: true, activeEra: snap.activeEra ?? null, submittedIn: snap.submittedIn ?? null,
        targets, banners, earning: earningSet.length > 0, offline };
}
