import csv
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

import node_census as nc

FIXTURE = os.path.join(HERE, "fixtures", "2026-10-16-authority-check.json")
OLD_CSV = os.path.join(HERE, "..", "results", "2026-10-16-census.csv")
ALICE_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
ALICE_PUB = bytes.fromhex("d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d")
GENESIS = nc.GENESIS


def addr(status="Ok", dial=None):
    a = {"address_short": "1.2.3.4:30333", "is_public": True, "result": {"status": status}}
    if status != "Ok":
        a["result"]["reason"] = "connection refused"
    if dial is not None:
        a["dial_outcome"] = dial
    return a


def auth(ss58, stash=None, name=None, peer=None, agent=None, dht=True, addresses=None):
    r = {"authority_ss58": ss58, "identity_name": name, "peer_id": peer,
         "agent_version": agent, "has_dht_record": dht,
         "addresses": addresses if addresses is not None else []}
    if stash:
        r["stash_ss58"] = stash
    return r


# ---- helpers to build chain values the way SCALE lays them out -------------

def raw_data(text):
    b = text.encode("utf-8")
    return bytes([len(b) + 1]) + b


def identity_value(display, judgements=b"\x00", additional=b"\x00", deposit=0):
    """Registration: judgements, deposit u128, info.additional, info.display,
    then the remaining Data fields (none) so the value looks like the real one."""
    rest = b"\x00" * 6 + b"\x00" + b"\x00" * 2  # legal web riot email, pgp Option, image twitter
    return judgements + deposit.to_bytes(16, "little") + additional + display + rest


def ss58_encode(pub, prefix=88):
    import hashlib
    # prefixes of 64 and above use the two-byte form (88 does, hence 49 character addresses)
    body = bytes([((prefix & 0xFC) >> 2) | 0x40, (prefix >> 8) | ((prefix & 3) << 6)]) + pub
    chk = hashlib.blake2b(b"SS58PRE" + body, digest_size=64).digest()[:2]
    num = int.from_bytes(body + chk, "big")
    out = ""
    while num:
        num, r = divmod(num, 58)
        out = nc._B58[r] + out
    return out


class FakeChain(object):
    """Mock JSON-RPC: storage maps hex key -> bytes, plus a genesis hash."""

    def __init__(self, storage, genesis=GENESIS, fail=None):
        self.storage = storage
        self.genesis = genesis
        self.fail = fail
        self.calls = []

    def __call__(self, url, method, params, timeout=30):
        self.calls.append((url, method))
        if self.fail:
            raise self.fail
        if method == "chain_getBlockHash":
            return self.genesis
        if method == "state_queryStorageAt":
            changes = []
            for k in params[0]:
                v = self.storage.get(k)
                changes.append([k, ("0x" + v.hex()) if v is not None else None])
            return [{"block": "0x00", "changes": changes}]
        raise AssertionError(method)


# ---- hashing and keys ------------------------------------------------------

class HashTests(unittest.TestCase):
    def test_xxh64_reference_vectors(self):
        self.assertEqual(nc.xxh64(b""), 0xEF46DB3751D8E999)
        self.assertEqual(nc.xxh64(b"a"), 0xD24EC4F1A98C6E5B)
        self.assertEqual(nc.xxh64(b"abc"), 0x44BC2CF5AD770999)

    def test_xxh64_long_input_path(self):
        # 39 bytes: exercises the 32-byte stripe loop (reference from the xxHash docs)
        self.assertEqual(nc.xxh64(b"Nobody inspects the spammish repetition"), 0xFBCEA83C8A378BF1)

    def test_twox128_matches_substrate_system_account_prefix(self):
        self.assertEqual(nc.twox128(b"System").hex(), "26aa394eea5630e07c48ae0c9558cef7")
        self.assertEqual(nc.twox128(b"Account").hex(), "b99d880ec681799c0cf30e8886371da9")

    def test_twox64_is_first_half_of_twox128(self):
        self.assertEqual(nc.twox64(b"System"), nc.twox128(b"System")[:8])

    def test_blake2_128_concat_known_alice_key_part(self):
        self.assertEqual(nc.blake2_128(ALICE_PUB).hex(), "de1e86a9a8c739864cf3cc5ec2bea59f")


class Ss58Tests(unittest.TestCase):
    def test_alice(self):
        self.assertEqual(nc.ss58_decode(ALICE_SS58), ALICE_PUB)

    def test_polkadex_prefix_roundtrip(self):
        real = "esoia6ocj8jC4Wq2mSeiCsXf1Z3eHqx7oHQ8hK8iPgHUYAmeC"
        self.assertEqual(ss58_encode(nc.ss58_decode(real)), real)
        self.assertEqual(nc.ss58_decode(ss58_encode(ALICE_PUB)), ALICE_PUB)

    def test_bad_checksum_and_chars_rejected(self):
        with self.assertRaises(ValueError):
            nc.ss58_decode(ALICE_SS58[:-1] + ("A" if ALICE_SS58[-1] != "A" else "B"))
        with self.assertRaises(ValueError):
            nc.ss58_decode("0OIl")
        with self.assertRaises(ValueError):
            nc.ss58_decode("abc")

    def test_every_stash_in_the_real_report_decodes(self):
        with open(FIXTURE) as fh:
            stashes = [a["stash_ss58"] for a in json.load(fh)["authorities"]]
        self.assertEqual(len(stashes), 200)
        for s in stashes:
            self.assertEqual(len(nc.ss58_decode(s)), 32)


class StorageKeyTests(unittest.TestCase):
    def test_identity_of_key_layout_twox64_concat(self):
        k = nc.identity_of_key(ALICE_PUB)
        self.assertEqual(len(k), 16 + 16 + 8 + 32)
        self.assertEqual(k[:16], nc.twox128(b"Identity"))
        self.assertEqual(k[16:32], nc.twox128(b"IdentityOf"))
        self.assertEqual(k[32:40], nc.twox64(ALICE_PUB))
        self.assertEqual(k[40:], ALICE_PUB)

    def test_super_of_key_layout_blake2_128_concat(self):
        k = nc.super_of_key(ALICE_PUB)
        self.assertEqual(len(k), 16 + 16 + 16 + 32)
        self.assertEqual(k[16:32], nc.twox128(b"SuperOf"))
        self.assertEqual(k[32:48].hex(), "de1e86a9a8c739864cf3cc5ec2bea59f")
        self.assertEqual(k[48:], ALICE_PUB)

    def test_known_stash_key_regression_pin(self):
        # Pins the key for the first stash in the 2026-10-16 report so a later
        # edit to the hashers cannot change keys unnoticed. Computed by this
        # module (the hashers above are checked against Substrate vectors).
        pub = nc.ss58_decode("esoia6ocj8jC4Wq2mSeiCsXf1Z3eHqx7oHQ8hK8iPgHUYAmeC")
        self.assertEqual(
            nc.identity_of_key(pub).hex(),
            "2aeddc77fe58c98d50bd37f1b90840f9cd7f37317cd20b61e9bd46fab8704714"
            "d8281abb722f7da8828daa0ccf4ecb2b48670d36e3c598668ccc13521c8c5c12"
            "bca8590e06310954")


# ---- identity decode -------------------------------------------------------

class IdentityDecodeTests(unittest.TestCase):
    def test_simple_display(self):
        self.assertEqual(nc.decode_identity_display(identity_value(raw_data("Alice"))), "Alice")

    def test_name_with_space_and_unicode(self):
        self.assertEqual(
            nc.decode_identity_display(identity_value(raw_data("Outlier Ventures"))),
            "Outlier Ventures")
        self.assertEqual(nc.decode_identity_display(identity_value(raw_data("Zoë"))), "Zoë")

    def test_with_judgements_including_fee_paid(self):
        judg = b"\x08" + (1).to_bytes(4, "little") + b"\x02" + \
            (2).to_bytes(4, "little") + b"\x01" + (5).to_bytes(16, "little")
        self.assertEqual(
            nc.decode_identity_display(identity_value(raw_data("Bob"), judgements=judg)), "Bob")

    def test_with_additional_fields(self):
        add = b"\x04" + raw_data("k") + raw_data("v")
        self.assertEqual(
            nc.decode_identity_display(identity_value(raw_data("Carol"), additional=add)), "Carol")

    def test_none_display_is_empty(self):
        self.assertEqual(nc.decode_identity_display(identity_value(b"\x00")), "")

    def test_hash_variant_is_empty(self):
        self.assertEqual(nc.decode_identity_display(identity_value(b"\x22" + b"\x11" * 32)), "")

    def test_non_utf8_and_control_bytes_give_empty(self):
        self.assertEqual(nc.decode_identity_display(identity_value(b"\x03\xff\xfe")), "")
        self.assertEqual(nc.decode_identity_display(identity_value(raw_data("a\x00b"))), "")

    def test_truncated_or_garbage_never_raises(self):
        for bad in (b"", b"\x04", b"\x00" + b"\x00" * 5, b"\x0c" + b"\xff" * 3):
            self.assertEqual(nc.decode_identity_display(bad), "")

    def test_super_of(self):
        parent = b"\x07" * 32
        self.assertEqual(nc.decode_super_of(parent + raw_data("sub1")), (parent, "sub1"))
        self.assertIsNone(nc.decode_super_of(b"\x01\x02"))
        self.assertIsNone(nc.decode_super_of(parent + b"\x05ab"))

    def test_compact_modes(self):
        self.assertEqual(nc._compact(b"\x04", 0), (1, 1))
        self.assertEqual(nc._compact(b"\xb5\x01", 0), (109, 2))  # 0x01b5 >> 2
        self.assertEqual(nc._compact(b"\x02\x00\x01\x00", 0), (16384 + 0, 4))


# ---- names over RPC (mocked; no network in tests) --------------------------

def make_chain(entries):
    """entries: list of (pub, identity display or None, super (parent pub, sub) or None)"""
    storage = {}
    for pub, display, sup in entries:
        if display is not None:
            storage["0x" + nc.identity_of_key(pub).hex()] = identity_value(raw_data(display))
        if sup is not None:
            storage["0x" + nc.super_of_key(pub).hex()] = sup[0] + raw_data(sup[1])
    return storage


class NamesTests(unittest.TestCase):
    def setUp(self):
        self.p1, self.p2, self.p3, self.p4 = (bytes([i]) * 32 for i in (1, 2, 3, 4))
        self.s = [ss58_encode(p) for p in (self.p1, self.p2, self.p3, self.p4)]

    def test_own_identity_and_parent_slash_sub(self):
        chain = FakeChain(make_chain([
            (self.p1, "PARENT", None),
            (self.p2, None, (self.p1, "sub")),
            (self.p3, None, None),
        ]))
        names, err = nc.fetch_names(self.s[:3], ["https://a"], chain)
        self.assertIsNone(err)
        self.assertEqual(names, {self.s[0]: "PARENT", self.s[1]: "PARENT/sub"})

    def test_own_identity_beats_super(self):
        chain = FakeChain(make_chain([
            (self.p1, "P", None), (self.p2, "Own", (self.p1, "sub"))]))
        names, _ = nc.fetch_names(self.s[:2], ["https://a"], chain)
        self.assertEqual(names[self.s[1]], "Own")

    def test_sub_whose_parent_has_no_identity_uses_sub_name(self):
        chain = FakeChain(make_chain([(self.p2, None, (self.p1, "sub"))]))
        names, _ = nc.fetch_names([self.s[1]], ["https://a"], chain)
        self.assertEqual(names, {self.s[1]: "sub"})

    def test_batches_large_sets(self):
        pubs = [bytes([i % 250 + 1, i // 250]) + b"\x09" * 30 for i in range(120)]
        chain = FakeChain(make_chain([(p, "n", None) for p in pubs]))
        names, err = nc.fetch_names([ss58_encode(p) for p in pubs], ["https://a"], chain)
        self.assertIsNone(err)
        self.assertEqual(len(names), 120)
        self.assertGreaterEqual(len([c for c in chain.calls if c[1] == "state_queryStorageAt"]), 3)

    def test_rpc_failure_returns_empty_and_message(self):
        chain = FakeChain({}, fail=OSError("no route"))
        names, err = nc.fetch_names(self.s, ["https://a", "https://b"], chain)
        self.assertEqual(names, {})
        self.assertIn("https://a", err)
        self.assertIn("https://b", err)
        self.assertIn("no route", err)

    def test_falls_back_to_second_url(self):
        good = FakeChain(make_chain([(self.p1, "OK", None)]))

        def rpc(url, method, params, timeout=30):
            if url == "https://a":
                raise OSError("down")
            return good(url, method, params, timeout)

        names, err = nc.fetch_names([self.s[0]], ["https://a", "https://b"], rpc)
        self.assertIsNone(err)
        self.assertEqual(names, {self.s[0]: "OK"})

    def test_wrong_chain_is_rejected(self):
        chain = FakeChain(make_chain([(self.p1, "OK", None)]), genesis="0x" + "00" * 32)
        names, err = nc.fetch_names([self.s[0]], ["https://a"], chain)
        self.assertEqual(names, {})
        self.assertIn("different chain", err)

    def test_no_urls(self):
        self.assertEqual(nc.fetch_names(self.s, [], FakeChain({})), ({}, "no RPC URL given"))

    def test_bad_stash_is_skipped_not_fatal(self):
        chain = FakeChain(make_chain([(self.p1, "OK", None)]))
        names, err = nc.fetch_names(["notanaddress", self.s[0]], ["https://a"], chain)
        self.assertIsNone(err)
        self.assertEqual(names, {self.s[0]: "OK"})

    def test_garbled_html_response_is_an_error(self):
        def rpc(url, method, params, timeout=30):
            raise ValueError("not JSON (a load balancer error page?)")
        names, err = nc.fetch_names(self.s, ["https://a"], rpc)
        self.assertEqual(names, {})
        self.assertIn("not JSON", err)

    def test_to_http(self):
        self.assertEqual(nc.to_http("wss://rpc2.polkadex.ee"), "https://rpc2.polkadex.ee")
        self.assertEqual(nc.to_http("ws://h:9944"), "http://h:9944")
        self.assertEqual(nc.to_http("https://h"), "https://h")


class PickRpcTests(unittest.TestCase):
    def test_first_answering_mainnet(self):
        seen = []
        chain = FakeChain({})
        self.assertEqual(nc.pick_rpc(["wss://a", "wss://b"], chain, say=seen.append), "wss://a")

    def test_skips_dead_then_uses_next(self):
        def rpc(url, method, params, timeout=30):
            if url == "wss://a":
                raise OSError("down")
            return GENESIS
        self.assertEqual(nc.pick_rpc(["wss://a", "wss://b"], rpc, say=lambda m: None), "wss://b")

    def test_refuses_other_chain(self):
        with self.assertRaises(nc.Fatal):
            nc.pick_rpc(["wss://a"], lambda *a, **k: "0x" + "11" * 32, say=lambda m: None)

    def test_none_answer(self):
        def rpc(*a, **k):
            raise OSError("down")
        with self.assertRaises(nc.Fatal):
            nc.pick_rpc(["wss://a"], rpc, say=lambda m: None)


# ---- version parsing -------------------------------------------------------

class ParseVersionTests(unittest.TestCase):
    def test_polkadex_with_commit_and_node_name(self):
        self.assertEqual(nc.parse_version("Polkadex/v7.0.0-566b080 (rpc2)"), (7, 0, 0))

    def test_old_name_style(self):
        self.assertEqual(nc.parse_version("polkadex-node/v6.2.0-abc"), (6, 2, 0))

    def test_litep2p_suffix(self):
        self.assertEqual(nc.parse_version("Polkadex/v7.0.0-566b080 (val1) (litep2p)"), (7, 0, 0))

    def test_other_product_is_not_parsed(self):
        self.assertIsNone(nc.parse_version("Parity Polkadot/v1.21.1-c6ba84fb493 (mynode) (litep2p)"))

    def test_anchored_to_polkadex_prefix(self):
        self.assertEqual(nc.parse_version("foo (libp2p/v7.1.0) Polkadex/v6.0.0"), (6, 0, 0))

    def test_prefix_is_case_insensitive(self):
        self.assertEqual(nc.parse_version("POLKADEX-NODE/V7.0.0-abc"), (7, 0, 0))

    def test_big_numbers_and_no_suffix(self):
        self.assertEqual(nc.parse_version("Polkadex/v12.34.56-abc (n)"), (12, 34, 56))
        self.assertEqual(nc.parse_version("Polkadex/v7.0.0"), (7, 0, 0))

    def test_prerelease_numeric_part_still_parses(self):
        self.assertEqual(nc.parse_version("Polkadex/v7.1.0-rc1"), (7, 1, 0))

    def test_prerelease_detected(self):
        for a in ("Polkadex/v7.0.0-rc1", "Polkadex/v7.0.0-RC.2 (n)", "Polkadex/v7.0.0-alpha",
                  "Polkadex/v7.0.0-beta.1-566b080", "Polkadex/v7.0.0-dev", "Polkadex/v7.0.0-nightly"):
            self.assertTrue(nc.is_prerelease(a), a)

    def test_commit_suffix_is_not_prerelease(self):
        for a in ("Polkadex/v7.0.0-566b080 (rpc2)", "Polkadex/v7.0.0",
                  "polkadex-node/v6.2.0-abc", "Polkadex/v7.0.0-x"):
            self.assertFalse(nc.is_prerelease(a), a)

    def test_prerelease_of_other_product_or_missing(self):
        self.assertFalse(nc.is_prerelease(None))
        self.assertFalse(nc.is_prerelease("Parity Polkadot/v1.0.0-rc1"))

    def test_missing_and_unparseable_agent(self):
        for a in (None, "", "   ", "subp2p-agent", "polkadex-node/vNEXT"):
            self.assertIsNone(nc.parse_version(a))

    def test_two_digit_major_compares_numerically(self):
        self.assertTrue(nc.is_v7(nc.parse_version("Polkadex/v10.0.0")))

    def test_format_version(self):
        self.assertEqual(nc.format_version((7, 0, 0)), "7.0.0")
        self.assertEqual(nc.format_version(None), "")


class IsV7Tests(unittest.TestCase):
    def test_values(self):
        self.assertTrue(nc.is_v7((7, 0, 0)))
        self.assertTrue(nc.is_v7((7, 0, 1)))
        self.assertFalse(nc.is_v7((6, 99, 99)))
        self.assertIsNone(nc.is_v7(None))


class ReachableTests(unittest.TestCase):
    def test_agent_means_reachable(self):
        self.assertTrue(nc.is_reachable(auth("a", agent="Polkadex/v7.0.0-x")))

    def test_dial_success_means_reachable(self):
        self.assertTrue(nc.is_reachable(auth("a", addresses=[addr("Failed", {"status": "Success"})])))

    def test_tcp_ok_alone_is_not_reachable(self):
        self.assertFalse(nc.is_reachable(auth("a", addresses=[addr("Ok")])))

    def test_tcp_ok_with_failed_dial_is_not_reachable(self):
        r = auth("a", addresses=[addr("Ok", {"status": "Failed", "reason": "noise"})])
        self.assertFalse(nc.is_reachable(r))

    def test_all_failed_no_dht_skipped_empty_agent(self):
        self.assertFalse(nc.is_reachable(auth("a", addresses=[addr("Failed", {"status": "Failed"})])))
        self.assertFalse(nc.is_reachable(auth("a", dht=False)))
        self.assertFalse(nc.is_reachable(auth("a", addresses=[addr("Skipped", {"status": "Skipped"})])))
        self.assertFalse(nc.is_reachable(auth("a", agent="")))


class PrereleaseRowTests(unittest.TestCase):
    def test_prerelease_is_not_counted_as_seven(self):
        row = nc.build_row(auth("a", agent="Polkadex/v7.0.0-rc1 (n)"), {}, "d")
        self.assertEqual(row["client_version_parsed"], "prerelease")
        self.assertEqual(row["is_v7"], "no")
        self.assertEqual(row["reachable"], "yes")

    def test_commit_suffix_still_counts(self):
        row = nc.build_row(auth("a", agent="Polkadex/v7.0.0-566b080 (n)"), {}, "d")
        self.assertEqual((row["client_version_parsed"], row["is_v7"]), ("7.0.0", "yes"))

    def test_summary_separates_prerelease(self):
        rep = {"authorities": [
            auth("a1", stash="s1", name="Pre", agent="Polkadex/v7.0.0-rc1"),
            auth("a2", stash="s2", name="Ok7", agent="Polkadex/v7.0.0-abc"),
            auth("a3", stash="s3", name="Old", agent="Polkadex/v6.0.0"),
        ]}
        s = nc.summarize(nc.build_rows(rep, {"s1": "Pre"}, "d"))
        self.assertEqual(s["v7"], 1)
        self.assertEqual(s["versions"], {"prerelease": 1, "7.0.0": 1, "6.0.0": 1})
        self.assertIn("prerelease x1", nc.format_summary(s))


class CleanTests(unittest.TestCase):
    def test_ids_are_cleaned(self):
        row = nc.build_row(auth("=AUTH\n", stash="+STASH\x00", peer="@peer\r"), {}, "d")
        self.assertEqual(row["stash"], "'+STASH")
        self.assertEqual(row["authority_id"], "'=AUTH")
        self.assertEqual(row["peer_id"], "'@peer")

    def test_normal_ids_unchanged(self):
        row = nc.build_row(auth("5AUTH", stash="5STASH", peer="12D3KooWx"), {}, "d")
        self.assertEqual((row["stash"], row["authority_id"], row["peer_id"]),
                         ("5STASH", "5AUTH", "12D3KooWx"))

    def test_formula_injection_in_chain_name_is_neutralised(self):
        for bad in ("=HYPERLINK(1)", "+1", "-1", "@x"):
            row = nc.build_row(auth("a", stash="S"), {"S": bad}, "d")
            self.assertTrue(row["display_name"].startswith("'"), bad)

    def test_controls_stripped_from_name(self):
        row = nc.build_row(auth("a", stash="S"), {"S": "Bob\nEvil\r\x00"}, "d")
        self.assertEqual(row["display_name"], "BobEvil")

    def test_explorer_identity_name_in_report_is_ignored(self):
        row = nc.build_row(auth("a", stash="S", name="From Explorer"), {}, "d")
        self.assertEqual(row["display_name"], "")


class DedupeTests(unittest.TestCase):
    def rows(self, auths):
        return nc.build_rows({"authorities": auths}, {}, "d")

    def test_two_entries_one_stash_become_one_row(self):
        rows = self.rows([auth("5A1", stash="5S", peer="p1", dht=False),
                          auth("5A2", stash="5S", peer="p2", agent="Polkadex/v7.0.0-abc")])
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["reachable"], rows[0]["is_v7"], rows[0]["peer_id"]),
                         ("yes", "yes", "p2"))

    def test_highest_version_wins_regardless_of_order(self):
        a = auth("5A1", stash="5S", agent="Polkadex/v6.2.0-abc")
        b = auth("5A2", stash="5S", agent="Polkadex/v7.0.0-abc")
        for order in ([a, b], [b, a]):
            self.assertEqual(self.rows(order)[0]["client_version_parsed"], "7.0.0")

    def test_release_beats_prerelease_of_same_version(self):
        a = auth("5A1", stash="5S", agent="Polkadex/v7.0.0-rc1")
        b = auth("5A2", stash="5S", agent="Polkadex/v7.0.0-abc")
        for order in ([a, b], [b, a]):
            self.assertEqual(self.rows(order)[0]["client_version_parsed"], "7.0.0")

    def test_reachable_beats_unreachable(self):
        rows = self.rows([auth("5A1", stash="5S", dht=False),
                          auth("5A2", stash="5S", addresses=[addr("Ok", {"status": "Success"})])])
        self.assertEqual((len(rows), rows[0]["reachable"]), (1, "yes"))

    def test_no_stash_falls_back_to_authority_id(self):
        rows = self.rows([auth("5A1", agent="Polkadex/v6.0.0"), auth("5A1", agent="Polkadex/v7.0.0"),
                          auth("5A2", agent="Polkadex/v6.0.0")])
        self.assertEqual(len(rows), 2)

    def test_distinct_stashes_not_merged_and_order_kept(self):
        rows = self.rows([auth("5A1", stash="5S1"), auth("5A2", stash="5S2"), auth("5A3", stash="5S1")])
        self.assertEqual([r["stash"] for r in rows], ["5S1", "5S2"])
        self.assertEqual(nc.summarize(rows)["active"], 2)

    def test_merge_keeps_node_name(self):
        rows = self.rows([auth("5A1", stash="5S"), auth("5A2", stash="5S", agent=REAL_V6)])
        self.assertEqual(rows[0]["node_name"], "Master Validator/16")


class RowTests(unittest.TestCase):
    def test_columns_and_values(self):
        r = auth("5AUTH", stash="5STASH", peer="12D3KooWx", agent="Polkadex/v7.0.0-566b080 (rpc2)")
        row = nc.build_row(r, {"5STASH": "Alice"}, "2026-10-16")
        self.assertEqual(list(row.keys()), nc.COLUMNS)
        self.assertEqual(row["display_name"], "Alice")
        self.assertEqual(row["node_name"], "rpc2")
        self.assertEqual((row["reachable"], row["client_version_parsed"], row["is_v7"]),
                         ("yes", "7.0.0", "yes"))

    def test_older(self):
        row = nc.build_row(auth("a", agent="polkadex-node/v6.2.0-abc"), {}, "d")
        self.assertEqual((row["is_v7"], row["client_version_parsed"]), ("no", "6.2.0"))

    def test_unreachable_is_not_old(self):
        row = nc.build_row(auth("a", dht=False), {}, "d")
        self.assertEqual((row["reachable"], row["is_v7"], row["client_version_parsed"]),
                         ("no", "unknown", ""))

    def test_reachable_without_agent_is_unknown(self):
        row = nc.build_row(auth("a", addresses=[addr("Ok", {"status": "Success"})]), {}, "d")
        self.assertEqual((row["reachable"], row["is_v7"]), ("yes", "unknown"))


REAL_V6 = "Polkadex Node/v6.2.0-c6855f1d3d2 (Master Validator/16)"
REAL_V7 = "Polkadex Node/v7.0.0-57440d693fd (Faraday/18) (litep2p)"


class RealAgentStringTests(unittest.TestCase):
    def test_product_name_with_space(self):
        self.assertEqual(nc.parse_version(REAL_V6), (6, 2, 0))
        self.assertEqual(nc.parse_version(REAL_V7), (7, 0, 0))

    def test_all_three_product_spellings(self):
        for a in ("Polkadex Node/v7.0.0-abc (n)", "polkadex-node/v7.0.0-abc (n)",
                  "Polkadex/v7.0.0-abc (n)", "POLKADEX NODE/V7.0.0"):
            self.assertEqual(nc.parse_version(a), (7, 0, 0), a)

    def test_commit_hash_is_not_prerelease(self):
        self.assertFalse(nc.is_prerelease(REAL_V6))
        self.assertFalse(nc.is_prerelease(REAL_V7))

    def test_other_products_still_rejected(self):
        self.assertIsNone(nc.parse_version("Parity Polkadot/v1.21.1-c6ba84fb493 (x)"))
        self.assertIsNone(nc.parse_version("Polkadex Nodes/v7.0.0"))


class NodeNameTests(unittest.TestCase):
    def test_names(self):
        self.assertEqual(nc.parse_node_name("Polkadex Node/v6.2.0-c6855f1d3d2 (ETERNITY)"), "ETERNITY")
        self.assertEqual(nc.parse_node_name(REAL_V6), "Master Validator/16")
        self.assertEqual(nc.parse_node_name(REAL_V7), "Faraday/18")
        self.assertEqual(nc.parse_node_name("Polkadex Node/v7.0.0-abc (val1) (libp2p)"), "val1")
        self.assertEqual(nc.parse_node_name("Polkadex Node/v7.0.0-abc (my (old) node)"), "my (old) node")

    def test_missing_or_no_parens(self):
        for a in (None, "", "Polkadex Node/v7.0.0-abc"):
            self.assertEqual(nc.parse_node_name(a), "")

    def test_row_cleans_node_name(self):
        row = nc.build_row(auth("a", agent="Polkadex Node/v7.0.0-abc (=HYPERLINK(1))"), {}, "d")
        self.assertEqual(row["node_name"], "'=HYPERLINK(1)")


def sample_report():
    return {"authorities": [
        auth("5A1", stash="5S1", peer="p1", agent="Polkadex/v7.0.0-566b080 (rpc2)"),
        auth("5A2", stash="5S2", peer="p2", agent="Polkadex/v7.0.0-566b080 (x) (litep2p)"),
        auth("5A3", stash="5S3", peer="p3", agent="polkadex-node/v6.2.0-abc"),
        auth("5A4", stash="5S4", peer="p4", addresses=[addr("Ok", {"status": "Success"})]),
        auth("5A5", stash="5S5", dht=False),
        auth("5A6", stash="5S6", peer="p6", addresses=[addr("Failed", {"status": "Failed"})]),
    ]}


class SummaryTests(unittest.TestCase):
    def setUp(self):
        names = {"5S3": "Old", "5S4": "Silent", "5S5": "Dark", "5S6": "Dead"}
        self.rows = nc.build_rows(sample_report(), names, "2026-10-16")
        self.s = nc.summarize(self.rows)

    def test_counts(self):
        s = self.s
        self.assertEqual((s["active"], s["reachable"], s["v7"], s["unreachable"]), (6, 4, 2, 2))
        self.assertEqual(s["versions"], {"7.0.0": 2, "6.2.0": 1, "not reported": 1})
        self.assertAlmostEqual(s["percent_v7"], 100.0 * 2 / 6)
        self.assertEqual(s["active"], s["reachable"] + s["unreachable"])

    def test_names(self):
        self.assertEqual(sorted(self.s["unreachable_names"]), ["Dark", "Dead"])

    def test_text(self):
        text = nc.format_summary(self.s)
        self.assertIn("Active validators: 6", text)
        self.assertIn("Reachable: 4", text)
        self.assertIn("6.2.0 x1, 7.0.0 x2, not reported x1", text)
        self.assertIn("Unreachable: 2", text)
        self.assertIn("On 7.0.0 or newer: 2 of 6 validators (33.3%)", text)
        self.assertIn("not counted as old", text)

    def test_versions_sort_numerically(self):
        s = nc.summarize(nc.build_rows({"authorities": [
            auth("a", stash="1", agent="Polkadex/v10.0.0"), auth("b", stash="2", agent="Polkadex/v9.0.0")]}, {}, "d"))
        self.assertIn("9.0.0 x1, 10.0.0 x1", nc.format_summary(s))

    def test_label_falls_back_to_node_name_then_authority(self):
        rows = nc.build_rows({"authorities": [auth("5AUTH", dht=False)]}, {}, "d")
        self.assertEqual(nc.summarize(rows)["unreachable_names"], ["5AUTH"])
        rows = nc.build_rows({"authorities": [auth("5A", stash="S", agent=REAL_V6)]}, {}, "d")
        self.assertEqual(nc._label(rows[0]), "Master Validator/16")

    def test_empty_rows_do_not_divide_by_zero(self):
        self.assertEqual(nc.summarize([])["percent_v7"], 0.0)


class CsvTests(unittest.TestCase):
    def test_roundtrip_with_comma_in_name(self):
        rep = {"authorities": [auth("a", stash="s", agent="Polkadex/v7.0.0-x")]}
        rows = nc.build_rows(rep, {"s": "A, B & C"}, "2026-10-16")
        buf = io.StringIO()
        nc.write_csv(rows, buf)
        buf.seek(0)
        back = list(csv.DictReader(buf))
        self.assertEqual((back[0]["display_name"], back[0]["is_v7"]), ("A, B & C", "yes"))

    def test_header_order_matches_old_tool(self):
        buf = io.StringIO()
        nc.write_csv([], buf)
        self.assertEqual(buf.getvalue().strip(),
                         "date,stash,display_name,node_name,authority_id,peer_id,reachable,"
                         "agent_version,client_version_parsed,is_v7")


class ReportShapeTests(unittest.TestCase):
    def test_empty_or_missing_authorities_is_an_error(self):
        for rep in ({"authorities": []}, {}):
            with self.assertRaises(ValueError):
                nc.build_rows(rep, {}, "d")


# ---- --diff ----------------------------------------------------------------

def crow(stash, name="", state="6.2.0", reachable="yes"):
    return {"stash": stash, "authority_id": "A" + stash, "display_name": name, "node_name": "",
            "reachable": reachable, "client_version_parsed": state if reachable == "yes" else ""}


class DiffTests(unittest.TestCase):
    def test_upgrade_reachability_join_leave_unchanged(self):
        old = [crow("s1", "Up"), crow("s2", "Same"), crow("s3", "Dark", reachable="no"),
               crow("s4", "Gone"), crow("s5", "Down", "7.0.0")]
        new = [crow("s1", "Up", "7.0.0"), crow("s2", "Same"), crow("s3", "Dark", "6.2.0"),
               crow("s6", "Fresh", "7.0.0"), crow("s5", "Down", reachable="no")]
        d = nc.diff_rows(old, new)
        self.assertEqual(d["changed"], [("Dark", "unreachable", "6.2.0"), ("Down", "7.0.0", "unreachable"),
                                        ("Up", "6.2.0", "7.0.0")])
        self.assertEqual(d["joined"], ["Fresh"])
        self.assertEqual(d["left"], ["Gone"])
        self.assertEqual(d["unchanged"], 1)

    def test_identical_runs_have_no_changes(self):
        rows = [crow("s1"), crow("s2")]
        d = nc.diff_rows(rows, rows)
        self.assertEqual((d["changed"], d["joined"], d["left"], d["unchanged"]), ([], [], [], 2))

    def test_format(self):
        d = nc.diff_rows([crow("s1", "Up"), crow("s9", "Gone")], [crow("s1", "Up", "7.0.0"), crow("s2", "New")])
        text = nc.format_diff(d, "2026-10-09-census.csv")
        self.assertIn("Changes since 2026-10-09-census.csv: 1 changed, 1 joined, 1 left, 0 unchanged", text)
        self.assertIn("Up: 6.2.0 -> 7.0.0", text)
        self.assertIn("joined the active set: New", text)
        self.assertIn("left the active set: Gone", text)

    def test_reachable_without_version_has_its_own_state(self):
        r = crow("s1", "X", "")
        self.assertEqual(nc._state(r), "version not reported")

    def test_rows_without_stash_match_on_authority_id(self):
        a = {"stash": "", "authority_id": "AUTH", "display_name": "n", "node_name": "",
             "reachable": "yes", "client_version_parsed": "6.2.0"}
        b = dict(a, client_version_parsed="7.0.0")
        self.assertEqual(nc.diff_rows([a], [b])["changed"], [("n", "6.2.0", "7.0.0")])


# ---- reprocess against the real 2026-10-16 report --------------------------

def mock_names_chain():
    pub = nc.ss58_decode("esptrhJNi2mEW2a5qJuXU76h6JhLabry9ZXsnuBcwdE9H8u6n")  # a stash from the report
    return FakeChain(make_chain([(pub, "Di", None)]))


@unittest.skipUnless(os.path.isfile(OLD_CSV), "results/2026-10-16-census.csv is git-ignored; present only after a local run")
class RealReportTests(unittest.TestCase):
    def process(self, **kw):
        out = os.path.join(tempfile.mkdtemp(), "census.csv")
        lines = []
        rows = nc.process(FIXTURE, "2026-10-16", out, ["https://a"], say=lines.append, **kw)
        return rows, out, lines

    def test_reproduces_the_2026_10_16_counts(self):
        rows, out, lines = self.process(want_names=False)
        s = nc.summarize(rows)
        self.assertEqual((s["active"], s["reachable"], s["v7"], s["unreachable"]), (200, 185, 34, 15))
        self.assertEqual(s["versions"], {"6.2.0": 151, "7.0.0": 34})
        text = "\n".join(lines)
        self.assertIn("Active validators: 200", text)
        self.assertIn("6.2.0 x151, 7.0.0 x34", text)
        self.assertIn("34 of 200 validators (17.0%)", text)

    def test_matches_every_column_of_the_existing_csv_except_names(self):
        rows, out, _ = self.process(want_names=False)
        with open(OLD_CSV) as fh:
            old = list(csv.DictReader(fh))
        self.assertEqual(len(old), len(rows))
        for o, n in zip(old, rows):
            for col in nc.COLUMNS:
                if col != "display_name":
                    self.assertEqual(o[col], n[col], (o["stash"], col))

    def test_rpc_failure_still_writes_csv_and_says_so(self):
        rows, out, lines = self.process(rpc=FakeChain({}, fail=OSError("refused")))
        self.assertEqual(len(rows), 200)
        self.assertTrue(all(r["display_name"] == "" for r in rows))
        with open(out) as fh:
            self.assertEqual(len(list(csv.DictReader(fh))), 200)
        text = "\n".join(lines)
        self.assertIn("could not be read from the chain", text)
        self.assertIn("refused", text)

    def test_names_from_mocked_chain_land_in_csv(self):
        rows, out, lines = self.process(rpc=mock_names_chain())
        named = [r for r in rows if r["display_name"]]
        self.assertEqual([(r["stash"], r["display_name"]) for r in named],
                         [("esptrhJNi2mEW2a5qJuXU76h6JhLabry9ZXsnuBcwdE9H8u6n", "Di")])
        self.assertIn("Names: 1 of 200", "\n".join(lines))

    def test_diff_against_the_old_csv_shows_no_version_change(self):
        out = os.path.join(tempfile.mkdtemp(), "c.csv")
        lines = []
        nc.process(FIXTURE, "2026-10-16", out, [], want_names=False, diff_path=OLD_CSV, say=lines.append)
        self.assertIn("0 changed, 0 joined, 0 left, 200 unchanged", "\n".join(lines))


class CrawlTests(unittest.TestCase):
    """The crawl path with a stand-in for the explorer binary (no cargo, no p2p)."""

    def run_crawl(self, stub_body, env=None):
        d = tempfile.mkdtemp()
        stub = os.path.join(d, "stub")
        with open(stub, "w") as fh:
            fh.write("#!/bin/sh\n" + stub_body)
        os.chmod(stub, 0o755)
        saved = (nc.RESULTS, nc.ensure_binary, nc.pick_rpc)
        nc.RESULTS = os.path.join(d, "results")
        nc.ensure_binary = lambda cache, say=print: stub
        nc.pick_rpc = lambda cands, rpc=None, say=print: cands[0]
        lines = []
        try:
            nc.crawl("2026-10-20", dict(env or {}, CACHE_DIR=os.path.join(d, "cache")), [],
                     False, None, say=lines.append)
        finally:
            nc.RESULTS, nc.ensure_binary, nc.pick_rpc = saved
        return d, lines

    def test_crawl_runs_tool_with_census_sh_arguments_and_writes_csv(self):
        d = tempfile.mkdtemp()
        argfile = os.path.join(d, "args")
        body = 'echo "$@" > %s\ncp %s "$(echo "$@" | sed \'s/.*--json //\')"\n' % (argfile, FIXTURE)
        out, lines = self.run_crawl(body, {"TIMEOUT": "900", "NETWORK_BACKEND": "litep2p"})
        with open(argfile) as fh:
            args = fh.read()
        for want in ("authority-check", "--url wss://rpc2.polkadex.ee", "--genesis 3920bcb4",
                     "--timeout 900", "--dial-timeout 10", "--network-backend litep2p",
                     "boot.polkadex.ee"):
            self.assertIn(want, args)
        self.assertNotIn("--genesis 0x", args)
        self.assertTrue(os.path.exists(os.path.join(out, "results", "raw", "2026-10-20-authority-check.json")))
        with open(os.path.join(out, "results", "2026-10-20-census.csv")) as fh:
            self.assertEqual(len(list(csv.DictReader(fh))), 200)
        self.assertIn("Active validators: 200", "\n".join(lines))

    def test_failing_tool_is_fatal(self):
        with self.assertRaises(nc.Fatal):
            self.run_crawl("exit 3\n")

    def test_tool_without_report_is_fatal(self):
        with self.assertRaises(nc.Fatal):
            self.run_crawl("exit 0\n")


class SubprocessTimeoutTests(unittest.TestCase):
    def test_timeouts_are_passed_and_readable(self):
        import subprocess
        seen = []
        def fake(cmd, **kw):
            seen.append((cmd[0], kw.get("timeout")))
            raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
        orig = nc.subprocess.run
        nc.subprocess.run = fake
        try:
            with self.assertRaises(nc.Fatal) as c1:
                nc._run(["git", "clone", "x"], timeout=nc.GIT_TIMEOUT)
            with self.assertRaises(nc.Fatal) as c2:
                nc._run(["cargo", "build", "--release"], timeout=nc.CARGO_TIMEOUT)
            with self.assertRaises(nc.Fatal):
                nc._git_out(["git", "rev-parse", "HEAD"], ".")
        finally:
            nc.subprocess.run = orig
        self.assertIn("timed out after 300 s: git clone x", str(c1.exception))
        self.assertIn("timed out after 3600 s", str(c2.exception))
        self.assertEqual(seen[0], ("git", 300))
        self.assertEqual(seen[1], ("cargo", 3600))

    def test_ensure_binary_passes_timeouts(self):
        src = open(os.path.join(HERE, "..", "node_census.py"), encoding="utf-8").read()
        self.assertEqual(src.count("timeout=GIT_TIMEOUT"), 4)  # clone, fetch, checkout, _git_out
        self.assertIn("timeout=CARGO_TIMEOUT", src)


class MainTests(unittest.TestCase):
    def test_reprocess_cli_default_out_next_to_raw_dir(self):
        self.assertEqual(
            nc.reprocess_paths("/x/results/raw/2026-10-16-authority-check.json"),
            ("2026-10-16", "/x/results/2026-10-16-census.csv"))
        self.assertEqual(nc.reprocess_paths("/tmp/whatever.json")[0], "")

    def test_reprocess_with_diff_end_to_end(self):
        d = tempfile.mkdtemp()
        raw = os.path.join(d, "raw")
        os.mkdir(raw)
        rp = os.path.join(raw, "2026-10-23-authority-check.json")
        rep = {"authorities": [auth("5A", stash="5S", agent=REAL_V7), auth("5B", stash="5T", agent=REAL_V6)]}
        with open(rp, "w") as fh:
            json.dump(rep, fh)
        older = os.path.join(d, "2026-10-16-census.csv")
        with open(older, "w") as fh:
            nc.write_csv(nc.build_rows({"authorities": [auth("5A", stash="5S", agent=REAL_V6),
                                                        auth("5B", stash="5T", agent=REAL_V6)]},
                                       {"5S": "Eve"}, "2026-10-16"), fh)
        lines = []
        rc = nc.main(["--reprocess", rp, "--no-names", "--diff", older], env={}, say=lines.append)
        self.assertEqual(rc, 0)
        text = "\n".join(lines)
        self.assertIn("1 changed, 0 joined, 0 left, 1 unchanged", text)
        self.assertIn("Faraday/18: 6.2.0 -> 7.0.0", text)
        with open(os.path.join(d, "2026-10-23-census.csv")) as fh:
            back = list(csv.DictReader(fh))
        self.assertEqual([r["is_v7"] for r in back], ["yes", "no"])

    def test_reprocess_rejects_undated_or_missing_file(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "whatever.json")
        with open(p, "w") as fh:
            json.dump(sample_report(), fh)
        self.assertEqual(nc.main(["--reprocess", p, "--no-names"], env={}, say=lambda m: None), 1)
        self.assertEqual(nc.main(["--reprocess", os.path.join(d, "nope.json")], env={}, say=lambda m: None), 1)

    def test_empty_report_is_an_error_exit(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "2026-10-16-authority-check.json")
        with open(p, "w") as fh:
            json.dump({"authorities": []}, fh)
        self.assertEqual(nc.main(["--reprocess", p, "--no-names"], env={}, say=lambda m: None), 1)

    def diff_rc(self, content, name="old.csv", mode="w"):
        d = tempfile.mkdtemp()
        path = os.path.join(d, name)
        if content is not None:
            with open(path, mode) as fh:
                fh.write(content)
        out = os.path.join(d, "out")
        said = []
        err = io.StringIO()
        old = sys.stderr
        sys.stderr = err
        try:
            rc = nc.main(["--reprocess", FIXTURE, "--no-names", "--diff", path, "--out-dir", out],
                         env={}, say=said.append)
        finally:
            sys.stderr = old
        return rc, err.getvalue(), said, out

    def assert_fail_fast(self, rc, err, said, out):
        self.assertEqual(rc, 2)
        self.assertEqual(len(err.strip().splitlines()), 1)
        self.assertIn("--diff", err)
        self.assertEqual(said, [])  # nothing processed
        self.assertFalse(os.path.exists(out))  # no CSV written

    def test_diff_missing_file(self):
        self.assert_fail_fast(*self.diff_rc(None))

    def test_diff_unreadable_file(self):
        d = tempfile.mkdtemp()  # a directory is not a readable file
        rc = nc.main(["--reprocess", FIXTURE, "--no-names", "--diff", d, "--out-dir", d + "/o"],
                     env={}, say=lambda m: None)
        self.assertEqual(rc, 2)

    def test_diff_nul_byte_is_csv_error(self):
        rc, err, said, out = self.diff_rc("stash,client_version_parsed\n5A,\x00\n")
        self.assert_fail_fast(rc, err, said, out)

    def test_diff_not_utf8(self):
        self.assert_fail_fast(*self.diff_rc(b"stash,client_version_parsed\n\xff\xfe,\n", mode="wb"))

    def test_diff_missing_columns(self):
        rc, err, said, out = self.diff_rc("name,other\na,b\n")
        self.assert_fail_fast(rc, err, said, out)
        self.assertIn("stash", err)

    def test_diff_header_only_has_no_rows(self):
        rc, err, said, out = self.diff_rc("stash,client_version_parsed,reachable\n")
        self.assert_fail_fast(rc, err, said, out)
        self.assertIn("no data rows", err)

    def test_diff_empty_file(self):
        self.assert_fail_fast(*self.diff_rc(""))

    def test_diff_validated_before_crawl(self):
        calls = []
        orig = nc.crawl
        try:
            nc.crawl = lambda *a, **k: calls.append(1)
            rc = nc.main(["--diff", "/nonexistent.csv"], env={}, say=lambda m: None)
        finally:
            nc.crawl = orig
        self.assertEqual((rc, calls), (2, []))

    def test_diff_valid_file_runs(self):
        buf = io.StringIO()
        nc.write_csv(nc.build_rows({"authorities": [auth("5A", stash="5S", agent=REAL_V6)]},
                                   {}, "2026-10-16"), buf)
        rc, err, said, out = self.diff_rc(buf.getvalue())
        self.assertEqual(rc, 0)
        self.assertIn("Changes since old.csv", "\n".join(said))
        self.assertTrue(os.path.isfile(os.path.join(out, "2026-10-16-census.csv")))

    def test_fixture_dir_stays_clean(self):
        self.assertEqual([f for f in os.listdir(os.path.dirname(FIXTURE)) if f.endswith(".csv")], [])

    def test_help_mentions_every_mode(self):
        text = nc.build_parser().format_help()
        for word in ("--reprocess", "--diff", "--no-names", "RPC_URL", "TIMEOUT", "DIAL_TIMEOUT",
                     "BOOTNODES", "NETWORK_BACKEND", nc.SUBP2P_SHA):
            self.assertIn(word, text)

    def test_names_urls_come_from_env_rpc_then_fallback(self):
        seen = []
        orig = nc.process
        try:
            nc.process = lambda raw, date, out, urls, *a, **k: seen.append(urls)
            d = tempfile.mkdtemp()
            p = os.path.join(d, "2026-10-16-authority-check.json")
            with open(p, "w") as fh:
                fh.write("{}")
            nc.main(["--reprocess", p], env={"RPC_URL": "wss://x.example"}, say=lambda m: None)
            nc.main(["--reprocess", p], env={}, say=lambda m: None)
        finally:
            nc.process = orig
        self.assertEqual(seen[0], ["https://x.example", "https://rpc.polkadex.ee"])
        self.assertEqual(seen[1], ["https://rpc2.polkadex.ee", "https://rpc.polkadex.ee"])

    def test_no_em_or_en_dashes_in_source(self):
        with open(os.path.join(HERE, "..", "node_census.py"), encoding="utf-8") as fh:
            src = fh.read()
        self.assertNotIn(chr(0x2014), src)
        self.assertNotIn(chr(0x2013), src)


if __name__ == "__main__":
    unittest.main()
