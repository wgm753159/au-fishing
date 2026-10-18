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

const payload = {
  version: 1,
  source: "surf-sat out/gutters_v3.kml",
  method:
    "Gutters detected from ESRI World Imagery (~0.5 m/px). Rock / reef / cliff / " +
    "rockpool / groyne corridors excluded via OSM before detection.",
  caveat:
    "A gutter is a channel where fish cruise, not a guaranteed fish-holding spot. " +
    "Single-date entries are leads, not conclusions. Read the water on the day.",
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
