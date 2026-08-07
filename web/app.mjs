/* The Electricity Ledger — UI. All maths lives in engine.mjs.
 * Uploaded usage data is parsed and kept in this browser; it is never sent
 * anywhere. The only network requests are for the static plan bundles. */
import * as Engine from "./engine.mjs";
import { parseNmi } from "./lib/nmi.mjs";
import { parseUsage, detectColumns } from "./lib/usage.mjs";

{
  const $ = (id) => document.getElementById(id);
  const fmt$ = (v) => (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-AU", { maximumFractionDigits: 0 });
  const fmt$2 = (v) => (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtK = (v) => v.toLocaleString("en-AU", { maximumFractionDigits: 0 });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const NMI_KEY = "ledger.nmi";
  const USAGE_KEY = "ledger.usage";

  let usage = null, plans = [], catalogue = null, network = null;
  let results = [];          // [{plan, bill}] sorted
  let pendingFile = null;    // {text, header} awaiting a column mapping

  const state = {
    evKwh: 2250,
    nightShare: 0.5,
    nightStart: 22 * 60,
    nightEnd: 6 * 60,
    conditional: false,
    showRestricted: false,
    showAll: false,
    search: "",
  };

  // ------------------------------------------------------------- boot ----

  fetch("data/index.json").then((r) => r.json()).then((idx) => {
    catalogue = idx;
    initControls();
    initUpload();

    const savedUsage = localStorage.getItem(USAGE_KEY);
    if (savedUsage) {
      try { usage = JSON.parse(savedUsage); } catch { localStorage.removeItem(USAGE_KEY); }
    }
    const savedNmi = localStorage.getItem(NMI_KEY);
    if (savedNmi) $("nmi-input").value = savedNmi;
    if (savedNmi) applyNmi(savedNmi);
    updateStage();
  }).catch((e) => {
    $("nmi-status").innerHTML = `<span class="nmi-err">Couldn't load plan data: ${esc(e.message)}</span>`;
  });

  /** Show the upload prompt until we have both usage data and a network. */
  function updateStage() {
    const ready = !!usage && !!network;
    $("upload-panel").hidden = !!usage;
    $("results").hidden = !ready;
    $("needs-nmi").hidden = !(usage && !network);
    if (usage) renderUsageSummary();
  }

  // ---------------------------------------------------------- upload ----

  function initUpload() {
    const drop = $("dropzone");
    const input = $("file-input");

    $("file-button").addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      if (input.files?.[0]) readFile(input.files[0]);
    });
    for (const ev of ["dragenter", "dragover"]) {
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
    }
    for (const ev of ["dragleave", "drop"]) {
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
    }
    drop.addEventListener("drop", (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) readFile(file);
    });
    $("replace-usage").addEventListener("click", () => {
      usage = null;
      localStorage.removeItem(USAGE_KEY);
      $("upload-error").hidden = true;
      $("mapping").hidden = true;
      updateStage();
    });
    $("mapping-apply").addEventListener("click", applyMapping);
  }

  function readFile(file) {
    if (file.size > 80 * 1024 * 1024) {
      showUploadError(`That file is ${(file.size / 1e6).toFixed(0)} MB, which is far larger than a year of interval data. Check it's the right file.`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => showUploadError("The file couldn't be read.");
    reader.onload = () => ingest(String(reader.result), file.name);
    reader.readAsText(file);
  }

  function ingest(text, filename, mapping) {
    $("upload-error").hidden = true;
    $("mapping").hidden = true;
    try {
      const region = network?.region || "NSW";
      const parsed = parseUsage(text, { region, mapping });
      usage = parsed;
      try {
        localStorage.setItem(USAGE_KEY, JSON.stringify(parsed));
      } catch {
        /* over quota — the session still works, it just won't persist */
      }
      pendingFile = null;
      updateStage();
      if (network) recompute();
    } catch (err) {
      if (err.needsMapping && err.header) {
        pendingFile = { text, header: err.header };
        showMapping(err.header);
      } else {
        showUploadError(err.message);
      }
    }
  }

  function showUploadError(msg) {
    const el = $("upload-error");
    el.textContent = msg;
    el.hidden = false;
  }

  function showMapping(header) {
    const guess = detectColumns(header);
    const opts = (sel) => header.map((h, i) =>
      `<option value="${i}"${i === sel ? " selected" : ""}>${esc(h || `column ${i + 1}`)}</option>`
    ).join("");
    $("map-from").innerHTML = `<option value="-1">—</option>` + opts(guess.from);
    $("map-type").innerHTML = `<option value="-1">—</option>` + opts(guess.type);
    $("map-amount").innerHTML = `<option value="-1">—</option>` + opts(guess.amount);
    $("map-import").innerHTML = `<option value="-1">—</option>` + opts(guess.importCol);
    $("map-export").innerHTML = `<option value="-1">—</option>` + opts(guess.exportCol);
    $("mapping").hidden = false;
  }

  function applyMapping() {
    if (!pendingFile) return;
    const v = (id) => Number($(id).value);
    ingest(pendingFile.text, null, {
      from: v("map-from"), type: v("map-type"), amount: v("map-amount"),
      importCol: v("map-import"), exportCol: v("map-export"),
    });
  }

  function renderUsageSummary() {
    const m = usage.meta || {};
    const warn = (m.warnings || []).map((w) => `<li>${esc(w)}</li>`).join("");
    $("usage-summary").innerHTML = `
      <div class="usage-facts">
        <span><b>${fmtK(m.totalImport || 0)}</b> kWh imported</span>
        <span><b>${fmtK(m.totalExport || 0)}</b> kWh exported</span>
        <span><b>${usage.days.length}</b> days, ${usage.start} → ${usage.end}</span>
        <span class="usage-fmt">${esc(m.format || "CSV")}</span>
      </div>
      ${warn ? `<ul class="usage-warn">${warn}</ul>` : ""}`;
  }

  // ------------------------------------------------------------- NMI ----

  function applyNmi(input, { silent } = {}) {
    const parsed = parseNmi(input);
    const status = $("nmi-status");

    if (!parsed.ok) {
      status.innerHTML = `<span class="nmi-err">${esc(parsed.error)}</span>`;
      showEmpty();
      return;
    }

    const entry = catalogue.networks.find((n) => n.key === parsed.network.key);
    if (!entry) {
      status.innerHTML = `<span class="nmi-err">` +
        `${esc(parsed.network.name)} (${esc(parsed.region)}) is a known network, but no plan ` +
        `bundle has been built for it yet. Run <code>node scripts/fetch-plans.mjs --network ` +
        `${esc(parsed.network.key)}</code> then <code>node scripts/build-data.mjs</code>.</span>`;
      showEmpty();
      return;
    }

    localStorage.setItem(NMI_KEY, parsed.nmi + (parsed.checksumValid === true ? parsed.checksum : ""));

    const bits = [
      `<b>${esc(entry.name)}</b> · ${esc(entry.region)}`,
      `${entry.planCount} plans from ${entry.brandCount} retailers`,
    ];
    if (parsed.warning) bits.push(`<span class="nmi-warn">${esc(parsed.warning)}</span>`);
    if (parsed.ambiguous) bits.push(`<span class="nmi-warn">${esc(parsed.ambiguous)}</span>`);
    status.innerHTML = bits.join(" · ");

    if (network?.key === entry.key) { updateStage(); return; }   // already loaded
    network = entry;
    updateStage();
    if (usage) $("busy").classList.add("on");
    fetch(`data/${entry.file}`)
      .then((r) => r.json())
      .then((p) => {
        plans = p.plans;
        $("meta-line").textContent =
          `${plans.length} plans · ${new Set(plans.map((x) => x.brandName)).size} retailers · ` +
          `${entry.name} · built ${(catalogue.builtAt || "").slice(0, 10)}`;
        if (usage) recompute(); else $("busy").classList.remove("on");
      })
      .catch((e) => {
        status.innerHTML = `<span class="nmi-err">Couldn't load ${esc(entry.file)}: ${esc(e.message)}</span>`;
        $("busy").classList.remove("on");
      });
  }

  function showEmpty() {
    plans = []; results = []; network = null;
    $("rank-body").innerHTML = "";
    $("stats").innerHTML = "";
    $("count-line").textContent = "";
    $("meta-line").textContent = "no network selected";
    updateStage();
  }

  function initControls() {
    const hours = [];
    for (let h = 0; h < 24; h++) hours.push(h);
    const opt = (h) => `<option value="${h * 60}">${String(h).padStart(2, "0")}:00</option>`;
    $("night-start").innerHTML = hours.map(opt).join("");
    $("night-end").innerHTML = hours.map(opt).join("");
    $("night-start").value = state.nightStart;
    $("night-end").value = state.nightEnd;

    const debounced = debounce(recompute, 300);
    $("ev-kwh").addEventListener("input", () => {
      state.evKwh = +$("ev-kwh").value;
      $("ev-kwh-out").textContent = fmtK(state.evKwh);
      $("ev-km").textContent = fmtK(state.evKwh / 15 * 100);
      debounced();
    });
    $("ev-split").addEventListener("input", () => {
      state.nightShare = +$("ev-split").value / 100;
      $("ev-split-out").textContent = $("ev-split").value + "%";
      debounced();
    });
    $("night-start").addEventListener("change", () => { state.nightStart = +$("night-start").value; recompute(); });
    $("night-end").addEventListener("change", () => { state.nightEnd = +$("night-end").value; recompute(); });
    $("opt-conditional").addEventListener("change", () => { state.conditional = $("opt-conditional").checked; rerank(); });
    $("opt-restricted").addEventListener("change", () => { state.showRestricted = $("opt-restricted").checked; render(); });
    $("opt-all-plans").addEventListener("change", () => { state.showAll = $("opt-all-plans").checked; render(); });
    $("search").addEventListener("input", () => { state.search = $("search").value.trim().toLowerCase(); render(); });

    $("drawer-scrim").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

    const applyDebounced = debounce(() => applyNmi($("nmi-input").value), 400);
    $("nmi-input").addEventListener("input", applyDebounced);
    $("nmi-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyNmi($("nmi-input").value);
    });
  }

  function debounce(fn, ms) {
    let t;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  // -------------------------------------------------------- recompute ----

  function recompute() {
    if (!usage || !plans.length) { $("busy").classList.remove("on"); return; }
    $("busy").classList.add("on");
    setTimeout(() => {
      const series = Engine.applyEv(usage, {
        evNightKwh: state.evKwh * state.nightShare,
        evDayKwh: state.evKwh * (1 - state.nightShare),
        nightStart: state.nightStart,
        nightEnd: state.nightEnd,
        dayStart: 9 * 60,
        dayEnd: 16 * 60,
      });
      results = [];
      for (const plan of plans) {
        const bill = Engine.computeBill(plan, usage, series, {});
        if (!bill.unsupported && isFinite(bill.baseTotal)) results.push({ plan, bill });
      }
      window.__series = series; // for drawer / debugging
      rerank();
      $("busy").classList.remove("on");
    }, 30);
  }

  function totalOf(r) {
    return state.conditional ? r.bill.withConditional : r.bill.baseTotal;
  }

  function rerank() {
    results.sort((a, b) => totalOf(a) - totalOf(b));
    render();
  }

  // ----------------------------------------------------------- render ----

  function visibleResults() {
    let list = results;
    if (!state.showRestricted) list = list.filter((r) => !r.plan.restricted);
    if (state.search) {
      list = list.filter((r) =>
        (r.plan.brandName + " " + r.plan.displayName).toLowerCase().includes(state.search));
    }
    if (!state.showAll) {
      const seen = new Set();
      list = list.filter((r) => {
        if (seen.has(r.plan.brandName)) return false;
        seen.add(r.plan.brandName);
        return true;
      });
    }
    return list;
  }

  function badgesFor(r) {
    const b = [];
    if (r.plan.type === "STANDING") b.push(['standing offer', 'badge']);
    if (r.plan.restricted) b.push(["membership required", "badge warn"]);
    if (r.bill.flags.includes("WHOLESALE_ESTIMATE")) b.push(["wholesale — estimate", "badge warn"]);
    if (r.bill.flags.includes("DEMAND")) b.push(["demand charges", "badge warn"]);
    if (r.bill.conditionalDiscount > 0) {
      b.push([(state.conditional ? "incl. " : "") + "conditional −" + fmt$(r.bill.conditionalDiscount), state.conditional ? "badge good" : "badge info"]);
    }
    if (r.bill.memberFees > 0) b.push(["fees +" + fmt$(r.bill.memberFees), "badge"]);
    if (r.bill.flags.includes("TOU_GAPS")) b.push(["tou gaps", "badge warn"]);
    return b;
  }

  function render() {
    const list = visibleResults();
    const best = list.length ? totalOf(list[0]) : 0;

    // stat band
    const totImp = usage.importKwh.reduce((a, x) => a + x, 0) + state.evKwh * state.nightShare;
    const totExp = usage.exportKwh.reduce((a, x) => a + x, 0);
    const median = list.length ? totalOf(list[Math.floor(list.length / 2)]) : 0;
    $("stats").innerHTML = `
      <div class="stat"><div class="k">Grid import (with EV)</div>
        <div class="v">${fmtK(totImp)} <small>kWh/yr</small></div>
        <div class="sub">${fmtK(totExp)} kWh solar exported</div></div>
      <div class="stat hero"><div class="k">Best annual cost</div>
        <div class="v">${list.length ? fmt$(best) : "—"}</div>
        <div class="sub">${list.length ? esc(list[0].plan.brandName) + " — " + esc(list[0].plan.displayName) : ""}</div></div>
      <div class="stat"><div class="k">Median plan</div>
        <div class="v">${fmt$(median)}</div>
        <div class="sub">across ${list.length} ranked ${state.showAll ? "plans" : "retailers"}</div></div>
      <div class="stat"><div class="k">Best vs median</div>
        <div class="v">${fmt$(median - best)} <small>saved/yr</small></div>
        <div class="sub">by picking the top plan</div></div>`;

    // table
    const rows = [];
    list.forEach((r, i) => {
      const t = totalOf(r);
      const badges = badgesFor(r).map(([txt, cls]) => `<span class="${cls}">${esc(txt)}</span>`).join("");
      rows.push(`<tr data-pid="${esc(r.plan.planId)}" class="${i === 0 ? "best-row" : ""}">
        <td class="num">${i + 1}</td>
        <td class="retailer">${esc(r.plan.brandName)}</td>
        <td class="plan-name" title="${esc(r.plan.displayName)}">${esc(r.plan.displayName)}</td>
        <td class="num cost">${fmt$(t)}</td>
        <td class="num delta ${t - best < 0.5 ? "zero" : ""}">${t - best < 0.5 ? "best" : "+" + fmt$(t - best)}</td>
        <td class="num">${fmt$(r.bill.supply)}</td>
        <td class="num">${fmt$(r.bill.usage + r.bill.demand)}</td>
        <td class="num credit-val">−${fmt$(r.bill.fit)}</td>
        <td>${badges}</td>
      </tr>`);
    });
    $("rank-body").innerHTML = rows.join("");
    $("count-line").textContent = `${list.length} of ${results.length} plans shown` +
      (state.showAll ? "" : " · best per retailer") +
      (state.showRestricted ? "" : " · membership plans hidden");

    for (const tr of $("rank-body").querySelectorAll("tr")) {
      tr.addEventListener("click", () => openDrawer(tr.dataset.pid));
    }
  }

  // ----------------------------------------------------------- drawer ----

  function windowText(w) {
    const t = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const days = w.days.length === 7 ? "every day" :
      w.days.map((d) => dayNames[d]).join(", ");
    return `${t(w.start)}–${t(w.end === 1440 ? 0 : w.end)} ${days}`;
  }

  function blocksText(blocks) {
    return blocks.map((b) =>
      (b.limit != null ? `first ${b.limit} kWh: ` : blocks.length > 1 ? "then: " : "") +
      (b.price * Engine.GST * 100).toFixed(2) + "c"
    ).join(" · ");
  }

  function openDrawer(pid) {
    const r = results.find((x) => x.plan.planId === pid);
    if (!r) return;
    const p = r.plan, b = r.bill;

    // rates table rows
    const rateRows = [];
    for (const tp of p.tariffPeriods) {
      const season = tp.startDate === "01-01" && tp.endDate === "12-31" ? "All year" :
        tp.startDate === "07-01" && tp.endDate === "06-30" ? "All year" :
        `${tp.startDate} → ${tp.endDate}`;
      rateRows.push(`<tr><td>${esc(season)}</td><td>Daily supply</td>
        <td class="num">${(tp.dailySupplyCharge * Engine.GST * 100).toFixed(2)}c/day</td><td></td></tr>`);
      if (tp.singleRate) {
        rateRows.push(`<tr><td></td><td>Anytime</td>
          <td class="num">${blocksText(tp.singleRate.blocks)}</td><td></td></tr>`);
      }
      for (const tou of tp.touRates || []) {
        rateRows.push(`<tr><td></td><td>${esc(tou.type)}</td>
          <td class="num">${blocksText(tou.blocks)}</td>
          <td class="win">${tou.windows.map(windowText).map(esc).join("<br>")}</td></tr>`);
      }
    }
    const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    for (const dc of p.demandCharges || []) {
      const months = dc.months.length === 12 ? "all year" :
        dc.months.map((m) => MON[m]).join(" ");
      rateRows.push(`<tr><td>${esc(months)}</td><td>Demand${dc.approx ? " (approx)" : ""}</td>
        <td class="num">${(dc.amount * Engine.GST * 100).toFixed(2)}c/kW/${dc.chargePeriod.toLowerCase()}</td>
        <td class="win">${esc(windowText({ days: dc.days, start: dc.start, end: dc.end }))}</td></tr>`);
    }

    const fitRows = p.fitGroups.map((g, i) => {
      const chosen = b.fitOptions.length && b.fitOptions[0].displayName === g.displayName;
      const tiers = g.tiers.map((t) =>
        (t.limit != null ? `first ${t.limit} kWh/${t.period === "P1D" ? "day" : t.period}: ` : g.tiers.length > 1 ? "then: " : "") +
        (t.price * 100).toFixed(2) + "c" +
        (t.windows ? ` (${t.windows.map(windowText).join("; ")})` : "")
      ).join(" · ");
      return `<li>${chosen ? "<b>→ " : ""}${esc(g.displayName)}: ${esc(tiers)}${chosen ? " (used in this estimate)</b>" : ""}</li>`;
    }).join("");

    const notes = [];
    if (p.type === "STANDING") notes.push("This is a standing offer — the regulator's default contract, usually beatable.");
    if (b.flags.includes("WHOLESALE_ESTIMATE")) notes.push("Wholesale pass-through pricing: the rates in the government data are the retailer's <b>estimate</b>; your real cost varies with the spot market. With your export volume this can swing far in either direction.");
    if (b.flags.includes("DEMAND")) notes.push("Demand charges are estimated the way retailers describe billing them: your single highest half-hour draw (kW) inside the window each month sets that month's demand, charged for <b>every</b> day of the month." + (b.flags.includes("DEMAND_APPROX") ? " The window or unit wasn't fully machine-readable and was inferred from fine print — treat the demand line as approximate." : ""));
    if (b.flags.includes("TOU_GAPS")) notes.push(`The published time-of-use windows don't cover ${b.unmatchedKwh.toFixed(0)} kWh of your usage; those were priced at the off-peak rate.`);
    for (const n of b.discountNotes) notes.push(esc(n));
    if (p.restricted) notes.push("Eligibility restricted: " + p.eligibility.map((e) => esc(e.information || e.type)).join("; "));
    if (p.benefitPeriod) notes.push("Benefit period: " + esc(p.benefitPeriod));

    const incentives = p.incentives.map((i) => `<li><b>${esc(i.displayName)}</b> — ${esc(i.description)}</li>`).join("");
    const t = state.conditional ? b.withConditional : b.baseTotal;
    const emeId = p.planId.replace(/@EME$/, "");

    $("drawer-inner").innerHTML = `
      <button class="drawer-close" id="drawer-close">esc ✕</button>
      <div class="drawer-brand">${esc(p.brandName)} · ${esc(p.type === "STANDING" ? "standing offer" : "market offer")} · ${esc(p.pricingModel.replace(/_/g, " ").toLowerCase())}</div>
      <h2>${esc(p.displayName)}</h2>

      <div class="bill-grid">
        <div class="lab">Daily supply charges</div><div class="r">${fmt$2(b.supply)}</div>
        <div class="lab">Usage charges${Object.keys(b.buckets).length > 1 ? " (" + Object.entries(b.buckets).map(([k, v]) => `${k.toLowerCase()} ${fmtK(v.kwh)} kWh`).join(", ") + ")" : ""}</div><div class="r">${fmt$2(b.usage)}</div>
        ${b.demand ? `<div class="lab">Demand charges</div><div class="r">${fmt$2(b.demand)}</div>` : ""}
        ${b.guaranteedDiscount ? `<div class="lab">Guaranteed discounts</div><div class="r cr">−${fmt$2(b.guaranteedDiscount)}</div>` : ""}
        ${state.conditional && b.conditionalDiscount ? `<div class="lab">Conditional discounts</div><div class="r cr">−${fmt$2(b.conditionalDiscount)}</div>` : ""}
        ${b.memberFees ? `<div class="lab">Membership fees</div><div class="r">${fmt$2(b.memberFees)}</div>` : ""}
        <div class="lab">Solar feed-in credit</div><div class="r cr">−${fmt$2(b.fit)}</div>
        <div class="lab total-row">Estimated annual total</div><div class="r total-row">${fmt$(t)}</div>
      </div>

      <h3>Month by month</h3>
      <div class="chart-wrap">${monthlyChart(b)}
        <div class="chart-legend">
          <span><span class="sw" style="background:var(--supply)"></span>Supply</span>
          <span><span class="sw" style="background:var(--usage)"></span>Usage</span>
          ${b.demand ? '<span><span class="sw" style="background:var(--demand)"></span>Demand</span>' : ""}
          <span><span class="sw" style="background:var(--credit)"></span>Solar credit</span>
          <span><span class="sw" style="background:var(--ink); height:2px; width:12px; border-radius:0"></span>Net</span>
        </div>
      </div>

      <h3>Published rates (inc. GST)</h3>
      <table class="rates-table">
        <thead><tr><th>Season</th><th>Charge</th><th>Rate</th><th>When</th></tr></thead>
        <tbody>${rateRows.join("")}</tbody>
      </table>

      <h3>Feed-in tariff options (GST-free)</h3>
      <div class="fine"><ul>${fitRows || "<li>No feed-in tariff published.</li>"}</ul></div>

      ${notes.length ? `<h3>Caveats</h3><div class="fine"><ul>${notes.map((n) => `<li>${n}</li>`).join("")}</ul></div>` : ""}
      ${incentives ? `<h3>Sign-up incentives (not counted)</h3><div class="fine"><ul>${incentives}</ul></div>` : ""}

      <a class="eme-link" href="https://www.energymadeeasy.gov.au/plan?id=${encodeURIComponent(emeId)}" target="_blank" rel="noopener">
        View this plan on Energy Made Easy ↗</a>`;

    $("drawer-close").addEventListener("click", closeDrawer);
    attachChartTips();
    $("drawer").classList.add("open");
    $("drawer").setAttribute("aria-hidden", "false");
    $("drawer-scrim").classList.add("open");
  }

  function closeDrawer() {
    $("drawer").classList.remove("open");
    $("drawer").setAttribute("aria-hidden", "true");
    $("drawer-scrim").classList.remove("open");
  }

  // ------------------------------------------------------------ chart ----

  function monthlyChart(bill) {
    const months = Object.keys(bill.monthly).sort();
    const W = 540, H = 240, padL = 46, padR = 8, padT = 14, padB = 22;
    const iw = W - padL - padR;
    const bw = iw / months.length;

    let maxUp = 0, maxDn = 0;
    const rows = months.map((mk) => {
      const m = bill.monthly[mk];
      const up = m.supply + m.usage + m.demand;
      maxUp = Math.max(maxUp, up);
      maxDn = Math.max(maxDn, m.fit);
      return { mk, m, up };
    });
    const span = maxUp + maxDn || 1;
    const scale = (H - padT - padB) / span;
    const zeroY = padT + maxUp * scale;

    const parts = [];
    // gridline at zero
    parts.push(`<line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="var(--rule)" stroke-width="1"/>`);

    rows.forEach((row, i) => {
      const x = padL + i * bw + bw * 0.18;
      const w = bw * 0.64;
      let y = zeroY;
      const segs = [
        [row.m.supply, "var(--supply)", "Supply"],
        [row.m.usage, "var(--usage)", "Usage"],
        [row.m.demand, "var(--demand)", "Demand"],
      ];
      for (const [val, color] of segs) {
        if (val <= 0) continue;
        const h = val * scale;
        y -= h;
        parts.push(`<rect x="${x.toFixed(1)}" y="${(y + 1).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0.5, h - 2).toFixed(1)}" rx="2" fill="${color}"/>`);
      }
      if (row.m.fit > 0) {
        const h = row.m.fit * scale;
        parts.push(`<rect x="${x.toFixed(1)}" y="${(zeroY + 1).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0.5, h - 2).toFixed(1)}" rx="2" fill="var(--credit)"/>`);
      }
      // net marker
      const net = row.up - row.m.fit;
      const ny = zeroY - net * scale;
      parts.push(`<line x1="${(x - 2).toFixed(1)}" y1="${ny.toFixed(1)}" x2="${(x + w + 2).toFixed(1)}" y2="${ny.toFixed(1)}" stroke="var(--ink)" stroke-width="2"/>`);
      // month label
      const lab = mkLabel(row.mk);
      parts.push(`<text x="${(x + w / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--ink-3)" font-family="var(--mono)">${lab}</text>`);
      // invisible hover target
      parts.push(`<rect class="hov" x="${(padL + i * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}" fill="transparent"
        data-tip="${esc(`${mkLabel(row.mk)} ${row.mk.slice(0, 4)}|Supply ${fmt$2(row.m.supply)}|Usage ${fmt$2(row.m.usage)}${row.m.demand ? "|Demand " + fmt$2(row.m.demand) : ""}|Solar −${fmt$2(row.m.fit)}|Net ${fmt$2(net)}`)}"/>`);
    });

    // y axis ticks
    for (const v of niceTicks(-maxDn, maxUp)) {
      const y = zeroY - v * scale;
      if (y < padT - 2 || y > H - padB) continue;
      parts.push(`<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--ink-3)" font-family="var(--mono)">${v < 0 ? "−$" + Math.abs(v) : "$" + v}</text>`);
      if (Math.abs(v) > 1e-9) parts.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--rule-soft)" stroke-width="1"/>`);
    }

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Monthly cost breakdown">${parts.join("")}</svg>`;
  }

  function mkLabel(mk) {
    return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+mk.slice(5, 7) - 1];
  }

  function niceTicks(lo, hi) {
    const span = hi - lo;
    const step = span > 300 ? 100 : span > 150 ? 50 : span > 60 ? 25 : 10;
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
    return ticks;
  }

  let tipEl = null;
  function attachChartTips() {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "tip";
      document.body.appendChild(tipEl);
    }
    for (const el of document.querySelectorAll(".hov")) {
      el.addEventListener("mousemove", (e) => {
        const lines = el.dataset.tip.split("|");
        tipEl.innerHTML = `<div class="t-head">${esc(lines[0])}</div>` + lines.slice(1).map(esc).join("<br>");
        tipEl.style.display = "block";
        tipEl.style.left = e.clientX + "px";
        tipEl.style.top = e.clientY + "px";
      });
      el.addEventListener("mouseleave", () => { tipEl.style.display = "none"; });
    }
  }
}
