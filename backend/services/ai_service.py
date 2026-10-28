"""Glue: classify an unknown domain, persist the summary (sites) and the full analysis (ai_analyses)."""
import threading
import time

from sqlalchemy.exc import SQLAlchemyError

from ai.classifier import AIUnavailable, Classifier, DailyBudget, InvalidAIResponse
from ai.gemini import build_backend
from database.models import AIAnalysis, Site
from database.postgres import db
from services import site_service

# One shared classifier per process, so its daily budget and per-domain locks are shared by every request.
_classifier: Classifier | None = None


class SharedDailyBudget:
    """The AI daily call cap counted in the database, so several workers share one budget instead of each
    spending the whole cap. Counts per UTC day. Falls back to a per-process count if the database is unreachable
    (the cap then errs on the side of spending less than the shared total, never more per worker)."""

    def __init__(self, limit: int):
        self.limit = limit
        self._local = DailyBudget(limit)

    def take(self) -> bool:
        from services import ratelimit
        if not ratelimit.shared_enabled():
            return self._local.take()
        day = int(time.time() // 86400)
        try:
            return ratelimit.shared_take("ai-daily-budget", day, self.limit, (day + 2) * 86400)
        except SQLAlchemyError:
            db.session.rollback()
            return self._local.take()


def get_classifier(config) -> Classifier:
    global _classifier
    if _classifier is None:
        limit = int(config.get("AI_DAILY_BUDGET", 500))
        from services import ratelimit
        _classifier = Classifier(build_backend(config),
                                 SharedDailyBudget(limit) if ratelimit.shared_enabled() else DailyBudget(limit))
    return _classifier


def set_classifier(c: Classifier | None) -> None:  # tests / hot swap after key is set
    global _classifier
    _classifier = c
    with _failed_lock:
        _failed.clear()


# Negative cache: a domain whose classification just failed (provider down, bad answer, budget spent) is not
# sent to the provider again for a minute. Without it every page load of that site, from every device, waits
# out another failing call and spends budget; the policy's unknown-site default applies meanwhile.
FAILURE_TTL = 60.0
_MAX_FAILED = 2048
_failed: dict[str, float] = {}
_failed_lock = threading.Lock()


def _recently_failed(domain: str) -> bool:
    with _failed_lock:
        until = _failed.get(domain)
        if until is None:
            return False
        if until <= time.monotonic():
            del _failed[domain]
            return False
        return True


def _remember_failure(domain: str) -> None:
    now = time.monotonic()
    with _failed_lock:
        if len(_failed) >= _MAX_FAILED:                      # bound memory: drop expired, then the oldest
            for k in [k for k, v in _failed.items() if v <= now] or [min(_failed, key=_failed.get)]:
                del _failed[k]
        _failed[domain] = now + FAILURE_TTL


def classify_and_store(domain: str, signals: dict | None, config,
                       classified_by: int | None = None) -> Site:
    """Ensure `domain` has a stored classification when possible.

    Returns the Site row. On AIUnavailable / InvalidAIResponse the site stays UNKNOWN and the
    caller applies the policy's unknown-site default.
    """
    if _recently_failed(domain):
        raise AIUnavailable("classification failed recently")
    site = site_service.get_or_create_site(domain)

    # Used by the classifier: if another request finished this domain while we waited, skip the AI call.
    def _done():
        db.session.refresh(site)
        return ((site.source == "ai" and not site.needs_reanalysis)
                or site.status == "ADMIN_VERIFIED")

    try:
        result = get_classifier(config).classify(domain, signals, already_classified=_done)
    except (AIUnavailable, InvalidAIResponse):
        _remember_failure(domain)
        raise
    if result is None:
        return site  # another request classified it first

    # The provider call took seconds. Re-read the row under a lock so an admin verification made
    # in that window is seen (and wins) instead of being overwritten by this stale object.
    site = Site.query.filter_by(id=site.id).with_for_update().one()
    stored = site_service.record_ai_result(
        site, result.top_category, result.risk_score, result.confidence, result.categories,
        classified_by)
    db.session.commit()
    if stored:
        _log_analysis(result)
    return site


def threat_context(domain: str, signals: dict | None = None) -> dict:
    """Plain-language reasons for a warning, plus the real site when this imitates a brand.

    Reasons come ONLY from our own deterministic checks. The AI's free-text evidence is derived from the
    page's content, which an attacker controls: a scam page could make the model "explain" itself with
    a phone number or instructions, and that text would then appear inside a trusted warning. The
    evidence stays in ai_analyses for administrators; it is never sent to the person's browser.
    """
    from detection import clean_page_signals, score_domain
    verdict = score_domain(domain, clean_page_signals(signals) or None)
    return {"evidence": verdict["reasons"][:4], "suggest": verdict.get("official")}


# Keep the full AI answer for administrators. Best effort: the decision itself is already committed on the site row.
def _log_analysis(result) -> None:
    try:
        db.session.add(AIAnalysis(
            domain=result.domain, model=str(result.model)[:64], risk_score=result.risk_score,
            confidence=result.confidence, categories=result.categories, evidence=result.evidence,
            heuristics=result.heuristics))
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()


__all__ = ["classify_and_store", "get_classifier", "set_classifier",
           "AIUnavailable", "InvalidAIResponse"]
