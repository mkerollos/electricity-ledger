// node test/nmi.test.mjs
import { readFileSync } from "node:fs";
import { nmiChecksum, parseNmi } from "../web/lib/nmi.mjs";

let fail = 0;
const ok = (cond, label) => {
  if (cond) console.log(`ok   ${label}`);
  else { console.error(`FAIL ${label}`); fail++; }
};

// 1. checksum against AEMO's published vectors
const fixtures = JSON.parse(readFileSync(new URL("./nmi_checksum_fixtures.json", import.meta.url)));
let bad = 0;
for (const f of fixtures) {
  if (nmiChecksum(f.nmi) !== f.checksum) {
    console.error(`   checksum ${f.nmi}: got ${nmiChecksum(f.nmi)}, want ${f.checksum}`);
    bad++;
  }
}
ok(bad === 0, `checksum matches all ${fixtures.length} AEMO fixtures`);

// 2. network resolution
const cases = [
  ["41026905506", "ausgrid", "NSW"],   // the bill this project started from
  ["4102690550", "ausgrid", "NSW"],    // same, without checksum digit
  ["4310000000", "endeavour", "NSW"],
  ["4001000000", "essential", "NSW"],
  ["NCCC000001", "ausgrid", "NSW"],
  ["3100000000", "energex", "QLD"],
  ["2001985732", "sapn", "SA"],
  ["6102000000", "citipower", "VIC"],
  ["7001000000", "evoenergy", "ACT"],
];
for (const [input, key, region] of cases) {
  const r = parseNmi(input);
  ok(r.ok && r.network?.key === key && r.region === region,
     `${input} -> ${key}/${region}` + (r.ok ? "" : ` (got error: ${r.error})`));
}

// 3. rejections
const rejects = [
  ["8001000000", /National Electricity Market/, "WA NMI rejected with explanation"],
  ["123", /10 digits/, "too short rejected"],
  ["41026905506789", /10 digits/, "too long rejected"],
  ["41O2690550", /digits and letters/, "letter O rejected"],
  ["", /Enter your NMI/, "empty rejected"],
];
for (const [input, pattern, label] of rejects) {
  const r = parseNmi(input);
  ok(!r.ok && pattern.test(r.error), label);
}

// 4. checksum warning surfaces but doesn't block
const wrong = parseNmi("41026905501");
ok(wrong.ok && wrong.checksumValid === false && /checksum/.test(wrong.warning),
   "wrong checksum warns but still resolves");
const right = parseNmi("41026905506");
ok(right.checksumValid === true, "correct checksum validates");

console.log(fail === 0 ? "\nnmi: all passed" : `\nnmi: ${fail} FAILED`);
process.exit(fail ? 1 : 0);
