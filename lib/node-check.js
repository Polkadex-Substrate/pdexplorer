// "Check my node" (design section 3.5): what GET /api/telemetry/node said, as
// one state, a word, a tone and sentences. Pure, no DOM; the view is
// lib/node-check-view.js. Copy from the design, verbatim where it gives one.
//
// Green (tone 'positive') only when the node is within 5 blocks of the chain
// head and has 3 or more peers. Behind is neutral, not red. Every state is a
// word as well as a colour.

export const NAME_MAX = 64;   // the longest node name the lookup takes
export const IN_SYNC_BLOCKS = 5;
export const MIN_PEERS = 3;
export const SELF_DECLARED = 'Telemetry names are self-declared. This is a hint, not proof that the node is yours.';
export const KEYS_NOT_VISIBLE = 'Telemetry cannot show which session keys a node holds, so the explorer cannot tell whether the keys registered for your stash are on this node. Once your validator is active, the Online this session row of your validator status comes from the chain and cannot be faked.';
export const UNAVAILABLE = 'The explorer cannot read telemetry right now. This does not affect your node or your validator.';
export const SWITCHED_OFF = 'Telemetry is unavailable on this explorer. This does not affect your node or your validator.';

// The telemetry host to name: the configured feed's (the route's feedHost), else just "telemetry".
const feedName = (r) => (r && typeof r.feedHost === 'string' && r.feedHost) || 'telemetry';
const fmt = (n) => '#' + Number(n).toLocaleString('en-US');
const peers = (p) => `${p} peer${p === 1 ? '' : 's'}`;

function releaseNote(r, node) {
    const rel = r && r.release;
    if (!rel || rel.state !== 'published' || !rel.version) return 'The official release is pending, so the client version is not compared yet.';
    if (node.versionVsRelease === 'same') return `Client ${node.version} is the latest official release.`;
    if (node.versionVsRelease === 'older') return `The latest official release is ${rel.version}. This node runs an older client.`;
    return `The latest official release is ${rel.version}.`;
}

// r: the route's JSON. Returns { state, word, tone, text, notes: [], nodes, similar }.
export function nodeCheckModel(r) {
    const name = r && r.name ? r.name : '';
    const base = { nodes: [], similar: [], notes: [] };
    if (!r || r.feed === 'off') return { ...base, state: 'off', word: 'Unavailable', tone: 'neutral', text: SWITCHED_OFF };
    if (r.feed !== 'ok') return { ...base, state: 'down', word: 'Unavailable', tone: 'neutral', text: UNAVAILABLE };
    const list = Array.isArray(r.nodes) ? r.nodes : [];
    const count = Number.isInteger(r.count) ? r.count : list.length;
    if (!count) {
        return { ...base, state: 'not-found', word: 'Not found', tone: 'neutral', similar: Array.isArray(r.similar) ? r.similar : [],
            text: `No node named ${name} is reporting to ${feedName(r)} right now. Check the --name and --telemetry-url flags. A node that does not report telemetry can still validate.`,
            notes: [SELF_DECLARED] };
    }
    if (count > 1) {
        return { ...base, state: 'several', word: 'Several', tone: 'neutral', nodes: list,
            text: `${count} nodes report the name ${name}. Names are not unique. Pick a name only you use.`,
            notes: [SELF_DECLARED] };
    }
    const n = list[0];
    const head = Number.isSafeInteger(r.head) ? r.head : null;
    const behind = head != null && n.best != null ? Math.max(0, head - n.best) : null;
    const notes = [];
    if (behind != null && behind > IN_SYNC_BLOCKS) {
        return { ...base, state: 'behind', word: 'Behind', tone: 'neutral', nodes: [n],
            text: `${name} is reporting but is ${behind.toLocaleString('en-US')} blocks behind. Wait until it has caught up before generating keys.`,
            notes: [releaseNote(r, n), SELF_DECLARED, KEYS_NOT_VISIBLE] };
    }
    const parts = [];
    if (n.best != null) parts.push(`Best block ${fmt(n.best)}${head != null ? ` (chain head ${fmt(head)})` : ''}`);
    if (n.finalized != null) parts.push(`finalized ${fmt(n.finalized)}`);
    if (n.peers != null) parts.push(peers(n.peers));
    if (n.version) parts.push(`client ${n.version}`);
    if (n.secondsAgo != null) parts.push(`last seen ${n.secondsAgo} s ago`);
    const text = `${name} is reporting.${parts.length ? ' ' + parts.join(', ') + '.' : ''}`;
    if (head == null) notes.push('The explorer cannot read the chain head right now, so the sync gap is unknown.');
    if (n.stale) notes.push('Telemetry marks this node as stale: it has not reported a new block for 2 minutes.');
    if (n.peers != null && n.peers < MIN_PEERS) notes.push(`It has fewer than ${MIN_PEERS} peers.`);
    notes.push(releaseNote(r, n), SELF_DECLARED, KEYS_NOT_VISIBLE);
    const green = behind != null && behind <= IN_SYNC_BLOCKS && n.peers != null && n.peers >= MIN_PEERS && !n.stale;
    return { ...base, state: green ? 'in-sync' : 'reporting', word: green ? 'In sync' : 'Reporting', tone: green ? 'positive' : 'neutral', text, notes, nodes: [n] };
}

// The "Node on telemetry" row of the validator status (design section 2.4).
// Always neutral: on the status page green is kept for Active and Heartbeat.
export function nodeTelemetryRow(r) {
    const name = r && r.name ? r.name : '';
    const row = (word, text) => ({ id: 'telemetry', label: 'Node on telemetry', word, tone: 'neutral', text });
    if (!r || r.feed === 'off') return row('Unavailable', SWITCHED_OFF);
    if (r.feed !== 'ok') return row('Unavailable', UNAVAILABLE);
    const list = Array.isArray(r.nodes) ? r.nodes : [];
    if (!list.length) return row('Not found', `No node named ${name} is reporting to ${feedName(r)}. ${SELF_DECLARED}`);
    if ((r.count || list.length) > 1) return row('Several', `${r.count || list.length} nodes report the name ${name}. ${SELF_DECLARED}`);
    const n = list[0];
    const bits = [];
    if (n.best != null) bits.push(`best block ${fmt(n.best)}`);
    if (n.peers != null) bits.push(peers(n.peers));
    if (n.version) bits.push(`version ${n.version}`);
    if (n.secondsAgo != null) bits.push(`seen ${n.secondsAgo} s ago`);
    return row('Reporting', `A node named ${name} is reporting${bits.length ? ': ' + bits.join(', ') : ''}. ${SELF_DECLARED}`);
}
