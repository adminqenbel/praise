from enum import Enum


# What can happen to a page. ASK and REVIEW wait for a parent; WARN lets an adult continue.
class Action(str, Enum):
    ALLOW = "ALLOW"
    BLOCK = "BLOCK"
    REVIEW = "REVIEW"
    ASK = "ASK"
    WARN = "WARN"      # show a warning page; the person may continue (adult version)


# Every kind of site the classifier and the policies know about, grouped as content, financial, security and general.
class Category(str, Enum):
    # content
    ADULT = "adult"
    GAMBLING = "gambling"
    BETTING = "betting"
    DRUGS = "drugs"
    VIOLENCE = "violence"
    WEAPONS = "weapons"
    SELF_HARM = "self_harm"
    # financial
    BANKING = "banking"
    PAYMENT = "payment"
    UPI = "upi"
    WALLET = "digital_wallet"
    TRADING = "trading"
    CRYPTO = "cryptocurrency"
    FOREX = "forex"
    LOANS = "loans"
    BNPL = "bnpl"
    FINANCIAL_PHISHING = "financial_phishing"
    # security
    MALWARE = "malware"
    PHISHING = "phishing"
    SUSPICIOUS = "suspicious_domain"
    SCAM = "scam"
    DANGEROUS_DOWNLOAD = "dangerous_download"
    # general
    SOCIAL_MEDIA = "social_media"
    DATING = "dating"
    GAMING = "gaming"
    STREAMING = "streaming"
    SHOPPING = "shopping"
    EDUCATION = "education"
    RESEARCH = "research"
    GENERAL = "general"
    CUSTOM = "custom"


# The same categories grouped for the dashboard's toggles and the presets.
GROUPS = {
    "content": [Category.ADULT, Category.GAMBLING, Category.BETTING, Category.DRUGS,
                Category.VIOLENCE, Category.WEAPONS, Category.SELF_HARM],
    "financial": [Category.BANKING, Category.PAYMENT, Category.UPI, Category.WALLET,
                  Category.TRADING, Category.CRYPTO, Category.FOREX, Category.LOANS,
                  Category.BNPL, Category.FINANCIAL_PHISHING],
    "security": [Category.MALWARE, Category.PHISHING, Category.SUSPICIOUS, Category.SCAM,
                 Category.DANGEROUS_DOWNLOAD],
    "general": [Category.SOCIAL_MEDIA, Category.DATING, Category.GAMING, Category.STREAMING,
                Category.SHOPPING, Category.EDUCATION, Category.RESEARCH, Category.GENERAL,
                Category.CUSTOM],
}

# Blocked by default even when the parent has no rule for them; only an explicit
# parent allow rule / exception overrides.
SECURITY_CATEGORIES = frozenset(GROUPS["security"] + [Category.FINANCIAL_PHISHING])

ALL_CATEGORY_VALUES = frozenset(c.value for c in Category)


# Turn a string into a Category, or None if it is not one we know (AI output is never trusted to be valid).
def parse_category(value) -> Category | None:
    try:
        return Category(value)
    except ValueError:
        return None
