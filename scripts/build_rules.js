// Writes the declarativeNetRequest rule files for the personal (Shield) side of Praise from common/protections.js.
// Run after editing the tracker lists:  node scripts/build_rules.js
const fs = require("fs");
const path = require("path");
const P = require("../common/protections.js");

const out = path.join(__dirname, "..", "extension", "rules");
fs.mkdirSync(out, { recursive: true });
// One JSON file per ruleset (trackers, fingerprint). Chrome loads these as static network-blocking rules.
const sets = P.buildRulesets();
for (const [name, rules] of Object.entries(sets)) {
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(rules, null, 1) + "\n");
  console.log(`wrote extension/rules/${name}.json (${rules[0].condition.requestDomains.length} domains)`);
}
