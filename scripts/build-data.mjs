#!/usr/bin/env node
/* Normalize cached CDR plan details into one bundle per distribution network,
 * written to web/data/.
 *
 *   node scripts/build-data.mjs
 */
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOCATIONS } from "../web/lib/nmi.mjs";
import { normalizePlan, planServes } from "../web/lib/normalize.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const OUT = join(ROOT, "web", "data");

/* Usage data is deliberately NOT built into web/data: it is personal (a year of
 * half-hourly readings reveals household occupancy) and the deployed app is
 * shared publicly. Users load their own file in the browser, where it stays. */

async function buildPlans() {
  const files = (await readdir(join(RAW, "plan-details"))).filter((f) => f.endsWith(".json"));
  console.log(`\nreading ${files.length} plan details...`);

  // planId -> {normalized, distributors}
  const normalized = [];
  for (const f of files) {
    const d = JSON.parse(await readFile(join(RAW, "plan-details", f), "utf8"));
    const plan = normalizePlan(d, { hasBattery: false, hasSmartMeter: true });
    if (plan) normalized.push(plan);
  }

  const index = { builtAt: new Date().toISOString(), networks: [] };
  await mkdir(OUT, { recursive: true });

  for (const net of ALLOCATIONS) {
    const plans = normalized.filter((p) =>
      planServes({ customerType: "RESIDENTIAL", geography: { distributors: p.distributors } },
                 { cdrNames: net.cdrNames }));
    if (!plans.length) continue;

    // distributors are only needed for bundling; drop from the payload
    const payload = plans.map(({ distributors, ...rest }) => rest);
    const file = `plans-${net.key}.json`;
    await writeFile(join(OUT, file), JSON.stringify({
      network: { key: net.key, name: net.name, region: net.region },
      builtAt: index.builtAt,
      plans: payload,
    }));
    const bytes = (await stat(join(OUT, file))).size;
    index.networks.push({
      key: net.key, name: net.name, region: net.region, file,
      planCount: plans.length,
      brandCount: new Set(plans.map((p) => p.brandName)).size,
      ambiguous: net.ambiguous || null,
    });
    console.log(`  ${net.key.padEnd(13)} ${String(plans.length).padStart(5)} plans  ` +
      `${String(new Set(plans.map((p) => p.brandName)).size).padStart(3)} brands  ` +
      `${(bytes / 1e6).toFixed(1)} MB`);
  }

  await writeFile(join(OUT, "index.json"), JSON.stringify(index, null, 1));
  console.log(`\nindex.json: ${index.networks.length} networks available`);
}

await buildPlans();
