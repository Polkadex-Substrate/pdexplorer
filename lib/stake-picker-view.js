// The stake picker's filter bar and validator rows (Stake & Nominate modal).
//
// script.js keeps the modal, the selection and the signing flow; this module
// only decides which validators the left-hand list shows, in what order, and
// how each row reads. It never builds or signs a transaction: "+" calls back
// into script.js's addStakeValidator, exactly as the old list did.
//
// Every string that came from the chain or the API (names, addresses, notes)
// goes through the escapeHtml the caller passes in. Browser natives (fetch,
// matchMedia, localStorage) are reached only through the wrappers the caller
// passes, so none is ever invoked detached from its owner.

import { aprLabel, minErasFor, APR_WINDOWS } from './stake-apr.js';
import { validatorsWithStakeState, pickerStakeText } from './stake-display.js';
import {
    SORTS, WHY, RECOMMENDED_PRESET, DEFAULT_FILTERS, FILTER_KEYS,
    sanitizeFilters, loadFilters, saveFilters, applyFilters, filterCounts, sortValidators,
    perfFor, identityGroup, selectedGroups, EXPOSURE_PAGE_SIZE, SLASH_LOOKBACK_ERAS, FALLBACK_MAX_NOMINATIONS
} from './stake-filters.js';

export const CHOICE_URL = '/api/staking/validator-choice';
export const FALLBACK_URL = '/api/validators';

// The picker's data. Prefers the full candidate snapshot; while the indexer
// has not built it yet (status Initializing, empty list) or the request fails,
// falls back to /api/validators so the modal still works, just without the
// APR and the filters that need the snapshot (those then read as unknown).
export async function loadPickerData(fetchJson) {
    try {
        const snap = await fetchJson(CHOICE_URL);
        if (snap && Array.isArray(snap.validators) && snap.validators.length) {
            return { validators: validatorsWithStakeState(snap), meta: { ...snap, validators: undefined, full: true } };
        }
    } catch (e) { /* fall through */ }
    const data = await fetchJson(FALLBACK_URL);
    // stakeDataOk false (every active validator read 0 stake): the rows say
    // "stake unavailable", never 0 PDEX, as the validator list does.
    const list = validatorsWithStakeState(data);
    return {
        validators: list.map(v => ({ ...v, active: true })),
        meta: { full: false, activeEra: data && data.commissionHistoryEra ? data.commissionHistoryEra : null }
    };
}

// How many validators one nomination may name: the runtime's
// StakingApi.nominations_quota, carried in the snapshot meta by
// lib/stake-choice-sync.js. 16 (the 392 value) only when the meta has none,
// for instance while the picker runs on the /api/validators fallback.
export function maxNominationsFrom(meta, { warn = (m) => console.warn(m) } = {}) {
    const n = meta ? Number(meta.maxNominations) : NaN;
    if (Number.isInteger(n) && n > 0) return n;
    warn(`[stake picker] no nominations quota from the chain; assuming ${FALLBACK_MAX_NOMINATIONS}`);
    return FALLBACK_MAX_NOMINATIONS;
}

// 1234567 -> "1.23M". Rows are narrow; the exact figure is on the validator page.
export function compactNumber(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 'n/a';
    const abs = Math.abs(x);
    if (abs >= 1e9) return (x / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (abs >= 1e4) return (x / 1e3).toFixed(1) + 'K';
    return x.toFixed(abs >= 100 ? 0 : 2);
}

function aprTitle(perf, window) {
    const base = `Past rewards over the last ${window} completed eras, after commission, per PDEX staked. Not a guarantee.`;
    if (!perf) return 'No reward history for this validator yet.';
    const counted = perf.erasUsed != null ? perf.erasUsed : perf.electedEras;
    if (perf.status === 'new') return `Elected history for only ${counted} of the last ${window} eras; ${minErasFor(window)} are needed for an APR. ${base}`;
    if (perf.status === 'none') return `Not in the active set during the last ${window} eras, so there is nothing to measure.`;
    return `${base} Based on ${perf.erasUsed} eras, ${perf.electedEras} of them in the active set; eras out of it count as zero.`;
}

// One row of the left-hand list.
export function validatorRowHtml(v, { esc, shortAddress, selected = false, window = DEFAULT_FILTERS.aprWindow, sameIdentityAsPick = false }) {
    const name = v.name && v.name !== 'Unknown' ? v.name : shortAddress(v.address);
    const perf = perfFor(v, window);
    const commission = v.commission == null ? 'n/a' : `${(Number(v.commission) || 0).toFixed(1)}%`;
    const ch = v.commissionHistory || null;
    const badges = [];
    if (v.active === false) badges.push('<span class="badge stake-badge-waiting" title="Not in the active set this era">WAITING</span>');
    if (v.blocked) badges.push('<span class="badge stake-badge-warn" title="This validator blocks new nominations">BLOCKED</span>');
    if (ch && (ch.raisedRecently || ch.pendingRaise)) badges.push(`<span class="badge commission-raised">${ch.pendingRaise ? 'RAISING NOW' : 'RAISED RECENTLY'}</span>`);
    if (Array.isArray(v.slashEras) && v.slashEras.length) badges.push(`<span class="badge stake-badge-warn" title="Slashed in era ${esc(v.slashEras.join(', '))}">SLASHED</span>`);
    if (sameIdentityAsPick && !selected) badges.push('<span class="badge stake-badge-info" title="Shares an on-chain identity with a validator you already picked">SAME IDENTITY</span>');
    const rel = perf && perf.reliability != null ? `${Math.round(perf.reliability)}% reliable` : null;
    const extra = [
        v.selfStake != null ? `self ${compactNumber(v.selfStake)}` : null,
        rel,
        v.exposureNominators != null ? `${Number(v.exposureNominators) || 0} backers` : (v.backers ? `${Number(v.backers) || 0} nominating` : null),
        v.identity && v.identity.verified ? 'verified identity' : null
    ].filter(Boolean).join(' &middot; ');
    const note = ch && ch.note
        ? `<div class="stake-val-history${ch.volatility === 'volatile' ? ' is-volatile' : ''}">${esc(ch.note)}</div>` : '';
    const stake = pickerStakeText(v, compactNumber);
    return `<div class="stake-validator-item${selected ? ' selected' : ''}" data-addr="${esc(v.address)}">
            <div class="stake-val-info">
                <div class="stake-val-name">${esc(name)}</div>
                <div class="stake-val-meta"><span class="stake-val-apr" title="${esc(aprTitle(perf, window))}">APR ${esc(aprLabel(perf))}</span> &middot; ${esc(commission)} comm &middot; ${esc(stake)}${badges.length ? ' ' + badges.join(' ') : ''}</div>
                ${extra ? `<div class="stake-val-meta stake-val-extra">${extra}</div>` : ''}
                ${note}
            </div>
            <button type="button" class="stake-val-add" ${selected ? 'disabled aria-label="Already selected"' : 'aria-label="Add to selection"'}>${selected ? '&#10003;' : '+'}</button>
        </div>`;
}

function why(key, esc) {
    const text = WHY[key] || '';
    return `<span class="stake-why" tabindex="0" role="img" title="${esc(text)}" aria-label="Why this matters: ${esc(text)}">?</span>`;
}
function countSlot(key) {
    return `<span class="stake-f-count" data-count-for="${key}"></span>`;
}

// The filter bar. Rendered once per open (and on a preset), then kept live by
// updateBar, so dragging the slider never loses focus to a re-render.
export function filterBarHtml(state, { esc, helpIcon = () => '', full = true, open = true } = {}) {
    const s = sanitizeFilters(state);
    const opt = (value, label, cur) => `<option value="${esc(value)}"${String(cur) === String(value) ? ' selected' : ''}>${esc(label)}</option>`;
    const box = (key, label) => `<label class="stake-f stake-f-check"><input type="checkbox" data-f="${key}"${s[key] ? ' checked' : ''}> <span>${esc(label)}</span> ${why(key, esc)} ${countSlot(key)}</label>`;
    const seg = (value, label) => `<button type="button" class="stake-seg-btn${s.status === value ? ' is-on' : ''}" data-status="${value}" aria-pressed="${s.status === value}">${esc(label)} <span class="stake-seg-n" data-count-status="${value}"></span></button>`;
    return `<div class="stake-filter-top">
            <div class="stake-presets">
                <button type="button" class="stake-chip" data-preset="recommended" title="Active, commission at most 10%, no recent raise, on-chain identity, reliable, room on one payout page, not slashed, one pick per identity; sorted by past APR">Suggested filters</button>
                <button type="button" class="stake-chip" data-preset="all" title="Clear every filter">Show all</button>
                ${helpIcon('choosing-validators', 'How the APR and these filters work')}
            </div>
            <div class="stake-seg" role="group" aria-label="Active or waiting">${seg('active', 'Active')}${seg('waiting', 'Waiting')}${seg('all', 'All')} ${why('status', esc)}</div>
            <label class="stake-f stake-f-inline">APR over <select data-f="aprWindow">${APR_WINDOWS.map(w => opt(w, `${w} eras`, s.aprWindow)).join('')}</select> ${why('aprWindow', esc)}</label>
            <label class="stake-f stake-f-inline">Sort <select data-f="sort">${Object.entries(SORTS).map(([k, d]) => opt(k, d.label, s.sort)).join('')}</select> ${why('sort', esc)}</label>
        </div>
        <details class="stake-filter-more"${open ? ' open' : ''}>
            <summary>Filters <span class="stake-shown" data-count-shown></span></summary>
            <div class="stake-filter-grid">
                <label class="stake-f stake-f-range">Max commission <input type="range" min="0" max="100" step="1" value="${esc(s.maxCommission)}" data-f="maxCommission" aria-label="Maximum commission percent"> <output data-out="maxCommission">${esc(s.maxCommission >= 100 ? 'any' : s.maxCommission + '%')}</output> ${why('maxCommission', esc)} ${countSlot('maxCommission')}</label>
                ${box('noRecentRaise', 'No recent or pending commission raise')}
                <label class="stake-f">Identity <select data-f="identity">${opt('any', 'Any', s.identity)}${opt('has', 'Has on-chain identity', s.identity)}${opt('verified', 'Verified by a registrar', s.identity)}</select> ${why('identity', esc)} ${countSlot('identity')}</label>
                <label class="stake-f">Reliability <select data-f="reliability">${opt('', 'Any', s.reliability)}${opt('nomiss', 'No missed eras', s.reliability)}${opt('90', '90% of eras or better', s.reliability)}${opt('100', 'Every era', s.reliability)}</select> ${why('reliability', esc)} ${countSlot('reliability')}</label>
                ${box('notBlocked', 'Accepting nominations')}
                ${box('singlePage', `Room on one payout page (at most ${EXPOSURE_PAGE_SIZE} backers)`)}
                ${box('noSlash', `Not slashed in the last ${SLASH_LOOKBACK_ERAS} eras`)}
                ${box('spread', 'One pick per on-chain identity')}
                <label class="stake-f">Min self-stake <input type="number" min="0" step="1" inputmode="decimal" value="${esc(s.minSelfStake)}" data-f="minSelfStake" aria-label="Minimum self-stake in PDEX"> PDEX ${why('minSelfStake', esc)} ${countSlot('minSelfStake')}</label>
            </div>
            ${full ? '' : '<div class="stake-apr-note">Full validator data is still being built; APR, waiting validators and some filters are unavailable for now.</div>'}
        </details>
        <div class="stake-apr-note" data-apr-note></div>`;
}

export function aprNoteText(window) {
    return `APR: rewards actually paid per PDEX staked over the last ${window} completed eras, after commission, annualized; eras out of the active set count as zero, and it assumes every payout page is claimed. Past rewards, not a guarantee.`;
}

// A warning under the Selected list when two or more picks sit under the same
// on-chain identity. Based on identity.superOf only; no other link is implied.
export function spreadNoteHtml(groups, byAddress, { esc, shortAddress }) {
    const dupes = [...groups.entries()].filter(([, addrs]) => addrs.length > 1);
    if (!dupes.length) return '';
    const parts = dupes.map(([root, addrs]) => {
        const rootV = byAddress.get(root) || byAddress.get(addrs[0]);
        const label = rootV && rootV.name && rootV.name !== 'Unknown' ? String(rootV.name).split(' / ')[0] : shortAddress(root);
        return `${esc(label)} (${addrs.length})`;
    });
    return `<div class="stake-spread-note">Several picks share one on-chain identity: ${parts.join(', ')}. Spreading across identities lowers the chance that one problem affects all of them.</div>`;
}

// Live parts of the bar: counts, the slider label, the status buttons, the note.
export function updateBar(barEl, state, counts) {
    if (!barEl) return;
    const s = sanitizeFilters(state);
    barEl.querySelectorAll('[data-count-for]').forEach(el => {
        const n = counts.hiddenBy[el.getAttribute('data-count-for')] || 0;
        el.textContent = n > 0 ? `hides ${n}` : '';
    });
    barEl.querySelectorAll('[data-count-status]').forEach(el => {
        el.textContent = `(${counts.status[el.getAttribute('data-count-status')] || 0})`;
    });
    barEl.querySelectorAll('[data-status]').forEach(el => {
        const on = el.getAttribute('data-status') === s.status;
        el.classList.toggle('is-on', on);
        el.setAttribute('aria-pressed', String(on));
    });
    const shown = barEl.querySelector('[data-count-shown]');
    if (shown) shown.textContent = `showing ${counts.shown} of ${counts.total}`;
    const out = barEl.querySelector('[data-out="maxCommission"]');
    if (out) out.textContent = s.maxCommission >= 100 ? 'any' : `${s.maxCommission}%`;
    const note = barEl.querySelector('[data-apr-note]');
    if (note) note.textContent = aprNoteText(s.aprWindow);
}

// Read one control's new value into the state.
export function readControl(state, el) {
    const key = el && el.getAttribute && el.getAttribute('data-f');
    if (!key || !Object.prototype.hasOwnProperty.call(DEFAULT_FILTERS, key)) return state;
    let value;
    if (el.type === 'checkbox') value = !!el.checked;
    else if (key === 'aprWindow' || key === 'maxCommission' || key === 'minSelfStake') value = Number(el.value);
    else value = el.value;
    return sanitizeFilters({ ...state, [key]: value });
}

// Wire the picker. Returns { setData, render, getState }.
//   deps.storage      localStorage or null
//   deps.isNarrow     () => boolean, true on phone widths (filters start folded)
//   deps.onAdd        (address) => void, script.js's addStakeValidator
export function createStakePicker({ barEl, listEl, noteEl, storage, escapeHtml: esc, shortAddress, helpIcon, onAdd, isNarrow = () => false }) {
    let state = loadFilters(storage);
    let validators = [];
    let meta = { full: false };
    let byAddress = new Map();
    let search = '';
    let selected = new Map();

    function ctx() {
        const sel = new Set(selected.keys());
        return {
            activeEra: meta.activeEra || null,
            pageSize: meta.exposurePageSize || EXPOSURE_PAGE_SIZE,
            selected: sel,
            groups: selectedGroups(sel, byAddress),
            search
        };
    }

    function drawBar() {
        if (!barEl) return;
        barEl.innerHTML = filterBarHtml(state, { esc, helpIcon, full: meta.full !== false, open: !isNarrow() });
    }

    function drawList() {
        const c = ctx();
        const counts = filterCounts(validators, state, c);
        updateBar(barEl, state, counts);
        if (noteEl) noteEl.innerHTML = spreadNoteHtml(c.groups, byAddress, { esc, shortAddress });
        if (!listEl) return;
        const shown = sortValidators(applyFilters(validators, state, c), state);
        if (!shown.length) {
            listEl.innerHTML = validators.length
                ? '<div class="stake-empty">No validator matches these filters. Loosen one, or press Show all.</div>'
                : '<div class="stake-empty">No validators loaded.</div>';
            return;
        }
        listEl.innerHTML = shown.map(v => {
            const g = identityGroup(v);
            return validatorRowHtml(v, {
                esc, shortAddress, selected: selected.has(v.address), window: state.aprWindow,
                sameIdentityAsPick: !!(g && c.groups.has(g))
            });
        }).join('');
        listEl.querySelectorAll('.stake-validator-item').forEach(item => {
            const addr = item.getAttribute('data-addr');
            const btn = item.querySelector('.stake-val-add');
            if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); onAdd(addr); });
            item.addEventListener('click', () => onAdd(addr));
        });
    }

    function commit(next, redrawBar = false) {
        state = sanitizeFilters(next);
        saveFilters(storage, state);
        if (redrawBar) drawBar();
        drawList();
    }

    if (barEl) {
        const onControl = (e) => {
            const t = e.target;
            if (!t || !t.getAttribute || !t.getAttribute('data-f')) return;
            // Typing in the number box: wait for a usable value, keep focus.
            commit(readControl(state, t));
        };
        barEl.addEventListener('change', onControl);
        barEl.addEventListener('input', onControl);
        barEl.addEventListener('click', (e) => {
            const b = e.target && e.target.closest ? e.target.closest('[data-preset],[data-status]') : null;
            if (!b) return;
            const preset = b.getAttribute('data-preset');
            if (preset === 'recommended') return commit({ ...RECOMMENDED_PRESET }, true);
            if (preset === 'all') return commit(showAllState(state), true);
            const status = b.getAttribute('data-status');
            if (status) commit({ ...state, status });
        });
    }

    return {
        setData(data) {
            validators = Array.isArray(data && data.validators) ? data.validators : [];
            meta = (data && data.meta) || { full: false };
            byAddress = new Map(validators.map(v => [v.address, v]));
            drawBar();
        },
        render(searchStr, selectedMap) {
            search = searchStr || '';
            if (selectedMap) selected = selectedMap;
            drawList();
        },
        getState: () => ({ ...state })
    };
}

// "Show all": every filter off, keeping the user's window and sort.
export function showAllState(state) {
    const s = sanitizeFilters(state);
    return sanitizeFilters({
        status: 'all', maxCommission: 100, noRecentRaise: false, identity: 'any', notBlocked: false,
        reliability: '', singlePage: false, minSelfStake: 0, noSlash: false, spread: false,
        aprWindow: s.aprWindow, sort: s.sort
    });
}

export { FILTER_KEYS };
