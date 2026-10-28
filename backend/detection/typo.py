"""Typosquat matching: bounded Damerau-Levenshtein over a deletion-neighbourhood index (SymSpell).

Indexing every deletion (up to 2 characters) of every brand token means a lookup generates the
deletions of the *query* and probes a dict, instead of comparing against every brand: cost depends on the
query length, not on how many brands there are. Candidates are then verified with the real distance.
"""
from functools import lru_cache
from itertools import combinations

from .data import BENIGN_NEAR, BRAND_TOKENS, KEYBOARD_NEIGHBOURS

MAX_DISTANCE = 2
MIN_LEN = 5             # shorter queries are never fuzzy-matched: too many real words sit one edit away
MAX_QUERY = 24


def osa_distance(a: str, b: str, limit: int = MAX_DISTANCE) -> int:
    """Optimal string alignment distance (insert, delete, substitute, swap adjacent); `limit + 1` when larger."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev2 = None
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        best = cur[0]
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            v = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if prev2 is not None and i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                v = min(v, prev2[j - 2] + 1)
            cur[j] = v
            best = min(best, v)
        if best > limit:
            return limit + 1
        prev2, prev = prev, cur
    return prev[-1]


def _deletes(word: str, depth: int) -> set:
    out = {word}
    for d in range(1, depth + 1):
        if d > len(word):
            break
        for idx in combinations(range(len(word)), d):
            out.add("".join(c for i, c in enumerate(word) if i not in idx))
    return out


def _build_index() -> dict:
    index: dict[str, set] = {}
    for tok in BRAND_TOKENS:
        if len(tok) < MIN_LEN:
            continue
        for d in _deletes(tok, MAX_DISTANCE if len(tok) >= 8 else 1):
            index.setdefault(d, set()).add(tok)
    return index


_INDEX = _build_index()


def classify_edit(query: str, brand: str) -> str | None:
    """How a single-edit typo differs from the brand: swap | repeat | adjacent | omit | insert | substitute.
    None when it is not one edit apart."""
    lq, lb = len(query), len(brand)
    if lq == lb:
        diffs = [i for i in range(lq) if query[i] != brand[i]]
        if len(diffs) == 1:
            i = diffs[0]
            return "adjacent" if query[i] in KEYBOARD_NEIGHBOURS.get(brand[i], ()) else "substitute"
        if len(diffs) == 2 and diffs[1] == diffs[0] + 1 and query[diffs[0]] == brand[diffs[1]] \
                and query[diffs[1]] == brand[diffs[0]]:
            return "swap"
        return None
    if lq == lb + 1:       # one extra character
        for i in range(lq):
            if query[:i] + query[i + 1:] == brand:
                return "repeat" if (i > 0 and query[i] == query[i - 1]) or (i + 1 < lq and query[i] == query[i + 1]) else "insert"
        return None
    if lq == lb - 1:
        for i in range(lb):
            if brand[:i] + brand[i + 1:] == query:
                return "omit"
    return None


# How far we are willing to look, by brand length: short brands are real words, so only the typo kinds
# people actually make by accident (swap, double letter, neighbouring key) count.
def _allowed(brand_len: int) -> int:
    return 0 if brand_len < MIN_LEN else 1 if brand_len < 9 else 2


@lru_cache(maxsize=16384)
def nearest_brand(token: str):
    """Closest brand token within the allowed edits as (brand_token, distance, kind), or None.

    `kind` is classify_edit's label for distance 1 and "two" for distance 2."""
    n = len(token)
    if n < MIN_LEN or n > MAX_QUERY or token in BRAND_TOKENS or token in BENIGN_NEAR:
        return None
    seen = set()
    best = None
    for d in _deletes(token, MAX_DISTANCE if n >= 7 else 1):
        for cand in _INDEX.get(d, ()):
            if cand in seen:
                continue
            seen.add(cand)
            limit = _allowed(len(cand))
            if not limit:
                continue
            dist = osa_distance(token, cand, limit)
            if dist > limit or dist == 0:
                continue
            if dist == 1:
                kind = classify_edit(token, cand)
                # Five-letter brands (chase, venmo, kotak...) are one edit from many ordinary words.
                if len(cand) == MIN_LEN and kind not in ("swap", "repeat", "adjacent"):
                    continue
            else:
                kind = "two"
            if best is None or dist < best[1] or (dist == best[1] and len(cand) > len(best[0])):
                best = (cand, dist, kind)
    return best
