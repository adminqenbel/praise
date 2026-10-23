const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const UI = require("../companion-ui.js");
const C = require("../companion.js");

const root = path.resolve(__dirname, "..", "..");

test("every face the UI can ask for has a drawing, and every drawing is made only of shapes the buddy's screen can show", () => {
  const names = [...Object.values(UI.FACE_FOR), "happy", "blink", "look"];
  const shapes = new Set(["rect", "path", "ellipse", "circle"]);
  for (const n of names) {
    assert.ok(Array.isArray(UI.FACES[n]) && UI.FACES[n].length >= 2, `a drawing for ${n}`);
    for (const [tag, attrs] of UI.FACES[n]) {
      assert.ok(shapes.has(tag), `${n}: ${tag}`);
      assert.ok(Object.values(attrs).every((v) => typeof v === "string" || typeof v === "number"), `${n}: attributes`);
    }
  }
});

test("no picture files are shipped for the buddy: it is drawn inline, so a page's content rules can't block it", () => {
  for (const dir of ["extension/companion", "dashboard/img"]) assert.ok(!fs.existsSync(path.join(root, dir)), `${dir} is gone`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
  const exposed = manifest.web_accessible_resources.flatMap((r) => r.resources);
  assert.deepStrictEqual(exposed.sort(), ["block/block.html", "warn/warn.html"]);
});

test("every mood the voice engine can pick is one the UI knows how to show", () => {
  const known = new Set([...Object.keys(UI.FACE_FOR), "happy", "nod", "celebrate"]);
  for (const m of C.MOODS) assert.ok(known.has(m), m);
});

test("the shared files are identical in every place they are copied to", () => {
  const same = (a, b) => assert.strictEqual(fs.readFileSync(path.join(root, a), "utf8"), fs.readFileSync(path.join(root, b), "utf8"), b);
  for (const t of ["extension"]) for (const f of ["companion.js", "companion-ui.js", "chat-ui.js", "companion.css"]) same(`common/${f}`, `${t}/${f}`);
  same("common/companion.js", "dashboard/js/companion.js");
  same("common/companion-ui.js", "dashboard/js/companion-ui.js");
  same("common/chat-ui.js", "dashboard/js/chat-ui.js");
  same("common/companion.css", "dashboard/css/companion.css");
});
