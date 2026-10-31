// The account picker's markup, kept apart from the page so it can be tested.
//
// What the picker has to get right that it did not before:
//   - say WHICH extension each account comes from. "Switch to another wallet"
//     usually means another extension (Polkadot.js to Talisman), and a flat list
//     of unlabeled names gave no way to tell two same-named accounts apart;
//   - mark the account that is connected right now, so a switch is visibly a
//     choice between things;
//   - say what to do when the account the user wants is not in the list. An
//     extension only shares the accounts the user allowed for this site, and no
//     page can widen that - so the empty case needs instructions, not silence.

// Display names for the keys extensions self-declare on window.injectedWeb3.
const SOURCE_LABELS = {
    'multisig': 'Multisig wallet',
    'polkadot-js': 'Polkadot.js',
    'talisman': 'Talisman',
    'subwallet-js': 'SubWallet',
    'polkagate': 'PolkaGate',
    'nova': 'Nova Wallet',
    'fearless-wallet': 'Fearless Wallet'
};

export function sourceLabel(key) {
    if (!key) return 'Address you typed';
    return SOURCE_LABELS[key] || String(key);
}

// Group accounts by the extension they came from, keeping the order extensions
// were enumerated in. Returns [{ source, label, accounts }].
export function groupBySource(accounts) {
    const groups = [];
    const index = new Map();
    for (const a of accounts || []) {
        const key = a.source || '';
        if (!index.has(key)) {
            const g = { source: key, label: sourceLabel(key), accounts: [] };
            index.set(key, g);
            groups.push(g);
        }
        index.get(key).accounts.push(a);
    }
    return groups;
}

// `current` is the connected address ('' if none); `currentSource` the extension
// it was picked from. An account counts as current when its public key matches
// AND (when we know the extension) the extension matches too, so the same key
// held in two extensions shows exactly one "Connected" badge.
export function buildAccountListHtml({ accounts, current, currentSource, isSame, esc, shortAddr }) {
    return groupBySource(accounts).map(g => {
        const rows = g.accounts.map(a => {
            const isCurrent = !!current && isSame(a.address, current) && (!currentSource || currentSource === a.source);
            return `<button type="button" class="wallet-account-btn${isCurrent ? ' is-current' : ''}" data-address="${esc(a.address)}" data-source="${esc(a.source || '')}"${isCurrent ? ' aria-current="true"' : ''}>
            <span class="wallet-account-name">${esc(a.name)}${isCurrent ? ' <span class="wallet-account-badge">Connected</span>' : ''}</span>
            <span class="wallet-account-addr">${esc(shortAddr(a.address))}</span>
        </button>`;
        }).join('');
        return `<div class="wallet-account-group" data-source="${esc(g.source)}">
        <div class="wallet-account-group-title">${esc(g.label)}</div>${rows}</div>`;
    }).join('');
}

// Shown above the list when something is already connected, so the picker is
// recognisably a "switch" and offers the two ways out: stay, or disconnect.
export function buildCurrentBannerHtml({ current, currentSource, esc, shortAddr }) {
    if (!current) return '';
    return `<div class="wallet-current-banner" id="wallet-current-banner">
        <span>Connected as <strong>${esc(shortAddr(current))}</strong>${currentSource ? ' (' + esc(sourceLabel(currentSource)) + ')' : ''}. Pick another account to switch.</span>
        <span class="wallet-current-actions">
            <button type="button" id="wallet-picker-stay" class="staking-download-btn">Keep this wallet</button>
            <button type="button" id="wallet-picker-disconnect" class="staking-download-btn">Disconnect</button>
        </span>
    </div>`;
}

// Instructions for the account that is not in the list. The refresh button
// re-asks every extension; the text says where the real control is.
export function buildMissingAccountHelpHtml() {
    return `<div class="wallet-picker-help">
        <button type="button" id="wallet-picker-refresh" class="staking-download-btn"><i class='bx bx-refresh'></i> Refresh accounts</button>
        <span>Account not listed? Open your wallet extension, allow <strong>Polkadex Explorer</strong> to see that account, then press Refresh. To use a different extension, install or unlock it and press Refresh.</span>
    </div>`;
}
