// The real explorer page (test/helpers/full-page.js, one child process per page) read back as DOM, and the real
// stylesheet read as a cascade, for the page head and tab tests (plan 2026-11-25-page-header-alignment).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';

const RUNNER = fileURLToPath(new URL('./full-page.js', import.meta.url));
export const INDEX_HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
export const STYLES_CSS = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

export function runPage(scenario) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [RUNNER, JSON.stringify(scenario)], { timeout: 90000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
            const line = String(stdout).split('\n').find(l => l.startsWith('RESULT '));
            if (!line) return reject(new Error('the page did not report: ' + (err ? err.message : '') + '\n' + String(stderr).slice(-1500)));
            resolve(JSON.parse(line.slice(7)));
        });
    });
}

// A happy-dom document holding markup (and, when asked, the real stylesheet).
export function parse(html, { css = '' } = {}) {
    const win = new Window({ url: 'https://explorer.test/', width: 1280, settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    if (css) win.document.head.innerHTML = `<style>${css}</style>`;
    win.document.body.innerHTML = html;
    return win;
}

// The hover and focus twins the preview tool writes (a static page cannot hover): .account-tab:hover becomes .account-tab.pv-hover.
export function withHoverTwins(css) {
    return css.replace(/([^{}@]+)\{([^{}]*)\}/g, (m, sel, body) => {
        if (!/:hover|:focus-visible/.test(sel)) return m;
        const twin = sel.trim().replace(/\s+/g, ' ').split(',').map(x => x.replace(/:hover/g, '.pv-hover').replace(/:focus-visible/g, '.pv-focus')).join(',');
        return `${m}\n${twin}{${body}}`;
    });
}

export const treasuryApi = (over = {}) => ({ '/api/treasury': { proposals: [], approvals: [], allProposals: [], spendableFunds: 1250, proposalCount: 87, status: 'Synced', ...over } });
export const democracyApi = (over = {}) => ({ '/api/democracy': { referenda: [], publicProposals: [], referendumCount: 1, status: 'Synced', currentBlock: 100, launchPeriod: 50, ...over } });
export const councilApi = () => ({
    '/api/council': { members: [], runnersUp: [], candidates: [], motions: [], desiredMembers: 3, termDuration: 100, blocksRemaining: 50, pallet: 'elections', collectivePallet: 'council' },
    '/api/technical-committee': { members: [], motions: [], proposalCount: 0, collectivePallet: 'technicalCommittee' }
});
export const ACCOUNT = encodeAddress(new Uint8Array(32).fill(7), 88);   // synthetic: belongs to no one
export const accountApi = () => ({ '/api/account/': { account: ACCOUNT, display: 'Unknown', balanceTotal: 1, balanceFree: 1, balanceReserved: 0, balanceFrozen: 0, roles: 'none', rank: '0', transactions: [], events: [], status: 'Synced' } });

// Steps that click each tab in turn and dump the tab row after each click.
export const tabSteps = (keys, attr, rowSelector) => keys.flatMap(k => [{ click: `[${attr}="${k}"]` }, { dump: rowSelector }]);
