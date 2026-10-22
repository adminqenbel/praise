const test = require("node:test");
const assert = require("node:assert");

// A very small stand-in for the DOM: just what the chat panel touches.
let focused = null;
class El {
  constructor(tag) {
    Object.assign(this, { tag, children: [], attrs: {}, listeners: {}, className: "", hidden: false, _text: "", value: "", dataset: {}, disabled: false, scrollTop: 0, scrollHeight: 0, parent: null });
  }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  get firstChild() { return this.children[0]; }
  set textContent(t) { this._text = String(t); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  focus() { focused = this; }
  fire(t, ev = {}) { for (const fn of this.listeners[t] || []) fn({ preventDefault() {}, stopPropagation() {}, isTrusted: true, ...ev }); }
  all(cls) { return [...this.children.flatMap((c) => c.all(cls)), ...(this.className.split(" ").includes(cls) ? [this] : [])]; }
}
global.document = { createElement: (t) => new El(t) };

const Chat = require("../chat-ui.js");

const mount = (opts = {}) => {
  const host = new El("div");
  const moods = [];
  const chat = Chat.mount(host, { who: "family", beat: 0, onMood: (m) => moods.push(m), ...opts });
  const said = () => chat.el.all("chat-msg").map((m) => m.textContent).filter(Boolean);
  return { host, chat, moods, said };
};

test("opening the chat shows an introduction once, and tells the host", () => {
  let opened = 0, closed = 0;
  const { chat, said } = mount({ onOpen: () => opened++, onClose: () => closed++ });
  assert.strictEqual(chat.isOpen, false);
  chat.open(); chat.close(); chat.open();
  assert.strictEqual(said().length, 1);
  assert.match(said()[0], /Dori/);
  assert.deepStrictEqual([opened, closed, chat.isOpen], [2, 1, true]);
  assert.strictEqual(chat.el.attrs["aria-label"], "Chat with Dori");
});

test("the adult buddy introduces itself as Ringo and offers its own suggestions", () => {
  const { chat, said } = mount({ who: "adult" });
  chat.open();
  assert.match(said()[0], /Ringo/);
  assert.ok(chat.el.all("chat-chip").some((c) => /scam/i.test(c.textContent)));
});

test("everyday questions are answered by the buddy itself and nothing is sent anywhere", async () => {
  let asked = 0;
  const { chat, said, moods } = mount({ remote: async () => { asked++; return "from the model"; } });
  chat.open();
  const out = await chat.send("tell me a joke");
  assert.strictEqual(out.intent, "joke");
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual(said().slice(1, 2), ["tell me a joke"]);
  assert.strictEqual(said().length, 3);
  assert.deepStrictEqual(moods.slice(0, 2), ["happy", "thinking"]);
  assert.strictEqual(moods[moods.length - 1], "celebrate");
});

test("a question the buddy doesn't know goes to the model, with the recent conversation", async () => {
  const calls = [];
  const { chat, said } = mount({ remote: async (text, history) => { calls.push([text, history]); return "Lima is the capital of Peru."; } });
  chat.open();
  await chat.send("hello");
  const out = await chat.send("what is the capital of Peru");
  assert.strictEqual(out.intent, "model");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], "what is the capital of Peru");
  assert.deepStrictEqual(calls[0][1].map((t) => t.role), ["user", "assistant"]);       // the question itself is not repeated in the history
  assert.strictEqual(said().pop(), "Lima is the capital of Peru.");
});

test("worrying messages and personal details never reach the model", async () => {
  let asked = 0;
  const { chat, said } = mount({ remote: async () => { asked++; return "x"; } });
  chat.open();
  for (const text of ["I want to die", "my name is Sam", "my phone is 5551234567"]) await chat.send(text);
  assert.strictEqual(asked, 0);
  assert.match(said()[2], /grown-up/);
});

test("a model answer with a link, markup or a number (for a child) is replaced by the buddy's own words", async () => {
  for (const bad of ["Go to https://evil.example now", "<b>hello</b>", "It is 5551234.", "", null, 42]) {
    const { chat } = mount({ remote: async () => bad });
    chat.open();
    const out = await chat.send("what is the capital of Peru");
    assert.strictEqual(out.intent, "unknown", String(bad));
  }
});

test("a model that fails or takes too long is replaced by the buddy's own words", async () => {
  const broken = mount({ remote: async () => { throw new Error("offline"); } });
  broken.chat.open();
  assert.strictEqual((await broken.chat.send("what is the capital of Peru")).intent, "unknown");
  const slow = mount({ remoteMs: 20, remote: () => new Promise(() => {}) });
  slow.chat.open();
  assert.strictEqual((await slow.chat.send("what is the capital of Peru")).intent, "unknown");
});

test("only one message at a time, and long or empty messages are handled", async () => {
  const { chat, said } = mount({ remote: async () => "ok then" });
  chat.open();
  const first = chat.send("what is the capital of Peru");
  assert.strictEqual(await chat.send("second"), null);          // still answering the first
  await first;
  assert.strictEqual(await chat.send("   "), null);
  await chat.send("x".repeat(1000));
  assert.ok(said().some((m) => m.length === Chat.MAX_LEN));
  assert.ok(chat.history.every((t) => t.content.length <= Chat.MAX_LEN));
});

test("closing and destroying: the panel hides, and nothing is kept", async () => {
  const { host, chat } = mount();
  chat.open();
  await chat.send("hello");
  assert.strictEqual(chat.history.length, 2);
  chat.close();
  assert.strictEqual(chat.el.hidden, true);
  chat.destroy();
  assert.strictEqual(chat.history.length, 0);
  assert.strictEqual(host.children.length, 0);
  assert.strictEqual(await chat.send("hello again"), null);
});

test("what the buddy says is set as text, never as markup", async () => {
  const { chat } = mount({ remote: async () => "Hello there." });
  chat.open();
  await chat.send("<img src=x onerror=alert(1)>");
  const mine = chat.el.all("chat-msg").find((m) => m.className.includes("me"));
  assert.strictEqual(mine.textContent, "<img src=x onerror=alert(1)>");
  assert.strictEqual(mine.children.length, 0);
});
