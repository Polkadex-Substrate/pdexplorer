# Validator node-version census (temporary)

A standalone operator tool. It is not part of the explorer server: nothing imports it, it is not built into the Docker images, and the explorer's tests do not run it.

One script, `node_census.py`, counts how many active Polkadex mainnet validators run client 7.0.0 or newer.

## Why it exists, and when to delete it

It tracks the 7.0.0 upgrade census ahead of the spec 392 runtime upgrade, and nothing else. The explorer endpoint that was once planned for this was cancelled. Delete this whole folder (`tools/node-census`) after 392 is enacted.

## Run it

Once, if `cargo --version` does not work: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, then open a new terminal.

    cd tools/node-census   # from the explorer repo root
    ./node_census.py --diff results/2026-10-16-census.csv

The first run builds the pinned subp2p-explorer (commit 8a02789937a374ffd586d503dc67781eb2c9ad65, `cargo build --locked`) into `~/.cache/validator-census`, 5 to 15 minutes. Later runs take about 10 to 12 minutes (crawl timeout 600 s plus dial checks). Only system python3 (3.9 or newer), git and Rust are needed. No credentials.

- Output: `results/DATE-census.csv`, a printed summary (active, reachable, count per version, unreachable, percent on 7.0.0 or newer) and, with `--diff OLDER.csv`, who changed version since that file.
- The raw crawl report is saved to `results/raw/` (git-ignored).
- `./node_census.py --reprocess [results/raw/FILE.json]` rebuilds the CSV from a saved raw report with no crawl. `--no-names` skips the one network read.
- `./node_census.py --help` lists the environment overrides: RPC_URL, TIMEOUT, DIAL_TIMEOUT, BOOTNODES, NETWORK_BACKEND, CACHE_DIR.
- Tests: `python3 -m unittest discover -s tools/node-census/tests -v` from the repo root (standard library, no network).

## How to read it

- Unreachable is never counted as old: those validators could not be asked. Chase them by name, then rerun with a longer TIMEOUT or `NETWORK_BACKEND=litep2p`.
- A prerelease build (7.0.0-rc1) is not counted as 7.0.0. A commit suffix like -566b080 is not a prerelease.
- The version is what the node says about itself, not proof of the binary on disk, and not proof the operator has set new session keys.
- Display names are read from the chain (Identity.IdentityOf, and SuperOf for PARENT/sub) over HTTPS JSON-RPC at rpc2.polkadex.ee, falling back to rpc.polkadex.ee. If that fails the CSV is still written with empty names and the summary says so. Node names from the agent string are in the `node_name` column.
- CSV text from the network and the chain is cleaned: control characters removed, a leading = + - @ prefixed with an apostrophe.
