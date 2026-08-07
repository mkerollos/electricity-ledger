/* NMI parsing: validation, checksum, and network (distributor) lookup.
 *
 * Runs unchanged in Node and the browser.
 *
 * The allocation patterns come from AEMO's NMI Allocation List
 * (https://www.aemo.com.au/-/media/Files/Electricity/NEM/Retail_and_Metering/
 *  Metering-Procedures/NMI-Allocation-List.pdf). `cdrNames` maps each network
 * to the distributor strings that actually appear in CDR plan geography —
 * they don't match AEMO's names, and some networks appear under several.
 */

// A NMI is 10 chars from this alphabet; I, O and the letters AEMO excludes
// never appear. An 11th digit, when present, is the checksum.
const NMI_BODY = /^[A-HJ-NP-Z0-9]{10}$/;

export const ALLOCATIONS = [
  { key: "ausgrid", name: "Ausgrid", region: "NSW",
    patterns: [/^NCCC[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/, /^410[234]\d{6}$/],
    cdrNames: ["Ausgrid"] },
  { key: "endeavour", name: "Endeavour Energy", region: "NSW",
    patterns: [/^NEEE[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/, /^431\d{7}$/],
    cdrNames: ["Endeavour"] },
  { key: "essential", name: "Essential Energy", region: "NSW",
    patterns: [/^NAAA[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/,
               /^NBBB[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/,
               /^NDDD[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/,
               /^NFFF[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/,
               /^4001\d{6}$/, /^4508\d{6}$/, /^4204\d{6}$/, /^4407\d{6}$/],
    // Essential publishes several tariff zones; a NMI alone can't tell them
    // apart, so all are offered and the ambiguity is surfaced in the UI.
    cdrNames: ["Essential Energy", "Essential Energy Standard", "Essential Energy Far West"],
    ambiguous: "Essential Energy has separate Standard and Far West tariff zones. " +
               "Plans from both are shown; check your bill for which applies." },
  { key: "evoenergy", name: "Evoenergy (ACT)", region: "ACT",
    patterns: [/^NGGG[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/, /^7001\d{6}$/],
    cdrNames: ["Evoenergy"] },
  { key: "energex", name: "Energex", region: "QLD",
    patterns: [/^QB\d{2}[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/, /^31\d{8}$/],
    cdrNames: ["Energex"] },
  { key: "ergon", name: "Ergon Energy", region: "QLD",
    patterns: [/^QAAA[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/,
               /^QCCC[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/,
               /^QDDD[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/,
               /^QEEE[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/,
               /^QFFF[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/,
               /^QGGG[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/, /^30\d{8}$/],
    cdrNames: ["Ergon"] },
  { key: "sapn", name: "SA Power Networks", region: "SA",
    patterns: [/^SAAA[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/, /^SASMPL\d{4}$/,
               /^200[12]\d{6}$/],
    cdrNames: ["SA Power Networks"] },
  { key: "citipower", name: "CitiPower", region: "VIC",
    patterns: [/^VAAA[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/, /^610[23]\d{6}$/],
    cdrNames: ["Citipower"] },
  { key: "ausnet", name: "AusNet Services", region: "VIC",
    patterns: [/^VBBB[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/, /^630[56]\d{6}$/],
    cdrNames: ["AusNet Services (electricity)"] },
  { key: "powercor", name: "Powercor", region: "VIC",
    patterns: [/^VCCC[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/, /^620[34]\d{6}$/],
    cdrNames: ["Powercor"] },
  { key: "jemena", name: "Jemena", region: "VIC",
    patterns: [/^VDDD[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/, /^6001\d{6}$/],
    cdrNames: ["Jemena"] },
  { key: "united", name: "United Energy", region: "VIC",
    patterns: [/^VEEE[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/, /^640[78]\d{6}$/],
    cdrNames: ["United Energy"] },
  { key: "tasnetworks", name: "TasNetworks", region: "TAS",
    patterns: [/^T000000(?:[0-4]\d{3}|500[01])$/, /^8000\d{6}$/, /^8590[23]\d{5}$/],
    cdrNames: ["TasNetworks"] },
];

// Networks outside the National Electricity Market: no CDR plan data exists.
const OUTSIDE_NEM = [
  { name: "Western Power (WA)", patterns: [/^WAAA[A-HJ-NP-VX-Z0-9][A-HJ-NP-Z0-9]{5}$/, /^800[1-9]\d{6}$/, /^801\d{7}$/] },
  { name: "Horizon Power (WA)", patterns: [/^8021\d{6}$/] },
  { name: "Northern Territory", patterns: [/^250\d{7}$/] },
];

/** AEMO's NMI checksum: a Luhn variant over the 10 characters' ASCII values. */
export function nmiChecksum(nmi) {
  let total = 0;
  for (let i = 0; i < nmi.length; i++) {
    let v = nmi.charCodeAt(nmi.length - 1 - i);
    if (i % 2 === 0) v *= 2;
    for (const d of String(v)) total += Number(d);
  }
  return (10 - (total % 10)) % 10;
}

/**
 * Parse and validate a NMI, returning what we could determine.
 * Accepts 10 chars, or 11 where the last is the checksum digit.
 * @returns {{ok, nmi, checksum, checksumValid, network, region, error, warning}}
 */
export function parseNmi(input) {
  const raw = String(input || "").toUpperCase().replace(/[\s-]/g, "");
  if (!raw) return { ok: false, error: "Enter your NMI." };
  if (raw.length < 10 || raw.length > 11) {
    return { ok: false, error: `A NMI is 10 digits (11 with the checksum); you entered ${raw.length}.` };
  }
  const body = raw.slice(0, 10);
  if (!NMI_BODY.test(body)) {
    return { ok: false, error: "A NMI uses digits and letters only (no I, O, or punctuation)." };
  }

  const expected = nmiChecksum(body);
  let checksumValid = null;
  if (raw.length === 11) checksumValid = Number(raw[10]) === expected;

  const result = { ok: true, nmi: body, checksum: expected, checksumValid };
  if (checksumValid === false) {
    result.warning = `The checksum digit doesn't match (expected ${expected}). ` +
      `Double-check the NMI — it may have a typo.`;
  }

  for (const a of ALLOCATIONS) {
    if (a.patterns.some((p) => p.test(body))) {
      result.network = a;
      result.region = a.region;
      if (a.ambiguous) result.ambiguous = a.ambiguous;
      return result;
    }
  }
  for (const o of OUTSIDE_NEM) {
    if (o.patterns.some((p) => p.test(body))) {
      return { ok: false, nmi: body,
        error: `That NMI is in ${o.name}, which isn't part of the National Electricity Market — ` +
               `the government plan data doesn't cover it.` };
    }
  }
  return { ok: false, nmi: body,
    error: "That NMI doesn't match any known distribution network. Check it against your bill." };
}

export function networkByKey(key) {
  return ALLOCATIONS.find((a) => a.key === key) || null;
}
