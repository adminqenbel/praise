"""Domain name handling: public-suffix split, punycode decoding, lookalike skeletons, scripts.

All functions are pure. The Unicode tables live in data.py.
"""
import unicodedata

from .data import CONFUSABLES, HOSTING_SUFFIXES, LEET, MULTI_FOLD, MULTI_SUFFIXES


def split_domain(domain: str) -> tuple[tuple[str, ...], str, str]:
    """(subdomain labels, registrable label, public suffix) for a lowercase host.

    The suffix is the longest known multi-label suffix (co.uk, com.au, github.io, ...) or else the last
    label. `sbi.co.in` -> ((), "sbi", "co.in"); `a.b.paypal.com.evil.xyz` -> (("a","b","paypal","com"), "evil", "xyz").
    A host that is itself a suffix gets an empty label.
    """
    labels = domain.strip(".").split(".")
    n = len(labels)
    suffix_len = 1
    # Longest match first, at most 3 labels (the longest entry we hold).
    for k in (3, 2):
        if n > k - 1 and ".".join(labels[n - k:]) in _SUFFIXES:
            suffix_len = k
            break
    if suffix_len >= n:
        return (), "", ".".join(labels)
    return tuple(labels[:n - suffix_len - 1]), labels[n - suffix_len - 1], ".".join(labels[n - suffix_len:])


_SUFFIXES = MULTI_SUFFIXES | HOSTING_SUFFIXES


def registrable(domain: str) -> str:
    subs, label, suffix = split_domain(domain)
    return f"{label}.{suffix}" if label else suffix


def decode_label(label: str) -> str:
    """Punycode label (xn--...) to Unicode; anything else, or anything malformed, unchanged."""
    if label.startswith("xn--"):
        try:
            return label[4:].encode("ascii").decode("punycode")
        except (UnicodeError, ValueError):
            return label
    return label


def decode_domain(domain: str) -> str:
    return ".".join(decode_label(p) for p in domain.split("."))


def script_of(ch: str) -> str:
    """Coarse Unicode script of a letter: LATIN, CYRILLIC, GREEK, ... or 'OTHER'. Digits and '-' are neutral."""
    if ch.isascii():
        return "LATIN" if ch.isalpha() else "COMMON"
    try:
        name = unicodedata.name(ch)
    except ValueError:
        return "OTHER"
    first = name.split(" ", 1)[0]
    if first in ("CJK", "HIRAGANA", "KATAKANA", "HANGUL", "BOPOMOFO"):
        return "CJK"
    return first if ch.isalpha() else "COMMON"


def scripts_in(label: str) -> frozenset:
    """Scripts of the letters in a label (digits and hyphens excluded)."""
    return frozenset(s for s in map(script_of, label) if s != "COMMON")


def skeleton(text: str) -> str:
    """Fold a name to how it looks: accents and width stripped, Unicode and digit lookalikes mapped to the
    Latin letter they imitate, i/l/1 merged, then rn->m, vv->w, cl->d. Two names with the same skeleton
    are visually confusable. Deliberately lossy: only ever compared against another skeleton."""
    out = []
    for ch in unicodedata.normalize("NFKD", text.lower()):
        if unicodedata.combining(ch):
            continue
        out.append(CONFUSABLES.get(ch) or ch)
    s = "".join(out)
    s = "".join(LEET.get(c, c) for c in s)
    for a, b in MULTI_FOLD:
        s = s.replace(a, b)
    return s


def alnum(text: str) -> str:
    """Letters and digits only (any script), lowercase."""
    return "".join(c for c in text.lower() if c.isalnum())
