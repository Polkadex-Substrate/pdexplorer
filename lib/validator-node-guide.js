// /validate/node: the public node guide (design section 3, Sprint 2). No wallet
// needed. Hardware, ports, the client (read from lib/validator-node-release.js,
// CEO decision D1), the flags, session keys generated on the node itself, the
// "Check my node" card (lib/node-check-view.js) and the security checklist.
//
// The explorer never runs any of this. Every command is text the operator
// copies onto their own server; the RPC calls in it go to 127.0.0.1 only. The
// guide never offers --rpc-external, --unsafe-rpc-external,
// --prometheus-external or --rpc-methods=unsafe (test/validator-node.test.js).
// --rpc-methods=auto (the client default) serves the unsafe author_* methods
// on 127.0.0.1 and refuses them on any other interface, so a later
// --rpc-external cannot expose them by mistake.
//
// While the official release is pending the guide says so and keeps
// build-from-source in a closed "Advanced" block, never as the main path.
//
// Brand (BRAND.md, spec 2026-11-21 section 5.4): one primary on the page, "Set
// up a validator" in the footer card; the external "Release notes" link is a
// secondary. The top has the hairline, a violet book tile, the compact path
// (step 1 current) and the statement as the trust row; section numbers are open
// violet markers; a pending release is an amber panel with the Pending chip; the
// checklist ticks are green. Commands never wrap mid-flag (they scroll) and each
// has a Copy button. The checklist ticks are not saved.

import { NODE_RELEASE, NODE_SOURCE, releaseState } from './validator-node-release.js';
import { EXPECTED_LAYOUT, layoutTotalBytes } from './session-keys.js';
import { renderNodeCheckCard, wireNodeCheck } from './node-check-view.js';
import { VALIDATE_STATEMENT } from './validator-status-view.js';
import { icon, chipHtml, trustHtml } from './ui-parts.js';
import { pathState, renderPath } from './validator-path.js';

// Shown at the top of the guide, verbatim (design section 3.1).
export const GUIDE_STATEMENT = VALIDATE_STATEMENT;

// Minimums from the validator kit's provision.sh (design section 3.2). The disk
// figure is the design's estimate until it is measured on validator1.
export const HARDWARE = [
    ['CPU', '4 dedicated cores', 'Block import and BABE and GRANDPA votes on time.'],
    ['RAM', '16 GB', '32 GB if you build the client on the same machine.'],
    ['Disk', '150 GB free, NVMe', 'The pruned database plus growth.'],
    ['Network', 'Static public IPv4, 30333/tcp open', ''],
    ['OS', 'Ubuntu 22.04 or 24.04', '']
];

export const PORTS = [
    ['30333/tcp', 'Peer to peer. Open to the internet.'],
    ['9944/tcp', 'RPC. 127.0.0.1 only. Never open it.'],
    ['9615/tcp', 'Metrics. 127.0.0.1 only. Never open it.']
];

export const BOOTNODES = [
    '/dns/polkadex.boot.faradaynodes.com/tcp/30716/p2p/12D3KooWENh4QpXzfaD8nonhTaSHreuRpKRTRtDTztGeJ7XxXgyw',
    '/dns/boot.polkadex.ee/tcp/30333/ws/p2p/12D3KooWPBimEphuSb48WuwEm44WoACtgnRnDPiGf8ekhurWyc95'
];
export const TELEMETRY_SUBMIT = 'wss://telemetry.polkadot.io/submit/ 0';

// The flags, once, for both the binary and Docker.
export function nodeFlags({ chain, basePath }) {
    return [
        `--chain=${chain}`,
        `--base-path=${basePath}`,
        '--name=YOUR-NODE-NAME',
        '--validator',
        '--database=rocksdb',
        '--sync=warp',
        '--rpc-port=9944',
        '--rpc-methods=auto',
        '--listen-addr=/ip4/0.0.0.0/tcp/30333',
        '--public-addr=/ip4/YOUR.PUBLIC.IP/tcp/30333',
        ['--bootnodes', ...BOOTNODES],
        '--prometheus-port=9615',
        ['--telemetry-url', TELEMETRY_SUBMIT]
    ];
}

const BIN = { chain: '/srv/polkadex/customSpecRaw.json', basePath: '/srv/polkadex/data' };
const IMG = { chain: '/polkadex/customSpecRaw.json', basePath: '/data' };

export function binaryCommand(bin = './polkadex-node') {
    const lines = nodeFlags(BIN).map((f) => {
        if (!Array.isArray(f)) return '  ' + f;
        if (f[0] === '--telemetry-url') return `  --telemetry-url='${f[1]}'`;
        return '  ' + f[0] + ' ' + f.slice(1).join(' \\\n              ');
    });
    return bin + ' \\\n' + lines.join(' \\\n');
}

export function composeFile(image) {
    const items = [];
    for (const f of nodeFlags(IMG)) {
        if (!Array.isArray(f)) items.push(`      - ${f}`);
        else if (f[0] === '--telemetry-url') items.push(`      - "--telemetry-url=${f[1]}"`);
        else { items.push(`      - ${f[0]}`); for (const v of f.slice(1)) items.push(`      - ${v}`); }
    }
    return ['services:', '  node:', `    image: ${image}`, '    restart: unless-stopped', '    stop_grace_period: 5m', '    network_mode: host',
        '    volumes:', '      - /srv/polkadex/data:/data', '      - /srv/polkadex/customSpecRaw.json:/polkadex/customSpecRaw.json:ro',
        '    command:', ...items].join('\n');
}

export const ROTATE_KEYS = `curl -s -H 'Content-Type: application/json' \\
  -d '{"id":1,"jsonrpc":"2.0","method":"author_rotateKeys","params":[]}' \\
  http://127.0.0.1:9944`;
export const HAS_KEYS = `curl -s -H 'Content-Type: application/json' \\
  -d '{"id":1,"jsonrpc":"2.0","method":"author_hasSessionKeys","params":["KEYS"]}' \\
  http://127.0.0.1:9944`;

const NO_PROXY_9944 = 'Never proxy or forward port 9944 (reverse proxy, SSH tunnel to 127.0.0.1): --rpc-methods=auto exposes every method to anything that reaches localhost.';
export const CHECKLIST = [
    'RPC 9944 and metrics 9615 answer on 127.0.0.1 only. From another machine, curl http://YOUR.IP:9944 must fail.',
    NO_PROXY_9944,
    'Firewall: deny incoming by default; allow SSH (rate-limited, key-only) and 30333/tcp. Nothing else.',
    'One keystore, one process. Never copy the keystore to a second server while the first can still start. Two nodes signing with the same keys is equivocation and is slashed.',
    'The stash seed never touches the server.',
    'If the server dies, do not restore its keystore. Build a new node, rotate keys there, register the new keys from the stash.',
    'Clock sync (chrony or systemd-timesyncd) is on.',
    'Unattended security upgrades are on; the node restarts by itself after a reboot.'
];

let cmdSeq = 0;
function cmd(esc, title, text) {
    const id = 'node-cmd-' + (++cmdSeq);
    return `<div class="validate-cmd" role="group" aria-label="${esc(title)}"><pre class="validate-cmd-pre mono" id="${id}" tabindex="0"><code>${esc(text)}</code></pre>`
        + `<button type="button" class="validate-text-btn" data-copy="${id}" aria-label="Copy: ${esc(title)}">${icon('bx-copy')}Copy</button></div>`;
}

function clientSection(esc, release) {
    const rs = releaseState(release);
    if (rs.published) {
        const r = release;
        return `<p>The official release is <b>polkadex-node ${esc(r.version)}</b>: a tagged binary and a Docker image, with checksums.</p>`
            + `<p><a class="validate-secondary" href="${esc(r.releaseNotesUrl)}" rel="noopener noreferrer" target="_blank">${icon('bx-link-external')}Release notes</a></p>`
            + '<h4 class="validate-guide-h4">Binary (Linux x86_64) and chain spec</h4>'
            + cmd(esc, 'Download and verify the binary', `curl -fL -o polkadex-node ${r.binaryUrl}\necho "${r.binarySha256}  polkadex-node" | sha256sum -c -\nchmod +x polkadex-node`)
            + cmd(esc, 'Download and verify the chain spec', `sudo mkdir -p /srv/polkadex/data && sudo chown "$USER" /srv/polkadex/data\nsudo curl -fL -o /srv/polkadex/customSpecRaw.json ${r.chainSpecUrl}\necho "${r.chainSpecSha256}  /srv/polkadex/customSpecRaw.json" | sha256sum -c -`)
            + '<p>Stop if sha256sum does not print OK for both files.</p>'
            + '<h4 class="validate-guide-h4">Docker image</h4>'
            + cmd(esc, 'Pull the image, pinned by digest', `docker pull ${r.image}`);
    }
    const s = NODE_SOURCE;
    return `<p class="validate-pending ui-panel is-warn" role="status">${icon('bx-error')}<span class="ui-panel-body">${chipHtml('is-wait', 'bx-time-five', 'Pending', esc)} The official release (a tagged binary and a Docker image, with checksums) is not published yet. This guide will link to it here. Until then, do not run a binary or an image you cannot verify.</span></p>`
        + '<details class="validate-advanced"><summary>Advanced: build from source at a pinned commit</summary><div class="validate-advanced-body">'
        + `<p>Client ${esc(s.version)}, commit <code>${esc(s.commit)}</code> of <code>${esc(s.repo)}</code>. The build takes 45 to 70 minutes on 6 cores and about 40 GB of scratch space. The chain spec is <code>${esc(s.chainSpecPath)}</code> in the same checkout.</p>`
        + cmd(esc, 'Build from source at the pinned commit', `sudo apt-get install -y build-essential clang libclang-dev cmake pkg-config libssl-dev protobuf-compiler git curl
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
. "$HOME/.cargo/env"
git clone ${s.repo}.git && cd polkadex-node
git checkout ${s.commit}
rustup toolchain install
cargo build --locked --release -p polkadex-node
cp target/release/polkadex-node ..
sudo mkdir -p /srv/polkadex/data && sudo chown "$USER" /srv/polkadex/data
sudo cp ${s.chainSpecPath} /srv/polkadex/customSpecRaw.json
cd ..`)
        + '</div></details>';
}

// The whole guide as HTML. release defaults to the constant; tests pass others.
export function renderNodeGuide({ esc, helpIcon = () => '', release = NODE_RELEASE, nodeName = '' }) {
    cmdSeq = 0;
    const published = releaseState(release).published;
    const image = published ? release.image : 'OFFICIAL-IMAGE-FROM-THE-RELEASE';
    const keysLen = 2 + layoutTotalBytes(EXPECTED_LAYOUT) * 2;
    const section = (n, id, title, body) => `<section class="validate-guide-step" aria-labelledby="${id}"><h3 class="validate-guide-h3" id="${id}"><span class="ui-step is-open">${n}</span> ${esc(title)}</h3>${body}</section>`;
    const hw = '<div class="balance-locks-table-wrap"><table class="data-table validate-guide-table"><caption class="validate-caption">Minimum hardware</caption><thead><tr><th scope="col" class="table-th">Item</th><th scope="col" class="table-th">Minimum</th><th scope="col" class="table-th">Note</th></tr></thead><tbody>'
        + HARDWARE.map(([k, v, n]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td><td>${esc(n)}</td></tr>`).join('') + '</tbody></table></div>';
    const ports = '<div class="balance-locks-table-wrap"><table class="data-table validate-guide-table"><caption class="validate-caption">Ports</caption><thead><tr><th scope="col" class="table-th">Port</th><th scope="col" class="table-th">Use</th></tr></thead><tbody>'
        + PORTS.map(([p, u]) => `<tr><th scope="row" class="mono">${esc(p)}</th><td>${esc(u)}</td></tr>`).join('') + '</tbody></table></div>';
    const notes = [
        'Do not pass --rpc-external, --unsafe-rpc-external or --prometheus-external. Without them RPC 9944 and metrics 9615 bind to 127.0.0.1 only.',
        '--rpc-methods=auto (the default) serves author_rotateKeys only on 127.0.0.1 and refuses it anywhere else. Never pass --rpc-methods=unsafe on a validator.',
        '--listen-addr only: this client refuses --port together with it.',
        'Pruning stays at the client default (state for the last 256 blocks). Warp sync refuses archive state anyway.',
        'The Polkadex bootnode is WebSocket-only; the /ws form is required.',
        'The telemetry URL and the verbosity 0 are one argument. Reporting to telemetry is recommended, not required; what a node reports there, its name included, is public.',
        NO_PROXY_9944,
        'Stop gracefully and allow up to 5 minutes for the database flush. Never kill -9 or docker kill.'
    ];
    return '<div class="list-container glass validate-guide ui-hairline">'
        + `<div class="list-header"><h2><span class="ui-tile is-violet" aria-hidden="true">${icon('bx-book-open')}</span>Run a Polkadex validator node ${helpIcon('run-a-validator', 'Run a validator: the node guide')}</h2></div>`
        + renderPath(pathState(null, { connected: false }), { esc, compact: true, here: 'node' })
        + '<div class="validate-body">'
        + trustHtml(esc, GUIDE_STATEMENT, '', 'validate-guide-trust')
        + '<p id="node-guide-msg" class="validate-msg" aria-live="polite"></p>'
        + section(1, 'node-step-server', 'The server', hw + ports)
        + section(2, 'node-step-client', 'The client', clientSection(esc, release))
        + section(3, 'node-step-run', 'Run the node',
            '<p>Pick a name only you use for <code>--name</code>; it is how you find your node on telemetry. A validator will not start without a network key. Create it once:</p>'
            + cmd(esc, 'Create the network key', './polkadex-node key generate-node-key --chain=/srv/polkadex/customSpecRaw.json --base-path=/srv/polkadex/data')
            + '<h4 class="validate-guide-h4">Binary</h4>' + cmd(esc, 'Start the validator node', binaryCommand())
            + `<ul class="validate-guide-notes">${notes.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`
            + '<h4 class="validate-guide-h4">Docker (compose), host networking so Docker does not open ports behind the firewall</h4>'
            + cmd(esc, 'docker-compose.yml', composeFile(image))
            + cmd(esc, 'Create the network key with Docker', 'docker compose run --rm node key generate-node-key --chain=/polkadex/customSpecRaw.json --base-path=/data'))
        + section(4, 'node-step-check', 'Check your node',
            '<p>Once the node runs, look it up by its name on telemetry. The explorer reads telemetry on its server; your browser does not contact it.</p>'
            + renderNodeCheckCard({ esc, name: nodeName }))
        + section(5, 'node-step-keys', 'Session keys',
            '<p>On the server, against the node itself:</p>'
            + cmd(esc, 'Generate session keys on the node', ROTATE_KEYS)
            + `<p>Run this only when the node has finished syncing and has peers. The result is one line starting with 0x, ${esc(keysLen)} characters long. It contains public keys only and is safe to paste. Each time you run it the node creates new keys, so run it once and register what it printed.</p>`
            + '<p>Then confirm the keystore holds them (replace KEYS):</p>'
            + cmd(esc, 'Confirm the keystore holds the keys', HAS_KEYS)
            + '<p>Paste the line into <a href="/validate/keys" class="item-link" data-spa-link="true">Check session keys</a>.</p>')
        + section(6, 'node-step-security', 'Security checklist',
            '<p>Tick these for yourself. The ticks are not saved.</p><ul class="validate-checklist">'
            + CHECKLIST.map((t, i) => `<li><input type="checkbox" id="node-sec-${i + 1}"> <label for="node-sec-${i + 1}">${esc(t)}</label></li>`).join('') + '</ul>')
        + '</div></div>'
        // The end of the page (spec 5.4): what comes next, and the page's one primary.
        + '<div class="list-container glass validate-guide-next"><p>Next: set up your validator.</p>'
        + '<a href="/validate/setup" class="validate-primary" data-spa-link="true">Set up a validator</a></div>';
}

// d: { esc, helpIcon, fetchJson, nodeName, setNodeParam, release, clipboard }
export function mountNodeGuide(el, d) {
    if (!el) return null;
    el.innerHTML = renderNodeGuide({ esc: d.esc, helpIcon: d.helpIcon, release: d.release || NODE_RELEASE, nodeName: d.nodeName || '' });
    const msg = el.querySelector('#node-guide-msg');
    const clip = d.clipboard || (globalThis.navigator && globalThis.navigator.clipboard);
    for (const b of el.querySelectorAll('[data-copy]')) {
        b.addEventListener('click', async () => {
            const pre = el.querySelector('#' + b.getAttribute('data-copy'));
            try { await clip.writeText(pre.textContent); msg.textContent = 'Copied.'; const t = b.lastChild; if (t && t.nodeType === 3) { t.textContent = 'Copied'; setTimeout(() => { t.textContent = 'Copy'; }, 1500); } } catch (e) { msg.textContent = 'The browser did not allow copying. Select the command and copy it instead.'; }
        });
    }
    return wireNodeCheck(el, { fetchJson: d.fetchJson, esc: d.esc, setNodeParam: d.setNodeParam });
}
