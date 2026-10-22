"""Site intelligence: URL normalization, lookup, and lifecycle transitions."""
from datetime import datetime, timezone
from ipaddress import ip_address
from urllib.parse import urlsplit

from database.models import Site, SiteCategory
from database.postgres import db
from ai.heuristics import phishing_signals
from policy.decision import SiteInfo

# Legal lifecycle transitions. ADMIN_VERIFIED can only be left via explicit
# admin re-review (DISPUTED / RECLASSIFIED), never by a new AI result.
TRANSITIONS = {
    "UNKNOWN": {"AI_CLASSIFIED", "PENDING_REVIEW", "ADMIN_VERIFIED"},
    "AI_CLASSIFIED": {"PENDING_REVIEW", "ADMIN_VERIFIED", "DISPUTED", "REVIEW_REQUIRED"},
    "PENDING_REVIEW": {"ADMIN_VERIFIED", "DISPUTED", "RECLASSIFIED", "REVIEW_REQUIRED"},
    "ADMIN_VERIFIED": {"DISPUTED", "RECLASSIFIED", "REVIEW_REQUIRED"},
    "DISPUTED": {"ADMIN_VERIFIED", "RECLASSIFIED", "PENDING_REVIEW"},
    "RECLASSIFIED": {"PENDING_REVIEW", "ADMIN_VERIFIED"},
    "REVIEW_REQUIRED": {"PENDING_REVIEW", "ADMIN_VERIFIED", "AI_CLASSIFIED"},
}


class InvalidTransition(ValueError):
    pass


def normalize_domain(url_or_host: str) -> str | None:
    """Return a lowercase ASCII (punycode) hostname, or None if unusable.

    Strips scheme, credentials, port, path, trailing dot and a leading 'www.'.
    IP literals and single-label hosts are rejected (not classifiable as sites).
    """
    # Accept a bare host or a full URL; anything that cannot be a normal website name is rejected.
    raw = (url_or_host or "").strip()
    if not raw or len(raw) > 2048:
        return None
    if "://" not in raw:
        raw = "//" + raw
    try:
        host = urlsplit(raw).hostname
    except ValueError:
        return None
    if not host:
        return None
    host = host.strip(".").lower()
    try:
        # Raw IP addresses are not websites we can classify.
        ip_address(host)
        return None
    except ValueError:
        pass
    try:
        # Convert look-alike Unicode names to punycode (xn--...) so they cannot hide as a real brand.
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return None
    if host.startswith("www."):
        host = host[4:]
    if "." not in host or len(host) > 253:
        return None
    return host


# Exact lookup by registrable domain.
def get_site(domain: str) -> Site | None:
    return Site.query.filter_by(domain=domain).one_or_none()


def find_site(domain: str) -> Site | None:
    """Exact match first; otherwise the nearest *seeded* ancestor (accounts.google.com ->
    google.com). Only seed rows cover subdomains: a normal row for blogspot.com must not
    vouch for every blog hosted on it."""
    site = get_site(domain)
    if site is not None:
        return site
    parts = domain.split(".")
    for i in range(1, len(parts) - 1):          # never match a bare TLD
        ancestor = get_site(".".join(parts[i:]))
        if ancestor is not None and ancestor.source == "seed":
            return ancestor
    return None


# Fetch the row for a domain, creating an UNKNOWN one the first time it is seen.
def get_or_create_site(domain: str) -> Site:
    site = get_site(domain)
    if site is None:
        site = Site(domain=domain)
        db.session.add(site)
        db.session.flush()
    return site


# Move a site to a new lifecycle status, refusing moves that are not in TRANSITIONS.
def transition(site: Site, new_status: str) -> None:
    if new_status == site.status:
        return
    if new_status not in TRANSITIONS.get(site.status, set()):
        raise InvalidTransition(f"{site.status} -> {new_status}")
    site.status = new_status
    if new_status == "ADMIN_VERIFIED":
        site.verified_at = datetime.now(timezone.utc)


def record_ai_result(site: Site, category: str, risk: int, confidence: float,
                     scores: dict, classified_by: int | None = None) -> bool:
    """Store an AI classification. Never overwrites an admin-verified site.

    Returns True if stored. Callers keep the full AI response in Mongo.
    """
    if site.status == "ADMIN_VERIFIED":
        return False
    site.category = category
    site.risk = max(0, min(100, int(risk)))
    site.confidence = max(0.0, min(1.0, float(confidence)))
    site.source = "ai"
    site.classified_by = classified_by
    site.classified_at = datetime.now(timezone.utc)
    site.needs_reanalysis = False
    SiteCategory.query.filter_by(site_id=site.id).delete()
    for cat, score in scores.items():
        db.session.add(SiteCategory(site_id=site.id, category=cat, score=float(score)))
    # Replace the old per-category scores with the new ones and mark the site as AI-classified.
    if site.status in ("UNKNOWN", "REVIEW_REQUIRED"):
        site.status = "AI_CLASSIFIED"
    return True


# An AI verdict at or above this risk only ever makes things stricter, so every family may
# rely on it. Below it the verdict would *loosen* restrictions, and its page signals came from
# one (untrusted) device, so other families ignore it until an admin verifies the site.
AI_SHARE_RISK = 50


def to_site_info(domain: str, site: Site | None, viewer_id: int | None = None) -> SiteInfo:
    """`viewer_id` is the parent whose child is asking; None skips the trust rule (admin views)."""
    lookalike = phishing_signals(domain)["score"]
    if site is None:
        return SiteInfo(domain=domain, lookalike=lookalike)
    flag = site.reputation[0].flag if site.reputation else None
    # Trust rule: a low-risk AI verdict came from one family's device, so other families don't rely on it until an admin verifies the site.
    if (viewer_id is not None and site.source == "ai" and site.status != "ADMIN_VERIFIED"
            and site.classified_by != viewer_id
            and (site.risk if site.risk is not None else 0) < AI_SHARE_RISK):
        return SiteInfo(domain=domain, status="AI_UNTRUSTED", reputation_flag=flag, lookalike=lookalike)
    return SiteInfo(
        domain=domain, status=site.status, category=site.category, risk=site.risk,
        confidence=site.confidence, source=site.source, reputation_flag=flag,
        needs_reanalysis=site.needs_reanalysis, lookalike=lookalike,
        category_scores={c.category: c.score for c in site.categories},
    )
