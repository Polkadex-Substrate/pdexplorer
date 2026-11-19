// The official Polkadex node release the node guide (/validate/node) points
// operators to. CEO decision D1 (2026-11-17): publish a tagged binary and a
// Docker image for client 7.0.x with checksums, and link the guide to it. This
// constant is the ONE place the guide reads the release from; nothing else in
// the explorer names a client version, an image or a checksum.
//
// While every field is null the guide says the official release is pending and
// does not offer build-from-source as the main path (only a collapsed
// "Advanced" block at the pinned commit below, as in the design's section 3.3).
//
// To publish: fill in EVERY field in one change. releaseState() refuses a half
// filled constant (the guide then still says "pending"), and the test
// test/validator-node.test.js fails on one, so a typo cannot ship a wrong link.
// The values end up inside shell commands an operator copies, which is why the
// formats are strict (https URLs without quotes or spaces, a 64-hex sha256, an
// image pinned by digest).
//
//   version          '7.0.1'                       the client version the release is
//   binaryUrl        https URL of the Linux x86_64 binary
//   binarySha256     its sha256, 64 lowercase hex
//   image            'registry/name:tag@sha256:<64 hex>' (pinned by digest)
//   chainSpecUrl     https URL of the mainnet chain spec (customSpecRaw.json)
//   chainSpecSha256  its sha256
//   releaseNotesUrl  https URL of the release page

export const NODE_RELEASE = Object.freeze({
    version: null,
    binaryUrl: null,
    binarySha256: null,
    image: null,
    chainSpecUrl: null,
    chainSpecSha256: null,
    releaseNotesUrl: null
});

// The pinned source the "Advanced: build from source" block names (design
// section 3.3; the kit's build-node.sh builds this commit).
export const NODE_SOURCE = Object.freeze({
    repo: 'https://github.com/Polkadex-Substrate/polkadex-node',
    commit: '566b080ba1a322fab0f11c085128f482e6b40802',
    version: '7.0.0',
    chainSpecPath: 'extras/customSpecRaw.json'
});

const FIELDS = ['version', 'binaryUrl', 'binarySha256', 'image', 'chainSpecUrl', 'chainSpecSha256', 'releaseNotesUrl'];
const RULES = {
    version: /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/,
    binaryUrl: /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~%/+-]*)?$/,
    binarySha256: /^[0-9a-f]{64}$/,
    image: /^[a-z0-9.-]+(:\d+)?\/[a-z0-9._/-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/,
    chainSpecUrl: /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~%/+-]*)?$/,
    chainSpecSha256: /^[0-9a-f]{64}$/,
    releaseNotesUrl: /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~%/+-]*)?$/
};

// { published, problems }. All null: pending, no problems. All valid:
// published. Anything in between: pending, with the fields that are wrong.
export function releaseState(r = NODE_RELEASE) {
    const rel = r || {};
    const set = FIELDS.filter(f => rel[f] != null && rel[f] !== '');
    if (!set.length) return { published: false, problems: [] };
    const problems = FIELDS.filter(f => typeof rel[f] !== 'string' || !RULES[f].test(rel[f]));
    return { published: problems.length === 0, problems };
}

// The version a node reports to telemetry ("7.0.0-566b080ba1a") against a
// release version ("7.0.1"): 'older', 'same', 'newer' or 'unknown'.
export function compareNodeVersion(nodeVersion, releaseVersion) {
    const parse = (v) => {
        const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const a = parse(nodeVersion), b = parse(releaseVersion);
    if (!a || !b) return 'unknown';
    for (let i = 0; i < 3; i++) {
        if (a[i] < b[i]) return 'older';
        if (a[i] > b[i]) return 'newer';
    }
    return 'same';
}
