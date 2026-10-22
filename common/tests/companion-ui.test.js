const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const UI = require("../companion-ui.js");
const C = require("../companion.js");

const root = path.resolve(__dirname, "..", "..");

test("every face the UI can ask for has a picture for both buddies, in every place the pictures are copied to", () => {
  const names = [...Object.values(UI.FACE_FOR), "blink", "look"];
  for (const dir of ["extension/companion", "dashboard/img"]) {
    for (const who of ["family", "adult"]) {
      for (const n of names) assert.ok(fs.existsSync(path.join(root, dir, `face-${who}-${n}.png`)), `${dir}/face-${who}-${n}.png`);
      for (const f of [`robot-${who}.png`, `robot-${who}-sm.png`, `orb-${who}.png`, `orb-${who}-sm.png`]) assert.ok(fs.existsSync(path.join(root, dir, f)), `${dir}/${f}`);
    }
    assert.ok(fs.existsSync(path.join(root, dir, "faces.json")), `${dir}/faces.json`);
  }
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
