#!/usr/bin/env node
/**
 * import-gutters — pull surf-sat's gutter detections into au-fishing.
 *
 * Source: ~/surf-sat/out/gutters_v3.kml  (v3 detector: OSM hard-structure mask
 * + 60 m corridor excludes rock, reef, cliff and rockpool edges before
 * detection — see surf-sat/GUTTERS_V3.md).
 *
 * Output: data/gutters.json — shore positions where a sand channel meets the
 * beach, tagged by how many independent capture dates confirmed them.
 *
 * Re-run whenever surf-sat publishes a new KML:
 *   node scripts/import-gutters.mjs [path/to/gutters_v3.kml]
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
const OUT = join(DATA_DIR, "gutters.json");
const src = process.argv[2] ?? join(process.env.HOME ?? "", "surf-sat/out/gutters_v3.kml");
const PERSIST = join(process.env.HOME ?? "", "surf-sat/data/gutter_persistence.json");

const xml = await readFile(src, "utf8");
const blocks = xml.match(/<Placemark>[\s\S]*?<\/Placemark>/g) ?? [];

const gutters = [];
for (const block of blocks) {
  const name = block.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim() ?? "";
  const style = block.match(/<styleUrl>#(\w+)<\/styleUrl>/)?.[1] ?? "single";
  const coords = block.match(/<coordinates>([\s\S]*?)<\/coordinates>/)?.[1]?.trim() ?? "";
  const desc = block.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ?? "";
  const [lng, lat] = coords.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

  const site = name.split(/\s/)[0];
  const dates = Number(desc.match(/<b>(\d+) of (\d+) capture dates/)?.[1] ?? 1);
  const nDates = Number(desc.match(/<b>(\d+) of (\d+) capture dates/)?.[2] ?? NaN);
  const lengthM = Number(desc.match(/mean alongshore length (\d+) m/)?.[1] ?? NaN);

  gutters.push({
    name,
    site,
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    confidence: style === "confirm" ? "confirmed" : style === "weak" ? "weak" : "single",
    dates,
    nDates,
    lengthM: Number.isFinite(lengthM) ? lengthM : null,
  });
}

// --- multi-date confirmation -------------------------------------------
// The KML carries the Sydney multi-date run. Beaches that have since been
// re-run through gutter_persistence.py live in gutter_persistence.json;
// for those, the persistent clusters supersede the single-date guesses.
let persistenceSites = [];
try {
  // Python's json.dump can emit bare NaN, which JSON.parse rejects.
  const persist = JSON.parse((await readFile(PERSIST, "utf8")).replace(/\bNaN\b/g, "null"));
  const alreadyConfirmed = new Set(
    gutters.filter((g) => g.confidence === "confirmed").map((g) => g.site)
  );
  persistenceSites = Object.keys(persist).filter((s) => !alreadyConfirmed.has(s));

  for (const site of persistenceSites) {
    const run = persist[site];
    // drop the old single-date guesses for this beach
    for (let i = gutters.length - 1; i >= 0; i--) {
      if (gutters[i].site === site) gutters.splice(i, 1);
    }
    for (const c of run.persistent ?? []) {
      gutters.push({
        name: `${site} gutter (${c.hits}/${run.n_dates})`,
        site,
        lat: Number(c.lat.toFixed(6)),
        lng: Number(c.lon.toFixed(6)),
        confidence: "confirmed",
        dates: c.hits,
        nDates: run.n_dates,
        lengthM: c.mean_len_m ?? null,
      });
    }
  }
} catch (err) {
  // Never fail silently: a parse error here means "no merge", which looks
  // identical to "nothing new" unless we say so.
  console.warn(`  ! gutter_persistence.json not merged: ${err.message}`);
}

const payload = {
  version: 1,
  source: "surf-sat out/gutters_v3.kml",
  method:
    "Gutters detected from ESRI World Imagery (~0.5 m/px). Rock / reef / cliff / " +
    "rockpool / groyne corridors excluded via OSM before detection.",
  caveat:
    "A gutter is a channel where fish cruise, not a guaranteed fish-holding spot. " +
    "Single-date entries are leads, not conclusions. Read the water on the day.",
  persistenceSites,
  counts: {
    total: gutters.length,
    confirmed: gutters.filter((g) => g.confidence === "confirmed").length,
    single: gutters.filter((g) => g.confidence !== "confirmed").length,
  },
  gutters,
};

await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
const sites = new Set(gutters.map((g) => g.site));
console.log(
  `imported ${gutters.length} gutters (${payload.counts.confirmed} confirmed) ` +
    `across ${sites.size} beaches -> ${OUT}`
);
