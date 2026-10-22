"""Gemini backend (google-genai) and an offline mock with the same interface.

NOTE: GeminiBackend has not been exercised against the live API yet (no key configured).
It is isolated here so everything else is testable with MockBackend / fakes.
"""
import re
import time

from .classifier import AIUnavailable


# Talks to Google's Gemini API. Output is requested as JSON at temperature 0 so answers are repeatable.
class GeminiBackend:
    def __init__(self, api_key: str, model: str, timeout_s: int = 10, attempts: int = 3,
                 backoff_s: float = 1.0):
        self.attempts, self.backoff_s = attempts, backoff_s
        if not api_key:
            raise AIUnavailable("GEMINI_API_KEY not configured")
        from google import genai  # imported lazily so the app runs without the SDK path hit
        from google.genai import types

        self.model = model
        self._types = types
        self._client = genai.Client(
            api_key=api_key, http_options=types.HttpOptions(timeout=timeout_s * 1000))

    # Only temporary provider errors (rate limit, server trouble) are retried; anything else fails straight away.
    TRANSIENT = {429, 500, 502, 503, 504}

    def generate(self, system: str, prompt: str) -> str:
        cfg = self._types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            temperature=0,
            max_output_tokens=1024,
        )
        last = None
        for attempt in range(self.attempts):
            try:
                resp = self._client.models.generate_content(
                    model=self.model, contents=prompt, config=cfg)
                return resp.text or ""
            except Exception as e:  # retry only temporary provider-side failures
                last = e
                if getattr(e, "code", None) not in self.TRANSIENT or attempt == self.attempts - 1:
                    raise
                time.sleep(self.backoff_s * (attempt + 1))
        raise last


# Word lists the offline mock classifier looks for, one list per category.
_KEYWORDS = {
    "gambling": ("casino", "poker", "slots", "jackpot", "roulette", "lottery"),
    "betting": ("betting", "sportsbook", "odds", "bet365", "wager"),
    "adult": ("porn", "xxx", "nsfw", "adult video", "escort"),
    "drugs": ("cannabis", "weed shop", "buy drugs", "cocaine"),
    "weapons": ("firearm", "buy guns", "ammo shop"),
    "banking": ("netbanking", "internet banking", "bank login", "online banking"),
    "cryptocurrency": ("crypto", "bitcoin", "ethereum", "token swap"),
    "trading": ("stock trading", "trade stocks", "demat", "brokerage"),
    "social_media": ("social network", "followers", "timeline", "messenger"),
    "education": ("university", "school", "course", "tutorial", "lesson", ".edu"),
}


class MockBackend:
    """Deterministic keyword classifier for offline dev and demos. Never calls the network."""

    model = "mock-keyword-v1"

    def generate(self, system: str, prompt: str) -> str:
        import json
        m = re.search(r"<page_data>(.*)</page_data>", prompt, re.S)
        blob = (m.group(1) if m else prompt).lower()
        cats, evidence = {}, []
        for cat, words in _KEYWORDS.items():
            hits = [w for w in words if w in blob]
            if hits:
                cats[cat] = round(min(0.95, 0.55 + 0.2 * len(hits)), 2)
                evidence.append(f"keywords for {cat}: {', '.join(hits[:3])}")
        if not cats:
            cats["general"] = 0.8
        risky = {"gambling", "betting", "adult", "drugs", "weapons"}
        top = max(cats, key=cats.get)
        risk = 90 if top in risky else 55 if top in {"banking", "cryptocurrency", "trading"} else 10
        return json.dumps({"risk_score": risk, "confidence": 0.7 if evidence else 0.4,
                           "categories": cats, "evidence": evidence})


class UnavailableBackend:
    """Used when no key is set and mock mode is not explicitly enabled. Fails closed:
    callers get AIUnavailable and fall back to the policy's unknown-site default, instead
    of a fake 'general' classification that could let a bad site through."""

    model = "unavailable"

    def generate(self, system: str, prompt: str) -> str:
        raise AIUnavailable("GEMINI_API_KEY not configured")


# Pick the classifier: mock if AI_MODE=mock, Gemini if a key exists, otherwise a backend that fails closed.
def build_backend(config) -> object:
    mode = str(config.get("AI_MODE", "")).lower()
    if mode == "mock":
        return MockBackend()
    key = config.get("GEMINI_API_KEY", "")
    if key:
        return GeminiBackend(key, config.get("GEMINI_MODEL", "gemini-3.8-flash"))
    return UnavailableBackend()
