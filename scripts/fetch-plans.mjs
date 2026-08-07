#!/usr/bin/env node
/* Fetch electricity plans from the CDR Product Reference Data APIs.
 *
 *   1. ACCC CDR Register  -> energy brands, each with a productBaseUri
 *   2. {base}/cds-au/v1/energy/plans          -> plan lists (with geography)
 *   3. {base}/cds-au/v1/energy/plans/{planId} -> full tariff detail
 *
 * Everything caches under data/raw/, so re-runs only fetch what's missing.
 *
 *   node scripts/fetch-plans.mjs                  # every NEM distributor
 *   node scripts/fetch-plans.mjs --network ausgrid
 *   node scripts/fetch-plans.mjs --refresh-lists  # re-read lists, keep details
 *   node scripts/fetch-plans.mjs --refresh        # ignore every cache
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOCATIONS } from "../web/lib/nmi.mjs";
import { planServes } from "../web/lib/normalize.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const REGISTER = "https://api.cdr.gov.au/cdr-register/v1/energy/data-holders/brands/summary";
const UA = "personal-plan-comparison/1.0 (individual consumer comparing own plans)";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1]?.startsWith("--") ? true : args[i + 1] ?? true) : null;
};
const REFRESH = !!flag("refresh");
// Retailers withdraw plans continuously, so a cached list goes stale within
// hours and its planIds start 404ing. Lists are cheap; refresh them often.
const REFRESH_LISTS = REFRESH || !!flag("refresh-lists");
const ONLY = flag("network");
const CONCURRENCY = Number(flag("concurrency") || 8);

async function getJson(url, { xv, xMinV, retries = 4 } = {}) {
  const headers = { "x-v": String(xv), "User-Agent": UA, Accept: "application/json" };
  if (xMinV) headers["x-min-v"] = String(xMinV);
  let delay = 1500;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
      if (!res.ok) {
        if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries - 1) {
          await sleep(delay); delay *= 2; continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt >= retries - 1) throw err;
      await sleep(delay); delay *= 2;
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cached(path, produce, { stale = false } = {}) {
  if (!stale && existsSync(path)) {
    return JSON.parse(await readFile(path, "utf8"));
  }
  const data = await produce();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data));
  return data;
}

/** Run `worker` over `items` with bounded concurrency. */
async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i).catch((e) => ({ __error: e.message }));
    }
  }));
  return results;
}

const slug = (uri) => uri.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_");

async function main() {
  const networks = ONLY && ONLY !== true
    ? ALLOCATIONS.filter((a) => a.key === ONLY)
    : ALLOCATIONS;
  if (!networks.length) {
    console.error(`Unknown network "${ONLY}". Known: ${ALLOCATIONS.map((a) => a.key).join(", ")}`);
    process.exit(1);
  }

  console.log(`Fetching plans for ${networks.length} network(s): ${networks.map((n) => n.key).join(", ")}\n`);

  const brands = await cached(join(RAW, "brands.json"), () => getJson(REGISTER, { xv: 2 }),
    { stale: REFRESH });
  const baseUris = new Map();
  for (const b of brands.data || []) {
    const uri = (b.productBaseUri || "").trim().replace(/\/+$/, "");
    if (uri) baseUris.set(uri, b.brandName);
  }
  console.log(`${(brands.data || []).length} register brands -> ${baseUris.size} product hosts`);

  // --- plan lists (national, cached per host) -----------------------------
  const hosts = [...baseUris.keys()];
  const failedHosts = [];
  const lists = await pool(hosts, CONCURRENCY, async (uri) => {
    return cached(join(RAW, "plan-lists", `${slug(uri)}.json`), async () => {
      const plans = [];
      for (let page = 1; ; page++) {
        const qs = new URLSearchParams({
          fuelType: "ELECTRICITY", effective: "CURRENT", type: "ALL",
          page: String(page), "page-size": "1000",
        });
        const data = await getJson(`${uri}/cds-au/v1/energy/plans?${qs}`, { xv: 3, xMinV: 1 });
        plans.push(...(data.data?.plans || []));
        if (page >= Number(data.meta?.totalPages || 1)) break;
      }
      return { plans };
    }, { stale: REFRESH_LISTS });
  });

  const allPlans = [];   // {uri, plan}
  lists.forEach((res, i) => {
    if (res?.__error) { failedHosts.push([hosts[i], res.__error]); return; }
    for (const p of res.plans) allPlans.push({ uri: hosts[i], plan: p });
  });
  console.log(`${allPlans.length} electricity plans listed nationally`);
  if (failedHosts.length) {
    console.log("hosts skipped:");
    for (const [uri, err] of failedHosts) console.log(`   ${uri}: ${err}`);
  }

  // --- select the plans each requested network needs ----------------------
  const wanted = new Map();  // planId -> uri
  const perNetwork = {};
  for (const net of networks) {
    const matches = allPlans.filter(({ plan }) => planServes(plan, { cdrNames: net.cdrNames }));
    perNetwork[net.key] = matches.length;
    for (const { uri, plan } of matches) wanted.set(plan.planId, uri);
  }
  console.log("\nplans per network:");
  for (const net of networks) console.log(`   ${net.key.padEnd(13)} ${perNetwork[net.key]}`);
  console.log(`\n${wanted.size} unique plan details required`);

  // --- plan details -------------------------------------------------------
  const entries = [...wanted.entries()];
  let done = 0, fromCache = 0;
  const failedDetails = [];
  await pool(entries, CONCURRENCY, async ([planId, uri]) => {
    const path = join(RAW, "plan-details", `${planId.replace(/[^A-Za-z0-9@._-]+/g, "_")}.json`);
    if (!REFRESH && existsSync(path)) { fromCache++; done++; return; }
    try {
      const data = await getJson(
        `${uri}/cds-au/v1/energy/plans/${encodeURIComponent(planId)}`, { xv: 3, xMinV: 1 });
      const detail = data.data || {};
      detail._meta = { baseUri: uri, fetchedAt: new Date().toISOString() };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(detail));
    } catch (e) {
      failedDetails.push([planId, e.message]);
    }
    done++;
    if (done % 500 === 0) process.stdout.write(`   details ${done}/${entries.length}\n`);
  });

  await writeFile(join(RAW, "index.json"), JSON.stringify({
    fetchedAt: new Date().toISOString(),
    networks: networks.map((n) => ({ key: n.key, name: n.name, region: n.region, cdrNames: n.cdrNames })),
    planCount: wanted.size,
    failedHosts, failedDetails,
  }, null, 1));

  console.log(`\ndetails: ${done - failedDetails.length} ok (${fromCache} cached), ${failedDetails.length} failed`);
  for (const [id, err] of failedDetails.slice(0, 10)) console.log(`   ${id}: ${err}`);
  console.log(`\nNext: node scripts/build-data.mjs`);
}

main().catch((e) => { console.error(e); process.exit(1); });
