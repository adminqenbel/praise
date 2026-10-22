"""Deterministic policy engine. Pure: no DB, no network. First matching level wins.

1 parent rule -> 2 admin-verified -> 3 trusted reputation -> 4 category policy
-> 5 TLD policy -> 6 AI classification -> 7 unknown default.
"""
from .categories import SECURITY_CATEGORIES, Action, parse_category
from .decision import Decision, Level, PolicyConfig, SiteInfo
from .tld_rules import tld_of


# A look-alike score at or above this triggers a warning in the adult version.
LOOKALIKE_WARN = 0.75


def domain_matches(domain: str, rules) -> str | None:
    """Return the matching rule if domain equals it or is a subdomain of it."""
    parts = domain.lower().strip(".").split(".")
    for i in range(len(parts)):
        candidate = ".".join(parts[i:])
        if candidate in rules:
            return candidate
    return None


# The action a policy sets for a category. Security categories (malware, phishing...) are blocked even when the policy says nothing.
def _category_action(policy: PolicyConfig, category: str | None) -> Action | None:
    cat = parse_category(category) if category else None
    if cat is None:
        return None
    explicit = policy.category_actions.get(cat.value)
    if explicit is not None:
        return Action(explicit)
    if cat in SECURITY_CATEGORIES:
        return Action.BLOCK
    return None


# The one function that decides allow/block/warn/review. It reads a site and a policy and returns the first rule that matches, in priority order. No I/O, so it is easy to test.
def decide(site: SiteInfo, policy: PolicyConfig) -> Decision:
    domain = site.domain.lower().strip(".")

    # 1. Explicit parent rules. Within this level: exception > block > allow.
    if m := domain_matches(domain, policy.exceptions):
        return Decision(Action.ALLOW, Level.PARENT_RULE, "Approved exception", matched_rule=m)
    if m := domain_matches(domain, policy.block_domains):
        return Decision(Action.BLOCK, Level.PARENT_RULE, "Blocked by parent rule", matched_rule=m)
    if m := domain_matches(domain, policy.allow_domains):
        return Decision(Action.ALLOW, Level.PARENT_RULE, "Allowed by parent rule", matched_rule=m)

    # 2. Admin-verified classification
    if site.status == "ADMIN_VERIFIED":
        action = _category_action(policy, site.category) or policy.default_known_action
        return Decision(action, Level.ADMIN_VERIFIED, f"Verified site: {site.category}",
                        category=site.category, risk=site.risk)

    # 3. Trusted security / reputation data
    if site.reputation_flag:
        return Decision(Action.BLOCK, Level.REPUTATION,
                        f"Flagged by reputation data: {site.reputation_flag}",
                        category=site.reputation_flag, risk=site.risk)

    # 3b. Adult version: a domain that clearly imitates a known brand is warned about no matter what
    #     the AI said, or whether it could be asked at all. (Parent rules and verified sites, above,
    #     still win.)
    if policy.warn_above_risk and site.lookalike >= LOOKALIKE_WARN:
        return Decision(Action.WARN, Level.HEURISTIC, "Looks like a fake bank or payment page",
                        category="financial_phishing", risk=int(site.lookalike * 100))

    # 4. Category policy for known non-AI classifications (seed data etc.)
    if site.category and site.source in ("seed", "admin"):
        action = _category_action(policy, site.category)
        if action is not None:
            return Decision(action, Level.CATEGORY, f"Category policy: {site.category}",
                            category=site.category, risk=site.risk)

    # 5. TLD policy (a signal, not proof)
    tld = tld_of(domain)
    if tld and tld in policy.blocked_tlds:
        return Decision(Action.BLOCK, Level.TLD, f"Blocked TLD {tld}", matched_rule=tld)
    if tld and policy.allowed_tlds and tld not in policy.allowed_tlds:
        return Decision(Action.REVIEW, Level.TLD, f"TLD {tld} not in allowed list",
                        matched_rule=tld)

    # 6. AI classification
    if policy.ai_enabled and site.source == "ai" and site.category:
        if (site.confidence or 0) >= policy.ai_min_confidence:
            action = _category_action(policy, site.category)
            if action is None:
                action, why = policy.default_known_action, f"AI classified as {site.category} (no rule)"
            else:
                why = f"AI classified as {site.category}"
            # Adult version: an allowed site the AI nevertheless rates very risky gets a warning.
            if (action == Action.ALLOW and policy.warn_above_risk
                    and (site.risk or 0) >= policy.warn_above_risk):
                action, why = Action.WARN, f"AI rates this site {site.risk}/100 for risk"
            return Decision(action, Level.AI, why, category=site.category, risk=site.risk)
        return Decision(Action.REVIEW, Level.AI, "Low-confidence AI classification",
                        category=site.category, risk=site.risk)

    # 7. Unknown-site default
    return Decision(policy.unknown_action, Level.UNKNOWN_DEFAULT, "Unknown site default")
