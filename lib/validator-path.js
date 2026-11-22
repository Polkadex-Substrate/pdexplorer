// The path strip on /validate (spec 2026-11-21-validate-redesign-and-colour-roles.md, section 3.3):
// three steps, Run a node, Set up, Manage, that show where the connected wallet's own stash stands
// and are the navigation. pathState is pure (tested in test/validate-hub.test.js); renderPath is markup.
//
// Two forms (fidelity review 1): the full strip (cards with chips and sub lines) for the visitor and the
// setup states, where it holds the primary; one compact line (markers and names, Run a node and Set up as
// links) for the manage states and while nothing is read yet. Step 3 has no link: the dashboard is the
// status (review 9 deleted "See status").
//
// The one primary of a state is ctaFor's (lib/validator-status.js), unchanged: Connect wallet goes
// in the connect bar, the setup primary replaces "Open setup" on the step 2 card. A looked-up stash
// (another account) has no path strip: the page is a report on that account.
//
// Step 1 can never be "done" from what the explorer sees, except when keys are on chain: keys on
// chain can only come from a node. The explorer cannot see a server.

import { ctaFor } from './validator-status.js';
import { icon, chipHtml as uiChip } from './ui-parts.js';

export const PATH_STEPS = Object.freeze([
    { n: 1, id: 'node', icon: 'bx-server', name: 'Run a node', sub: 'Server, client, start command and session keys.', link: { label: 'Open the guide', href: '/validate/node' } },
    { n: 2, id: 'setup', icon: 'bx-rocket', name: 'Set up', sub: 'Bond, register your keys and set commission.', link: { label: 'Open setup', href: '/validate/setup' } },
    { n: 3, id: 'manage', icon: 'bx-slider-alt', name: 'Manage', sub: 'Status, commission, key rotation and alerts.', link: null }
].map(Object.freeze));

// Chip words of section 3.3. Every chip has an icon (R4).
export const STEP_CHIPS = Object.freeze({
    start: { word: 'Start here', cls: 'is-step', icon: 'bx-right-arrow-alt' },
    next: { word: 'Next', cls: 'is-step', icon: 'bx-right-arrow-alt' },
    here: { word: 'You are here', cls: 'is-step', icon: 'bx-map-pin' },
    done: { word: 'Done', cls: 'is-positive', icon: 'bx-check' },
    later: { word: 'Later', cls: 'is-neutral', icon: 'bx-dots-horizontal-rounded' }
});

export const SETUP_STATES = new Set(['not-bonded', 'bonded-no-keys', 'keys-not-validating']);
const MANAGE_STATES = new Set(['waiting', 'elected-next', 'active', 'active-leaving', 'disabled']);

// state: the headline state of the own stash, or null when there is none yet (no wallet, restoring, loading).
// Returns { steps: [{ ...PATH_STEPS[i], marker, chip, current }], primary: { label, href, at } | null },
// or null for another account.
export function pathState(state, { connected = false, own = true, hasKeys = false, restoring = false } = {}) {
    if (connected && !own) return null;
    const mk = (marker, chip) => ({ marker, chip: chip ? { ...STEP_CHIPS[chip] } : null, current: marker === 'current' });
    let plan, primary = null;
    if (!connected && !restoring) {
        plan = [mk('current', 'start'), mk('later', 'later'), mk('later', 'later')];
        primary = { ...ctaFor('none', { connected: false }), at: 'connect' };
    } else if (connected && SETUP_STATES.has(state)) {
        const keysOnChain = state === 'keys-not-validating' || (hasKeys && state !== 'not-bonded' && state !== 'bonded-no-keys');
        plan = [keysOnChain ? mk('done', 'done') : mk('open', null), mk('current', 'next'), mk('later', 'later')];
        primary = { ...ctaFor(state, { connected: true, own: true }), at: 'step2' };
    } else if (connected && MANAGE_STATES.has(state)) {
        plan = [mk('done', 'done'), mk('done', 'done'), mk('current', 'here')];
    } else {
        // Restoring, or the own stash not read yet (or not readable): nothing to say, no chips.
        plan = [mk('later', null), mk('later', null), mk('later', null)];
    }
    return { steps: PATH_STEPS.map((s, i) => ({ ...s, link: s.link ? { ...s.link } : null, ...plan[i] })), primary };
}

const chipHtml = (c, esc) => (c ? uiChip(c.cls, c.icon, c.word, esc) : '');
const marker = (s, esc) => (s.marker === 'done'
    ? `<span class="ui-step is-done">${icon('bx-check')}<span class="sr-only">done</span></span>`
    : `<span class="ui-step is-${s.marker}">${esc(s.n)}</span>`);

// ps: pathState(...). compact: one line of three markers with names; a step with a link keeps it as its name.
export function renderPath(ps, { esc, compact = false } = {}) {
    if (!ps) return '';
    if (compact) {
        return '<ol class="validate-path is-compact" aria-label="Validator path">' + ps.steps.map(s => `<li class="validate-path-card is-${s.marker}"${s.current ? ' aria-current="step"' : ''}>${marker(s, esc)}`
            + (s.link ? `<a href="${esc(s.link.href)}" class="validate-path-name validate-path-link" data-spa-link="true">${esc(s.name)}</a>` : `<span class="validate-path-name">${esc(s.name)}</span>`)
            + '</li>').join('') + '</ol>';
    }
    return '<ol class="validate-path" aria-label="Validator path">' + ps.steps.map(s => {
        const primary = ps.primary && ps.primary.at === 'step2' && s.n === 2;
        const action = primary
            ? `<a href="${esc(ps.primary.href)}" class="validate-primary" data-spa-link="true">${esc(ps.primary.label)}</a>`
            : s.link ? `<a href="${esc(s.link.href)}" class="validate-path-link" data-spa-link="true">${esc(s.link.label)}${icon('bx-chevron-right')}</a>` : '';
        return `<li class="validate-path-card is-${s.marker}${primary ? ' has-primary' : ''}"${s.current ? ' aria-current="step"' : ''}>`
            + marker(s, esc)
            + '<div class="validate-path-main">'
            + `<p class="validate-path-name">${icon(s.icon)}<span>${esc(s.name)}</span>${chipHtml(s.chip, esc)}</p>`
            + `<p class="validate-path-sub">${esc(s.sub)}</p>`
            + action
            + '</div></li>';
    }).join('') + '</ol>';
}
