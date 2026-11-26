// Sprint 11 site sweep, WP1 (cto-team/plans/2026-11-26-sprint11-site-sweep.md, section 6.3): the preview scenes of the
// pages and modals WP1 changes, built by tools/preview-scenes.mjs (set "site", files site-<scene>-<width>.html at 1280
// and 375) from the REAL page (index.html and script.js in happy-dom, the real lib views mounted where the page needs a
// chain), then read back here. Each scene: no .staking-download-btn anywhere; at most one primary drawn; no colour,
// background or border written in markup inside the part WP1 changed (the focus; the rest of a page is WP2 and WP3);
// the focus is drawn.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const TOOL = fileURLToPath(new URL('../tools/preview-scenes.mjs', import.meta.url));
// [scene, focus: the part WP1 changed, what the scene must show]
const SCENES = [
    ['modal-withdraw-candidacy', '#council-withdraw-modal', '#council-withdraw-sign.validate-primary.is-solid'],
    ['modal-propose-spend-review', '#treasury-spend-modal', '#treasury-spend-review .ca-args, #treasury-spend-review .gd-args'],
    ['modal-referendum-vote-aye', '#referendum-vote-modal', '#referendum-vote-side-aye[aria-pressed="true"]'],
    ['modal-council-vote', '#council-vote-modal', '#council-vote-available-list .council-vote-row'],
    ['modal-candidacy', '#council-candidacy-modal', '#submit-candidacy-tx-btn.modal-submit-btn'],
    ['email-alerts-modal', '#email-subscribe-modal', '#email-subscribe-submit.validate-primary.is-solid'],
    ['storage-notice', '#storage-notice-dismiss', '#storage-notice-banner a.validate-text-btn[href="/privacy"]'],
    ['rewards-result', '.staking-toolbar-actions', '#staking-dl-csv.validate-secondary'],
    ['chain-state-result', '#cs-export', '#cs-dl-json.validate-secondary'],
    ['discussions-failed', '#discussions-content', '#discussions-retry-btn.validate-secondary'],
    ['democracy-failed', '#democracy-content', '#democracy-retry-btn.validate-secondary'],
    ['treasury-failed', '#treasury-content', '#treasury-retry-btn.validate-secondary'],
    ['account-labels-signed-out', '#account-label-signin', '#account-label-signin.ui-action'],
    ['watchlist-items', '#watchlist-clear-all', '#watchlist-clear-all.validate-text-btn.is-danger'],
    ['tx-not-found', '#tx-recover-btn', '#tx-details-container a.validate-secondary[href^="/search"]']
];
const PRIMARY = '.validate-primary, .wallet-option-row.is-primary, .modal-submit-btn';
const COLOUR = /(^|;)\s*(color|background(-color|-image)?|border(?!-radius)(-[a-z]+)*)\s*:/i;
const hidden = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { if (e.hasAttribute('hidden') || /display:\s*none/.test(e.getAttribute('style') || '')) return true; } return false; };

let dir = null, files = [], run = null;
before(() => {
    dir = mkdtempSync(join(tmpdir(), 's11-scenes-'));
    try {
        execFileSync(process.execPath, ['--experimental-sqlite', TOOL, '--wp', 'site', '--out', dir], { stdio: 'pipe', timeout: 400000, maxBuffer: 1 << 26 });
        files = readdirSync(dir);
    } catch (e) { run = String(e.stderr || e.message).split('\n').slice(0, 6).join('\n'); }
}, { timeout: 420000 });
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
const sceneDoc = (name) => {
    const html = readFileSync(join(dir, name), 'utf8');
    const inner = /srcdoc="([^"]*)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const win = new Window({ url: 'https://explorer.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    win.document.body.innerHTML = (/<body[^>]*>([\s\S]*)<\/body>/.exec(inner) || [])[1] || '';
    return win.document;
};

describe('the site scenes of WP1 (tools/preview-scenes.mjs --wp site)', () => {
    test('the tool builds the set without refusing', () => assert.equal(run, null, `the tool refused:\n${run}`));
    for (const [id, focus, must] of SCENES) {
        for (const width of [1280, 375]) {
            test(`site-${id}-${width}: built; ${must} shown; no legacy class; at most one primary; no colour in markup inside ${focus}`, () => {
                const name = `site-${id}-${width}.html`;
                assert.ok(files.includes(name), `no ${name}`);
                const doc = sceneDoc(name);
                assert.equal(doc.querySelectorAll('.staking-download-btn').length, 0, 'a .staking-download-btn in the scene');
                const shown = Array.from(doc.querySelectorAll(PRIMARY)).filter(e => !hidden(e));
                assert.ok(shown.length <= 1, `${shown.length} primaries drawn: ${shown.map(e => e.id || e.className).join(', ')}`);
                const root = doc.querySelector(focus);
                assert.ok(root && !hidden(root), `${focus} is not drawn`);
                const el = doc.querySelector(must);
                assert.ok(el && !hidden(el), `${must} is not drawn`);
                const bad = [root, ...root.querySelectorAll('[style]')].filter(e => e.hasAttribute('style') && COLOUR.test(';' + e.getAttribute('style'))).map(e => `<${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} style="${e.getAttribute('style').slice(0, 80)}">`);
                assert.deepEqual(bad, [], 'a colour written in markup');
            });
        }
    }
});
