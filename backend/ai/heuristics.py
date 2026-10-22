"""Deterministic pre-signals computed before (and independent of) any AI call.

Used for financial-phishing detection: lookalike brand + bank terms + login form +
suspicious TLD. Output feeds the Gemini prompt and is merged into the final scores.
"""
import re

# Banks, wallets and exchanges that phishing sites imitate.
KNOWN_BRANDS = {
    "paypal", "paytm", "phonepe", "gpay", "googlepay", "hdfc", "hdfcbank", "icici", "icicibank",
    "sbi", "onlinesbi", "axisbank", "kotak", "barclays", "hsbc", "chase", "wellsfargo",
    "bankofamerica", "citibank", "binance", "coinbase", "razorpay", "stripe", "venmo",
    "zerodha", "upstox", "groww",
}
# Legitimate registrable domains for the brands above (prevents flagging the real sites).
OFFICIAL_DOMAINS = {
    "paypal.com", "paytm.com", "phonepe.com", "hdfcbank.com", "icicibank.com", "onlinesbi.sbi",
    "sbi.co.in", "axisbank.com", "kotak.com", "barclays.co.uk", "hsbc.com", "chase.com",
    "wellsfargo.com", "bankofamerica.com", "citi.com", "binance.com", "coinbase.com",
    "razorpay.com", "stripe.com", "venmo.com", "zerodha.com", "upstox.com", "groww.in",
}
# Words that make a domain look like a login or payment page.
BANK_TERMS = ("bank", "login", "signin", "secure", "verify", "account", "wallet", "pay",
              "upi", "kyc", "update", "billing", "netbanking", "otp")
# Cheap TLDs that are over-represented in scam sites; a hint, never proof.
SUSPICIOUS_TLDS = {".xyz", ".top", ".click", ".icu", ".work", ".buzz", ".gq", ".tk", ".ml",
                   ".cf", ".ga", ".cyou", ".rest", ".live"}

_NON_ALNUM = re.compile(r"[^a-z0-9]")


def official_for(brand: str) -> str | None:
    """The brand's real domain, to offer instead of a look-alike."""
    matches = sorted(d for d in OFFICIAL_DOMAINS if brand in d.split(".")[0] or d.split(".")[0] in brand)
    return matches[0] if matches else None


def phishing_signals(domain: str, signals: dict | None = None) -> dict:
    """Return {score: 0..1, reasons: [...]}. Pure and cheap."""
    signals = signals or {}
    domain = domain.lower()
    reasons = []
    score = 0.0
    official = None

    # The real brand sites are never flagged.
    if any(domain == d or domain.endswith("." + d) for d in OFFICIAL_DOMAINS):
        return {"score": 0.0, "reasons": ["official brand domain"]}

    # Strip dots and hyphens so 'pay-pal.xyz' and 'paypal.xyz' are caught the same way.
    flat = _NON_ALNUM.sub("", domain.rsplit(".", 1)[0])
    brand = next((b for b in sorted(KNOWN_BRANDS, key=len, reverse=True) if b in flat), None)
    if brand:
        score += 0.4
        reasons.append(f"contains brand name '{brand}' on an unofficial domain")
        official = official_for(brand)

    terms = [t for t in BANK_TERMS if t in flat]
    if terms:
        score += min(0.2, 0.07 * len(terms))
        reasons.append("bank/login terms in domain: " + ", ".join(terms[:4]))

    tld = "." + domain.rsplit(".", 1)[-1]
    if tld in SUSPICIOUS_TLDS:
        score += 0.15
        reasons.append(f"suspicious TLD {tld}")

    if domain.count("-") >= 2:
        score += 0.1
        reasons.append("multiple hyphens in domain")

    if signals.get("has_password_field"):
        score += 0.15 if (brand or terms) else 0.05
        reasons.append("page has a password/login form")

    # Score adds up brand + bank words + odd TLD + hyphens + login form, capped at 1.0.
    return {"score": round(min(score, 1.0), 2), "reasons": reasons, "brand": brand,
            "official": official if brand else None}
