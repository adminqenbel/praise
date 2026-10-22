import logging
import re

from flask import Blueprint, current_app, g, jsonify, request, session

from database.models import Child, Device, User
from database.postgres import db
from services import space_service
from ai.companion_llm import get_companion
from services.ratelimit import client_ip, rate_limit
from services.auth_service import (csrf_token, current_user, err, hash_password, login_required,
                                   login_user, new_pairing_code, redeem_pairing_code,
                                   verify_password)

# Sign-up, login, spaces, children and device pairing for the dashboard, plus the one public endpoint the extension uses to pair.
bp = Blueprint("auth", __name__, url_prefix="/api")
log = logging.getLogger("praise.security")
MAX_PASSWORD = 256   # cap work done hashing attacker-supplied input

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# Hash to burn time on unknown emails so login timing doesn't reveal accounts.
_DUMMY_HASH = hash_password("dummy-password-for-timing")


def _user_json(u: User):
    # account_type is the space being shown; spaces lists every space this login has set up
    return {"id": u.id, "email": u.email, "role": u.role, "account_type": space_service.active(u),
            "spaces": space_service.enabled(u)}


# Create an account. A family account starts empty; an adult account starts with one profile for the person themself.
@bp.post("/auth/register")
@rate_limit("register", 10, 3600)
def register():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    if not _EMAIL.match(email) or len(email) > 255:
        return err("valid email required", 400)
    if len(password) < 8:
        return err("password must be at least 8 characters", 400)
    if len(password) > MAX_PASSWORD:
        return err("password is too long", 400)
    if User.query.filter_by(email=email).first():
        return err("email already registered", 409)
    account_type = data.get("account_type", "family")
    if account_type not in ("family", "adult"):
        return err("account_type must be family or adult", 400)
    user = User(email=email, password_hash=hash_password(password), role="parent",
                account_type=account_type, has_family=account_type == "family", has_adult=False)
    db.session.add(user)
    db.session.flush()
    if account_type == "adult":
        # An adult protects themselves: one "self" profile with a balanced Shield rule set.
        space_service.enable(user, "adult")
    db.session.commit()
    login_user(user)
    return jsonify(user=_user_json(user), csrf=csrf_token()), 201


# Rate-limit logins per address and per email, so one account can't be guessed at from many places or one place at many accounts.
def _login_key():
    email = str((request.get_json(silent=True) or {}).get("email", "")).strip().lower()[:255]
    return f"{client_ip()}|{email}"


# Check the password. Unknown emails run a dummy hash so response time doesn't reveal whether an account exists.
@bp.post("/auth/login")
@rate_limit("login-ip", 60, 900)
@rate_limit("login", 8, 900, key_fn=_login_key)
def login():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    user = User.query.filter_by(email=email).first()
    ok = len(password) <= MAX_PASSWORD and verify_password(
        password, user.password_hash if user else _DUMMY_HASH)
    if not user or not ok:
        log.warning("failed login ip=%s", client_ip())
        return err("invalid credentials", 401)
    login_user(user)
    return jsonify(user=_user_json(user), csrf=csrf_token())


@bp.post("/auth/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@bp.post("/auth/space")
@login_required()
def switch_space():
    """Show the family or the personal space. A space the login does not have yet is added only when `enable` is true
    (the dashboard asks first), so a stray click never creates a profile."""
    data = request.get_json(silent=True) or {}
    space = data.get("space")
    if space not in space_service.SPACES:
        return err("space must be family or adult", 400)
    if space not in space_service.enabled(g.user):
        if data.get("enable") is not True:
            return err("That space isn't set up on this login yet.", 409)
        space_service.enable(g.user, space)
    g.user.account_type = space
    db.session.commit()
    return jsonify(user=_user_json(g.user), csrf=csrf_token())


@bp.post("/auth/chat")
@login_required()
@rate_limit("dash-chat", 12, 60, key_fn=lambda: f"user{g.user.id}")
def dashboard_chat():
    """A message to the buddy on the dashboard (Dori talks to a parent, Ringo to an adult). Same contract as the
    extension's /api/ext/chat: a null reply means the buddy answers from its own lines. Never logged or stored."""
    body = request.get_json(silent=True) or {}
    companion = get_companion(current_app.config)
    audience = "adult" if space_service.active(g.user) == "adult" else "parent"
    reply = companion.chat(audience, body.get("message"), body.get("history")) if companion.enabled else None
    return jsonify(reply=reply)


# Who is logged in? The dashboard calls this on load to decide which space (family or adult) to show.
@bp.get("/auth/me")
def me():
    user = current_user()
    if user is None:
        return err("authentication required", 401)
    return jsonify(user=_user_json(user), csrf=csrf_token())


# ---- children & device pairing (parent-owned) ---------------------------

# Add a child profile (family space only).
@bp.post("/children")
@login_required()
def create_child():
    if space_service.active(g.user) != "family":
        return err("Your personal space protects one profile: you. Switch to your family space to add a child.", 403)
    name = str((request.get_json(silent=True) or {}).get("name", "")).strip()
    if not name or len(name) > 100:
        return err("name required", 400)
    child = Child(parent_id=g.user.id, name=name)
    db.session.add(child)
    db.session.commit()
    return jsonify(id=child.id, name=child.name), 201


# The profiles of the space being shown, with their paired devices.
@bp.get("/children")
@login_required()
def list_children():
    kids = Child.query.filter_by(parent_id=g.user.id, kind=space_service.child_kind(g.user)).all()
    return jsonify(children=[{
        "id": c.id, "name": c.name, "kind": c.kind, "policy_id": c.policy_id,
        "devices": [{"id": d.id, "label": d.label, "paired": d.token_hash is not None,
                     "revoked": d.revoked,
                     "last_seen": d.last_seen.isoformat() if d.last_seen else None}
                    for d in c.devices]} for c in kids])


# Make a pairing code for a new browser. Only the owner's own children are reachable; others get the same 'not found'.
@bp.post("/children/<int:child_id>/devices")
@login_required()
def create_device(child_id):
    child = Child.query.filter_by(id=child_id, parent_id=g.user.id).first()
    if child is None:
        return err("not found", 404)  # same response for other users' children
    label = str((request.get_json(silent=True) or {}).get("label", ""))[:100]
    device = Device(child_id=child.id, label=label or None)
    db.session.add(device)
    code = new_pairing_code(device)
    db.session.commit()
    return jsonify(device_id=device.id, pairing_code=code, expires_in_seconds=900), 201


# Cut a browser off: its token is wiped so it can no longer use the API.
@bp.post("/devices/<int:device_id>/revoke")
@login_required()
def revoke_device(device_id):
    device = (Device.query.join(Child).filter(Device.id == device_id,
                                              Child.parent_id == g.user.id).first())
    if device is None:
        return err("not found", 404)
    device.revoked = True
    device.token_hash = None
    device.pairing_code_hash = None
    db.session.commit()
    return jsonify(ok=True)


@bp.post("/devices/pair")
@rate_limit("pair", 10, 600)
def pair_device():
    """Called by the extension. Unauthenticated by design: the one-time code is the secret."""
    code = str((request.get_json(silent=True) or {}).get("code", ""))
    result = redeem_pairing_code(code)
    if result is None:
        db.session.commit()
        log.warning("failed pairing attempt ip=%s", client_ip())
        return err("invalid or expired pairing code", 400)
    device, token = result
    db.session.commit()
    # The one extension adapts to whoever issued the code: a parent's code makes it the family version for a child's
    # browser, an adult's own code makes it the personal shield.
    return jsonify(device_id=device.id, token=token, mode=space_service.mode_of_child(device.child))
