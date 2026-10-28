"""Server-side detection: scores how much a domain (and optionally the page) looks like a scam or an imitation.

Interface fixed by docs/DETECTION-CONTRACT.md:
    score_domain(domain, signals=None) -> Verdict dict
    combine(verdicts)                  -> Verdict dict
Detection only supplies evidence; the policy engine decides.
"""
from .score import VERSION, combine, level_of, score_domain

__all__ = ["VERSION", "combine", "level_of", "score_domain"]
