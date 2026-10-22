from dataclasses import dataclass, field
from enum import IntEnum

from .categories import Action


# Which rule produced a decision. The number is the priority: a lower number always beats a higher one.
class Level(IntEnum):
    PARENT_RULE = 1
    ADMIN_VERIFIED = 2
    REPUTATION = 3
    CATEGORY = 4
    TLD = 5
    AI = 6
    UNKNOWN_DEFAULT = 7
    HEURISTIC = 8   # deterministic look-alike check; works even when the AI is unavailable


# The result of one policy check: what to do, why, and which rule decided. Immutable so it can't be altered after the fact.
@dataclass(frozen=True)
class Decision:
    action: Action
    level: Level
    reason: str
    category: str | None = None
    risk: int | None = None
    matched_rule: str | None = None

    # The JSON shape the extension receives. can_continue is true only for WARN (adult version: the person may proceed).
    def to_dict(self):
        return {
            "action": self.action.value,
            "can_continue": self.action == Action.WARN,
            "level": self.level.name,
            "reason": self.reason,
            "category": self.category,
            "risk": self.risk,
            "matched_rule": self.matched_rule,
        }


# What we know about a website, independent of any child or account: its lifecycle status, category, risk and source.
@dataclass
class SiteInfo:
    domain: str
    status: str = "UNKNOWN"  # UNKNOWN|AI_CLASSIFIED|PENDING_REVIEW|ADMIN_VERIFIED|...
    category: str | None = None  # dominant category
    risk: int | None = None  # 0-100
    confidence: float | None = None  # 0-1
    category_scores: dict = field(default_factory=dict)
    source: str = "none"  # none|seed|ai|admin
    reputation_flag: str | None = None  # e.g. "malware" from trusted feeds
    needs_reanalysis: bool = False  # admin asked for a fresh AI pass
    lookalike: float = 0.0  # 0-1 deterministic score that the domain imitates a known brand


# One account's rules flattened for the engine: category actions, allow/block lists, TLD rules and AI settings.
@dataclass
class PolicyConfig:
    category_actions: dict = field(default_factory=dict)  # category value -> Action
    allow_domains: set = field(default_factory=set)
    block_domains: set = field(default_factory=set)
    exceptions: set = field(default_factory=set)  # approved domains (always allow)
    allowed_tlds: set = field(default_factory=set)
    blocked_tlds: set = field(default_factory=set)
    unknown_action: Action = Action.REVIEW
    ai_enabled: bool = True
    ai_min_confidence: float = 0.6
    default_known_action: Action = Action.ALLOW
    warn_above_risk: int = 0   # adult version: warn when the AI rates an otherwise-allowed site this risky (0 = off)
