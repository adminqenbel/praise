"""Load a child's stored policy into the pure engine's PolicyConfig."""
from database.models import Child, Policy
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


def config_for_child(child: Child) -> PolicyConfig:
    return policy_to_config(child.policy)


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
    rows = Site.query.filter_by(status="ADMIN_VERIFIED").limit(limit).all()
    for site in rows:
        d = decide(to_site_info(site.domain, site), cfg)
        if d.level != Level.ADMIN_VERIFIED:      # a parent rule outranks it; already in the lists
            continue
        # Sort each verified site into the allow / warn / block list, with 'exact' lists for sites that do not cover their subdomains.
        key = {Action.ALLOW: "allow", Action.WARN: "warn"}.get(d.action, "block")
        out[key + ("" if site.source == "seed" else "_exact")].append(site.domain)
    return {k: sorted(v) for k, v in out.items()}
