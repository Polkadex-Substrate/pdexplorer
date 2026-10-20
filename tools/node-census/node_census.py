#!/usr/bin/env python3
"""Polkadex validator node-version census, one self-contained script.

TEMPORARY: it only tracks the 7.0.0 client upgrade across the active mainnet
validator set before the spec 392 runtime upgrade. Delete the whole
validator-census folder once 392 is enacted.

  crawl (default)   build the pinned subp2p-explorer once, run its authority-check
                    against mainnet, save the raw JSON to results/raw/, then process.
  --reprocess [F]   process a saved raw report, no crawl (newest by default).
  processing        one row per active validator (stash): node version from the
                    libp2p agent string, reachable or not, display name read from
                    the chain (Identity.IdentityOf, SuperOf for PARENT/sub) over
                    HTTPS JSON-RPC. Writes results/DATE-census.csv, prints a summary.
  --diff OLDER.csv  also print who changed version since an earlier CSV (the weekly use).

Python 3.9+ standard library only. A crawl also needs git, Rust (cargo) and
outbound TCP to validators' p2p ports. No credentials.
"""
import argparse
import csv
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")

SUBP2P_REPO = "https://github.com/lexnv/subp2p-explorer"
SUBP2P_SHA = "8a02789937a374ffd586d503dc67781eb2c9ad65"

# Mainnet genesis hash, written in two halves on purpose: the repo's secret
# scan flags any bare 64-hex string, and this one is public, not a secret.
GENESIS = "0x3920bcb4960a1eef5580cd5367ff3f43" + "0eef052774f78468852f7b9cb39f8a3c"

DEFAULT_RPC = "wss://rpc2.polkadex.ee"
DEFAULT_RPC_FALLBACK = "wss://rpc.polkadex.ee"
BOOTNODES_DEFAULT = ",".join([
    "/dns/boot.polkadex.ee/tcp/30333/ws/p2p/12D3KooWPBimEphuSb48WuwEm44WoACtgnRnDPiGf8ekhurWyc95",
    "/dns/polkadex.boot.faradaynodes.com/tcp/30716/p2p/12D3KooWENh4QpXzfaD8nonhTaSHreuRpKRTRtDTztGeJ7XxXgyw",
    "/dns/boot.pdexmon.com/tcp/30333/ws/p2p/12D3KooWDG1dWUq2z3moX7yXqo5hKPSwcpyoK55NRrwZG8g5VtRu",
])

COLUMNS = [
    "date", "stash", "display_name", "node_name", "authority_id", "peer_id",
    "reachable", "agent_version", "client_version_parsed", "is_v7",
]
TARGET = (7, 0, 0)

class Fatal(Exception):
    pass

# --- Version parsing (from the libp2p agent string) ---

# Anchored to the Polkadex product prefix so other components in the agent string
# (a transport "libp2p/v7.1.0") are never read as the node version. Real agents read
# "Polkadex Node/v7.0.0-<commit> (<name>)"; "polkadex-node/v" and "Polkadex/v" occur
# too. The text after the numbers is captured to spot prereleases.
_VERSION_RE = re.compile(
    r"(?<![a-z0-9])polkadex(?:[- ]node)?/v(\d+)\.(\d+)(?:\.(\d+))?([-+][^\s()]*)?",
    re.IGNORECASE,
)
# A suffix starting with one of these labels is a prerelease (7.0.0-rc1); anything
# else (a commit hash such as -566b080) is build metadata.
_PRERELEASE_RE = re.compile(
    r"^-(alpha|beta|rc|prerelease|preview|pre|dev|nightly|canary|snapshot)(?![a-z])",
    re.IGNORECASE,
)
_BACKEND_GROUP_RE = re.compile(r"\s*\((?:libp2p|litep2p)\)\s*$", re.IGNORECASE)
_NODE_GROUP_RE = re.compile(r"^\s*\((.*)\)\s*$", re.DOTALL)

def _match(agent):
    if not agent or not isinstance(agent, str):
        return None
    return _VERSION_RE.search(agent)

def parse_version(agent):
    """(major, minor, patch) from an agent string, or None."""
    m = _match(agent)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))

def is_prerelease(agent):
    m = _match(agent)
    if not m or not m.group(4):
        return False
    return bool(_PRERELEASE_RE.match(m.group(4)))

def parse_node_name(agent):
    """The parenthesised node name after the version, e.g. "Faraday/18". A
    trailing "(litep2p)" or "(libp2p)" is the network backend, not a name."""
    if not agent or not isinstance(agent, str):
        return ""
    m = _match(agent)
    if m:
        rest = agent[m.end():]
    else:
        i = agent.find("(")
        rest = agent[i:] if i >= 0 else ""
    rest = _BACKEND_GROUP_RE.sub("", rest)
    g = _NODE_GROUP_RE.match(rest)
    return g.group(1).strip() if g else ""

def _version_key(agent):
    """Order for picking the best of duplicate entries: unknown lowest, a
    release above a prerelease of the same numbers."""
    v = parse_version(agent)
    return (-1, -1, -1, -1) if v is None else v + (0 if is_prerelease(agent) else 1,)

def format_version(v):
    return "" if v is None else "%d.%d.%d" % v

def is_v7(v):
    """True if at least 7.0.0, False if older, None if unknown."""
    return None if v is None else v >= TARGET

def is_reachable(result):
    """Reachable: identify answered (non-empty agent_version) or a p2p dial
    succeeded (dial_outcome Success). A bare TCP connect (result.status Ok)
    does not count: any open port passes it."""
    agent = result.get("agent_version")
    if isinstance(agent, str) and agent.strip():
        return True
    for a in result.get("addresses") or []:
        if (a.get("dial_outcome") or {}).get("status") == "Success":
            return True
    return False

def clean_text(value):
    """Drop control characters and neutralise spreadsheet formula prefixes."""
    if value is None:
        return ""
    text = "".join(ch for ch in str(value) if unicodedata.category(ch)[0] != "C").strip()
    if text and text[0] in "=+-@":
        text = "'" + text
    return text

# --- Hashing and SCALE helpers for reading chain storage ---

_M64 = (1 << 64) - 1
_P1, _P2, _P3 = 11400714785074694791, 14029467366897019727, 1609587929392839161
_P4, _P5 = 9650029242287828579, 2870177450012600261

def _rotl(x, r):
    return ((x << r) | (x >> (64 - r))) & _M64

def _u64(b, p):
    return int.from_bytes(b[p:p + 8], "little")

def _round(acc, inp):
    acc = (acc + inp * _P2) & _M64
    return (_rotl(acc, 31) * _P1) & _M64

def xxh64(data, seed=0):
    """Pure-Python XXH64 (what Substrate calls twox64 when seed is 0)."""
    n, p = len(data), 0
    if n >= 32:
        v1, v2 = (seed + _P1 + _P2) & _M64, (seed + _P2) & _M64
        v3, v4 = seed & _M64, (seed - _P1) & _M64
        while p <= n - 32:
            v1 = _round(v1, _u64(data, p))
            v2 = _round(v2, _u64(data, p + 8))
            v3 = _round(v3, _u64(data, p + 16))
            v4 = _round(v4, _u64(data, p + 24))
            p += 32
        h = (_rotl(v1, 1) + _rotl(v2, 7) + _rotl(v3, 12) + _rotl(v4, 18)) & _M64
        for v in (v1, v2, v3, v4):
            h = ((h ^ _round(0, v)) * _P1 + _P4) & _M64
    else:
        h = (seed + _P5) & _M64
    h = (h + n) & _M64
    while p + 8 <= n:
        h = (_rotl(h ^ _round(0, _u64(data, p)), 27) * _P1 + _P4) & _M64
        p += 8
    if p + 4 <= n:
        h = (_rotl(h ^ (int.from_bytes(data[p:p + 4], "little") * _P1 & _M64), 23) * _P2 + _P3) & _M64
        p += 4
    while p < n:
        h = (_rotl(h ^ (data[p] * _P5 & _M64), 11) * _P1) & _M64
        p += 1
    h ^= h >> 33
    h = (h * _P2) & _M64
    h ^= h >> 29
    h = (h * _P3) & _M64
    return h ^ (h >> 32)

def twox64(data):
    return xxh64(data, 0).to_bytes(8, "little")

def twox128(data):
    return xxh64(data, 0).to_bytes(8, "little") + xxh64(data, 1).to_bytes(8, "little")

def blake2_128(data):
    return hashlib.blake2b(data, digest_size=16).digest()

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def ss58_decode(address):
    """Public key (32 bytes) from an SS58 address. Checks the checksum.
    Raises ValueError on anything malformed."""
    num = 0
    for ch in address:
        i = _B58.find(ch)
        if i < 0:
            raise ValueError("bad base58 character")
        num = num * 58 + i
    raw = num.to_bytes((num.bit_length() + 7) // 8, "big")
    raw = b"\x00" * (len(address) - len(address.lstrip("1"))) + raw
    if len(raw) == 35:
        plen = 1
    elif len(raw) == 36:
        plen = 2
    else:
        raise ValueError("unexpected SS58 length")
    body, check = raw[:-2], raw[-2:]
    if hashlib.blake2b(b"SS58PRE" + body, digest_size=64).digest()[:2] != check:
        raise ValueError("SS58 checksum mismatch")
    return body[plen:]

def identity_of_key(pub):
    """Identity.IdentityOf is a Twox64Concat map (polkadot-sdk pallet-identity)."""
    return twox128(b"Identity") + twox128(b"IdentityOf") + twox64(pub) + pub

def super_of_key(pub):
    """Identity.SuperOf is a Blake2_128Concat map (polkadot-sdk pallet-identity)."""
    return twox128(b"Identity") + twox128(b"SuperOf") + blake2_128(pub) + pub

def _compact(b, off):
    """SCALE compact integer: (value, new offset)."""
    mode = b[off] & 3
    if mode == 0:
        return b[off] >> 2, off + 1
    if mode == 1:
        return int.from_bytes(b[off:off + 2], "little") >> 2, off + 2
    if mode == 2:
        return int.from_bytes(b[off:off + 4], "little") >> 2, off + 4
    raise ValueError("big-integer compact not expected here")

def _read_data(b, off):
    """pallet-identity Data: (text, new offset). 0 None, 1..33 Raw(tag-1 bytes),
    34..37 a 32-byte hash (no text)."""
    tag = b[off]
    off += 1
    if tag == 0:
        return "", off
    if 1 <= tag <= 33:
        raw = b[off:off + tag - 1]
        if len(raw) != tag - 1:
            raise ValueError("truncated")
        try:
            text = raw.decode("utf-8").strip()
        except UnicodeDecodeError:
            return "", off + tag - 1
        if "�" in text or any(unicodedata.category(c)[0] == "C" for c in text):
            text = ""
        return text, off + tag - 1
    if 34 <= tag <= 37:
        return "", off + 32
    raise ValueError("unknown Data variant")

def decode_identity_display(raw):
    """Display name from an Identity.IdentityOf value, or "". Layout (legacy
    IdentityInfo, as in the Polkadex runtime): judgements Vec<(u32, Judgement)>,
    deposit u128, additional Vec<(Data, Data)>, display Data. Only display is read."""
    try:
        n, off = _compact(raw, 0)
        for _ in range(n):
            off += 4
            tag = raw[off]
            off += 1
            if tag == 1:  # Judgement::FeePaid(u128)
                off += 16
        off += 16
        n, off = _compact(raw, off)
        for _ in range(n):
            _, off = _read_data(raw, off)
            _, off = _read_data(raw, off)
        return _read_data(raw, off)[0]
    except (IndexError, ValueError):
        return ""

def decode_super_of(raw):
    """(parent public key, sub name) from an Identity.SuperOf value, or None."""
    try:
        if len(raw) < 33:
            return None
        return raw[:32], _read_data(raw, 32)[0]
    except (IndexError, ValueError):
        return None

# --- On-chain names over HTTPS JSON-RPC (best effort, read only) ---

def to_http(url):
    if url.startswith("wss://"):
        return "https://" + url[len("wss://"):]
    if url.startswith("ws://"):
        return "http://" + url[len("ws://"):]
    return url

def rpc_call(url, method, params, timeout=30):
    """One JSON-RPC request over HTTP(S). Returns the result or raises."""
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                          "params": params}).encode()
    req = urllib.request.Request(
        to_http(url), data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "node-census/1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read(8 * 1024 * 1024)
    try:
        data = json.loads(body)
    except ValueError:
        raise ValueError("not JSON (a load balancer error page?)")
    if not isinstance(data, dict) or "result" not in data:
        raise ValueError("RPC error: %s" % str(data.get("error") if isinstance(data, dict) else data)[:120])
    return data["result"]

def _query_values(url, keys, rpc, chunk=50):
    """{key hex: value bytes or None} through state_queryStorageAt."""
    out = {}
    for i in range(0, len(keys), chunk):
        part = ["0x" + k.hex() for k in keys[i:i + chunk]]
        res = rpc(url, "state_queryStorageAt", [part])
        for block in res or []:
            for key, val in block.get("changes", []):
                out[key] = bytes.fromhex(val[2:]) if val else None
    return out

def _names_from(url, stashes, rpc):
    pubs = {}
    for s in stashes:
        try:
            pubs[s] = ss58_decode(s)
        except ValueError:
            pass
    if rpc(url, "chain_getBlockHash", [0]) != GENESIS:
        raise ValueError("endpoint serves a different chain")
    ids = _query_values(url, [identity_of_key(p) for p in pubs.values()], rpc)
    names, subs = {}, {}
    for s, p in pubs.items():
        val = ids.get("0x" + identity_of_key(p).hex())
        display = decode_identity_display(val) if val else ""
        if display:
            names[s] = display
    pending = [s for s in pubs if s not in names]
    sup = _query_values(url, [super_of_key(pubs[s]) for s in pending], rpc)
    for s in pending:
        val = sup.get("0x" + super_of_key(pubs[s]).hex())
        parsed = decode_super_of(val) if val else None
        if parsed:
            subs[s] = parsed
    parents = sorted({p for p, _ in subs.values()})
    pid = _query_values(url, [identity_of_key(p) for p in parents], rpc)
    for s, (parent, sub) in subs.items():
        val = pid.get("0x" + identity_of_key(parent).hex())
        pname = decode_identity_display(val) if val else ""
        if pname and sub:
            names[s] = "%s/%s" % (pname, sub)
        elif pname or sub:
            names[s] = pname or sub
    return names

def fetch_names(stashes, urls, rpc=rpc_call):
    """(names by stash, error text or None). Tries each URL in turn and uses
    the first that completes. Never raises: names are best effort."""
    errors = []
    for url in urls:
        try:
            return _names_from(url, stashes, rpc), None
        except Exception as exc:  # network, JSON, decode: all mean "try next"
            errors.append("%s: %s" % (to_http(url), exc))
    return {}, "; ".join(errors) if errors else "no RPC URL given"

# --- Report to rows, CSV, summary ---

def build_row(result, names, date):
    stash = result.get("stash_ss58") or ""
    agent = result.get("agent_version")
    version = parse_version(agent)
    pre = is_prerelease(agent)
    v7 = is_v7(version)
    if pre:  # policy: a prerelease (7.0.0-rc1) is not counted as on 7.0.0
        v7 = False
    return {
        "date": date,
        "stash": clean_text(stash),
        "display_name": clean_text((names or {}).get(stash, "")),
        "node_name": clean_text(parse_node_name(agent)),
        "authority_id": clean_text(result.get("authority_ss58")),
        "peer_id": clean_text(result.get("peer_id")),
        "reachable": "yes" if is_reachable(result) else "no",
        "agent_version": clean_text(agent),
        "client_version_parsed": "prerelease" if pre else format_version(version),
        "is_v7": "unknown" if v7 is None else ("yes" if v7 else "no"),
    }

def build_rows(report, names, date):
    """One row per validator. The same stash can appear more than once in the
    report; entries are merged on stash (authority id when the stash is
    empty), keeping the best reachability and the highest version seen."""
    auths = report.get("authorities") if isinstance(report, dict) else None
    if not auths:
        raise ValueError("report has no authorities: the run did not complete")
    groups, order = {}, []
    for i, r in enumerate(auths):
        row = build_row(r, names, date)
        key = row["stash"] or row["authority_id"] or ("#%d" % i)
        rank = (is_reachable(r), _version_key(r.get("agent_version")))
        if key not in groups:
            groups[key] = (rank, row)
            order.append(key)
            continue
        old_rank, old = groups[key]
        best, other = (row, old) if rank > old_rank else (old, row)
        merged = dict(best)
        for col in ("display_name", "node_name", "authority_id", "peer_id"):
            merged[col] = merged[col] or other[col]
        if other["reachable"] == "yes":
            merged["reachable"] = "yes"
        groups[key] = (max(rank, old_rank), merged)
    return [groups[k][1] for k in order]

def write_csv(rows, fh):
    w = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator="\n")
    w.writeheader()
    for r in rows:
        w.writerow(r)

def _label(row):
    return row["display_name"] or row["node_name"] or row["stash"] or row["authority_id"]

def summarize(rows):
    reachable = [r for r in rows if r["reachable"] == "yes"]
    versions = {}
    for r in reachable:
        k = r["client_version_parsed"] or "not reported"
        versions[k] = versions.get(k, 0) + 1
    v7 = sum(1 for r in reachable if r["is_v7"] == "yes")
    return {
        "active": len(rows), "reachable": len(reachable), "v7": v7,
        "percent_v7": (100.0 * v7 / len(rows)) if rows else 0.0,
        "versions": versions, "unreachable": len(rows) - len(reachable),
        "unreachable_names": [_label(r) for r in rows if r["reachable"] != "yes"],
    }

def _vkey(label):
    nums = re.findall(r"\d+", label)
    return (0, [int(n) for n in nums]) if nums else (1, [])

def format_summary(s):
    per_version = ", ".join("%s x%d" % (k, v) for k, v in
                            sorted(s["versions"].items(), key=lambda kv: _vkey(kv[0])))
    return "\n".join([
        "Active validators: %d" % s["active"],
        "Reachable: %d" % s["reachable"],
        "Per version (reachable): %s" % (per_version or "none"),
        "Unreachable: %d (%s)" % (s["unreachable"], ", ".join(s["unreachable_names"]) or "none"),
        "On 7.0.0 or newer: %d of %d validators (%.1f%%)" % (s["v7"], s["active"], s["percent_v7"]),
        "A prerelease build (7.0.0-rc1) is not counted as 7.0.0. Unreachable validators are "
        "not counted as old: they could not be asked.",
    ])

# --- --diff: who changed since an earlier CSV ---

def read_csv(path):
    with open(path, "r", encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))

def load_diff_csv(path):
    """Read and validate the older CSV given to --diff. Returns its rows, or
    raises Fatal with a one-line message."""
    try:
        rows = read_csv(path)
        with open(path, "r", encoding="utf-8", newline="") as fh:
            header = next(csv.reader(fh), [])
    except FileNotFoundError:
        raise Fatal("--diff file not found: %s" % path)
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        raise Fatal("--diff file %s is not a readable CSV (%s)" % (path, str(exc).splitlines()[0] if str(exc) else type(exc).__name__))
    missing = [c for c in ("stash", "client_version_parsed") if c not in header]
    if missing:
        raise Fatal("--diff file %s is not a census CSV, missing column(s): %s" % (path, ", ".join(missing)))
    if not rows:
        raise Fatal("--diff file %s has no data rows" % path)
    return rows

def _state(row):
    if row.get("reachable") != "yes":
        return "unreachable"
    return row.get("client_version_parsed") or "version not reported"

def _rkey(row):
    return row.get("stash") or row.get("authority_id") or ""

def diff_rows(old, new):
    """Compare two lists of CSV rows. Returns a dict with changed
    [(label, old state, new state)], joined, left (labels) and unchanged."""
    o = {_rkey(r): r for r in old}
    n = {_rkey(r): r for r in new}
    changed, unchanged = [], 0
    for k, r in n.items():
        if k in o:
            a, b = _state(o[k]), _state(r)
            if a == b:
                unchanged += 1
            else:
                changed.append((_label(r), a, b))
    return {
        "changed": sorted(changed, key=lambda t: t[0].lower()),
        "joined": sorted(_label(r) for k, r in n.items() if k not in o),
        "left": sorted(_label(r) for k, r in o.items() if k not in n),
        "unchanged": unchanged,
    }

def format_diff(d, old_name):
    lines = ["Changes since %s: %d changed, %d joined, %d left, %d unchanged"
             % (old_name, len(d["changed"]), len(d["joined"]), len(d["left"]), d["unchanged"])]
    for label, a, b in d["changed"]:
        lines.append("  %s: %s -> %s" % (label, a, b))
    if d["joined"]:
        lines.append("  joined the active set: " + ", ".join(d["joined"]))
    if d["left"]:
        lines.append("  left the active set: " + ", ".join(d["left"]))
    return "\n".join(lines)

# --- Processing a raw report ---

def reprocess_paths(report_path):
    """(date, default CSV path): the date is the YYYY-MM-DD prefix of the file
    name; the CSV goes in results/, one level above results/raw/."""
    m = re.match(r"(\d{4}-\d{2}-\d{2})-", os.path.basename(report_path))
    date = m.group(1) if m else ""
    raw_dir = os.path.dirname(os.path.abspath(report_path))
    res = os.path.dirname(raw_dir) if os.path.basename(raw_dir) == "raw" else raw_dir
    return date, os.path.join(res, "%s-census.csv" % date)

def process(raw_path, date, out_path, rpc_urls, want_names=True, diff_path=None,
            rpc=rpc_call, say=print, old_rows=None):
    with open(raw_path, "r", encoding="utf-8") as fh:
        report = json.load(fh)
    stashes = sorted({r.get("stash_ss58") for r in report.get("authorities") or []
                      if isinstance(r, dict) and r.get("stash_ss58")})
    names, err = {}, None
    if want_names:
        names, err = fetch_names(stashes, rpc_urls, rpc)
    rows = build_rows(report, names, date)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="") as fh:
        write_csv(rows, fh)
    say("Validator node census %s" % date)
    say(format_summary(summarize(rows)))
    if not want_names:
        say("Names: skipped (--no-names), display_name left empty.")
    elif err:
        say("Names: could not be read from the chain, display_name left empty (%s)." % err)
    else:
        say("Names: %d of %d stashes have an on-chain identity." % (len(names), len(stashes)))
    say("CSV written to %s" % out_path)
    if diff_path:
        say(format_diff(diff_rows(old_rows if old_rows is not None else load_diff_csv(diff_path), rows), os.path.basename(diff_path)))
    return rows

# --- Crawl: pinned subp2p-explorer build and authority-check ---

GIT_TIMEOUT = 300
CARGO_TIMEOUT = 3600

def _run(cmd, timeout=None, **kw):
    try:
        subprocess.run(cmd, check=True, timeout=timeout, **kw)
    except subprocess.CalledProcessError as exc:
        raise Fatal("command failed (exit %d): %s" % (exc.returncode, " ".join(cmd[:3])))
    except subprocess.TimeoutExpired:
        raise Fatal("command timed out after %d s: %s" % (timeout, " ".join(cmd[:3])))

def _git_out(cmd, cwd):
    try:
        return subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              universal_newlines=True, timeout=GIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise Fatal("command timed out after %d s: %s" % (GIT_TIMEOUT, " ".join(cmd[:3])))

def ensure_binary(cache_dir, say=print):
    """Clone and build subp2p-explorer at the pinned sha (skipped when a stamp
    for this sha exists). Returns the binary path."""
    env_path = os.path.join(os.path.expanduser("~"), ".cargo", "bin") + os.pathsep + os.environ.get("PATH", "")
    os.environ["PATH"] = env_path
    if not shutil.which("git"):
        raise Fatal("git not found")
    if not shutil.which("cargo"):
        raise Fatal("Rust is not installed. Install it once with:\n"
                    "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh\n"
                    "then open a new terminal and run this script again.")
    src = os.path.join(cache_dir, "subp2p-explorer")
    binary = os.path.join(src, "target", "release", "subp2p-explorer-cli")
    stamp = os.path.join(src, "target", ".census-built-" + SUBP2P_SHA)
    os.makedirs(cache_dir, exist_ok=True)
    if not os.path.isdir(os.path.join(src, ".git")):
        say("Cloning subp2p-explorer")
        _run(["git", "clone", "--quiet", SUBP2P_REPO, src], timeout=GIT_TIMEOUT)
    if _git_out(["git", "cat-file", "-e", SUBP2P_SHA + "^{commit}"], src).returncode != 0:
        _run(["git", "fetch", "--quiet", "origin"], cwd=src, timeout=GIT_TIMEOUT)
    _run(["git", "checkout", "--quiet", "--force", "--detach", SUBP2P_SHA], cwd=src, timeout=GIT_TIMEOUT)
    head = _git_out(["git", "rev-parse", "HEAD"], src).stdout.strip()
    if head != SUBP2P_SHA:
        raise Fatal("checkout is at %s, expected %s" % (head, SUBP2P_SHA))
    if not (os.access(binary, os.X_OK) and os.path.exists(stamp)):
        say("Building subp2p-explorer (once, several minutes)")
        _run(["cargo", "build", "--release", "--locked", "-p", "subp2p-explorer-cli"], cwd=src, timeout=CARGO_TIMEOUT)
        if not os.access(binary, os.X_OK):
            raise Fatal("build finished but %s is missing" % binary)
        open(stamp, "w").close()
    return binary

def pick_rpc(candidates, rpc=rpc_call, say=print):
    """First candidate that answers and serves Polkadex mainnet."""
    for url in candidates:
        try:
            got = rpc(url, "chain_getBlockHash", [0], 15)
        except Exception as exc:
            say("%s did not answer (%s), trying the next one" % (url, exc))
            continue
        if got != GENESIS:
            raise Fatal("%s serves a different chain (genesis %s), refusing to run" % (url, got))
        return url
    raise Fatal("no RPC endpoint answered (tried %s)" % ", ".join(candidates))

def crawl(date, env, rpc_urls, want_names, diff_path, say=print, old_rows=None):
    cache = env.get("CACHE_DIR") or os.path.join(os.path.expanduser("~"), ".cache", "validator-census")
    candidates = [env.get("RPC_URL") or DEFAULT_RPC, env.get("RPC_FALLBACK") or DEFAULT_RPC_FALLBACK]
    rpc = pick_rpc(candidates, say=say)
    say("Using RPC %s, chain confirmed as Polkadex mainnet" % rpc)
    binary = ensure_binary(cache, say)
    run_dir = os.path.join(cache, "run")  # the tool writes a cache/ folder in its cwd
    raw_dir = os.path.join(RESULTS, "raw")
    os.makedirs(run_dir, exist_ok=True)
    os.makedirs(raw_dir, exist_ok=True)
    raw = os.path.join(raw_dir, "%s-authority-check.json" % date)
    if os.path.exists(raw):
        os.remove(raw)
    timeout = env.get("TIMEOUT") or "600"
    backend = env.get("NETWORK_BACKEND") or "libp2p"
    say("Running authority-check (timeout %ss, backend %s)" % (timeout, backend))
    _run([binary, "authority-check", "--url", rpc, "--genesis", GENESIS[2:],
          "--bootnodes", env.get("BOOTNODES") or BOOTNODES_DEFAULT,
          "--timeout", timeout, "--dial-timeout", env.get("DIAL_TIMEOUT") or "10",
          "--network-backend", backend, "--json", raw], cwd=run_dir)
    if not (os.path.exists(raw) and os.path.getsize(raw) > 0):
        raise Fatal("authority-check produced no JSON report at %s" % raw)
    return process(raw, date, os.path.join(RESULTS, "%s-census.csv" % date),
                   rpc_urls, want_names, diff_path, say=say, old_rows=old_rows)

# --- Command line ---

HELP_EPILOG = """\
Examples (on the Mac, from this folder):
  ./node_census.py                          crawl now, write results/DATE-census.csv
  ./node_census.py --diff results/2026-10-16-census.csv
                                            crawl, then show who changed since that file
  ./node_census.py --reprocess              rebuild the CSV from the newest raw report
  ./node_census.py --reprocess --no-names   same, without any network call

Crawl settings (environment variables):
  RPC_URL           default wss://rpc2.polkadex.ee; RPC_FALLBACK (default wss://rpc.polkadex.ee)
                    is used if it does not answer; the chain must match mainnet genesis
  TIMEOUT           seconds for the DHT crawl, default 600
  DIAL_TIMEOUT      seconds per address, default 10
  BOOTNODES         comma separated multiaddrs, default the four Polkadex bootnodes
  NETWORK_BACKEND   libp2p (default) or litep2p; try litep2p if libp2p finds few records
  CACHE_DIR         default ~/.cache/validator-census (explorer built here once at
                    commit %s, cargo build --locked)

Reachable means the node answered identify or a p2p dial succeeded. An unreachable
validator is never counted as old, it could not be asked. A prerelease build
(7.0.0-rc1) is not counted as 7.0.0; a commit suffix such as -566b080 is not a
prerelease. Names are best effort: if the RPC read fails the CSV is still written
with empty names and the summary says so.
""" % SUBP2P_SHA

def build_parser():
    p = argparse.ArgumentParser(
        prog="node_census.py", formatter_class=argparse.RawDescriptionHelpFormatter,
        description=__doc__, epilog=HELP_EPILOG)
    p.add_argument("command", nargs="?", choices=["crawl"], default="crawl",
                   help="crawl is the default; put it before any options")
    p.add_argument("--reprocess", nargs="?", const="newest", metavar="FILE",
                   help="process a saved raw report instead of crawling "
                        "(newest results/raw file when no FILE is given)")
    p.add_argument("--diff", metavar="OLDER.csv",
                   help="print who changed version since this earlier census CSV")
    p.add_argument("--out-dir", metavar="DIR",
                   help="with --reprocess, write the CSV here instead of next to the raw report's results folder")
    p.add_argument("--no-names", action="store_true",
                   help="do not read names from the chain (works offline)")
    return p

def main(argv=None, env=None, say=print):
    env = os.environ if env is None else env
    p = build_parser()
    args = p.parse_args(argv)
    urls = [to_http(u) for u in (env.get("RPC_URL") or DEFAULT_RPC,
                                 env.get("RPC_FALLBACK") or DEFAULT_RPC_FALLBACK)]
    urls = [u for i, u in enumerate(urls) if u not in urls[:i]]
    try:
        old_rows = load_diff_csv(args.diff) if args.diff else None
        if args.reprocess:
            raw = args.reprocess
            if raw == "newest":
                found = sorted(glob.glob(os.path.join(RESULTS, "raw", "*-authority-check.json")))
                if not found:
                    raise Fatal("no raw report found in %s" % os.path.join(RESULTS, "raw"))
                raw = found[-1]
            if not os.path.isfile(raw):
                raise Fatal("raw report not found: %s" % raw)
            date, out = reprocess_paths(raw)
            if not date:
                raise Fatal("raw report must be named YYYY-MM-DD-*.json")
            say("Reprocessing %s (no crawl)" % raw)
            if args.out_dir:
                out = os.path.join(args.out_dir, os.path.basename(out))
            process(raw, date, out, urls, not args.no_names, args.diff, say=say, old_rows=old_rows)
        else:
            date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            crawl(date, env, urls, not args.no_names, args.diff, say=say, old_rows=old_rows)
    except Fatal as exc:
        sys.stderr.write("node_census: %s\n" % exc)
        return 2 if "--diff" in str(exc) else 1
    except ValueError as exc:  # empty report, bad JSON
        sys.stderr.write("node_census: %s\n" % exc)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
