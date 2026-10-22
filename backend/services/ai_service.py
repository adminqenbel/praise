"""Glue: classify an unknown domain, persist the summary (sites) and the full analysis (ai_analyses)."""
from sqlalchemy.exc import SQLAlchemyError

from ai.classifier import AIUnavailable, Classifier, DailyBudget, InvalidAIResponse
from ai.gemini import build_backend
from database.models import AIAnalysis, Site
from database.postgres import db
from services import site_service

# One shared classifier per process, so its daily budget and per-domain locks are shared by every request.
_classifier: Classifier | None = None


def get_classifier(config) -> Classifier:
    global _classifier
    if _classifier is None:
        _classifier = Classifier(build_backend(config),
                                 DailyBudget(int(config.get("AI_DAILY_BUDGET", 500))))
    return _classifier


def set_classifier(c: Classifier | None) -> None:  # tests / hot swap after key is set
    global _classifier
    _classifier = c


def classify_and_store(domain: str, signals: dict | None, config,
                       classified_by: int | None = None) -> Site:
    """Ensure `domain` has a stored classification when possible.

    Returns the Site row. On AIUnavailable / InvalidAIResponse the site stays UNKNOWN and the
    caller applies the policy's unknown-site default.
    """
    site = site_service.get_or_create_site(domain)

    # Used by the classifier: if another request finished this domain while we waited, skip the AI call.
    def _done():
        db.session.refresh(site)
        return ((site.source == "ai" and not site.needs_reanalysis)
                or site.status == "ADMIN_VERIFIED")

    result = get_classifier(config).classify(domain, signals, already_classified=_done)
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
    from ai.heuristics import phishing_signals
    heur = phishing_signals(domain, signals)
    return {"evidence": heur["reasons"][:4], "suggest": heur.get("official")}


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
