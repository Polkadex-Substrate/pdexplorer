// Validator onboarding, Sprint 7 (rollout gap A2): "Manage this validator" on
// the public validator page (design 5.1: "when the connected wallet is the
// stash, controller or a proxy of this validator, a secondary button").
//
// Shown only with FEATURE_FLAGS.validate on and a connected account that is:
//   - the stash: a link to /validate (the dashboard follows the wallet);
//   - its controller (an older setup): a link to /validate/<stash>;
//   - a qualifying proxy of it: a type that can make at least one manage
//     action on this runtime (lib/validator-delegate.js proxyAllows over the
//     KIND_CALLS of lib/validator-manage.js) with no announcement delay, the
//     same rule the manage panel applies: a link to /validate/<stash>;
//   - a member of the multisig that is the stash (saved in this browser): a
//     button that switches to the multisig wallet, then opens /validate.
// Secondary style only: the page keeps its one primary (BRAND.md). A proxy
// read that fails counts as no proxies (no guess): stash, controller and
// multisig still get the button. Tested in
// test/validator-rollout-s7.test.js.

import { proxyAllows } from './validator-delegate.js';
import { KIND_CALLS } from './validator-manage.js';

export const MANAGE_LINK_TEXT = 'Manage this validator';

export const canManage = (type) => Object.values(KIND_CALLS).some(([pallet, call]) => proxyAllows(type, pallet, call));

export function manageRole({ stash, controller = null, me, proxies = [], multisig = null, isSame = (a, b) => a === b } = {}) {
    if (!me || !stash) return { role: null };
    if (isSame(me, stash)) return { role: 'stash' };
    if (controller && isSame(me, controller)) return { role: 'controller' };
    const p = (proxies || []).find(x => isSame(x.delegate, me) && Number(x.delay || 0) === 0 && canManage(x.type));
    if (p) return { role: 'proxy', type: String(p.type) };
    if (multisig && isSame(multisig.address, stash) && (multisig.signers || []).some(s => isSame(s, me))) return { role: 'multisig' };
    return { role: null };
}

const current = new WeakMap();

// d: { enabled, account, stash, controller, readProxies(stash) async,
// findMultisig(address), isSame, esc, selectMultisig(address), navigate(route) }
export async function mountManageLink(el, d) {
    if (!el) return;
    const token = {};
    current.set(el, token);
    el.innerHTML = '';
    const me = d.account && d.account.status === 'connected' ? String(d.account.address || '') : '';
    if (!d.enabled || !me || !d.stash) return;
    const isSame = typeof d.isSame === 'function' ? d.isSame : (a, b) => a === b;
    const quick = manageRole({ stash: d.stash, controller: d.controller, me, isSame });
    let role = quick;
    if (!role.role) {
        // A failed proxy read must not hide the other roles: carry on with no proxies.
        let proxies = [];
        try { proxies = await d.readProxies(d.stash); } catch (e) { proxies = []; }
        if (current.get(el) !== token) return;
        const multisig = typeof d.findMultisig === 'function' ? d.findMultisig(d.stash) : null;
        role = manageRole({ stash: d.stash, controller: d.controller, me, proxies, multisig, isSame });
    }
    if (current.get(el) !== token || !role.role) return;
    const esc = d.esc;
    if (role.role === 'multisig') {
        el.innerHTML = `<button type="button" class="validate-secondary">${esc(MANAGE_LINK_TEXT)}</button>`;
        el.querySelector('button').addEventListener('click', () => { d.selectMultisig(d.stash); d.navigate('validate'); });
        return;
    }
    const href = role.role === 'stash' ? '/validate' : '/validate/' + encodeURIComponent(d.stash);
    el.innerHTML = `<a href="${esc(href)}" class="validate-secondary" data-spa-link="true">${esc(MANAGE_LINK_TEXT)}</a>`;
}
