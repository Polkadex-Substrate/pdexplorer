// A very small DOM stand-in for the close-control tests: elements with
// attributes, a parent chain, dispatchable events and the selector forms the
// close layer uses (tag, .class, [attr], [attr="v"], comma lists).
// happy-dom is not always installed, and these tests need no layout.

function matchOne(el, sel) {
    sel = sel.trim();
    let m;
    if ((m = /^\.([\w-]+)$/.exec(sel))) return el.classList().includes(m[1]);
    if ((m = /^\[([\w-]+)\]$/.exec(sel))) return el.attrs[m[1]] !== undefined;
    if ((m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel))) return el.attrs[m[1]] === m[2];
    if ((m = /^\[([\w-]+)\^="([^"]*)"\]$/.exec(sel))) return String(el.attrs[m[1]] || '').startsWith(m[2]);
    if ((m = /^(\w+)\[([\w-]+)="([^"]*)"\]$/.exec(sel))) return el.tag === m[1] && el.attrs[m[2]] === m[3];
    if (/^\w+$/.test(sel)) return el.tag === sel;
    return false;
}

export class El {
    constructor(tag, attrs = {}, children = []) {
        this.tag = tag; this.attrs = { ...attrs }; this.children = []; this.parent = null;
        this.dataset = {}; this.style = {}; this.value = ''; this.type = attrs.type || 'text';
        this.readOnly = false; this.disabled = false; this.listeners = {}; this.focused = false; this.clicks = 0;
        for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
        children.forEach(c => this.add(c));
    }
    add(c) { c.parent = this; this.children.push(c); return c; }
    classList() { return String(this.attrs.class || '').split(/\s+/).filter(Boolean); }
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    hasAttribute(k) { return this.attrs[k] !== undefined; }
    matches(sel) { return sel.split(',').some(s => matchOne(this, s)); }
    closest(sel) { for (let e = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
    contains(o) { for (let e = o; e; e = e.parent) if (e === this) return true; return false; }
    querySelectorAll(sel) { const out = []; const walk = e => e.children.forEach(c => { if (c.matches(sel)) out.push(c); walk(c); }); walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(t, fn, cap) { (this.listeners[t] = this.listeners[t] || []).push({ fn, cap: !!cap }); }
    focus() { this.focused = true; if (this.ownerDoc) this.ownerDoc.activeElement = this; }
    // Capture listeners from the root down, then the target, then bubble up.
    dispatch(type, init = {}) {
        const path = []; for (let e = this; e; e = e.parent) path.unshift(e);
        const ev = { type, target: this, key: init.key, defaultPrevented: false, stopped: false, immediate: false,
            preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
            stopImmediatePropagation() { this.stopped = true; this.immediate = true; }, ...init };
        for (const el of path.slice(0, -1)) { if (ev.stopped) return ev; for (const l of (el.listeners[type] || [])) if (l.cap) { if (ev.immediate) return ev; l.fn(ev); } }
        if (!ev.stopped) for (const l of (this.listeners[type] || [])) { if (ev.immediate) break; l.fn(ev); }
        for (const el of path.slice(0, -1).reverse()) { if (ev.stopped) break; for (const l of (el.listeners[type] || [])) if (!l.cap) l.fn(ev); }
        return ev;
    }
    click() { this.clicks++; return this.dispatch('click'); }
}

export function makeDoc(...kids) {
    const root = new El('html');
    kids.forEach(k => root.add(k));
    root.activeElement = null;
    const all = e => [e, ...e.children.flatMap(all)];
    all(root).forEach(e => { e.ownerDoc = root; });
    root.contains = (o) => { for (let e = o; e; e = e.parent) if (e === root) return true; return false; };
    return root;
}
export const field = (value, attrs = {}) => { const e = new El(attrs.tag || 'textarea', attrs); e.value = value; return e; };
