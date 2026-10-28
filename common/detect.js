// Phishing / scam scoring shared by the extension, the local agent and Node tests (see docs/DETECTION-CONTRACT.md,
// docs/BROWSER-DETECTION.md). Pure helpers only: no chrome.*, no network, deterministic. Indexes are built lazily, once.
//
// Evidence is fused in log-odds: score = sigmoid(PRIOR + sum of evidence weights). Every weight below is the log-odds
// shift one observation adds; the named table W is what the docs list. A score only ever adds caution.
(function (root) {
  "use strict";

  const VERSION = 2;
  const PRIOR = -4.0;                                  // a site with no evidence at all: about 1.8%

  // ---- evidence weights (log-odds) ------------------------------------------------------------------------
  const W = {
    // brand imitation (only the strongest one counts)
    brand_exact_gtld: 4.4,        // paypal.org: the brand's name on a TLD it does not use
    brand_exact_cctld: 2.2,       // paypal.pk: brands do own country domains, so a weaker signal
    homoglyph: 6.0,               // paypa1.com, раураl.com: looks identical once look-alike characters are folded
    typo_1: 4.8, typo_2: 3.8,     // one or two edits away from a brand (Damerau-Levenshtein)
    typo_kb: 0.4, typo_swap: 0.4, // the slip is a neighbouring key / swapped letters: more likely deliberate
    combo: 4.4, combo_short: 2.6, // brand + other words: paypal-support.com (short brand names are weaker)
    embedded: 3.6,                // paypalsecure.com
    sub_brand: 4.6,               // paypal.evil.xyz
    sub_domain: 0.9,              // paypal.com.evil.xyz: a whole domain name placed in front of another
    brand_path: 1.4, brand_path_login: 0.8,
    brand_userinfo: 3.0,
    brand_keyword: 0.6,           // brand evidence plus a login/verify word
    // lexical
    mixed_script: 6.0, idn: 0.8, look_latin: 2.5,
    ip_host: 3.0, userinfo: 3.0, ip_login: 0.8, port_odd: 0.9, port_alt: 0.4,
    susp_tld: 1.2, weak_tld: 0.5, free_host: 0.6, shortener: 0.6,
    kw1: 0.4, kw2: 1.4, kw3: 2.2, kw4: 2.8,
    hyphens2: 0.5, hyphens3: 1.4, subs3: 0.6, subs5: 1.2, digits: 0.5,
    len100: 0.4, len200: 0.8, host30: 0.4, host50: 0.8, encoded: 0.6, redirect_param: 0.5, http: 0.4,
    dga_min: 1.0, dga_max: 4.5,
    // page
    pw_alone: 0.3, pw_cross_form: 2.2, pw_insecure_action: 1.2, pw_http_page: 1.0, form_ip: 1.5, form_free_host: 0.8,
    form_mailto: 2.0, ask_cross_form: 1.2,
    page_brand_pw: 2.8, page_brand: 0.5, page_brand_text_pw: 1.0,
    lex_urgency: 0.5, lex_threat: 0.7, lex_ask: 0.6, lex_reward: 0.6, lex_support: 0.8, lex_cap: 3.5, lex_multi: 0.6, lex_pw: 0.8,
    iframe1: 0.5, iframe3: 1.1, iframe_pw: 0.5, scripts12: 0.4, scripts25: 0.8, entropy_hi: 0.8, entropy_vhi: 1.5,
    combine_decay: 0.75,
  };

  // ---- small helpers --------------------------------------------------------------------------------------
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const logit = (p) => { p = Math.min(Math.max(p, 1e-4), 1 - 1e-4); return Math.log(p / (1 - p)); };
  const round3 = (x) => Math.round(x * 1000) / 1000;

  function levelOf(score) {
    return score >= 0.75 ? "high" : score >= 0.5 ? "medium" : score >= 0.25 ? "low" : "none";
  }

  function none() {
    return { score: 0, level: "none", reasons: [], brand: null, official: null, features: {} };
  }

  function verdictFrom(evidence, brand, official, features) {
    let z = PRIOR;
    for (let i = 0; i < evidence.length; i++) z += evidence[i][0];
    const score = round3(sigmoid(z));
    evidence.sort((a, b) => b[0] - a[0]);
    const reasons = [];
    for (let i = 0; i < evidence.length && reasons.length < 6; i++) {
      if (evidence[i][1] && reasons.indexOf(evidence[i][1]) === -1) reasons.push(evidence[i][1]);
    }
    features.logit = round3(z);
    return { score, level: levelOf(score), reasons, brand: brand || null, official: official || null, features };
  }

  // ---- public suffixes (small embedded subset) ------------------------------------------------------------
  // Multi-label suffixes of the busiest country registries, plus free-hosting platforms that behave like a public
  // suffix (anyone can open a name under them), as the real list does.
  const COUNTRY_SUFFIXES = ("co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk com.au net.au org.au edu.au gov.au " +
    "id.au co.nz org.nz net.nz govt.nz ac.nz co.in net.in org.in ac.in gov.in edu.in res.in nic.in firm.in gen.in ind.in " +
    "co.jp ne.jp or.jp ac.jp go.jp co.kr or.kr go.kr co.za org.za gov.za ac.za com.br net.br org.br gov.br edu.br " +
    "com.cn net.cn org.cn gov.cn edu.cn com.hk org.hk edu.hk gov.hk com.tw org.tw edu.tw gov.tw com.sg org.sg edu.sg gov.sg " +
    "com.my org.my edu.my gov.my com.mx org.mx gob.mx edu.mx com.ar org.ar gob.ar com.co org.co com.pe com.ve com.tr org.tr " +
    "edu.tr gov.tr com.pk org.pk edu.pk gov.pk com.bd org.bd com.ng org.ng gov.ng com.eg org.eg com.sa org.sa com.ua org.ua " +
    "com.ph org.ph com.vn org.vn com.pl com.ru co.id or.id co.th in.th ac.th com.lk co.il org.il ac.il co.ke or.ke com.gh " +
    "com.np com.kw com.qa com.om com.jo com.lb com.ec com.uy com.py com.bo com.gt com.do com.pa com.cr com.sv com.hn com.es " +
    "com.pt com.gr com.ro com.de co.at com.ae co.ae net.ae org.ae gov.ae com.bh com.cy com.mt com.mk com.ba").split(" ");
  const FREE_HOSTS = ("github.io gitlab.io pages.dev workers.dev netlify.app vercel.app herokuapp.com blogspot.com web.app " +
    "firebaseapp.com weebly.com wixsite.com glitch.me repl.co onrender.com azurewebsites.net appspot.com duckdns.org ngrok.io " +
    "ngrok-free.app trycloudflare.com carrd.co godaddysites.com myshopify.com notion.site webflow.io square.site " +
    "000webhostapp.com infinityfreeapp.com epizy.com rf.gd byethost.com 5gl.xyz mystrikingly.com yolasite.com wordpress.com " +
    "blogspot.in wuaze.com framer.app bubbleapps.io r2.dev cloudfront.net surge.sh fly.dev railway.app").split(" ");
  const SUFFIXES = new Set(COUNTRY_SUFFIXES.concat(FREE_HOSTS));
  const FREE_SET = new Set(FREE_HOSTS);

  const SUSP_TLD = new Set(["xyz", "top", "click", "icu", "work", "buzz", "gq", "tk", "ml", "cf", "ga", "cyou", "rest", "live",
    "cam", "sbs", "cfd", "monster", "quest", "vip", "loan", "men", "bid", "win", "date", "racing", "review", "stream", "download",
    "zip", "mov", "support", "country", "kim", "party", "accountant", "science", "trade", "webcam", "uno", "fit"]);
  const WEAK_TLD = new Set(["info", "online", "site", "shop", "store", "website", "link", "club", "fun", "space", "pw", "ws", "cc",
    "life", "world", "today", "biz", "co"]);
  const TLD_LIKE = new Set(["com", "net", "org", "co", "in", "gov", "edu", "info", "biz"]);
  const SHORTENERS = new Set(["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly",
    "shorturl.at", "tiny.cc", "rb.gy", "lnkd.in", "s.id", "v.gd"]);

  // Split a lower-case host into parts. `reg` is the registrable domain (name + public suffix).
  function parseHost(host) {
    const labels = host.split(".");
    const n = labels.length;
    let sl = 1;
    if (n >= 3 && SUFFIXES.has(labels[n - 2] + "." + labels[n - 1])) sl = 2;
    else if (n === 2 && SUFFIXES.has(host)) return { labels, sld: "", suffix: host, reg: host, subs: [] };
    return {
      labels,
      sld: labels[n - sl - 1] || "",
      suffix: sl === 1 ? labels[n - 1] : labels[n - 2] + "." + labels[n - 1],
      reg: labels.slice(n - sl - 1).join("."),
      subs: labels.slice(0, n - sl - 1),
    };
  }

  // ---- punycode (RFC 3492 decoder) ------------------------------------------------------------------------
  function punycodeDecode(input) {
    const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
    let n = 128, i = 0, bias = 72;
    const out = [];
    let b = input.lastIndexOf("-");
    if (b < 0) b = 0;
    for (let j = 0; j < b; j++) out.push(input.charCodeAt(j));
    const adapt = (delta, num, first) => {
      delta = first ? Math.floor(delta / damp) : delta >> 1;
      delta += Math.floor(delta / num);
      let k = 0;
      while (delta > (((base - tMin) * tMax) >> 1)) { delta = Math.floor(delta / (base - tMin)); k += base; }
      return Math.floor(k + ((base - tMin + 1) * delta) / (delta + skew));
    };
    for (let idx = b > 0 ? b + 1 : 0; idx < input.length;) {
      const oldi = i;
      for (let w = 1, k = base; ; k += base) {
        if (idx >= input.length) throw new Error("punycode");
        const cp = input.charCodeAt(idx++);
        const digit = cp - 48 < 10 ? cp - 22 : cp - 65 < 26 ? cp - 65 : cp - 97 < 26 ? cp - 97 : base;
        if (digit >= base) throw new Error("punycode");
        i += digit * w;
        const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
        if (digit < t) break;
        w *= base - t;
      }
      bias = adapt(i - oldi, out.length + 1, oldi === 0);
      n += Math.floor(i / (out.length + 1));
      i %= out.length + 1;
      out.splice(i++, 0, n);
    }
    return String.fromCodePoint.apply(null, out);
  }

  // A host label as people read it: punycode (xn--) decoded to Unicode, otherwise unchanged.
  function displayLabel(label) {
    if (label.length > 4 && label.charCodeAt(0) === 120 && label.startsWith("xn--")) {
      try { return punycodeDecode(label.slice(4)); } catch (e) { return label; }
    }
    return label;
  }

  // ---- confusables ------------------------------------------------------------------------------------------
  // Characters from other alphabets that are drawn like a Latin letter (a practical subset of Unicode's confusables).
  const CONFUSABLE = new Map();
  (function () {
    const pairs = {
      a: "аɑαа", c: "сϲсⅽ", e: "еҽεе", o: "оοօ0о", p: "рρр", x: "хχх", y: "уүγу", i: "іιíìïıӏ¡", j: "јϳ", s: "ѕѕ",
      d: "ԁ", h: "һ", l: "ӏⅼłǀ", q: "ԛ", w: "ԝ", k: "кκ", m: "м", t: "тτ", n: "ո", u: "υս", v: "νѵ", b: "ь", g: "ɡԍ",
      z: "ᴢ", f: "ғ", r: "г",
    };
    for (const k of Object.keys(pairs)) for (const ch of pairs[k]) if (ch.charCodeAt(0) > 127) CONFUSABLE.set(ch, k);
  })();
  const DIGIT_FOLD = { 48: "o", 49: "l", 51: "e", 52: "a", 53: "s", 54: "g", 55: "t", 56: "b", 57: "g" };

  // Fold a lower-case label so that look-alike spellings collide: other-alphabet letters and accents become Latin,
  // digits that read as letters become those letters, i/1/l are one letter, and rn / vv / cl become m / w / d.
  function skeleton(s) {
    if (/[^\x00-\x7f]/.test(s)) {
      let t = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
      let o = "";
      for (const ch of t) o += CONFUSABLE.get(ch) || ch;
      s = o;
    }
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 48 && c <= 57) out += DIGIT_FOLD[c];
      else if (c === 105) out += "l";
      else out += s[i];
    }
    return out.replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d");
  }

  // Latin plus Cyrillic / Greek / Armenian letters in one label: the classic homograph trick.
  function mixedScript(label) {
    let latin = false, other = false;
    for (let i = 0; i < label.length; i++) {
      const c = label.charCodeAt(i);
      if (c < 128) { if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) latin = true; }
      else if ((c >= 0x370 && c <= 0x3ff) || (c >= 0x400 && c <= 0x52f) || (c >= 0x530 && c <= 0x58f)) other = true;
      if (latin && other) return true;
    }
    return false;
  }

  // ---- edit distance + keyboard -----------------------------------------------------------------------------
  const DL_A = new Int32Array(64), DL_B = new Int32Array(64), DL_C = new Int32Array(64);
  // Damerau-Levenshtein (optimal string alignment), abandoned as soon as it must exceed `max`.
  function editDistance(a, b, max) {
    const la = a.length, lb = b.length;
    if (la - lb > max || lb - la > max) return max + 1;
    if (la > 60 || lb > 60) return max + 1;
    let p2 = DL_C, p1 = DL_A, cur = DL_B;
    for (let j = 0; j <= lb; j++) p1[j] = j;
    for (let i = 1; i <= la; i++) {
      cur[0] = i;
      let rowMin = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= lb; j++) {
        const cb = b.charCodeAt(j - 1);
        let v = p1[j] + 1;
        const ins = cur[j - 1] + 1;
        if (ins < v) v = ins;
        const sub = p1[j - 1] + (ca === cb ? 0 : 1);
        if (sub < v) v = sub;
        if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) {
          const t = p2[j - 2] + 1;
          if (t < v) v = t;
        }
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      const tmp = p2; p2 = p1; p1 = cur; cur = tmp;
    }
    return p1[lb];
  }

  let KB = null;
  function keysAdjacent(x, y) {
    if (!KB) {
      KB = new Map();
      const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"], off = [0, 0.25, 0.75];
      for (let r = 0; r < 3; r++) for (let c = 0; c < rows[r].length; c++) KB.set(rows[r][c], [r, c + off[r]]);
    }
    const p = KB.get(x), q = KB.get(y);
    return !!(p && q && Math.abs(p[0] - q[0]) <= 1 && Math.abs(p[1] - q[1]) <= 1.1 && x !== y);
  }

  // For a pair at distance 1 and equal length: was it one neighbouring-key slip, or two letters swapped?
  function slipKind(a, b) {
    if (a.length !== b.length) return null;
    let first = -1, count = 0;
    for (let i = 0; i < a.length; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) { if (first < 0) first = i; count++; }
    if (count === 1) return keysAdjacent(a[first], b[first]) ? "kb" : null;
    if (count === 2 && a[first] === b[first + 1] && a[first + 1] === b[first]) return "swap";
    return null;
  }

  // ---- brand data -------------------------------------------------------------------------------------------
  // "names ; official registrable domains". The first name is the brand, the first domain is what we suggest.
  // Names shorter than 5 letters only ever match as a whole word (see matchToken).
  const BRAND_DATA = [
    "paypal ; paypal.com paypal.me paypalobjects.com paypal.co.uk paypal.in paypal.de paypal.fr paypal.it paypal.es paypal.ca paypal.com.au paypal.com.br paypal.com.mx paypal.jp paypal.nl paypal-community.com braintreegateway.com",
    "google gmail youtube googlemail ; google.com gmail.com youtube.com youtu.be ytimg.com googleapis.com gstatic.com googleusercontent.com googlevideo.com google.co.in google.co.uk google.de google.fr google.ca google.com.au google.com.br google.co.jp google.es google.it google.nl google.ru google.com.mx google.org withgoogle.com googlemail.com android.com chromium.org web.dev google.dev",
    "microsoft outlook office365 onedrive skype xbox hotmail msteams azure ; microsoft.com live.com outlook.com office.com office365.com microsoftonline.com sharepoint.com onedrive.com skype.com xbox.com hotmail.com msn.com bing.com azure.com windows.com msft.net live.net visualstudio.com microsoft.net",
    "apple icloud itunes ; apple.com icloud.com me.com mzstatic.com apple.co cdn-apple.com apple.news appleid.com itunes.com",
    "amazon ; amazon.com amazon.in amazon.co.uk amazon.de amazon.fr amazon.it amazon.es amazon.ca amazon.co.jp amazon.com.au amazon.com.br amazon.com.mx amazon.nl amazon.sg amazon.ae amazon.sa amazon.com.tr amazon.pl amazon.se amazon.science a.co amzn.to amzn.com primevideo.com audible.com media-amazon.com ssl-images-amazon.com amazon.dev awsstatic.com aws.com",
    "facebook instagram whatsapp messenger ; facebook.com fb.com fb.me fbcdn.net facebookmail.com instagram.com cdninstagram.com whatsapp.com whatsapp.net wa.me messenger.com meta.com oculus.com threads.net",
    "twitter ; twitter.com x.com twimg.com t.co",
    "netflix ; netflix.com nflxvideo.net nflximg.net nflxso.net nflxext.com",
    "linkedin ; linkedin.com licdn.com lnkd.in",
    "dropbox ; dropbox.com dropboxapi.com getdropbox.com dropboxusercontent.com db.tt",
    "adobe ; adobe.com adobe.io adobelogin.com behance.net typekit.net",
    "ebay ; ebay.com ebay.co.uk ebay.de ebay.com.au ebay.in ebay.ca ebay.fr ebay.it ebay.es ebaystatic.com ebayimg.com",
    "walmart ; walmart.com walmart.ca walmartimages.com",
    "chase ; chase.com",
    "wellsfargo ; wellsfargo.com wf.com",
    "bankofamerica ; bankofamerica.com bofa.com",
    "citibank ; citibank.com citi.com citigroup.com",
    "capitalone ; capitalone.com",
    "americanexpress ; americanexpress.com amex.com aexp.com",
    "hsbc ; hsbc.com hsbc.co.uk hsbc.co.in hsbc.com.hk",
    "barclays ; barclays.co.uk barclays.com barclaycard.co.uk",
    "lloyds lloydsbank ; lloydsbank.com lloydsbank.co.uk",
    "natwest ; natwest.com",
    "santander ; santander.com santander.co.uk santanderbank.com",
    "dhl ; dhl.com dhl.de dhl.co.in dhl.co.uk",
    "fedex ; fedex.com",
    "ups ; ups.com",
    "usps ; usps.com",
    "royalmail ; royalmail.com",
    "coinbase ; coinbase.com",
    "binance ; binance.com binance.us bnbstatic.com",
    "kraken ; kraken.com",
    "blockchain ; blockchain.com blockchain.info",
    "metamask ; metamask.io",
    "trustwallet ; trustwallet.com",
    "ledger ; ledger.com",
    "opensea ; opensea.io",
    "uniswap ; uniswap.org",
    "steam steamcommunity steampowered ; steampowered.com steamcommunity.com steamstatic.com steamgames.com",
    "epicgames ; epicgames.com unrealengine.com",
    "roblox ; roblox.com rbxcdn.com",
    "discord ; discord.com discord.gg discordapp.com discordapp.net",
    "github ; github.com githubusercontent.com githubassets.com",
    "gitlab ; gitlab.com",
    "spotify ; spotify.com scdn.co spotifycdn.com",
    "zoom ; zoom.us zoom.com zoomgov.com",
    "slack ; slack.com slack-edge.com",
    "docusign ; docusign.com docusign.net",
    "intuit quickbooks turbotax ; intuit.com quickbooks.com turbotax.com",
    "telegram ; telegram.org t.me telegram.me",
    "tiktok ; tiktok.com tiktokcdn.com",
    "snapchat ; snapchat.com snap.com",
    "reddit ; reddit.com redd.it redditstatic.com redditmedia.com",
    "pinterest ; pinterest.com pinimg.com",
    "yahoo ; yahoo.com yahoo.co.jp yahoo.co.uk yahoo.in ymail.com",
    "godaddy ; godaddy.com",
    "namecheap ; namecheap.com",
    "cloudflare ; cloudflare.com cloudflare.net",
    "wetransfer ; wetransfer.com we.tl",
    "stripe ; stripe.com stripe.network",
    "venmo ; venmo.com",
    "cashapp ; cash.app cashapp.com",
    "zelle ; zellepay.com",
    "wise ; wise.com transferwise.com",
    "revolut ; revolut.com",
    "shopify ; shopify.com shopifycdn.com",
    "aliexpress ; aliexpress.com aliexpress.us alicdn.com",
    "alibaba ; alibaba.com alibabagroup.com",
    "booking ; booking.com bstatic.com",
    "airbnb ; airbnb.com airbnb.co.in airbnb.co.uk",
    "uber ; uber.com ubereats.com",
    "visa ; visa.com visa.co.in",
    "mastercard ; mastercard.com mastercard.us",
    "verizon ; verizon.com verizonwireless.com",
    "comcast xfinity ; xfinity.com comcast.com comcast.net",
    "att ; att.com",
    // India
    "sbi onlinesbi sbicard ; onlinesbi.sbi sbi.co.in sbicard.com sbi.bank.in onlinesbi.com sbiyono.sbi",
    "hdfcbank hdfc ; hdfcbank.com hdfc.com hdfcsec.com hdfclife.com hdfcergo.com",
    "icicibank icici ; icicibank.com icici.com icicidirect.com icicilombard.com iciciprulife.com",
    "axisbank ; axisbank.com axis.bank.in",
    "kotak kotakbank ; kotak.com kotakbank.com kotaksecurities.com",
    "yesbank ; yesbank.in",
    "pnbindia ; pnbindia.in netpnb.com",
    "bankofbaroda ; bankofbaroda.in bankofbaroda.com bobibanking.com",
    "canarabank ; canarabank.com",
    "paytm ; paytm.com paytmbank.com paytmpayments.com",
    "phonepe ; phonepe.com",
    "gpay ; pay.google.com",
    "bhim npci ; npci.org.in bhimupi.org.in",
    "razorpay ; razorpay.com",
    "zerodha ; zerodha.com kite.trade",
    "upstox ; upstox.com",
    "groww ; groww.in",
    "irctc ; irctc.co.in irctc.com",
    "uidai aadhaar ; uidai.gov.in",
    "incometax incometaxindia ; incometax.gov.in incometaxindia.gov.in",
    "digilocker ; digilocker.gov.in",
    "flipkart ; flipkart.com fkcdn.com",
    "myntra ; myntra.com",
    "swiggy ; swiggy.com",
    "zomato ; zomato.com",
    "jio ; jio.com ril.com",
    "airtel ; airtel.in airtel.com",
    "vodafone ; vodafone.com vodafone.in myvi.in",
    "bsnl ; bsnl.co.in",
    "indiapost ; indiapost.gov.in",
    "licindia ; licindia.in",
    "snapdeal ; snapdeal.com",
    "bajajfinserv ; bajajfinserv.in",
  ];

  // Well-known sites that are not impersonation targets: they are never flagged and never used as a lookalike target.
  const POPULAR = ("wikipedia.org wikimedia.org stackoverflow.com stackexchange.com nytimes.com bbc.co.uk bbc.com cnn.com theguardian.com " +
    "medium.com wordpress.org mozilla.org python.org nodejs.org npmjs.com w3.org archive.org imdb.com craigslist.org quora.com " +
    "twitch.tv paypay.ne.jp ndtv.com indiatimes.com thehindu.com hindustantimes.com khanacademy.org coursera.org edx.org " +
    "nasa.gov who.int un.org harvard.edu mit.edu stanford.edu ox.ac.uk cam.ac.uk nih.gov cdc.gov usa.gov gov.uk canada.ca " +
    "india.gov.in irs.gov ssa.gov nhs.uk ubuntu.com debian.org kernel.org gnu.org apache.org eclipse.org rust-lang.org golang.org " +
    "docker.com kubernetes.io mongodb.com postgresql.org mysql.com oracle.com ibm.com intel.com nvidia.com amd.com samsung.com " +
    "sony.com lg.com dell.com hp.com lenovo.com asus.com cisco.com salesforce.com atlassian.com notion.so figma.com canva.com " +
    "trello.com asana.com hubspot.com mailchimp.com wix.com squarespace.com weebly.com ycombinator.com producthunt.com " +
    "bloomberg.com reuters.com forbes.com wsj.com economist.com washingtonpost.com espn.com nationalgeographic.com " +
    "timesofindia.com moneycontrol.com economictimes.com livemint.com zeebiz.com ibm.org duckduckgo.com brave.com " +
    "opera.com vivaldi.com torproject.org signal.org proton.me protonmail.com tutanota.com fastmail.com").split(" ");

  // Words that may surround a brand name in a lookalike, and words that describe a login/payment page.
  const STRONG_KEYWORDS = ["login", "logon", "signin", "secure", "security", "verify", "verification", "account", "update",
    "support", "helpdesk", "wallet", "banking", "payment", "billing", "confirm", "validate", "recover", "recovery", "unlock",
    "suspend", "alert", "kyc", "otp", "refund", "invoice", "reward", "claim", "prize", "netbanking", "upi", "webscr", "password",
    "credential", "customer", "authenticate"];
  const WORDS = new Set(STRONG_KEYWORDS.concat(("official service services online app apps mobile web portal id my help team center " +
    "centre care free gift pay bank card cards credit loan loans store shop mail email cloud home page site net com info new now " +
    "pro plus max prime access manage manager user users client clients member members team desk hub zone india usa uk global " +
    "world city best top fast easy smart safe safety trust protect protection check status track tracking order orders offer " +
    "offers deal deals sale news media group the and for with from to in of on at by").split(" ")));

  // ---- index (built once) ---------------------------------------------------------------------------------
  // brands: [{ name, names[], domains[] }]. Accepts the built-in strings, {name, names?, domains} objects, or a
  // {name: [domains]} map (ctx.brands).
  function normaliseBrands(list) {
    const out = [];
    if (Array.isArray(list)) {
      for (const b of list) {
        if (typeof b === "string") {
          const [n, d] = b.split(";");
          const names = n.trim().split(/\s+/).filter(Boolean), domains = (d || "").trim().split(/\s+/).filter(Boolean);
          if (names.length) out.push({ name: names[0], names, domains });
        } else if (b && typeof b === "object" && typeof b.name === "string") {
          const names = [b.name].concat(Array.isArray(b.names) ? b.names : []).map((x) => String(x).toLowerCase());
          out.push({ name: names[0], names, domains: (Array.isArray(b.domains) ? b.domains : []).map((x) => String(x).toLowerCase()) });
        }
      }
    } else if (list && typeof list === "object") {
      for (const k of Object.keys(list)) {
        const domains = Array.isArray(list[k]) ? list[k] : [];
        out.push({ name: k.toLowerCase(), names: [k.toLowerCase()], domains: domains.map((x) => String(x).toLowerCase()) });
      }
    }
    return out;
  }

  function buildIndex(brandList, withPopular) {
    const brands = normaliseBrands(brandList);
    const byName = new Map(), byFold = new Map(), official = new Map(), buckets = [], embedded = [];
    brands.forEach((b, i) => {
      for (const d of b.domains) official.set(d, i);
      for (const nm of b.names) {
        if (nm.length < 3 || byName.has(nm)) continue;
        byName.set(nm, i);
        const f = skeleton(nm);
        if (nm.length >= 4 && !byFold.has(f)) byFold.set(f, i);
        if (nm.length >= 6) (buckets[nm.length] || (buckets[nm.length] = [])).push([nm, i]);
        if (nm.length >= 5) embedded.push([nm, i]);
      }
    });
    embedded.sort((a, b) => b[0].length - a[0].length);
    if (withPopular) for (const d of POPULAR) if (!official.has(d)) official.set(d, -1);
    return { brands, byName, byFold, official, buckets, embedded };
  }

  let DEFAULT_INDEX = null;
  const INDEX_CACHE = new WeakMap(), OFFICIAL_CACHE = new WeakMap();
  function indexFor(ctx) {
    if (ctx && ctx.brands && typeof ctx.brands === "object") {
      let idx = INDEX_CACHE.get(ctx.brands);
      if (!idx) { idx = buildIndex(ctx.brands, true); INDEX_CACHE.set(ctx.brands, idx); }
      return idx;
    }
    return DEFAULT_INDEX || (DEFAULT_INDEX = buildIndex(BRAND_DATA, true));
  }
  function extraOfficial(ctx) {
    const list = ctx && ctx.official;
    if (!Array.isArray(list) || !list.length) return null;
    let set = OFFICIAL_CACHE.get(list);
    if (!set) { set = new Set(list.map((x) => String(x).toLowerCase())); OFFICIAL_CACHE.set(list, set); }
    return set;
  }

  // Is `reg` (a registrable domain) an official / trusted domain? Returns { brand, domain } or null.
  function officialMatch(reg, idx, extra) {
    if (extra && extra.has(reg)) return { brand: null, domain: reg };
    const i = idx.official.get(reg);
    if (i === undefined) return null;
    return i >= 0 ? { brand: idx.brands[i].name, domain: idx.brands[i].domains[0] || reg } : { brand: null, domain: reg };
  }

  // ---- brand matching ---------------------------------------------------------------------------------------
  // Does the single word `tok` equal, look like, or nearly spell a brand name? -> { b, kind, dist, slip } or null.
  function matchToken(tok, idx, fuzzy) {
    const len = tok.length;
    if (len < 3) return null;
    let b = idx.byName.get(tok);
    if (b !== undefined) return { b, kind: "exact", dist: 0, slip: null };
    if (len < 4 || len > 40) return null;
    const f = skeleton(tok);
    b = idx.byFold.get(f);
    if (b !== undefined) return { b, kind: "skel", dist: 0, slip: null };
    if (!fuzzy || len < 6 || len > 24 || WORDS.has(tok)) return null;
    let best = null;
    for (let L = len - 2; L <= len + 2; L++) {
      const bucket = idx.buckets[L];
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k++) {
        const nm = bucket[k][0];
        const max = nm.length >= 9 ? 2 : 1;
        const d = editDistance(tok, nm, max);
        if (d <= max && (!best || d < best.dist)) best = { b: bucket[k][1], kind: "typo", dist: d, slip: d === 1 ? slipKind(tok, nm) : null };
      }
    }
    return best;
  }

  // Can `rest` be read as nothing but ordinary login/service words (and digits)?
  function segmentable(rest) {
    rest = rest.replace(/[0-9-]/g, "");
    const n = rest.length;
    if (!n) return true;
    if (n > 40) return false;
    const ok = [true];
    for (let i = 1; i <= n; i++) {
      ok[i] = false;
      for (let j = Math.max(0, i - 12); j < i - 1 && !ok[i]; j++) if (ok[j] && WORDS.has(rest.slice(j, i))) ok[i] = true;
    }
    return ok[n];
  }

  function hasKeyword(s) {
    for (let i = 0; i < STRONG_KEYWORDS.length; i++) if (s.indexOf(STRONG_KEYWORDS[i]) !== -1) return true;
    return false;
  }

  // Brand name written inside a longer, hyphen-free word: paypalsecure, mypaypal, applepay.
  function embeddedBrand(flat, idx) {
    const list = idx.embedded;
    for (let i = 0; i < list.length; i++) {
      const nm = list[i][0];
      if (flat.length < nm.length + 2) continue;
      const at = flat.indexOf(nm);
      if (at < 0) continue;
      const rest = flat.slice(0, at) + " " + flat.slice(at + nm.length);
      if (nm.length >= 7 || (segmentable(flat.slice(0, at)) && segmentable(flat.slice(at + nm.length))) || hasKeyword(flat.slice(0, at) + " " + flat.slice(at + nm.length))) return { b: list[i][1], rest };
    }
    return null;
  }

  // ---- random / algorithmic domain names ---------------------------------------------------------------------
  const COMMON_BIGRAMS = new Set(("th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve " +
    "co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur ca el ta la ns di fo ho pe ec pr no ct us ac ot il tr ly nc et ut " +
    "ss so rs un lo wa ge ie wh ee wi em ad ol rt po we na ul ni ts mo ow pa im mi ai sh ir su id os iv ia am fi ci vi pl ig tu " +
    "ev ld ry mp fe bl ab gh ty op wo sa ay ex ke fr oo av ag if ap gr od bo sp rd do uc bu ei ov by rm ep tt oc ob ik ak ub ys " +
    "nk ok lt rk ft ew gi ug ip ba ya yo ze za ka ku ki ko sk sc sl sm sn sw ph ps eb ib ym iz ix ud um up aw ef eg ew").split(" "));
  const VOWELS = "aeiouy";

  function wordCoverage(s) {
    const n = s.length;
    const best = [0];
    for (let i = 1; i <= n; i++) {
      best[i] = best[i - 1];
      for (let j = Math.max(0, i - 12); j <= i - 3; j++) {
        if (WORDS.has(s.slice(j, i)) || COMMON_WORDS.has(s.slice(j, i))) { const v = best[j] + (i - j); if (v > best[i]) best[i] = v; }
      }
    }
    return best[n] / n;
  }
  const COMMON_WORDS = new Set(("bank shop store news mail cloud game games play music video photo travel hotel food health home house " +
    "book books school learn tech soft data digital smart green blue fast super open link zone club market trade money cash credit " +
    "sport auto cars design studio press blog post live life love group system systems solution solutions king fresh daily local " +
    "delhi mumbai london paris tokyo berlin sydney coffee pizza garden flower farm fashion kids baby pet pets dog cat fish tree " +
    "sun moon star sky sea river mountain road street park city town village land world earth water fire stone gold silver red " +
    "black white bright quick bike run walk yoga gym fitness dental doctor clinic care medical pharma legal law tax finance " +
    "invest capital insurance realty estate rent hire job jobs career work office events event ticket tickets wedding photo " +
    "gallery art craft print paper pen ink book library museum history science math physics chemistry biology english hindi " +
    "tamil cricket football soccer tennis golf chess poker lottery casino bet bets odds").split(" "));

  // 0..1: how much the label looks machine-generated. Only for ASCII labels of 9+ characters.
  function dgaScore(label) {
    const len = label.length;
    if (len < 9 || len > 63) return 0;
    let vowels = 0, digits = 0, run = 0, maxRun = 0, switches = 0, rare = 0, pairs = 0, letters = 0, prevDigit = false, hexOnly = true;
    const seen = new Set();
    for (let i = 0; i < len; i++) {
      const c = label[i];
      const isDigit = c >= "0" && c <= "9";
      seen.add(c);
      if (isDigit) { digits++; run = 0; } else if (c !== "-") {
        letters++;
        if (VOWELS.indexOf(c) >= 0) { vowels++; run = 0; } else { run++; if (run > maxRun) maxRun = run; }
        if (c > "f") hexOnly = false;
      }
      if (i > 0 && isDigit !== prevDigit && label[i - 1] !== "-" && c !== "-") switches++;
      prevDigit = isDigit;
      if (i > 0 && !isDigit && !(label[i - 1] >= "0" && label[i - 1] <= "9") && c !== "-" && label[i - 1] !== "-") {
        pairs++;
        if (!COMMON_BIGRAMS.has(label[i - 1] + c)) rare++;
      }
    }
    if (letters < 4) return digits >= 8 ? 0.5 : 0;
    let s = 0;
    if (maxRun >= 6) s += 0.45; else if (maxRun === 5) s += 0.2;
    const rareRatio = pairs ? rare / pairs : 0;
    if (rareRatio > 0.6) s += 0.4; else if (rareRatio > 0.45) s += 0.2;
    const vr = vowels / letters;
    if (vr < 0.18) s += 0.25; else if (vr > 0.7) s += 0.2;
    if (digits / len > 0.3) s += 0.3;
    if (switches >= 4) s += 0.2;
    if (len >= 12 && hexOnly && digits > 0 && letters > 0) s += 0.6;
    if (len >= 12 && seen.size / len > 0.75) s += 0.2;
    if (s >= 0.4 && wordCoverage(label.replace(/[-0-9]/g, "")) >= 0.75) s *= 0.2;
    return Math.min(1, s);
  }

  // ---- URL scoring --------------------------------------------------------------------------------------------
  const PATH_LOGIN = new Set(["login", "signin", "verify", "secure", "account", "update", "confirm", "webscr", "auth", "password", "banking"]);
  const PRIVATE_V4 = /^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

  function parseUrl(url) {
    if (typeof url !== "string") return null;
    let s = url.length > 4096 ? url.slice(0, 4096) : url;
    s = s.trim();
    if (!s) return null;
    let u = null;
    try { u = new URL(s); } catch (e) { u = null; }
    if (u && u.protocol !== "http:" && u.protocol !== "https:") {
      if (s.indexOf("//") !== -1 || !/^[^/?#:]+\.[^/?#:]+:\d/.test(s)) return null;   // javascript:, data:, chrome:// ...
      u = null;
    }
    if (!u) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
      try { u = new URL("http://" + s); } catch (e) { return null; }
    }
    return u;
  }

  function scoreUrl(url, ctx) {
    try { return scoreUrlInner(url, ctx); } catch (e) { return none(); }
  }

  function scoreUrlInner(url, ctx) {
    const u = parseUrl(url);
    if (!u) return none();
    let host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || host.indexOf(".") === -1 && host[0] !== "[") return none();   // localhost, intranet names
    if (host.startsWith("www.")) host = host.slice(4);
    const idx = indexFor(ctx);
    const href = u.href;
    const ev = [];
    const f = { url_length: typeof url === "string" ? url.length : 0 };
    let brand = null, officialDomain = null;

    // IP address hosts have no name to judge.
    if (host[0] === "[" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      if (host[0] !== "[" && PRIVATE_V4.test(host)) return none();
      if (host === "[::1]") return none();
      ev.push([W.ip_host, "Web address is a raw IP number, not a site name"]);
      f.ip_host = 1;
      const pb = scorePathParts(u, idx, f);
      if (pb) {
        ev.push([W.brand_path + (pb.login ? W.brand_path_login : 0), `Mentions "${idx.brands[pb.b].name}" in the page path of an unrelated site`]);
        brand = idx.brands[pb.b].name; officialDomain = idx.brands[pb.b].domains[0] || null;
      } else if (f.path_login) ev.push([W.ip_login, null]);
      if (u.protocol === "http:") ev.push([W.http, "Connection is not encrypted (http)"]);
      return verdictFrom(ev, brand, officialDomain, f);
    }

    const p = parseHost(host);
    const extra = extraOfficial(ctx);
    const off = officialMatch(p.reg, idx, extra);
    if (off) {
      const v = none();
      v.brand = off.brand; v.official = off.domain; v.features = { official: 1 };
      return v;
    }
    if (!p.sld) return none();

    const sld = p.sld, tld = p.labels[p.labels.length - 1];
    f.host_labels = p.labels.length;
    f.subdomains = p.subs.length;

    // -- internationalised names: decode, mixed scripts, look-alike letters
    const disp = displayLabel(sld);
    let brandEv = null;                    // [weight, reason, brandIdx]
    const consider = (w, reason, b) => { if (!brandEv || w > brandEv[0]) brandEv = [w, reason, b]; };
    let foldedLabel = sld;
    if (disp !== sld || /[^\x00-\x7f]/.test(sld)) {
      f.idn = 1;
      foldedLabel = disp;
      if (mixedScript(disp)) { ev.push([W.mixed_script, "Mixes letters from different alphabets, a look-alike trick"]); f.mixed_script = 1; }
      else {
        const sk = skeleton(disp);
        if (!/[^\x00-\x7f]/.test(sk) && /[^\x00-\x7f]/.test(disp.normalize("NFD").replace(/[̀-ͯ]/g, ""))) {
          ev.push([W.look_latin, "Uses other alphabets' letters that look like Latin ones"]); f.look_latin = 1;
        } else ev.push([W.idn, "Uses an internationalised (non-English) domain name"]);
      }
    }
    const label = foldedLabel.toLowerCase();

    // -- brand imitation in the registrable name
    const tokens = label.split("-");
    const flat = tokens.length > 1 ? label.replace(/-/g, "") : label;
    let m = matchToken(label, idx, true);
    let how = "whole";
    if (!m && tokens.length > 1) { m = matchToken(flat, idx, true); how = "flat"; }
    if (m) {
      const B = idx.brands[m.b];
      if (m.kind === "exact") {
        const cc = tld.length === 2 && !SUSP_TLD.has(tld) && !FREE_SET.has(p.suffix);
        consider(cc ? W.brand_exact_cctld : W.brand_exact_gtld, `Uses the name "${B.name}" on a site that is not ${B.domains[0] || B.name}`, m.b);
      } else if (m.kind === "skel") {
        consider(W.homoglyph, `Looks like "${B.name}" written with look-alike characters`, m.b);
      } else {
        f.edit_distance = m.dist;
        let w = m.dist === 1 ? W.typo_1 : W.typo_2;
        if (m.slip === "kb") w += W.typo_kb; else if (m.slip === "swap") w += W.typo_swap;
        consider(w, `Looks like a misspelling of "${B.name}"`, m.b);
      }
    } else if (tokens.length > 1) {
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.length < 3) continue;
        const mt = matchToken(t, idx, true);
        if (!mt) continue;
        const B = idx.brands[mt.b];
        if (mt.kind === "exact") {
          consider(t.length < 5 ? W.combo_short : W.combo, `Uses the name "${B.name}" inside a different site name`, mt.b);
        } else if (mt.kind === "skel") consider(W.homoglyph - 0.5, `Contains a look-alike spelling of "${B.name}"`, mt.b);
        else consider(mt.dist === 1 ? W.typo_1 - 0.8 : W.typo_2 - 0.8, `Contains a misspelling of "${B.name}"`, mt.b);
      }
    } else if (label.length >= 7) {
      const e = embeddedBrand(label, idx);
      if (e) consider(W.embedded, `Hides the name "${idx.brands[e.b].name}" inside a longer site name`, e.b);
    }
    if (!brandEv && tokens.length > 1) {                    // brand glued to words once hyphens are gone: pay-pal-login
      const e = embeddedBrand(flat, idx);
      if (e && flat.length >= 8) consider(W.embedded, `Hides the name "${idx.brands[e.b].name}" inside a longer site name`, e.b);
    }

    // -- brand in the subdomains: paypal.evil.xyz, paypal.com.evil.xyz
    if (p.subs.length) {
      for (let i = 0; i < p.subs.length; i++) {
        const sub = displayLabel(p.subs[i]).toLowerCase();
        if (/[^\x00-\x7f]/.test(sub) && mixedScript(sub)) { if (!f.mixed_script) { ev.push([W.mixed_script, "Mixes letters from different alphabets, a look-alike trick"]); f.mixed_script = 1; } }
        const parts = sub.indexOf("-") === -1 ? [sub] : sub.split("-");
        for (let j = 0; j < parts.length; j++) {
          const mt = parts[j].length >= 3 ? matchToken(parts[j], idx, true) : null;
          if (!mt) continue;
          const B = idx.brands[mt.b];
          let w = mt.kind === "exact" ? W.sub_brand : mt.kind === "skel" ? W.homoglyph - 1 : W.typo_1 - 1;
          if (mt.kind === "exact" && B.names[0].length < 5 && parts.length === 1 && p.subs.length === 1) w = W.combo_short + 0.6;
          if (mt.kind === "exact" && TLD_LIKE.has(p.subs[i + 1]) && parts.length === 1) { w += W.sub_domain; f.sub_domain = 1; }
          consider(w, `Puts the name "${B.name}" in front of an unrelated site`, mt.b);
        }
      }
    }

    // -- brand/domain in user info: http://paypal.com@evil.xyz/
    let userinfo = "";
    if (u.username || u.password) {
      userinfo = (u.username + ":" + u.password).toLowerCase();
      ev.push([W.userinfo, "Web address contains an @ that hides the real site"]);
      f.userinfo = 1;
      const ut = userinfo.split(/[^a-z0-9]+/);
      for (let i = 0; i < ut.length; i++) {
        if (ut[i].length >= 4 && idx.byName.has(ut[i])) { consider(W.brand_userinfo, `Pretends to be "${idx.brands[idx.byName.get(ut[i])].name}" before the @`, idx.byName.get(ut[i])); break; }
      }
    }

    // -- keywords, path, query
    let kw = 0;
    const hay = label + (p.subs.length ? "." + p.subs.join(".") : "");
    for (let i = 0; i < STRONG_KEYWORDS.length; i++) if (hay.indexOf(STRONG_KEYWORDS[i]) !== -1) kw++;
    f.keywords = kw;
    if (kw) ev.push([kw >= 4 ? W.kw4 : kw === 3 ? W.kw3 : kw === 2 ? W.kw2 : W.kw1, kw > 1 ? "Several login or payment words in the site name" : "Login or payment word in the site name"]);
    const pathBrand = scorePathParts(u, idx, f);
    if (!brandEv && pathBrand) consider(W.brand_path + (pathBrand.login ? W.brand_path_login : 0), `Mentions "${idx.brands[pathBrand.b].name}" in the page path of an unrelated site`, pathBrand.b);

    if (brandEv) {
      ev.push([brandEv[0], brandEv[1]]);
      if (kw) ev.push([W.brand_keyword, null]);
      brand = idx.brands[brandEv[2]].name;
      officialDomain = idx.brands[brandEv[2]].domains[0] || null;
      f.brand_weight = brandEv[0];
    }

    // -- host / URL shape
    if (SUSP_TLD.has(tld)) { ev.push([W.susp_tld, `Uses the .${tld} ending, common in scam sites`]); f.susp_tld = 1; }
    else if (WEAK_TLD.has(tld)) ev.push([W.weak_tld, null]);
    if (FREE_SET.has(p.suffix)) { ev.push([W.free_host, "Hosted on a free website builder"]); f.free_host = 1; }
    if (SHORTENERS.has(p.reg)) ev.push([W.shortener, "Short link hides its destination"]);
    const hy = (label.match(/-/g) || []).length;
    if (hy >= 3) ev.push([W.hyphens3, "Many hyphens in the site name"]); else if (hy === 2) ev.push([W.hyphens2, null]);
    f.hyphens = hy;
    if (p.subs.length >= 5) ev.push([W.subs5, "Unusually many sub-domain levels"]); else if (p.subs.length >= 3) ev.push([W.subs3, null]);
    if (host.length > 50) ev.push([W.host50, "Very long host name"]); else if (host.length > 30) ev.push([W.host30, null]);
    const hl = host.length;
    if (hl >= 8) {
      let d = 0;
      for (let i = 0; i < hl; i++) { const c = host.charCodeAt(i); if (c >= 48 && c <= 57) d++; }
      f.digit_ratio = round3(d / hl);
      if (d / hl > 0.3) ev.push([W.digits, "Lots of digits in the site name"]);
    }
    if (u.port) {
      if (u.port === "8080" || u.port === "8443" || u.port === "8000") ev.push([W.port_alt, null]);
      else ev.push([W.port_odd, "Unusual network port"]);
    }
    if (f.url_length > 200) ev.push([W.len200, "Very long web address"]); else if (f.url_length > 100) ev.push([W.len100, null]);
    const pct = (href.match(/%[0-9a-f]{2}/gi) || []).length;
    f.encoded = pct;
    if (pct >= 3 && href.length > 40) ev.push([W.encoded, "Web address is full of encoded characters"]);
    if (/[?&=/](https?%3a|https?:)/i.test(u.search + u.pathname)) ev.push([W.redirect_param, null]);
    if (u.protocol === "http:") ev.push([W.http, "Connection is not encrypted (http)"]);

    // -- randomness (only when nothing else explains the name)
    if (!brandEv && !f.idn) {
      const dga = dgaScore(label);
      f.dga = round3(dga);
      if (dga >= 0.4) ev.push([W.dga_min + (W.dga_max - W.dga_min) * (Math.min(dga, 1) - 0.4) / 0.6, "Site name looks randomly generated"]);
    }

    return verdictFrom(ev, brand, officialDomain, f);
  }

  // Brand names and login words in the path/query. Returns { b, login } when a brand token appears.
  function scorePathParts(u, idx, f) {
    const path = (u.pathname + u.search).toLowerCase();
    if (path.length < 3) return null;
    const toks = path.slice(0, 512).split(/[^a-z0-9]+/);
    let b = -1, login = false;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.length < 4) continue;
      if (b < 0 && idx.byName.has(t)) b = idx.byName.get(t);
      if (PATH_LOGIN.has(t)) login = true;
    }
    if (f) f.path_login = login ? 1 : 0;
    return b >= 0 ? { b, login } : null;
  }

  // ---- page scoring -------------------------------------------------------------------------------------------
  const LEXICON = [
    // [regex, category]. Matched against lower-case title + description + visible text.
    [/\bwithin (the next )?(24|48|72) hours\b/, "urgency"], [/\b(act|respond|verify|confirm|update) (now|immediately|today)\b/, "urgency"],
    [/\bimmediate action (is )?required\b/, "urgency"], [/\blast (warning|notice|chance)\b/, "urgency"], [/\b(expires?|expiring) (in|today|soon)\b/, "urgency"],
    [/\bavoid (permanent )?(suspension|closure|deactivation|loss)\b/, "urgency"],
    [/\b(account|card|access|wallet|profile) (has been |is |was |will be )?(temporarily )?(suspended|locked|blocked|deactivated|restricted|disabled|limited)\b/, "threat"],
    [/\bunusual (sign[- ]?in|login|activity)\b/, "threat"], [/\bunauthori[sz]ed (access|transaction|login|activity)\b/, "threat"],
    [/\b(permanently|will be) (closed|terminated|deleted|blocked)\b/, "threat"], [/\blegal action\b/, "threat"], [/\bsecurity (alert|breach|warning)\b/, "threat"],
    [/\bverify your (identity|account|details|information|card|bank)\b/, "ask"], [/\bconfirm your (password|identity|account|card|details|pin|otp)\b/, "ask"],
    [/\b(update|re-?enter|enter) your (payment|billing|card|bank|password|pin)\b/, "ask"], [/\b(one[- ]time (password|code|pin)|otp)\b/, "ask"],
    [/\b(cvv|cvc|card number|card verification|atm pin|net ?banking (id|password)|upi pin)\b/, "ask"],
    [/\bkyc\b.*\b(update|verify|expire|pending|complete)\b|\b(update|verify|complete|pending|expire\w*) .{0,20}\bkyc\b/, "ask"], [/\b(aadhaar|pan) (card )?(number|details|verification)\b/, "ask"],
    [/\b(you have|you've|you are) (won|been selected)\b/, "reward"], [/\bclaim your (prize|reward|gift|refund|cashback)\b/, "reward"],
    [/\b(lottery|jackpot) winner\b/, "reward"], [/\bcongratulations\b.{0,60}\b(won|selected|winner)\b/, "reward"], [/\bunclaimed (refund|funds|prize)\b/, "reward"],
    [/\b(virus|malware|trojan)s? (has been |was |have been )?detected\b/, "support"], [/\b(call|contact) (us |our )?(toll[- ]free|support|technician|helpline)\b/, "support"],
    [/\byour (computer|device|pc) (is|has been) (infected|compromised|blocked)\b/, "support"], [/\bdo not (restart|close|shut ?down) (your|this)\b/, "support"],
  ];
  const LEX_W = { urgency: [W.lex_urgency, 1.2], threat: [W.lex_threat, 1.6], ask: [W.lex_ask, 1.6], reward: [W.lex_reward, 1.2], support: [W.lex_support, 1.6] };

  function safeUrl(s) {
    if (typeof s !== "string" || !s) return null;
    try { return new URL(s.length > 2048 ? s.slice(0, 2048) : s); } catch (e) { return null; }
  }

  function brandInText(text, idx, wantCount) {
    // first brand name that appears as a whole word (or two adjacent words, "wells fargo")
    const toks = text.split(/[^a-z0-9]+/);
    const counts = new Map();
    let first = -1;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      let b;
      if (t.length >= 4) b = idx.byName.get(t);
      if (b === undefined && i + 1 < toks.length && t.length >= 3 && t.length + toks[i + 1].length >= 6) b = idx.byName.get(t + toks[i + 1]);
      if (b !== undefined) { counts.set(b, (counts.get(b) || 0) + 1); if (first < 0) first = b; }
    }
    return first < 0 ? null : { b: first, count: counts.get(first), counts };
  }

  function scorePage(signals, ctx) {
    try { return scorePageInner(signals, ctx); } catch (e) { return none(); }
  }

  function scorePageInner(signals, ctx) {
    if (!signals || typeof signals !== "object") return none();
    const idx = indexFor(ctx);
    const ev = [];
    const f = {};
    const pageUrl = safeUrl(signals.url || (ctx && ctx.url) || (signals.host ? "https://" + signals.host : ""));
    let host = pageUrl ? pageUrl.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "") : "";
    let reg = "";
    if (host && host.indexOf(".") !== -1 && host[0] !== "[" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      reg = parseHost(host).reg;
      const off = officialMatch(reg, idx, extraOfficial(ctx));
      if (off) { const v = none(); v.brand = off.brand; v.official = off.domain; v.features = { official: 1 }; return v; }
    }
    const pw = !!signals.has_password_field;
    const str = (x, n) => (typeof x === "string" ? x.slice(0, n) : "");
    const title = str(signals.title, 300).toLowerCase(), desc = str(signals.description, 500).toLowerCase(), text = str(signals.text, 4000).toLowerCase();
    f.password = pw ? 1 : 0;
    if (pw) ev.push([W.pw_alone, null]);

    // -- where do the forms send data?
    const actions = Array.isArray(signals.form_actions) ? signals.form_actions.slice(0, 20) : [];
    let cross = false, insecure = false, ipAction = false, freeAction = false, mailAction = false;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (typeof a === "string" && /^mailto:/i.test(a)) { mailAction = true; continue; }
      const au = safeUrl(a);
      if (!au || (au.protocol !== "http:" && au.protocol !== "https:")) continue;
      const ah = au.hostname.toLowerCase().replace(/^www\./, "");
      if (au.protocol === "http:") insecure = true;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ah) && !PRIVATE_V4.test(ah)) ipAction = true;
      const areg = ah.indexOf(".") === -1 ? ah : parseHost(ah).reg;
      if (FREE_SET.has(parseHost(ah).suffix)) freeAction = true;
      if (reg && areg !== reg && !(extraOfficial(ctx) || new Set()).has(areg)) cross = true;
    }
    f.cross_form = cross ? 1 : 0;
    let asks = 0;
    const blob = title + " " + desc + " " + text;
    const cats = new Map();
    for (let i = 0; i < LEXICON.length; i++) {
      if (LEXICON[i][0].test(blob)) cats.set(LEXICON[i][1], (cats.get(LEXICON[i][1]) || 0) + 1);
    }
    let lex = 0;
    for (const [cat, n] of cats) lex += Math.min(LEX_W[cat][1], LEX_W[cat][0] * n);
    lex = Math.min(lex, W.lex_cap);
    f.lexicon_hits = 0; cats.forEach((n) => { f.lexicon_hits += n; });
    asks = cats.get("ask") || 0;
    if (pw && cross) ev.push([W.pw_cross_form, "Login form sends your password to a different site"]);
    else if (cross && asks) ev.push([W.ask_cross_form, "Form that asks for card or ID details sends them to a different site"]);
    if (pw && insecure) ev.push([W.pw_insecure_action, "Login form is sent without encryption"]);
    if (pw && pageUrl && pageUrl.protocol === "http:") ev.push([W.pw_http_page, "Password is typed on a page that is not encrypted"]);
    if (ipAction) ev.push([W.form_ip, "Form sends data to a raw IP address"]);
    if (freeAction && (pw || asks)) ev.push([W.form_free_host, "Form sends data to a free hosting site"]);
    if (pw && mailAction) ev.push([W.form_mailto, "Login form sends your details by email"]);

    // -- brand named by the page but not by the host
    let brand = null, officialDomain = null;
    if (reg) {
      const bt = brandInText(title + " " + desc, idx, false);
      if (bt) {
        brand = idx.brands[bt.b].name; officialDomain = idx.brands[bt.b].domains[0] || null;
        ev.push([pw ? W.page_brand_pw : W.page_brand, `Page title names "${brand}" but the site is not ${officialDomain || brand}`]);
      } else if (pw) {
        const bx = brandInText(text, idx, true);
        if (bx && bx.count >= 2) {
          brand = idx.brands[bx.b].name; officialDomain = idx.brands[bx.b].domains[0] || null;
          ev.push([W.page_brand_text_pw, `Page talks about "${brand}" but the site is not ${officialDomain || brand}`]);
        }
      }
      f.brand_in_page = brand ? 1 : 0;
    }

    // -- pressure tactics
    if (lex > 0) {
      const names = [];
      if (cats.has("urgency")) names.push("urgent");
      if (cats.has("threat")) names.push("threatening");
      if (cats.has("ask")) names.push("asks for private details");
      if (cats.has("reward")) names.push("promises a prize");
      if (cats.has("support")) names.push("fake tech-support");
      ev.push([lex, "Page uses " + names.join(", ") + " wording"]);
      if (cats.size >= 3) ev.push([W.lex_multi, null]);
      if (pw && (cats.has("threat") || cats.has("ask"))) ev.push([W.lex_pw, null]);
    }

    // -- DOM extras
    const hidden = Number(signals.hidden_iframes) || 0;
    if (hidden >= 3) ev.push([W.iframe3, "Several hidden frames on the page"]);
    else if (hidden >= 1) ev.push([W.iframe1, "Hidden frame on the page"]);
    if (hidden && pw) ev.push([W.iframe_pw, null]);
    f.hidden_iframes = hidden;
    const sh = Array.isArray(signals.external_script_hosts) ? new Set(signals.external_script_hosts.slice(0, 200)).size : 0;
    f.script_hosts = sh;
    if (sh >= 25) ev.push([W.scripts25, "Loads scripts from a very large number of other sites"]);
    else if (sh >= 12) ev.push([W.scripts12, null]);
    const ent = Number(signals.inline_script_entropy) || 0;
    f.inline_entropy = round3(ent);
    if (ent > 5.8) ev.push([W.entropy_vhi, "Page contains scrambled (obfuscated) code"]);
    else if (ent > 5.4) ev.push([W.entropy_hi, "Page contains heavily packed code"]);

    return verdictFrom(ev, brand, officialDomain, f);
  }

  // ---- combining ------------------------------------------------------------------------------------------------
  // Evidence from several verdicts (URL + page + server) is added in log-odds, strongest first, each next one damped
  // (they are correlated). An official verdict anywhere wins: the site is the brand's own.
  function combine(verdicts) {
    try {
      const list = (Array.isArray(verdicts) ? verdicts : []).filter((v) => v && typeof v === "object");
      if (!list.length) return none();
      const official = list.find((v) => v.features && v.features.official);
      if (official) return { score: 0, level: "none", reasons: [], brand: official.brand || null, official: official.official || null, features: { official: 1 } };
      const scored = list.map((v) => ({ v, e: Math.max(0, logit(Number(v.score) || 0) - PRIOR) }));
      scored.sort((a, b) => b.e - a.e);
      let z = PRIOR, k = 1;
      for (const s of scored) { z += s.e * k; k *= W.combine_decay; }
      const score = round3(sigmoid(z));
      const reasons = [];
      for (const s of scored) for (const r of (Array.isArray(s.v.reasons) ? s.v.reasons : [])) if (typeof r === "string" && reasons.length < 6 && reasons.indexOf(r) === -1) reasons.push(r);
      const withBrand = scored.find((s) => s.v.brand);
      const features = Object.assign({}, scored[0].v.features, { logit: round3(z), combined: list.length });
      return {
        score, level: levelOf(score), reasons,
        brand: withBrand ? withBrand.v.brand : null,
        official: withBrand ? withBrand.v.official || null : null,
        features,
      };
    } catch (e) { return none(); }
  }

  const api = { version: VERSION, scoreUrl, scorePage, combine, PRIOR, WEIGHTS: W,
    parseHost, skeleton, editDistance, dgaScore, punycodeDecode };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraiseDetect = api;
})(typeof self !== "undefined" ? self : this);
