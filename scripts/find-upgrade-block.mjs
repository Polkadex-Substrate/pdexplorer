#!/usr/bin/env node
// Finds where a chain switched to a given runtime spec, for the 392 testnet
// proof in docs/392-readiness.md. Works on any endpoint, so the proof can run
// on whatever 392 chain is reachable (the public testnet, or a copy of
// mainnet state upgraded to 392).
//
//   node scripts/find-upgrade-block.mjs --ws wss://polkadex-testnet.polkadex.ee
//   node scripts/find-upgrade-block.mjs --ws <url> --spec 392 --margin 1000
//
// Prints the chain head and its spec, the block U that enacted the spec (its
// system.CodeUpdated block; U + 1 is the first block built with it), and the
// MIN_BLOCK value for the dev instance so it indexes both sides of U. A last
// line "RESULT ..." is the one to copy into the proof record.
//
// Also prints the genesis hash and warns when it is mainnet's (a mainnet-state
// copy), because transactions signed there are shaped like mainnet ones.
//
// Read-only JSON-RPC (chain_getHeader, chain_getBlockHash,
// state_getRuntimeVersion). Reading the spec at an old block needs that
// block's state, so point it at an archive node; a pruned node fails with a
// state error, which the script reports as such.

import { rpcClient } from '../lib/json-rpc-client.js';
import { findUpgradeBlock, proofWindow } from '../lib/upgrade-block.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
// Polkadex mainnet genesis (also in test/fixtures/metadata-373.json).
const MAINNET_GENESIS = '0x3920bcb4960a1eef5580cd5367ff3f430eef052774f78468852f7b9cb39f8a3c';
const WS = opt('ws', null);
const SPEC = Number(opt('spec', '392'));
const MARGIN = Number(opt('margin', '1000'));
if (!WS || !/^wss?:\/\//.test(WS)) {
    console.error('Usage: node scripts/find-upgrade-block.mjs --ws <wss url> [--spec 392] [--margin 1000]');
    process.exit(2);
}
if (!Number.isInteger(SPEC) || SPEC <= 0 || !Number.isInteger(MARGIN) || MARGIN < 1) {
    console.error('--spec and --margin must be positive integers.');
    process.exit(2);
}
if (typeof WebSocket !== 'function') {
    console.error('This script needs a global WebSocket (Node 22 or newer). Found Node ' + process.version + '.');
    process.exit(2);
}

const { call, close } = rpcClient(WS);
try {
    const head = parseInt((await call('chain_getHeader')).number, 16);
    const rv = await call('state_getRuntimeVersion');
    const genesis = await call('chain_getBlockHash', [0]);
    console.log(`endpoint ${WS}`);
    console.log(`head #${head}, ${rv.specName} spec ${rv.specVersion}, transaction version ${rv.transactionVersion}`);
    console.log(`genesis ${genesis}`);
    if (String(genesis).toLowerCase() === MAINNET_GENESIS) {
        console.log('WARNING: this chain has the MAINNET genesis hash (a copy of mainnet). A transaction signed here is shaped like a mainnet one:');
        console.log('         keep the wallet default (a mortal era, which binds the signature to a block of THIS chain); never sign an immortal one.');
    }
    const specAt = async (n) => {
        const hash = await call('chain_getBlockHash', [n]);
        if (!hash) throw new Error(`no block hash for #${n}`);
        try {
            return (await call('state_getRuntimeVersion', [hash])).specVersion;
        } catch (e) {
            throw new Error(`state at #${n} unavailable (${e.message}); this needs an archive node`);
        }
    };
    const r = await findUpgradeBlock({ specAt, head, target: SPEC });
    if (!r.upgraded) {
        console.log(`RESULT not-upgraded: head runs spec ${r.headSpec}, below ${SPEC}. This endpoint cannot serve the 392 proof.`);
        process.exitCode = 1;
    } else if (r.fromGenesis) {
        const w = proofWindow(r, head, MARGIN);
        console.log(`block 0 already runs spec ${SPEC} or later: the chain started on it (no pre-upgrade blocks to index).`);
        console.log(`RESULT from-genesis spec=${r.headSpec} head=${head} MIN_BLOCK=${w.from}`);
    } else {
        const w = proofWindow(r, head, MARGIN);
        console.log(`spec ${r.previousSpec} -> ${SPEC} or later enacted in block #${r.block} (system.CodeUpdated there); #${r.firstNewBlock} is the first block built with it.`);
        console.log(`index window #${w.from}..#${w.to} (${w.blocks} blocks)`);
        console.log(`RESULT upgrade-block=${r.block} previous-spec=${r.previousSpec} head-spec=${r.headSpec} head=${head} MIN_BLOCK=${w.from} WINDOW_END=${w.to} WINDOW_BLOCKS=${w.blocks}`);
    }
} catch (e) {
    console.error(`FAILED: ${e.message}`);
    process.exitCode = 1;
} finally {
    close();
}
