// The node guide (/validate/node) and "Check my node", Sprint 2 of
// cto-team/plans/2026-11-17-validator-onboarding-design.md (sections 3.1 to
// 3.5), with the CEO decisions of 2026-11-17: D1 (the guide links to the
// official release read from ONE constant; pending while it is unset, with
// build-from-source only in a closed "Advanced" block) and D3 (telemetry is
// read on the server; the browser never contacts it, the CSP is unchanged).
//
// Synthetic data: node names are made up, accounts are 32 bytes of one
// repeated value and belong to no one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { NODE_RELEASE, NODE_SOURCE, releaseState, compareNodeVersion } from '../lib/validator-node-release.js';
import { nodeCheckModel, nodeTelemetryRow, SELF_DECLARED, KEYS_NOT_VISIBLE, UNAVAILABLE, SWITCHED_OFF, IN_SYNC_BLOCKS, MIN_PEERS } from '../lib/node-check.js';
import { renderNodeCheckCard, renderNodeCheckResult, wireNodeCheck } from '../lib/node-check-view.js';
import { renderNodeGuide, mountNodeGuide, GUIDE_STATEMENT, CHECKLIST, HARDWARE, ROTATE_KEYS, HAS_KEYS } from '../lib/validator-node-guide.js';
import { VALIDATE_STATEMENT, mountValidatePage } from '../lib/validator-status-view.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { allRoutes, CACHE_TIERS } from '../lib/api-reference.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, stripComments } from './helpers/source.js';

const esc = escapeHtml;
const RELEASE = Object.freeze({
    version: '7.0.1',
    binaryUrl: 'https://github.com/Polkadex-Substrate/polkadex-node/releases/download/v7.0.1/polkadex-node',
    binarySha256: 'a'.repeat(64),
    image: 'docker.io/polkadex/polkadex-node:7.0.1@sha256:' + 'b'.repeat(64),
    chainSpecUrl: 'https://github.com/Polkadex-Substrate/polkadex-node/releases/download/v7.0.1/customSpecRaw.json',
    chainSpecSha256: 'c'.repeat(64),
    releaseNotesUrl: 'https://github.com/Polkadex-Substrate/polkadex-node/releases/tag/v7.0.1'
});
const PENDING = Object.freeze(Object.fromEntries(Object.keys(RELEASE).map(k => [k, null])));
const node = (over = {}) => ({ name: 'alpha-node', version: '7.0.0-566b080ba1a', best: 1_000_000, finalized: 999_998, peers: 12, validator: false, networkId: '12D3KooWExamplePeerIdForTests01', stale: false, secondsAgo: 3, behind: 0, versionVsRelease: null, ...over });
const ok = (over = {}) => ({ feed: 'ok', feedHost: 'telemetry.polkadot.io', name: 'alpha-node', head: 1_000_002, release: { state: 'pending', version: null }, count: 1, nodes: [node()], similar: [], ...over });

describe('the release constant (D1): one place, pending or fully valid', () => {
    test('the shipped constant is pending (every field null) or fully published, never half filled', () => {
        const rs = releaseState(NODE_RELEASE);
        assert.ok(rs.published || Object.values(NODE_RELEASE).every(v => v === null), 'half-filled NODE_RELEASE: ' + rs.problems.join(', '));
        assert.deepEqual(Object.keys(NODE_RELEASE).sort(), ['binarySha256', 'binaryUrl', 'chainSpecSha256', 'chainSpecUrl', 'image', 'releaseNotesUrl', 'version']);
        assert.ok(Object.isFrozen(NODE_RELEASE));
    });
    test('all null: pending with no problems; all valid: published', () => {
        assert.deepEqual(releaseState(PENDING), { published: false, problems: [] });
        assert.deepEqual(releaseState(RELEASE), { published: true, problems: [] });
    });
    test('half filled or malformed: still pending, the bad fields named (they end up inside shell commands)', () => {
        assert.deepEqual(releaseState({ ...PENDING, version: '7.0.1' }).problems, ['binaryUrl', 'binarySha256', 'image', 'chainSpecUrl', 'chainSpecSha256', 'releaseNotesUrl']);
        const bad = {
            version: 'v7', binaryUrl: 'http://example.test/x', binarySha256: 'A'.repeat(64), image: 'docker.io/polkadex/polkadex-node:7.0.1',
            chainSpecUrl: "https://example.test/a';rm -rf ~;'", chainSpecSha256: 'c'.repeat(63), releaseNotesUrl: 'https://example.test/a b'
        };
        for (const [k, v] of Object.entries(bad)) {
            const r = releaseState({ ...RELEASE, [k]: v });
            assert.deepEqual([r.published, r.problems], [false, [k]], k);
        }
    });
    test('the pinned source of the Advanced block (design 3.3)', () => {
        assert.deepEqual({ ...NODE_SOURCE }, { repo: 'https://github.com/Polkadex-Substrate/polkadex-node', commit: '566b080ba1a322fab0f11c085128f482e6b40802', version: '7.0.0', chainSpecPath: 'extras/customSpecRaw.json' });
    });
    test('compareNodeVersion: the version a node reports against a release', () => {
        assert.equal(compareNodeVersion('7.0.0-566b080ba1a', '7.0.1'), 'older');
        assert.equal(compareNodeVersion('7.0.1-deadbeef', '7.0.1'), 'same');
        assert.equal(compareNodeVersion('7.1.0', '7.0.9'), 'newer');
        assert.equal(compareNodeVersion('6.2.0-c6855f1d3d2', '7.0.0'), 'older');
        assert.equal(compareNodeVersion('', '7.0.0'), 'unknown');
        assert.equal(compareNodeVersion('7.0.0', null), 'unknown');
    });
    test('no other module names a client version, image or checksum (the constant is the one place)', () => {
        for (const f of ['lib/validator-node-guide.js', 'lib/node-check.js', 'lib/node-check-view.js', 'lib/telemetry-api.js']) {
            const src = stripComments(readRepo(f, import.meta.url));
            assert.doesNotMatch(src, /\b7\.0\.\d\b|sha256:[0-9a-f]{8}|566b080/, f);
        }
    });
});

describe('nodeCheckModel: the states of design section 3.5', () => {
    test('found and in sync: green only within 5 blocks of head with 3 or more peers', () => {
        const m = nodeCheckModel(ok({ head: 1_000_005 }));
        assert.deepEqual([m.state, m.word, m.tone], ['in-sync', 'In sync', 'positive']);
        assert.equal(m.text, 'alpha-node is reporting. Best block #1,000,000 (chain head #1,000,005), finalized #999,998, 12 peers, client 7.0.0-566b080ba1a, last seen 3 s ago.');
        assert.ok(m.notes.includes(SELF_DECLARED));
        assert.ok(m.notes.includes(KEYS_NOT_VISIBLE));
        assert.equal(IN_SYNC_BLOCKS, 5);
        assert.equal(MIN_PEERS, 3);
    });
    test('the boundaries: 6 blocks behind is Behind (neutral); 2 peers is Reporting (neutral)', () => {
        const behind = nodeCheckModel(ok({ head: 1_000_006 }));
        assert.deepEqual([behind.state, behind.word, behind.tone], ['behind', 'Behind', 'neutral']);
        assert.equal(behind.text, 'alpha-node is reporting but is 6 blocks behind. Wait until it has caught up before generating keys.');
        const few = nodeCheckModel(ok({ nodes: [node({ peers: 2 })] }));
        assert.deepEqual([few.state, few.tone], ['reporting', 'neutral']);
        assert.ok(few.notes.includes('It has fewer than 3 peers.'));
        assert.equal(nodeCheckModel(ok({ nodes: [node({ peers: 3 })] })).tone, 'positive');
    });
    test('a node telemetry marks stale is never green', () => {
        const m = nodeCheckModel(ok({ nodes: [node({ stale: true })] }));
        assert.equal(m.tone, 'neutral');
        assert.ok(m.notes.some(t => /stale/.test(t)));
    });
    test('the chain head unreadable: neutral, and it says the gap is unknown', () => {
        const m = nodeCheckModel(ok({ head: null }));
        assert.deepEqual([m.state, m.tone], ['reporting', 'neutral']);
        assert.match(m.text, /^alpha-node is reporting\. Best block #1,000,000, finalized/);
        assert.ok(m.notes.includes('The explorer cannot read the chain head right now, so the sync gap is unknown.'));
    });
    test('several nodes with the name', () => {
        const m = nodeCheckModel(ok({ count: 2, nodes: [node(), node({ networkId: '12D3KooWOtherPeer' })] }));
        assert.deepEqual([m.state, m.word, m.tone, m.nodes.length], ['several', 'Several', 'neutral', 2]);
        assert.equal(m.text, '2 nodes report the name alpha-node. Names are not unique. Pick a name only you use.');
    });
    test('not found, with similar names', () => {
        const m = nodeCheckModel(ok({ count: 0, nodes: [], similar: ['alpha-node-2'] }));
        assert.deepEqual([m.state, m.word, m.tone, m.similar], ['not-found', 'Not found', 'neutral', ['alpha-node-2']]);
        assert.equal(m.text, 'No node named alpha-node is reporting to telemetry.polkadot.io right now. Check the --name and --telemetry-url flags. A node that does not report telemetry can still validate.');
    });
    test('feed down or still connecting; switched off', () => {
        for (const feed of ['down', 'connecting']) assert.deepEqual([nodeCheckModel({ feed, name: 'x' }).state, nodeCheckModel({ feed, name: 'x' }).text], ['down', UNAVAILABLE]);
        assert.equal(UNAVAILABLE, 'The explorer cannot read telemetry right now. This does not affect your node or your validator.');
        assert.deepEqual([nodeCheckModel({ feed: 'off', name: 'x' }).state, nodeCheckModel({ feed: 'off' }).text], ['off', SWITCHED_OFF]);
        assert.match(SWITCHED_OFF, /^Telemetry is unavailable on this explorer\./);
        assert.equal(nodeCheckModel(null).state, 'off');
    });
    test('the release: pending says so; published compares', () => {
        assert.ok(nodeCheckModel(ok()).notes.includes('The official release is pending, so the client version is not compared yet.'));
        const pub = { release: { state: 'published', version: '7.0.1' } };
        assert.ok(nodeCheckModel(ok({ ...pub, nodes: [node({ versionVsRelease: 'older' })] })).notes.includes('The latest official release is 7.0.1. This node runs an older client.'));
        assert.ok(nodeCheckModel(ok({ ...pub, nodes: [node({ version: '7.0.1-x', versionVsRelease: 'same' })] })).notes.includes('Client 7.0.1-x is the latest official release.'));
    });
    test('session keys: telemetry cannot show them, and it says so', () => {
        assert.match(KEYS_NOT_VISIBLE, /^Telemetry cannot show which session keys a node holds/);
        assert.equal(SELF_DECLARED, 'Telemetry names are self-declared. This is a hint, not proof that the node is yours.');
    });
    test('the dashboard row (design 2.4): always neutral, the self-declared sentence follows', () => {
        const r = nodeTelemetryRow(ok({ head: 1_000_005 }));
        assert.deepEqual([r.id, r.label, r.word, r.tone], ['telemetry', 'Node on telemetry', 'Reporting', 'neutral']);
        assert.equal(r.text, 'A node named alpha-node is reporting: best block #1,000,000, 12 peers, version 7.0.0-566b080ba1a, seen 3 s ago. ' + SELF_DECLARED);
        assert.equal(nodeTelemetryRow(ok({ count: 0, nodes: [] })).text, 'No node named alpha-node is reporting to telemetry.polkadot.io. ' + SELF_DECLARED);
        assert.equal(nodeTelemetryRow({ feed: 'down', name: 'x' }).text, UNAVAILABLE);
        assert.equal(nodeTelemetryRow({ feed: 'off', name: 'x' }).text, SWITCHED_OFF);
    });
});

function dom(url = 'http://localhost/validate/node') {
    const w = new Window({ url });
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    return { w, el, doc: w.document };
}
const flush = (n = 5) => new Promise(r => setTimeout(r, n));

describe('the Check my node card', () => {
    test('labelled field, tied to its message; a polite live region for the result; the button is secondary', () => {
        const { el, doc } = dom();
        el.innerHTML = renderNodeCheckCard({ esc, name: 'a"b' });
        const input = doc.getElementById('node-check-input');
        assert.equal(doc.querySelector('label[for="node-check-input"]').textContent, 'Node name (the value of --name)');
        assert.equal(input.getAttribute('aria-describedby'), 'node-check-msg');
        assert.equal(input.getAttribute('maxlength'), '64');
        assert.equal(input.value, 'a"b');
        assert.equal(doc.getElementById('node-check-result').getAttribute('aria-live'), 'polite');
        assert.equal(el.querySelectorAll('.validate-primary').length, 0);
        assert.equal(el.querySelector('button[type="submit"]').className, 'validate-secondary');
    });
    test('node names are escaped everywhere they appear', () => {
        const evil = '<img src=x onerror=alert(1)>';
        const html = renderNodeCheckResult(ok({ name: evil, count: 0, nodes: [], similar: [evil + '2'] }), { esc });
        assert.ok(!html.includes('<img'), html);
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
        const several = renderNodeCheckResult(ok({ name: evil, count: 2, nodes: [node({ name: evil, version: evil, networkId: evil }), node()] }), { esc });
        assert.ok(!several.includes('<img'));
    });
    test('green only on In sync; every state is a word', () => {
        const green = (r) => { const { el } = dom(); el.innerHTML = renderNodeCheckResult(r, { esc }); return Array.from(el.querySelectorAll('.is-positive')).map(x => x.textContent); };
        assert.deepEqual(green(ok({ head: 1_000_005 })), ['In sync']);
        for (const r of [ok({ head: 1_000_100 }), ok({ count: 0, nodes: [] }), ok({ count: 2, nodes: [node(), node()] }), { feed: 'down', name: 'x' }, { feed: 'off', name: 'x' }]) assert.deepEqual(green(r), []);
    });
    test('several: a table with a header row and scoped headers', () => {
        const { el } = dom();
        el.innerHTML = renderNodeCheckResult(ok({ count: 2, nodes: [node(), node({ networkId: '12D3KooWOtherPeerIdForTests02' })] }), { esc });
        assert.equal(el.querySelectorAll('thead th[scope="col"]').length, 4);
        assert.equal(el.querySelectorAll('tbody th[scope="row"]').length, 2);
    });
    test('wiring: empty refused in the browser; a name is looked up on the explorer API only, kept in ?node=, the result announced', async () => {
        const { el } = dom();
        el.innerHTML = renderNodeCheckCard({ esc });
        const urls = [], params = [];
        const w = wireNodeCheck(el, { esc, fetchJson: async (u) => { urls.push(u); return ok({ name: 'bravo node' }); }, setNodeParam: (n) => params.push(n) });
        await w.check('  ');
        assert.equal(el.querySelector('#node-check-msg').textContent, 'Enter the node name, the value of --name.');
        assert.equal(el.querySelector('#node-check-input').getAttribute('aria-invalid'), 'true');
        assert.deepEqual(urls, []);
        await w.check(' bravo node ');
        assert.deepEqual(urls, ['/api/telemetry/node?name=bravo%20node']);
        assert.deepEqual(params, ['bravo node']);
        assert.equal(el.querySelector('#node-check-input').getAttribute('aria-invalid'), null);
        assert.match(el.querySelector('#node-check-result').textContent, /bravo node is reporting\./);
        assert.equal(el.querySelector('#node-check-result').getAttribute('aria-busy'), null);
    });
    test('a prefilled name (a bookmarked ?node=) is checked at once; a similar name is one click', async () => {
        const { el } = dom();
        el.innerHTML = renderNodeCheckCard({ esc, name: 'charlie' });
        const urls = [];
        const w = wireNodeCheck(el, { esc, fetchJson: async (u) => { urls.push(u); return u.endsWith('charlie') ? ok({ name: 'charlie', count: 0, nodes: [], similar: ['charlie-01'] }) : ok({ name: 'charlie-01' }); } });
        await w.ran;
        assert.deepEqual(urls, ['/api/telemetry/node?name=charlie']);
        el.querySelector('[data-node-name="charlie-01"]').click();
        await flush();
        assert.equal(urls[1], '/api/telemetry/node?name=charlie-01');
        assert.equal(el.querySelector('#node-check-input').value, 'charlie-01');
    });
    test('the API fails: unavailable; rate limited: says so', async () => {
        const { el } = dom();
        el.innerHTML = renderNodeCheckCard({ esc });
        let fail = Object.assign(new Error('HTTP 500'), { status: 500 });
        const w = wireNodeCheck(el, { esc, fetchJson: async () => { throw fail; } });
        await w.check('delta');
        assert.match(el.querySelector('#node-check-result').textContent, /cannot read telemetry right now/);
        fail = Object.assign(new Error('Too many'), { status: 429 });
        await w.check('delta');
        assert.equal(el.querySelector('#node-check-msg').textContent, 'Too many lookups from this address. Wait a minute and try again.');
    });
});

const pres = (html) => { const { el } = dom(); el.innerHTML = html; return Array.from(el.querySelectorAll('pre')).map(p => p.textContent); };

describe('the node guide: release pending (D1)', () => {
    const html = renderNodeGuide({ esc, release: PENDING });
    test('says the official release is pending; no download, no checksum, no primary button', () => {
        assert.match(html, /The official release \(a tagged binary and a Docker image, with checksums\) is not published yet\./);
        assert.doesNotMatch(html, /Release notes|sha256sum|docker pull/);
        const { el } = dom(); el.innerHTML = html;
        assert.equal(el.querySelectorAll('.validate-primary').length, 0);
    });
    test('build from source only in a closed Advanced block, after the pending notice, never the main path', () => {
        const { el } = dom(); el.innerHTML = html;
        const details = el.querySelectorAll('details.validate-advanced');
        assert.equal(details.length, 1);
        assert.equal(details[0].hasAttribute('open'), false);
        assert.equal(details[0].querySelector('summary').textContent, 'Advanced: build from source at a pinned commit');
        assert.ok(html.indexOf('validate-pending') < html.indexOf('validate-advanced'));
        for (const p of el.querySelectorAll('pre')) if (/cargo build|git clone/.test(p.textContent)) assert.ok(p.closest('details'), 'a build command outside the Advanced block');
        assert.ok(details[0].textContent.includes(NODE_SOURCE.commit));
        assert.ok(!el.textContent.replace(details[0].textContent, '').includes(NODE_SOURCE.commit), 'the commit only inside Advanced');
    });
    test('the Docker file names no image until there is an official one', () => {
        const compose = pres(html).find(p => p.startsWith('services:'));
        assert.match(compose, /image: OFFICIAL-IMAGE-FROM-THE-RELEASE/);
    });
});

describe('the node guide: release published', () => {
    const html = renderNodeGuide({ esc, release: RELEASE });
    test('the version, one primary (Release notes), binary, chain spec and image with their checksums', () => {
        const { el } = dom(); el.innerHTML = html;
        const primary = el.querySelectorAll('.validate-primary');
        assert.equal(primary.length, 1);
        assert.equal(primary[0].textContent, 'Release notes');
        assert.equal(primary[0].getAttribute('href'), RELEASE.releaseNotesUrl);
        assert.equal(primary[0].getAttribute('rel'), 'noopener noreferrer');
        assert.match(el.textContent, /polkadex-node 7\.0\.1/);
        const cmds = pres(html).join('\n');
        assert.ok(cmds.includes(`curl -fL -o polkadex-node ${RELEASE.binaryUrl}`));
        assert.ok(cmds.includes(`echo "${RELEASE.binarySha256}  polkadex-node" | sha256sum -c -`));
        assert.ok(cmds.includes(`echo "${RELEASE.chainSpecSha256}  /srv/polkadex/customSpecRaw.json" | sha256sum -c -`));
        assert.ok(cmds.includes(`docker pull ${RELEASE.image}`));
        assert.ok(cmds.includes('sudo mkdir -p /srv/polkadex/data && sudo chown "$USER" /srv/polkadex/data'), 'the data directory belongs to the user who runs the node');
        assert.ok(cmds.includes(`image: ${RELEASE.image}`));
        assert.equal(el.querySelectorAll('details.validate-advanced').length, 0, 'no build from source once there is a release');
    });
    test('a half-filled release renders as pending, not as a broken link', () => {
        const half = renderNodeGuide({ esc, release: { ...RELEASE, binarySha256: null } });
        assert.match(half, /is not published yet/);
        assert.doesNotMatch(half, /Release notes/);
    });
});

describe('the node guide: commands, flags, keys, checklist (design 3.2 to 3.4)', () => {
    const html = renderNodeGuide({ esc, release: PENDING });
    const cmds = pres(html);
    const run = cmds.find(c => c.startsWith('./polkadex-node \\'));
    const compose = cmds.find(c => c.startsWith('services:'));
    test('the start command carries the validator flags, once each', () => {
        for (const f of ['--validator', '--name=YOUR-NODE-NAME', '--chain=/srv/polkadex/customSpecRaw.json', '--base-path=/srv/polkadex/data', "--telemetry-url='wss://telemetry.polkadot.io/submit/ 0'",
            '--rpc-port=9944', '--rpc-methods=auto', '--listen-addr=/ip4/0.0.0.0/tcp/30333', '--public-addr=/ip4/YOUR.PUBLIC.IP/tcp/30333', '--prometheus-port=9615', '--sync=warp', '--database=rocksdb', '--bootnodes']) {
            assert.equal(run.split(f).length - 1, 1, f);
        }
        assert.ok(run.includes('/dns/boot.polkadex.ee/tcp/30333/ws/p2p/'), 'the WebSocket bootnode in its /ws form');
        for (const f of ['--validator', '--chain=/polkadex/customSpecRaw.json', '--base-path=/data', '"--telemetry-url=wss://telemetry.polkadot.io/submit/ 0"', '--rpc-methods=auto']) assert.ok(compose.includes(f), 'compose ' + f);
        assert.match(compose, /network_mode: host/);
        assert.match(compose, /stop_grace_period: 5m/);
    });
    test('never exposes unsafe RPC: no --rpc-external, --unsafe-rpc-external, --prometheus-external, --rpc-methods=unsafe or --rpc-cors in any command', () => {
        for (const c of cmds) assert.doesNotMatch(c, /--rpc-external|--unsafe-rpc-external|--prometheus-external|--rpc-methods[= ]unsafe|--rpc-cors|--unsafe-force-node-key-generation/, c.slice(0, 80));
        assert.match(html, /Do not pass --rpc-external, --unsafe-rpc-external or --prometheus-external\./);
        assert.match(html, /Never pass --rpc-methods=unsafe on a validator\./);
    });
    test('session keys: generated on the node, curl to 127.0.0.1 only, shown as commands, never run by the explorer', () => {
        assert.ok(cmds.includes(ROTATE_KEYS) && cmds.includes(HAS_KEYS));
        for (const c of cmds) for (const u of c.match(/https?:\/\/[^\s'"]+/g) || []) {
            if (/:9944|:9615/.test(u)) assert.match(u, /^http:\/\/127\.0\.0\.1:(9944|9615)$/, u);
        }
        assert.match(ROTATE_KEYS, /"method":"author_rotateKeys"/);
        assert.match(HAS_KEYS, /"method":"author_hasSessionKeys","params":\["KEYS"\]/);
        assert.match(html, /Run this only when the node has finished syncing and has peers\. The result is one line starting with 0x, 388 characters long\. It contains public keys only and is safe to paste\. Each time you run it the node creates new keys, so run it once and register what it printed\./);
        assert.match(html, /<a href="\/validate" class="item-link" data-spa-link="true">Check session keys before you register them<\/a>/);
    });
    test('the statement of section 3.1, verbatim, first', () => {
        assert.equal(GUIDE_STATEMENT, VALIDATE_STATEMENT);
        assert.ok(html.indexOf(esc(GUIDE_STATEMENT)) > 0 && html.indexOf(esc(GUIDE_STATEMENT)) < html.indexOf('node-step-server'));
    });
    test('hardware, ports, notes: RPC and metrics on 127.0.0.1 only; graceful stop', () => {
        assert.deepEqual(HARDWARE.map(h => h[0]), ['CPU', 'RAM', 'Disk', 'Network', 'OS']);
        assert.match(html, /9944\/tcp<\/th><td>RPC\. 127\.0\.0\.1 only\. Never open it\./);
        assert.match(html, /Never kill -9 or docker kill\./);
        assert.match(html, /Reporting to telemetry is recommended, not required/);
    });
    test('the security checklist: eight real checkboxes, each labelled; ticks are not saved', () => {
        const { el } = dom(); el.innerHTML = html;
        const boxes = el.querySelectorAll('.validate-checklist input[type="checkbox"]');
        assert.equal(boxes.length, 8);
        assert.equal(CHECKLIST.length, 8);
        for (const b of boxes) assert.ok(el.querySelector(`label[for="${b.id}"]`), b.id);
        assert.match(html, /The ticks are not saved\./);
        for (const f of ['lib/validator-node-guide.js', 'lib/node-check-view.js', 'lib/node-check.js']) assert.doesNotMatch(stripComments(readRepo(f, import.meta.url)), /localStorage|sessionStorage|document\.cookie/, f);
    });
});

describe('the node guide: accessibility basics', () => {
    const { el } = dom();
    el.innerHTML = renderNodeGuide({ esc, release: PENDING, helpIcon: (s, t) => `<a href="/help/${s}" aria-label="${t}">?</a>` });
    test('one h2, then six numbered h3 sections, each section labelled by its heading', () => {
        assert.equal(el.querySelectorAll('h2').length, 1);
        const h3 = Array.from(el.querySelectorAll('section.validate-guide-step > h3'));
        assert.deepEqual(h3.map(h => h.textContent), ['1. The server', '2. The client', '3. Run the node', '4. Check your node', '5. Session keys', '6. Security checklist']);
        for (const s of el.querySelectorAll('section.validate-guide-step')) assert.ok(el.querySelector('#' + s.getAttribute('aria-labelledby')));
    });
    test('commands: a named group each, the command focusable (it scrolls, never wraps), a named Copy button', () => {
        const blocks = el.querySelectorAll('.validate-cmd');
        assert.ok(blocks.length >= 6);
        for (const b of blocks) {
            assert.equal(b.getAttribute('role'), 'group');
            assert.ok(b.getAttribute('aria-label'));
            const pre = b.querySelector('pre');
            assert.equal(pre.getAttribute('tabindex'), '0');
            const btn = b.querySelector('button[data-copy]');
            assert.equal(btn.getAttribute('data-copy'), pre.id);
            assert.equal(btn.getAttribute('aria-label'), 'Copy: ' + b.getAttribute('aria-label'));
        }
        const ids = Array.from(el.querySelectorAll('pre')).map(p => p.id);
        assert.equal(new Set(ids).size, ids.length, 'unique ids');
    });
    test('tables: a caption and scoped headers', () => {
        for (const t of el.querySelectorAll('table.validate-guide-table')) {
            assert.ok(t.querySelector('caption'));
            assert.ok(t.querySelectorAll('tbody th[scope="row"]').length > 0);
        }
    });
    test('the help icon names the new topic', () => {
        assert.ok(el.querySelector('h2 a[href="/help/run-a-validator"]'));
    });
    test('the pending notice is a status, the copy message a polite live region', () => {
        assert.equal(el.querySelector('.validate-pending').getAttribute('role'), 'status');
        assert.equal(el.querySelector('#node-guide-msg').getAttribute('aria-live'), 'polite');
    });
});

describe('mountNodeGuide', () => {
    test('Copy puts the command on the clipboard and says so; a refusal says what to do', async () => {
        const { el } = dom();
        const copied = [];
        let refuse = false;
        mountNodeGuide(el, { esc, release: PENDING, fetchJson: async () => ok(), clipboard: { writeText: async (t) => { if (refuse) throw new Error('no'); copied.push(t); } } });
        const btn = el.querySelector('button[data-copy]');
        btn.click(); await flush();
        assert.equal(copied[0], el.querySelector('#' + btn.getAttribute('data-copy')).textContent);
        assert.equal(el.querySelector('#node-guide-msg').textContent, 'Copied.');
        refuse = true;
        btn.click(); await flush();
        assert.equal(el.querySelector('#node-guide-msg').textContent, 'The browser did not allow copying. Select the command and copy it instead.');
    });
    test('?node=NAME: the card is filled and checked on load', async () => {
        const { el } = dom();
        const urls = [];
        const w = mountNodeGuide(el, { esc, release: PENDING, nodeName: 'echo', fetchJson: async (u) => { urls.push(u); return ok({ name: 'echo' }); } });
        await w.ran;
        assert.deepEqual(urls, ['/api/telemetry/node?name=echo']);
        assert.equal(el.querySelector('#node-check-input').value, 'echo');
    });
});

describe('the status page: the Node on telemetry row with ?node=NAME', () => {
    const STASH = encodeAddress(new Uint8Array(32).fill(66), 88);
    const model = { address: STASH, state: 'active', headline: 'Active in era 500.', pill: { word: 'Active', tone: 'positive' }, rows: [{ id: 'keys', label: 'Keys', text: 'Registered keys match the keys in use.', word: 'Match', tone: 'neutral' }], era: {}, session: {} };
    function deps(nodeName, answer) {
        const urls = [];
        return { urls, d: { urlAddress: STASH, account: null, isSame: (a, b) => a === b, helpIcon: () => '', esc, shortAddr: (a) => a.slice(0, 6), navigate: () => {}, nodeName,
            fetchJson: async (u) => { urls.push(u); if (u === '/api/validator/params') return { specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 } }; if (u.endsWith('/status')) return model; if (u.startsWith('/api/telemetry/node')) { if (answer instanceof Error) throw answer; return answer; } throw new Error('unexpected ' + u); } } };
    }
    test('the row is added after the status rows, neutral', async () => {
        const { el } = dom('http://localhost/validate');
        const { urls, d } = deps('foxtrot', ok({ name: 'foxtrot' }));
        await mountValidatePage(el, d);
        assert.ok(urls.includes('/api/telemetry/node?name=foxtrot'));
        const dts = Array.from(el.querySelectorAll('.validate-rows dt')).map(x => x.textContent);
        assert.deepEqual(dts, ['Keys', 'Node on telemetry']);
        const word = el.querySelectorAll('.validate-rows .validate-word')[1];
        assert.deepEqual([word.textContent, word.className], ['Reporting', 'validate-word is-neutral']);
    });
    test('the telemetry lookup fails: the row says unavailable, the status stays', async () => {
        const { el } = dom('http://localhost/validate');
        const { d } = deps('golf', new Error('HTTP 500'));
        await mountValidatePage(el, d);
        assert.match(el.querySelector('.validate-headline').textContent, /Active in era 500\./);
        assert.match(el.querySelector('.validate-rows').textContent, /cannot read telemetry right now/);
    });
    test('no ?node=: no telemetry request at all', async () => {
        const { el } = dom('http://localhost/validate');
        const { urls, d } = deps('', ok());
        await mountValidatePage(el, d);
        assert.ok(!urls.some(u => u.includes('telemetry')));
    });
    test('the empty state links to the node guide', async () => {
        const { el } = dom('http://localhost/validate');
        const { d } = deps('', ok());
        await mountValidatePage(el, { ...d, urlAddress: '', account: { status: 'none' } });
        assert.ok(el.querySelector('a[href="/validate/node"]'));
    });
});

// The client's module graph from script.js, followed through relative imports.
function clientModules() {
    const seen = new Set();
    const walk = (rel) => {
        if (seen.has(rel)) return;
        seen.add(rel);
        const src = readRepo(rel, import.meta.url);
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
        for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"](\.\.?\/[^'"]+)['"]/g)) {
            const parts = (dir + m[1]).split('/');
            const out = [];
            for (const p of parts) { if (p === '.' || p === '') continue; if (p === '..') out.pop(); else out.push(p); }
            walk(out.join('/'));
        }
    };
    walk('script.js');
    return [...seen];
}

describe('D3: the browser never contacts telemetry; the CSP is unchanged', () => {
    test('nginx.conf: every CSP names no telemetry host, and connect-src is exactly what it was', () => {
        const nginx = readRepo('nginx.conf', import.meta.url);
        const csp = nginx.split('\n').filter(l => /Content-Security-Policy/.test(l) && !l.trim().startsWith('#'));
        assert.ok(csp.length >= 2);
        for (const l of csp) {
            assert.doesNotMatch(l, /telemetry/i);
            assert.match(l, /connect-src 'self' wss:\/\/rpc\.polkadex\.ee wss:\/\/relay\.walletconnect\.org;/);
        }
    });
    test('the client bundle: the server-side telemetry modules are not in it; no feed host anywhere in it', () => {
        const mods = clientModules();
        assert.ok(mods.includes('lib/validator-node-guide.js') && mods.includes('lib/node-check-view.js'), mods.join(' '));
        for (const m of ['lib/telemetry-reader.js', 'lib/telemetry-relay.js', 'lib/telemetry-api.js', 'lib/telemetry-feed.js']) assert.ok(!mods.includes(m), m + ' is in the client bundle');
        for (const m of mods) {
            const src = stripComments(readRepo(m, import.meta.url));
            assert.doesNotMatch(src, /feed\.telemetry|telemetry\.polkadot\.io\/feed|\/shard_submit/, m);
            // the submit URL is printed for operators (a flag value), never dialled
            if (/telemetry\.polkadot\.io/.test(src)) assert.ok(['lib/validator-node-guide.js', 'lib/node-check.js', 'lib/help-topics.js'].includes(m), m + ' names a telemetry host');
        }
    });
    test('the copy names the submit URL only as text inside commands and sentences', () => {
        const guide = stripComments(readRepo('lib/validator-node-guide.js', import.meta.url));
        assert.doesNotMatch(guide, /new\s+WebSocket|fetch\(\s*['"`]wss?:/);
    });
});

describe('the explorer never calls the unsafe author_* methods (design 3.1)', () => {
    const files = ['server.js', 'script.js', ...readdirSync(new URL('../lib/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => 'lib/' + f)];
    // Copy only: these modules name the methods in text an operator reads.
    const COPY = new Set(['lib/validator-node-guide.js', 'lib/help-topics.js', 'lib/session-keys.js', 'lib/validator-status-view.js', 'lib/validator-status-api.js', 'lib/api-reference.js', 'lib/validator-setup-view.js']);
    test('no RPC call to author_rotateKeys, author_insertKey or author_hasSessionKeys anywhere', () => {
        for (const f of files) {
            const src = stripComments(readRepo(f, import.meta.url));
            assert.doesNotMatch(src, /\bauthor\s*\.\s*(rotateKeys|insertKey|hasSessionKeys)\b/, f);
            assert.doesNotMatch(src, /author_insertKey/, f);
            assert.doesNotMatch(src, /method\s*:\s*['"`]author_/, f);
            if (/author_(rotateKeys|hasSessionKeys)/.test(src)) assert.ok(COPY.has(f), `${f} names an unsafe method outside guide copy`);
        }
    });
    test('in the guide they only appear inside the curl text to 127.0.0.1', () => {
        for (const c of [ROTATE_KEYS, HAS_KEYS]) assert.match(c, /^curl -s -H 'Content-Type: application\/json' \\\n {2}-d '\{"id":1,"jsonrpc":"2\.0","method":"author_(rotateKeys|hasSessionKeys)","params":\[[^\]]*\]\}' \\\n {2}http:\/\/127\.0\.0\.1:9944$/);
    });
});

describe('wiring: server, docs, shell, script, help, brand', () => {
    const server = stripComments(readRepo('server.js', import.meta.url));
    const script = stripComments(readRepo('script.js', import.meta.url));
    const html = readRepo('index.html', import.meta.url);
    test('server.js: the route, the relay in the cluster primary, the snapshot in HTTP workers, the reader in-process with WORKERS=1', () => {
        assert.match(server, /import \{ registerTelemetryRoute \} from '\.\/lib\/telemetry-api\.js'/);
        assert.match(server, /import \{ telemetryConfig, telemetryHostName, startTelemetryRelay, receiveTelemetry, startLocalTelemetry \} from '\.\/lib\/telemetry-relay\.js'/);
        assert.match(server, /const TELEMETRY = telemetryConfig\(process\.env\);/);
        assert.match(server, /registerTelemetryRoute\(app, \{ enabled: TELEMETRY\.enabled, source: [^}]*rateOk: telemetryRateOk,\s*head: [^\n]*cacheShort, serverError,\s*feedHost: telemetryHostName\(TELEMETRY\.url\) \}\)/);
        const primary = server.slice(server.indexOf('if (cluster.isPrimary)'));
        assert.ok(primary.indexOf("startTelemetryRelay({ config: TELEMETRY, cluster") > 0 && primary.indexOf("startTelemetryRelay(") < primary.indexOf("cluster.on('exit'"), 'the relay starts in the primary');
        assert.match(server, /if \(TELEMETRY\.enabled && process\.env\.INDEXER_ROLE !== 'on'\) telemetrySource = receiveTelemetry\(\);\s*runWorker\(\{ indexer: process\.env\.INDEXER_ROLE === 'on', clustered: true \}\)/);
        assert.match(server, /telemetrySource = startLocalTelemetry\(\{ config: TELEMETRY[^\n]*\n\s*runWorker\(\{ indexer: wantsIndexer, clustered: false \}\)/);
        assert.match(server, /TELEMETRY_LOOKUP_PER_MIN = readPositiveInteger\(process\.env\.TELEMETRY_LOOKUP_PER_MIN, 30\)/);
    });
    test('off by default: TELEMETRY_FEED_URL is documented, commented out, and set nowhere else', () => {
        const env = readRepo('.env.example', import.meta.url);
        assert.match(env, /^# TELEMETRY_FEED_URL=wss:\/\/feed\.telemetry\.polkadot\.io\/feed$/m);
        assert.doesNotMatch(env, /^TELEMETRY_FEED_URL=/m);
        assert.match(env, /^# TELEMETRY_LOOKUP_PER_MIN=30/m);
        assert.doesNotMatch(readRepo('docker-compose.yml', import.meta.url), /TELEMETRY_FEED_URL\s*[:=]\s*\S/);
    });
    test('documented: API reference (Short tier), README, llms.txt', () => {
        assert.ok(allRoutes().some(r => r.method === 'GET' && r.path === '/api/telemetry/node?name=<node name>'));
        assert.equal(CACHE_TIERS.find(t => t.routes.includes('/api/telemetry/node'))?.name, 'Short');
        for (const f of ['README.md', 'public/llms.txt']) assert.ok(readRepo(f, import.meta.url).includes('/api/telemetry/node'), f);
    });
    test('index.html: the flagged "Run a validator" link on the Validators page', () => {
        assert.match(html, /<a href="\/validate\/node" class="item-link validate-flag-link" hidden>Run a validator<\/a>/);
    });
    test('script.js: /validate/node mounts the guide; ?node= reaches the guide and the status; under 15,000 lines', () => {
        assert.match(script, /import \{ mountNodeGuide \} from '\.\/lib\/validator-node-guide\.js'/);
        assert.match(script, /if \(address === 'node'\) return mountNodeGuide\(document\.getElementById\('validate-root'\), \{ fetchJson: fetchApiJson, helpIcon, esc: stakingEscapeHtml, nodeName, setNodeParam \}\)/);
        assert.match(script, /new URLSearchParams\(window\.location\.search\)\.get\('node'\)/);
        assert.match(script, /isAddress: isSearchableAddress, nodeName \}/);
        assert.ok(readRepo('script.js', import.meta.url).split('\n').length <= 15000);
    });
    test('help: the "Run a validator" topic, flagged, no dashes, not in the sitemap while the flag is off', () => {
        const t = HELP_TOPICS.find(x => x.slug === 'run-a-validator');
        assert.ok(t);
        assert.equal(t.flag, 'validate');
        assert.ok(!/[\u2013\u2014]/.test(t.title + t.body));
        assert.doesNotMatch(server, /path: '\/help\/run-a-validator'/);
        for (const w of ['/validate/node', '127.0.0.1', 'self-declared', 'pending']) assert.ok(t.body.includes(w), w);
    });
    test('no en or em dashes in the new modules', () => {
        for (const f of ['lib/validator-node-guide.js', 'lib/node-check.js', 'lib/node-check-view.js', 'lib/telemetry-feed.js', 'lib/telemetry-reader.js', 'lib/telemetry-relay.js', 'lib/telemetry-api.js', 'lib/validator-node-release.js']) {
            assert.ok(!/[\u2013\u2014]/.test(readRepo(f, import.meta.url)), f);
        }
    });
    test('brand: the new styles add no colour of their own (green only on the positive state classes, no red), no inline colours', () => {
        const css = readRepo('styles.css', import.meta.url).replace(/\/\*[\s\S]*?\*\//g, '');
        const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }))
            .filter(r => /\.validate-(guide|cmd|checklist|pending|advanced|caption|node)/.test(r.sel));
        assert.ok(rules.length >= 10, 'the guide styles exist');
        for (const r of rules) {
            assert.doesNotMatch(r.body, /--success|--brand-secondary|--error|#[0-9a-f]{3,8}\b|rgba?\(\s*(20|255)\s*,\s*(241|77)/i, r.sel);
        }
        for (const f of ['lib/validator-node-guide.js', 'lib/node-check-view.js']) assert.doesNotMatch(stripComments(readRepo(f, import.meta.url)), /style="/, f);
    });
});

// ── the real page (happy-dom, one load per child process) ──
const RUNNER = fileURLToPath(new URL('./helpers/full-page.js', import.meta.url));
function page(scenario) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [RUNNER, JSON.stringify({ probe: ['.validate-guide', '#node-check-result', '#nav-validate'], ...scenario })], { timeout: 60000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
            const line = String(stdout).split('\n').find(l => l.startsWith('RESULT '));
            if (!line) return reject(new Error('the page did not report: ' + (err ? err.message : '') + '\n' + String(stderr).slice(-2000)));
            resolve(JSON.parse(line.slice(7)));
        });
    });
}

describe('/validate/node in the real page', () => {
    test('flag off: the not-found page, and nothing about telemetry is fetched', async () => {
        const r = await page({ path: 'validate/node?node=hotel' });
        assert.equal(r.page, 'not-found');
        assert.equal(r.probe['.validate-guide'].count, 0);
        assert.ok(!r.fetched.some(u => u.includes('telemetry')));
    });
    test('flag on: the guide; ?node=NAME asks the explorer API, never a telemetry host', async () => {
        const r = await page({ path: 'validate/node?node=hotel', seed: { pdex_validate_enabled: '1' }, api: { '/api/telemetry/node': ok({ name: 'hotel' }) }, steps: [{ wait: 200 }] });
        assert.equal(r.page, 'validate');
        assert.equal(r.probe['.validate-guide'].count, 1);
        assert.ok(r.fetched.includes('/api/telemetry/node?name=hotel'), r.fetched.join(', '));
        assert.match(r.probe['#node-check-result'].text, /hotel is reporting\./);
        for (const u of [...r.fetched, ...r.sockets]) assert.doesNotMatch(u, /telemetry\.polkadot|feed\.telemetry/, u);
        assert.equal(r.final.path, '/validate/node?node=hotel');
        assert.deepEqual(r.errors, []);
    });
});

describe('Fable findings 2, 3 and 4 on the node guide and Check my node', () => {
    const NO_PROXY = 'Never proxy or forward port 9944 (reverse proxy, SSH tunnel to 127.0.0.1): --rpc-methods=auto exposes every method to anything that reaches localhost.';
    test('finding 2: the run notes and the checklist both say never to proxy or forward 9944', () => {
        const html = renderNodeGuide({ esc, release: PENDING });
        assert.ok(CHECKLIST.includes(NO_PROXY));
        assert.ok(html.split(esc(NO_PROXY)).length === 3, 'once in the notes, once in the checklist');
    });
    test('finding 3: the host named in "not found" is the configured feed host, never hard-coded', () => {
        const nf = (o) => ({ feed: 'ok', name: 'alpha-node', count: 0, nodes: [], similar: [], ...o });
        const m = nodeCheckModel(nf({ feedHost: 'telemetry.example.org' }));
        assert.match(m.text, /^No node named alpha-node is reporting to telemetry\.example\.org right now\./);
        assert.match(nodeTelemetryRow(nf({ feedHost: 'telemetry.example.org' })).text, /^No node named alpha-node is reporting to telemetry\.example\.org\. /);
        const bare = nodeCheckModel(nf({}));
        assert.match(bare.text, /^No node named alpha-node is reporting to telemetry right now\./);
        assert.doesNotMatch(bare.text + nodeTelemetryRow(nf({})).text, /polkadot\.io/);
        assert.doesNotMatch(stripComments(readRepo('lib/node-check.js', import.meta.url)), /polkadot\.io/);
    });
    test('finding 4: no empty header cell in the hardware table; every th has a scope', () => {
        const { el } = dom(); el.innerHTML = renderNodeGuide({ esc, release: PENDING });
        const ths = [...el.querySelectorAll('th')];
        assert.ok(ths.length > 0);
        for (const th of ths) {
            assert.ok(th.textContent.trim().length > 0, 'empty th: ' + th.outerHTML);
            assert.match(th.getAttribute('scope') || '', /^(col|row)$/, th.outerHTML);
        }
    });
});
