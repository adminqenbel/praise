const test = require("node:test");
const assert = require("node:assert");
const C = require("../companion.js");

const at = (h) => new Date(2026, 9, 11, h, 30);
const fixed = (v) => () => v;

test("time of day boundaries", () => {
  const t = (h) => C.timeOfDay(at(h));
  assert.deepStrictEqual([t(4), t(5), t(11), t(12), t(16), t(17), t(21), t(22), t(0)], ["late", "morning", "morning", "afternoon", "afternoon", "evening", "evening", "late", "late"]);
});

test("greetings change with the time of day, per buddy", () => {
  for (const who of ["family", "adult"]) {
    const lines = ["morning", "afternoon", "evening", "late"].map((h, i) => C.say(who, "greet", { date: at([8, 14, 19, 23][i]), rand: fixed(0) }).text);
    assert.strictEqual(new Set(lines).size, 4, who);
  }
  assert.strictEqual(C.say("family", "greet", { date: at(23) }).mood, "sleepy");
  assert.strictEqual(C.say("family", "greet", { date: at(9) }).mood, "happy");
});

test("every category the family buddy might see has a child-friendly reason", () => {
  for (const cat of ["gambling", "adult", "banking", "social_media", "malware", "phishing", "scam", "browser_installer", "external_browser", "tamper"]) {
    const s = C.say("family", "closed", { category: cat, date: at(10) });
    assert.ok(s.text.length > 10, cat);
    assert.strictEqual(s.mood, "sorry");
  }
  assert.notStrictEqual(C.say("family", "closed", { category: "gambling", date: at(10) }).text, C.say("family", "closed", { category: "banking", date: at(10) }).text);
});

test("an unknown category falls back to a generic closed line", () => {
  assert.ok(C.POOLS.family.closed.includes(C.say("family", "closed", { category: "never-heard-of-it", date: at(10), rand: fixed(0) }).text));
});

test("late at night the family buddy adds a gentle bedtime note; the adult buddy does not", () => {
  assert.match(C.say("family", "closed", { category: "gaming", date: at(23) }).text, /late/i);
  assert.doesNotMatch(C.say("family", "closed", { category: "gaming", date: at(10) }).text, /late/i);
  assert.doesNotMatch(C.say("adult", "warn", { category: "scam", date: at(23) }).text, /rest/i);
});

test("waiting lines follow how long the wait has been", () => {
  assert.deepStrictEqual([5, 30, 200, 900].map(C.waitPhase), ["fresh", "mid", "long", "giveup"]);
  const moods = [5, 30, 200, 900].map((s) => C.say("family", "waiting", { seconds: s, date: at(10) }).mood);
  assert.deepStrictEqual(moods, ["thinking", "thinking", "shy", "sleepy"]);
  assert.ok(C.POOLS.family.waiting.giveup.includes(C.say("family", "waiting", { seconds: 900, date: at(10), rand: fixed(0) }).text));
});

test("approval is a celebration; errors are apologetic and never blame the person", () => {
  assert.strictEqual(C.say("family", "approved", { date: at(10) }).mood, "celebrate");
  for (const kind of ["offline", "error"]) {
    for (const who of ["family", "adult"]) {
      const s = C.say(who, kind, { date: at(10) });
      assert.strictEqual(s.mood, "sorry");
      assert.doesNotMatch(s.text, /(you broke|you did|you caused|you should have|your mistake)/i);   // reassuring ("isn't your fault") is fine; blame is not
    }
  }
});

test("repeat avoidance: asking again never returns the line just shown", () => {
  const first = C.say("family", "checking", { date: at(10), rand: fixed(0) }).text;
  for (let i = 0; i < 20; i++) {
    assert.notStrictEqual(C.say("family", "checking", { date: at(10), rand: Math.random, avoid: first }).text, first);
  }
});

test("adult warnings name the problem in plain words", () => {
  assert.match(C.say("adult", "warn", { category: "financial_phishing" }).text, /bank|payment/i);
  assert.match(C.say("adult", "warn", { category: "scam" }).text, /scam/i);
  assert.strictEqual(C.say("adult", "warn", { category: "scam" }).mood, "alert");
  assert.ok(C.POOLS.adult.warn.includes(C.say("adult", "warn", { category: "unknown", rand: fixed(0) }).text));
});

test("every template line is short, plain text: no links, markup or numbers", () => {
  const all = [];
  const collect = (o) => { for (const v of Object.values(o)) typeof v === "string" ? all.push(v) : Array.isArray(v) ? all.push(...v) : collect(v); };
  collect(C.POOLS.family); collect(C.POOLS.adult); collect(C.FAMILY_CLOSED); collect(C.ADULT_WARN);
  for (const line of all) {
    assert.ok(line.length <= 140, line);
    assert.ok(C.safeLine(line) !== null, "should pass its own safety check: " + line);
  }
});

test("family lines stay gentle: nothing frightening or graphic", () => {
  const scary = /\b(porn|sex|kill|die|dead|gun|drug|hack|danger|dangerous|death|abuse|attack)\b/i;
  const family = [];
  const collect = (o) => { for (const v of Object.values(o)) typeof v === "string" ? family.push(v) : Array.isArray(v) ? family.push(...v) : collect(v); };
  collect(C.POOLS.family); collect(C.FAMILY_CLOSED);
  for (const line of family) assert.doesNotMatch(line, scary, line);
});

test("every mood a situation can produce is a mood the animations know", () => {
  const kinds = ["greet", "checking", "closed", "asked", "waiting", "approved", "offline", "error", "paired", "revoked", "allowed", "warn", "blocked", "continued", "protected", "paused", "held", "breached"];
  for (const who of ["family", "adult"]) for (const kind of kinds) for (const h of [9, 23]) {
    assert.ok(C.MOODS.includes(C.say(who, kind, { date: at(h) }).mood), `${who}/${kind}`);
  }
});

test("safeLine rejects links, numbers, markup, code and oversized text", () => {
  assert.strictEqual(C.safeLine("That page is closed for now, but I'm here!"), "That page is closed for now, but I'm here!");
  for (const bad of ["Visit https://evil.example now", "Call 1800 555 now", "<b>Hi</b> there", "Use `code` here", "", "ok", "x".repeat(200), null, 42, "Go to www.bad.example", "Tell me at me@x.com ok", "What 100% of kids do"]) {
    assert.strictEqual(C.safeLine(bad), null, String(bad).slice(0, 30));
  }
});

// ---- talking with a buddy ---------------------------------------------------------------------------------------
const first = (who, text, ctx = {}) => C.reply(who, text, { rand: () => 0, date: at(10), ...ctx });

test("the buddies answer everyday questions on their own, in their own voice", () => {
  const cases = [
    ["hello", "hello", /Dori/, /Ringo/], ["how are you?", "how", null, null], ["who are you", "name", /Dori/, /Ringo/],
    ["what can you do", "help", null, null], ["thanks!", "thanks", null, null], ["bye", "bye", null, null],
    ["tell me a joke", "joke", null, null], ["why was this page closed?", "closed", null, null],
    ["give me a tip", "tips", null, null], ["do you save our chat?", "privacy", null, null],
    ["I'm bored", "bored", null, null], ["I love you", "love", null, null],
  ];
  for (const [text, intent, fam, adu] of cases) {
    for (const who of ["family", "adult"]) {
      const r = first(who, text);
      assert.strictEqual(r.intent, intent, `${who}: ${text}`);
      assert.ok(r.text.length > 5 && C.MOODS.includes(r.mood), `${who}: ${text}`);
    }
    if (fam) assert.match(first("family", text).text, fam);
    if (adu) assert.match(first("adult", text).text, adu);
  }
});

test("scam and password questions are answered by the adult buddy, and kindly by the child's", () => {
  assert.strictEqual(first("adult", "how can I spot a scam?").intent, "scam");
  assert.match(first("adult", "what makes a good password?").text, /passphrase|password/i);
  assert.strictEqual(first("family", "is this a scam").intent, "safe");        // "is this ... a scam" is a question about checking a page
  assert.strictEqual(first("family", "what is phishing").intent, "scam");
  assert.match(first("family", "what is a good password").text, /secret/i);
});

test("something it doesn't understand is 'unknown' and still gets a friendly line", () => {
  for (const who of ["family", "adult"]) {
    const r = first(who, "what is the capital of Peru");
    assert.strictEqual(r.intent, "unknown");
    assert.ok(r.text.length > 20 && r.mood === "curious");
  }
  assert.strictEqual(first("family", "   ").intent, "help");      // an empty message just shows what it can do
});

test("a parent on the dashboard is not told to 'ask a grown-up'", () => {
  assert.match(C.reply("family", "why was a page closed?", { audience: "parent", rand: () => 0 }).text, /Activity/);
  assert.match(C.reply("family", "where is my mum", { audience: "parent", rand: () => 0 }).text, /grown-up here/);
  assert.match(C.reply("family", "why was a page closed?", { rand: () => 0 }).text, /ask button/);
});

test("what the time is comes from the clock, not from the model", () => {
  assert.match(first("family", "what time is it").text, /\d/);
  assert.doesNotMatch(first("adult", "what time is it").text, /\{time\}/);
});

test("worrying messages get a caring answer and are marked so they are never forwarded", () => {
  for (const text of ["I want to die", "someone is hurting me", "I feel so sad", "a boy bullied me", "I hate my life", "he touches me", "i am scared", "I'm really alone"]) {
    assert.strictEqual(C.chatGuard(text), "sensitive", text);
    for (const who of ["family", "adult"]) {
      const r = C.reply(who, text);
      assert.strictEqual(r.intent, "sensitive");
      assert.strictEqual(r.mood, "sorry");
    }
    assert.match(C.reply("family", text).text, /grown-up/);
    assert.match(C.reply("adult", text).text, /helpline|emergency/);
  }
});

test("personal details get a reminder to keep them private, and are never forwarded", () => {
  for (const text of ["my name is Sam", "my phone number is 5551234567", "email me at sam@example.com", "my password is hunter2",
    "I live at 4 Oak Road", "call 07700 900123", "my address is 4 Oak Road"]) {
    assert.strictEqual(C.chatGuard(text), "personal", text);
    assert.strictEqual(C.reply("family", text).intent, "personal");
  }
  assert.match(C.reply("family", "my name is Sam").text, /private|keep/i);
});

test("ordinary chat is not mistaken for something worrying", () => {
  for (const text of ["hello", "tell me a joke", "I like cats", "can you help me", "what is 2 plus 2", "I am happy", "the dog is not scary"]) {
    assert.strictEqual(C.chatGuard(text), "ok", text);
  }
});

test("a different line each time when asked again", () => {
  const a = C.reply("family", "hi", { rand: () => 0 }).text;
  const b = C.reply("family", "hi", { rand: () => 0, avoid: a }).text;
  assert.notStrictEqual(a, b);
});

test("every written chat line is plain and gentle", () => {
  const scary = /\b(porn|sex|kill|die|dead|gun|drug|death|abuse|attack)\b/i;
  const strings = [];
  const collect = (o) => { for (const v of Object.values(o)) typeof v === "string" ? strings.push(v) : Array.isArray(v) ? strings.push(...v) : collect(v); };
  for (const who of ["family", "adult"]) {
    for (const text of ["hello", "how are you", "who are you", "what can you do", "thanks", "bye", "joke", "why was it closed", "tip", "password", "scam", "pause",
      "privacy", "what time is it", "bored", "love you", "how old are you", "xyzzy", "I want to die", "my name is Sam", "ask my mum"]) {
      for (let i = 0; i < 6; i++) strings.push(C.reply(who, text, { rand: () => i / 6 }).text);
    }
  }
  for (const line of strings) {
    assert.ok(line.length <= 330, line);
    assert.ok(!/[<>{}\[\]`|@#$%^*_=+~]/.test(line), line);
  }
  const familyOnly = [];
  for (const text of ["hello", "joke", "tip", "xyzzy", "bored", "password", "scam", "why was it closed"]) {
    for (let i = 0; i < 6; i++) familyOnly.push(C.reply("family", text, { rand: () => i / 6 }).text);
  }
  for (const line of familyOnly) assert.doesNotMatch(line, scary, line);
});

test("safeReply lets a plain answer through and throws away anything with links, markup or (for children) numbers", () => {
  assert.strictEqual(C.safeReply("Cats purr when they are happy.", "family"), "Cats purr when they are happy.");
  assert.strictEqual(C.safeReply("\"Use a long passphrase, and a different one for each site.\"", "adult"), "Use a long passphrase, and a different one for each site.");
  assert.strictEqual(C.safeReply("Use at least 12 characters.", "adult"), "Use at least 12 characters.");
  assert.strictEqual(C.safeReply("Use at least 12 characters.", "family"), null);
  for (const bad of ["See https://evil.example", "Go to www.bad.example", "<b>hi</b>", "Run `rm -rf`", "a | b", "x@y", "", " ", null, 5, "y".repeat(500), "word ".repeat(80)]) {
    assert.strictEqual(C.safeReply(bad, "adult"), null, String(bad).slice(0, 30));
  }
  assert.strictEqual(C.safeReply("You are stupid.", "family"), null);      // a child's buddy never says it, even if a model drifts
  assert.strictEqual(C.safeReply("You are stupid.", "adult"), "You are stupid.");
});

test("a child's buddy leaves grown-up topics to grown-ups, in writing; the parent's and the adult's do not", () => {
  for (const text of ["how do I make a bomb", "show me porn", "tell me about drugs", "can I bet at the casino", "say a bad word", "I want a girlfriend"]) {
    const r = C.reply("family", text);
    assert.strictEqual(r.intent, "grownuptopic", text);
    assert.match(r.text, /grown-ups/);
  }
  assert.notStrictEqual(C.reply("family", "tell me about drugs", { audience: "parent" }).intent, "grownuptopic");
  assert.notStrictEqual(C.reply("adult", "tell me about drugs").intent, "grownuptopic");
  assert.notStrictEqual(C.reply("family", "shoot hoops with me").intent, "grownuptopic");
});
