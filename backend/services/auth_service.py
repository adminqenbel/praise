"""Auth helpers: password hashing, CSRF, role decorators, device tokens."""
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import g, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from database.models import Device, User
from database.postgres import db

# A pairing code works once and only for 15 minutes. The alphabet leaves out look-alike characters (0/O, 1/I).
PAIRING_TTL = timedelta(minutes=15)
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


# Passwords are only ever stored as salted hashes.
def hash_password(pw: str) -> str:
    return generate_password_hash(pw)


def verify_password(pw: str, pw_hash: str) -> bool:
    return check_password_hash(pw_hash, pw)


# Pairing codes and device tokens are stored as SHA-256 hashes, so a database leak does not reveal them.
def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


# One shape for every API error: {error: message}.
def err(message: str, status: int):
    return jsonify(error=message), status


# ---- dashboard sessions -------------------------------------------------

# Per-session token the dashboard echoes back in X-CSRF-Token on every change, so other websites cannot act as the user.
def csrf_token() -> str:
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


def login_user(user: User) -> None:
    session.clear()  # prevent session fixation
    session["uid"] = user.id
    csrf_token()
    session.permanent = False


def current_user() -> User | None:
    uid = session.get("uid")
    return db.session.get(User, uid) if uid else None


# Decorator for dashboard routes: needs a logged-in session, optionally a role, and a valid CSRF token on anything that changes data.
def login_required(role: str | None = None):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            user = current_user()
            if user is None:
                return err("authentication required", 401)
            if role and user.role != role:
                return err("forbidden", 403)
            if request.method not in _SAFE_METHODS:
                sent = request.headers.get("X-CSRF-Token", "")
                if not hmac.compare_digest(sent, session.get("csrf", "")):
                    return err("invalid CSRF token", 403)
            g.user = user
            return fn(*a, **kw)
        return wrapper
    return deco


# ---- device pairing / tokens ---------------------------------------------

# Create a short one-time code for a device and store only its hash and expiry.
def new_pairing_code(device: Device) -> str:
    code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(8))
    device.pairing_code_hash = sha256(code)
    device.pairing_expires_at = datetime.now(timezone.utc) + PAIRING_TTL
    return code


def redeem_pairing_code(code: str) -> tuple[Device, str] | None:
    """One-time: returns (device, plaintext token) and burns the code."""
    code = (code or "").strip().upper()
    if len(code) != 8:
        return None
    device = Device.query.filter_by(pairing_code_hash=sha256(code), revoked=False).first()
    if device is None:
        return None
    expires = device.pairing_expires_at
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires is None or expires < datetime.now(timezone.utc):
        device.pairing_code_hash = None
        return None
    # Success: issue a long random device token (shown once, stored hashed) and burn the code.
    token = secrets.token_urlsafe(32)
    device.token_hash = sha256(token)
    device.pairing_code_hash = None
    device.pairing_expires_at = None
    device.paired_at = datetime.now(timezone.utc)
    return device, token


# Decorator for extension routes: the request must carry a valid, unrevoked device token as a Bearer header.
def device_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return err("device token required", 401)
        device = Device.query.filter_by(token_hash=sha256(header[7:].strip()),
                                        revoked=False).first()
        if device is None:
            return err("invalid device token", 401)
        device.last_seen = datetime.now(timezone.utc)
        db.session.commit()
        g.device = device
        return fn(*a, **kw)
    return wrapper
