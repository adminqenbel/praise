"""Create local demo data through the real HTTP API (backend must be running).

    python scripts/seed_demo.py [http://localhost:5000]

Makes: parent account, admin account, one child with a paired device, a policy, and a few
site checks so the dashboard has something to show. Dev use only.
"""
import json
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5000"
PARENT = ("parent@demo.test", "demo-password-123")
ADMIN = ("admin@demo.test", "demo-password-123")


# Tiny HTTP client that keeps the login cookie and sends the CSRF token on changes, like the dashboard does.
class Client:
    def __init__(self):
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None

    def call(self, method, path, body=None, headers=None):
        h = {"Content-Type": "application/json", **(headers or {})}
        if self.csrf and method != "GET":
            h["X-CSRF-Token"] = self.csrf
        req = urllib.request.Request(BASE + path, method=method, headers=h,
                                     data=json.dumps(body).encode() if body is not None else None)
        try:
            with self.opener.open(req) as r:
                data = json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")
        self.csrf = data.get("csrf", self.csrf)
        return 200, data


# Use the account if it exists, otherwise create it.
def login_or_register(c, creds):
    s, d = c.call("POST", "/api/auth/login", {"email": creds[0], "password": creds[1]})
    if s != 200:
        s, d = c.call("POST", "/api/auth/register", {"email": creds[0], "password": creds[1]})
    assert s in (200, 201), d


p = Client()
login_or_register(p, PARENT)
kids = p.call("GET", "/api/children")[1]["children"]
# First run only: create a child, a Teen policy, pair a device, then run a few site checks and upload sample events.
if not kids:
    cid = p.call("POST", "/api/children", {"name": "Mia"})[1]["id"]
    pol = p.call("POST", "/api/policies", {"name": "Mia's rules", "preset": "teen"})[1]
    p.call("PUT", f"/api/children/{cid}/policy", {"policy_id": pol["id"]})
    code = p.call("POST", f"/api/children/{cid}/devices", {"label": "School laptop"})[1]["pairing_code"]
    ext = Client()
    token = ext.call("POST", "/api/devices/pair", {"code": code})[1]["token"]
    auth = {"Authorization": "Bearer " + token}
    for url, sig in [
        ("https://lucky-jackpot-casino.com", {"title": "Casino and slots jackpot"}),
        ("https://www.wikipedia.org", {"title": "Wikipedia the free encyclopedia"}),
        ("https://university-course-portal.edu", {"title": "University course tutorial lessons"}),
        ("https://bet-odds-sportsbook.net", {"title": "Sportsbook betting odds"}),
    ]:
        ext.call("POST", "/api/ext/check", {"url": url, "signals": sig}, auth)
    ext.call("POST", "/api/ext/events", {"events": [
        {"kind": "download", "data": {"filename": "ChromeSetup.exe", "kind": "browser_installer", "action": "BLOCK", "ext": "exe"}},
        {"kind": "download", "data": {"filename": "essay.pdf", "kind": "ok", "action": "ALLOW", "ext": "pdf"}},
        {"kind": "security", "data": {"type": "external_browser", "url": "microsoft-edge:https://example.com"}},
        {"kind": "cookie", "data": {"type": "cookie", "domain": "doubleclick.net", "name": "IDE", "third_party": True, "persistent": True, "lifetime_days": 90, "purpose": "Advertising / tracking", "confidence": 0.9, "action": "BLOCKED", "rule": "tracker"}},
        {"kind": "cookie", "data": {"type": "cookie", "domain": "school.edu", "name": "sid", "third_party": False, "persistent": False, "lifetime_days": 0, "purpose": "Sign-in or session (essential)", "confidence": 0.75, "action": "ALLOWED", "rule": "allow"}},
        {"kind": "cookie", "data": {"type": "storage", "domain": "wikipedia.org", "local_storage": 6, "session_storage": 1, "indexed_db": 0, "cache_storage": 2, "service_workers": 1}},
        {"kind": "browser", "data": {"type": "access_request", "domain": "bet-odds-sportsbook.net"}},
        {"kind": "browser", "data": {"type": "access_request", "domain": "gamefaqs.com"}},
    ]}, auth)
    print("seeded child Mia")

# The admin account can't be created through the API; it needs `flask create-admin`.
c = Client()
s, _ = c.call("POST", "/api/auth/login", {"email": ADMIN[0], "password": ADMIN[1]})
print("parent:", PARENT[0], "| admin:", ADMIN[0], "(admin must be created with `flask create-admin`)" if s != 200 else "ok")
