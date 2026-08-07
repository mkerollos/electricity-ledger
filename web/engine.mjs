/* Annual electricity bill engine for normalized CDR plan specs.
 *
 * Money conventions:
 *  - Plan rates are $ ex-GST (as published in CDR PRD data).
 *  - All charges (supply, usage, demand, percent discounts on them) are
 *    grossed up by GST. Feed-in credits are not (no GST for residential
 *    sellers), matching how retailers bill.
 *  - Returned figures are $ inc GST.
 *
 * Time conventions:
 *  - usage arrays are indexed day*48 + slot, slot = local half-hour.
 *  - Plans with timeZone AEST have their windows evaluated in AEST:
 *    on AEDT days the local clock is shifted back 60 minutes.
 */
export const GST = 1.1;

// ------------------------------------------------------------ helpers --

function mmdd(dateStr) {
  return dateStr.slice(5); // "2025-11-03" -> "11-03"
}

function inSeason(md, start, end) {
  // inclusive MM-DD range, wrapping over new year (e.g. 11-01 .. 03-31)
  if (start <= end) return md >= start && md <= end;
  return md >= start || md <= end;
}

function inWindow(win, dayOfWeek, minute) {
  if (win.days.indexOf(dayOfWeek) === -1) return false;
  if (win.start <= win.end) return minute >= win.start && minute < win.end;
  return minute >= win.start || minute < win.end; // wraps midnight
}

function anyWindow(wins, dayOfWeek, minute) {
  for (let i = 0; i < wins.length; i++) {
    if (inWindow(wins[i], dayOfWeek, minute)) return true;
  }
  return false;
}

// Reset-period key for block accounting / FIT caps.
function periodKey(period, dayIdx, dateStr) {
  switch (period) {
    case "P1D": return dayIdx;
    case "P1M": return dateStr.slice(0, 7);
    case "P2M": return dateStr.slice(0, 4) + "-b" + Math.floor((+dateStr.slice(5, 7) - 1) / 2);
    case "P3M": return dateStr.slice(0, 4) + "-q" + Math.floor((+dateStr.slice(5, 7) - 1) / 3);
    case "P6M": return dateStr.slice(0, 4) + "-h" + Math.floor((+dateStr.slice(5, 7) - 1) / 6);
    default: return "Y"; // P1Y / unknown: never resets within our 1-year run
  }
}

// Marginal cost of adding `kwh` on top of `acc` kWh already used in this
// reset period, under ordered blocks [{limit(kWh block size)|null, price}].
function marginalBlockCost(blocks, acc, kwh) {
  let cost = 0;
  let remaining = kwh;
  let lower = 0;
  for (let i = 0; i < blocks.length && remaining > 1e-12; i++) {
    const b = blocks[i];
    const upper = b.limit == null ? Infinity : lower + b.limit;
    const roomTop = Math.min(upper, acc + kwh);
    const roomBottom = Math.max(lower, acc);
    if (roomTop > roomBottom) {
      const amt = roomTop - roomBottom;
      cost += amt * b.price;
      remaining -= amt;
    }
    lower = upper;
  }
  if (remaining > 1e-12 && blocks.length) {
    cost += remaining * blocks[blocks.length - 1].price; // beyond last block
  }
  return cost;
}

// -------------------------------------------------------- EV scenario --

/**
 * Returns {imp, exp} Float64Arrays after applying the EV load.
 * opts: evNightKwh, evDayKwh, nightStart/nightEnd (minutes, may wrap),
 *       dayStart/dayEnd (minutes).
 * Night charging adds grid import inside the night window.
 * Day charging consumes solar surplus first (reduces export); any
 * shortfall becomes grid import inside the day window.
 */
function applyEv(usage, opts) {
  const n = usage.importKwh.length;
  const imp = Float64Array.from(usage.importKwh);
  const exp = Float64Array.from(usage.exportKwh);
  const days = usage.days.length;

  const nightSlots = [];
  for (let s = 0; s < 48; s++) {
    const m = s * 30;
    const w = { days: [0, 1, 2, 3, 4, 5, 6], start: opts.nightStart, end: opts.nightEnd };
    if (inWindow(w, 0, m)) nightSlots.push(s);
  }
  const daySlots = [];
  for (let s = 0; s < 48; s++) {
    const m = s * 30;
    if (m >= opts.dayStart && m < opts.dayEnd) daySlots.push(s);
  }

  const nightPerSlot = nightSlots.length ? (opts.evNightKwh / days) / nightSlots.length : 0;
  const dayPerDay = opts.evDayKwh / days;

  for (let d = 0; d < days; d++) {
    const base = d * 48;
    for (let i = 0; i < nightSlots.length; i++) imp[base + nightSlots[i]] += nightPerSlot;

    if (dayPerDay > 0 && daySlots.length) {
      let need = dayPerDay;
      // consume solar surplus first, largest export slots first
      const order = daySlots.slice().sort((a, b) => exp[base + b] - exp[base + a]);
      for (let i = 0; i < order.length && need > 1e-12; i++) {
        const idx = base + order[i];
        const take = Math.min(exp[idx], need);
        exp[idx] -= take;
        need -= take;
      }
      if (need > 1e-12) {
        const per = need / daySlots.length; // remainder drawn from grid
        for (let i = 0; i < daySlots.length; i++) imp[base + daySlots[i]] += per;
      }
    }
  }
  return { imp, exp };
}

// ------------------------------------------------------------- engine --

/**
 * Compute the annual bill for one plan.
 * usage: parsed usage.json. series: {imp, exp} (post-EV).
 * Returns $ inc GST figures plus breakdowns, or {unsupported: reason}.
 */
function computeBill(plan, usage, series, opts) {
  const days = usage.days.length;
  const flags = plan.flags.slice();
  const demandMode = (opts && opts.demandMode) || "monthly";

  let supply = 0;        // ex GST
  let usageCost = 0;     // ex GST
  let demandCost = 0;    // ex GST
  let unmatchedKwh = 0;
  let noPeriodDays = 0;

  const bucketAgg = {};  // label -> {kwh, cost}
  const monthly = {};    // "YYYY-MM" -> {supply, usage, demand, fit}
  const blockAcc = {};   // bucketId -> {key, acc}

  // Demand tracking: per demand charge id -> map(chargeKey -> maxKw)
  const demandMax = {};

  const aestShift = plan.timeZone === "AEST";

  for (let d = 0; d < days; d++) {
    const dateStr = usage.days[d];
    const md = mmdd(dateStr);
    const dow = usage.dayOfWeek[d];
    const monthKey = dateStr.slice(0, 7);
    const mon = (monthly[monthKey] = monthly[monthKey] ||
      { supply: 0, usage: 0, demand: 0, fit: 0, days: 0 });
    mon.days++;

    // --- find the tariff period covering this date
    let tp = null, tpIdx = -1;
    for (let i = 0; i < plan.tariffPeriods.length; i++) {
      const cand = plan.tariffPeriods[i];
      if (inSeason(md, cand.startDate, cand.endDate)) { tp = cand; tpIdx = i; break; }
    }
    if (!tp) { noPeriodDays++; continue; }

    supply += tp.dailySupplyCharge;
    mon.supply += tp.dailySupplyCharge * GST;

    // Demand charges live at plan level with their own month lists (the
    // retailer's own season text), independent of tariff period structure.
    // They apply to every day of an active month, even outside the window.
    const calMonth = +dateStr.slice(5, 7);
    if (plan.demandCharges) {
      for (let j = 0; j < plan.demandCharges.length; j++) {
        const dcj = plan.demandCharges[j];
        if (dcj.months.indexOf(calMonth) === -1) continue;
        const store = (demandMax[j] = demandMax[j] ||
          { dc: dcj, max: {}, months: {}, dayCount: {} });
        store.dayCount[monthKey] = (store.dayCount[monthKey] || 0) + 1;
      }
    }

    // AEDT local minute -> AEST minute = local - 60
    const minuteShift = aestShift && usage.dst[d] ? -60 : 0;

    for (let s = 0; s < 48; s++) {
      const idx = d * 48 + s;
      const kwh = series.imp[idx];
      let minute = s * 30 + minuteShift;
      if (minute < 0) minute += 1440;

      // --- demand measurement (kW = kWh * 2 for half-hour intervals)
      if (plan.demandCharges) {
        for (let j = 0; j < plan.demandCharges.length; j++) {
          const dc = plan.demandCharges[j];
          if (dc.months.indexOf(calMonth) === -1) continue;
          const w = { days: dc.days, start: dc.start, end: dc.end };
          if (inWindow(w, dow, minute)) {
            const kw = kwh * 2;
            const store = demandMax[j];
            // Billing basis: retailers' fine print near-universally takes the
            // highest half-hour in the window over the MONTH (or season) and
            // charges it for every day of that month, mirroring the network
            // tariff — even where the structured fields claim measurement=DAY.
            // demandMode "daily" keeps the literal per-day reading for comparison.
            let measureKey;
            if (dc.measurementPeriod === "TARIFF_PERIOD") measureKey = "TP";
            else if (demandMode === "daily" && dc.chargePeriod === "DAY") measureKey = d;
            else measureKey = monthKey;
            if (!(measureKey in store.max) || kw > store.max[measureKey]) {
              store.max[measureKey] = kw;
            }
            (store.months[measureKey] = store.months[measureKey] || {})[monthKey] = true;
          }
        }
      }

      if (kwh <= 0) continue;

      // --- pick usage bucket
      let blocks = null, bucketLabel = null, bucketId = null, rperiod = "P1Y";
      if (tp.touRates) {
        let hit = null;
        for (let j = 0; j < tp.touRates.length; j++) {
          if (anyWindow(tp.touRates[j].windows, dow, minute)) { hit = tp.touRates[j]; break; }
        }
        if (!hit) {
          // coverage gap: fall back to an OFF_PEAK bucket if one exists
          for (let j = 0; j < tp.touRates.length; j++) {
            if (tp.touRates[j].type === "OFF_PEAK") { hit = tp.touRates[j]; break; }
          }
          unmatchedKwh += kwh;
          if (!hit) hit = tp.touRates[0];
        }
        blocks = hit.blocks;
        bucketLabel = hit.type;
        bucketId = tpIdx + ":tou:" + tp.touRates.indexOf(hit);
        rperiod = hit.period;
      } else if (tp.singleRate) {
        blocks = tp.singleRate.blocks;
        bucketLabel = "SINGLE";
        bucketId = tpIdx + ":sr";
        rperiod = tp.singleRate.period;
      } else {
        return { unsupported: "tariff period has no rates" };
      }

      // --- block accounting within reset period
      const key = periodKey(rperiod, d, dateStr);
      let st = blockAcc[bucketId];
      if (!st || st.key !== key) st = blockAcc[bucketId] = { key: key, acc: 0 };
      const cost = marginalBlockCost(blocks, st.acc, kwh);
      st.acc += kwh;
      usageCost += cost;
      mon.usage += cost * GST;

      const agg = (bucketAgg[bucketLabel] = bucketAgg[bucketLabel] || { kwh: 0, cost: 0 });
      agg.kwh += kwh;
      agg.cost += cost * GST;
    }
  }

  // --- demand charges
  let demandApprox = false;
  for (const id in demandMax) {
    const store = demandMax[id];
    const dc = store.dc;
    if (dc.approx) demandApprox = true;
    for (const k in store.max) {
      const kw = Math.max(store.max[k], dc.minDemand);
      const activeMonths = Object.keys(store.months[k] || {});
      let charge;
      if (dc.chargePeriod === "MONTH") {
        // $/kW/month, charged for each month the window was active
        charge = kw * dc.amount * (k === "TP" ? activeMonths.length : 1);
      } else if (k === "TP") {
        // $/kW/day, one max across the whole tariff period: every active day
        let n = 0;
        for (const mk in store.dayCount) n += store.dayCount[mk];
        charge = kw * dc.amount * n;
      } else if (k.length === 7) {
        // $/kW/day, monthly max charged for every day of that month
        charge = kw * dc.amount * (store.dayCount[k] || 0);
      } else {
        charge = kw * dc.amount; // literal per-day reading (demandMode "daily")
      }
      demandCost += charge;
      if (k === "TP" && activeMonths.length) {
        const per = (charge * GST) / activeMonths.length;
        for (let i = 0; i < activeMonths.length; i++) {
          if (monthly[activeMonths[i]]) monthly[activeMonths[i]].demand += per;
        }
      } else {
        const mk = k.length === 7 ? k : usage.days[+k].slice(0, 7);
        if (monthly[mk]) monthly[mk].demand += charge * GST;
      }
    }
  }
  if (demandApprox && flags.indexOf("DEMAND_APPROX") === -1) flags.push("DEMAND_APPROX");

  // --- feed-in tariff: evaluate each alternative group, keep the best
  const fitOptions = [];
  for (let g = 0; g < plan.fitGroups.length; g++) {
    const group = plan.fitGroups[g];
    let credit = 0;
    const tierAcc = group.tiers.map(() => ({ key: null, acc: 0 }));
    const monthlyFit = {};
    for (let d = 0; d < days; d++) {
      const dateStr = usage.days[d];
      const dow = usage.dayOfWeek[d];
      const minuteShift = aestShift && usage.dst[d] ? -60 : 0;
      for (let s = 0; s < 48; s++) {
        let e = series.exp[d * 48 + s];
        if (e <= 0) continue;
        let minute = s * 30 + minuteShift;
        if (minute < 0) minute += 1440;
        for (let t = 0; t < group.tiers.length && e > 1e-12; t++) {
          const tier = group.tiers[t];
          if (tier.windows && !anyWindow(tier.windows, dow, minute)) continue;
          let take = e;
          if (tier.limit != null) {
            const key = periodKey(tier.period, d, dateStr);
            const st = tierAcc[t];
            if (st.key !== key) { st.key = key; st.acc = 0; }
            const room = tier.limit - st.acc;
            if (room <= 1e-12) continue;
            take = Math.min(e, room);
            st.acc += take;
          }
          credit += take * tier.price;
          const mk = dateStr.slice(0, 7);
          monthlyFit[mk] = (monthlyFit[mk] || 0) + take * tier.price;
          e -= take;
        }
      }
    }
    fitOptions.push({ displayName: group.displayName, credit: credit, monthlyFit: monthlyFit });
  }
  fitOptions.sort((a, b) => b.credit - a.credit);
  const fitCredit = fitOptions.length ? fitOptions[0].credit : 0;
  if (fitOptions.length) {
    for (const mk in fitOptions[0].monthlyFit) {
      if (monthly[mk]) monthly[mk].fit += fitOptions[0].monthlyFit[mk];
    }
  }
  if (fitOptions.length > 1) flags.push("FIT_OPTIONS");

  // --- gross up charges
  const supplyInc = supply * GST;
  const usageInc = usageCost * GST;
  const demandInc = demandCost * GST;
  const chargesInc = supplyInc + usageInc + demandInc;

  // --- discounts
  let guaranteedDisc = 0;
  let conditionalDisc = 0;
  const discountNotes = [];
  for (let i = 0; i < plan.discounts.length; i++) {
    const disc = plan.discounts[i];
    let amt = 0;
    if (disc.method === "percentOfBill" && disc.value != null) {
      amt = chargesInc * disc.value;
    } else if (disc.method === "percentOfUse" && disc.value != null) {
      amt = usageInc * disc.value;
    } else if (disc.method === "fixedAmount" && disc.value != null) {
      amt = disc.value; // treated as annual; noted in caveats
      discountNotes.push("Fixed discount treated as once per year: " + (disc.displayName || ""));
    }
    if (disc.type === "GUARANTEED") guaranteedDisc += amt;
    else conditionalDisc += amt;
  }

  // --- membership fees (assumed GST-inc as published)
  let memberFees = 0;
  for (let i = 0; i < plan.membershipFees.length; i++) {
    const fee = plan.membershipFees[i];
    const term = (fee.term || "ANNUAL").toUpperCase();
    const mult = term === "MONTHLY" ? 12 : term === "QUARTERLY" ? 4 :
                 term === "WEEKLY" ? 52 : term === "DAILY" ? 365 : 1;
    memberFees += fee.amount * mult;
  }

  if (unmatchedKwh > 0.005 * 2296) flags.push("TOU_GAPS");
  if (noPeriodDays > 0) flags.push("PERIOD_GAPS");

  const baseTotal = chargesInc - fitCredit - guaranteedDisc + memberFees;
  const withConditional = baseTotal - conditionalDisc;

  return {
    total: opts && opts.includeConditional ? withConditional : baseTotal,
    baseTotal: baseTotal,
    withConditional: withConditional,
    supply: supplyInc,
    usage: usageInc,
    demand: demandInc,
    fit: fitCredit,
    guaranteedDiscount: guaranteedDisc,
    conditionalDiscount: conditionalDisc,
    memberFees: memberFees,
    buckets: bucketAgg,
    monthly: monthly,
    fitOptions: fitOptions.map(function (o) {
      return { displayName: o.displayName, credit: o.credit };
    }),
    unmatchedKwh: unmatchedKwh,
    discountNotes: discountNotes,
    flags: flags,
  };
}

export { applyEv, computeBill, marginalBlockCost, inWindow, inSeason };
