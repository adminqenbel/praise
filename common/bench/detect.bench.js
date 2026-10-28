// Micro-benchmark for common/detect.js:  node common/bench/detect.bench.js
// Prints per-call median / p95 (microseconds, after warm-up) and ops/sec for each entry point.
// Every URL is distinct (a counter is appended), so no result can be served from a cache.
const D = require("../detect.js");

const LEGIT = ["https://www.google.com/search?q=cats", "https://github.com/anthropics/claude-code/issues/1", "https://en.wikipedia.org/wiki/Phishing",
  "https://stackoverflow.com/questions/1/how-to", "https://www.bbc.co.uk/news/world", "https://mail.example-school.edu/inbox", "https://irctc.co.in/nget/train-search",
  "https://shop.mybakery-chennai.com/cart?item=4", "https://docs.python.org/3/library/re.html", "https://www.nytimes.com/section/world",
  "https://rajeshhardware.in/products", "https://blog.springfieldlibrary.org/2024/05/summer-reading", "https://applebees.com/menu", "https://pineapple-recipes.com/cake",
  "https://news.ycombinator.com/item?id=123", "https://www.reddit.com/r/programming/", "https://learn.microsoft.com/en-us/azure/", "https://pay.google.com/about/",
  "https://www.greenvalleyfarms.com/shop/eggs", "https://blog.sunrise-dental-clinic.co.uk/team", "https://app.bookkeeping-helper.io/dashboard", "https://www.hillviewacademy.org/admissions",
  "https://kerala-spice-traders.in/catalog?page=2", "https://secure.mortgage-advisers-leeds.co.uk/login", "https://www.trailrunnersclub.net/events/2024", "https://support.acme-widgets.com/tickets/42",
  "https://www.bankbazaar.com/credit-card.html", "https://myaccount.northwindtraders.com/billing"];
const BAD = ["https://paypa1-secure-login.xyz/verify", "http://paypal.com.account-update.top/a", "https://faceboook.com/login", "https://amazon-support.com/help",
  "https://xkqjzvplwmtr.top/", "https://hdfcbank-kyc-update.in/x", "http://203.0.113.9/paypal/signin", "https://secure.login.update.bank-verify.cfd/%2e%2e/x?u=1",
  "https://микрософт-login.com/", "http://paypal.com@evil.example.xyz/", "https://paypal-login.github.io/",
  "https://goog1e.com/accounts", "https://m1crosoft-support.click/"];

function bench(name, fn, n) {
  for (let i = 0; i < 5000; i++) fn(i);                 // warm-up (also builds the lazy indexes)
  const times = new Float64Array(n);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    const a = process.hrtime.bigint();
    fn(i);
    times[i] = Number(process.hrtime.bigint() - a) / 1000;
  }
  const total = Number(process.hrtime.bigint() - t0) / 1e9;
  times.sort();
  const med = times[Math.floor(n / 2)], p95 = times[Math.floor(n * 0.95)];
  console.log(`${name.padEnd(26)} median ${med.toFixed(1).padStart(6)} us   p95 ${p95.toFixed(1).padStart(6)} us   ${Math.round(n / total).toLocaleString().padStart(10)} ops/s (timer overhead included)`);
  return med;
}

const t = process.hrtime.bigint();
D.scoreUrl("https://paypal.com/");
console.log(`first call (builds the indexes): ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(2)} ms`);

const page = { title: "Sign in to your PayPal account", description: "", url: "https://login-secure.example.xyz/",
  text: "Your account has been suspended. Verify your identity within 24 hours or it will be closed permanently. Enter your password and card number.",
  has_password_field: true, form_count: 1, form_actions: ["http://198.51.100.7/post.php"], external_script_hosts: ["a.example", "b.example"],
  hidden_iframes: 1, inline_script_entropy: 5.0 };
const mixed = (i) => (i % 3 === 0 ? BAD[i % BAD.length] : LEGIT[i % LEGIT.length]) + "?n=" + i;
const vs = [];
for (let i = 0; i < 300; i++) vs.push(D.scoreUrl(mixed(i)));
const results = {
  mixed: bench("scoreUrl (1/3 phishing)", (i) => D.scoreUrl(mixed(i)), 60000),
  legit: bench("scoreUrl (legit only)", (i) => D.scoreUrl(LEGIT[i % LEGIT.length] + "?n=" + i), 60000),
  phish: bench("scoreUrl (phishing only)", (i) => D.scoreUrl(BAD[i % BAD.length] + "?n=" + i), 60000),
  page: bench("scorePage", () => D.scorePage(page), 30000),
  combine: bench("combine (2 verdicts)", (i) => D.combine([vs[i % vs.length], vs[(i + 1) % vs.length]]), 60000),
};
if (process.argv.includes("--json")) console.log(JSON.stringify(results));
