"""Parent-facing policy management (session + CSRF)."""
from flask import Blueprint, g, jsonify, request

from database.models import (Child, DomainRule, Policy, PolicyException, PolicyRule, TldRule)
from database.postgres import db
from policy.categories import ALL_CATEGORY_VALUES
from policy.presets import preset
from policy.tld_rules import normalize_tlds
from services import policy_service, space_service
from services.auth_service import err, login_required
from services.settings_service import SettingsError, validate_settings
from services.site_service import normalize_domain

bp = Blueprint("policy", __name__, url_prefix="/api")

# Values the API accepts. Everything a client sends is checked against these lists before it is stored.
RULE_ACTIONS = {"ALLOW", "BLOCK", "REVIEW", "ASK", "WARN"}
PRESETS = {"child_safe", "teen", "education", "custom", "shield_balanced", "shield_strict", "shield_minimal"}
UNKNOWN_ACTIONS = {"ALLOW", "BLOCK", "REVIEW", "WARN"}


# A policy is only reachable by its owner: looking up someone else's id returns nothing, so the API answers 'not found'.
def _own_policy(policy_id):
    return Policy.query.filter_by(id=policy_id, owner_id=g.user.id).first()


# The full shape of a policy as the dashboard receives it: settings, category rules, domain and TLD lists, exceptions and which profiles use it.
def _policy_json(p: Policy):
    return {
        "id": p.id, "name": p.name, "preset": p.preset, "unknown_action": p.unknown_action,
        "ai_enabled": p.ai_enabled, "ai_min_confidence": p.ai_min_confidence,
        "settings": p.settings or {},
        "rules": {r.category: r.action for r in p.rules},
        "domains": [{"id": d.id, "domain": d.domain, "action": d.action} for d in p.domain_rules],
        "tlds": [{"id": t.id, "tld": t.tld, "action": t.action} for t in p.tld_rules],
        "exceptions": [{"id": e.id, "domain": e.domain, "note": e.note} for e in p.exceptions],
        "children": [c.id for c in Child.query.filter_by(policy_id=p.id, parent_id=g.user.id)],
    }


def _json():
    return request.get_json(silent=True) or {}


# Category groups and preset names, used to build the dashboard's toggles.
@bp.get("/meta/categories")
@login_required()
def categories():
    from policy.categories import GROUPS
    return jsonify(groups={k: [c.value for c in v] for k, v in GROUPS.items()},
                   presets=sorted(PRESETS))


# Only the policies of the space being shown (family or personal).
@bp.get("/policies")
@login_required()
def list_policies():
    return jsonify(policies=[_policy_json(p) for p in
                             Policy.query.filter_by(owner_id=g.user.id, space=space_service.active(g.user)).order_by(Policy.id)])


# New policy from a preset. Presets from the other space are refused, so child presets never land on an adult.
@bp.post("/policies")
@login_required()
def create_policy():
    data = _json()
    name = str(data.get("name", "")).strip()
    preset_name = data.get("preset", "custom")
    if not name or len(name) > 100:
        return err("name required", 400)
    if preset_name not in PRESETS:
        return err("unknown preset", 400)
    space = space_service.policy_space(preset_name, g.user)
    if space != space_service.active(g.user):
        return err("That preset belongs to the other space. Switch spaces to use it.", 400)
    if space == "adult" and preset_name in ("child_safe", "teen", "education"):
        return err("That preset is for children's browsers.", 400)
    p = policy_service.create_policy_from_preset(g.user.id, name, preset_name)
    p.space = space
    db.session.add(p)
    db.session.commit()
    return jsonify(_policy_json(p)), 201


@bp.get("/policies/<int:pid>")
@login_required()
def get_policy(pid):
    p = _own_policy(pid)
    return jsonify(_policy_json(p)) if p else err("not found", 404)


# Change name, unknown-site action, AI settings or protection settings. Each field is validated; editing settings turns the preset into 'custom'.
@bp.patch("/policies/<int:pid>")
@login_required()
def update_policy(pid):
    p = _own_policy(pid)
    if p is None:
        return err("not found", 404)
    data = _json()
    if "name" in data:
        name = str(data["name"]).strip()
        if not name or len(name) > 100:
            return err("invalid name", 400)
        p.name = name
    if "unknown_action" in data:
        if data["unknown_action"] not in UNKNOWN_ACTIONS:
            return err("invalid unknown_action", 400)
        p.unknown_action = data["unknown_action"]
    if "ai_enabled" in data:
        if not isinstance(data["ai_enabled"], bool):
            return err("ai_enabled must be boolean", 400)
        p.ai_enabled = data["ai_enabled"]
    if "ai_min_confidence" in data:
        v = data["ai_min_confidence"]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 1:
            return err("ai_min_confidence must be between 0 and 1", 400)
        p.ai_min_confidence = float(v)
    if "settings" in data:
        try:
            p.settings = validate_settings(data["settings"])
        except SettingsError as e:
            return err(str(e), 400)
    p.preset = "custom" if any(k in data for k in ("unknown_action", "settings")) else p.preset
    db.session.commit()
    return jsonify(_policy_json(p))


@bp.delete("/policies/<int:pid>")
@login_required()
def delete_policy(pid):
    p = _own_policy(pid)
    if p is None:
        return err("not found", 404)
    db.session.delete(p)  # children fall back to the strict default (FK SET NULL)
    db.session.commit()
    return jsonify(ok=True)


@bp.put("/policies/<int:pid>/rules")
@login_required()
def set_rules(pid):
    """Replace category rules: {"gambling": "BLOCK", ...}. Omitted categories are cleared."""
    p = _own_policy(pid)
    if p is None:
        return err("not found", 404)
    rules = _json().get("rules")
    if not isinstance(rules, dict):
        return err("rules must be an object", 400)
    for cat, action in rules.items():
        if cat not in ALL_CATEGORY_VALUES:
            return err(f"unknown category: {cat}", 400)
        if action not in RULE_ACTIONS:
            return err(f"invalid action for {cat}", 400)
    p.rules.clear()
    db.session.flush()
    for cat, action in rules.items():
        p.rules.append(PolicyRule(category=cat, action=action))
    p.preset = "custom"
    db.session.commit()
    return jsonify(_policy_json(p))


# Shared by the domain, TLD and exception endpoints: check ownership, validate, refuse duplicates, add.
def _add_list_item(pid, model, relation_name, build, fields):
    p = _own_policy(pid)
    if p is None:
        return err("not found", 404)
    item, problem = build(_json())
    if problem:
        return err(problem, 400)
    if any(all(getattr(x, f) == getattr(item, f) for f in fields) for x in getattr(p, relation_name)):
        return err("already exists", 409)
    getattr(p, relation_name).append(item)
    db.session.commit()
    return jsonify(_policy_json(p)), 201


# Shared delete: the item must belong to the caller's own policy.
def _delete_list_item(pid, model, item_id):
    p = _own_policy(pid)
    if p is None:
        return err("not found", 404)
    item = model.query.filter_by(id=item_id, policy_id=p.id).first()
    if item is None:
        return err("not found", 404)
    db.session.delete(item)
    db.session.commit()
    return jsonify(_policy_json(db.session.get(Policy, pid)))


# Validators that turn request data into a rule row, or an error message.
def _build_domain(data):
    domain = normalize_domain(str(data.get("domain", "")))
    if domain is None:
        return None, "valid domain required"
    if data.get("action") not in ("ALLOW", "BLOCK"):
        return None, "action must be ALLOW or BLOCK"
    return DomainRule(domain=domain, action=data["action"]), None


def _build_tld(data):
    tlds = normalize_tlds([str(data.get("tld", ""))])
    tld = next(iter(tlds), "")
    if len(tld) < 2 or len(tld) > 32 or not tld[1:].replace("-", "").isalnum():
        return None, "valid TLD required (for example .xyz)"
    if data.get("action") not in ("ALLOW", "BLOCK"):
        return None, "action must be ALLOW or BLOCK"
    return TldRule(tld=tld, action=data["action"]), None


def _build_exception(data):
    domain = normalize_domain(str(data.get("domain", "")))
    if domain is None:
        return None, "valid domain required"
    return PolicyException(domain=domain, note=str(data.get("note", ""))[:255] or None), None


@bp.post("/policies/<int:pid>/domains")
@login_required()
def add_domain(pid):
    return _add_list_item(pid, DomainRule, "domain_rules", _build_domain, ["domain"])


@bp.delete("/policies/<int:pid>/domains/<int:item_id>")
@login_required()
def del_domain(pid, item_id):
    return _delete_list_item(pid, DomainRule, item_id)


@bp.post("/policies/<int:pid>/tlds")
@login_required()
def add_tld(pid):
    return _add_list_item(pid, TldRule, "tld_rules", _build_tld, ["tld"])


@bp.delete("/policies/<int:pid>/tlds/<int:item_id>")
@login_required()
def del_tld(pid, item_id):
    return _delete_list_item(pid, TldRule, item_id)


@bp.post("/policies/<int:pid>/exceptions")
@login_required()
def add_exception(pid):
    return _add_list_item(pid, PolicyException, "exceptions", _build_exception, ["domain"])


@bp.delete("/policies/<int:pid>/exceptions/<int:item_id>")
@login_required()
def del_exception(pid, item_id):
    return _delete_list_item(pid, PolicyException, item_id)


# Choose which policy a profile uses. Only a policy from the profile's own space is accepted; none means the strict default.
@bp.put("/children/<int:child_id>/policy")
@login_required()
def assign_policy(child_id):
    child = Child.query.filter_by(id=child_id, parent_id=g.user.id).first()
    if child is None:
        return err("not found", 404)
    pid = _json().get("policy_id")
    if pid is None:
        child.policy_id = None
    else:
        policy = _own_policy(pid)
        if policy is None or policy.space != ("adult" if child.kind == "self" else "family"):
            return err("policy not found", 404)
        child.policy_id = pid
    db.session.commit()
    return jsonify(child_id=child.id, policy_id=child.policy_id)
