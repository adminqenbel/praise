"""Create (or reuse) a demo ADULT account, pair a browser, and print a fresh pairing code.

    python scripts/seed_adult.py [http://localhost:5000]

Dev use only: the account is adult@demo.test (removed by `flask purge-demo`).
"""
import json
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

# Which backend to talk to (default: the local one) and the demo login this script uses.
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5000"
EMAIL, PASSWORD = "adult@demo.test", "demo-password-123"

jar = CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
csrf = None


# Tiny HTTP client that keeps the login cookie and sends the CSRF token on changes, like the dashboard does.
def call(method, path, body=None):
    global csrf
    headers = {"Content-Type": "application/json"}
    if csrf and method != "GET":
        headers["X-CSRF-Token"] = csrf
    req = urllib.request.Request(BASE + path, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with opener.open(req) as r:
            data = json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")
    csrf = data.get("csrf", csrf)
    return 200, data


# Log in, or create the demo adult account the first time.
status, data = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
if status != 200:
    status, data = call("POST", "/api/auth/register",
                        {"email": EMAIL, "password": PASSWORD, "account_type": "adult"})
assert status in (200, 201), data
profile = call("GET", "/api/children")[1]["children"][0]
code = call("POST", f"/api/children/{profile['id']}/devices", {"label": "My browser"})[1]["pairing_code"]
# sample activity (from a second, throwaway device) so the dashboard has something to show
sample = call("POST", f"/api/children/{profile['id']}/devices", {"label": "Demo laptop"})[1]["pairing_code"]
plain = urllib.request.build_opener()
token = json.loads(plain.open(urllib.request.Request(BASE + "/api/devices/pair", method="POST", data=json.dumps({"code": sample}).encode(),
                                                    headers={"Content-Type": "application/json"})).read())["token"]
sec = lambda **d: {"kind": "security", "data": d}
# Fake warnings, blocked sites and tracker cookies, so the personal dashboard's charts are not empty.
events = [
    sec(type="warning_shown", domain="secure-hdfcbank-login.xyz", category="financial_phishing", risk=88),
    sec(type="warning_shown", domain="prize-winner-now.example.com", category="scam", risk=92),
    sec(type="warning_overridden", domain="prize-winner-now.example.com"),
    sec(type="site_blocked", domain="free-codec-download.top", category="malware", risk=99),
    sec(type="sensitive_shown", domain="secure-hdfcbank-login.xyz", kinds=["card", "password"]),
    sec(type="sensitive_cancelled", domain="secure-hdfcbank-login.xyz", kinds=["card", "password"]),
    sec(type="sensitive_breached", domain="old-forum.example.org", kinds=["password"]),
    sec(type="sensitive_reused", domain="shop.example.net", kinds=["password"]),
] + [{"kind": "cookie", "data": {"type": "cookie", "domain": "doubleclick.net", "name": "IDE", "third_party": True,
        "persistent": True, "lifetime_days": 90, "purpose": "Advertising / tracking", "confidence": 0.9, "action": "BLOCKED", "rule": "tracker"}}] * 6
req = urllib.request.Request(BASE + "/api/ext/events", method="POST", data=json.dumps({"events": events}).encode(),
                             headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
plain.open(req).read()

print(f"adult account: {EMAIL}  profile: {profile['name']} ({profile['kind']})")
print(f"pairing code (valid 15 minutes, works once): {code}")
