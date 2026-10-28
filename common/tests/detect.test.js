const test = require("node:test");
const assert = require("node:assert");
const D = require("../detect.js");

// ---- labelled corpus (every phishing example is invented; none is a real malicious address) -----------------
// Real brand sites and sites that merely look close to a brand: must never be flagged (score < 0.25).
const OFFICIAL = [
  "https://www.paypal.com/signin", "https://accounts.google.com/signin/v2", "https://login.microsoftonline.com/common/oauth2/authorize",
  "https://appleid.apple.com/sign-in", "https://www.amazon.in/gp/cart/view.html", "https://www.amazon.co.uk/", "https://www.facebook.com/login",
  "https://netbanking.hdfcbank.com/netbanking/", "https://retail.onlinesbi.sbi/retail/login.htm", "https://www.icicibank.com/personal-banking",
  "https://www.irctc.co.in/nget/train-search", "https://www.chase.com/personal/online-banking", "https://secure.bankofamerica.com/login/sign-in",
  "https://github.com/login", "https://www.paytm.com/recharge", "https://pay.google.com/about/", "https://mail.google.com/mail/u/0/",
  "https://en.wikipedia.org/wiki/Main_Page", "https://www.bbc.co.uk/news/world", "https://www.paypay.ne.jp/", "https://www.linkedin.com/in/someone",
  "https://steamcommunity.com/id/someone", "https://www.coinbase.com/signin", "https://www.binance.com/en/my/dashboard",
  "https://uidai.gov.in/en/my-aadhaar", "https://www.incometax.gov.in/iec/foportal/", "https://www.sbicard.com/en/personal/credit-cards.page",
  "https://www.hsbc.co.uk/ways-to-bank/", "https://docs.google.com/forms/d/e/1FAIpQLSabc/viewform", "https://support.apple.com/en-in/HT201994",
  "https://learn.microsoft.com/en-us/azure/", "https://news.ycombinator.com/item?id=123", "https://stackoverflow.com/questions/1/how",
];
// Ordinary sites, including names that contain a brand's letters by accident or look "login-ish".
const ORDINARY = [
  "https://applebees.com/menu", "https://pineapple-recipes.com/cake", "https://purchasechase.com/offers", "https://www.greenvalleyfarms.com/shop/eggs",
  "https://blog.sunrise-dental-clinic.co.uk/team", "https://app.bookkeeping-helper.io/dashboard", "https://www.hillviewacademy.org/admissions",
  "https://kerala-spice-traders.in/catalog?page=2", "https://secure.mortgage-advisers-leeds.co.uk/login", "https://www.trailrunnersclub.net/events/2024",
  "https://support.acme-widgets.com/tickets/42", "https://www.bankbazaar.com/credit-card.html", "https://myaccount.northwindtraders.com/billing",
  "https://groups.io/g/photography", "https://metaverse-news.org/latest", "https://visakhapatnam-tourism.in/beaches", "https://www.citizensbank.com/",
  "https://slackware.com/getslack/", "https://applebysmith.com/about", "https://wiseowl.com/courses", "https://uberlin.de/events",
  "https://xn--bcher-kva.de/", "https://m\u00fcnchen.de/verwaltung", "https://caf\u00e9-paris.fr/menu", "https://my-portfolio.netlify.app/",
  "https://mycoolstartup.io/pricing", "https://recipes.happyfoodie.com/dal-tadka", "https://courses.learnwithmaya.com/python", "https://shop.handmadeceramics.in/mugs",
  "https://tech.sparkandwire.net/2024/review", "https://www.rajeshhardware.in/products", "https://blog.springfieldlibrary.org/summer-reading",
  "https://www.nytimes.com/section/world", "https://login.example-school.edu/portal", "https://www.chennaicricketclub.com/fixtures",
  "https://secure.dentalcarecentre.com.au/appointments", "https://bookmyflowers.co.in/rose-bouquet", "https://www.paymentsense-demo.co.uk/",
  "http://localhost:3000/", "http://192.168.1.1/admin", "https://shop.mapleleafcrafts.ca/cart?item=77&utm_source=mail",
];
// Real sites that were not used while tuning the weights (a sanity check against over-fitting).
const REAL_SITES = ("tesla.com airbnb.com expedia.com etsy.com wayfair.com bestbuy.com homedepot.com zalando.com swiggy.com bigbasket.com nykaa.com " +
  "meesho.com policybazaar.com makemytrip.com redbus.in bookmyshow.com hotstar.com practo.com pharmeasy.in cowin.gov.in mygov.in passportindia.gov.in " +
  "indusind.com idfcfirstbank.com federalbank.co.in bandhanbank.com openai.com huggingface.co kaggle.com leetcode.com hackerrank.com freecodecamp.org " +
  "w3schools.com geeksforgeeks.org digitalocean.com heroku.com vercel.com grammarly.com duolingo.com udemy.com twilio.com zendesk.com typeform.com " +
  "delta.com emirates.com goindigo.in telegraph.co.uk aljazeera.com cricbuzz.com espncricinfo.com pnc.com schwab.com fidelity.com robinhood.com " +
  "klarna.com bluehost.com nordvpn.com lastpass.com bitwarden.com").split(" ").map((h) => "https://www." + h + "/");
const LEGIT = OFFICIAL.concat(ORDINARY, REAL_SITES);

const PHISHING = [
  // typos and look-alike characters
  "https://paypa1.com/signin", "https://paypall.com/login", "https://faceboook.com/login", "https://gooogle.com/accounts", "https://goog1e-accounts.com/",
  "https://amaz0n.com/ap/signin", "https://arnazon.com/orders", "https://micr0soft.com/login", "https://microsft.com/office", "https://netfliix.com/login",
  "https://linkedln.com/feed", "https://instagrarn.com/accounts/login", "https://whatsap.com/web", "https://flipcart.com/offers", "https://fllpkart.com/sale",
  "https://hdfcbnk.com/netbanking", "https://icicibnak.com/login", "https://axisbamk.com/login", "https://paypa1.com/webscr?cmd=_login-run",
  // brand + words
  "https://paypal-support.com/help", "https://paypal-secure-login.xyz/", "https://secure-paypal.net/confirm", "https://amazon-prime-reward.top/claim",
  "https://chase-online-verify.com/", "https://sbi-kyc-update-online.in/", "https://hdfcbank-netbanking-login.com/", "https://icici-rewards-claim.top/",
  "https://netflix-billing-update.com/pay", "https://dhl-parcel-delivery-fee.top/", "https://paypalsecure.com/login", "https://applepay-verify.com/id",
  "https://microsoftsupport.xyz/call", "https://amazonlogin.com/signin", "https://facebooksecurity.net/check", "https://googleaccountsverify.com/",
  // brand in front of another domain
  "https://paypal.com.secure-login.xyz/", "https://login.paypal.com.verify-id.top/", "https://www.google.com.account-check.in/", "https://amazon.in.deals-today.shop/",
  "https://accounts.google.com.signin.cfd/", "https://hdfcbank.com.netbanking-secure.in/", "https://sbi.co.in.kyc-update.online/",
  // other alphabets
  "https://xn--80ak6aa92e.com/", "https://\u0440\u0430\u0443\u0440\u0430l.com/", "https://g\u043e\u043egle.com/", "https://\u0430mazon.com/", "https://micr\u043es\u043eft.com/",
  // raw IPs, credentials in the address
  "http://203.0.113.45/paypal/login.php", "http://198.51.100.9:8080/secure/signin", "http://[2001:db8::1]/bank/login",
  "http://paypal.com@malicious-host.xyz/", "https://www.google.com:443@evil-host.top/login",
  // free hosting
  "https://paypal-login.github.io/", "https://secure-hdfcbank.netlify.app/", "https://amazon-refund.web.app/", "https://microsoft-support.weebly.com/", "https://chase-verify.pages.dev/",
  // machine-generated names
  "https://xkqjzvplwmtr.top/", "https://q7w8e9r0t1y2u3i4.xyz/", "https://bvnmcxzlkjhg.click/", "https://a8f3e9c1b7d2e4f6.top/", "https://zzqxwvkjhrtp.icu/",
  "https://8h2j9k4l6m3n7p1q.buzz/", "https://lkjhgfdsazxcvb.work/",
  // generic lures
  "https://secure.login.update.bank-verify.cfd/%2e%2e/x", "https://account-verification-center-login.top/", "https://kyc-update-india-now.xyz/", "https://free-gift-reward-claim.click/",
  "https://upi-refund-status.icu/",
];

function rates(threshold) {
  const fp = LEGIT.filter((u) => D.scoreUrl(u).score >= threshold);
  const fn = PHISHING.filter((u) => D.scoreUrl(u).score < threshold);
  const tp = PHISHING.length - fn.length;
  return { fp, fn, precision: tp / (tp + fp.length || 1), recall: tp / PHISHING.length };
}

test("corpus is large enough", () => {
  assert.ok(LEGIT.length >= 50, `${LEGIT.length} legit`);
  assert.ok(PHISHING.length >= 50, `${PHISHING.length} phishing`);
});

test("official brand domains always score exactly 0", () => {
  for (const u of OFFICIAL) {
    const v = D.scoreUrl(u);
    assert.strictEqual(v.score, 0, u);
    assert.strictEqual(v.level, "none", u);
  }
  const v = D.scoreUrl("https://secure.paypal.com/signin");
  assert.strictEqual(v.brand, "paypal");
  assert.strictEqual(v.official, "paypal.com");
});

test("no legitimate site reaches the 'low' level", () => {
  const { fp } = rates(0.25);
  assert.deepStrictEqual(fp, []);
});

test("phishing: precision and recall at the medium threshold (0.5)", () => {
  const r = rates(0.5);
  assert.deepStrictEqual(r.fp, []);
  assert.ok(r.precision >= 0.98, "precision " + r.precision);
  assert.ok(r.recall >= 0.9, `recall ${r.recall}; missed: ${r.fn.join(" ")}`);
});

test("phishing: nearly everything is at least 'low' (0.25), and most is 'high'", () => {
  const r = rates(0.25);
  assert.ok(r.recall >= 0.96, `recall ${r.recall}; missed: ${r.fn.join(" ")}`);
  const high = PHISHING.filter((u) => D.scoreUrl(u).level === "high").length;
  assert.ok(high / PHISHING.length >= 0.6, "high share " + high / PHISHING.length);
});

// ---- verdict shape -----------------------------------------------------------------------------------------------
test("a verdict has the contract's shape", () => {
  for (const u of ["https://paypa1-login.xyz/", "https://example.org/", "https://paypal.com/"]) {
    const v = D.scoreUrl(u);
    assert.deepStrictEqual(Object.keys(v).sort(), ["brand", "features", "level", "official", "reasons", "score"]);
    assert.ok(v.score >= 0 && v.score <= 1);
    assert.ok(["none", "low", "medium", "high"].includes(v.level));
    assert.ok(Array.isArray(v.reasons) && v.reasons.length <= 6 && v.reasons.every((r) => typeof r === "string"));
    assert.strictEqual(typeof v.features, "object");
  }
  assert.strictEqual(D.version, 2);
  assert.ok(Number.isInteger(D.version));
});

test("levels follow the contract thresholds", () => {
  const c = D.combine;
  for (const [s, level] of [[0.1, "none"], [0.3, "low"], [0.6, "medium"], [0.9, "high"]]) {
    assert.strictEqual(c([{ score: s, level: "x", reasons: [] }]).level, level, String(s));
  }
});

test("reasons say what was seen and name no page text", () => {
  const v = D.scoreUrl("https://paypal.com.secure-login.xyz/");
  assert.ok(v.reasons.length >= 1 && v.reasons.length <= 6);
  assert.ok(v.reasons.some((r) => /paypal/.test(r)));
  assert.strictEqual(v.brand, "paypal");
  assert.strictEqual(v.official, "paypal.com");
});

// ---- garbage in, no throw ----------------------------------------------------------------------------------------
test("garbage input never throws and scores 0", () => {
  const junk = [null, undefined, 5, NaN, {}, [], true, "", " ", "http://", "https://", "://x", "not a url", "javascript:alert(1)", "data:text/html,hi",
    "chrome://extensions", "file:///c:/x", "http://[::", "http://a..b/", "http://%zz.com/", "\u0000\u0001", "http://" + "a".repeat(5000) + ".com/",
    "https://example.com/" + "x".repeat(200000), "http://" + "a.".repeat(500) + "com", "ftp://paypal.com/", { toString() { throw new Error("x"); } }];
  for (const j of junk) {
    let v;
    assert.doesNotThrow(() => { v = D.scoreUrl(j); }, String(typeof j));
    assert.strictEqual(v.level === "none" || v.score >= 0, true);
    assert.ok(v.score >= 0 && v.score <= 1);
  }
  for (const j of [null, undefined, 5, "x", [], { text: 5, form_actions: "no", title: {} }, { form_actions: [null, 5, {}, "::"], external_script_hosts: 7, has_password_field: "yes" }]) {
    assert.doesNotThrow(() => D.scorePage(j));
    assert.ok(D.scorePage(j).score >= 0);
  }
  for (const j of [null, undefined, 5, "x", [], [null], [{}], [{ score: "bad" }], [{ score: NaN, reasons: 4 }]]) {
    assert.doesNotThrow(() => D.combine(j));
  }
  assert.strictEqual(D.scoreUrl(null).score, 0);
  assert.strictEqual(D.scorePage(null).level, "none");
  assert.strictEqual(D.combine([]).score, 0);
  assert.doesNotThrow(() => D.scoreUrl("https://paypa1.com/", { brands: 5, official: "x" }));
});

test("bare hosts without a scheme are understood", () => {
  assert.ok(D.scoreUrl("paypa1-login.xyz/signin").score >= 0.75);
  assert.strictEqual(D.scoreUrl("paypal.com").score, 0);
});

// ---- building blocks -----------------------------------------------------------------------------------------------
test("public suffix aware parsing", () => {
  const p = D.parseHost;
  assert.deepStrictEqual([p("a.b.example.com").reg, p("a.b.example.com").sld], ["example.com", "example"]);
  assert.deepStrictEqual([p("shop.example.co.uk").reg, p("shop.example.co.uk").suffix], ["example.co.uk", "co.uk"]);
  assert.strictEqual(p("login.paypal.github.io").reg, "paypal.github.io");
  assert.strictEqual(p("x.irctc.co.in").reg, "irctc.co.in");
  assert.strictEqual(p("co.uk").sld, "");
});

test("punycode decoding", () => {
  assert.strictEqual(D.punycodeDecode("bcher-kva"), "b\u00fccher");
  assert.strictEqual(D.punycodeDecode("80ak6aa92e"), "\u0430\u0440\u0440\u04cf\u0435");
  assert.throws(() => D.punycodeDecode("!!"));
});

test("skeleton folds look-alikes", () => {
  assert.strictEqual(D.skeleton("paypa1"), D.skeleton("paypal"));
  assert.strictEqual(D.skeleton("arnazon"), D.skeleton("amazon"));
  assert.strictEqual(D.skeleton("g00gle"), D.skeleton("google"));
  assert.strictEqual(D.skeleton("\u0440\u0430\u0443\u0440\u0430l"), D.skeleton("paypal"));
  assert.notStrictEqual(D.skeleton("paypal"), D.skeleton("paypay"));
});

test("Damerau-Levenshtein is bounded and counts a swap as one edit", () => {
  const d = D.editDistance;
  assert.strictEqual(d("paypal", "paypal", 2), 0);
  assert.strictEqual(d("paypal", "paypall", 2), 1);
  assert.strictEqual(d("paypal", "pyapal", 2), 1);
  assert.strictEqual(d("paypal", "paypxl", 2), 1);
  assert.strictEqual(d("paypal", "pxypxl", 2), 2);
  assert.strictEqual(d("paypal", "google", 2), 3);          // "more than max"
  assert.strictEqual(d("a", "abcdef", 2), 3);
});

test("keyboard slips and swaps add a little evidence", () => {
  const near = D.scoreUrl("https://axisbamk.com/").score;      // m is next to n
  const far = D.scoreUrl("https://axisbaxk.com/").score;
  assert.ok(near > far, `${near} vs ${far}`);
  assert.ok(D.scoreUrl("https://icicibnak.com/").features.edit_distance === 1);
});

test("algorithmic names are told apart from real words", () => {
  for (const s of ["xkqjzvplwmtr", "q7w8e9r0t1y2u3i4", "a8f3e9c1b7d2e4f6", "bvnmcxzlkjhg"]) assert.ok(D.dgaScore(s) >= 0.4, s);
  for (const s of ["stackoverflow", "wikipedia", "greenvalleyfarms", "northwindtraders", "chennaicricketclub", "bookkeeping", "springfieldlibrary", "hillviewacademy", "flipkart", "zerodha"]) {
    assert.ok(D.dgaScore(s) < 0.4, s + " " + D.dgaScore(s));
  }
});

test("lookalikes of short brand names need more than the name", () => {
  assert.ok(D.scoreUrl("https://groups.io/").score < 0.25);
  assert.ok(D.scoreUrl("https://uberlin.de/").score < 0.25);
  assert.ok(D.scoreUrl("https://sbi.xyz/").score >= 0.5);
  assert.ok(D.scoreUrl("https://sbi-kyc-update-online.in/").score >= 0.5);
});

test("URL shape features: userinfo, ports, encoded text, deep subdomains", () => {
  const plain = D.scoreUrl("https://shop.example-store.com/a");
  assert.ok(D.scoreUrl("https://shop.example-store.com:4444/a").score > plain.score);
  assert.ok(D.scoreUrl("https://user:pw@shop.example-store.com/a").score > plain.score + 0.2);
  assert.ok(D.scoreUrl("https://a.b.c.d.e.f.example-store.com/a").score > plain.score);
  assert.ok(D.scoreUrl("https://shop.example-store.com/a%20%2e%2e%2f%3d%3a?x=%41%42").features.encoded >= 5);
  assert.ok(D.scoreUrl("http://shop.example-store.com/a").score > plain.score);
});

test("private and local addresses are not judged", () => {
  for (const u of ["http://10.0.0.5/login", "http://192.168.0.10/", "http://127.0.0.1:8080/", "http://localhost/paypal/login"]) assert.strictEqual(D.scoreUrl(u).score, 0, u);
});

// ---- ctx -------------------------------------------------------------------------------------------------------
test("ctx.official lists extra domains that always score 0", () => {
  const u = "https://paypal-support.com/help";
  assert.ok(D.scoreUrl(u).score >= 0.5);
  assert.strictEqual(D.scoreUrl(u, { official: ["paypal-support.com"] }).score, 0);
});

test("ctx.brands replaces the built-in list (array or map form)", () => {
  const brands = { acmebank: ["acmebank.com"], zenpay: ["zenpay.io"] };
  const v = D.scoreUrl("https://acmebank-login.xyz/", { brands });
  assert.ok(v.score >= 0.75);
  assert.strictEqual(v.brand, "acmebank");
  assert.strictEqual(v.official, "acmebank.com");
  assert.strictEqual(D.scoreUrl("https://acmebank.com/", { brands }).score, 0);
  assert.ok(D.scoreUrl("https://paypa1.com/", { brands }).score < 0.25);       // built-ins are gone
  const arr = [{ name: "zenpay", names: ["zenpayments"], domains: ["zenpay.io"] }];
  assert.ok(D.scoreUrl("https://zenpayments-help.top/", { brands: arr }).score >= 0.5);
});

test("deterministic: same input, same verdict", () => {
  const a = D.scoreUrl("https://paypa1-secure-login.xyz/verify?x=1"), b = D.scoreUrl("https://paypa1-secure-login.xyz/verify?x=1");
  assert.deepStrictEqual(a, b);
});

// ---- scorePage --------------------------------------------------------------------------------------------------
const loginPage = (extra) => Object.assign({ title: "Sign in", description: "", text: "Welcome back", has_password_field: true, form_count: 1, url: "https://shop.example-store.com/login" }, extra);

test("scorePage: a plain login form on an unknown site is not alarming", () => {
  const v = D.scorePage(loginPage({ form_actions: ["https://shop.example-store.com/session"] }));
  assert.ok(v.score < 0.25, String(v.score));
});

test("scorePage: password sent to another site, or over http", () => {
  const base = D.scorePage(loginPage({})).score;
  const cross = D.scorePage(loginPage({ form_actions: ["https://collector.other-host.net/post"] }));
  assert.ok(cross.score > base + 0.1 && cross.reasons.some((r) => /different site/.test(r)));
  const http = D.scorePage(loginPage({ url: "http://shop.example-store.com/login", form_actions: ["http://shop.example-store.com/s"] }));
  assert.ok(http.score > base);
  const ip = D.scorePage(loginPage({ form_actions: ["http://198.51.100.7/p.php"] }));
  assert.ok(ip.reasons.some((r) => /IP/.test(r)));
  const mail = D.scorePage(loginPage({ form_actions: ["mailto:x@example.org"] }));
  assert.ok(mail.score > base);
});

test("scorePage: brand in the title that does not match the host", () => {
  const v = D.scorePage(loginPage({ title: "PayPal - Log in to your account", form_actions: ["https://shop.example-store.com/s"] }));
  assert.strictEqual(v.brand, "paypal");
  assert.strictEqual(v.official, "paypal.com");
  assert.ok(v.score >= 0.25, String(v.score));
  const noPw = D.scorePage({ title: "PayPal announces results", text: "", has_password_field: false, url: "https://news.example-daily.com/a" });
  assert.ok(noPw.score < 0.25);
  const real = D.scorePage(loginPage({ title: "PayPal - Log in", url: "https://www.paypal.com/signin", form_actions: ["https://www.paypal.com/auth"] }));
  assert.strictEqual(real.score, 0);
});

test("scorePage: pressure wording raises the score; reasons never repeat page text", () => {
  const secret = "ZEBRA-QUOKKA-77";
  const text = `${secret} Your account has been suspended. Verify your identity within 24 hours or it will be closed permanently. Enter your OTP and card number to continue.`;
  const calm = D.scorePage(loginPage({ text: "Welcome back to our shop" })).score;
  const v = D.scorePage(loginPage({ text, form_actions: ["https://collector.other-host.net/post"] }));
  assert.ok(v.score > 0.75 && v.score > calm, String(v.score));
  assert.ok(v.reasons.length <= 6);
  assert.ok(!JSON.stringify(v).includes(secret));
  assert.ok(!JSON.stringify(v).includes("OTP and card"));
  const kyc = D.scorePage({ title: "Update", text: "Your KYC is pending. Complete KYC update now. Click claim your reward", has_password_field: false, url: "https://bonus.example-deals.top/" });
  assert.ok(kyc.score > D.scorePage({ title: "Update", text: "calm text", url: "https://bonus.example-deals.top/" }).score);
});

test("scorePage: hidden frames, many script hosts, packed code", () => {
  const base = D.scorePage(loginPage({})).score;
  assert.ok(D.scorePage(loginPage({ hidden_iframes: 4 })).score > base);
  assert.ok(D.scorePage(loginPage({ external_script_hosts: Array.from({ length: 30 }, (_, i) => `h${i}.example.net`) })).score > base);
  assert.ok(D.scorePage(loginPage({ inline_script_entropy: 5.9 })).score > D.scorePage(loginPage({ inline_script_entropy: 4.8 })).score);
});

test("scorePage works without a URL (host features are skipped)", () => {
  const v = D.scorePage({ title: "PayPal login", text: "calm", has_password_field: true, form_count: 1 });
  assert.strictEqual(v.brand, null);
  assert.ok(v.score >= 0);
  const urgent = D.scorePage({ text: "Unusual sign-in activity. Verify your identity within 24 hours.", has_password_field: true });
  assert.ok(urgent.score > v.score);
});

// ---- combine ----------------------------------------------------------------------------------------------------
test("combine: evidence adds, strongest first, never below the strongest", () => {
  const u = D.scoreUrl("https://paypal-support.com/help");
  const p = D.scorePage({ title: "PayPal", text: "Verify your identity within 24 hours", has_password_field: true, url: "https://paypal-support.com/help",
    form_actions: ["https://collector.other-host.net/x"] });
  const c = D.combine([u, p]);
  assert.ok(c.score >= Math.max(u.score, p.score));
  assert.ok(c.score <= 1);
  assert.strictEqual(c.brand, "paypal");
  assert.ok(c.reasons.length <= 6);
  assert.deepStrictEqual(D.combine([u]).score, u.score);
  assert.strictEqual(D.combine([D.scoreUrl("https://example.org/"), null]).level, "none");
});

test("combine: an official verdict wins, so a page can never make a brand's own site look bad", () => {
  const official = D.scoreUrl("https://www.paypal.com/");
  const odd = { score: 0.9, level: "high", reasons: ["x"], brand: null, official: null, features: {} };
  const c = D.combine([official, odd]);
  assert.strictEqual(c.score, 0);
  assert.strictEqual(c.official, "paypal.com");
});

test("extractDomSignals reads a document into the signals scorePage takes, and never throws", () => {
  const el = (attrs) => ({ getAttribute: (n) => (attrs[n] == null ? null : attrs[n]), hidden: !!attrs.hiddenFlag });
  const inline = Array.from({ length: 80 }, (_, i) => String.fromCharCode(33 + ((i * 37) % 90)) + (i * 7919).toString(36)).join("");
  const doc = {
    URL: "https://login.example-shop.top/signin", title: "Sign in to PayPal",
    querySelector: (sel) => (sel.includes("password") ? {} : sel.includes("description") ? { getAttribute: () => "Secure sign in" } : null),
    body: { innerText: "Verify   your\n identity  within 24 hours" },
    forms: [{ action: "https://collector.other-host.net/post" }, { action: "" }, { action: "https://collector.other-host.net/post" }],
    scripts: [{ src: "https://cdn.other-host.net/a.js" }, { src: "/local.js" }, { src: "" , textContent: inline }, { src: "https://cdn.other-host.net/b.js" }],
    getElementsByTagName: () => [el({ style: "display:none" }), el({ width: "0" }), el({ hiddenFlag: true }), el({ style: "border:0" })],
  };
  const s = D.extractDomSignals(doc, { href: doc.URL, hostname: "login.example-shop.top" });
  assert.strictEqual(s.title, "Sign in to PayPal");
  assert.strictEqual(s.text, "Verify your identity within 24 hours");
  assert.strictEqual(s.has_password_field, true);
  assert.strictEqual(s.form_count, 3);
  assert.deepStrictEqual(s.form_actions, ["https://collector.other-host.net/post"]);
  assert.deepStrictEqual(s.external_script_hosts, ["cdn.other-host.net"]);
  assert.strictEqual(s.hidden_iframes, 3);
  assert.ok(s.inline_script_entropy > 4);
  assert.strictEqual(s.url, doc.URL);
  const v = D.scorePage(s);
  assert.ok(v.score >= 0.5 && v.brand === "paypal", JSON.stringify(v));
  for (const bad of [null, undefined, {}, 5, { body: null, forms: 5 }]) assert.doesNotThrow(() => D.extractDomSignals(bad, null));
  assert.strictEqual(D.extractDomSignals(null).has_password_field, false);
});

test("combine accepts verdicts that came from the server", () => {
  const c = D.combine([{ score: 0.4, reasons: ["server says"], brand: "x" }, D.scoreUrl("https://example.org/")]);
  assert.ok(c.score >= 0.4 - 0.001);
  assert.ok(c.reasons.includes("server says"));
});
