// node test/usage.test.mjs
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNem12, looksLikeNem12 } from "../web/lib/nem12.mjs";
import { parseUsage, detectColumns } from "../web/lib/usage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log(`ok   ${label}`);
  else { console.error(`FAIL ${label}${extra ? " — " + extra : ""}`); fail++; }
};

// --- NEM12: single channel, hand-summed from the fixture -------------------
{
  const text = readFileSync(join(ROOT, "test/fixtures/nem12/sample8.csv"), "utf8");
  ok(looksLikeNem12(text), "sample8 detected as NEM12");
  const p = parseNem12(text);
  ok(p.nmi === "NEM1208142", "NMI read from 200 record", p.nmi);
  ok(p.suffixes.join() === "E1", "single E1 channel", p.suffixes.join());
  ok(p.dayCount === 2, "two days of 300 records", String(p.dayCount));

  // Independently total the first 300 row from the raw text.
  const row = text.split("\n").find((l) => l.startsWith("300,20050401"));
  const handTotal = row.split(",").slice(2, 50).reduce((a, v) => a + Number(v), 0);
  const parsedTotal = [...p.channels.get("E1").get("2005-04-01")].reduce((a, b) => a + b, 0);
  ok(Math.abs(handTotal - parsedTotal) < 1e-6, "day total matches hand sum",
     `${parsedTotal} vs ${handTotal}`);
}

// --- NEM12: multi-channel, must keep B1 separate and drop reactive ---------
{
  const text = readFileSync(join(ROOT, "test/fixtures/nem12/sample2.csv"), "utf8");
  const p = parseNem12(text);
  ok(p.suffixes.includes("E1") && p.suffixes.includes("B1"),
     "import and export channels both found", p.suffixes.join());
  ok(!p.suffixes.includes("K1") && !p.suffixes.includes("Q1"),
     "reactive power channels ignored", p.suffixes.join());

  const u = parseUsage(text, { region: "NSW" });
  ok(u.meta.format === "NEM12", "parseUsage routes to NEM12");
  ok(u.meta.totalImport > 0 && u.meta.totalExport >= 0,
     "import/export separated", `imp ${u.meta.totalImport.toFixed(0)} exp ${u.meta.totalExport.toFixed(0)}`);
  ok(u.importKwh.length === 365 * 48, "padded to a full year of half-hours",
     String(u.importKwh.length));
  ok(u.meta.warnings.some((w) => /coverage/i.test(w)),
     "warns that a 2-day file doesn't cover the year");
}

// --- interval folding: 15-minute data must halve into 30-minute slots ------
{
  const vals = Array.from({ length: 96 }, () => "1.0").join(",");
  const text = [
    "100,NEM12,200505121650,X,Y",
    "200,NMI123,E1,E1,E1,N1,1,KWH,15,",
    `300,20250401,${vals},A,,,20250402014306,`,
    "900",
  ].join("\n");
  const p = parseNem12(text);
  const day = p.channels.get("E1").get("2025-04-01");
  ok(day.length === 48 && day[0] === 2 && day[47] === 2,
     "15-min intervals folded to 48 half-hours of 2.0", `${day[0]}, ${day[47]}`);
}

// --- unit conversion: Wh must become kWh ----------------------------------
{
  const vals = Array.from({ length: 48 }, () => "1000").join(",");
  const text = [
    "100,NEM12,200505121650,X,Y",
    "200,NMI123,E1,E1,E1,N1,1,WH,30,",
    `300,20250401,${vals},A,,,20250402014306,`,
    "900",
  ].join("\n");
  const day = parseNem12(text).channels.get("E1").get("2025-04-01");
  ok(Math.abs(day[0] - 1) < 1e-9, "1000 Wh read as 1 kWh", String(day[0]));
}

// --- controlled load kept separate but folded into import for pricing -----
{
  const v = (x) => Array.from({ length: 48 }, () => x).join(",");
  const text = [
    "100,NEM12,200505121650,X,Y",
    "200,NMI123,E1E2,E1,E1,N1,1,KWH,30,",
    `300,20250401,${v("1")},A,,,20250402014306,`,
    "200,NMI123,E1E2,E2,E2,N1,1,KWH,30,",
    `300,20250401,${v("0.5")},A,,,20250402014306,`,
    "900",
  ].join("\n");
  const u = parseUsage(text, { region: "NSW" });
  ok(u.meta.hasControlledLoad, "controlled load flagged");
  ok(Math.abs(u.meta.totalControlled - 24) < 1e-6, "CL totalled separately",
     String(u.meta.totalControlled));
  ok(Math.abs(u.meta.totalImport - 72) < 1e-6, "CL folded into import (48+24)",
     String(u.meta.totalImport));
  ok(u.meta.warnings.some((w) => /controlled load/i.test(w)), "CL caveat surfaced");
}

// --- DST derivation without timezone offsets ------------------------------
{
  const v = Array.from({ length: 48 }, () => "1").join(",");
  const mk = (d) => [
    "100,NEM12,200505121650,X,Y", "200,N,E1,E1,E1,N1,1,KWH,30,",
    `300,${d},${v},A,,,20250402014306,`, "900",
  ].join("\n");
  const jan = parseUsage(mk("20250115"), { region: "NSW", days: 1 });
  const jul = parseUsage(mk("20250715"), { region: "NSW", days: 1 });
  const qld = parseUsage(mk("20250115"), { region: "QLD", days: 1 });
  ok(jan.dst[0] === 1, "January is AEDT in NSW");
  ok(jul.dst[0] === 0, "July is AEST in NSW");
  ok(qld.dst[0] === 0, "Queensland never observes DST");
}

// --- the real retailer CSV still parses identically ------------------------
{
  const csvPath = join(ROOT, "actual_usage.csv");
  if (existsSync(csvPath)) {
    const u = parseUsage(readFileSync(csvPath, "utf8"), { region: "NSW" });
    ok(u.meta.format === "CSV", "retailer export detected as tabular CSV");
    ok(u.days.length === 365, "365-day window");
    ok(Math.abs(u.meta.totalImport - 2295.9) < 0.5, "import total unchanged",
       u.meta.totalImport.toFixed(1));
    ok(Math.abs(u.meta.totalExport - 13429.5) < 0.5, "export total unchanged",
       u.meta.totalExport.toFixed(1));
    ok(u.meta.coverage > 0.99, "full coverage reported");
  } else {
    console.log("skip actual_usage.csv (not present)");
  }
}

// --- unparseable input fails loudly, and offers mapping --------------------
{
  let threw = null;
  try { parseUsage("alpha,beta,gamma\n1,2,3\n"); } catch (e) { threw = e; }
  ok(threw && threw.needsMapping, "unknown columns raise a mapping request");
  ok(threw && Array.isArray(threw.header), "error carries the header for the mapping UI");

  let threw2 = null;
  try { parseUsage(""); } catch (e) { threw2 = e; }
  ok(threw2, "empty file rejected");
}

// --- column detection on a wide-format export -----------------------------
{
  const cols = detectColumns(["Interval Date", "Consumption (kWh)", "Feed-in (kWh)"]);
  ok(cols.from === 0 && cols.importCol === 1 && cols.exportCol === 2,
     "wide-format columns detected", JSON.stringify(cols));
}

console.log(fail === 0 ? "\nusage: all passed" : `\nusage: ${fail} FAILED`);
process.exit(fail ? 1 : 0);
