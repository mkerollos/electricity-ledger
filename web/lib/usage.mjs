/* Turn an uploaded interval-data file into the half-hourly series the engine
 * walks, for both NEM12 and the tabular CSVs retailers email out.
 *
 * Design rule: a misread file would produce confident, wrong bills, so this
 * module never guesses silently. Ambiguity either throws with an explanation
 * or is reported in `meta` for the UI to show before anything is priced.
 */
import { looksLikeNem12, parseNem12 } from "./nem12.mjs";

const CONSUMPTION_RE = /consum|import|usage|general|peak|anytime/i;
const EXPORT_RE = /feed\s*in|feed-in|export|generat|solar/i;
const CONTROLLED_RE = /controlled|off\s*peak\s*(1|2)|cl1|cl2/i;

// States observing daylight saving; QLD, WA and NT do not.
const DST_REGIONS = new Set(["NSW", "VIC", "SA", "TAS", "ACT"]);

// ------------------------------------------------------------- CSV bits --

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Parse a timestamp in the shapes these exports actually use. */
function parseTimestamp(s) {
  if (!s) return null;
  const t = s.trim();
  // 2026-06-15T23:30:00+10:00  |  2026-06-15 23:30
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(t);
  if (m) {
    return { date: `${m[1]}-${m[2]}-${m[3]}`, hh: +m[4], mm: +m[5], offset: t.slice(19) || null };
  }
  // 15/06/2026 23:30  (day-first, the Australian convention)
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[T ,]+(\d{1,2}):(\d{2})/.exec(t);
  if (m) {
    const dd = m[1].padStart(2, "0"), mo = m[2].padStart(2, "0");
    return { date: `${m[3]}-${mo}-${dd}`, hh: +m[4], mm: +m[5], offset: null };
  }
  return null;
}

/** Australian DST: first Sunday in October to first Sunday in April. */
function firstSunday(year, month) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  return 1 + ((7 - d.getUTCDay()) % 7);
}
function isDst(dateStr, region) {
  if (!DST_REGIONS.has(region)) return 0;
  const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7), d = +dateStr.slice(8, 10);
  if (m > 4 && m < 10) return 0;
  if (m < 4 || m > 10) return 1;
  if (m === 4) return d < firstSunday(y, 4) ? 1 : 0;
  return d >= firstSunday(y, 10) ? 1 : 0;   // October
}

/**
 * Identify the columns of a tabular export.
 * @returns {{type, amount, from, importCol, exportCol}} indices, -1 when absent
 */
export function detectColumns(header) {
  const h = header.map((x) => x.toLowerCase());
  const find = (re) => h.findIndex((x) => re.test(x));
  return {
    type: find(/usage type|^type$|channel|register|direction/),
    amount: find(/amount|kwh|value|quantity|reading|consumption/),
    from: find(/from|start|date.*time|timestamp|interval date|^date$/),
    importCol: find(/consumption \(kwh\)|import|usage \(kwh\)/),
    exportCol: find(/feed.?in|export/),
  };
}

function parseTabular(text, mapping) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error("The file is empty.");

  const header = splitCsvLine(lines[0]);
  const cols = mapping || detectColumns(header);

  // Two shapes exist: a type column plus one amount column, or separate
  // import/export columns on each row.
  const typed = cols.type >= 0 && cols.amount >= 0 && cols.from >= 0;
  const wide = cols.from >= 0 && (cols.importCol >= 0 || cols.exportCol >= 0);
  if (!typed && !wide) {
    const err = new Error(
      "Couldn't work out which columns hold the readings. Expected a timestamp " +
      "column plus either a usage-type and amount column, or separate import " +
      `and export columns. Found: ${header.join(", ")}`);
    err.header = header;
    err.needsMapping = true;
    throw err;
  }

  const imp = new Map(), exp = new Map(), ctl = new Map();
  const offsets = new Map();
  let skipped = 0, unknownType = new Set();

  for (let i = 1; i < lines.length; i++) {
    const row = splitCsvLine(lines[i]);
    const ts = parseTimestamp(row[cols.from]);
    if (!ts) { skipped++; continue; }
    const slot = ts.hh * 2 + (ts.mm >= 30 ? 1 : 0);
    if (!(slot >= 0 && slot < 48)) { skipped++; continue; }
    const key = `${ts.date}|${slot}`;
    if (ts.offset) offsets.set(ts.date, ts.offset);

    const add = (map, v) => { if (Number.isFinite(v)) map.set(key, (map.get(key) || 0) + v); };

    if (typed) {
      const v = Number(row[cols.amount]);
      if (!Number.isFinite(v)) { skipped++; continue; }
      const label = row[cols.type] || "";
      if (CONTROLLED_RE.test(label)) add(ctl, v);
      else if (EXPORT_RE.test(label)) add(exp, v);
      else if (CONSUMPTION_RE.test(label)) add(imp, v);
      else { skipped++; unknownType.add(label.slice(0, 30)); }
    } else {
      if (cols.importCol >= 0) add(imp, Number(row[cols.importCol]));
      if (cols.exportCol >= 0) add(exp, Number(row[cols.exportCol]));
    }
  }

  if (!imp.size && !exp.size) {
    throw new Error(
      "No usable readings found. The columns were identified but every row " +
      "failed to parse — check the timestamp and number formats.");
  }
  return { imp, exp, ctl, offsets, skipped, unknownType: [...unknownType] };
}

// ------------------------------------------------------------ assembly --

function channelsToMaps(parsed) {
  const imp = new Map(), exp = new Map(), ctl = new Map();
  for (const [suffix, byDate] of parsed.channels) {
    let target = null;
    if (/^E1/.test(suffix)) target = imp;
    else if (/^E[2-9]/.test(suffix)) target = ctl;
    else if (/^B/.test(suffix)) target = exp;
    else continue;                                   // K*/Q* reactive
    for (const [date, slots] of byDate) {
      for (let s = 0; s < 48; s++) {
        if (!slots[s]) continue;
        const key = `${date}|${s}`;
        target.set(key, (target.get(key) || 0) + slots[s]);
      }
    }
  }
  return { imp, exp, ctl, offsets: new Map(), skipped: 0, unknownType: [] };
}

/**
 * Parse an uploaded file into the engine's usage object.
 * @param {string} text
 * @param {{days?:number, region?:string, mapping?:object}} [opts]
 */
export function parseUsage(text, opts = {}) {
  const windowDays = opts.days || 365;
  const region = opts.region || "NSW";
  const warnings = [];
  let format, nmi = null, hasControlledLoad = false;

  let bits;
  if (looksLikeNem12(text)) {
    format = "NEM12";
    const parsed = parseNem12(text);
    nmi = parsed.nmi;
    hasControlledLoad = parsed.hasControlledLoad;
    warnings.push(...parsed.warnings);
    bits = channelsToMaps(parsed);
  } else {
    format = "CSV";
    bits = parseTabular(text, opts.mapping);
    hasControlledLoad = bits.ctl.size > 0;
  }

  const { imp, exp, ctl, offsets } = bits;
  const allDays = [...new Set(
    [...imp.keys(), ...exp.keys(), ...ctl.keys()].map((k) => k.slice(0, 10)))].sort();
  if (!allDays.length) throw new Error("No dated readings found in the file.");

  // Use the most recent whole window so every season appears exactly once.
  const end = allDays[allDays.length - 1];
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const startMs = endMs - (windowDays - 1) * 86400000;
  const firstMs = Date.parse(`${allDays[0]}T00:00:00Z`);

  const days = [];
  for (let ms = startMs; ms <= endMs; ms += 86400000) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }

  const importKwh = [], exportKwh = [], controlledKwh = [], dayOfWeek = [], dst = [];
  let daysWithData = 0;
  for (const ds of days) {
    dayOfWeek.push((new Date(`${ds}T00:00:00Z`).getUTCDay() + 6) % 7);
    const off = offsets.get(ds);
    dst.push(off ? (off === "+11:00" ? 1 : 0) : isDst(ds, region));
    let any = false;
    for (let s = 0; s < 48; s++) {
      const key = `${ds}|${s}`;
      const i = imp.get(key) || 0, e = exp.get(key) || 0, c = ctl.get(key) || 0;
      if (i || e || c) any = true;
      // Controlled load is folded into import: the engine can't price a
      // separate CL tariff yet, so it is charged at main rates. That
      // overstates cost (CL rates are cheaper), which is the safe direction.
      importKwh.push(Math.round((i + c) * 1e4) / 1e4);
      exportKwh.push(Math.round(e * 1e4) / 1e4);
      controlledKwh.push(Math.round(c * 1e4) / 1e4);
    }
    if (any) daysWithData++;
  }

  const totalImport = importKwh.reduce((a, b) => a + b, 0);
  const totalExport = exportKwh.reduce((a, b) => a + b, 0);
  const totalControlled = controlledKwh.reduce((a, b) => a + b, 0);

  const coverage = daysWithData / days.length;
  if (coverage < 0.9) {
    warnings.push(
      `Only ${daysWithData} of ${days.length} days in the year have readings ` +
      `(${Math.round(coverage * 100)}% coverage). Annual costs are scaled from ` +
      `what's present, so they'll understate a full year.`);
  }
  if (firstMs > startMs) {
    warnings.push(
      `The file starts ${allDays[0]}, so the year before that is empty. ` +
      `A full 12 months gives a far more reliable comparison.`);
  }
  if (hasControlledLoad) {
    warnings.push(
      `Controlled load detected (${totalControlled.toFixed(0)} kWh). It's priced ` +
      `at main tariff rates because separate controlled-load pricing isn't ` +
      `implemented yet — that overstates cost on plans offering it.`);
  }
  if (!totalExport) {
    warnings.push("No solar export found — plans are ranked on consumption alone.");
  }
  if (bits.unknownType?.length) {
    warnings.push(`Ignored unrecognised usage types: ${bits.unknownType.join(", ")}`);
  }

  return {
    start: days[0],
    end: days[days.length - 1],
    days, dayOfWeek, dst, importKwh, exportKwh,
    meta: {
      format, nmi, totalImport, totalExport, totalControlled,
      hasControlledLoad,
      rowsSkipped: bits.skipped || 0,
      daysWithData, daysInWindow: days.length,
      coverage, warnings,
    },
  };
}

/** Back-compat alias for the original CSV-only entry point. */
export const parseUsageCsv = parseUsage;
