const test = require("node:test");
const assert = require("node:assert");
const Ring = require("../js/ring.js");

const keys = (layers) => layers.filter((l) => l.on).map((l) => l.key);

test("defaults: every layer is on once a browser is connected", () => {
  assert.deepStrictEqual(keys(Ring.layersFor({}, true)), ["safe", "trackers", "data", "passwords"]);
  const p = Ring.posture(Ring.layersFor({}, true), true);
  assert.deepStrictEqual([p.on, p.total, p.level, p.label], [4, 4, "full", "Fully protected"]);
});

test("nothing is lit until a browser is connected", () => {
  const layers = Ring.layersFor({}, false);
  assert.deepStrictEqual(keys(layers), []);
  assert.ok(layers.every((l) => l.enabled));                       // the settings still say what WOULD be on
  assert.strictEqual(Ring.posture(layers, false).label, "Not connected");
});

test("switching a layer off in settings dims exactly that layer", () => {
  const s = { sensitive_data: { warn: false }, passwords: { breach_check: false, reuse_check: false } };
  assert.deepStrictEqual(keys(Ring.layersFor(s, true)), ["safe", "trackers"]);
  assert.strictEqual(Ring.posture(Ring.layersFor(s, true), true).label, "Partly protected");
});

test("the trackers layer stays on while any one tracker protection is on", () => {
  const off = { privacy: { block_trackers: false, block_fingerprinting: false, strip_tracking_params: false } };
  assert.ok(!keys(Ring.layersFor(off, true)).includes("trackers"));
  for (const k of ["block_trackers", "block_fingerprinting", "strip_tracking_params"]) {
    assert.ok(keys(Ring.layersFor({ privacy: { ...off.privacy, [k]: true } }, true)).includes("trackers"), k);
  }
});

test("reuse detection alone keeps the password layer on", () => {
  const s = { passwords: { breach_check: false, reuse_check: true } };
  assert.ok(keys(Ring.layersFor(s, true)).includes("passwords"));
});

test("arc paths are valid and sweep the right way", () => {
  const d = Ring.arcPath(100, 100, 80, -90, 0);
  assert.match(d, /^M 100\.00 20\.00 A 80 80 0 0 1 180\.00 100\.00$/);
  assert.match(Ring.arcPath(100, 100, 80, -90, 120), / 0 1 1 /);   // more than half a circle uses the large-arc flag
});
