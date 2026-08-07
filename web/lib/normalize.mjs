/* Normalization of raw CDR plan details into the compact tariff specs the
 * billing engine consumes. Shared by the build script (Node) and, when plans
 * are fetched live, the browser — one implementation of the domain rules.
 *
 * Conventions in the output:
 *  - Rates stay $ ex-GST exactly as published (the engine grosses up charges
 *    by 1.1; feed-in credits are not grossed up).
 *  - Days are MON=0 .. SUN=6.
 *  - Times are minutes since midnight, half-open windows [start, end).
 *  - Feed-in entries group into alternative options; tiers within a group are
 *    volume caps consumed in order.
 */

const DAY_CODES = { MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4, SAT: 5, SUN: 6 };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Capitalised month tokens only, so the verb "may" can't match.
const MONTH_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/g;
const TIME_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi;
const WEEKDAY_RE = /mon(?:day)?\s*(?:to|-|–)\s*fri/i;

/** '14:59' -> minutes. Ends filed on :59/:29 are inclusive, so add a minute. */
function minutes(t) {
  const hh = Number(t.slice(0, 2));
  const mm = Number(t.slice(3, 5));
  let v = hh * 60 + mm;
  if (mm % 30 === 29 || mm % 30 === 59 || mm % 15 === 14) v += 1;
  return v;
}

function normWindow(w) {
  const days = [...new Set((w.days || []).map((d) => DAY_CODES[d]).filter((d) => d !== undefined))].sort();
  let start = minutes(w.startTime);
  let end = minutes(w.endTime);
  if (end === 0) end = 1440;
  if (start === 0 && (end === 1440 || end === 1)) end = 1440;
  return { days: days.length ? days : [0, 1, 2, 3, 4, 5, 6], start, end };
}

function normBlocks(rates) {
  return (rates || []).map((r) => ({
    limit: r.volume === undefined || r.volume === null ? null : Number(r.volume),
    price: Number(r.unitPrice),
  }));
}

function monthRange(a, b) {
  const out = [a];
  while (out[out.length - 1] !== b) {
    out.push((out[out.length - 1] % 12) + 1);
    if (out.length > 12) return Array.from({ length: 12 }, (_, i) => i + 1);
  }
  return out;
}

/** 'Winter Jun to Aug' -> [6,7,8]; 'Nov-Mar & Jun-Aug' -> both ranges. */
function monthsFromText(text) {
  const tokens = [...String(text || "").matchAll(MONTH_RE)]
    .map((m) => MONTHS.indexOf(m[1]) + 1);
  if (!tokens.length || tokens.length % 2) return null; // can't pair: don't guess
  const months = new Set();
  for (let i = 0; i < tokens.length; i += 2) {
    for (const m of monthRange(tokens[i], tokens[i + 1])) months.add(m);
  }
  return [...months].sort((a, b) => a - b);
}

function monthsFromPeriod(startMd, endMd) {
  return monthRange(Number(startMd.slice(0, 2)), Number(endMd.slice(0, 2)));
}

/** Best effort: '... 2pm to 8pm Mon to Fri ...' -> {start, end, days}. */
function windowFromText(text) {
  const times = [...String(text || "").matchAll(TIME_RE)];
  if (times.length < 2) return null;
  const toMin = (m) => {
    const h = (Number(m[1]) % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
    return h * 60 + Number(m[2] || 0);
  };
  const start = toMin(times[0]);
  const end = toMin(times[1]);
  if (!(start >= 0 && start < end && end <= 1440)) return null;
  const days = WEEKDAY_RE.test(text) ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6];
  return { start, end, days };
}

function normDemand(dc) {
  let start = minutes(dc.startTime);
  let end = minutes(dc.endTime);
  let approx = false;
  let days = dc.days?.length
    ? [...new Set(dc.days.map((d) => DAY_CODES[d]).filter((d) => d !== undefined))].sort()
    : [0, 1, 2, 3, 4, 5, 6];

  if (start === end) {                       // the window lives in the prose
    const parsed = windowFromText(dc.description);
    if (parsed) {
      start = parsed.start; end = parsed.end;
      if (!dc.days?.length) days = parsed.days;
    } else {
      start = 14 * 60; end = 20 * 60;
      if (!dc.days?.length) days = [0, 1, 2, 3, 4];
    }
    approx = true;
  }
  if (end === 0) end = 1440;

  const text = `${dc.displayName || ""} ${dc.description || ""}`.toLowerCase();

  // Some retailers file the wrong chargePeriod; their own label wins
  // (Momentum labels "$/kW/day" but sets chargePeriod MONTH).
  let chargePeriod = dc.chargePeriod || "DAY";
  if (/kw\s*(?:\/|per\s*)\s*day/.test(text)) chargePeriod = "DAY";
  else if (/kw\s*(?:\/|per\s*)\s*month/.test(text)) chargePeriod = "MONTH";

  // Some retailers (GEE) publish cents in the dollar AmountString.
  let amount = Number(dc.amount);
  const centsHinted = /cent|c\/kw|�\/kw/.test(text);
  const implausible = amount > (chargePeriod === "DAY" ? 3 : 100);
  if (implausible && (centsHinted || amount > 10)) { amount /= 100; approx = true; }

  // Retailers often file every season's demand row inside one tariff period;
  // the row's own text names the real season, so trust that.
  const months = monthsFromText(`${dc.displayName || ""} ${dc.description || ""}`);

  return {
    amount, start, end, days, months, chargePeriod,
    measurementPeriod: dc.measurementPeriod || "DAY",
    minDemand: Number(dc.minDemand || 0),
    displayName: dc.displayName || null,
    approx,
  };
}

function normTariffPeriod(tp) {
  const out = {
    startDate: tp.startDate || "01-01",
    endDate: tp.endDate || "12-31",
    displayName: tp.displayName || null,
    dailySupplyCharge: Number(tp.dailySupplyCharge || 0),
  };
  if (tp.singleRate) {
    out.singleRate = {
      period: tp.singleRate.period || "P1Y",
      blocks: normBlocks(tp.singleRate.rates),
    };
  }
  const tous = (tp.timeOfUseRates || []).map((tou) => ({
    type: tou.type || "PEAK",
    period: tou.period || "P1Y",
    blocks: normBlocks(tou.rates),
    windows: (tou.timeOfUse || []).map(normWindow),
    displayName: tou.displayName || null,
  }));
  if (tous.length) out.touRates = tous;
  if (tp.demandCharges?.length) out.demand = tp.demandCharges.map(normDemand);
  return out;
}

/** Lift demand charges to plan level, filling months and de-duplicating. */
function hoistDemand(tariffPeriods) {
  const out = [];
  const seen = new Set();
  for (const tp of tariffPeriods) {
    for (const dc of tp.demand || []) {
      if (!dc.months) dc.months = monthsFromPeriod(tp.startDate, tp.endDate);
      const key = [dc.amount, dc.start, dc.end, dc.days, dc.months,
                   dc.chargePeriod, dc.measurementPeriod].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(dc);
    }
    delete tp.demand;
  }
  return out;
}

function normFit(fits) {
  const groups = new Map();
  for (const fit of fits || []) {
    if (String(fit.scheme || "").toUpperCase() === "PREMIUM") continue; // closed govt schemes
    const name = fit.displayName || fit.description || "FIT";
    if (!groups.has(name)) {
      groups.set(name, {
        displayName: name,
        payerType: fit.payerType || null,
        description: fit.description || null,
        tiers: [],
      });
    }
    const g = groups.get(name);
    if (fit.singleTariff) {
      for (const r of fit.singleTariff.rates || []) {
        g.tiers.push({
          limit: r.volume == null ? null : Number(r.volume),
          price: Number(r.unitPrice),
          period: fit.singleTariff.period || "P1Y",
          windows: null,
        });
      }
    }
    for (const tv of fit.timeVaryingTariffs || []) {
      const wins = (tv.timeVariations || []).map(normWindow);
      for (const r of tv.rates || []) {
        g.tiers.push({
          limit: r.volume == null ? null : Number(r.volume),
          price: Number(r.unitPrice),
          period: tv.period || "P1D",
          windows: wins.length ? wins : null,
        });
      }
    }
  }
  const result = [...groups.values()];
  for (const g of result) {
    g.tiers.sort((a, b) => (a.limit == null) - (b.limit == null) || (a.limit || 0) - (b.limit || 0));
  }
  return result;
}

function normDiscounts(discounts) {
  return (discounts || []).map((d) => {
    let value = null;
    if (d.methodUType === "percentOfBill") value = Number(d.percentOfBill.rate);
    else if (d.methodUType === "percentOfUse") value = Number(d.percentOfUse.rate);
    else if (d.methodUType === "fixedAmount") value = Number(d.fixedAmount.amount);
    return {
      type: d.type || null,
      category: d.category || null,
      method: d.methodUType || null,
      value,
      displayName: d.displayName || null,
      description: d.description || null,
    };
  });
}

const RESTRICTED_ELIGIBILITY = new Set([
  "THIRD_PARTY_ONLY", "ORG_MEMBER", "LOYALTY_MEMBER", "SENIOR_CARD",
  "REQ_EQUIP_SUPPLIER", "EXISTING_BATTERY",
]);
const RESTRICTED_TEXT =
  /member|comparator|third.party|employee|staff|westpac|velocity|rewards|\bclub\b|nrma|racv|\braa\b|cba|commbank|yello|only available through/i;

/** @param opts {{hasBattery?:boolean, hasSmartMeter?:boolean}} site facts */
function isRestricted(elig, terms, opts) {
  // A smart (interval) meter disqualifies plans that demand a basic meter.
  if (opts.hasSmartMeter !== false && /basic meter|accumulation meter/i.test(terms || "")) {
    return true;
  }
  for (const e of elig) {
    if (e.type === "EXISTING_BATTERY" && opts.hasBattery) continue;
    if (RESTRICTED_ELIGIBILITY.has(e.type)) return true;
    if (e.type === "OTHER" &&
        RESTRICTED_TEXT.test(`${e.information || ""} ${e.description || ""}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize one CDR plan detail payload.
 * @param {object} d  the `data` object from Get Generic Plan Detail
 * @param {object} [opts] site facts affecting eligibility
 */
export function normalizePlan(d, opts = {}) {
  const ec = d.electricityContract;
  if (!ec) return null;

  const tariffPeriods = (ec.tariffPeriod || []).map(normTariffPeriod);
  const demandCharges = hoistDemand(tariffPeriods);

  const flags = [];
  if (demandCharges.length) {
    flags.push("DEMAND");
    if (demandCharges.some((dc) => dc.approx)) flags.push("DEMAND_APPROX");
  }
  if (d.brandName === "Amber Electric") flags.push("WHOLESALE_ESTIMATE");

  const eligibility = (ec.eligibility || []).map((e) => ({
    type: e.type || null,
    information: e.information || null,
    description: e.description || null,
  }));

  const membershipFees = (ec.fees || [])
    .filter((f) => f.type === "MEMBERSHIP" && f.amount)
    .map((f) => ({
      amount: Number(f.amount),
      term: f.term || null,
      description: f.description || null,
    }));

  return {
    planId: d.planId,
    brand: d.brand || null,
    brandName: (d.brandName || "").trim(),
    displayName: d.displayName || null,
    type: d.type || null,                                  // MARKET / STANDING
    pricingModel: ec.pricingModel || null,
    timeZone: ec.timeZone || "LOCAL",
    distributors: d.geography?.distributors || [],
    // Retailers restrict some plans to a subset of a network's postcodes, so
    // the distributor alone doesn't determine availability. build-data interns
    // these into a shared table and replaces them with an index.
    includedPostcodes: d.geography?.includedPostcodes || null,
    excludedPostcodes: d.geography?.excludedPostcodes || null,
    tariffPeriods,
    demandCharges,
    fitGroups: normFit(ec.solarFeedInTariff),
    discounts: normDiscounts(ec.discounts),
    membershipFees,
    incentives: (ec.incentives || []).map((i) => ({
      displayName: i.displayName || null,
      description: i.description || null,
    })),
    eligibility,
    restricted: isRestricted(eligibility, ec.terms, opts),
    benefitPeriod: ec.benefitPeriod || null,
    terms: ec.terms || null,
    flags,
  };
}

/** True if a plan list entry serves this postcode + distributor + residential. */
export function planServes(plan, { postcode, cdrNames }) {
  const ctype = (plan.customerType || "RESIDENTIAL").toUpperCase();
  if (ctype !== "RESIDENTIAL" && ctype !== "ALL") return false;

  const geo = plan.geography || {};
  const dists = geo.distributors || [];
  if (cdrNames?.length && dists.length &&
      !dists.some((d) => cdrNames.some((n) => d.toLowerCase().includes(n.toLowerCase())))) {
    return false;
  }
  if (postcode) {
    if (postcodeIn(geo.excludedPostcodes, postcode)) return false;
    if (geo.includedPostcodes && !postcodeIn(geo.includedPostcodes, postcode)) return false;
  }
  return true;
}

/**
 * Is a plan sold at this postcode? `set` is an entry from a bundle's
 * interned postcodeSets table ({inc, exc}); a null set means unrestricted.
 */
export function servesPostcode(set, postcode) {
  if (!set || !postcode) return true;
  if (postcodeIn(set.exc, postcode)) return false;
  if (set.inc && !postcodeIn(set.inc, postcode)) return false;
  return true;
}

/** CDR postcode lists may hold ranges like '2000-2249'. */
export function postcodeIn(list, postcode) {
  const pc = Number(postcode);
  for (const item of list || []) {
    const s = String(item).trim();
    if (s.includes("-")) {
      const [lo, hi] = s.split("-");
      if (Number(lo) <= pc && pc <= Number(hi)) return true;
    } else if (s === String(postcode)) return true;
  }
  return false;
}
