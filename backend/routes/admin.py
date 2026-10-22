"""Dashboard data routes: events/stats (parents, own children only), site intelligence,
and the admin-only review queue for the shared database."""
from datetime import datetime

from flask import Blueprint, g, jsonify, request

from database.models import Child, Site, SiteReview
from database.postgres import db
from policy.categories import ALL_CATEGORY_VALUES, Category
from services import site_service, space_service, stats_service
from services.auth_service import err, login_required
from services.ratelimit import rate_limit
from services.site_service import InvalidTransition

bp = Blueprint("admin", __name__, url_prefix="/api")

# Statuses that need an administrator's attention; the review queue shows these.
QUEUE_STATUSES = ("AI_CLASSIFIED", "PENDING_REVIEW", "REVIEW_REQUIRED", "DISPUTED")


# A site as the dashboard sees it; `detail` adds the category scores and the last 10 reviews.
def _site_json(s: Site, detail=False):
    out = {"id": s.id, "domain": s.domain, "status": s.status, "category": s.category,
           "risk": s.risk, "confidence": s.confidence, "source": s.source,
           "classified_at": s.classified_at.isoformat() if s.classified_at else None,
           "verified_at": s.verified_at.isoformat() if s.verified_at else None,
           "needs_reanalysis": s.needs_reanalysis}
    if detail:
        out["scores"] = {c.category: c.score for c in s.categories}
        out["reviews"] = [{"action": r.action, "previous_category": r.previous_category,
                           "new_category": r.new_category, "note": r.note,
                           "at": r.created_at.isoformat()}
                          for r in sorted(s.reviews, key=lambda r: r.created_at, reverse=True)[:10]]
    return out


# Privacy boundary: activity is only ever read for the caller's own profiles, in the space being shown.
def _owned_child_ids(requested=None):
    q = Child.query.filter_by(parent_id=g.user.id, kind=space_service.child_kind(g.user))   # only the space being shown
    if requested is not None:
        q = q.filter_by(id=requested)
    return [c.id for c in q]


def _child_scope():
    """Returns (child_ids, error_response). `child_id` query param narrows to one child."""
    raw = request.args.get("child_id")
    if raw is None:
        return _owned_child_ids(), None
    if not raw.isdigit():
        return None, err("invalid child_id", 400)
    ids = _owned_child_ids(int(raw))
    return (ids, None) if ids else (None, err("not found", 404))


# ---- parent: activity ------------------------------------------------------------------

# Numbers and chart data for the home page (blocked, unknown sites, downloads, cookies...).
@bp.get("/stats")
@login_required()
def stats():
    ids, bad = _child_scope()
    if bad:
        return bad
    days = request.args.get("days", "7")
    days = int(days) if days.isdigit() else 7
    if not ids:
        return jsonify(stats_service.dashboard_stats([-1], days))
    return jsonify(stats_service.dashboard_stats(ids, days))


# Activity lists (browser, cookie, download, security) with paging and an optional type filter.
@bp.get("/events")
@login_required()
def events():
    ids, bad = _child_scope()
    if bad:
        return bad
    kind = request.args.get("kind", "browser")
    if kind not in stats_service.KIND_COLLECTIONS:
        return err("unknown kind", 400)
    limit = request.args.get("limit", "50")
    before = None
    if request.args.get("before"):
        try:
            before = datetime.fromisoformat(request.args["before"])
        except ValueError:
            return err("invalid before", 400)
    extra = {}
    if request.args.get("type"):
        extra["type"] = request.args["type"][:40]
    docs = stats_service.recent_events(ids or [-1], kind, int(limit) if limit.isdigit() else 50,
                                       before, extra)
    return jsonify(events=docs)


# ---- site intelligence (any signed-in user; global data only) --------------------------------

# Search the shared site database. It holds only public website facts, never anything about a person.
@bp.get("/sites")
@login_required()
def list_sites():
    q = Site.query
    if s := request.args.get("status"):
        q = q.filter_by(status=s)
    if c := request.args.get("category"):
        q = q.filter_by(category=c)
    if d := request.args.get("q"):
        q = q.filter(Site.domain.ilike("%" + d.replace("%", "").replace("_", "")[:100] + "%"))
    limit = request.args.get("limit", "50")
    rows = q.order_by(Site.risk.desc().nullslast(), Site.id.desc()).limit(
        min(int(limit) if limit.isdigit() else 50, 200)).all()
    return jsonify(sites=[_site_json(s) for s in rows])


@bp.get("/sites/<path:domain>")
@login_required()
def get_site(domain):
    d = site_service.normalize_domain(domain)
    site = site_service.get_site(d) if d else None
    return jsonify(_site_json(site, detail=True)) if site else err("not found", 404)


@bp.post("/sites/<path:domain>/dispute")
@login_required()
@rate_limit("dispute", 20, 3600, key_fn=lambda: f"u{g.user.id}")
def dispute_site(domain):
    """A parent thinks a classification is wrong: flag it for admin review."""
    d = site_service.normalize_domain(domain)
    site = site_service.get_site(d) if d else None
    if site is None:
        return err("not found", 404)
    note = str((request.get_json(silent=True) or {}).get("note", ""))[:500]
    # A verified classification is shared by every family: one parent's disagreement must not
    # change it. For those sites only the dispute is recorded and an admin decides.
    if site.status != "ADMIN_VERIFIED":
        try:
            site_service.transition(site, "REVIEW_REQUIRED")
        except InvalidTransition:
            return err("this site can't be disputed in its current state", 409)
    db.session.add(SiteReview(site_id=site.id, reviewer_id=g.user.id, action="DISPUTE",
                              previous_category=site.category, note=note or None))
    db.session.commit()
    return jsonify(_site_json(site))


# ---- admin: review queue ----------------------------------------------------------------------

# Admin only: sites waiting for a human decision, riskiest first, plus verified sites a parent has disputed.
@bp.get("/admin/reviews")
@login_required("admin")
def review_queue():
    statuses = request.args.getlist("status") or list(QUEUE_STATUSES)
    if not set(statuses) <= set(QUEUE_STATUSES):
        return err("invalid status", 400)
    rows = (Site.query.filter(Site.status.in_(statuses))
            .order_by(Site.risk.desc().nullslast(), Site.id).limit(200).all())
    if not request.args.getlist("status"):
        rows += _verified_with_open_dispute()
    return jsonify(sites=[_site_json(s, detail=True) for s in rows])


def _verified_with_open_dispute():
    """Verified sites a parent has disputed and no admin has looked at since."""
    out = []
    candidates = (Site.query.filter(Site.status == "ADMIN_VERIFIED").join(SiteReview)
                  .filter(SiteReview.action == "DISPUTE").distinct().all())
    for s in candidates:
        last = max(r.created_at for r in s.reviews if r.action == "DISPUTE")
        if not any(r.action != "DISPUTE" and r.created_at > last for r in s.reviews):
            out.append(s)
    return out


# Admin only: how many sites are in each lifecycle status.
@bp.get("/admin/overview")
@login_required("admin")
def admin_overview():
    rows = db.session.query(Site.status, db.func.count(Site.id)).group_by(Site.status).all()
    return jsonify(sites_by_status={s: n for s, n in rows})


# Admin only: record a decision. CONFIRM_BLOCK, ALLOW and CHANGE_CATEGORY verify the site for every family; REANALYZE asks the AI to look again.
@bp.post("/admin/reviews/<int:site_id>")
@login_required("admin")
def review_site(site_id):
    site = db.session.get(Site, site_id)
    if site is None:
        return err("not found", 404)
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    note = str(data.get("note", ""))[:500] or None
    previous = site.category
    category = data.get("category")

    if category is not None and category not in ALL_CATEGORY_VALUES:
        return err("unknown category", 400)

    try:
        if action == "CONFIRM_BLOCK":
            if not site.category or site.category in (Category.GENERAL.value, Category.EDUCATION.value):
                return err("nothing to confirm: choose a category with CHANGE_CATEGORY", 400)
            _verify(site)
        elif action == "ALLOW":
            site.category = category or Category.GENERAL.value
            site.risk = min(site.risk if site.risk is not None else 0, 10)
            _verify(site)
        elif action == "CHANGE_CATEGORY":
            if not category:
                return err("category required", 400)
            site.category = category
            _verify(site)
        elif action == "REANALYZE":
            site_service.transition(site, "REVIEW_REQUIRED")
            site.needs_reanalysis = True
        else:
            return err("invalid action", 400)
    except InvalidTransition:
        return err("action not allowed in the site's current state", 409)

    # Keep an audit trail of who decided what, and what the category was before.
    db.session.add(SiteReview(site_id=site.id, reviewer_id=g.user.id, action=action,
                              previous_category=previous, new_category=site.category, note=note))
    db.session.commit()
    return jsonify(_site_json(site, detail=True))


# Mark a site as verified by a person. From now on a new AI result can never overwrite it.
def _verify(site: Site):
    site.source = "admin"
    site.needs_reanalysis = False
    site_service.transition(site, "ADMIN_VERIFIED")
    if site.verified_at is None:  # already-verified sites re-confirmed by another admin
        from datetime import timezone
        site.verified_at = datetime.now(timezone.utc)
