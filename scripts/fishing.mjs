#!/usr/bin/env node
/**
 * au-fishing — Australian fishing-conditions CLI for the au-fishing skill.
 *
 * Data sources
 *   - WillyWeather API v2 : tides / wind / swell / sunrise-sunset / moon   (needs key)
 *   - OpenStreetMap Overpass : piers, breakwaters, groynes, fishing spots  (keyless)
 *   - Nominatim             : geocoding fallback                           (keyless)
 *
 * No runtime dependencies. Node >= 18 (global fetch).
 *
 * Borrowed from Volare-Consulting-Software/fishon (MIT):
 *   - the two-layer output idea (human table + machine JSON)
 *   - haversine distance + cluster-collapse for spot de-duplication
 *   Deliberately NOT borrowed: its NOAA tide provider, Fish Rules regulations,
 *   and FishWeather Playwright scraper — all US-only.
 */

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const API_BASE = "https://api.willyweather.com.au/v2";
// Public Overpass instances, tried in order. They go down independently and
// the "fast" failures are 502s, so a single endpoint is not enough.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
].filter(Boolean);
// Point this at a self-hosted instance if the public ones keep throttling you.
if (process.env.AF_OVERPASS_URL) OVERPASS_ENDPOINTS.unshift(process.env.AF_OVERPASS_URL);
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
// NSW Marine Protected Areas (ArcGIS REST, PUBLIC folder). 311 zones statewide.
// In ArcGIS a point is "lng,lat" — the reverse of every other API here.
const MPA_LAYER =
  "https://spatial.industry.nsw.gov.au/arcgis/rest/services/PUBLIC/Marine_Protected_Areas/MapServer/0";
// Keyless fallback for wind/swell when no WillyWeather key is present.
const OPEN_METEO_MARINE = "https://marine-api.open-meteo.com/v1/marine";
const OPEN_METEO_WX = "https://api.open-meteo.com/v1/forecast";
const UA = "au-fishing-skill/0.1 (personal, non-commercial)";

// Ask for metric explicitly. Account defaults win if the server ignores this,
// so normaliseUnits() below converts ft/mph back if needed.
const UNITS =
  "tideHeight:m,swellHeight:m,speed:kmh,temperature:c,amount:mm,pressure:hpa,distance:km";

const FORECASTS = "tides,wind,swell,sunrisesunset,moonphases";

// ---------------------------------------------------------------- utilities

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) {
      flags._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return { command, flags };
}

const pad = (n) => String(n).padStart(2, "0");

const DEBUG = process.env.AF_DEBUG === "1";
async function timed(label, fn) {
  if (!DEBUG) return fn();
  const t = Date.now();
  try {
    return await fn();
  } finally {
    console.error(`[debug] ${label}: ${Date.now() - t}ms`);
  }
}

/** "YYYY-MM-DD HH:MM:SS" (location-local, no zone) -> { date, min } */
function splitDT(s) {
  if (!s) return null;
  const [date, time] = s.split(" ");
  const [h, m] = (time ?? "00:00:00").split(":").map(Number);
  return { date, min: h * 60 + m };
}

function fmtMin(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// -------------------------------------------------------------- data access

/** Never let an API key reach a log, a terminal, or a screenshot. */
const redact = (u) => String(u).replace(/\/v2\/[^/]+\//g, "/v2/***/").replace(/(key=)[^&]+/gi, "$1***");

async function jget(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", ...headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${redact(url)}\n${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${redact(url)}\n${text.slice(0, 300)}`);
  }
}

/**
 * POST to Overpass. The body must be `data=<encodeURIComponent(q)>` — spaces
 * as %20. URLSearchParams encodes them as "+", which Overpass rejects.
 */
let overpassPreferred = null; // remember the last healthy instance

async function overpass(query, timeoutMs = 10000) {
  const order = overpassPreferred
    ? [overpassPreferred, ...OVERPASS_ENDPOINTS.filter((e) => e !== overpassPreferred)]
    : OVERPASS_ENDPOINTS;
  let lastErr;
  for (const endpoint of order) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (DEBUG) console.error(`[debug] overpass via ${endpoint}`);
      overpassPreferred = endpoint;
      return data;
    } catch (err) {
      lastErr = err;
      if (DEBUG) console.error(`[debug] overpass ${endpoint} failed: ${err.message}`);
    }
  }
  throw new Error(
    `All Overpass endpoints failed (${lastErr?.message}).\n` +
      "Public Overpass instances actively throttle automated use and are often down.\n" +
      "Options: retry later, or set AF_OVERPASS_URL to your own instance."
  );
}

const KEY_FILE = join(process.env.HOME ?? "", ".config", "willyweather.key");

function readKeyFile() {
  try {
    return readFileSync(KEY_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function wwKey() {
  const k = process.env.WILLYWEATHER_API_KEY || readKeyFile();
  if (!k) {
    throw new Error(
      "WILLYWEATHER_API_KEY is not set.\n" +
        "Get a key at https://www.willyweather.com.au/api/register.html then either\n" +
        `  export WILLYWEATHER_API_KEY=xxxxx   or   put it in ${KEY_FILE}\n` +
        "Without it, conditions falls back to Open-Meteo (no tides)."
    );
  }
  return k;
}

async function ww(path, params = {}) {
  const url = new URL(`${API_BASE}/${wwKey()}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return jget(url, { "Content-Type": "application/json" });
}

async function resolveLocation(queryOrId) {
  if (/^\d+$/.test(queryOrId)) return ww(`/locations/${queryOrId}.json`);
  const hits = await ww("/search.json", { query: queryOrId, limit: 5 });
  const list = Array.isArray(hits) ? hits : [hits];
  if (!list.length) throw new Error(`No WillyWeather location matched "${queryOrId}".`);
  return list[0];
}

async function getWeather(id, days) {
  const data = await ww(`/locations/${id}/weather.json`, {
    forecasts: FORECASTS,
    days,
    units: UNITS,
  });
  return data;
}

// ------------------------------------------------------------- normalisation

/** Convert to metres / km-h if the API ignored our units request. */
function normaliseUnits(weather) {
  const f = weather?.forecasts ?? {};
  const m = f.tides?.units?.height === "ft" ? 0.3048 : 1;
  const s = f.swell?.units?.height === "ft" ? 0.3048 : 1;
  const wUnit = f.wind?.units?.speed;
  const w = wUnit === "mph" ? 1.60934 : wUnit === "knots" || wUnit === "kn" ? 1.852 : 1;
  for (const d of f.tides?.days ?? [])
    for (const e of d.entries ?? []) e.height = +(e.height * m).toFixed(2);
  for (const d of f.swell?.days ?? [])
    for (const e of d.entries ?? []) e.height = +(e.height * s).toFixed(2);
  for (const d of f.wind?.days ?? [])
    for (const e of d.entries ?? []) e.speed = +(e.speed * w).toFixed(1);
  return weather;
}

// ------------------------------------------------------------- day modelling

function buildDays(weather) {
  const f = weather.forecasts ?? {};
  const days = new Map();
  const day = (k) => {
    if (!days.has(k)) {
      days.set(k, { date: k, tides: [], wind: [], swell: [], sun: null, moon: null });
    }
    return days.get(k);
  };

  for (const d of f.tides?.days ?? []) {
    for (const e of d.entries ?? []) {
      const t = splitDT(e.dateTime);
      if (t) day(t.date).tides.push({ min: t.min, height: Number(e.height), type: e.type });
    }
  }
  for (const d of f.wind?.days ?? []) {
    for (const e of d.entries ?? []) {
      const t = splitDT(e.dateTime);
      if (t)
        day(t.date).wind.push({
          min: t.min,
          speed: Number(e.speed),
          direction: Number(e.direction),
          dirText: e.directionText,
        });
    }
  }
  for (const d of f.swell?.days ?? []) {
    for (const e of d.entries ?? []) {
      const t = splitDT(e.dateTime);
      if (t)
        day(t.date).swell.push({
          min: t.min,
          height: Number(e.height),
          period: Number(e.period),
          direction: Number(e.direction),
          dirText: e.directionText,
        });
    }
  }
  for (const d of f.sunrisesunset?.days ?? []) {
    const e = (d.entries ?? [])[0];
    const t = splitDT(e?.riseDateTime);
    if (t) {
      day(t.date).sun = {
        rise: splitDT(e.riseDateTime)?.min ?? null,
        set: splitDT(e.setDateTime)?.min ?? null,
        firstLight: splitDT(e.firstLightDateTime)?.min ?? null,
        lastLight: splitDT(e.lastLightDateTime)?.min ?? null,
      };
    }
  }
  for (const d of f.moonphases?.days ?? []) {
    const e = (d.entries ?? [])[0];
    const t = splitDT(e?.riseDateTime) ?? splitDT(d.dateTime);
    if (t && e) {
      day(t.date).moon = {
        phase: e.phase,
        phaseCode: e.phaseCode,
        pctFull: Number(e.percentageFull),
        hemisphere: e.hemisphere,
      };
    }
  }
  for (const d of days.values()) d.tides.sort((a, b) => a.min - b.min);
  return days;
}

/** Tide height + flow rate at any minute-of-day, built across all days. */
function tideModel(allDays) {
  const dates = [...allDays.keys()].sort();
  if (!dates.length) return null;
  const base = dates[0];
  const baseMs = new Date(`${base}T00:00:00Z`).getTime();
  const abs = (date, min) =>
    Math.round((new Date(`${date}T00:00:00Z`).getTime() - baseMs) / 60000) + min;

  const events = [];
  for (const d of allDays.values())
    for (const e of d.tides) events.push({ abs: abs(d.date, e.min), height: e.height, type: e.type });
  events.sort((a, b) => a.abs - b.abs);
  if (events.length < 2) return null;

  function bracket(t) {
    if (t <= events[0].abs) return { a: events[0], b: events[0], p: 0, edge: true };
    const last = events[events.length - 1];
    if (t >= last.abs) return { a: last, b: last, p: 0, edge: true };
    for (let i = 0; i < events.length - 1; i++) {
      const a = events[i];
      const b = events[i + 1];
      if (t >= a.abs && t <= b.abs) {
        return { a, b, p: (t - a.abs) / (b.abs - a.abs || 1), edge: false };
      }
    }
    return { a: last, b: last, p: 0, edge: true };
  }

  return {
    heightAt(date, min) {
      const { a, b, p } = bracket(abs(date, min));
      return a.height + (b.height - a.height) * p;
    },
    /** metres per hour of tide movement; 0 at slack (high/low) */
    flowAt(date, min) {
      const { a, b, p, edge } = bracket(abs(date, min));
      if (edge || b.abs === a.abs) return 0;
      const peak = Math.abs(b.height - a.height) / ((b.abs - a.abs) / 60);
      return peak * Math.sin(Math.PI * p);
    },
  };
}

function nearest(entries, min, maxGapMin = 240) {
  let best = null;
  let bestD = Infinity;
  for (const e of entries) {
    const d = Math.abs(e.min - min);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best && bestD <= maxGapMin ? best : null;
}

// ------------------------------------------------------------------ scoring

/**
 * Slot score 0-100. Weights are deliberately explicit so a human can argue
 * with them. This is a heuristic, not a bite-probability model.
 *   35% moving water (tide flow)
 *   30% low light (dawn/dusk)
 *   20% wind (calm enough to cast / hold bottom)
 *   10% swell (some wash is good, too much is dangerous)
 *    5% tide range (spring > neap, more water moving)
 *
 * `flowScore` is pre-normalised against the best flow of that day: absolute
 * thresholds do not transfer between a 1.3m Sydney spring tide and a 4m
 * top-end tide, so "fraction of today's best run" is the portable signal.
 */
function scoreSlot({ flowScore, wind, swell, light, rangeScore }) {
  const windScore = clamp01((30 - wind) / 20); // 0 @30km/h, 1 @<=10km/h
  const swellScore =
    swell == null ? 0.6 : clamp01(1 - Math.abs(swell - 1.0) / 1.6); // 1.0m ideal
  const parts = { flow: flowScore, light, wind: windScore, swell: swellScore, range: rangeScore };
  // Drop missing components and renormalise — otherwise a keyless run (no
  // tides) caps out around 60 and every score silently means something else.
  let num = 0;
  let den = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const p = parts[k];
    if (p == null) continue;
    num += w * p;
    den += w;
  }
  const total = den > 0 ? (100 * num) / den : 0;
  return { total: Math.round(total), parts };
}

const WEIGHTS = { flow: 0.35, light: 0.3, wind: 0.2, swell: 0.1, range: 0.05 };
const PART_LABELS = { flow: "潮水", light: "光线", wind: "风", swell: "涌", range: "潮差" };
/** Which factor is actually driving the score (weight-adjusted, not raw). */
function dominant(parts) {
  return Object.entries(parts)
    .filter(([, v]) => v != null)
    .sort((a, b) => b[1] * WEIGHTS[b[0]] - a[1] * WEIGHTS[a[0]])
    .slice(0, 1)
    .map(([k]) => PART_LABELS[k])
    .join("");
}

function analyseDay(d, model, opts = {}) {
  const winds = d.wind.map((w) => w.speed);
  const swells = d.swell.map((s) => s.height);
  const heights = d.tides.map((t) => t.height);
  const range = heights.length ? Math.max(...heights) - Math.min(...heights) : 0;

  // pass 1 — raw metrics
  const raw = [];
  for (let min = 0; min < 1440; min += 30) {
    const tideH = d.tides.length ? model?.heightAt(d.date, min) ?? null : null;
    const flow = d.tides.length ? model?.flowAt(d.date, min) ?? 0 : 0;
    const w = nearest(d.wind, min);
    const s = nearest(d.swell, min);
    const sun = d.sun;
    const light = sun
      ? Math.max(
          sun.rise != null ? clamp01(1 - Math.abs(min - sun.rise) / 120) : 0,
          sun.set != null ? clamp01(1 - Math.abs(min - sun.set) / 120) : 0
        )
      : 0;
    raw.push({
      min,
      tideH,
      flow,
      wind: w?.speed ?? null,
      windDir: w?.dirText ?? null,
      swell: s?.height ?? null,
      swellPeriod: s?.period ?? null,
      swellDir: s?.dirText ?? null,
      light,
    });
  }

  // pass 2 — score, with flow normalised against this day's best run
  const maxFlow = Math.max(0, ...raw.map((s) => s.flow));
  const rangeScore = clamp01(range / 1.8); // 1.8m spring range ≈ 1.0
  const hasTide = d.tides.length > 0;
  const slots = raw.map((s) => {
    const scored = scoreSlot({
      flowScore: hasTide && maxFlow > 0 ? clamp01(s.flow / (0.85 * maxFlow)) : undefined,
      wind: s.wind ?? 20,
      swell: s.swell,
      light: s.light,
      rangeScore: hasTide ? rangeScore : undefined,
    });
    return { ...s, score: scored.total, parts: scored.parts };
  });

  // contiguous windows above threshold, >= 60 min, best 3
  const THRESHOLD = 55;
  const windows = [];
  let run = null;
  for (const s of slots) {
    if (s.score >= THRESHOLD) {
      if (!run) run = { start: s.min, end: s.min + 30, slots: [s] };
      else {
        run.end = s.min + 30;
        run.slots.push(s);
      }
    } else if (run) {
      windows.push(run);
      run = null;
    }
  }
  if (run) windows.push(run);

  const ranked = windows
    .filter((w) => w.end - w.start >= 60)
    .map((w) => {
      const avg = Math.round(w.slots.reduce((a, s) => a + s.score, 0) / w.slots.length);
      const peak = w.slots.reduce((a, s) => (s.score > a.score ? s : a));
      return { ...w, avg, peak };
    })
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 3);

  const warnings = [];
  const maxSwell = swells.length ? Math.max(...swells) : 0;
  const maxWind = winds.length ? Math.max(...winds) : 0;
  if (maxSwell >= 2.0)
    warnings.push(`涌浪 ${maxSwell.toFixed(1)}m — 岩石/礁石位风险高，堤坝上注意越浪`);
  if (maxWind >= 25) warnings.push(`风 ${maxWind.toFixed(0)}km/h — 小船/皮划艇不建议出`);
  if (!d.tides.length)
    warnings.push(
      opts.noTideHint ??
        "该地点没有潮汐数据（WillyWeather 只对部分 location type 提供）"
    );

  return {
    date: d.date,
    tideRange: +range.toFixed(2),
    tideEvents: d.tides,
    windMax: maxWind ? +maxWind.toFixed(0) : null,
    swellMax: maxSwell ? +maxSwell.toFixed(1) : null,
    swellPeriod: d.swell.length
      ? [Math.min(...d.swell.map((s) => s.period)), Math.max(...d.swell.map((s) => s.period))]
      : null,
    sun: d.sun,
    moon: d.moon,
    windows: ranked.map((w) => ({
      start: fmtMin(w.start),
      end: w.end > 1440 ? `次日 ${fmtMin(w.end)}` : fmtMin(w.end),
      avgScore: w.avg,
      peakScore: w.peak.score,
      peakAt: fmtMin(w.peak.min),
      dominant: dominant(w.peak.parts),
      flowAtPeak: +w.peak.flow.toFixed(2),
      tideAtPeak: w.peak.tideH == null ? null : +w.peak.tideH.toFixed(2),
      windAtPeak: w.peak.wind,
      windDirAtPeak: w.peak.windDir,
      swellAtPeak: w.peak.swell,
      swellPeriodAtPeak: w.peak.swellPeriod,
      parts: w.peak.parts,
    })),
    warnings,
  };
}

// ------------------------------------------------------------------ output

function renderReport(location, analyses, meta = {}) {
  const out = [];
  out.push(
    `# ${location.name}${location.region ? `, ${location.region}` : ""}` +
      (location.state ? ` (${location.state})` : "")
  );
  out.push(
    `数据源 ${meta.source ?? "?"} · ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)} · ${location.timeZone}`
  );
  for (const z of meta.zones ?? []) {
    out.push(
      z.noTake
        ? `- 🚫 **${z.name} — ${z.zone}：禁钓区**`
        : `- ⚠️ ${z.name} — ${z.zone}：有分区限制，出发前查具体规则`
    );
  }
  out.push("");
  for (const a of analyses) {
    out.push(`## ${a.date}`);
    const tide = a.tideEvents.length
      ? a.tideEvents
          .map((t) => `${fmtMin(t.min)} ${t.type === "high" ? "高" : "低"} ${t.height.toFixed(2)}m`)
          .join(" · ")
      : "无潮汐数据";
    out.push(`- **潮汐** ${tide}${a.tideRange ? `（振幅 ${a.tideRange.toFixed(2)}m）` : ""}`);
    if (a.windMax != null)
      out.push(`- **风** 最大 ${a.windMax}km/h`);
    if (a.swellMax != null)
      out.push(
        `- **涌浪** 最大 ${a.swellMax}m` +
          (a.swellPeriod ? `，周期 ${a.swellPeriod[0]}–${a.swellPeriod[1]}s` : "")
      );
    if (a.sun)
      out.push(
        `- **日月** 日出 ${fmtMin(a.sun.rise)} / 日落 ${fmtMin(a.sun.set)}` +
          (a.moon ? ` · 月 ${a.moon.pctFull}% ${a.moon.phase ?? ""}` : "")
      );
    if (a.windows.length) {
      out.push("");
      out.push("| 窗口 | 均分 | 峰值 | 主导 | 潮 | 风 | 涌 |");
      out.push("|---|---|---|---|---|---|---|");
      for (const w of a.windows) {
        out.push(
          `| ${w.start}–${w.end} | ${w.avgScore} | ${w.peakScore} @${w.peakAt} | ${w.dominant} | ` +
            `${w.tideAtPeak == null ? "—" : `${w.flowAtPeak.toFixed(2)}m/h`} | ` +
            `${w.windAtPeak ?? "?"}km/h ${w.windDirAtPeak ?? ""} | ` +
            `${w.swellAtPeak ?? "?"}m${w.swellPeriodAtPeak ? `/${w.swellPeriodAtPeak}s` : ""} |`
        );
      }
    } else {
      out.push("");
      out.push("_没有达到 55 分阈值的窗口。_");
    }
    for (const w of a.warnings) out.push(`- ⚠️ ${w}`);
    out.push("");
  }
  out.push(
    "_分数是启发式（潮水 35% / 光线 30% / 风 20% / 涌 10% / 潮差 5%），不是鱼获预测。_"
  );
  if (String(meta.source ?? "").startsWith("WillyWeather"))
    out.push("_天气数据 © WillyWeather · 基于 Bureau of Meteorology 数据_");
  return out.join("\n");
}

// ------------------------------------------------------------ MPA zoning

const NO_TAKE = /sanctuary/i;

/** Which NSW marine park zone (if any) contains this point. */
async function mpaAt(lat, lng) {
  const url =
    `${MPA_LAYER}/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint` +
    `&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    `&outFields=NAME,TYPE,ZONE_TYPE&returnGeometry=false&f=json`;
  const data = await jget(url);
  return (data.features ?? []).map((f) => ({
    name: f.attributes.NAME,
    type: f.attributes.TYPE,
    zone: f.attributes.ZONE_TYPE,
    noTake: NO_TAKE.test(f.attributes.ZONE_TYPE ?? ""),
  }));
}

// -------------------------------------------------------- Open-Meteo fallback

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg) => COMPASS[Math.round(((deg % 360) / 22.5)) % 16] ?? "?";

/**
 * Build a WillyWeather-shaped payload from Open-Meteo so the rest of the
 * pipeline does not care where the numbers came from. Tides and moon are
 * simply absent — downstream code already tolerates that.
 */
async function openMeteoPayload(geo, days) {
  const q = `latitude=${geo.lat}&longitude=${geo.lng}&timezone=auto&forecast_days=${days}`;
  const [marine, wx] = await Promise.all([
    jget(`${OPEN_METEO_MARINE}?${q}&hourly=wave_height,wave_period,wave_direction`),
    jget(`${OPEN_METEO_WX}?${q}&hourly=wind_speed_10m,wind_direction_10m&daily=sunrise,sunset&wind_speed_unit=kmh`),
  ]);

  const byDay = (times, build) => {
    const days = new Map();
    times.forEach((t, i) => {
      const [date, clock] = t.split("T");
      const v = build(i);
      if (v == null) return;
      if (!days.has(date)) days.set(date, { dateTime: `${date} 00:00:00`, entries: [] });
      days.get(date).entries.push({ dateTime: `${date} ${clock}:00`, ...v });
    });
    return [...days.values()];
  };

  const swellDays = byDay(marine.hourly?.time ?? [], (i) =>
    marine.hourly.wave_height[i] == null
      ? null
      : {
          height: marine.hourly.wave_height[i],
          period: marine.hourly.wave_period?.[i],
          direction: marine.hourly.wave_direction?.[i],
          directionText: compass(marine.hourly.wave_direction?.[i] ?? 0),
        }
  );
  const realWindDays = byDay(wx.hourly?.time ?? [], (i) =>
    wx.hourly.wind_speed_10m?.[i] == null
      ? null
      : {
          speed: wx.hourly.wind_speed_10m[i],
          direction: wx.hourly.wind_direction_10m?.[i],
          directionText: compass(wx.hourly.wind_direction_10m?.[i] ?? 0),
        }
  );

  const sunDays = (wx.daily?.time ?? []).map((date, i) => {
    const rise = wx.daily.sunrise?.[i]?.split("T")[1];
    const set = wx.daily.sunset?.[i]?.split("T")[1];
    return {
      dateTime: `${date} 00:00:00`,
      entries: [
        {
          riseDateTime: rise ? `${date} ${rise}:00` : null,
          setDateTime: set ? `${date} ${set}:00` : null,
        },
      ],
    };
  });

  return {
    location: {
      id: "open-meteo",
      name: geo.name ?? "?",
      region: "",
      state: geo.state ?? "",
      lat: geo.lat,
      lng: geo.lng,
      timeZone: wx.timezone ?? "Australia/Sydney",
      typeId: 2,
    },
    forecasts: {
      wind: { units: { speed: "kmh" }, days: realWindDays },
      swell: { units: { height: "m" }, days: swellDays },
      sunrisesunset: { days: sunDays },
    },
  };
}

// -------------------------------------------------------------------- spots

async function geocode(query) {
  const url = new URL(NOMINATIM);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  const res = await jget(url.toString(), { "Accept-Language": "en" });
  if (!res.length) throw new Error(`Could not geocode "${query}".`);
  const label = res[0].display_name;
  const parts = label.split(",").map((x) => x.trim());
  const state = parts.find((x) => /^(NSW|VIC|QLD|WA|SA|TAS|NT|ACT)$/.test(x)) ?? "";
  return { lat: Number(res[0].lat), lng: Number(res[0].lon), label, name: parts[0], state };
}

async function findSpots(lat, lng, radiusKm) {
  const r = Math.round(radiusKm * 1000);
  const q = `[out:json][timeout:30];(
    node["man_made"="pier"](around:${r},${lat},${lng});
    way["man_made"="pier"](around:${r},${lat},${lng});
    node["man_made"="breakwater"](around:${r},${lat},${lng});
    way["man_made"="breakwater"](around:${r},${lat},${lng});
    node["man_made"="groyne"](around:${r},${lat},${lng});
    way["man_made"="groyne"](around:${r},${lat},${lng});
    node["leisure"="fishing"](around:${r},${lat},${lng});
    way["leisure"="fishing"](around:${r},${lat},${lng});
  );out center tags;`;
  const data = await overpass(q);

  const kindOf = (tags = {}) => {
    if (tags.leisure === "fishing") return "钓鱼点";
    if (tags.man_made === "pier") return "栈桥";
    if (tags.man_made === "breakwater") return "防波堤";
    if (tags.man_made === "groyne") return "丁坝";
    return "结构";
  };

  const spots = [];
  for (const el of data.elements ?? []) {
    const elLat = el.lat ?? el.center?.lat;
    const elLng = el.lon ?? el.center?.lon;
    if (elLat == null || elLng == null) continue;
    // Private jetties dominate Sydney waterfront tagging; they are not fishable.
    if (["private", "no"].includes(el.tags?.access)) continue;
    const kind = kindOf(el.tags);
    // Named structures first; unnamed ones are still useful (a groyne is a
    // groyne) so keep them as a fallback rather than dropping them.
    const named = el.tags?.name;
    spots.push({
      name: named ?? `未命名${kind}`,
      named: Boolean(named),
      kind,
      lat: elLat,
      lng: elLng,
      km: +haversineKm(lat, lng, elLat, elLng).toFixed(1),
    });
  }
  // collapse near-duplicates (node + way of the same pier), keep nearest
  spots.sort((a, b) => Number(b.named) - Number(a.named) || a.km - b.km);
  const kept = [];
  for (const s of spots) {
    if (kept.some((k) => haversineKm(k.lat, k.lng, s.lat, s.lng) < 0.15)) continue;
    kept.push(s);
    if (kept.length >= 25) break;
  }
  return kept;
}


// -------------------------------------------------------------- local data

const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
const SPECIES_FILE = join(DATA_DIR, "species.json");
const MARKS_FILE = join(DATA_DIR, "reefs.json"); // shared/public marks (committed)
const LOCAL_MARKS_FILE = join(DATA_DIR, "reefs.local.json"); // personal marks (gitignored)
const CATCH_FILE = join(DATA_DIR, "catches.jsonl");

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

const norm = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function matchSpecies(db, query) {
  const q = norm(query);
  if (!q) return [];
  const hits = [];
  for (const sp of db.species ?? []) {
    const hay = [sp.name, sp.group, ...(sp.aliases ?? [])].filter(Boolean).map(norm);
    let score = 0;
    for (const h of hay) {
      if (h === q) score = Math.max(score, 3);
      else if (h.includes(q)) score = Math.max(score, 2);
      else if (q.includes(h) && h.length > 3) score = Math.max(score, 1);
    }
    if (score) hits.push({ sp, score });
  }
  return hits.sort((a, b) => b.score - a.score).map((h) => h.sp);
}

function legalCheck(sp, sizeCm) {
  if (sp.protected || sp.bagLimit === 0)
    return { ok: false, reason: `${sp.name} 禁捕（release only）` };
  if (sizeCm == null) return { ok: null, reason: "没给尺寸，无法判断合规" };
  if (sp.maxCm != null && sizeCm > sp.maxCm)
    return { ok: false, reason: `${sizeCm}cm 超过上限 ${sp.maxCm}cm——必须放回` };
  if (sp.minCm != null && sizeCm < sp.minCm)
    return { ok: false, reason: `${sizeCm}cm 小于下限 ${sp.minCm}cm——必须放回` };
  if (sp.maxRule) return { ok: true, reason: `尺寸合规，但注意：${sp.maxRule}` };
  return { ok: true, reason: "尺寸合规" };
}

function describeSpecies(sp) {
  const size =
    sp.minCm == null && sp.maxCm == null
      ? "无尺寸限制"
      : `${sp.minCm ?? "—"}${sp.maxCm != null ? `–${sp.maxCm}` : "+"}cm`;
  const bag = sp.bagLimit == null ? "袋限不明" : `袋限 ${sp.bagLimit}`;
  const poss = sp.possessionLimit ? ` · 持有 ${sp.possessionLimit}` : "";
  return `${size} · ${bag}${poss}${sp.grouped ? "（组合上限）" : ""}`;
}

async function cmdSpecies(flags) {
  const db = await readJson(SPECIES_FILE, { species: [] });
  if (!db.species?.length)
    throw new Error("data/species.json 缺失或为空。");

  if (flags.legal || flags.size) {
    const name = flags.legal && flags.legal !== true ? flags.legal : flags.q;
    if (!name || name === true) throw new Error('需要鱼名：--legal "Dusky Flathead" [--size 42]');
    const hits = matchSpecies(db, name);
    if (!hits.length) throw new Error(`规则表里没有匹配 "${name}" 的鱼种。`);
    const sp = hits[0];
    const sizeCm = flags.size != null ? Number(flags.size) : null;
    const verdict = legalCheck(sp, sizeCm);
    if (flags.json)
      return console.log(JSON.stringify({ species: sp, sizeCm, verdict }, null, 2));
    console.log(`# ${sp.name}`);
    console.log(describeSpecies(sp));
    if (sp.closedSeason) console.log(`禁渔期：${sp.closedSeason}`);
    if (sp.notes) console.log(`注意：${sp.notes}`);
    console.log("");
    const mark = verdict.ok === false ? "❌" : verdict.ok === true ? "✅" : "❔";
    console.log(`${mark} ${verdict.reason}`);
    console.log(`\n_${db.jurisdiction} 规则，数据截至 ${db.asOf}。以 ${db.source} 为准。_`);
    return;
  }

  const q = flags.q && flags.q !== true ? flags.q : null;
  const list = q ? matchSpecies(db, q) : db.species;
  if (!list.length) throw new Error(`没有匹配 "${q}" 的鱼种。`);
  if (flags.json) return console.log(JSON.stringify({ query: q, count: list.length, species: list }, null, 2));

  console.log(`# ${db.jurisdiction} 海水鱼种规则${q ? ` — "${q}"` : ""}（${list.length} 条）\n`);
  console.log("| 鱼种 | 尺寸 | 袋限 | 备注 |");
  console.log("|---|---|---|---|");
  for (const sp of list) {
    const note = [sp.closedSeason && `禁渔 ${sp.closedSeason}`, sp.protected && "禁捕", sp.notes]
      .filter(Boolean)
      .join("；");
    console.log(
      `| ${sp.name} | ${sp.minCm ?? "—"}${sp.maxCm != null ? `–${sp.maxCm}` : ""} | ${sp.bagLimit ?? "?"} | ${note.slice(0, 80)} |`
    );
  }
  console.log(
    `\n_未列出的鱼种默认袋限 ${db.defaultBagLimit}。${db.possessionRule}_`
  );
  console.log(`_数据截至 ${db.asOf}，来源 ${db.source}_`);
}

async function readCatches() {
  try {
    const txt = await readFile(CATCH_FILE, "utf8");
    return txt
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function cmdCatch(flags) {
  if (!flags.species || flags.species === true)
    throw new Error('Usage: fishing.mjs catch --species "Dusky Flathead" [--size 42] [--spot "..."] [--released] [--tide rising] [--note "..."]');
  const db = await readJson(SPECIES_FILE, { species: [] });
  const sp = matchSpecies(db, flags.species)[0] ?? null;
  const sizeCm = flags.size != null ? Number(flags.size) : null;
  const now = new Date();
  const date =
    flags.date ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = flags.time ?? `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const rec = {
    date,
    time,
    spot: flags.spot && flags.spot !== true ? flags.spot : null,
    species: sp?.name ?? String(flags.species),
    rawSpecies: sp ? undefined : String(flags.species),
    sizeCm,
    kept: !flags.released,
    tide: flags.tide && flags.tide !== true ? flags.tide : null,
    note: flags.note && flags.note !== true ? flags.note : null,
    loggedAt: now.toISOString(),
  };

  if (sp && sizeCm != null) {
    const v = legalCheck(sp, sizeCm);
    rec.legal = v.ok;
    if (v.ok === false && rec.kept) console.log(`❌ 这条不该留：${v.reason}`);
    else if (v.ok === false && !rec.kept) console.log(`✅ 放流正确：${v.reason}`);
    else if (v.ok === true) console.log(`✅ ${v.reason}`);
  } else if (!sp) {
    console.log(`ℹ️ "${flags.species}" 不在规则表里，已按原名记录。`);
  }

  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(CATCH_FILE, JSON.stringify(rec) + "\n");
  const all = await readCatches();
  console.log(
    `已记录：${rec.date} ${rec.time} · ${rec.species}${sizeCm ? ` ${sizeCm}cm` : ""} · ${rec.kept ? "留下" : "放流"}${rec.spot ? ` @ ${rec.spot}` : ""}`
  );
  console.log(`累计 ${all.length} 条 → ${CATCH_FILE}`);
}

function bucketOf(hour) {
  if (hour < 5) return "深夜 00–05";
  if (hour < 9) return "清晨 05–09";
  if (hour < 16) return "白天 09–16";
  if (hour < 20) return "黄昏 16–20";
  return "夜间 20–24";
}

async function cmdStats(flags) {
  const all = await readCatches();
  if (!all.length) {
    console.log("还没有记录。用 catch 记第一条：");
    console.log('  fishing.mjs catch --species "Dusky Flathead" --size 42 --spot "Narrabeen" --tide falling');
    return;
  }
  const by = (keyFn) => {
    const m = new Map();
    for (const c of all) {
      const k = keyFn(c) ?? "未知";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const bySpecies = by((c) => c.species);
  const bySpot = by((c) => c.spot);
  const byHour = by((c) => bucketOf(Number((c.time ?? "12:00").split(":")[0])));
  const byTide = by((c) => c.tide);
  const kept = all.filter((c) => c.kept).length;
  const sized = all.filter((c) => typeof c.sizeCm === "number");
  const illegal = all.filter((c) => c.legal === false && c.kept);

  if (flags.json)
    return console.log(
      JSON.stringify({ total: all.length, kept, released: all.length - kept, bySpecies, bySpot, byHour, byTide, sized: sized.length, illegalKept: illegal.length }, null, 2)
    );

  console.log(`# 钓获统计（${all.length} 条，留下 ${kept} / 放流 ${all.length - kept}）`);
  const span = [all[0].date, all[all.length - 1].date].sort();
  console.log(`${span[0]} → ${span[1]}\n`);
  const table = (title, rows) => {
    console.log(`**${title}**`);
    for (const [k, v] of rows.slice(0, 8)) console.log(`- ${k}: ${v}`);
    console.log("");
  };
  table("鱼种", bySpecies);
  table("钓点", bySpot);
  table("时段", byHour);
  if (byTide.length && byTide[0][0] !== "未知") table("潮态", byTide);

  if (sized.length) {
    const sizes = sized.map((c) => c.sizeCm);
    console.log(`**尺寸** ${Math.min(...sizes)}–${Math.max(...sizes)}cm，平均 ${(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(1)}cm`);
  }
  if (illegal.length) console.log(`\n⚠️ ${illegal.length} 条记录里，尺寸不合规却保留了 —— 这种数据会影响后续校准。`);
  console.log("\n_样本还小的时候这些只是描述性统计，不足以改权重。攒到 30 条以上再看。_");
}

async function loadMarks() {
  const pub = (await readJson(MARKS_FILE, { marks: [] })).marks ?? [];
  const own = (await readJson(LOCAL_MARKS_FILE, { marks: [] })).marks ?? [];
  return [...pub, ...own];
}

async function saveMarks(marks, file = LOCAL_MARKS_FILE) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      { version: 1, note: "手工维护的点位。verified=false 表示未核对来源。", marks },
      null,
      2
    ) + "\n"
  );
}

const ACCESS_LABEL = { boat: "船钓", kayak: "皮划艇/SUP", shore: "岸钓", unknown: "岸边可达性未核实" };

async function cmdMarks(flags) {
  if (flags.add || flags._[0] === "add") {
    const name = flags.name;
    const lat = Number(flags.lat);
    const lng = Number(flags.lng);
    if (!name || name === true || !Number.isFinite(lat) || !Number.isFinite(lng))
      throw new Error('Usage: fishing.mjs marks add --name "Sydney OAR" --lat -33.85 --lng 151.30 [--type reef|fad|wreck] [--depth 38]');
    // Personal marks go to the gitignored file unless --public is passed.
    const target = flags.public ? MARKS_FILE : LOCAL_MARKS_FILE;
    const marks = (await readJson(target, { marks: [] })).marks ?? [];
    marks.push({
      name: String(name),
      type: flags.type && flags.type !== true ? String(flags.type) : "reef",
      lat,
      lng,
      depthM: flags.depth != null ? Number(flags.depth) : null,
      note: flags.note && flags.note !== true ? String(flags.note) : null,
      verified: false,
      addedAt: new Date().toISOString(),
    });
    await saveMarks(marks, target);
    console.log(
      `已添加 ${name}。共 ${marks.length} 个点位 → ${target}` +
        (flags.public ? "（公开文件，提交会发布）" : "（本地文件，已 gitignore）")
    );
    return;
  }

  let marks = await loadMarks();
  let origin = null;
  if (flags.near && flags.near !== true) {
    const geo = await geocode(String(flags.near));
    origin = geo;
    const radiusKm = Number(flags.km ?? 50);
    marks = marks
      .map((m) => ({ ...m, km: +haversineKm(geo.lat, geo.lng, m.lat, m.lng).toFixed(1) }))
      .filter((m) => m.km <= radiusKm)
      .sort((a, b) => a.km - b.km);
  }
  if (flags.json) return console.log(JSON.stringify({ origin, marks }, null, 2));
  if (!marks.length) {
    console.log("还没有本地点位。加一个：");
    console.log('  fishing.mjs marks add --name "Sydney OAR" --lat -33.85 --lng 151.30 --type reef');
    return;
  }
  console.log(`# 本地点位${origin ? `（距 ${origin.label.split(",")[0]} ${flags.km ?? 50}km 内）` : ""}\n`);
  for (const m of marks) {
    console.log(
      `- ${m.km != null ? `${m.km}km  ` : ""}**${m.name}** · ${m.type}` +
        `${m.depthM ? ` · ${m.depthM}m` : ""} · ${ACCESS_LABEL[m.access] ?? "?"}` +
        `${m.distanceToAccessKm ? ` · 距下水点 ${m.distanceToAccessKm}km` : ""}` +
        ` · ${m.lat.toFixed(5)},${m.lng.toFixed(5)}${m.verified ? "" : " · 未核对"}`
    );
  }
}

// ------------------------------------------------------------------- doctor

async function cmdDoctor() {
  const envKey = process.env.WILLYWEATHER_API_KEY;
  const fileKey = readKeyFile();
  const key = envKey || fileKey;

  console.log(`key source   : ${envKey ? "env WILLYWEATHER_API_KEY" : fileKey ? KEY_FILE : "none"}`);
  if (key) console.log(`key length   : ${key.length}`);

  if (!key) {
    console.log("WillyWeather : SKIP (no key) — conditions will use Open-Meteo");
  } else {
    try {
      const hits = await ww("/search.json", { query: "Sydney", limit: 1 });
      console.log(`WillyWeather : OK (${Array.isArray(hits) ? hits.length : "?"} result, ${hits?.[0]?.name ?? "?"})`);
    } catch (err) {
      const message = err.message;
      const code = message.match(/"code"\s*:\s*"([^"]+)"/)?.[1] ?? "unknown";
      const desc = message.match(/"description"\s*:\s*"([^"]+)"/)?.[1] ?? message.split("\n")[0];
      console.log(`WillyWeather : FAIL [${code}] ${desc}`);
      if (code === "account-not-enabled")
        console.log("               → 账号未启用。查邮箱确认链接，或在 /account/api.html 看状态。");
    }
  }

  try {
    const zones = await mpaAt(-33.98233, 151.22412);
    console.log(`NSW MPA API  : OK (${zones.length} zone hit at Botany Bay EAR test point)`);
  } catch (err) {
    console.log(`NSW MPA API  : FAIL ${err.message.split("\n")[0]}`);
  }

  const marks = await loadMarks();
  const species = (await readJson(SPECIES_FILE, { species: [] })).species ?? [];
  console.log(`local data   : ${marks.length} marks, ${species.length} species rules`);
}

// --------------------------------------------------------------------- main

async function cmdSpots(flags) {
  const near = flags.near;
  if (!near || near === true)
    throw new Error('Usage: fishing.mjs spots --near "Collaroy Beach" [--km 10]');
  const radiusKm = Number(flags.km ?? 10);
  const geo = await timed("geocode", () => geocode(near));

  // OSM is best-effort: public Overpass instances throttle automated use.
  let osm = [];
  try {
    osm = await timed("overpass", () => findSpots(geo.lat, geo.lng, radiusKm));
    osm.forEach((sp) => (sp.source = "OSM"));
  } catch (err) {
    console.error(`⚠️  OSM 不可用，只显示本地点位。（${err.message.split("\n")[0]}）`);
  }

  // Local marks always work — this is also where your own GPS marks live.
  const local = (await loadMarks())
    .map((m) => ({
      name: m.name,
      kind: m.type ?? "mark",
      lat: m.lat,
      lng: m.lng,
      depthM: m.depthM ?? null,
      access: m.access ?? "unknown",
      verified: m.verified ?? false,
      km: +haversineKm(geo.lat, geo.lng, m.lat, m.lng).toFixed(1),
      source: "local",
    }))
    .filter((m) => m.km <= radiusKm);

  const merged = [...local, ...osm];
  merged.sort((a, b) => a.km - b.km);
  const spots = [];
  for (const sp of merged) {
    if (spots.some((k) => haversineKm(k.lat, k.lng, sp.lat, sp.lng) < 0.15)) continue;
    spots.push(sp);
    if (spots.length >= 30) break;
  }

  const zoneLists = await timed("mpa", () =>
    Promise.all(spots.map((sp) => mpaAt(sp.lat, sp.lng).catch(() => [])))
  );
  spots.forEach((sp, i) => (sp.zones = zoneLists[i]));

  if (flags.json) return console.log(JSON.stringify({ origin: geo, radiusKm, spots }, null, 2));
  console.log(`# 钓点 — ${geo.label}`);
  console.log(`半径 ${radiusKm}km，共 ${spots.length} 处（本地 ${local.length} / OSM ${osm.length}）\n`);
  for (const s of spots) {
    const z = s.zones?.find((x) => x.noTake) ?? s.zones?.[0];
    const tag = z ? (z.noTake ? ` · 🚫 ${z.name}（禁钓）` : ` · ⚠️ ${z.name}（${z.zone}）`) : "";
    const depth = s.depthM ? ` · ${s.depthM}m` : "";
    const acc = s.source === "local" ? ` · ${ACCESS_LABEL[s.access] ?? ""}` : "";
    console.log(
      `- ${s.km}km  **${s.name}** · ${s.kind}${depth}${acc} · ${s.lat.toFixed(5)},${s.lng.toFixed(5)}${tag}`
    );
  }
  console.log("\n_OSM 结构未验证公众可达性；本地点位由你自己维护。_");
}

async function cmdConditions(flags) {
  const at = flags.at;
  if ((!at || at === true) && !flags.fixture)
    throw new Error('Usage: fishing.mjs conditions --at "Collaroy Beach" [--days 3] [--json]');
  const days = Number(flags.days ?? 3);

  let weather;
  let source;
  if (flags.fixture) {
    weather = JSON.parse(await (await import("node:fs/promises")).readFile(flags.fixture, "utf8"));
    source = "fixture";
  } else if (process.env.WILLYWEATHER_API_KEY || readKeyFile()) {
    try {
      const loc = await resolveLocation(at);
      weather = await getWeather(loc.id, days);
      source = "WillyWeather";
    } catch (err) {
      // 401 account-not-enabled, quota exhaustion, or an outage should not
      // be fatal — drop to Open-Meteo and say so.
      console.error(`⚠️  WillyWeather 不可用，降级到 Open-Meteo。（${err.message.split("\n")[0]}）`);
      const geo = await geocode(at);
      weather = await openMeteoPayload(geo, days);
      source = "Open-Meteo（WillyWeather 调用失败，无潮汐）";
    }
  } else {
    // No key: still useful, just without tides/moon.
    const geo = await geocode(at);
    weather = await openMeteoPayload(geo, days);
    source = "Open-Meteo（keyless，无潮汐/月相）";
  }
  normaliseUnits(weather);

  const location = weather.location ?? {
    name: at,
    region: "",
    state: "",
    id: "?",
    lat: 0,
    lng: 0,
    timeZone: "Australia/Sydney",
  };
  const zones = await mpaAt(location.lat, location.lng).catch(() => []);

  const map = buildDays(weather);
  const model = tideModel(map);
  const analyses = [...map.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) =>
      analyseDay(d, model, {
        noTideHint: source.startsWith("Open-Meteo")
          ? "本次数据源 Open-Meteo 不含潮汐——设 WILLYWEATHER_API_KEY 才能算潮流窗口"
          : undefined,
      })
    );

  if (flags.json) {
    console.log(JSON.stringify({ location, source, zones, days: analyses }, null, 2));
    return;
  }
  console.log(renderReport(location, analyses, { source, zones }));
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  try {
    if (command === "spots") await cmdSpots(flags);
    else if (command === "conditions") await cmdConditions(flags);
    else if (command === "species") await cmdSpecies(flags);
    else if (command === "catch") await cmdCatch(flags);
    else if (command === "stats") await cmdStats(flags);
    else if (command === "marks") await cmdMarks(flags);
    else if (command === "doctor") await cmdDoctor();
    else {
      console.log(`au-fishing

  conditions  --at "Collaroy Beach" [--days 3] [--json]     潮汐/风/涌 + 窗口
  spots       --near "Collaroy Beach" [--km 10] [--json]   钓点（本地点位 + OSM）
  species     [--q flathead] [--legal "Dusky Flathead" --size 42]   NSW 尺寸/袋限
  catch       --species "Dusky Flathead" --size 42 [--spot X] [--released] [--tide falling]
  stats       [--json]                                      钓获统计
  marks       [--near X] | marks add --name X --lat Y --lng Z [--type reef] [--depth 30]
  doctor                                                    检查 key / 服务连通性

Env: WILLYWEATHER_API_KEY (only needed for tides; otherwise Open-Meteo fallback)
     AF_OVERPASS_URL (optional self-hosted Overpass)
     AF_DEBUG=1 (timing)`);
      process.exit(command ? 1 : 0);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
