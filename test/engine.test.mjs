// node test/engine.test.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as Engine from "../web/engine.mjs";
import { parseUsage } from "../web/lib/usage.mjs";
import { servesPostcode } from "../web/lib/normalize.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Usage is parsed from the CSV at test time — it is deliberately not a build
// artifact, since personal interval data must never ship with the app.
const usage = parseUsage(readFileSync(join(ROOT, "actual_usage.csv"), "utf8"), { region: "NSW" });
const ausgrid = JSON.parse(readFileSync(join(ROOT, "web/data/plans-ausgrid.json")));
const plans = ausgrid.plans;

let fail = 0;
const approx = (a, b, tol, label) => {
  if (Math.abs(a - b) > tol) {
    console.error(`FAIL ${label}: got ${a.toFixed(2)}, want ${b.toFixed(2)}`);
    fail++;
  } else console.log(`ok   ${label}: ${a.toFixed(2)}`);
};
const ok = (cond, label, extra) => {
  if (cond) console.log(`ok   ${label}${extra ? " — " + extra : ""}`);
  else { console.error(`FAIL ${label}${extra ? " — " + extra : ""}`); fail++; }
};

const series = {
  imp: Float64Array.from(usage.importKwh),
  exp: Float64Array.from(usage.exportKwh),
};

// --- 1. flat rate with a daily block, hand-computed independently ---------
const glo = plans.find((p) => p.planId.startsWith("GLO1142213"));
if (glo) {
  const r = Engine.computeBill(glo, usage, series, {});
  const tp = glo.tariffPeriods[0];
  const [b0, b1] = tp.singleRate.blocks;
  let expUsage = 0;
  for (let d = 0; d < usage.days.length; d++) {
    let dayKwh = 0;
    for (let s = 0; s < 48; s++) dayKwh += usage.importKwh[d * 48 + s];
    expUsage += Math.min(dayKwh, b0.limit) * b0.price + Math.max(0, dayKwh - b0.limit) * b1.price;
  }
  approx(r.usage, expUsage * 1.1, 0.5, "block-rate usage");
  approx(r.supply, tp.dailySupplyCharge * usage.days.length * 1.1, 0.5, "daily supply");
} else { console.error("FAIL: Globird fixture plan missing"); fail++; }

// --- 2. synthetic TOU + tiered FIT ---------------------------------------
{
  const plan = {
    planId: "SYNTH", brandName: "Test", displayName: "Synth", type: "MARKET",
    pricingModel: "TIME_OF_USE", timeZone: "LOCAL", demandCharges: [],
    tariffPeriods: [{
      startDate: "01-01", endDate: "12-31", dailySupplyCharge: 1.0,
      touRates: [
        { type: "PEAK", period: "P1Y", blocks: [{ limit: null, price: 0.50 }],
          windows: [{ days: [0, 1, 2, 3, 4], start: 840, end: 1200 }] },
        { type: "OFF_PEAK", period: "P1Y", blocks: [{ limit: null, price: 0.10 }],
          windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 1440 }] },
      ],
    }],
    fitGroups: [{ displayName: "fit", tiers: [
      { limit: 5, price: 0.10, period: "P1D", windows: null },
      { limit: null, price: 0.02, period: "P1Y", windows: null }] }],
    discounts: [], membershipFees: [], incentives: [], eligibility: [],
    restricted: false, flags: [],
  };
  const su = {
    days: ["2026-01-05", "2026-01-10"], dayOfWeek: [0, 5], dst: [1, 1],
    importKwh: new Array(96).fill(0), exportKwh: new Array(96).fill(0),
  };
  su.importKwh[30] = 1;        // Mon 15:00 -> peak
  su.importKwh[16] = 1;        // Mon 08:00 -> off-peak
  su.importKwh[48 + 30] = 1;   // Sat 15:00 -> off-peak (weekend)
  su.exportKwh[24] = 8;        // 5 kWh @10c then 3 @2c
  const ss = { imp: Float64Array.from(su.importKwh), exp: Float64Array.from(su.exportKwh) };
  const r = Engine.computeBill(plan, su, ss, {});
  approx(r.usage, (0.5 + 0.1 + 0.1) * 1.1, 1e-6, "TOU bucket selection");
  approx(r.supply, 2 * 1.1, 1e-6, "synthetic supply");
  approx(r.fit, 5 * 0.10 + 3 * 0.02, 1e-6, "tiered daily-capped FIT");
}

// --- 3. demand billed as monthly max charged across every day of the month
{
  const plan = {
    planId: "DEM", brandName: "Test", displayName: "Demand", type: "MARKET",
    pricingModel: "SINGLE_RATE", timeZone: "LOCAL",
    tariffPeriods: [{ startDate: "01-01", endDate: "12-31", dailySupplyCharge: 0,
      singleRate: { period: "P1Y", blocks: [{ limit: null, price: 0 }] } }],
    demandCharges: [{ amount: 0.10, start: 840, end: 1200, days: [0, 1, 2, 3, 4],
      months: [1], chargePeriod: "DAY", measurementPeriod: "DAY", minDemand: 0, approx: false }],
    fitGroups: [], discounts: [], membershipFees: [], incentives: [],
    eligibility: [], restricted: false, flags: ["DEMAND"],
  };
  // 3 days, all January; one 2 kWh half-hour (=4 kW) inside the window
  const su = {
    days: ["2026-01-05", "2026-01-06", "2026-01-07"], dayOfWeek: [0, 1, 2], dst: [1, 1, 1],
    importKwh: new Array(144).fill(0), exportKwh: new Array(144).fill(0),
  };
  su.importKwh[30] = 2;   // Mon 15:00 -> 4 kW peak
  const ss = { imp: Float64Array.from(su.importKwh), exp: Float64Array.from(su.exportKwh) };
  const r = Engine.computeBill(plan, su, ss, {});
  // 4 kW * $0.10 * 3 days in the month * GST
  approx(r.demand, 4 * 0.10 * 3 * 1.1, 1e-6, "demand = monthly max x all days");
}

// --- 4. full sweep: nothing crashes, nothing goes non-finite --------------
{
  let errors = 0, unsupported = 0;
  const totals = [];
  for (const p of plans) {
    try {
      const b = Engine.computeBill(p, usage, series, {});
      if (b.unsupported) { unsupported++; continue; }
      if (!Number.isFinite(b.baseTotal)) throw new Error("non-finite total");
      totals.push(b.baseTotal);
    } catch (e) {
      if (errors++ < 3) console.error(`   ${p.planId}: ${e.message}`);
    }
  }
  if (errors) { console.error(`FAIL sweep: ${errors} errors`); fail++; }
  else console.log(`ok   swept ${totals.length} plans, 0 errors, ${unsupported} unsupported`);
  totals.sort((a, b) => a - b);
  console.log(`     cheapest $${totals[0].toFixed(0)}, median $${totals[totals.length >> 1].toFixed(0)}, dearest $${totals.at(-1).toFixed(0)}`);
}

// --- 5. postcode availability: a NMI alone doesn't determine what's for sale
{
  const sets = ausgrid.postcodeSets || [];
  const avail = (pc) => plans.filter((p) =>
    p.pcSet == null || servesPostcode(sets[p.pcSet], pc));

  // 2212 is ordinary Ausgrid territory: every plan is sold there.
  const at2212 = avail("2212");
  approx(at2212.length, plans.length, 0, "all Ausgrid plans available at 2212");

  // 2109 is the documented outlier — only a small minority serve it.
  const at2109 = avail("2109");
  ok(at2109.length > 0 && at2109.length < plans.length * 0.1,
     "2109 restricted to a small subset", `${at2109.length} of ${plans.length}`);

  // Essential Energy: filtering must remove a retailer that isn't sold there.
  const ess = JSON.parse(readFileSync(join(ROOT, "web/data/plans-essential.json")));
  const cheapest = (pc) => {
    const list = ess.plans
      .filter((p) => !p.restricted && (!pc || p.pcSet == null || servesPostcode(ess.postcodeSets[p.pcSet], pc)))
      .map((p) => ({ p, b: Engine.computeBill(p, usage, series, {}) }))
      .filter((x) => !x.b.unsupported)
      .sort((a, b) => a.b.baseTotal - b.b.baseTotal);
    return list[0];
  };
  const anywhere = cheapest(null);
  const at2340 = cheapest("2340");
  ok(anywhere.p.brandName !== at2340.p.brandName,
     "postcode changes Essential's top plan (the bug this guards)",
     `${anywhere.p.brandName} -> ${at2340.p.brandName}`);
  ok(at2340.b.baseTotal >= anywhere.b.baseTotal,
     "filtered best is never cheaper than the unfiltered best");
}

console.log(fail === 0 ? "\nengine: all passed" : `\nengine: ${fail} FAILED`);
process.exit(fail ? 1 : 0);
