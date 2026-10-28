"""Server-side detection (backend/detection): unit tests per algorithm plus a labelled corpus evaluation."""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from ai.heuristics import phishing_signals
from detection import combine, level_of, score_domain
from detection import data, dga, typo
from detection.names import decode_domain, registrable, script_of, scripts_in, skeleton, split_domain
from services.site_service import normalize_domain
from tests.detection_corpus import BAD, HELDOUT_BAD, HELDOUT_LEGIT, LEGIT

FLAG = 0.5


def norm(d):
    """The form the server actually scores: punycode, no www."""
    return normalize_domain(d) or d


# ---- contract -------------------------------------------------------------------------------------------

def test_verdict_has_the_contract_shape():
    v = score_domain("secure-paypal-login.top", {"has_password_field": True})
    assert set(v) == {"score", "level", "reasons", "brand", "official", "features"}
    assert 0.0 <= v["score"] <= 1.0 and v["level"] == level_of(v["score"]) == "high"
    assert len(v["reasons"]) <= 6 and all(isinstance(r, str) for r in v["reasons"])
    assert v["brand"] == "paypal" and v["official"] == "paypal.com"
    assert all(isinstance(x, (int, float)) for x in v["features"].values())


@pytest.mark.parametrize("bad", [None, "", " ", ".", "..", "com", "a..b", 42, [], b"x.com", "x" * 400 + ".com",
                                 "\x00.com", "xn--.com", "xn--zzzzzzzzzzzzzzzz.com", "💥.com", "a.b" * 80])
def test_never_raises_on_bad_input(bad):
    v = score_domain(bad)
    assert v["score"] < 0.1 and v["level"] == "none"


def test_levels_follow_the_contract_cuts():
    assert [level_of(s) for s in (0, 0.24, 0.25, 0.49, 0.5, 0.74, 0.75, 1)] == \
        ["none", "none", "low", "low", "medium", "medium", "high", "high"]


def test_signals_only_add_caution():
    base = score_domain("my-recipes.example.com")
    with_pw = score_domain("my-recipes.example.com", {"has_password_field": True})
    assert with_pw["score"] >= base["score"]
    assert score_domain("netbanking.hdfcbank.com", {"has_password_field": True, "title": "HDFC login"})["score"] == 0.0


def test_page_signals_raise_a_brand_page_on_an_unrelated_domain():
    plain = score_domain("my-recipes.example.com")
    page = score_domain("my-recipes.example.com", {
        "has_password_field": True, "title": "PayPal: Log in", "text": "Verify your account, unusual activity",
        "form_actions": ["https://collector.example.net/post.php"]})
    assert plain["score"] < FLAG <= page["score"] and page["brand"] == "paypal"
    # reasons never repeat page text
    assert all("Log in" not in r and "collector" not in r for r in page["reasons"])


def test_combine_strongest_leads_and_reasons_merge():
    a = score_domain("secure-paypal-login.top")
    b = score_domain("xkqjzvbwmtpl.com")
    c = combine([b, a, None, "junk"])
    assert c["score"] == a["score"] and c["brand"] == "paypal"
    assert set(a["reasons"]) <= set(c["reasons"]) and len(c["reasons"]) <= 6
    assert combine([])["score"] == 0.0 and combine(None)["level"] == "none"


def test_wrapper_keeps_the_old_keys():
    h = phishing_signals("paypal-secure-login.top", {"has_password_field": True})
    assert h["brand"] == "paypal" and h["official"] == "paypal.com" and h["score"] >= 0.8
    assert phishing_signals("wikipedia.org") == score_domain("wikipedia.org")


def test_verdict_is_a_fresh_object_each_call():
    v = score_domain("secure-paypal-login.top")
    v["reasons"].append("tampered")
    v["features"]["x"] = 1
    again = score_domain("secure-paypal-login.top")
    assert "tampered" not in again["reasons"] and "x" not in again["features"]


# ---- public suffixes ------------------------------------------------------------------------------------

@pytest.mark.parametrize("host,expect", [
    ("sbi.co.in", ((), "sbi", "co.in")),
    ("www.barclays.co.uk", (("www",), "barclays", "co.uk")),
    ("a.b.paypal.com.evil.xyz", (("a", "b", "paypal", "com"), "evil", "xyz")),
    ("shop.bbc.com.au", (("shop",), "bbc", "com.au")),
    ("paypal-login.pages.dev", ((), "paypal-login", "pages.dev")),
    ("x.y.github.io", (("x",), "y", "github.io")),
    ("co.uk", ((), "", "co.uk")),
    ("example.com", ((), "example", "com")),
])
def test_split_domain_knows_multi_label_suffixes(host, expect):
    assert split_domain(host) == expect


def test_registrable():
    assert registrable("login.sbi.co.in") == "sbi.co.in"
    assert registrable("a.example.org") == "example.org"


def test_sbi_co_in_is_handled_with_the_real_label():
    # the old rsplit('.', 1) would have analysed "sbi.co" and treated "in" as the TLD
    assert score_domain("sbi.co.in")["score"] == 0.0
    assert score_domain("sbi-login.co.in")["score"] > score_domain("sbi.co.in")["score"]


# ---- IDN and look-alike characters ----------------------------------------------------------------------

def test_punycode_round_trip_and_scripts():
    host = "раураl.com".encode("idna").decode()
    assert host.startswith("xn--") and decode_domain(host) == "раураl.com"
    assert scripts_in("раураl") == {"CYRILLIC", "LATIN"}
    assert script_of("a") == "LATIN" and script_of("-") == "COMMON" and script_of("α") == "GREEK"
    assert decode_domain("xn--zzzz") == "xn--zzzz" or isinstance(decode_domain("xn--zzzz"), str)


@pytest.mark.parametrize("a,b", [
    ("paypal", "paypa1"), ("paypal", "раураl"), ("microsoft", "rnicrosoft"), ("google", "g00gle"),
    ("apple", "аррӏе"), ("windows", "vvindows"), ("paypal", "ｐａｙｐａｌ"), ("amazon", "amaz0n"),
])
def test_skeleton_equates_lookalikes(a, b):
    assert skeleton(a) == skeleton(b)


def test_skeleton_keeps_different_words_apart():
    assert skeleton("paypal") != skeleton("paytm")
    assert skeleton("bank") != skeleton("bang")


def test_mixed_script_label_is_flagged_even_without_a_brand():
    host = "wіkipedia-support.com".encode("idna").decode()       # Cyrillic і
    v = score_domain(host)
    assert any("alphabet" in r for r in v["reasons"]) and v["score"] > score_domain("wikipedia-support.com")["score"]


def test_plain_idn_is_only_a_mild_hint():
    v = score_domain("xn--mnchen-3ya.de")
    assert v["score"] < 0.1


# ---- typosquats -----------------------------------------------------------------------------------------

def test_osa_distance():
    assert typo.osa_distance("paypal", "paypal") == 0
    assert typo.osa_distance("paypal", "paypla") == 1      # swap counts as one edit
    assert typo.osa_distance("paypal", "paypall") == 1
    assert typo.osa_distance("paypal", "peypel") == 2
    assert typo.osa_distance("paypal", "google") == 3      # over the limit: limit + 1


def test_index_agrees_with_brute_force_for_a_sample_of_queries():
    queries = ["paypall", "paypla", "gooogle", "amazom", "binnance", "coinbse", "hdfcbnak", "wellsfaro",
               "microsfot", "netfliix", "linkdin", "kotakk", "stripee", "razorpya", "citibamk", "random"]
    for q in queries:
        got = typo.nearest_brand(q)
        brute = [(t, typo.osa_distance(q, t, typo._allowed(len(t)))) for t in data.BRAND_TOKENS
                 if len(t) >= typo.MIN_LEN and typo._allowed(len(t))]
        close = [t for t, d in brute if 0 < d <= typo._allowed(len(t))]
        # everything the index returns is verified by the real distance; if brute force finds a candidate the
        # index must find one too (five-letter brands only count for swaps/repeats/neighbour keys)
        if got is None:
            assert not [t for t in close if len(t) > typo.MIN_LEN or typo.classify_edit(q, t) in ("swap", "repeat", "adjacent")], q
        else:
            assert got[0] in close, q


def test_edit_kinds():
    assert typo.classify_edit("paypla", "paypal") == "swap"
    assert typo.classify_edit("paypall", "paypal") == "repeat"
    assert typo.classify_edit("paypl", "paypal") == "omit"
    assert typo.classify_edit("payoal", "paypal") == "adjacent"       # o is next to p on the keyboard
    assert typo.classify_edit("paypbl", "paypal") == "substitute"


def test_ordinary_words_near_a_brand_are_left_alone():
    for d in ("phase.com", "purchase.com", "kodak.com", "venom.com", "growth.com", "goggle.com"):
        assert score_domain(d)["score"] < 0.25, d


def test_short_brands_are_not_fuzzy_matched():
    assert score_domain("sbx.com")["score"] == 0.0 and score_domain("hsbd.com")["score"] == 0.0


# ---- combosquatting and subdomains ----------------------------------------------------------------------

def test_combosquat_reasons_name_the_brand_and_words():
    v = score_domain("secure-hdfcbank-login.xyz", {"has_password_field": True})
    assert v["score"] >= 0.8 and v["official"] == "hdfcbank.com"
    text = " ".join(v["reasons"]).lower()
    assert "hdfcbank" in text and "login" in text and "tld" in text and "password" in text


def test_brand_hidden_in_a_longer_word_needs_more_than_a_substring():
    assert score_domain("pineapple.com")["brand"] is None
    assert score_domain("chaseandsanborn.com")["brand"] is None
    assert score_domain("bobcat.com")["brand"] is None


def test_official_domain_in_a_subdomain_is_the_strongest_sign():
    v = score_domain("paypal.com.evil.xyz")
    assert v["score"] >= 0.9 and v["brand"] == "paypal"
    assert score_domain("login.hdfcbank.com.verify-now.top")["official"] == "hdfcbank.com"


def test_free_host_brand_page():
    assert score_domain("hdfcbank.weebly.com")["score"] >= FLAG


def test_country_variants_of_global_brands_are_genuine():
    for d in ("google.co.in", "amazon.com.au", "www.apple.com.cn", "ebay.de"):
        assert score_domain(d)["score"] == 0.0, d
    assert score_domain("google.tk")["score"] > 0.3                 # abused free ccTLD is not trusted
    assert score_domain("paypal.github.io")["score"] > 0.3          # hosting suffix is not a country variant


# ---- random names ---------------------------------------------------------------------------------------

def test_randomness_separates_natural_from_generated_names():
    natural = ["wikipedia", "stackoverflow", "cricbuzz", "geeksforgeeks", "bajajfinserv", "sbcglobal", "rbcroyalbank",
               "mutualfundsindia", "thehindu", "vkontakte", "cloudflare", "huffpost"]
    random_ = ["xkqjzvbwmtpl", "a8f3k2j9d0s1", "qzxwvbnmlkjh", "rtkpvnxzwq", "3kd9s8f7a6", "yqzzkvwxj"]
    assert max(dga.randomness(w)[0] for w in natural) < 0.2
    assert min(dga.randomness(w)[0] for w in random_) > 0.6


def test_short_labels_are_never_called_random():
    for w in ("xkcd", "bbc", "rbc", "hdfc", "nvdia", "sbcgl"):
        assert dga.randomness(w)[0] == 0.0


# ---- data sanity ----------------------------------------------------------------------------------------

def test_every_official_domain_scores_zero_alone_and_under_subdomains():
    for dom in data.OFFICIAL:
        for host in (dom, "www." + dom, "login." + dom):
            if host.startswith("www.") and dom.startswith("www."):
                continue
            assert score_domain(host)["score"] == 0.0, host


def test_brand_data_is_well_formed():
    for name, (domains, aliases) in data._BRANDS.items():
        assert isinstance(domains, tuple) and domains, name
        assert isinstance(aliases, tuple), name
        assert name == name.lower() and name.isalnum(), name
        assert data.SUGGEST[name] in data.OFFICIAL, name
    assert len(data._BRANDS) >= 120


def test_hosting_and_user_content_domains_are_never_official():
    for d in ("github.io", "amazonaws.com", "googleusercontent.com", "sharepoint.com", "blogspot.com",
              "pages.dev", "weebly.com"):
        assert d not in data.OFFICIAL


# ---- labelled corpus ------------------------------------------------------------------------------------

def _evaluate(legit, bad):
    tp = sum(score_domain(norm(d))["score"] >= FLAG for d, _ in bad)
    fp = sum(score_domain(norm(d))["score"] >= FLAG for d in legit)
    return tp, len(bad), fp, len(legit)


def test_corpus_is_large_enough():
    assert sum(1 for _, off in LEGIT if not off) + sum(1 for _, off in LEGIT if off) >= 60
    assert len(BAD) >= 60 and len({d for d, _ in BAD}) == len(BAD)
    assert not ({d for d, _ in LEGIT} & {d for d, _ in BAD})


def test_no_official_domain_is_ever_flagged():
    official = [d for d, off in LEGIT if off]
    assert official and all(score_domain(norm(d))["score"] == 0.0 for d in official)


def test_precision_and_recall_on_the_corpus():
    legit = [d for d, _ in LEGIT]
    tp, n_bad, fp, n_legit = _evaluate(legit, BAD)
    recall = tp / n_bad
    precision = tp / (tp + fp) if tp + fp else 1.0
    assert recall >= 0.95, f"recall {recall:.3f}"
    assert precision >= 0.98, f"precision {precision:.3f}"
    assert fp == 0, "no legitimate domain should reach the 'medium' level"


@pytest.mark.parametrize("family", sorted({f for _, f in BAD}))
def test_each_attack_family_is_caught(family):
    rows = [d for d, f in BAD if f == family]
    hit = sum(score_domain(norm(d))["score"] >= FLAG for d in rows)
    assert hit / len(rows) >= 0.9, f"{family}: {hit}/{len(rows)}"


def test_held_out_set():
    """Written after tuning on the main corpus, so a looser bar: it measures generalisation, not fit."""
    tp, n_bad, fp, n_legit = _evaluate(HELDOUT_LEGIT, HELDOUT_BAD)
    assert tp / n_bad >= 0.85 and fp == 0


def test_flagged_ordinary_sites_are_at_most_low():
    for d, off in LEGIT:
        if not off:
            assert score_domain(norm(d))["level"] in ("none", "low"), d


def test_phishing_scores_are_ordered_by_evidence():
    weak = score_domain("paypal.org")["score"]
    mid = score_domain("paypal-support.com")["score"]
    strong = score_domain("secure-paypal-login.top")["score"]
    assert weak < mid < strong
