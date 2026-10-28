"""Domain risk scoring: brand imitation, look-alike characters, random names and cheap-TLD hints, fused in log-odds.

Each independent kind of evidence adds a weight (in natural-log odds) to a low prior; the score is the logistic
of the sum. Because the weights add in log space, two weak hints (a cheap TLD and a login word) stay weak while
a strong one (a misspelt brand, a look-alike character) dominates, and no single hint can reach certainty.
The weights below were set by hand and checked against the labelled corpus in tests/test_detection.py.

    P(phish | evidence) = 1 / (1 + exp(-(PRIOR + sum of weights)))

Official brand domains (data.OFFICIAL) short-circuit to 0 before any evidence is looked at.
"""
import math
from functools import lru_cache

from . import dga, typo
from .data import (ABUSED_CCTLDS, AMBIGUOUS_BRANDS, BRAND_TOKENS, BRANDS, FILLER, MILD_TLDS, OFFICIAL,
                   OFFICIAL_CC, STRONG_TERMS, SUGGEST, SUSPICIOUS_TLDS, TERMS, HOSTING_SUFFIXES)
from .names import alnum, decode_domain, scripts_in, skeleton, split_domain

VERSION = 2

# Probability that an arbitrary domain a person opens is a brand-imitating phish, before looking at it.
PRIOR = -3.9

# Evidence weights (log-odds added). Rationale in the comment after each.
W = {
    "homoglyph": 5.6,         # same skeleton as a brand but spelt differently: nobody does this by accident
    "homoglyph_script": 6.4,  # ...and it needs letters from another alphabet
    "official_in_sub": 5.6,   # paypal.com.evil.xyz: the real domain, put where the owner is not
    "combo": 3.8,             # brand + login/pay words: the classic combosquat (terms add on top)
    "brand_words": 2.9,       # brand next to other words (paypal-community.net)
    "embedded": 2.9,          # a long brand name inside a longer made-up word
    "exact": 2.8,             # the brand's label on a suffix the brand does not own (chase.xyz)
    "split": 4.0,             # the brand chopped by a hyphen (pay-pal.com)
    "exact_weak": 1.4,        # same, but the brand is a short or ordinary word (apple, axis, bob)
    "sub_brand": 3.6,         # brand as a subdomain label of an unrelated site (paypal.evil.xyz)
    "typo_swap": 5.0, "typo_repeat": 5.0, "typo_adjacent": 4.8, "typo_omit": 4.6, "typo_insert": 4.5,
    "typo_substitute": 4.3, "typo_two": 3.8,
    "mixed_script": 2.6,      # Latin letters mixed with Cyrillic/Greek/...: almost only used to deceive
    "idn": 0.5,                # any internationalised name; ordinary on its own
    "term": 0.6,              # per distinct login/payment word (up to 3)
    "tld": 1.3,               # cheap, abuse-heavy TLD
    "tld_mild": 0.5,
    "hyphens2": 0.6, "hyphens3": 1.0,
    "deep": 0.6,              # four or more subdomain labels
    "long": 0.5,              # very long registrable label
    "free_host": 0.8,         # brand imitation hosted on a free site builder
    "dga": 5.0,               # at randomness 1.0 (ramps in from 0.2)
    "gov_edu": -1.0,          # government and university registries
    # page signals (only ever add)
    "pw_suspect": 1.4, "pw_plain": 0.3, "title_brand": 2.0, "urgent": 0.7, "form_offsite": 1.2,
    "hidden_iframe": 0.8, "entropy": 0.5,
}

# Typo kinds -> weight key
_TYPO_KEYS = {"swap": "typo_swap", "repeat": "typo_repeat", "adjacent": "typo_adjacent", "omit": "typo_omit",
              "insert": "typo_insert", "substitute": "typo_substitute", "two": "typo_two"}

_GOV_EDU = frozenset(("gov", "edu", "mil", "gov.in", "nic.in", "ac.in", "edu.in", "ac.uk", "gov.uk",
                      "edu.au", "gov.au", "ac.jp", "go.jp", "edu.sg", "gov.sg"))

_URGENT = ("verify your account", "account has been suspended", "account is suspended", "unusual activity",
           "confirm your identity", "update your payment", "one-time password", "enter your otp",
           "your account will be", "limited time", "act now", "security alert", "unauthorized login",
           "verify your identity", "kyc", "suspended")

LEVELS = ((0.75, "high"), (0.5, "medium"), (0.25, "low"))


def level_of(score: float) -> str:
    for cut, name in LEVELS:
        if score >= cut:
            return name
    return "none"


def _none(reason: str | None = None, **extra) -> dict:
    return {"score": 0.0, "level": "none", "reasons": [reason] if reason else [], "brand": extra.get("brand"),
            "official": None, "features": extra.get("features", {})}


# ---- brand vocabulary in two spaces: as written, and as it looks (skeleton) ------------------------------


class _Space:
    """Brand tokens and terms in one comparison space."""

    def __init__(self, fold):
        self.fold = fold
        self.brands = {}                      # token in this space -> (brand name, original token)
        for tok, brand in BRAND_TOKENS.items():
            self.brands.setdefault(fold(tok), (brand, tok))
        self.by_len = sorted(self.brands, key=len, reverse=True)
        self.terms = frozenset(fold(t) for t in TERMS | FILLER)
        self.terms_by_len = sorted(self.terms, key=len, reverse=True)
        self.ambiguous = frozenset(fold(t) for t in AMBIGUOUS_BRANDS)
        self.strong = frozenset(fold(t) for t in STRONG_TERMS)
        self.unfold = {fold(t): t for t in sorted(TERMS | FILLER, reverse=True)}
        self._covered = lru_cache(maxsize=8192)(self._covered_uncached)

    def _covered_uncached(self, s: str) -> bool:
        """True if `s` is entirely terms / filler / digits (any split)."""
        n = len(s)
        ok = [False] * (n + 1)
        ok[0] = True
        for i in range(n):
            if not ok[i]:
                continue
            if s[i].isdigit():
                ok[i + 1] = True
            for t in self.terms_by_len:
                if s.startswith(t, i):
                    ok[i + len(t)] = True
        return ok[n]

    def covered(self, s: str) -> bool:
        return not s or self._covered(s)

    def terms_in(self, s: str) -> list:
        """Strong terms appearing as whole pieces of a fully-covered string, in order, without repeats."""
        found = []
        i, n = 0, len(s)
        while i < n:
            for t in self.terms_by_len:
                if s.startswith(t, i):
                    if t in self.strong and self.unfold[t] not in found:
                        found.append(self.unfold[t])
                    i += len(t)
                    break
            else:
                i += 1
        return found

    def find(self, text: str):
        """Best brand reading of `text` in this space: (kind, brand, rest_terms) or None.
        kind: exact | combo | embedded"""
        n = len(text)
        if n < 3:
            return None
        hit = self.brands.get(text)
        if hit:
            return ("exact", hit[0], [])
        for b in self.by_len:
            lb = len(b)
            if lb > n:
                continue
            i = text.find(b)
            if i < 0:
                continue
            left, right = text[:i], text[i + lb:]
            brand, orig = self.brands[b]
            if self.covered(left) and self.covered(right):
                return ("combo", brand, self.terms_in(left) + self.terms_in(right))
            # Inside a longer unknown word: only for long, distinctive names (not "apple" in "pineapple").
            if lb >= 6 and b not in self.ambiguous:
                return ("embedded", brand, [])
        return None


_RAW = _Space(lambda s: s)
_SKEL = _Space(skeleton)


def _label_hit(text: str, skel_text: str, has_foreign: bool):
    """(weight_key, brand, kind, terms) for the strongest brand reading of one label, or None."""
    best = None

    def consider(key, brand, kind, terms):
        nonlocal best
        if best is None or W[key] > W[best[0]]:
            best = (key, brand, kind, terms)

    flat = alnum(text)
    pieces = [p for p in text.split("-") if p]
    for cand in ([flat] + (pieces if len(pieces) > 1 else [])):
        raw = _RAW.find(cand)
        if raw:
            kind, brand, terms = raw
            if kind == "exact" and cand == flat and len(pieces) > 1:
                consider("split", brand, "split", [])
            elif kind == "exact":
                weak = len(cand) <= 4 or cand in AMBIGUOUS_BRANDS
                consider("exact_weak" if weak else "exact", brand, "exact", [])
            elif kind == "combo":
                consider("combo", brand, "combo", terms)
            else:
                consider("embedded", brand, "embedded", [])
    # Brand + words that are not login/pay words, split by hyphens: brand next to other words.
    if best and best[2] == "embedded" and len(pieces) > 1:
        best = ("brand_words", best[1], "words", [])

    # Look-alike reading (skeleton space): the text is compared with brands by how it looks. Skipped for any
    # piece that already spells the brand correctly.
    sflat = alnum(skel_text)
    if sflat != flat:
        spieces = [alnum(p) for p in skel_text.split("-") if p] if len(pieces) > 1 else []
        rpieces = [alnum(p) for p in pieces] if len(pieces) > 1 else []
        for rc, sc in zip([flat] + rpieces, [sflat] + spieces):
            s = _SKEL.find(sc)
            if not s:
                continue
            kind, brand, terms = s
            r = _RAW.find(rc)
            if r and r[1] == brand and r[0] in ("exact", "combo"):
                continue                                  # spelt right
            tok_len = len(next((t for t in BRAND_TOKENS if BRAND_TOKENS[t] == brand), brand))
            # very short brands (ing, sbi) only count when visibly foreign characters are involved
            if tok_len < 4 and not has_foreign:
                continue
            if r and r[1] == brand and kind == "combo":
                # the brand is spelt right; only the words around it are disguised ("paypal-l0gin")
                consider("combo", brand, "combo", terms)
            elif kind in ("exact", "combo"):
                consider("homoglyph_script" if has_foreign else "homoglyph", brand, "homoglyph", terms)
            elif not r:
                consider("embedded", brand, "embedded", [])

    # Misspellings (one or two edits) of a brand, token by token.
    for p in pieces:
        near = typo.nearest_brand(alnum(p))
        if near:
            tok, dist, kind = near
            consider(_TYPO_KEYS[kind], BRAND_TOKENS[tok], "typo:" + kind, [])
    return best


def _sub_hits(subs: tuple, reg: str):
    """Brand imitation in the subdomain part: the real domain used as a subdomain, or a brand label."""
    if not subs:
        return None
    labels = list(subs)
    # paypal.com.evil.xyz: a run of subdomain labels that spells an official domain.
    for k in (3, 2):
        for i in range(len(labels) - k + 1):
            window = ".".join(labels[i:i + k])
            if window in OFFICIAL:
                return ("official_in_sub", OFFICIAL[window], "official-in-sub", [])
    for lab in labels:
        if len(lab) < 3 or lab == "www":
            continue
        for cand in [alnum(lab)] + [alnum(p) for p in lab.split("-") if p]:
            hit = _RAW.find(cand) if cand else None
            if not (hit and hit[0] in ("exact", "combo")) and cand:
                hit = _SKEL.find(alnum(skeleton(cand)))      # g00gle.com-verify.top
            if hit and hit[0] in ("exact", "combo"):
                return ("sub_brand", hit[1], "sub-brand", hit[2])
    return None


def _official_brand(domain: str, subs: tuple, label: str, suffix: str):
    """Brand name when `domain` is (a subdomain of) a genuine brand domain, else None."""
    parts = domain.split(".")
    for i in range(len(parts) - 1):
        cand = ".".join(parts[i:])
        if cand in OFFICIAL:
            return OFFICIAL[cand]
    # google.co.in, amazon.com.au: the brand's own label under an ordinary country suffix.
    if label in OFFICIAL_CC and suffix not in HOSTING_SUFFIXES:
        last = suffix.rsplit(".", 1)[-1]
        if len(last) == 2 and last not in ABUSED_CCTLDS:
            return OFFICIAL_CC[label]
    return None


def _tld_of(suffix: str) -> str:
    return suffix.rsplit(".", 1)[-1]


@lru_cache(maxsize=32768)
def _analyse(domain: str):
    """Pure, signal-free analysis of one host: (logit, evidence[(weight, reason)], brand, official, features)."""
    host = domain.strip().strip(".").lower()
    if host.startswith("www."):
        host = host[4:]
    if not host or "." not in host or len(host) > 253 or any(not p for p in host.split(".")):
        return None
    subs, label, suffix = split_domain(host)
    if not label:
        return None

    official_brand = _official_brand(host, subs, label, suffix)
    if official_brand:
        return ("official", official_brand)

    ulabel = decode_domain(label)
    uni_subs = tuple(decode_domain(s) for s in subs)
    skel_label = skeleton(ulabel)
    scripts = scripts_in(ulabel)
    foreign = scripts - {"LATIN"}
    is_idn = label.startswith("xn--") or not ulabel.isascii()
    mixed = "LATIN" in scripts and bool(foreign - {"CJK"})
    has_foreign = bool(foreign)

    ev = []       # (weight, reason)
    brand = None

    hit = _label_hit(ulabel, skel_label, has_foreign)
    sub_hit = _sub_hits(uni_subs, label)

    chosen = hit
    if sub_hit and (chosen is None or W[sub_hit[0]] > W[chosen[0]]):
        chosen = sub_hit
    free_host = suffix in HOSTING_SUFFIXES
    terms_seen = []
    if chosen:
        key, brand, kind, terms = chosen
        terms_seen = list(terms)
        ev.append((W[key], _brand_reason(key, kind, brand, terms)))
        if free_host:
            ev.append((W["free_host"], "brand imitation on a free hosting site"))

    if mixed:
        ev.append((W["mixed_script"], "mixes Latin letters with another alphabet"))
    elif is_idn and not chosen:
        ev.append((W["idn"], "internationalised (non-ASCII) domain name"))

    # Login / payment words anywhere in the label or subdomains.
    plain = alnum(ulabel)
    words = []
    for cand in [plain] + [alnum(p) for p in ulabel.split("-") if p] + [alnum(s) for s in uni_subs]:
        if cand and _RAW.covered(cand):
            for t in _RAW.terms_in(cand):
                if t not in words:
                    words.append(t)
    for t in terms_seen:
        if t not in words:
            words.append(t)
    # Words inside a longer name ("loginsecure9") are found by plain substring as a fallback.
    if not words:
        words = [t for t in sorted(STRONG_TERMS) if len(t) >= 5 and t in plain][:3]
    if words:
        n = min(3, len(words))
        covered = bool(chosen) and all(t in terms_seen for t in words)    # the brand reason already names them
        ev.append((W["term"] * n, "" if covered else "login/payment words in domain: " + ", ".join(words[:4])))

    tld = _tld_of(suffix) if not free_host else ""
    if tld in SUSPICIOUS_TLDS:
        mild = tld in MILD_TLDS
        ev.append((W["tld_mild" if mild else "tld"], f"suspicious TLD .{tld}"))
    elif suffix in _GOV_EDU or tld in _GOV_EDU:
        ev.append((W["gov_edu"], "government or university registry"))

    hyph = ulabel.count("-")
    if hyph >= 3:
        ev.append((W["hyphens3"], "many hyphens in domain"))
    elif hyph == 2:
        ev.append((W["hyphens2"], "multiple hyphens in domain"))
    if len(subs) >= 4:
        ev.append((W["deep"], "unusually many subdomain levels"))
    if len(label) > 30:
        ev.append((W["long"], "very long domain name"))

    r, dfeat = dga.randomness(plain if ulabel.isascii() else "")
    if r >= 0.2 and not chosen:
        ev.append((W["dga"] * (r - 0.2) / 0.8, "name looks randomly generated"))

    logit = PRIOR + sum(w for w, _ in ev)
    features = {"logit": round(logit, 3), "label_len": float(len(label)), "subdomains": float(len(subs)),
                "hyphens": float(hyph), "randomness": round(r, 3), "strong_terms": float(len(words)),
                "brand_hit": 1.0 if chosen else 0.0, "idn": 1.0 if is_idn else 0.0,
                "mixed_script": 1.0 if mixed else 0.0, "suspicious_tld": 1.0 if tld in SUSPICIOUS_TLDS else 0.0,
                "free_host": 1.0 if free_host else 0.0}
    return ("scored", logit, tuple(ev), brand, SUGGEST.get(brand) if brand else None, features, tuple(words))


def _brand_reason(key: str, kind: str, brand: str, terms: list) -> str:
    if key in ("homoglyph", "homoglyph_script"):
        return f"look-alike characters imitate the brand '{brand}'"
    if key == "official_in_sub":
        return f"the real '{brand}' address is used as a subdomain of another site"
    if key == "sub_brand":
        return f"brand '{brand}' appears as a subdomain of an unrelated site"
    if key == "split":
        return f"brand name '{brand}' written with hyphens"
    if key == "combo":
        return f"combines brand '{brand}' with " + (", ".join(f"'{t}'" for t in terms[:3]) if terms else "extra words")
    if key == "brand_words":
        return f"brand name '{brand}' mixed with other words on an unofficial domain"
    if key.startswith("typo"):
        what = {"swap": "swapped letters", "repeat": "doubled letter", "adjacent": "neighbouring-key typo",
                "omit": "missing letter", "insert": "extra letter", "substitute": "changed letter",
                "two": "near-miss spelling"}[kind.split(":")[1]]
        return f"misspelling of brand '{brand}' ({what})"
    return f"contains brand name '{brand}' on an unofficial domain"


def _sigmoid(x: float) -> float:
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    e = math.exp(x)
    return e / (1.0 + e)


def _title_brands(title: str) -> list:
    flat = alnum(title)
    words = {"".join(c for c in w if c.isalnum()) for w in title.lower().split()}
    out = []
    for tok, brand in BRAND_TOKENS.items():
        if brand in out or len(tok) < 4:
            continue
        if tok in words or (len(tok) >= 6 and tok not in AMBIGUOUS_BRANDS and tok in flat):
            out.append(brand)
    return out


def _page_evidence(domain_ev, brand, host_reg: str, signals: dict):
    """Extra (weight, reason) from what the page itself shows. Never lowers a score."""
    out = []
    pw = bool(signals.get("has_password_field"))
    suspect = bool(brand) or any(w > 0.4 for w, _ in domain_ev) and sum(w for w, _ in domain_ev) > 0.9
    if pw:
        out.append((W["pw_suspect"] if suspect else W["pw_plain"], "page has a password/login form"))
    new_brand = None
    title = str(signals.get("title") or "")[:200]
    if title:
        names = _title_brands(title)
        if names:
            new_brand = names[0]
            out.append((W["title_brand"] + (0.8 if pw else 0.0), f"page title names '{names[0]}' on an unofficial site"))
    text = (str(signals.get("title") or "") + " " + str(signals.get("text") or ""))[:3000].lower()
    n = sum(1 for p in _URGENT if p in text)
    if n:
        out.append((min(2, n) * W["urgent"], "page uses urgent account-verification wording"))
    actions = signals.get("form_actions")
    if pw and isinstance(actions, list):
        for act in actions[:10]:
            if isinstance(act, str) and "//" in act:
                host = act.split("//", 1)[1].split("/", 1)[0].split("@")[-1].split(":")[0].lower()
                if host and host != host_reg and not host.endswith("." + host_reg):
                    out.append((W["form_offsite"], "login form sends data to a different site"))
                    break
    if signals.get("hidden_iframes"):
        out.append((W["hidden_iframe"], "page hides embedded frames"))
    ent = signals.get("inline_script_entropy")
    if isinstance(ent, (int, float)) and not isinstance(ent, bool) and ent > 5.5:
        out.append((W["entropy"], "page script looks obfuscated"))
    return out, new_brand


def score_domain(domain: str, signals: dict | None = None) -> dict:
    """Verdict for a host (and optionally what the page showed). Never raises."""
    try:
        res = _analyse(domain.strip().lower()) if isinstance(domain, str) else None
        if res is None:
            return _none()
        if res[0] == "official":
            return _none("official brand domain", brand=res[1], features={"official": 1.0})
        _, logit, ev, brand, official, features, words = res
        reasons_ev = list(ev)
        if isinstance(signals, dict) and signals:
            host = domain.strip().lower()
            if host.startswith("www."):
                host = host[4:]
            extra, new_brand = _page_evidence(ev, brand, host, signals)
            reasons_ev += extra
            logit += sum(w for w, _ in extra)
            if not brand and new_brand:
                brand, official = new_brand, SUGGEST.get(new_brand)
            features = dict(features, page_evidence=round(sum(w for w, _ in extra), 3))
        else:
            features = dict(features)
        # No evidence at all is exactly 0 (not the prior), so ordinary sites read as "nothing found".
        score = round(_sigmoid(logit), 3) if any(w > 0 for w, _ in reasons_ev) else 0.0
        positive = sorted((e for e in reasons_ev if e[0] > 0 and e[1]), key=lambda e: -e[0])
        reasons = [r for _, r in positive[:6]]
        features["logit"] = round(logit, 3)
        return {"score": score, "level": level_of(score), "reasons": reasons, "brand": brand,
                "official": official if score >= 0.25 else None, "features": features}
    except Exception:   # a scorer bug must never break browsing
        return _none()


def combine(verdicts) -> dict:
    """Merge verdicts for the same visit (e.g. URL + page). The strongest one leads; reasons are
    merged in order of the verdict that gave them (at most 6, no repeats)."""
    items = [v for v in (verdicts or []) if isinstance(v, dict)]
    if not items:
        return _none()
    items.sort(key=lambda v: -float(v.get("score") or 0))
    top = items[0]
    reasons = []
    for v in items:
        for r in v.get("reasons") or []:
            if r not in reasons:
                reasons.append(r)
    brand = top.get("brand") or next((v.get("brand") for v in items if v.get("brand")), None)
    official = top.get("official") or next((v.get("official") for v in items if v.get("official")), None)
    score = float(top.get("score") or 0)
    return {"score": score, "level": level_of(score), "reasons": reasons[:6], "brand": brand,
            "official": official, "features": dict(top.get("features") or {})}


def brand_count() -> int:
    return len(BRANDS)
