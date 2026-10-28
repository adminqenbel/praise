"""Deterministic pre-signals computed before (and independent of) any AI call.

Thin wrapper over the `detection` package (docs/DETECTION-CONTRACT.md): the scoring, brand lists and
public-suffix handling live there. Kept so existing callers keep one import, and so the old
{score, reasons, brand, official} keys stay available. Output feeds the Gemini prompt and is merged
into the final scores.
"""
from detection import score_domain


def phishing_signals(domain: str, signals: dict | None = None) -> dict:
    """Return the detection verdict ({score: 0..1, level, reasons, brand, official, features}). Pure and cached."""
    return score_domain(domain, signals)
