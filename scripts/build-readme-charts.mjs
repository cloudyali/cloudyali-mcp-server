// Renders every chart in README.md.
//
// Committed rather than kept in a scratch directory, because a PNG nobody can
// regenerate is a claim rather than a fact. Two claims in particular:
//
//   1. Every chart is Apache ECharts 5. Not a hand-rolled SVG, not CSS bars —
//      the same library portal-v3 uses, so a chart in the docs and a chart in
//      the product come out of the same renderer.
//   2. Every chart uses the theme this server serves at cloudyali://echarts-theme.
//      It is imported from dist/ below, not copied, so the docs cannot drift
//      from the theme a model is told to register.
//
// Figures are illustrative throughout. They are shaped like real bills — compute
// dominant, storage flat, one service climbing, a step change that never came
// back — but no chart here is drawn on a real account, and none should be.
//
//   npm run charts
//
// Needs playwright, echarts and @fontsource/inter, which are NOT dependencies of
// this package: regenerating the docs is a rare job and none of it ships. The
// script says what to install if they are missing.

import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs");

let chromium, ECHARTS_THEME, echartsSrc, FACE;
try {
  ({ chromium } = await import("playwright"));
  ({ ECHARTS_THEME } = await import(join(ROOT, "dist/brand/assets.js")));
  echartsSrc = readFileSync(join(ROOT, "node_modules/echarts/dist/echarts.min.js"), "utf8");
  const fonts = join(ROOT, "node_modules/@fontsource/inter/files");
  // Inter is embedded as a data URI, not linked. A headless renderer without it
  // silently falls back to a serif, which would ship a picture that
  // misrepresents the design system it exists to demonstrate.
  FACE = [400, 600]
    .map((w) => {
      const b64 = readFileSync(join(fonts, `inter-latin-${w}-normal.woff2`)).toString("base64");
      return `@font-face{font-family:Inter;font-weight:${w};font-style:normal;font-display:block;src:url(data:font/woff2;base64,${b64}) format("woff2");}`;
    })
    .join("");
} catch (err) {
  console.error(
    `Missing a chart-rendering dependency: ${err.message}\n\n` +
      `  npm install --no-save playwright echarts @fontsource/inter && npx playwright install chromium\n\n` +
      `Also run \`npm run build\` first — the theme is imported from dist/.`,
  );
  process.exit(1);
}

// Reserved colours. These mean one thing wherever they appear and are never used
// as categorical slots — see cloudyali://design.
const INCREASE = "#e03228"; // red-600
const OTHER = "#7e92a8";    // coal-500

const GROUND = {
  light: { surface: "#ffffff", ink: "#18293d", ink2: "#32465c", grid: "rgba(100,120,143,0.16)", axis: "#cfdae5" },
  dark:  { surface: "#0f1620", ink: "#e6edf5", ink2: "#9db0c6", grid: "rgba(157,176,198,0.16)", axis: "#2c3a4b" },
};

/** The published theme with only surface and ink swapped — the series hues are
 *  chosen to hold on both grounds, which is the whole point of the scale. */
function themed(mode) {
  const g = GROUND[mode];
  const t = JSON.parse(JSON.stringify(ECHARTS_THEME));
  t.backgroundColor = g.surface;
  t.textStyle.color = g.ink2;
  t.title.textStyle.color = g.ink;
  t.title.subtextStyle.color = g.ink2;
  t.legend.textStyle.color = g.ink2;
  t.categoryAxis.axisLine.lineStyle.color = g.axis;
  t.categoryAxis.axisLabel.color = g.ink2;
  t.valueAxis.axisLabel.color = g.ink2;
  t.valueAxis.splitLine.lineStyle.color = g.grid;
  return t;
}

// --- chart 1: monthly spend by service, stacked ------------------------------
const MONTHS = ["Mar", "Apr", "May", "Jun", "Jul", "Aug"];
const SPEND = [
  ["Amazon EC2",            [18420, 19180, 18960, 21340, 22870, 24110]],
  ["Amazon RDS",            [ 9240,  9310,  9880, 10120, 10460, 10390]],
  ["Google Compute Engine", [ 6110,  6480,  7220,  7940,  8610,  9880]],
  ["Azure Virtual Machines",[ 5320,  5280,  5410,  5390,  5470,  5520]],
  ["Amazon S3",             [ 3180,  3240,  3310,  3380,  3450,  3520]],
  ["Amazon CloudFront",     [ 1420,  1610,  1580,  2240,  2690,  2410]],
];

const spendOption = () => ({
  animation: false,
  title: { text: "Monthly cloud spend by service", subtext: "Six months, all providers · illustrative figures", left: 0, top: 0 },
  tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
  legend: { bottom: 0, itemGap: 18 },
  grid: { left: 8, right: 16, top: 78, bottom: 44, containLabel: true },
  xAxis: { type: "category", data: MONTHS },
  yAxis: { type: "value", axisLabel: { formatter: (v) => "$" + v / 1000 + "k" } },
  series: SPEND.map(([name, data]) => ({ name, type: "bar", stack: "spend", data, barMaxWidth: 56, emphasis: { focus: "series" } })),
});

// --- chart 2: priced waste by category ---------------------------------------
// One measure across categories, so ONE colour. Seven hues would imply seven
// series and say nothing the labels already do.
const WASTE = [
  ["Idle EC2 instances", 4820], ["Unattached EBS volumes", 3140],
  ["Idle public IPv4 addresses", 2260], ["Over-allocated EBS", 1780],
  ["Unused Secrets Manager", 960], ["GCP stopped-VM storage", 610],
  ["ECR + S3 leftovers", 240],
].reverse();

const wasteOption = (mode) => ({
  animation: false,
  title: { text: "Priced waste by category", subtext: "Estimated monthly USD, all providers · illustrative figures", left: 0, top: 0 },
  grid: { left: 8, right: 72, top: 76, bottom: 8, containLabel: true },
  xAxis: { type: "value", axisLabel: { formatter: (v) => "$" + v.toLocaleString() }, splitLine: { show: true } },
  yAxis: { type: "category", data: WASTE.map((r) => r[0]), axisTick: { show: false } },
  series: [{
    type: "bar", data: WASTE.map((r) => r[1]), barMaxWidth: 22,
    itemStyle: { borderRadius: [0, 4, 4, 0] },
    label: { show: true, position: "right", color: GROUND[mode].ink, fontFamily: "Inter", fontSize: 13, fontWeight: 600,
             formatter: (p) => "$" + p.value.toLocaleString() },
  }],
});

// --- chart 3: anomaly days against daily spend -------------------------------
let seed = 20260401;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const DAYS = [], TOTAL = [];
for (let i = 0; i < 152; i++) {
  const d = new Date(Date.UTC(2026, 3, 1) + i * 86400000);
  DAYS.push(d.toISOString().slice(0, 10));
  const weekend = [0, 6].includes(d.getUTCDay()) ? 0.82 : 1;
  const step = i >= 78 ? 1.22 : 1; // a step change that never came back
  TOTAL.push(Math.round((1740 + rnd() * 190) * weekend * step));
}
const dayIdx = Object.fromEntries(DAYS.map((d, i) => [d, i]));
// real=true is a genuine spend change. real=false is an expected-cost-of-zero on
// a service that had been billing daily: an artefact of detection, not a change
// in the bill, and the reason these are plotted against the spend line.
const ANOM = [
  ["2026-04-14", "Amazon RDS", 412, true],  ["2026-04-27", "Amazon EC2", 96, false],
  ["2026-05-01", "Amazon S3", 41, false],   ["2026-05-01", "Amazon RDS", 58, false],
  ["2026-05-02", "Gemini API", 33, false],  ["2026-05-19", "Amazon RDS", 690, true],
  ["2026-06-08", "Azure Storage", 128, true], ["2026-06-18", "Amazon EC2", 305, true],
  ["2026-06-24", "Amazon EC2", 288, true],  ["2026-07-02", "Amazon S3", 47, false],
  ["2026-07-11", "Gemini API", 214, true],  ["2026-07-15", "Amazon RDS", 72, false],
  ["2026-07-29", "Amazon CloudFront", 61, false], ["2026-08-05", "Azure Storage", 176, true],
  ["2026-08-12", "Amazon EC2", 88, false],  ["2026-08-21", "Amazon RDS", 521, true],
  ["2026-08-26", "Gemini API", 55, false],  ["2026-08-30", "Amazon S3", 39, false],
];
// Four labels, not five: the two June markers are six days apart and a label
// that overlaps another is worse than no label.
const TOP = new Set([...ANOM].sort((a, b) => b[2] - a[2]).slice(0, 4).map((r) => r.join()));
const shortSvc = (s) => s.replace(/^Amazon |^Azure /, "");

const anomalyOption = (mode) => {
  const g = GROUND[mode];
  const marker = (r) => ({
    value: [dayIdx[r[0]], TOTAL[dayIdx[r[0]]]],
    symbolSize: 7 + Math.sqrt(r[2]) * 0.9,
    itemStyle: { color: r[3] ? INCREASE : OTHER, borderColor: g.surface, borderWidth: 1.5, opacity: r[3] ? 1 : 0.85 },
    label: { show: TOP.has(r.join()), position: "top", distance: 7, color: g.ink,
             fontFamily: "Inter", fontSize: 11, fontWeight: 600, formatter: shortSvc(r[1]) + " +$" + r[2] },
  });
  return {
    animation: false,
    title: { text: "Anomaly days against total daily spend",
             subtext: "Five months, all providers · marker size is cost impact · illustrative figures", left: 0, top: 0 },
    legend: { bottom: 0, itemGap: 22, data: [
      { name: "Daily spend", itemStyle: { color: OTHER } },
      { name: "Real spend change", itemStyle: { color: INCREASE } },
      { name: "Zero-baseline artefact", itemStyle: { color: OTHER } },
    ] },
    grid: { left: 8, right: 24, top: 76, bottom: 44, containLabel: true },
    xAxis: { type: "category", data: DAYS, boundaryGap: false, axisLabel: { interval: 0,
      formatter: (d) => d.endsWith("-01") ? new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) : "" } },
    // min: 0 deliberately. Truncating a spend axis to make variation look
    // dramatic is the one chart crime this palette work exists to avoid.
    yAxis: { type: "value", min: 0, axisLabel: { formatter: (v) => "$" + (v / 1000).toFixed(1) + "k" } },
    series: [
      { name: "Daily spend", type: "line", data: TOTAL, color: OTHER, symbol: "none",
        lineStyle: { width: 1.5 }, areaStyle: { color: "rgba(126,146,168,0.12)" }, z: 1 },
      { name: "Real spend change", type: "scatter", color: INCREASE, z: 3, data: ANOM.filter((r) => r[3]).map(marker) },
      { name: "Zero-baseline artefact", type: "scatter", color: OTHER, z: 2, data: ANOM.filter((r) => !r[3]).map(marker) },
    ],
  };
};

const CHARTS = [
  { file: "spend-by-service",  w: 1120, h: 520, option: spendOption },
  { file: "waste-by-category", w: 1120, h: 440, option: wasteOption },
  { file: "anomaly-days",      w: 1120, h: 420, option: anomalyOption },
];

/**
 * Serialise an ECharts option, functions included.
 *
 * JSON.stringify drops a function-valued key ENTIRELY and silently. The first
 * version of this script used it, and every axis formatter disappeared — the
 * date axis printed all 152 labels on top of each other and the money axes lost
 * their "$" and "k". Nothing errored; the charts just came out wrong, which is
 * the failure mode this codebase keeps meeting. Hence the assertion below.
 */
function serialize(v) {
  if (typeof v === "function") return v.toString();
  if (Array.isArray(v)) return `[${v.map(serialize).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${serialize(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function page(mode, w, h, option) {
  return `<!doctype html><html><head><meta charset="utf8"><style>${FACE}
  html,body{margin:0;padding:0;background:${GROUND[mode].surface};font-family:Inter,sans-serif;}
  #c{width:${w}px;height:${h}px;}</style></head><body><div id="c"></div>
<script>${echartsSrc}</script>
<script>
  window.__ready = false;
  (async () => {
    // Canvas resolves fonts at draw time, so the chart must not be drawn until
    // Inter has loaded.
    await document.fonts.load("600 20px Inter");
    await document.fonts.load("400 14px Inter");
    await document.fonts.ready;
    echarts.registerTheme("cloudyali", ${JSON.stringify(themed(mode))});
    echarts.init(document.getElementById("c"), "cloudyali", { renderer: "canvas", devicePixelRatio: 2 })
      .setOption(${serialize(option(mode))});
    window.__ready = true;
  })();
</script></body></html>`;
}

mkdirSync(OUT, { recursive: true });
// PLAYWRIGHT_BROWSERS_PATH / CHROMIUM_PATH lets a machine with Chromium already
// on disk skip `npx playwright install`.
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
for (const c of CHARTS) {
  for (const mode of ["light", "dark"]) {
    const html = page(mode, c.w, c.h, c.option);
    // Cheap, and it would have caught the JSON.stringify bug on the first run:
    // every chart here defines at least one axis formatter, so a page emitted
    // without the word is a page whose formatters were dropped.
    if (!html.includes("formatter")) {
      throw new Error(`${c.file}: no formatter survived serialisation — axis labels would render raw`);
    }
    const p = await browser.newPage({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 2 });
    await p.setContent(html, { waitUntil: "networkidle" });
    await p.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    await p.waitForTimeout(300);
    await p.locator("#c").screenshot({ path: join(OUT, `${c.file}-${mode}.png`) });
    await p.close();
    console.log(`docs/${c.file}-${mode}.png`);
  }
}
await browser.close();
