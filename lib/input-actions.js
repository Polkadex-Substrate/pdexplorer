// Paste and Clear inside every text box (CEO request, 2026-11-17; spec:
// cto-team/plans/2026-11-17-input-paste-clear.md).
//
// Each text-like field gets two small icon buttons at its right edge: Clear (bx-x,
// only while the field has text) and Paste (bx-paste, only where the browser can read
// the clipboard). Fields declare what a paste means with data-input-kind; the audit test
// (test/input-actions-audit.test.js) fails the build for a field that declares neither a
// kind nor a data-no-input-actions reason.
//
// The rules that matter:
//   - the buttons are real type="button" buttons, out of the tab order (Ctrl or Cmd+V
//     and select-all + Delete already do the same from the keyboard);
//   - after either action focus is in the field, and `input` then `change` fire on it so
//     the field's own validation runs; nothing is ever submitted;
//   - the clipboard is read only inside the Paste click, never on load, focus or hover;
//   - an amount that cannot be read for certain ("1,5") is refused, never guessed.

import { createConfirmDialog } from './confirm-dialog.js';

export const INPUT_KINDS = Object.freeze(['address', 'address-list', 'amount', 'integer', 'ref', 'hex', 'search', 'code', 'text']);

const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number']);
const MAX_CLIPBOARD = 100000;
const LONG_DRAFT = 200;
const HINT_MS = 6000;

export const MESSAGES = Object.freeze({
    amount: 'That does not look like an amount. Type it in.',
    empty: 'Nothing to paste.',
    tooLong: 'That is too long to paste.',
    pasted: 'Pasted',
    cleared: 'Cleared'
});
const overLimit = (n) => `That is longer than this field allows (${n} characters).`;
const cutTo = (n) => `Pasted text was cut to ${n} characters.`;

// ── pure functions ──

export function isTextLike(tag, type) {
    const t = String(tag || '').toLowerCase();
    if (t === 'textarea') return true;
    if (t !== 'input') return false;
    return TEXT_TYPES.has(String(type == null ? '' : type).toLowerCase());
}

// 'both' | 'compact' (one slot) | 'clear' (Clear only) | 'none'.
// attrs: { tag, type, disabled, readOnly, optOut, actions }. width 0 = not measured yet.
export function inputActionsMode(attrs = {}, width = 0, canPaste = true) {
    if (!isTextLike(attrs.tag, attrs.type)) return 'none';
    if (attrs.disabled || attrs.readOnly || attrs.optOut != null) return 'none';
    const w = Number(width) || 0;
    if (attrs.actions === 'clear' || !canPaste || (w > 0 && w < 96)) return 'clear';
    if (attrs.actions === 'compact' || (w > 0 && w < 200)) return 'compact';
    return 'both';
}

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;   // zero-width and bidi control marks
const WRAP_QUOTES = /^["'`\u2018\u2019\u201C\u201D]+|["'`\u2018\u2019\u201C\u201D]+$/g;

// "1,000" / "1 000" / "1.000" style grouping: the first group 1 to 3 digits without a
// leading zero, every later group exactly 3. Anything else is not a thousands separator.
function ungroup(s, sep) {
    const groups = s.split(sep);
    if (groups.length < 2 || !/^[1-9]\d{0,2}$/.test(groups[0]) || !groups.slice(1).every(g => /^\d{3}$/.test(g))) return null;
    return groups.join('');
}

function cleanAmount(raw) {
    let t = raw.replace(ZERO_WIDTH, '').trim().replace(/^pdex\s*/i, '').replace(/\s*pdex$/i, '').trim();
    t = t.replace(/[\s_]+/g, ' ');                 // any run of spaces or underscores is one gap
    if (!/^[\d., ]+$/.test(t)) return null;        // a minus, an exponent, a letter: not ours to fix
    const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
    let dec = '';
    if (lastComma >= 0 && lastDot >= 0) dec = lastComma > lastDot ? ',' : '.';
    else if (lastDot >= 0) dec = '.';
    else if (lastComma >= 0 && t.includes(' ') && t.indexOf(',') === lastComma) dec = ',';   // "1 000,5": spaces group, so the one comma is the decimal mark
    let intPart = t, frac = '';
    if (dec) {
        const i = t.lastIndexOf(dec);
        intPart = t.slice(0, i);
        frac = t.slice(i + 1);
        if (!/^\d+$/.test(frac)) return null;
    }
    const seps = new Set(intPart.replace(/\d/g, ''));
    if (seps.size > 1) return null;
    if (seps.size === 1) {
        const sep = [...seps][0];
        if (sep === dec) return null;               // the decimal mark twice
        intPart = ungroup(intPart, sep);
        if (intPart == null) return null;
    }
    if (!/^\d+$/.test(intPart)) return null;
    return frac ? `${intPart}.${frac}` : intPart;
}

const compactHex = (s) => s.replace(ZERO_WIDTH, '').replace(/\s+/g, '').replace(WRAP_QUOTES, '');

function cleanInteger(s) {
    let t = s.replace(ZERO_WIDTH, '').replace(/\s+/g, '').replace(/^#/, '');
    if (t.includes(',')) { const u = ungroup(t, ','); if (u != null) t = u; }
    return t;
}

// What a paste of `text` puts into a field of `kind`.
//   opts.maxLength  the field's maxlength (0 or absent: none)
//   opts.room       characters free where the text goes (an insert or an append); defaults to maxLength
//   opts.multiline  a textarea
// Returns { ok: true, value[, note] } or { ok: false, message }.
export function cleanPaste(kind, text, opts = {}) {
    const raw = String(text == null ? '' : text);
    if (raw.length > MAX_CLIPBOARD) return { ok: false, message: MESSAGES.tooLong };
    if (!raw.replace(ZERO_WIDTH, '').trim()) return { ok: false, message: MESSAGES.empty };
    const multiline = !!opts.multiline;
    const oneLine = (s) => s.replace(/\r\n|\r|\n/g, ' ');
    let value;
    switch (kind) {
    case 'address': value = compactHex(raw); break;
    case 'hex': value = compactHex(raw); break;
    case 'address-list':
        value = raw.replace(ZERO_WIDTH, '').split(/[\s,;]+/).map(s => s.replace(WRAP_QUOTES, '').trim()).filter(Boolean).join('\n');
        break;
    case 'amount':
        value = cleanAmount(raw);
        if (value == null) return { ok: false, message: MESSAGES.amount };
        break;
    case 'integer': value = cleanInteger(raw); break;
    case 'ref': value = /^\s*0x/i.test(raw.replace(ZERO_WIDTH, '')) ? compactHex(raw) : cleanInteger(raw); break;
    case 'search':
    case 'code': value = oneLine(raw.trim()); break;
    default: value = multiline ? raw : oneLine(raw).trim();
    }
    if (!multiline) value = oneLine(value);
    if (!value) return { ok: false, message: MESSAGES.empty };

    const max = Number(opts.maxLength) > 0 ? Number(opts.maxLength) : 0;
    if (max) {
        const room = opts.room == null ? max : Math.max(0, Number(opts.room));
        if (value.length > room) {
            if (!multiline) return { ok: false, message: overLimit(max) };   // only free-text areas may be cut
            if (!room) return { ok: false, message: overLimit(max) };
            return { ok: true, value: value.slice(0, room), note: cutTo(max) };
        }
    }
    return { ok: true, value };
}

// ── the DOM component ──

const FIELDS = new WeakMap();      // field -> state
const DOCS = new WeakMap();        // document -> { canPaste, denied, live, ask, observer }

function docState(doc) {
    let s = DOCS.get(doc);
    if (!s) {
        const win = doc.defaultView || {};
        const nav = win.navigator || {};
        s = {
            canPaste: !!(win.isSecureContext && nav.clipboard && typeof nav.clipboard.readText === 'function'),
            denied: false, live: null, ask: null, observer: null
        };
        DOCS.set(doc, s);
    }
    return s;
}

const kindOf = (el) => { const k = el.getAttribute('data-input-kind'); return INPUT_KINDS.includes(k) ? k : 'text'; };
const isTextarea = (el) => el.tagName === 'TEXTAREA';
const maxLengthOf = (el) => { const n = parseInt(el.getAttribute('maxlength'), 10); return n > 0 ? n : 0; };

function hasSelectionApi(el) {
    try { return typeof el.selectionStart === 'number' && el.selectionStart !== null; } catch (_) { return false; }
}

function attrsOf(el) {
    return {
        tag: el.tagName, type: isTextarea(el) ? 'textarea' : (el.type || el.getAttribute('type') || ''),
        disabled: !!el.disabled || el.hasAttribute('disabled'), readOnly: !!el.readOnly || el.hasAttribute('readonly'),
        optOut: el.getAttribute('data-no-input-actions'), actions: el.getAttribute('data-input-actions')
    };
}

function modeOf(el, width) {
    const ds = docState(el.ownerDocument);
    return inputActionsMode(attrsOf(el), width, ds.canPaste && !ds.denied);
}

function widthOf(el) {
    try { const r = el.getBoundingClientRect(); return r && r.width > 0 ? r.width : 0; } catch (_) { return 0; }
}

function focusField(el) {
    if (!el || !el.isConnected) return;
    try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) { /* gone */ } }
}

function setCaret(el, pos) {
    if (!hasSelectionApi(el)) return;
    try { el.setSelectionRange(pos, pos); } catch (_) { /* not selectable */ }
}

// The layout the field had in its parent, read with the field briefly display:none so
// percentages and auto come back as specified rather than as used pixels.
const LAYOUT = ['flex-grow', 'flex-shrink', 'flex-basis', 'align-self', 'justify-self', 'order',
    'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end', 'min-width', 'max-width',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left'];
const DEFAULTS = { 'flex-grow': '0', 'flex-shrink': '1', order: '0' };
const SKIP = new Set(['', 'auto', 'none', 'normal', 'initial']);

function moveLayout(el, wrap, win) {
    if (!win || typeof win.getComputedStyle !== 'function') return;
    const parent = el.parentElement;
    let shown = 'inline-block', parentDisplay = '';
    try { shown = win.getComputedStyle(el).display || shown; } catch (_) { /* keep */ }
    try { parentDisplay = parent ? win.getComputedStyle(parent).display || '' : ''; } catch (_) { /* keep */ }
    const prev = el.style.getPropertyValue('display'), prio = el.style.getPropertyPriority('display');
    const v = {};
    try {
        el.style.setProperty('display', 'none', 'important');
        const cs = win.getComputedStyle(el);
        for (const p of [...LAYOUT, 'width']) v[p] = String(cs.getPropertyValue(p) || '').trim();
    } catch (_) { /* no styles: nothing to move */ }
    if (prev) el.style.setProperty('display', prev, prio); else el.style.removeProperty('display');

    wrap.style.display = /^(block|flex|grid|table|list-item)$/.test(shown) ? 'block' : 'inline-block';
    let movedMargin = false;
    for (const p of LAYOUT) {
        const val = v[p];
        if (!val || SKIP.has(val) || DEFAULTS[p] === val) continue;
        if (p.startsWith('margin-')) { if (parseFloat(val) === 0) continue; movedMargin = true; }
        wrap.style.setProperty(p, val);
    }
    if (movedMargin) el.style.setProperty('margin', '0px');
    const flexParent = /flex/.test(parentDisplay), gridParent = /grid/.test(parentDisplay);
    const width = v.width;
    let fill = false;
    if (width && !SKIP.has(width)) { wrap.style.setProperty('width', width); fill = true; }
    else if (flexParent && (parseFloat(v['flex-grow']) > 0 || (v['flex-basis'] && v['flex-basis'] !== 'auto'))) fill = true;
    else if (gridParent) fill = true;
    else if (wrap.style.display === 'block') wrap.style.setProperty('width', 'fit-content');
    if (fill) el.style.setProperty('width', '100%');
}

// A label's own words, without the field or any control inside it.
function labelText(label) {
    const copy = label.cloneNode(true);
    for (const n of Array.from(copy.querySelectorAll('input, textarea, select, button, output, .ia-actions, .ia-hint'))) n.remove();
    return String(copy.textContent || '').replace(/\s+/g, ' ').trim();
}

function makeButton(doc, which, toolbar) {
    const b = doc.createElement('button');
    b.setAttribute('type', 'button');
    b.setAttribute('tabindex', '-1');
    b.className = `ia-btn ia-${which}${toolbar ? ' md-tool' : ''}`;
    const label = which === 'paste' ? 'Paste from clipboard' : 'Clear';
    b.setAttribute('aria-label', label);
    b.setAttribute('title', label);
    const i = doc.createElement('i');
    i.className = `bx ${which === 'paste' ? 'bx-paste' : 'bx-x'}`;
    i.setAttribute('aria-hidden', 'true');
    b.appendChild(i);
    // Keep focus (and the mobile keyboard) in the field: no blur, no blur validation.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    return b;
}

// Show or hide each button for the field's current value.
function sync(el) {
    const st = FIELDS.get(el);
    if (!st) return;
    const empty = !el.value;
    if (st.clear) st.clear.hidden = empty;
    if (st.paste) st.paste.hidden = st.mode === 'compact' && !empty;
}

// Build or rebuild the buttons for the field's current mode.
function render(el) {
    const st = FIELDS.get(el);
    if (!st) return;
    const mode = modeOf(el, st.width);
    st.mode = mode;
    el.setAttribute('data-ia', mode);
    const doc = el.ownerDocument;
    const wantClear = mode !== 'none';
    const wantPaste = mode === 'both' || mode === 'compact';
    if (wantClear && !st.clear) {
        st.clear = makeButton(doc, 'clear', st.toolbar);
        st.clear.addEventListener('click', (e) => { e.preventDefault(); st.pending = onClear(el); });
        st.actions.insertBefore(st.clear, st.actions.firstChild);
    } else if (!wantClear && st.clear) { st.clear.remove(); st.clear = null; }
    if (wantPaste && !st.paste) {
        st.paste = makeButton(doc, 'paste', st.toolbar);
        st.paste.addEventListener('click', (e) => { e.preventDefault(); st.pending = onPaste(el); });
        st.actions.appendChild(st.paste);
    } else if (!wantPaste && st.paste) { st.paste.remove(); st.paste = null; }
    st.actions.hidden = mode === 'none';
    sync(el);
}

function remeasure(el) {
    const st = FIELDS.get(el);
    if (!st || st.width) return;
    const w = widthOf(el);
    if (!w) return;
    st.width = w;
    if (st.ro) { try { st.ro.disconnect(); } catch (_) { /* gone */ } st.ro = null; }
    render(el);
}

function enhanceField(el) {
    if (!el || !el.isConnected || !el.ownerDocument) return false;
    if (FIELDS.has(el)) { render(el); return false; }
    if (el.closest('.ia-actions')) return false;
    const width = widthOf(el);
    if (modeOf(el, width) === 'none') return false;

    const doc = el.ownerDocument, win = doc.defaultView;
    const hadFocus = doc.activeElement === el;
    let sel = null;
    if (hadFocus && hasSelectionApi(el)) sel = [el.selectionStart, el.selectionEnd];

    const label = el.closest('label');
    if (label && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
        const text = labelText(label);
        if (text) el.setAttribute('aria-label', text);
    }

    const ta = isTextarea(el);
    const wrap = doc.createElement('span');
    wrap.className = ta ? 'ia-wrap ia-wrap-ta' : 'ia-wrap';
    moveLayout(el, wrap, win);
    el.parentNode.insertBefore(wrap, el);

    const actions = doc.createElement('span');
    let toolbar = false;
    const mountSel = ta ? el.getAttribute('data-input-actions-mount') : '';
    const host = mountSel ? (el.closest('.md-composer') || el.parentElement || doc).querySelector(mountSel) : null;
    if (host) {
        toolbar = true;
        actions.className = 'ia-actions ia-actions-toolbar';
        host.appendChild(actions);
        wrap.appendChild(el);
    } else if (ta) {
        actions.className = 'ia-actions ia-actions-top';
        wrap.appendChild(actions);
        wrap.appendChild(el);
    } else {
        actions.className = 'ia-actions';
        wrap.appendChild(el);
        wrap.appendChild(actions);
    }

    const st = { wrap, actions, toolbar, paste: null, clear: null, mode: 'none', width, ro: null, hintTimer: 0, pending: null };
    FIELDS.set(el, st);
    el.setAttribute('data-ia', 'none');
    render(el);

    const resync = () => sync(el);
    for (const type of ['input', 'change', 'pointerover']) wrap.addEventListener(type, resync);
    wrap.addEventListener('focusin', () => { remeasure(el); sync(el); });
    if (!width && win && typeof win.ResizeObserver === 'function') {
        try { st.ro = new win.ResizeObserver(() => remeasure(el)); st.ro.observe(el); } catch (_) { st.ro = null; }
    }

    if (hadFocus) {
        focusField(el);
        if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch (_) { /* not selectable */ } }
    }
    return true;
}

// Enhance every text box in `root` (an element or the document). Returns how many were
// new. Safe to call again: a field is wrapped once.
export function enhanceInputActions(root) {
    if (!root) return 0;
    const scope = root.nodeType === 9 ? root.body : root;
    if (!scope) return 0;
    const list = [];
    if (scope.matches && scope.matches('input, textarea')) list.push(scope);
    if (scope.querySelectorAll) list.push(...scope.querySelectorAll('input, textarea'));
    let n = 0;
    for (const el of list) { try { if (enhanceField(el)) n++; } catch (_) { /* one odd field must not stop the rest */ } }
    return n;
}

// For code that sets .value directly (Max buttons, prefill, a form reset).
export function syncInputActions(el) {
    if (!el) return;
    if (FIELDS.has(el)) render(el); else enhanceField(el);
}

// ── feedback ──

function announce(doc, text) {
    const ds = docState(doc);
    if (!ds.live || !ds.live.isConnected) {
        ds.live = doc.querySelector('.ia-live');
        if (!ds.live) {
            ds.live = doc.createElement('div');
            ds.live.className = 'sr-only ia-live';
            ds.live.setAttribute('aria-live', 'polite');
            doc.body.appendChild(ds.live);
        }
    }
    ds.live.textContent = text;
}

function hint(el, text) {
    const st = FIELDS.get(el);
    const doc = el.ownerDocument, win = doc.defaultView;
    announce(doc, text);
    if (!st) return;
    let h = st.wrap.querySelector('.ia-hint');
    if (!h) {
        h = doc.createElement('span');
        h.className = 'ia-hint stake-hint';
        st.wrap.appendChild(h);
    }
    h.textContent = text;
    if (st.hintTimer) win.clearTimeout(st.hintTimer);
    st.hintTimer = win.setTimeout(() => { st.hintTimer = 0; h.remove(); }, HINT_MS);
}

function blockedMessage(win) {
    const nav = win.navigator || {};
    if (typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches) return 'Clipboard is blocked. Press and hold the field, then tap Paste.';
    const platform = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || '';
    return /mac|iphone|ipad/i.test(platform) ? 'Clipboard is blocked. Press Cmd+V to paste.' : 'Clipboard is blocked. Press Ctrl+V to paste.';
}

// Chromium can say the permission is denied: then no Paste anywhere for the session.
// Elsewhere the query is unsupported and the button stays (the bubble may just have
// been dismissed).
async function checkDenied(doc) {
    const nav = (doc.defaultView || {}).navigator || {};
    if (!nav.permissions || typeof nav.permissions.query !== 'function') return;
    try {
        const status = await nav.permissions.query({ name: 'clipboard-read' });
        if (!status || status.state !== 'denied') return;
    } catch (_) { return; }
    docState(doc).denied = true;
    for (const f of Array.from(doc.querySelectorAll('[data-ia]'))) if (FIELDS.has(f)) render(f);
}

// ── writing ──

// The field that stands where `el` stood, when an input handler re-rendered it.
function replacementOf(el, ancestors) {
    if (el.isConnected) return el;
    const doc = el.ownerDocument;
    if (el.id) return doc.getElementById(el.id);
    const anchor = ancestors.find(a => a.isConnected) || doc.body;
    let sel = el.tagName.toLowerCase();
    for (const c of Array.from(el.classList)) if (!c.startsWith('ia-')) sel += '.' + c.replace(/[^\w-]/g, '\\$&');
    for (const a of ['data-col', 'name', 'data-f', 'data-i']) {
        const v = el.getAttribute(a);
        if (v != null) sel += `[${a}="${v.replace(/["\\]/g, '\\$&')}"]`;
    }
    try { return anchor.querySelector(sel); } catch (_) { return null; }
}

// Replace [start, end) with `piece`, fire input then change, and leave focus and the
// caret in the field (or in the field that replaced it).
function write(el, start, end, piece, inputType) {
    const doc = el.ownerDocument, win = doc.defaultView;
    const before = el.value;
    const next = before.slice(0, start) + piece + before.slice(end);
    const ancestors = [];
    for (let a = el.parentElement; a; a = a.parentElement) ancestors.push(a);

    // Through the browser's editing command where it exists, so Ctrl+Z still works.
    let viaCommand = false;
    if (doc.activeElement === el && hasSelectionApi(el) && typeof doc.execCommand === 'function') {
        try {
            focusField(el);
            el.setSelectionRange(start, end);
            const ran = piece ? doc.execCommand('insertText', false, piece) : doc.execCommand('delete', false);
            viaCommand = !!ran && el.value === next;
        } catch (_) { viaCommand = false; }
        if (!viaCommand && el.value !== before && el.value !== next) el.value = before;
    }
    if (!viaCommand) {
        el.value = next;
        setCaret(el, start + piece.length);
        let ev;
        try { ev = new win.InputEvent('input', { bubbles: true, inputType, data: piece || null }); } catch (_) { ev = new win.Event('input', { bubbles: true }); }
        el.dispatchEvent(ev);
    }
    el.dispatchEvent(new win.Event('change', { bubbles: true }));

    const target = replacementOf(el, ancestors) || el;
    if (target !== el) {
        enhanceInputActions(target);
        focusField(target);
        setCaret(target, target.value.length);
    } else {
        focusField(el);
        setCaret(el, start + piece.length);
    }
    sync(target);
    return target;
}

// A field that is not on screen (a composer in Preview) must not be changed by a stale click.
const isShown = (el) => !(el.hidden || (el.style && el.style.display === 'none'));

async function onPaste(el) {
    const doc = el.ownerDocument, win = doc.defaultView;
    if (!isShown(el)) return;
    focusField(el);
    let text;
    try {
        text = await win.navigator.clipboard.readText();
    } catch (_) {
        focusField(el);
        hint(el, blockedMessage(win));
        await checkDenied(doc);
        return;
    }
    const kind = kindOf(el);
    const multiline = isTextarea(el);
    const max = maxLengthOf(el);
    const value = el.value;
    let start = 0, end = value.length, prefix = '';
    if (kind === 'text' && hasSelectionApi(el)) {
        start = el.selectionStart; end = el.selectionEnd;
    } else if (kind === 'address-list' && value.trim()) {
        start = end = value.length;
        prefix = value.endsWith('\n') ? '' : '\n';
    }
    const room = max ? max - (value.length - (end - start)) - prefix.length : undefined;
    const r = cleanPaste(kind, text, { maxLength: max, room, multiline });
    if (!r.ok) { focusField(el); hint(el, r.message); return; }
    write(el, start, end, prefix + r.value, 'insertFromPaste');
    if (r.note) hint(el, r.note); else announce(doc, MESSAGES.pasted);
}

async function onClear(el) {
    const doc = el.ownerDocument;
    if (!isShown(el)) return;
    focusField(el);
    if (isTextarea(el) && kindOf(el) === 'text' && el.value.length > LONG_DRAFT) {
        const ds = docState(doc);
        if (!ds.ask) ds.ask = createConfirmDialog(doc, { title: 'Clear this draft?', confirmLabel: 'Clear', cancelLabel: 'Keep writing' });
        const yes = await ds.ask('What you wrote here will be removed.');
        if (!yes) { focusField(el); return; }
    }
    if (!el.value) { focusField(el); return; }
    write(el, 0, el.value.length, '', 'deleteContentBackward');
    announce(doc, MESSAGES.cleared);
}

// ── fields rendered later ──

// Enhance the page now, then every text box that is added or whose disabled / readonly
// changes, once per animation frame. Also re-checks emptiness after any click, for
// values set by code (Max buttons). Returns the MutationObserver.
export function startInputActionsObserver(doc) {
    if (!doc || !doc.body) return null;
    const ds = docState(doc);
    if (ds.observer) return ds.observer;
    const win = doc.defaultView;
    enhanceInputActions(doc.body);
    const pending = new Set();
    let scheduled = false, syncAll = false;
    const frame = (fn) => (typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame(fn) : win.setTimeout(fn, 16));
    const flush = () => {
        scheduled = false;
        const items = Array.from(pending);
        pending.clear();
        for (const n of items) {
            try {
                if (!n.isConnected) continue;
                if (FIELDS.has(n)) render(n); else enhanceInputActions(n);
            } catch (_) { /* keep going */ }
        }
        if (syncAll) {
            syncAll = false;
            for (const f of Array.from(doc.querySelectorAll('[data-ia]'))) if (FIELDS.has(f)) sync(f);
        }
    };
    const schedule = () => { if (!scheduled) { scheduled = true; frame(flush); } };
    const mo = new win.MutationObserver((records) => {
        for (const r of records) {
            if (r.type === 'attributes') { if (r.target.nodeType === 1) pending.add(r.target); continue; }
            for (const n of r.addedNodes) {
                if (n.nodeType !== 1) continue;
                if (n.closest && n.closest('.ia-wrap, .ia-actions')) continue;   // our own inserts
                pending.add(n);
            }
        }
        if (pending.size) schedule();
    });
    mo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'readonly'] });
    doc.addEventListener('click', () => { syncAll = true; schedule(); }, true);
    ds.observer = mo;
    return mo;
}
