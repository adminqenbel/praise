"""Load a child's stored policy into the pure engine's PolicyConfig."""
import os
import time

from flask import current_app, has_app_context
from sqlalchemy import event
from sqlalchemy.orm import Session, selectinload

from database.models import Child, DomainRule, Policy, PolicyException, PolicyRule, TldRule
from policy.categories import Action
from policy.decision import PolicyConfig
from policy.presets import preset, preset_settings
from policy.tld_rules import normalize_tlds
from services.site_service import normalize_domain

DEFAULT_PRESET = "child_safe"  # a child with no policy assigned gets the strictest preset


# Flatten the stored policy rows into the plain PolicyConfig the engine understands. No policy means the strictest preset.
def policy_to_config(policy: Policy | None) -> PolicyConfig:
    if policy is None:
        return preset(DEFAULT_PRESET)
    cfg = PolicyConfig(
        category_actions={r.category: Action(r.action) for r in policy.rules},
        allow_domains={d for r in policy.domain_rules if r.action == "ALLOW"
                       if (d := normalize_domain(r.domain))},
        block_domains={d for r in policy.domain_rules if r.action == "BLOCK"
                       if (d := normalize_domain(r.domain))},
        exceptions={d for e in policy.exceptions if (d := normalize_domain(e.domain))},
        allowed_tlds=normalize_tlds(t.tld for t in policy.tld_rules if t.action == "ALLOW"),
        blocked_tlds=normalize_tlds(t.tld for t in policy.tld_rules if t.action == "BLOCK"),
        unknown_action=Action(policy.unknown_action),
        ai_enabled=policy.ai_enabled,
        ai_min_confidence=policy.ai_min_confidence,
        warn_above_risk=int(((policy.settings or {}).get("safe_browsing") or {}).get("warn_above_risk") or 0),
    )
    return cfg


# ---- per-process cache of flattened policies --------------------------------------------------------------------
# /api/ext/check runs for every page, and flattening a policy is five queries. The cache is dropped whenever this
# process commits a change to any policy table (the SQLAlchemy hooks below), and entries also expire after
# POLICY_CACHE_TTL seconds, which bounds how long another worker can serve an older copy after an edit.
_CACHE_KEY = "praise_policy_cache"
_POLICY_TABLES = (Policy, PolicyRule, DomainRule, TldRule, PolicyException)
DEFAULT_CACHE_TTL = 10.0


def _cache() -> dict | None:
    return current_app.extensions.setdefault(_CACHE_KEY, {}) if has_app_context() else None


def clear_policy_cache() -> None:
    cache = _cache()
    if cache is not None:
        cache.clear()


@event.listens_for(Session, "after_flush")
def _note_policy_change(session, _ctx):
    if any(isinstance(o, _POLICY_TABLES) for o in (*session.new, *session.dirty, *session.deleted)):
        session.info["policy_changed"] = True
        clear_policy_cache()


@event.listens_for(Session, "after_commit")
def _policy_committed(session):
    # Clear again once the change is visible: a request that read the old rows between the flush and the
    # commit may have cached them.
    if session.info.pop("policy_changed", False):
        clear_policy_cache()


@event.listens_for(Session, "after_rollback")
def _policy_rolled_back(session):
    session.info.pop("policy_changed", None)


def _cache_ttl() -> float:
    raw = current_app.config.get("POLICY_CACHE_TTL", os.environ.get("POLICY_CACHE_TTL"))
    try:
        return float(raw) if raw not in (None, "") else DEFAULT_CACHE_TTL
    except ValueError:
        return DEFAULT_CACHE_TTL


def config_for_child(child: Child) -> PolicyConfig:
    cache = _cache()
    ttl = _cache_ttl() if cache is not None else 0
    if not ttl:
        return policy_to_config(child.policy)
    now = time.monotonic()
    hit = cache.get(child.policy_id)
    if hit is not None and hit[0] > now:
        return hit[1]
    cfg = policy_to_config(_load_policy(child))
    cache[child.policy_id] = (now + ttl, cfg)
    return cfg


def _load_policy(child: Child) -> Policy | None:
    """The child's policy with its rule lists, in one round of queries instead of one lazy load per list."""
    if child.policy_id is None:
        return None
    return (Policy.query.options(selectinload(Policy.rules), selectinload(Policy.domain_rules),
                                 selectinload(Policy.tld_rules), selectinload(Policy.exceptions))
            .filter_by(id=child.policy_id).one_or_none())


# The JSON copy of a policy that is sent to the extension so it can keep enforcing it offline.
def snapshot(cfg: PolicyConfig, settings: dict | None = None) -> dict:
    return {
        "category_actions": {k: Action(v).value for k, v in cfg.category_actions.items()},
        "allow_domains": sorted(cfg.allow_domains),
        "block_domains": sorted(cfg.block_domains),
        "exceptions": sorted(cfg.exceptions),
        "allowed_tlds": sorted(cfg.allowed_tlds),
        "blocked_tlds": sorted(cfg.blocked_tlds),
        "unknown_action": cfg.unknown_action.value,
        "settings": settings or {},
    }


def create_policy_from_preset(owner_id: int, name: str, preset_name: str) -> Policy:
    """New policy (not yet committed) seeded from a preset's rules and settings."""
    from database.models import PolicyRule
    cfg = preset(preset_name)
    p = Policy(owner_id=owner_id, name=name, preset=preset_name,
               unknown_action=cfg.unknown_action.value, settings=preset_settings(preset_name))
    for cat, action in cfg.category_actions.items():
        p.rules.append(PolicyRule(category=cat, action=action.value))
    return p


def verified_lists(cfg: PolicyConfig, limit: int = 3000) -> dict:
    """What the engine would decide for every verified site under this policy, so the
    extension can keep honouring it while offline. Seeded rows cover subdomains; others
    are exact-match only (mirrors site_service.find_site)."""
    from database.models import Site
    from policy.decision import Level
    from policy.engine import decide
    from services.site_service import to_site_info

    out = {"allow": [], "allow_exact": [], "warn": [], "warn_exact": [], "block": [], "block_exact": []}
    rows = (Site.query.options(selectinload(Site.reputation), selectinload(Site.categories))
            .filter_by(status="ADMIN_VERIFIED").limit(limit).all())
    for site in rows:
        d = decide(to_site_info(site.domain, site), cfg)
        if d.level != Level.ADMIN_VERIFIED:      # a parent rule outranks it; already in the lists
            continue
        # Sort each verified site into the allow / warn / block list, with 'exact' lists for sites that do not cover their subdomains.
        key = {Action.ALLOW: "allow", Action.WARN: "warn"}.get(d.action, "block")
        out[key + ("" if site.source == "seed" else "_exact")].append(site.domain)
    return {k: sorted(v) for k, v in out.items()}
