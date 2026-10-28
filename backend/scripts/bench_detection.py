"""Benchmark and accuracy comparison: the previous heuristic (kept below for reference) vs backend/detection.

    cd backend; python scripts/bench_detection.py [--rounds 10] [--n 20000]

Prints microseconds per call and calls per second, uncached (every call sees a new name) and cached (repeat
visits), then precision/recall of both scorers on the labelled corpus in tests/detection_corpus.py.
"""
import argparse
import pathlib
import re
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from detection import score as _score_mod                                   # noqa: E402
from detection import score_domain                                            # noqa: E402
from services.site_service import normalize_domain                            # noqa: E402
from tests.detection_corpus import BAD, HELDOUT_BAD, HELDOUT_LEGIT, LEGIT     # noqa: E402

# ---- the heuristic this package replaced (same logic, for comparison only) -------------------------------
_KNOWN = {"paypal", "paytm", "phonepe", "gpay", "googlepay", "hdfc", "hdfcbank", "icici", "icicibank", "sbi",
          "onlinesbi", "axisbank", "kotak", "barclays", "hsbc", "chase", "wellsfargo", "bankofamerica",
          "citibank", "binance", "coinbase", "razorpay", "stripe", "venmo", "zerodha", "upstox", "groww"}
_OFFICIAL = {"paypal.com", "paytm.com", "phonepe.com", "hdfcbank.com", "icicibank.com", "onlinesbi.sbi",
             "sbi.co.in", "axisbank.com", "kotak.com", "barclays.co.uk", "hsbc.com", "chase.com",
             "wellsfargo.com", "bankofamerica.com", "citi.com", "binance.com", "coinbase.com", "razorpay.com",
             "stripe.com", "venmo.com", "zerodha.com", "upstox.com", "groww.in"}
_TERMS = ("bank", "login", "signin", "secure", "verify", "account", "wallet", "pay", "upi", "kyc", "update",
          "billing", "netbanking", "otp")
_TLDS = {".xyz", ".top", ".click", ".icu", ".work", ".buzz", ".gq", ".tk", ".ml", ".cf", ".ga", ".cyou",
         ".rest", ".live"}
_NON = re.compile(r"[^a-z0-9]")


def legacy_phishing_signals(domain, signals=None):
    signals = signals or {}
    domain = domain.lower()
    score = 0.0
    if any(domain == d or domain.endswith("." + d) for d in _OFFICIAL):
        return {"score": 0.0}
    flat = _NON.sub("", domain.rsplit(".", 1)[0])
    brand = next((b for b in sorted(_KNOWN, key=len, reverse=True) if b in flat), None)
    if brand:
        score += 0.4
    terms = [t for t in _TERMS if t in flat]
    if terms:
        score += min(0.2, 0.07 * len(terms))
    if "." + domain.rsplit(".", 1)[-1] in _TLDS:
        score += 0.15
    if domain.count("-") >= 2:
        score += 0.1
    if signals.get("has_password_field"):
        score += 0.15 if (brand or terms) else 0.05
    return {"score": round(min(score, 1.0), 2)}


# ---- timing ----------------------------------------------------------------------------------------------
def _clear():
    _score_mod._analyse.cache_clear()
    _score_mod._base_verdict.cache_clear()


def _names():
    base = [d for d, _ in LEGIT] + [d for d, _ in BAD] + HELDOUT_LEGIT + [d for d, _ in HELDOUT_BAD]
    return [normalize_domain(d) or d for d in base]


def _unique_variants(names, n):
    """n distinct hosts shaped like the corpus (so the uncached path is exercised on every call)."""
    out = []
    i = 0
    while len(out) < n:
        for name in names:
            label, _, rest = name.partition(".")
            out.append(f"{label}{i}.{rest}" if i else name)
            if len(out) == n:
                break
        i += 1
    return out


def _time(fn, items, rounds=1):
    best = float("inf")
    for _ in range(rounds):
        t = time.perf_counter()
        for d in items:
            fn(d)
        best = min(best, time.perf_counter() - t)
    return best / len(items) * 1e6


def _quality(fn, flag=0.5):
    legit = [normalize_domain(d) or d for d, _ in LEGIT] + [normalize_domain(d) or d for d in HELDOUT_LEGIT]
    bad = [normalize_domain(d) or d for d, _ in BAD] + [normalize_domain(d) or d for d, _ in HELDOUT_BAD]
    tp = sum(fn(d)["score"] >= flag for d in bad)
    fp = sum(fn(d)["score"] >= flag for d in legit)
    off = [normalize_domain(d) or d for d, o in LEGIT if o]
    off_flagged = sum(fn(d)["score"] > 0 for d in off)
    return tp / len(bad), (tp / (tp + fp) if tp + fp else 1.0), fp, off_flagged, len(bad), len(legit)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=10)
    ap.add_argument("--n", type=int, default=20000, help="distinct hosts for the uncached run")
    args = ap.parse_args()

    names = _names()
    fresh = _unique_variants(names, args.n)
    print(f"corpus: {len(names)} hosts; uncached run: {len(fresh)} distinct hosts\n")

    legacy = _time(legacy_phishing_signals, fresh, args.rounds)
    _clear()
    # uncached: each host is new, so every call pays for the full analysis (one pass, cache cleared first)
    cold = _time(score_domain, fresh, 1)
    _clear()
    for d in names:
        score_domain(d)
    warm = _time(score_domain, names * 50, args.rounds)
    print(f"{'scorer':28s} {'us/call':>10s} {'calls/s':>12s}")
    print(f"{'legacy heuristic':28s} {legacy:10.2f} {1e6 / legacy:12,.0f}")
    print(f"{'detection (uncached)':28s} {cold:10.2f} {1e6 / cold:12,.0f}")
    print(f"{'detection (cached repeat)':28s} {warm:10.2f} {1e6 / warm:12,.0f}")

    print("\nquality on the labelled corpus (flag = score >= 0.5; official domains must stay at 0)")
    print(f"{'scorer':28s} {'recall':>8s} {'precision':>10s} {'false+':>7s} {'official hit':>13s}")
    for label, fn in (("legacy heuristic", legacy_phishing_signals), ("detection", score_domain)):
        rec, prec, fp, off, nb, nl = _quality(fn)
        print(f"{label:28s} {rec:8.3f} {prec:10.3f} {fp:7d} {off:13d}")
    print(f"({nb} phishing-style hosts, {nl} legitimate hosts)")


if __name__ == "__main__":
    main()
