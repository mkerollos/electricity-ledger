/* NEM12 parser — the AEMO standard interval-data format that distributor
 * portals (Ausgrid Energy Easy, Endeavour, etc.) hand out.
 *
 * Structure:
 *   100  header
 *   200  NMI data details — declares the channel that following 300s belong to
 *   300  one day of interval values for the current channel
 *   400  interval events (skipped)
 *   500  B2B details (skipped)
 *   900  end
 *
 * A 200 record's fields are:
 *   [0]200 [1]NMI [2]NMIConfiguration [3]RegisterID [4]NMISuffix
 *   [5]MDMDataStreamIdentifier [6]MeterSerialNumber [7]UOM
 *   [8]IntervalLength [9]NextScheduledReadDate
 *
 * Channel suffixes: E = consumption (E1 main, E2+ usually controlled load),
 * B = export to grid, K and Q = reactive power (ignored — not energy).
 *
 * Everything is normalised to 48 half-hour slots per local day.
 */

const ENERGY_UOM = { KWH: 1, WH: 0.001, MWH: 1000 };

/**
 * @param {string} text raw NEM12 file
 * @returns {{nmi, channels, warnings, intervalLengths, hasControlledLoad}}
 *   channels: Map<suffix, Map<'YYYY-MM-DD', Float64Array(48)>>
 */
export function parseNem12(text) {
  const lines = text.split(/\r?\n/);
  const channels = new Map();
  const warnings = [];
  const intervalLengths = new Set();
  const nmis = new Set();

  let current = null;      // active 200 record context
  let sawHeader = false;
  let dayCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = line.split(",");
    const kind = f[0].trim();

    if (kind === "100") { sawHeader = true; continue; }
    if (kind === "900" || kind === "400" || kind === "500") continue;

    if (kind === "200") {
      const nmi = (f[1] || "").trim();
      const suffix = (f[4] || "").trim().toUpperCase();
      const uom = (f[7] || "").trim().toUpperCase();
      const intervalLength = Number(f[8]);
      if (nmi) nmis.add(nmi);

      const scale = ENERGY_UOM[uom];
      if (!scale) {                       // KVARH etc: real but not energy
        current = null;
        continue;
      }
      if (!(intervalLength > 0) || 1440 % intervalLength !== 0) {
        warnings.push(`Line ${i + 1}: unusable interval length "${f[8]}" — block skipped.`);
        current = null;
        continue;
      }
      intervalLengths.add(intervalLength);
      current = { suffix, scale, intervalLength, perDay: 1440 / intervalLength };
      continue;
    }

    if (kind === "300") {
      if (!current) continue;             // 300 under an ignored/invalid 200
      const raw = (f[1] || "").trim();
      if (!/^\d{8}$/.test(raw)) {
        warnings.push(`Line ${i + 1}: bad interval date "${raw}" — row skipped.`);
        continue;
      }
      const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;

      const values = new Array(current.perDay);
      let bad = 0;
      for (let k = 0; k < current.perDay; k++) {
        const v = Number(f[2 + k]);
        if (!Number.isFinite(v)) { values[k] = 0; bad++; } else values[k] = v * current.scale;
      }
      if (bad === current.perDay) {
        warnings.push(`Line ${i + 1}: no numeric values for ${date} — row skipped.`);
        continue;
      }

      const slots = toHalfHours(values, current.intervalLength);
      let byDate = channels.get(current.suffix);
      if (!byDate) channels.set(current.suffix, (byDate = new Map()));
      const existing = byDate.get(date);
      if (existing) {
        for (let k = 0; k < 48; k++) existing[k] += slots[k];  // re-read/duplicate
      } else {
        byDate.set(date, slots);
        dayCount++;
      }
    }
  }

  if (!sawHeader && !channels.size) {
    throw new Error("This doesn't look like a NEM12 file — no 100 header or 300 interval records found.");
  }
  if (!channels.size) {
    throw new Error("The NEM12 file has no energy channels (only reactive power, or unreadable interval blocks).");
  }

  const suffixes = [...channels.keys()];
  const hasControlledLoad = suffixes.some((s) => /^E[2-9]/.test(s));
  if (intervalLengths.size > 1) {
    warnings.push(`File mixes ${[...intervalLengths].join(" and ")}-minute intervals; all were folded into half-hours.`);
  }

  return {
    nmi: nmis.size === 1 ? [...nmis][0] : null,
    channels,
    suffixes,
    hasControlledLoad,
    intervalLengths: [...intervalLengths],
    dayCount,
    warnings,
  };
}

/** Fold N native intervals for a day into 48 half-hour totals. */
function toHalfHours(values, intervalLength) {
  const out = new Float64Array(48);
  if (intervalLength === 30) {
    for (let k = 0; k < 48; k++) out[k] = values[k] || 0;
    return out;
  }
  const per = 30 / intervalLength;              // native intervals per half hour
  if (per >= 1) {
    for (let k = 0; k < values.length; k++) out[Math.floor(k / per)] += values[k] || 0;
    return out;
  }
  // intervals longer than 30 min (rare): spread evenly across the slots covered
  const span = intervalLength / 30;
  for (let k = 0; k < values.length; k++) {
    const share = (values[k] || 0) / span;
    for (let s = 0; s < span; s++) out[k * span + s] += share;
  }
  return out;
}

/** True if `text` looks like NEM12 rather than a tabular CSV export. */
export function looksLikeNem12(text) {
  const head = text.slice(0, 4000);
  if (/^\s*100\s*,\s*NEM12/i.test(head)) return true;
  return /^\s*200\s*,/m.test(head) && /^\s*300\s*,\s*\d{8}\s*,/m.test(head);
}
