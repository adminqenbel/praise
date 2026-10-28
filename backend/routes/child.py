"""Extension-facing API (device-token auth)."""
import logging

from flask import Blueprint, current_app, g, jsonify, request

import detection
from ai.classifier import AIUnavailable, InvalidAIResponse
from ai.companion_llm import get_companion
from database.postgres import db
from policy.categories import Action
from policy.decision import Level
from policy.engine import decide
from services import ai_service, event_service, policy_service, site_service, space_service
from services.auth_service import device_required, err, redeem_disconnect_code, verify_password
from services.ratelimit import limiter, rate_limit

# Everything under /api/ext is called by the browser extension and is authenticated by its device token, not by a login.
bp = Blueprint("child", __name__, url_prefix="/api/ext")
log = logging.getLogger("praise.security")
MAX_PASSWORD = 256   # cap work done hashing a password typed into a browser

# Limits: how many new-site AI checks one family may trigger, and how long (seconds) the extension may cache each kind of answer.
AI_CALLS_PER_FAMILY = 40   # new-site classifications per parent per 10 minutes
CACHE_TTL_SECONDS = {Action.ALLOW: 3600, Action.BLOCK: 3600, Action.REVIEW: 60, Action.ASK: 60,
                     Action.WARN: 600}


def _needs_ai(site_info, decision, cfg) -> bool:
    """Call the classifier only for sites with no stored classification whose outcome
    was not already settled by a parent rule, verified data, reputation or a TLD block."""
    if not cfg.ai_enabled:
        return False
    if site_info.needs_reanalysis and site_info.status != "ADMIN_VERIFIED":
        return decision.level != Level.PARENT_RULE  # fresh AI pass requested by an admin
    if site_info.source != "none" or site_info.status != "UNKNOWN":
        return False
    if decision.level == Level.TLD:
        return decision.action != Action.BLOCK  # a blocked TLD is final; no AI spend
    return decision.level == Level.UNKNOWN_DEFAULT  # even when the default is BLOCK, we want the category


@bp.post("/disconnect")
@device_required
@rate_limit("disconnect", 5, 600, key_fn=lambda: f"dev{g.device.id}", shared=True)
def disconnect():
    """The browser asks to leave its account. An adult protecting themselves just confirms; on a family
    account the browser belongs to a child, so a parent has to agree (otherwise the child could simply switch the
    protection off): a one-time disconnect code from the dashboard, or the parent's password. The popup's one field
    takes either and sends it as `code`; older extensions send `password`. Either way the device is revoked here, so
    the dashboard shows it gone."""
    body = request.get_json(silent=True) or {}
    parent = g.device.child.parent
    if space_service.mode_of_child(g.device.child) == "family":
        code = str(body.get("code", ""))[:MAX_PASSWORD]
        password = str(body.get("password", "")) or code
        if not redeem_disconnect_code(g.device, code) and \
                (len(password) > MAX_PASSWORD or not verify_password(password, parent.password_hash)):
            db.session.commit()                       # an expired code is cleared
            log.warning("failed disconnect attempt device=%s", g.device.id)
            return err("That isn't a current disconnect code from the parent's dashboard.", 403)
    g.device.revoked = True
    g.device.token_hash = None
    g.device.pairing_code_hash = None
    db.session.commit()
    return jsonify(ok=True)


@bp.post("/companion-line")
@device_required
@rate_limit("companion", 30, 60, key_fn=lambda: f"dev{g.device.id}")
def companion_line():
    """Reword a buddy's template line with the optional local model. Always answers 200: a null line
    means "keep the template" (model off, slow, or its answer didn't pass the safety check)."""
    body = request.get_json(silent=True) or {}
    companion = get_companion(current_app.config)
    line = companion.rephrase(str(body.get("who", "family")), str(body.get("line", ""))[:200], str(body.get("kind", ""))) if companion.enabled else None
    return jsonify(line=line)


@bp.post("/chat")
@device_required
@rate_limit("chat", 12, 60, key_fn=lambda: f"dev{g.device.id}")
def chat():
    """A message to the buddy from the browser pet or popup. Always answers 200: a null reply means "answer from your own
    lines" (model off or slow, the message needs a person's care or holds personal details, or the answer failed the
    check). `off` is true when a parent has switched the chat off. The message is used to make one answer and nothing
    more: it is never logged or stored."""
    body = request.get_json(silent=True) or {}
    child = g.device.child
    mode = space_service.mode_of_child(child)
    settings = child.policy.settings if child.policy and child.policy.settings else {}
    if mode == "family" and (settings.get("companion") or {}).get("chat") is False:
        return jsonify(reply=None, off=True)
    companion = get_companion(current_app.config)
    audience = "adult" if mode == "adult" else "child"
    reply = companion.chat(audience, body.get("message"), body.get("history")) if companion.enabled else None
    return jsonify(reply=reply, off=False)


# The main endpoint: the extension sends a URL and gets back what to do with it.
# Steps: normalise the domain -> look it up -> let the policy engine decide -> only if the site is new, ask the AI -> decide again -> log the event.
@bp.post("/check")
@device_required
@rate_limit("check", 120, 60, key_fn=lambda: f"dev{g.device.id}")
def check():
    body = request.get_json(silent=True) or {}
    url = str(body.get("url", ""))
    domain = site_service.normalize_domain(url)
    if domain is None:
        return err("unclassifiable URL", 400)

    child = g.device.child
    cfg = policy_service.config_for_child(child)

    site = site_service.find_site(domain)
    info = site_service.to_site_info(domain, site, child.parent_id)
    # Once the extension has sent what the page shows, score the page too (a login form, a brand in the title
    # on an unrelated domain). Evidence only: it raises the look-alike score the engine's step 3b reads, and
    # parent rules and verified sites still outrank it.
    page = detection.clean_page_signals(body.get("signals"))
    if page:
        info.lookalike = max(info.lookalike, detection.score_domain(domain, page)["score"])
    decision = decide(info, cfg)

    ai_state = "not_needed"
    if _needs_ai(info, decision, cfg):
        if "signals" not in body:
            # The extension gathers page signals itself (before rendering the page) and
            # re-sends. `signals: {}` means "none available"; AI then uses the domain only.
            return jsonify(domain=domain, ai="need_signals", need_signals=True,
                           cache_ttl=0, **decision.to_dict())
        # One family can't spend the shared AI budget: per-parent ceiling across all their devices.
        if current_app.config.get("RATELIMIT_ENABLED", True) and \
                not limiter.allow(f"ai:user{child.parent_id}", AI_CALLS_PER_FAMILY, 600, shared=True)[0]:
            ai_state = "unavailable"
        else:
            try:
                site = ai_service.classify_and_store(domain, body.get("signals"), current_app.config,
                                                     classified_by=child.parent_id)
                info = site_service.to_site_info(domain, site, child.parent_id)
                if page:
                    info.lookalike = max(info.lookalike, detection.score_domain(domain, page)["score"])
                decision = decide(info, cfg)
                ai_state = "classified"
            except (AIUnavailable, InvalidAIResponse):
                ai_state = "unavailable"  # keep the unknown-site default decision

    # Every check is logged (child, device, URL, decision) in the events table for the parent's activity view.
    event_service.record("browser", child.id, g.device.id, {
        "url": url[:2000], "domain": domain, "decision": decision.to_dict(), "ai": ai_state})

    # For warnings and blocks that came from our own checks, add plain-language reasons and the real site to suggest.
    context = {}
    if decision.action in (Action.WARN, Action.BLOCK) and decision.level != Level.PARENT_RULE:
        context = ai_service.threat_context(domain, body.get("signals"))
    return jsonify(domain=domain, ai=ai_state, cache_ttl=CACHE_TTL_SECONDS[decision.action],
                   **decision.to_dict(), **context)


# Gives the extension a copy of the account's policy and the verified-site lists, so it can keep enforcing them if the server is unreachable.
@bp.get("/policy-sync")
@device_required
def policy_sync():
    child = g.device.child
    cfg = policy_service.config_for_child(child)
    settings = child.policy.settings if child.policy else {}
    return jsonify({**policy_service.snapshot(cfg, settings),
                    "verified": policy_service.verified_lists(cfg), "child": child.name,
                    "mode": space_service.mode_of_child(child)})


# The extension uploads batches of activity here (cookies, downloads, security events).
@bp.post("/events")
@device_required
@rate_limit("events", 30, 60, key_fn=lambda: f"dev{g.device.id}")
def events():
    body = request.get_json(silent=True) or {}
    ok, bad = event_service.record_batch(body.get("events"), g.device.child_id, g.device.id)
    return jsonify(accepted=ok, rejected=bad)
