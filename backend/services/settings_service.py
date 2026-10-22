"""Validation for policy.settings (mirrors DEFAULTS in extension/protections.js)."""

# Every setting a policy may hold, grouped, with the kind of value each accepts (true/false, a fixed list of words, or a number range).
SCHEMA = {
    "downloads": {"enabled": bool, "archives": ("ALLOW", "BLOCK")},
    "protections": {"browser_installers": bool, "escape": bool, "tamper": bool,
                    "storage_monitor": bool},
    "cookies": {"monitor": bool, "third_party": ("ALLOW", "BLOCK"),
                "trackers": ("ALLOW", "BLOCK"), "unknown": ("ALLOW", "ASK", "BLOCK"),
                "clear_on_close": bool},
    # adult version
    "safe_browsing": {"warn_above_risk": ("range", 0, 100), "scam_checks": bool},
    "privacy": {"block_trackers": bool, "strip_tracking_params": bool,
                "block_fingerprinting": bool, "privacy_report": bool},
    "sensitive_data": {"warn": bool, "cards": bool, "ids": bool, "otp": bool, "passwords": bool},
    "passwords": {"breach_check": bool, "reuse_check": bool},
    # the buddy
    "companion": {"chat": bool},
}


class SettingsError(ValueError):
    pass


def validate_settings(data) -> dict:
    """Return a cleaned settings dict; unknown keys and bad values raise SettingsError."""
    if not isinstance(data, dict):
        raise SettingsError("settings must be an object")
    clean = {}
    for group, body in data.items():
        spec = SCHEMA.get(group)
        if spec is None or not isinstance(body, dict):
            raise SettingsError(f"unknown settings group: {group}")
        clean[group] = {}
        for key, value in body.items():
            # Reject unknown settings and wrong value types instead of storing them; the extension trusts what the server sends.
            kind = spec.get(key)
            if kind is None:
                raise SettingsError(f"unknown setting: {group}.{key}")
            if kind is bool:
                ok = isinstance(value, bool)
            elif kind and kind[0] == "range":
                ok = isinstance(value, int) and not isinstance(value, bool) and kind[1] <= value <= kind[2]
            else:
                ok = value in kind
            if not ok:
                raise SettingsError(f"invalid value for {group}.{key}")
            clean[group][key] = value
    return clean
