// The `cloudyali://design` resource body.
//
// Kept out of resources.ts because it is long and because it is generated-adjacent: the palette
// values come from ECHARTS_THEME, never from a hex typed here. A hex typed here is a copy that
// drifts, and a chart drawn in almost-CloudYali colours is worse than one drawn in obviously
// generic ones — the near miss reads as a bug in the product rather than as a default.

import { ECHARTS_THEME } from "./assets.js";

const C = ECHARTS_THEME.cloudyali;
const SERIES = ECHARTS_THEME.color;

const seriesTable = SERIES.map((hex, i) => `| \`series-${i + 1}\` | \`${hex}\` |`).join("\n");

export const DESIGN_MD = `# Rendering CloudYali data

Everything below is the CloudYali design system's data-visualization contract, the same one the
console is built on. Use it for any chart, dashboard or report you build from these tools, so what
you produce looks like it came from the product rather than from a default library palette.

## Charts are Apache ECharts

The console uses ECharts 5. Fetch \`cloudyali://echarts-theme\` for the full theme object, register
it once, and never set a colour on an individual series:

\`\`\`js
echarts.registerTheme('cloudyali', theme);   // theme = the JSON from cloudyali://echarts-theme
echarts.init(el, 'cloudyali');
\`\`\`

If you are rendering somewhere ECharts is not available, use the palette below directly and keep
the same rules — the rules matter more than the library.

## The categorical ramp

| Role | Hex |
|---|---|
${seriesTable}
| \`other\` | \`${C.other}\` |

**Seven, and the seventh is the end.** Past seven a cost breakdown stops being readable before it
stops having colours. Roll the tail into \`other\` rather than reaching for an eighth hue. \`other\`
is not in the theme's rotation on purpose: if it were, ECharts would eventually hand it to a real
service and paint a genuine cost grey.

**Assign in order.** \`series-1\` for the largest or most important line, then down. Do not shuffle
for variety — the same service should be the same colour across every chart in one answer.

## Reserved colours — do not use these as series colours

| Role | Hex | Means |
|---|---|---|
| \`increase\` / \`over-budget\` | \`${C.increase}\` | cost went up, budget exceeded, anomaly |
| \`decrease\` / \`under-budget\` | \`${C.decrease}\` | cost went down, saving realised |
| \`warning\` | \`${C.warning}\` | approaching a budget threshold |
| \`forecast\` | \`${C.forecast}\` | projected, not billed |
| \`other\` | \`${C.other}\` | Other / Untagged / Unallocated |

A chart that paints \`AmazonEC2\` red is telling the reader something it does not mean. Red, yellow
and grey carry meaning in a FinOps chart; spend them on meaning.

\`series-4\` is green, which is a deliberate compromise — the palette needed the hue to stay
distinguishable. The rule that keeps it safe: **a chart carrying budget or anomaly meaning uses the
semantic colours above and does not draw from the series ramp at all.**

## Sequential and diverging

- **Sequential** (spend intensity, tag coverage, heatmaps): \`${C.sequential.join("`, `")}\`
- **Diverging** (change vs the previous period): \`${C.diverging[0]}\` (up) → \`${C.diverging[1]}\` (flat) → \`${C.diverging[2]}\` (down)

The diverging scale is red → teal, **not** red → green. Red/green is the obvious pair and the wrong
one: under deuteranopia it scores a perceptual distance of 16, against 59 for red/teal, and roughly
one man in twelve reads a spend chart.

## Rules that are not about colour

**Projections are not measurements.** Anything forecast or extrapolated is drawn with
\`forecast\` and a dashed line. A projected month drawn like a billed one is the chart lying.

**Money gets a currency and a scale.** Axis labels read \`$1.2k\`, not \`1200\`. Never truncate a
cost axis to start above zero — a bar chart that starts at $30 turns a 4% rise into a cliff.

**Time runs left to right, oldest first**, even when the API returned newest first.

**Sort categorical bars by value, not alphabetically**, unless the reader asked for a lookup.

## Every generated artifact carries a footer

Charts get screenshotted and pasted into Slack, and the caveats stay behind in the conversation. So
the artifact itself has to carry its provenance. Put this at the bottom of any chart, dashboard or
report you generate — fetch the mark from \`cloudyali://brand-mark\` and paste it verbatim:

\`\`\`html
<footer style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
               margin-top:24px;padding-top:12px;border-top:1px solid ${ECHARTS_THEME.tooltip.borderColor};
               font:12px/1.5 ${ECHARTS_THEME.textStyle.fontFamily},system-ui,sans-serif;
               color:${ECHARTS_THEME.textStyle.color}">
  <!-- the <svg> from cloudyali://brand-mark, verbatim -->
  <span>Generated <time datetime="ISO-8601">&lt;date and time, with the timezone&gt;</time></span>
  <span style="color:${C.warning}">AI-generated — Claude can make mistakes. Check the figures before acting on them.</span>
</footer>
\`\`\`

Three things, all required:

1. **The mark**, so the artifact is identifiable as CloudYali output.
2. **A timestamp**, with the timezone, and the *window the data covers* if that differs from when
   it was generated. Cloud bills are restated for days after the fact; an undated cost chart is
   unfalsifiable.
3. **The AI notice.** Not boilerplate — it is doing real work here, because these tools can return
   a number that is correct for a question slightly different from the one asked.

**And the part that actually matters:** if any tool result carried a \`WARNING:\` line — a filter the
API silently dropped, a query re-pointed at a different dataset — that warning goes in the footer
too, in full. The chart is exactly where such a caveat gets lost, and a caveat that survives only in
the transcript has not survived.
`;
