"""One login, two spaces.

An email can hold a family space (children's browsers, set up by a parent) and a personal space (the person's own
browser, Praise Shield) at the same time. `User.account_type` is the space the dashboard is currently showing; the
`has_family` / `has_adult` flags say which spaces exist. Everything that belongs to a space is told apart by the profile's
kind (a child's profile is "child", the person's own is "self") and by the rule set's `space`, so the spaces never mix.
"""
from database.models import Child
from database.postgres import db
from services import policy_service

# The two spaces a login can have, and the profile kind that belongs to each.
SPACES = ("family", "adult")
CHILD_KIND = {"family": "child", "adult": "self"}


# Spaces this login has turned on (always at least one).
def enabled(user) -> list[str]:
    out = [s for s, on in (("family", user.has_family), ("adult", user.has_adult)) if on]
    return out or [user.account_type]


def active(user) -> str:
    """The space the dashboard is showing: the last one chosen, as long as it still exists."""
    return user.account_type if user.account_type in enabled(user) else enabled(user)[0]


# Kind of profile that new people are created as in the space being shown.
def child_kind(user) -> str:
    return CHILD_KIND[active(user)]


def mode_of_child(child: Child) -> str:
    """Which version the extension becomes for a browser paired to this profile."""
    return "adult" if child.kind == "self" else "family"


# Shield presets always belong to the personal space; other presets follow the space being shown.
def policy_space(preset_name: str, user) -> str:
    return "adult" if preset_name.startswith("shield_") else active(user)


def enable(user, space: str) -> None:
    """Add a space to this login. The personal space starts with one profile ("Me") and a balanced rule set."""
    if space == "family":
        user.has_family = True
        return
    if not user.has_adult:
        policy = policy_service.create_policy_from_preset(user.id, "My protection", "shield_balanced")
        policy.space = "adult"
        db.session.add(policy)
        db.session.flush()
        db.session.add(Child(parent_id=user.id, name="Me", kind="self", policy_id=policy.id))
    user.has_adult = True
