"""Reference data for domain scoring. Pure data: add a brand, a term or a suffix here, not in the algorithms.

Everything is an immutable structure built once at import.
"""

# ---- brands ------------------------------------------------------------------------------------
# name -> (official registrable domains, extra spellings people type, ccTLD variants are genuine?)
# `name` is the canonical token ("paypal"); aliases are other tokens that mean the same brand ("hdfc").
# A trailing "*" on a domain means "also genuine under any ordinary country suffix" (google.* -> google.co.in).
# Banks, wallets, exchanges and big tech: Indian and global.
_BRANDS = {
    # payments and wallets
    "paypal": (("paypal.com*", "paypal.me", "paypalobjects.com"), ()),
    "paytm": (("paytm.com", "paytmbank.com", "paytmpaymentsbank.com"), ()),
    "phonepe": (("phonepe.com",), ()),
    "gpay": (("pay.google.com", "gpay.app.goo.gl"), ("googlepay",)),
    "razorpay": (("razorpay.com",), ()),
    "stripe": (("stripe.com",), ()),
    "venmo": (("venmo.com",), ()),
    "cashapp": (("cash.app", "cashapp.com"), ()),
    "zelle": (("zellepay.com", "zelle.com"), ()),
    "wise": (("wise.com", "transferwise.com"), ("transferwise",)),
    "payoneer": (("payoneer.com",), ()),
    "westernunion": (("westernunion.com*",), ()),
    "bhim": (("bhimupi.org.in", "npci.org.in"), ("bhimupi",)),
    "mobikwik": (("mobikwik.com",), ()),
    "freecharge": (("freecharge.in",), ()),
    "cred": (("cred.club",), ()),
    "visa": (("visa.com*", "visa.co.in"), ()),
    "mastercard": (("mastercard.com*", "mastercard.us"), ()),
    "amex": (("americanexpress.com*", "amex.com"), ("americanexpress",)),
    # Indian banks
    "hdfcbank": (("hdfcbank.com", "hdfcbank.net", "hdfc.com", "hdfcsec.com", "hdfclife.com",
                  "hdfcfund.com", "hdfcergo.com", "hdfcbankprepaid.com"), ("hdfc",)),
    "icicibank": (("icicibank.com", "icici.com", "icicidirect.com", "iciciprulife.com",
                   "icicilombard.com", "icicibank.co.in"), ("icici",)),
    "sbi": (("sbi.co.in", "onlinesbi.sbi", "onlinesbi.com", "sbicard.com", "sbilife.co.in",
             "sbimf.com", "bank.sbi", "sbi.bank.in"), ("onlinesbi", "statebankofindia")),
    "axisbank": (("axisbank.com", "axis.bank.in", "axismf.com", "axisdirect.in"), ("axis",)),
    "kotak": (("kotak.com", "kotak.bank.in", "kotaksecurities.com", "kotakmf.com"),
              ("kotakbank", "kotakmahindra")),
    "pnb": (("pnbindia.in", "netpnb.com"), ("pnbindia",)),
    "bankofbaroda": (("bankofbaroda.in", "bankofbaroda.com", "bobibanking.com"), ("bob",)),
    "canarabank": (("canarabank.com", "canarabank.in"), ()),
    "unionbank": (("unionbankofindia.co.in", "unionbankonline.co.in"), ("unionbankofindia",)),
    "idfcfirst": (("idfcfirstbank.com",), ("idfcbank", "idfc")),
    "yesbank": (("yesbank.in", "yesbank.co.in"), ()),
    "indusind": (("indusind.com", "indusind.bank.in"), ("indusindbank",)),
    "bandhan": (("bandhanbank.com",), ("bandhanbank",)),
    "federalbank": (("federalbank.co.in",), ()),
    "rbi": (("rbi.org.in",), ()),
    "npci": (("npci.org.in",), ()),
    "irctc": (("irctc.co.in", "irctc.com"), ()),
    "uidai": (("uidai.gov.in", "myaadhaar.uidai.gov.in"), ("aadhaar",)),
    "incometax": (("incometax.gov.in", "incometaxindia.gov.in"), ("incometaxindia",)),
    "epfo": (("epfindia.gov.in", "epfindia.com"), ("epfindia",)),
    "zerodha": (("zerodha.com", "kite.zerodha.com"), ()),
    "upstox": (("upstox.com",), ()),
    "groww": (("groww.in",), ()),
    "angelone": (("angelone.in", "angelbroking.com"), ("angelbroking",)),
    "coindcx": (("coindcx.com",), ()),
    "wazirx": (("wazirx.com",), ()),
    # global banks
    "chase": (("chase.com", "jpmorgan.com", "jpmorganchase.com"), ("jpmorgan",)),
    "wellsfargo": (("wellsfargo.com", "wf.com"), ()),
    "bankofamerica": (("bankofamerica.com", "bofa.com", "merrilledge.com"), ("bofa",)),
    "citibank": (("citi.com", "citibank.com", "citibank.co.in", "citigroup.com"), ("citi",)),
    "barclays": (("barclays.co.uk", "barclays.com", "barclaycard.co.uk", "barclaycard.com"),
                 ("barclaycard",)),
    "hsbc": (("hsbc.com*", "hsbc.co.uk", "hsbc.co.in", "hsbc.com.hk"), ()),
    "lloyds": (("lloydsbank.com", "lloydsbank.co.uk", "lloydsbankinggroup.com"), ("lloydsbank",)),
    "natwest": (("natwest.com", "rbs.co.uk", "ulsterbank.ie"), ()),
    "santander": (("santander.com", "santander.co.uk", "santanderbank.com"), ()),
    "capitalone": (("capitalone.com",), ()),
    "usbank": (("usbank.com",), ()),
    "tdbank": (("td.com", "tdbank.com"), ()),
    "rbc": (("rbc.com", "rbcroyalbank.com"), ("royalbank",)),
    "scotiabank": (("scotiabank.com",), ()),
    "commbank": (("commbank.com.au",), ("commonwealthbank",)),
    "anz": (("anz.com", "anz.com.au"), ()),
    "westpac": (("westpac.com.au",), ()),
    "nab": (("nab.com.au",), ()),
    "deutschebank": (("deutsche-bank.de", "db.com"), ()),
    "ing": (("ing.com", "ing.nl", "ing.de", "ing.be", "ing.com.au"), ()),
    "bnpparibas": (("bnpparibas.com", "bnpparibas.fr"), ()),
    "revolut": (("revolut.com",), ()),
    "monzo": (("monzo.com",), ()),
    "dbs": (("dbs.com", "dbs.com.sg"), ()),
    "ubs": (("ubs.com",), ()),
    "discover": (("discover.com",), ()),
    "navyfederal": (("navyfederal.org",), ()),
    "schwab": (("schwab.com",), ()),
    "fidelity": (("fidelity.com",), ()),
    "robinhood": (("robinhood.com",), ()),
    "etrade": (("etrade.com",), ()),
    # exchanges
    "binance": (("binance.com", "binance.us", "binance.in"), ()),
    "coinbase": (("coinbase.com",), ()),
    "kraken": (("kraken.com",), ()),
    "bybit": (("bybit.com",), ()),
    "okx": (("okx.com",), ()),
    "kucoin": (("kucoin.com",), ()),
    "gemini": (("gemini.com",), ()),
    "bitfinex": (("bitfinex.com",), ()),
    "blockchain": (("blockchain.com", "blockchain.info"), ()),
    "metamask": (("metamask.io",), ()),
    "ledger": (("ledger.com",), ()),
    "trezor": (("trezor.io",), ()),
    "opensea": (("opensea.io",), ()),
    "uniswap": (("uniswap.org",), ()),
    "trustwallet": (("trustwallet.com",), ()),
    # big tech and platforms that phishers imitate
    "google": (("google.com*", "gmail.com", "youtube.com", "goo.gl", "g.co", "gstatic.com",
                "withgoogle.com", "google.dev"), ("gmail",)),
    "microsoft": (("microsoft.com", "live.com", "outlook.com", "office.com", "office365.com",
                   "microsoftonline.com", "msn.com", "bing.com", "windows.com", "azure.com",
                   "xbox.com", "skype.com", "onedrive.com", "msft.net"),
                  ("office365", "outlook", "onedrive")),
    "apple": (("apple.com*", "icloud.com", "me.com", "mzstatic.com", "cdn-apple.com"), ("icloud",)),
    "amazon": (("amazon.com*", "amazon.in", "amazon.co.uk", "amazon.de",
                "amazon.ca", "amazon.com.au", "amzn.to", "amzn.com", "primevideo.com", "audible.com",
                "a2z.com", "amazon.jobs", "awsstatic.com", "amazonpay.in"), ("amzn",)),
    "facebook": (("facebook.com", "fb.com", "fb.me", "fbcdn.net", "messenger.com", "meta.com",
                  "facebook.net"), ("meta",)),
    "instagram": (("instagram.com", "cdninstagram.com"), ()),
    "whatsapp": (("whatsapp.com", "whatsapp.net", "wa.me"), ()),
    "twitter": (("twitter.com", "x.com", "t.co", "twimg.com"), ()),
    "linkedin": (("linkedin.com", "licdn.com"), ()),
    "netflix": (("netflix.com", "nflxext.com", "nflximg.net", "nflxso.net"), ()),
    "spotify": (("spotify.com", "scdn.co"), ()),
    "dropbox": (("dropbox.com",), ()),
    "adobe": (("adobe.com", "adobe.io", "typekit.net"), ()),
    "docusign": (("docusign.com", "docusign.net"), ()),
    "zoom": (("zoom.us", "zoom.com"), ()),
    "github": (("github.com",), ()),
    "steam": (("steampowered.com", "steamcommunity.com", "steamstatic.com"), ("steampowered",)),
    "roblox": (("roblox.com", "rbxcdn.com"), ()),
    "discord": (("discord.com", "discord.gg", "discordapp.com"), ("discordapp",)),
    "telegram": (("telegram.org", "t.me", "telegram.me"), ()),
    "ebay": (("ebay.com*", "ebay.in"), ()),
    "flipkart": (("flipkart.com", "fkcdn.com"), ()),
    "walmart": (("walmart.com",), ()),
    "dhl": (("dhl.com", "dhl.de"), ()),
    "fedex": (("fedex.com",), ()),
    "ups": (("ups.com",), ()),
    "usps": (("usps.com",), ()),
    "indiapost": (("indiapost.gov.in",), ()),
    "airtel": (("airtel.in", "airtel.com"), ()),
    "jio": (("jio.com", "ril.com"), ()),
    "swiggy": (("swiggy.com",), ()),
    "zomato": (("zomato.com",), ()),
}

# Neutral filler that can sit around a brand without changing what the name means.
FILLER = frozenset(("my", "the", "of", "and", "in", "us", "uk", "usa", "india", "global", "new", "net",
                    "www", "com", "org", "co", "in", "inc", "ltd", "group", "world", "now", "get", "go",
                    "to", "for", "your", "you", "one", "pro", "plus", "my", "e", "i"))

# Words that make a domain look like a login, payment or support page. `weight` is not per term:
# the scorer counts how many distinct terms appear (see score.py).
TERMS = frozenset((
    "bank", "banking", "netbanking", "login", "signin", "logon", "secure", "security", "verify",
    "verification", "account", "wallet", "pay", "payment", "upi", "kyc", "update", "billing", "otp",
    "support", "help", "service", "services", "customer", "care", "online", "official", "alert",
    "confirm", "suspended", "unlock", "recover", "recovery", "refund", "reward", "rewards", "claim",
    "bonus", "offer", "card", "credit", "debit", "loan", "invoice", "portal", "web", "auth",
    "authenticate", "validate", "access", "id", "password", "reset", "mobile", "app", "customercare",
    "helpdesk", "team", "center", "centre", "limited", "restore", "activate", "activation", "form",
    "check", "status", "tracking", "track", "delivery", "notice", "urgent", "document",
))
# Words that are decisive for scoring (they mean "this page wants your credentials or money").
STRONG_TERMS = frozenset((
    "login", "signin", "logon", "secure", "security", "verify", "verification", "account", "wallet",
    "kyc", "update", "billing", "otp", "confirm", "suspended", "unlock", "recover", "recovery",
    "refund", "claim", "password", "reset", "restore", "activate", "validate", "authenticate",
    "netbanking", "support", "helpdesk", "customercare", "alert", "urgent",
))

# Cheap TLDs that are over-represented in scam sites; a hint, never proof.
SUSPICIOUS_TLDS = frozenset((
    "xyz", "top", "click", "icu", "work", "buzz", "gq", "tk", "ml", "cf", "ga", "cyou", "rest", "live",
    "sbs", "cfd", "monster", "quest", "bond", "lol", "zip", "mov", "support", "loan", "men", "country",
    "stream", "download", "review", "party", "racing", "date", "accountant", "science", "trade",
    "bid", "kim", "link", "fit", "best", "life", "site", "online", "shop", "store", "vip", "wang",
    "pw", "su", "cc", "ws", "mom", "autos", "boats", "beauty", "hair", "skin", "makeup",
))
# TLDs that are suspicious on their own but not enough on their own to matter (common for real small sites).
MILD_TLDS = frozenset(("online", "site", "shop", "store", "life", "live", "link", "best", "cc", "ws"))

# Country suffixes that are genuine for a brand written "xxx.com*". The free/abused ccTLDs are excluded.
ABUSED_CCTLDS = frozenset(("tk", "ml", "ga", "cf", "gq", "cc", "ws", "pw", "su", "to", "top"))

# ---- public suffixes ---------------------------------------------------------------------------
# A compact subset of the Public Suffix List: multi-label registries and the free hosts where anyone
# can create a name under the suffix (so the part the attacker chooses is the label to the left).
MULTI_SUFFIXES = frozenset("""
co.uk org.uk me.uk ltd.uk plc.uk net.uk sch.uk ac.uk gov.uk nhs.uk police.uk
com.au net.au org.au edu.au gov.au asn.au id.au
co.in net.in org.in firm.in gen.in ind.in ac.in edu.in res.in gov.in nic.in
com.br net.br org.br gov.br edu.br
co.jp ne.jp or.jp ac.jp go.jp ad.jp
co.nz net.nz org.nz govt.nz ac.nz school.nz
co.za org.za web.za gov.za ac.za
com.sg org.sg edu.sg gov.sg net.sg
com.hk org.hk edu.hk gov.hk net.hk
com.my org.my edu.my gov.my net.my
com.ph org.ph edu.ph gov.ph net.ph
com.pk org.pk edu.pk gov.pk net.pk
com.bd org.bd edu.bd gov.bd net.bd
com.lk org.lk edu.lk gov.lk
com.ng org.ng edu.ng gov.ng
co.ke or.ke ac.ke go.ke
com.tr org.tr edu.tr gov.tr net.tr
com.mx org.mx edu.mx gob.mx net.mx
com.ar org.ar edu.ar gob.ar net.ar
com.co org.co edu.co gov.co net.co
com.cn org.cn edu.cn gov.cn net.cn
com.tw org.tw edu.tw gov.tw net.tw idv.tw
co.kr or.kr ac.kr go.kr ne.kr
co.id or.id ac.id go.id web.id my.id biz.id sch.id
co.th or.th ac.th go.th in.th
com.vn net.vn org.vn edu.vn gov.vn
com.eg org.eg edu.eg gov.eg
com.sa org.sa edu.sa gov.sa
com.ae net.ae org.ae gov.ae ac.ae
co.il org.il ac.il gov.il
com.ua org.ua gov.ua net.ua
com.pe org.pe edu.pe gob.pe
com.ve org.ve
com.ec org.ec
com.uy org.uy
com.gh org.gh
co.tz or.tz go.tz
co.ug or.ug go.ug
co.zw
co.bw
com.np org.np edu.np gov.np
com.kh org.kh
com.mm
com.bh
com.kw
com.qa
com.om
com.jo
com.lb
com.cy
com.mt
com.gr
com.pl net.pl org.pl
com.pt
com.ro
com.ru
gov.pl
""".split())
# Free hosts / app platforms: names under these are created by whoever signs up.
HOSTING_SUFFIXES = frozenset("""
github.io gitlab.io pages.dev workers.dev web.app firebaseapp.com netlify.app vercel.app herokuapp.com
onrender.com glitch.me repl.co replit.app 000webhostapp.com weebly.com wixsite.com blogspot.com
wordpress.com webflow.io framer.app carrd.co godaddysites.com square.site myshopify.com
azurewebsites.net cloudfront.net appspot.com web.core.windows.net r2.dev trycloudflare.com ngrok.io
ngrok-free.app duckdns.org no-ip.org ddns.net hopto.org serveo.net surge.sh now.sh fly.dev railway.app
bubbleapps.io notion.site typedream.app webcindario.com infinityfreeapp.com rf.gd epizy.com
""".split())

# ---- unicode lookalikes ------------------------------------------------------------------------
# Characters that render like a Latin letter in common fonts (UTS #39 style, trimmed to what matters
# in domain names). NFKD already folds accents, full-width forms and most compatibility characters.
CONFUSABLES = {
    # Cyrillic
    "а": "a", "в": "b", "ѕ": "s", "е": "e", "ё": "e", "і": "i", "ї": "i", "ј": "j", "к": "k",
    "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ь": "b",
    "һ": "h", "ԁ": "d", "ԛ": "q", "ԝ": "w", "ӏ": "l", "ѵ": "v", "ү": "y", "ғ": "f", "ԍ": "g",
    "ɡ": "g", "ᴀ": "a", "ɑ": "a", "ɩ": "i", "ı": "i", "ł": "l", "ø": "o", "ð": "d", "đ": "d",
    "ƒ": "f", "ƙ": "k", "ɓ": "b", "ɗ": "d", "ƴ": "y", "ʋ": "v", "ʀ": "r", "ɴ": "n", "ɢ": "g",
    # Greek
    "α": "a", "β": "b", "γ": "y", "ε": "e", "ι": "i", "κ": "k", "μ": "u", "ν": "v", "ο": "o",
    "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w", "η": "n", "ϲ": "c", "ϳ": "j", "ϸ": "p",
    # Armenian, Hebrew, Cherokee and others that borrow Latin shapes
    "օ": "o", "ս": "u", "ո": "n", "ք": "p", "գ": "q", "ց": "g", "ա": "w",
    "ס": "o", "ו": "l", "ᏼ": "b", "ꓲ": "l",
    # Latin ligatures and extended letters
    "æ": "ae", "œ": "oe", "ß": "ss",
    # separators people use instead of a hyphen or dot
    "‐": "-", "‑": "-", "–": "-", "—": "-", "。": ".", "｡": ".", "․": ".",
}
# Letter-for-digit and symbol swaps, plus the i/l/1/| family that fonts draw almost identically.
LEET = {"0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "$": "s", "@": "a",
        "!": "l", "|": "l", "i": "l"}
# Multi-letter lookalikes, applied after the single-letter fold.
MULTI_FOLD = (("rn", "m"), ("vv", "w"), ("cl", "d"), ("ii", "u"), ("nn", "m"))

# QWERTY neighbours, for "fat finger" substitutions.
_ROWS = ("qwertyuiop", "asdfghjkl", "zxcvbnm")
KEYBOARD_NEIGHBOURS: dict[str, frozenset] = {}


def _build_keyboard():
    pos = {ch: (r, c) for r, row in enumerate(_ROWS) for c, ch in enumerate(row)}
    for ch, (r, c) in pos.items():
        KEYBOARD_NEIGHBOURS[ch] = frozenset(
            o for o, (r2, c2) in pos.items() if o != ch and abs(r - r2) <= 1 and abs(c - c2) <= 1)


_build_keyboard()

# ---- words that look like a typo of a brand but are ordinary words or other companies ----------
BENIGN_NEAR = frozenset("""
phase case chasm chaser chose chaise purchase venom venomous grow growl growth strip stripes striped
apples applet appel paypals bankers banker banks banking bankrate lloyd lloyds wise wiser wisely
visas vista visage zoom zoomed zoomer discord discover discoverer gem gems gemini steam steamy
ledger ledgers kraken krakow cred credo creed credit googly goggle goggles adobo metal metas
amazing kodak
""".split())

# Real, unrelated sites whose names sit one edit from a brand.
LEGIT_LOOKALIKE_DOMAINS = frozenset("""
kodak.com goggle.com venom.com chasm.com purchase.com phase.com stripes.com growth.com
""".split())

# Tokens that are common English words as well as brand names: they only count as a brand when they
# stand alone or are directly combined with a term, never when hidden inside a longer word.
AMBIGUOUS_BRANDS = frozenset((
    "apple", "chase", "stripe", "visa", "meta", "citi", "ing", "wise", "gemini", "ledger", "kraken",
    "steam", "zoom", "discord", "discover", "cred", "gpay", "bob", "axis", "ups", "dhl", "nab", "anz",
    "rbc", "ubs", "dbs", "sbi", "pnb", "okx", "jio", "rbi", "npci", "x", "me", "amex", "cash",
))

# ---- derived lookups ---------------------------------------------------------------------------


def _build():
    official = {}        # registrable domain -> brand
    official_cc = {}     # "paypal" label base for domains marked "*" -> brand
    tokens = {}          # token (name or alias) -> brand
    for name, (domains, aliases) in _BRANDS.items():
        tokens[name] = name
        for a in aliases:
            tokens.setdefault(a, name)
        for d in domains:
            if d.endswith("*"):
                d = d[:-1]
                official_cc[d.split(".")[0]] = name
            official[d] = name
    return official, official_cc, tokens


OFFICIAL, OFFICIAL_CC, BRAND_TOKENS = _build()
BRANDS = tuple(_BRANDS)
# brand name -> the domain to suggest instead of an imitation
SUGGEST = {name: next(iter(doms)).rstrip("*") for name, (doms, _) in _BRANDS.items()}
