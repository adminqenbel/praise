const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const P = require("../protections.js");

const ext = (...p) => path.join(__dirname, "..", "..", "extension", ...p);

// ---- switches ------------------------------------------------------------------------------------------------------
test("techniqueOptions: conservative defaults, older privacy switches keep their meaning", () => {
  const d = P.techniqueOptions(undefined);
  assert.deepStrictEqual([d.strip_params, d.send_gpc, d.send_dnt, d.trim_referrer, d.https_upgrade], [true, true, false, true, false]);
  assert.strictEqual(d.harden.webrtc, false);                         // can affect calls: opt in
  assert.strictEqual(d.harden.canvas, true);
  assert.deepStrictEqual(P.techniqueOptions({ privacy: { strip_tracking_params: false } }).strip_params, false);
  const off = P.techniqueOptions({ privacy: { block_fingerprinting: false } });
  assert.ok(Object.values(off.harden).every((v) => v === false));    // the master switch turns all hardening off
  const mine = P.techniqueOptions({ techniques: { send_dnt: true, https_upgrade: true, https_upgrade_exceptions: ["Old-Portal.example.org", "bad domain", 5, "x.co.uk."], harden: { webrtc: true, canvas: false } } });
  assert.deepStrictEqual([mine.send_dnt, mine.https_upgrade, mine.harden.webrtc, mine.harden.canvas], [true, true, true, false]);
  assert.deepStrictEqual(mine.https_upgrade_exceptions, ["old-portal.example.org", "x.co.uk"]);
  assert.strictEqual(P.techniqueOptions({ techniques: { send_gpc: "yes", strip_params: 1 } }).send_gpc, true);   // wrong types fall back
  assert.strictEqual(P.techniqueOptions("junk").strip_params, true);
  assert.strictEqual(P.DEFAULTS.privacy.strip_tracking_params, true);  // the settings schema itself is unchanged
});

// ---- dynamic rules ------------------------------------------------------------------------------------------------
const ALL_OFF = { strip_params: false, send_gpc: false, send_dnt: false, trim_referrer: false, https_upgrade: false };

test("buildDynamicRules: each technique is its own switch", () => {
  const only = (key, extra) => P.buildDynamicRules(Object.assign({}, ALL_OFF, { [key]: true }, extra)).rules;
  assert.deepStrictEqual(P.buildDynamicRules(ALL_OFF).rules, []);
  assert.ok(only("strip_params").length >= 2 && only("strip_params").every((r) => r.action.type === "redirect"));
  const gpc = only("send_gpc");
  assert.deepStrictEqual(gpc.map((r) => r.id), [P.RULE_IDS.gpc]);
  assert.deepStrictEqual(gpc[0].action.requestHeaders, [{ header: "Sec-GPC", operation: "set", value: "1" }]);
  const dnt = only("send_dnt");
  assert.deepStrictEqual(dnt[0].action.requestHeaders, [{ header: "DNT", operation: "set", value: "1" }]);
  const ref = only("trim_referrer");
  assert.strictEqual(ref.length, 1);
  assert.deepStrictEqual(ref[0].action.requestHeaders, [{ header: "referer", operation: "remove" }]);
  assert.ok(only("https_upgrade").some((r) => r.action.type === "upgradeScheme"));
  const defaults = P.buildDynamicRules().rules;
  assert.ok(defaults.some((r) => r.id === P.RULE_IDS.gpc) && !defaults.some((r) => r.action.type === "upgradeScheme") && !defaults.some((r) => r.id === P.RULE_IDS.dnt));
});

test("rule ids are deterministic, unique, and all inside the reserved range that updateDynamicRules clears", () => {
  const all = P.buildDynamicRules({ send_dnt: true, https_upgrade: true, https_upgrade_exceptions: ["a.example.org"] });
  assert.deepStrictEqual(all, P.buildDynamicRules({ https_upgrade_exceptions: ["a.example.org"], https_upgrade: true, send_dnt: true }));
  const ids = all.rules.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  const reserved = new Set(all.removeRuleIds);
  assert.strictEqual(reserved.size, all.removeRuleIds.length);
  for (const id of ids) assert.ok(reserved.has(id), "id " + id);
  assert.deepStrictEqual(P.reservedRuleIds(), all.removeRuleIds);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(all)), all);                      // plain data, can be passed to Chrome as is
});

test("generated rules satisfy Chrome's limits and rule validity (checkRules)", () => {
  const all = P.buildDynamicRules({ send_dnt: true, https_upgrade: true, https_upgrade_exceptions: ["a.example.org"] }).rules;
  assert.deepStrictEqual(P.checkRules(all, "dynamic"), []);
  for (const [name, rules] of Object.entries(Object.assign({}, P.buildRulesets(), P.buildPrivacyRulesets()))) {
    assert.deepStrictEqual(P.checkRules(rules, "static"), [], name);
  }
  assert.ok(all.length < 100);                                                         // far below the 30,000 dynamic limit
  assert.ok(P.LIMITS.dynamicRules === 30000 && P.LIMITS.regexRules === 1000);
});

test("checkRules catches what Chrome would reject", () => {
  const ok = { id: 1, priority: 1, action: { type: "block" }, condition: { requestDomains: ["a.example.com"], resourceTypes: ["script"] } };
  assert.deepStrictEqual(P.checkRules([ok]), []);
  const has = (rules, re, kind) => assert.ok(P.checkRules(rules, kind).some((p) => re.test(p)), String(re) + " in " + JSON.stringify(P.checkRules(rules, kind)));
  has([ok, ok], /duplicate/);
  has([{ ...ok, id: 0 }], /id must be/);
  has([{ ...ok, action: { type: "nuke" } }], /unknown action/);
  has([{ ...ok, condition: { resourceTypes: ["bogus"] } }], /unknown resource/);
  has([{ ...ok, condition: { requestDomains: ["not a host"] } }], /bad domain/);
  has([{ ...ok, condition: { regexFilter: "(" } }], /does not compile/);
  has([{ ...ok, condition: { regexFilter: "a".repeat(600) } }], /too long/);
  has([{ ...ok, condition: { resourceTypes: ["main_frame"] } }], /blocks main_frame/);
  has([{ ...ok, action: { type: "modifyHeaders" } }], /without headers/);
  has(Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, priority: 1, action: { type: "allow" }, condition: { regexFilter: "^x" } })), /too many regex/);
  has(Array.from({ length: 5001 }, (_, i) => ({ id: i + 1, priority: 1, action: { type: "upgradeScheme" }, condition: { urlFilter: "|http://" } })), /too many redirect/, "dynamic");
  assert.ok(P.checkRules(null).length);
});

// ---- tracking parameters ------------------------------------------------------------------------------------------
test("tracking parameters: unique, plain names, the common ones present, functional ones absent", () => {
  assert.strictEqual(new Set(P.TRACKING_PARAMS).size, P.TRACKING_PARAMS.length);
  for (const p of P.TRACKING_PARAMS) assert.match(p, /^[a-z0-9_]+$/);               // the regex builder does not escape names
  for (const p of ["utm_source", "fbclid", "gclid", "msclkid", "mc_eid", "igshid", "_hsenc", "_gl", "mkt_tok", "yclid", "twclid", "ttclid", "li_fat_id"]) {
    assert.ok(P.TRACKING_PARAMS.includes(p), p);
  }
  for (const p of ["id", "q", "page", "v", "t", "ref", "source", "campaign", "code", "state", "token", "lang", "list", "si"]) assert.ok(!P.TRACKING_PARAMS.includes(p), p + " is functional");
  assert.strictEqual(P.stripTrackingParams("https://x.com/watch?v=abc&t=10&igshid=1&_gl=2*abc"), "https://x.com/watch?v=abc&t=10");
});

test("queryTransform rules keep working with a larger parameter list", () => {
  const rules = P.paramStripRules(P.RULE_IDS.params);
  assert.ok(rules.length >= 4 && rules.length < 99);
  for (const r of rules) {
    assert.ok(r.condition.regexFilter.length < 200);
    assert.deepStrictEqual(r.action.redirect.transform.queryTransform.removeParams, P.TRACKING_PARAMS);
  }
  const hit = (u) => rules.some((r) => new RegExp(r.condition.regexFilter).test(u));
  assert.ok(hit("https://a.com/p?id=1&mkt_tok=abc") && hit("https://a.com/?_gl=1") && hit("https://a.com/?x=1&pk_campaign=z"));
  assert.ok(!hit("https://a.com/?id=1&page=2"));
});

// ---- HTTPS upgrade ------------------------------------------------------------------------------------------------
test("HTTPS upgrade: main frame only, and the usual exclusions win by priority", () => {
  const rules = P.httpsUpgradeRules(["Legacy.example.org"]);
  const up = rules.find((r) => r.action.type === "upgradeScheme");
  assert.deepStrictEqual(up.condition.resourceTypes, ["main_frame"]);
  const allows = rules.filter((r) => r.action.type === "allow");
  assert.ok(allows.length >= 6 && allows.every((r) => r.priority > up.priority && r.condition.resourceTypes.join() === "main_frame"));
  // the keep-on-http patterns, as Chrome's regex engine would read them
  const keep = (u) => allows.filter((r) => r.condition.regexFilter).some((r) => new RegExp(r.condition.regexFilter).test(u));
  for (const u of ["http://192.168.1.10/admin", "http://10.0.0.1:8080/", "http://[::1]/", "http://localhost/", "http://localhost:3000/x", "http://printer/status",
    "http://nas.local/", "http://router.home.arpa/", "http://site.example.com:8080/", "http://user@192.0.2.5/", "http://app.internal/login", "http://x.test/"]) assert.ok(keep(u), u);
  for (const u of ["http://example.com/", "http://www.bbc.co.uk/news", "http://sub.school.edu/a?b=http://x:80", "http://news.site.org/path:1"]) assert.ok(!keep(u), u);
  const named = allows.filter((r) => r.condition.requestDomains).flatMap((r) => r.condition.requestDomains);
  for (const d of ["neverssl.com", "captive.apple.com", "connectivitycheck.gstatic.com", "legacy.example.org"]) assert.ok(named.includes(d), d);
  assert.deepStrictEqual(P.checkRules(rules), []);
});

// ---- block lists --------------------------------------------------------------------------------------------------
test("block lists: refreshed, deduplicated, and fraud-prevention scripts stay out", () => {
  const sets = P.buildRulesets();
  const trackers = sets.trackers[0].condition.requestDomains, fp = sets.fingerprint[0].condition.requestDomains;
  assert.ok(trackers.length >= 90, String(trackers.length));
  assert.strictEqual(new Set(trackers).size, trackers.length);
  assert.deepStrictEqual(trackers.slice().sort(), trackers);
  for (const d of ["fullstory.com", "adsafeprotected.com", "mc.yandex.ru", "hs-analytics.net", "doubleclick.net"]) assert.ok(trackers.includes(d), d);
  for (const d of ["fingerprintjs.com", "fpjs.io", "liveramp.com"]) assert.ok(fp.includes(d), d);
  for (const d of P.FRAUD_SCRIPT_DOMAINS) assert.ok(!trackers.includes(d) && !fp.includes(d), d + " would break sign-ins");
  for (const d of ["google.com", "facebook.com", "youtube.com", "wikipedia.org", "github.com", "amazon.com", "microsoft.com"]) assert.ok(!trackers.includes(d), d);
  assert.strictEqual(sets.fingerprint[0].condition.requestDomains.filter((d) => trackers.includes(d)).length, 0, "no domain in two lists");
});

test("referrer rule only touches third-party requests to tracking hosts", () => {
  const r = P.buildPrivacyRulesets().referrer[0];
  assert.strictEqual(r.condition.domainType, "thirdParty");
  assert.ok(!r.condition.resourceTypes.includes("main_frame"));
  assert.ok(r.condition.requestDomains.includes("doubleclick.net") && !r.condition.requestDomains.includes("google.com"));
});

test("generated files match the code (run node scripts/build_rules.js)", () => {
  const all = Object.assign({}, P.buildRulesets(), P.buildPrivacyRulesets());
  for (const [name, rules] of Object.entries(all)) assert.deepStrictEqual(JSON.parse(fs.readFileSync(ext("rules", `${name}.json`), "utf8")), rules, name);
  const gen = fs.readFileSync(ext("harden-main.js"), "utf8");
  assert.ok(gen.endsWith(P.hardeningSource(P.TECHNIQUE_DEFAULTS.harden)));
  assert.match(gen, /^\/\/ Generated by scripts\/build_rules\.js/);
});

// ---- page-world hardening, run against stubs ----------------------------------------------------------------------
const ALL_ON = { canvas: true, webgl: true, audio: true, hardware: true, plugins: true, webrtc: true, gpc_api: true, referrer: true };

function stubWindow(o = {}) {
  const doc = { createElement: () => new Canvas(), listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; }, querySelector: () => o.meta || null };
  class Ctx2D {
    constructor(c) { this.c = c; }
    drawImage(src) { this.c._data = Uint8ClampedArray.from(src._data || new Uint8ClampedArray(src.width * src.height * 4).fill(128)); }
    getImageData(x, y, w, h) { return { width: w, height: h, data: Uint8ClampedArray.from(this.c._data || new Uint8ClampedArray(w * h * 4).fill(128)) }; }
    putImageData(img) { this.c._data = Uint8ClampedArray.from(img.data); }
  }
  class Canvas {
    constructor(w = 300, h = 150) { this.width = w; this.height = h; this.ownerDocument = doc; }
    getContext() { return this._ctx || (this._ctx = new Ctx2D(this)); }
    _url() { const d = this._data || new Uint8ClampedArray(this.width * this.height * 4).fill(128); return "data:" + d.reduce((a, b, i) => a + b * ((i % 251) + 1), 0); }
    toDataURL() { return this._url(); }
    toBlob(cb) { cb(this._url()); }
  }
  class WebGLRenderingContext { readPixels(x, y, w, h, f, t, px) { px.fill(100); } }
  class AudioBuffer { constructor() { this.arr = new Float32Array(1000); } getChannelData() { return this.arr; } }
  class AnalyserNode { getFloatFrequencyData(a) { a.fill(-100); } }
  class RTCPeerConnection {
    constructor() { this.l = {}; }
    addEventListener(t, fn) { (this.l[t] = this.l[t] || []).push(fn); }
    removeEventListener(t, fn) { this.l[t] = (this.l[t] || []).filter((x) => x !== fn); }
    emit(t, ev) { (this.l[t] || []).forEach((fn) => fn.call(this, ev)); if (t === "icecandidate" && this._on) this._on(ev); }
  }
  Object.defineProperty(RTCPeerConnection.prototype, "onicecandidate", { configurable: true, get() { return this._on; }, set(fn) { this._on = fn; } });
  const navProto = {};
  Object.defineProperty(navProto, "hardwareConcurrency", { get: () => (o.cores == null ? 12 : o.cores), configurable: true });
  Object.defineProperty(navProto, "deviceMemory", { get: () => (o.memory == null ? 8 : o.memory), configurable: true });
  const navigator = Object.create(navProto);
  const plugins = (o.plugins || ["PDF Viewer", "Chrome PDF Viewer"]).map((name) => ({ name }));
  Object.defineProperty(navProto, "plugins", { get: () => plugins, configurable: true });
  return { win: { CanvasRenderingContext2D: Ctx2D, HTMLCanvasElement: Canvas, WebGLRenderingContext, AudioBuffer, AnalyserNode, RTCPeerConnection, navigator,
    document: doc, URL, location: { href: "https://site.example/p", origin: "https://site.example" } }, Ctx2D, Canvas, doc, navProto };
}

const flipped = (data) => { let n = 0; for (const v of data) { if (v !== 128) { assert.strictEqual(v, 129); n++; } } return n; };

test("hardening: canvas reads get stable, invisible noise; small canvases are untouched", () => {
  const { win, Canvas } = stubWindow();
  const clean = new Canvas().getContext().getImageData(0, 0, 300, 150);
  assert.strictEqual(flipped(clean.data), 0);
  assert.deepStrictEqual(P.installHardening(win, { canvas: true }, 42), ["canvas"]);
  const c = new Canvas();
  const a = c.getContext().getImageData(0, 0, 300, 150), b = c.getContext().getImageData(0, 0, 300, 150);
  const n = flipped(a.data);
  assert.ok(n > 300 && n < 2500, "about 1 pixel in 64 changes: " + n);
  assert.deepStrictEqual(a.data, b.data);                                      // same read, same answer
  for (let i = 3; i < a.data.length; i += 4) assert.strictEqual(a.data[i], 128);   // alpha untouched
  assert.strictEqual(flipped(c.getContext().getImageData(0, 0, 10, 10).data), 0);   // tiny canvas
});

test("hardening: toDataURL and toBlob go through the same noise; the source canvas is not modified", () => {
  const plain = stubWindow(), hard = stubWindow();
  const before = new plain.Canvas().toDataURL();
  P.installHardening(hard.win, { canvas: true }, 7);
  const c = new hard.Canvas();
  const url = c.toDataURL();
  assert.notStrictEqual(url, before);
  assert.strictEqual(c.toDataURL(), url);                                      // stable
  let blob; c.toBlob((x) => { blob = x; });
  assert.strictEqual(blob, url);
  assert.strictEqual(c._data, undefined);                                      // the page's canvas itself is unchanged
  assert.strictEqual(new hard.Canvas(8, 8).toDataURL(), new plain.Canvas(8, 8).toDataURL());
  const other = stubWindow(); P.installHardening(other.win, { canvas: true }, 8);
  assert.notStrictEqual(new other.Canvas().toDataURL(), url);                  // a different page load gets different noise
});

test("hardening: a tainted canvas still behaves like the real call", () => {
  const { win, Ctx2D } = stubWindow();
  Ctx2D.prototype.getImageData = function () { throw new Error("SecurityError"); };
  P.installHardening(win, { canvas: true }, 1);
  const c = new win.HTMLCanvasElement(300, 150);
  assert.throws(() => c.getContext().getImageData(0, 0, 300, 150), /SecurityError/);
  assert.doesNotThrow(() => c.toDataURL());
});

test("hardening: WebGL readPixels and audio buffers", () => {
  const { win } = stubWindow();
  assert.deepStrictEqual(P.installHardening(win, { webgl: true, audio: true }, 9).sort(), ["audio", "webgl"]);
  const px = new Uint8Array(300 * 150 * 4);
  new win.WebGLRenderingContext().readPixels(0, 0, 300, 150, 0, 0, px);
  let diff = 0; for (const v of px) { if (v !== 100) { assert.strictEqual(v, 101); diff++; } }
  assert.ok(diff > 0);
  const small = new Uint8Array(40); new win.WebGLRenderingContext().readPixels(0, 0, 2, 5, 0, 0, small);
  assert.ok(small.every((v) => v === 100));
  const buf = new win.AudioBuffer();
  const a = buf.getChannelData(0), copy = Float32Array.from(a);
  const b = buf.getChannelData(0);
  assert.deepStrictEqual(Float32Array.from(b), copy);                          // noise is added once, not on every call
  const max = Math.max(...Array.from(a).map(Math.abs));
  assert.ok(max > 0 && max <= 1.1e-7, "noise stays far below audibility: " + max);
  const f = new Float32Array(64);
  new win.AnalyserNode().getFloatFrequencyData(f);
  assert.ok(f.every((v) => Math.abs(v + 100) <= 1.1e-4) && f.some((v) => v !== -100));
});

test("hardening: cores, memory and plug-ins are coarsened", () => {
  for (const [cores, expect] of [[16, 8], [12, 8], [8, 8], [6, 4], [4, 4], [3, 2], [1, 1]]) {
    const { win } = stubWindow({ cores });
    P.installHardening(win, { hardware: true }, 1);
    assert.strictEqual(win.navigator.hardwareConcurrency, expect, "cores " + cores);
  }
  const { win } = stubWindow({ memory: 8 });
  assert.deepStrictEqual(P.installHardening(win, { hardware: true }, 1), ["hardware"]);
  assert.strictEqual(win.navigator.deviceMemory, 4);
  const low = stubWindow({ memory: 1 }); P.installHardening(low.win, { hardware: true }, 1);
  assert.strictEqual(low.win.navigator.deviceMemory, 1);                        // never raised

  const std = stubWindow();
  assert.deepStrictEqual(P.installHardening(std.win, { plugins: true }, 1), []);   // the standard list is left alone
  const odd = stubWindow({ plugins: ["PDF Viewer", "Shady Toolbar", "Chrome PDF Viewer", "Internal Tool"] });
  assert.deepStrictEqual(P.installHardening(odd.win, { plugins: true }, 1), ["plugins"]);
  const view = odd.win.navigator.plugins;
  assert.strictEqual(view.length, 2);
  assert.deepStrictEqual(Array.from(view).map((p) => p.name), ["PDF Viewer", "Chrome PDF Viewer"]);
  assert.strictEqual(view.namedItem("Shady Toolbar"), null);
  assert.strictEqual(view.item(0).name, "PDF Viewer");
});

test("hardening: navigator.globalPrivacyControl is exposed unless the browser already has it", () => {
  const a = stubWindow();
  assert.deepStrictEqual(P.installHardening(a.win, { gpc_api: true }, 1), ["gpc_api"]);
  assert.strictEqual(a.win.navigator.globalPrivacyControl, true);
  const b = stubWindow(); Object.defineProperty(b.navProto, "globalPrivacyControl", { get: () => false, configurable: true });
  assert.deepStrictEqual(P.installHardening(b.win, { gpc_api: true }, 1), []);
  assert.strictEqual(b.win.navigator.globalPrivacyControl, false);
});

test("hardening: WebRTC guard drops raw private addresses and keeps everything else", () => {
  const { win } = stubWindow();
  assert.deepStrictEqual(P.installHardening(win, { webrtc: true }, 1), ["webrtc"]);
  const pc = new win.RTCPeerConnection();
  const seen = [];
  const handler = (ev) => seen.push(ev.candidate ? ev.candidate.candidate : "end");
  pc.addEventListener("icecandidate", handler);
  const cand = (s) => ({ candidate: { candidate: s } });
  pc.emit("icecandidate", cand("candidate:1 1 udp 2122260223 192.168.1.23 54321 typ host generation 0"));
  pc.emit("icecandidate", cand("candidate:2 1 udp 2122260223 10.1.2.3 54321 typ host"));
  pc.emit("icecandidate", cand("candidate:3 1 udp 1686052607 203.0.113.9 61000 typ srflx raddr 192.168.1.23 rport 54321"));
  pc.emit("icecandidate", cand("candidate:4 1 udp 2122260223 fd12:3456:789a::1 54321 typ host"));
  pc.emit("icecandidate", cand("candidate:5 1 udp 2122260223 3f0a2c1e-aaaa-bbbb-cccc-0123456789ab.local 54321 typ host"));
  pc.emit("icecandidate", cand("candidate:6 1 udp 1686052607 198.51.100.4 61000 typ srflx"));
  pc.emit("icecandidate", { candidate: null });
  assert.deepStrictEqual(seen.map((s) => s.split(" ")[0]), ["candidate:5", "candidate:6", "end"]);   // the srflx line that names a LAN raddr is dropped too
  // removeEventListener still works with the original function
  pc.removeEventListener("icecandidate", handler);
  pc.emit("icecandidate", cand("candidate:7 1 udp 1 198.51.100.4 1 typ srflx"));
  assert.strictEqual(seen.length, 3);
  // the onicecandidate property is filtered as well, and reads back what the page set
  const pc2 = new win.RTCPeerConnection();
  const got = [];
  const on = (ev) => got.push(ev.candidate.candidate);
  pc2.onicecandidate = on;
  assert.strictEqual(pc2.onicecandidate, on);
  pc2.emit("icecandidate", cand("candidate:8 1 udp 1 172.20.0.5 1 typ host"));
  pc2.emit("icecandidate", cand("candidate:9 1 udp 1 198.51.100.4 1 typ srflx"));
  assert.deepStrictEqual(got, ["candidate:9 1 udp 1 198.51.100.4 1 typ srflx"]);
});

test("hardening: leaky referrer policies are tightened for links that leave the site", () => {
  const click = (stub, href, attrs = {}) => {
    const a = { href, attrs: { ...attrs }, hasAttribute(n) { return n in this.attrs; }, setAttribute(n, v) { this.attrs[n] = v; } };
    stub.doc.listeners.click({ target: { closest: () => a } });
    return a;
  };
  const leaky = { getAttribute: () => "unsafe-url" };
  const s = stubWindow({ meta: leaky });
  assert.deepStrictEqual(P.installHardening(s.win, { referrer: true }, 1), ["referrer"]);
  assert.strictEqual(click(s, "https://other.example/x").attrs.referrerpolicy, "strict-origin-when-cross-origin");
  assert.strictEqual(click(s, "https://site.example/inside").attrs.referrerpolicy, undefined);                 // same site: untouched
  assert.strictEqual(click(s, "https://other.example/x", { referrerpolicy: "no-referrer" }).attrs.referrerpolicy, "no-referrer");   // never overrides the page's own choice
  const calm = stubWindow({ meta: { getAttribute: () => "same-origin" } });
  P.installHardening(calm.win, { referrer: true }, 1);
  assert.strictEqual(click(calm, "https://other.example/x").attrs.referrerpolicy, undefined);                   // a stricter policy stays
  const none = stubWindow();
  P.installHardening(none.win, { referrer: true }, 1);
  assert.strictEqual(click(none, "https://other.example/x").attrs.referrerpolicy, undefined);
});

test("hardening: every technique is off unless asked for, and missing APIs never throw", () => {
  const { win } = stubWindow();
  const before = win.navigator.hardwareConcurrency;
  assert.deepStrictEqual(P.installHardening(win, {}, 1), []);
  assert.deepStrictEqual(P.installHardening(stubWindow().win, undefined, 1), []);
  assert.strictEqual(win.navigator.hardwareConcurrency, before);
  assert.deepStrictEqual(P.installHardening({}, ALL_ON, 1), []);
  assert.deepStrictEqual(P.installHardening({ navigator: {}, document: {} }, ALL_ON, 1), []);
  assert.deepStrictEqual(P.installHardening(null, ALL_ON, 1), []);
  const twice = stubWindow();
  assert.ok(P.installHardening(twice.win, ALL_ON, 1).length >= 5);
  assert.deepStrictEqual(P.installHardening(twice.win, ALL_ON, 1), []);         // a second injection does nothing
});

test("hardeningSource is the same code as text and runs on its own", () => {
  const src = P.hardeningSource({ hardware: true, canvas: false }, 123);
  assert.ok(!/require\(|module\./.test(src));
  const { win } = stubWindow();
  const sandbox = vm.createContext(Object.assign(win, { self: win }));
  vm.runInContext(src, sandbox);
  assert.strictEqual(win.navigator.hardwareConcurrency, 8);
  assert.strictEqual(new win.HTMLCanvasElement().toDataURL(), new (stubWindow().Canvas)().toDataURL());   // canvas switched off in this copy
  const random = P.hardeningSource({ canvas: true });
  assert.match(random, /crypto\.getRandomValues/);
  const s2 = stubWindow();
  const ctx2 = vm.createContext(Object.assign(s2.win, { self: s2.win, crypto: { getRandomValues: (a) => { a[0] = 99; return a; } } }));
  vm.runInContext(random, ctx2);
  assert.notStrictEqual(new s2.win.HTMLCanvasElement().toDataURL(), new (stubWindow().Canvas)().toDataURL());
  // the shipped file is this code too
  const shipped = fs.readFileSync(ext("harden-main.js"), "utf8");
  const s3 = stubWindow({ cores: 16 });
  const ctx3 = vm.createContext(Object.assign(s3.win, { self: s3.win, crypto: { getRandomValues: (a) => { a[0] = 5; return a; } } }));
  vm.runInContext(shipped, ctx3);
  assert.strictEqual(s3.win.navigator.hardwareConcurrency, 8);
});
