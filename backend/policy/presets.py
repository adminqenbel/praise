from .categories import GROUPS, Action, Category
from .decision import PolicyConfig


# Build a category->action map: everything in `block` is blocked, everything in `allow` is allowed.
def _actions(block=(), allow=()):
    out = {c.value: Action.ALLOW for c in allow}
    out.update({c.value: Action.BLOCK for c in block})
    return out


# Categories every family preset blocks: adult content, money, and security threats.
_BLOCKED_CORE = GROUPS["content"] + GROUPS["financial"] + GROUPS["security"]


# Starting rule sets: Child Safe, Teen, Education and Custom for families, plus the three Shield levels for adults.
def preset(name: str) -> PolicyConfig:
    if name == "child_safe":
        return PolicyConfig(
            category_actions=_actions(block=_BLOCKED_CORE + [Category.SOCIAL_MEDIA, Category.DATING]),
            unknown_action=Action.BLOCK)
    if name == "teen":
        return PolicyConfig(
            category_actions=_actions(block=_BLOCKED_CORE + [Category.DATING],
                                      allow=[Category.SOCIAL_MEDIA]),
            unknown_action=Action.REVIEW)
    if name == "education":
        return PolicyConfig(
            category_actions=_actions(
                block=_BLOCKED_CORE + [Category.SOCIAL_MEDIA, Category.DATING],
                allow=[Category.EDUCATION, Category.RESEARCH]),
            unknown_action=Action.REVIEW)
    if name in SHIELD_PRESETS:
        return PolicyConfig(category_actions=SHIELD_PRESETS[name]["actions"],
                            unknown_action=Action.ALLOW,
                            warn_above_risk=SHIELD_PRESETS[name]["settings"]["safe_browsing"]["warn_above_risk"])
    if name == "custom":
        return PolicyConfig()
    raise ValueError(f"unknown preset {name!r}")


# ---- adult version ("Praise Shield"): the person protects themselves --------------------------
def _w(*cats):
    return {c.value: Action.WARN for c in cats}


# Build one Shield preset: category actions plus the settings groups (safe browsing, privacy, sensitive data, passwords, cookies).
def _shield(actions, warn_risk, **over):
    settings = {
        "safe_browsing": {"warn_above_risk": warn_risk, "scam_checks": True},
        "privacy": {"block_trackers": True, "strip_tracking_params": True,
                    "block_fingerprinting": True, "privacy_report": True},
        "sensitive_data": {"warn": True, "cards": True, "ids": True, "otp": True, "passwords": True},
        "passwords": {"breach_check": True, "reuse_check": False},
        "cookies": {"monitor": True, "trackers": "BLOCK", "third_party": "ALLOW",
                    "unknown": "ALLOW", "clear_on_close": False},
    }
    for group, values in over.items():
        settings[group].update(values)
    return {"actions": actions, "settings": settings}


# Adult presets. They warn rather than block, so the person stays in control.
SHIELD_PRESETS = {
    # warn on look-alikes and scams, hard-block malware
    "shield_balanced": _shield(
        {**_w(Category.PHISHING, Category.FINANCIAL_PHISHING, Category.SCAM, Category.SUSPICIOUS,
              Category.DANGEROUS_DOWNLOAD), Category.MALWARE.value: Action.BLOCK}, 70),
    # block phishing outright, stricter privacy
    "shield_strict": _shield(
        {Category.MALWARE.value: Action.BLOCK, Category.PHISHING.value: Action.BLOCK,
         Category.FINANCIAL_PHISHING.value: Action.BLOCK, Category.DANGEROUS_DOWNLOAD.value: Action.BLOCK,
         **_w(Category.SCAM, Category.SUSPICIOUS)}, 50,
        cookies={"third_party": "BLOCK", "clear_on_close": True}, passwords={"reuse_check": True}),
    # stay out of the way: only clear threats
    "shield_minimal": _shield(
        {Category.MALWARE.value: Action.BLOCK,
         **_w(Category.PHISHING, Category.FINANCIAL_PHISHING, Category.SCAM)}, 85,
        privacy={"strip_tracking_params": False, "block_fingerprinting": False},
        sensitive_data={"ids": False, "otp": False, "passwords": False}),
}


def preset_settings(name: str) -> dict:
    """Settings stored with a new policy. Family presets carry none (extension defaults apply)."""
    import copy
    return copy.deepcopy(SHIELD_PRESETS[name]["settings"]) if name in SHIELD_PRESETS else {}
