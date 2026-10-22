"""Well-known sites, pre-classified so everyday browsing never waits on (or is blocked by)
an AI call. Seeded rows are ADMIN_VERIFIED with source="seed": a seeded domain also covers
its subdomains (accounts.google.com), which ordinary rows never do.

The category still goes through each parent's policy, so Child Safe closes seeded social
media and money sites exactly as it would closes an AI-classified one.
"""
from database.models import Site
from database.postgres import db

# category -> (risk, domains)
# The curated list: for each category, a default risk score and the well-known domains in it.
SEED = {
    "general": (5, """
        google.com bing.com duckduckgo.com ecosia.org yahoo.com microsoft.com office.com live.com
        outlook.com microsoftonline.com apple.com icloud.com github.com stackoverflow.com
        zoom.us canva.com bbc.com bbc.co.uk nytimes.com theguardian.com thehindu.com
        timesofindia.indiatimes.com ndtv.com weather.com""".split()),
    "research": (5, """
        wikipedia.org wikimedia.org britannica.com nationalgeographic.com nasa.gov noaa.gov
        scholar.archive.org archive.org""".split()),
    "education": (5, """
        khanacademy.org coursera.org edx.org duolingo.com codecademy.com w3schools.com
        developer.mozilla.org scratch.mit.edu mit.edu stanford.edu harvard.edu openstax.org
        ted.com byjus.com vedantu.com diksha.gov.in ncert.nic.in""".split()),
    "streaming": (10, "youtube.com youtu.be netflix.com spotify.com primevideo.com hotstar.com twitch.tv".split()),
    "social_media": (20, """
        facebook.com instagram.com x.com twitter.com tiktok.com reddit.com snapchat.com
        discord.com whatsapp.com telegram.org pinterest.com linkedin.com""".split()),
    "gaming": (15, "roblox.com minecraft.net steampowered.com epicgames.com ea.com".split()),
    "shopping": (10, "amazon.com amazon.in ebay.com flipkart.com etsy.com".split()),
    "banking": (30, "hdfcbank.com icicibank.com onlinesbi.sbi sbi.co.in axisbank.com kotak.com chase.com bankofamerica.com wellsfargo.com hsbc.com".split()),
    "payment": (30, "paypal.com paytm.com razorpay.com stripe.com venmo.com".split()),
    "upi": (30, "phonepe.com".split()),
    "cryptocurrency": (45, "binance.com coinbase.com wazirx.com".split()),
    "trading": (35, "zerodha.com upstox.com groww.in".split()),
}


def seed_sites() -> tuple[int, int]:
    """Insert missing rows and replace AI guesses with the curated entry.

    Never touches a row an admin verified (source="admin") or one already seeded.
    Returns (added_or_upgraded, left_alone).
    """
    # Load every row once so seeding hundreds of domains needs a single query.
    existing = {s.domain: s for s in Site.query.all()}
    changed = left = 0
    for category, (risk, domains) in SEED.items():
        for domain in domains:
            site = existing.get(domain)
            if site is None:
                site = Site(domain=domain)
                db.session.add(site)
                existing[domain] = site
            elif site.source in ("admin", "seed") or site.status == "ADMIN_VERIFIED":
                left += 1
                continue
            site.category, site.risk, site.confidence = category, risk, 1.0
            site.source, site.status, site.needs_reanalysis = "seed", "ADMIN_VERIFIED", False
            changed += 1
    db.session.commit()
    return changed, left
