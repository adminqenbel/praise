"""Labelled domains for evaluating detection. Every phishing entry is invented for this test (none is a real
malicious address); legitimate entries are well-known public sites and brand domains, including tricky ones.

LEGIT: (domain, is_official_brand_domain). BAD: (domain, family). A domain is "flagged" at score >= 0.5.
"""

# Official brand domains (must score exactly 0).
OFFICIAL = [
    "chase.com", "stripe.com", "sbi.co.in", "bankofamerica.com", "paypal.com", "netbanking.hdfcbank.com",
    "accounts.google.com", "onlinesbi.sbi", "icicibank.com", "www.barclays.co.uk", "hsbc.co.uk",
    "login.microsoftonline.com", "smile.amazon.co.uk", "google.co.in", "amazon.com.au", "wellsfargo.com",
    "coinbase.com", "binance.com", "groww.in", "kite.zerodha.com", "paytm.com", "phonepe.com",
    "razorpay.com", "support.apple.com", "appleid.apple.com", "icloud.com", "youtube.com", "linkedin.com",
    "netflix.com", "citi.com", "ing.com", "github.com", "mail.google.com", "online.citibank.co.in",
    "m.facebook.com", "web.whatsapp.com", "venmo.com", "upstox.com", "kotak.com", "axisbank.com",
    "revolut.com", "wise.com", "irctc.co.in", "discord.com", "zoom.us", "dropbox.com",
]

# Legitimate but not brand-owned (must not be flagged): ordinary sites, near-miss words, short names.
ORDINARY = [
    "wikipedia.org", "bbc.co.uk", "nytimes.com", "stackoverflow.com", "cloudflare.com", "mozilla.org",
    "python.org", "kodak.com", "purchase.com", "pineapple.com", "phase.com", "stripes.com", "venom.com",
    "growth.com", "applepie.com", "chaseandsanborn.com", "bobcat.com", "axis.com", "xkcd.com", "irs.gov",
    "data.gov.in", "iitb.ac.in", "nhs.uk", "gov.uk", "paytmmall.com", "sbigeneral.in", "kotaklife.com",
    "bankrate.com", "bankbazaar.com", "loginradius.com", "paycom.com", "securityscorecard.com",
    "accountingtoday.com", "updatestar.com", "geeksforgeeks.org", "w3schools.com", "sbcglobal.net",
    "vkontakte.ru", "chatgpt.com", "huffpost.com", "cricbuzz.com", "makemytrip.com", "moneycontrol.com",
    "xn--mnchen-3ya.de", "xn--bcher-kva.de", "my-cool-blog-site.com", "torvalds.github.io",
    "thebestwebsiteforcheapsportsequipmentonline.com", "citibank.com.sg", "metaldetectors.com",
    "visasforall.com", "stripe-dev-notes.blogspot.com", "ebay.co.nz", "flipkartwholesale.in",
    "hotstar.com", "policybazaar.com", "nsdl.co.in", "bookmyshow.com", "cleartax.in"
]

LEGIT = [(d, True) for d in OFFICIAL] + [(d, False) for d in ORDINARY]

BAD = [
    # typosquats (one or two edits from a brand)
    ("paypall.com", "typo"), ("paypla.com", "typo"), ("peypal.com", "typo"), ("gooogle.com", "typo"),
    ("googel.com", "typo"), ("amazom.com", "typo"), ("amazonn.in", "typo"), ("binnance.com", "typo"),
    ("coinbse.com", "typo"), ("coinbaes.com", "typo"), ("wellsfaro.com", "typo"), ("hdfcbnak.com", "typo"),
    ("icicbank.com", "typo"), ("axisbnak.com", "typo"), ("kotakk.com", "typo"), ("paytn.com", "typo"),
    ("phonepee.com", "typo"), ("razorpya.com", "typo"), ("stripee.com", "typo"), ("netflixx.com", "typo"),
    ("microsfot.com", "typo"), ("mircosoft.com", "typo"), ("linkdin.com", "typo"), ("instagramm.com", "typo"),
    ("faceboook.com", "typo"), ("whatsap.com", "typo"), ("zerodah.com", "typo"), ("citibamk.com", "typo"),
    ("bankofamerca.com", "typo"),
    # look-alike characters (digits, rn/m, Unicode)
    ("paypa1.com", "homoglyph"), ("g00gle.com", "homoglyph"), ("micr0soft.com", "homoglyph"),
    ("rnicrosoft.com", "homoglyph"), ("amaz0n.in", "homoglyph"), ("faceb00k.com", "homoglyph"),
    ("app1e.com", "homoglyph"), ("netfl1x.com", "homoglyph"), ("l1nkedin.com", "homoglyph"),
    ("arnazon.com", "homoglyph"), ("paypai.com", "homoglyph"),
    ("раураl.com", "homoglyph"), ("аррӏе.com", "homoglyph"), ("gооgle.com", "homoglyph"),
    ("microsоft.com", "homoglyph"), ("аmazon.com", "homoglyph"), ("ѕtripe.com", "homoglyph"),
    ("bіnance.com", "homoglyph"), ("ρaypal.com", "homoglyph"),
    # brand + login/payment words
    ("secure-paypal-login.com", "combo"), ("paypal-support.net", "combo"), ("hdfcbank-kyc-update.in", "combo"),
    ("sbi-netbanking-login.xyz", "combo"), ("icici-bank-verify.top", "combo"), ("amazon-gift-claim.click", "combo"),
    ("netflix-billing-update.com", "combo"), ("apple-id-locked.icu", "combo"), ("appleid-verify.com", "combo"),
    ("microsoft-account-security.top", "combo"), ("google-drive-share-login.cyou", "combo"),
    ("binance-wallet-verify.xyz", "combo"), ("coinbase-pro-login.live", "combo"), ("paytm-kyc-update.in", "combo"),
    ("phonepe-refund.top", "combo"), ("wellsfargo-alert.com", "combo"), ("chase-secure-login.com", "combo"),
    ("bankofamerica-verify.net", "combo"), ("instagram-verify-badge.com", "combo"),
    ("whatsapp-gold-update.xyz", "combo"), ("support-razorpay.com", "combo"), ("paypalsecure.com", "combo"),
    ("hdfcbanklogin.com", "combo"), ("axisbank-offers-login.com", "combo"), ("sbi-kyc-update.com", "combo"),
    # brand as subdomain / official domain used as a subdomain
    ("paypal.com.account-verify.xyz", "subdomain"), ("login.hdfcbank.com.verify-now.top", "subdomain"),
    ("www.sbi.co.in.kyc-update.com", "subdomain"), ("accounts.google.com.signin-check.click", "subdomain"),
    ("netflix.com.billing.help", "subdomain"), ("appleid.apple.com.locked.icu", "subdomain"),
    ("secure.chase.com.login-portal.net", "subdomain"), ("amazon.in.orders-verify.top", "subdomain"),
    ("microsoft.com-support.ml", "subdomain"), ("paypal.login.evil.pages.dev", "subdomain"),
    ("hdfcbank.weebly.com", "subdomain"), ("sbi-login.pages.dev", "subdomain"),
    ("icicibank.netbanking.github.io", "subdomain"),
    # brand label on a cheap TLD
    ("hdfcbank.xyz", "brand_tld"), ("icicibank.top", "brand_tld"), ("binance.click", "brand_tld"),
    ("paypal.xyz", "brand_tld"), ("coinbase.icu", "brand_tld"), ("zerodha.work", "brand_tld"),
    # random / generated names
    ("xkqjzvbwmtpl.com", "dga"), ("a8f3k2j9d0s1.net", "dga"), ("qzxwvbnmlkjh.org", "dga"),
    ("9d8f7g6h5j4k.xyz", "dga"), ("kjsdhfkjshdf.info", "dga"), ("zxcvbnmqwrty.com", "dga"),
    ("bvcxzlkjhgf.net", "dga"), ("rtkpvnxzwq.com", "dga"), ("ncjksdnvkj.biz", "dga"),
    ("yqzzkvwxj.com", "dga"), ("3kd9s8f7a6.top", "dga"), ("uyt5r4e3w2q1.com", "dga"),
]

# A second set written after the weights were tuned on the sets above and not used for tuning, to estimate how
# well the scorer generalises (see test_detection.py::test_held_out_set).
HELDOUT_LEGIT = [
    "applebees.com", "citizensbank.com", "amazonia.org", "ubuntu.com", "wisetech.com", "slack.com",
    "notion.so", "figma.com", "canva.com", "reddit.com", "twitch.tv", "imdb.com", "espn.com", "weather.com",
    "craigslist.org", "booking.com", "airbnb.com", "tripadvisor.com", "zillow.com", "etsy.com",
    "shopify.com", "digitalocean.com", "ycombinator.com", "arxiv.org", "nature.com", "ndtv.com",
    "thehindu.com", "olacabs.com", "nykaa.com", "myntra.com", "dream11.com", "bajajfinserv.in",
    "tatacapital.com", "pnbhousing.com", "icicisecurities.com", "mutualfundsindia.com",
    "krakencoffee.com", "visaliacounty.gov", "ebay.co.uk", "mail.yahoo.com", "outlook.office365.com",
    "docs.google.com", "play.google.com", "aws.amazon.com", "developer.apple.com", "status.stripe.com",
    "careers.hsbc.com", "secure.chase.com", "www.paypal.com", "pay.google.com",
]
HELDOUT_BAD = [
    ("paypaal.com", "typo"), ("amazone.com", "typo"), ("gogle.com", "typo"), ("hdfcbanks.com", "typo"),
    ("icicibanks.in", "typo"), ("coinbasse.com", "typo"), ("wellsfragro.com", "typo"), ("barclayss.co.uk", "typo"),
    ("verify-paypal.com", "combo"), ("netbanking-hdfcbank.in", "combo"), ("kotak-mahindra-login.com", "combo"),
    ("login-office365-microsoft.xyz", "combo"), ("binance-support-team.com", "combo"),
    ("unlock-instagram.top", "combo"), ("metamask-wallet-restore.io", "combo"),
    ("claim-coinbase-reward.com", "combo"), ("trustwallet-sync-wallet.xyz", "combo"),
    ("amazon-prime-renewal.top", "combo"), ("sbi-yono-update.in", "combo"), ("chase-fraud-alert.net", "combo"),
    ("www.paypal.com.cgi-bin.webscr.xyz", "subdomain"), ("paypal.com.signin.verify.info", "subdomain"),
    ("hdfcbank.com.netbanking-secure.work", "subdomain"), ("login.microsoftonline.com.auth-check.top", "subdomain"),
    ("pаypal.com", "homoglyph"), ("bаnkofamerica.com", "homoglyph"), ("cοinbase.com", "homoglyph"),
    ("аpple.com", "homoglyph"), ("g0ogle.in", "homoglyph"), ("amazcn.com", "homoglyph"),
    ("wxzqpjvk.com", "dga"), ("kfhdjshgf8d7.com", "dga"), ("lmnbvcxzas.net", "dga"), ("p0o9i8u7y6.xyz", "dga"),
]
