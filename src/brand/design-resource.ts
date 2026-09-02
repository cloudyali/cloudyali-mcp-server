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

## Every generated artifact is stamped, at the top

Charts get screenshotted and pasted into Slack, and the caveats stay behind in the conversation.
So the artifact carries its own provenance — at the **top**, where it is read before the numbers
rather than after them. Fetch the mark from \`cloudyali://brand-mark\` and paste it verbatim:

\`\`\`html
<header style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
               margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid ${ECHARTS_THEME.tooltip.borderColor};
               font:12px/1.5 ${ECHARTS_THEME.textStyle.fontFamily},system-ui,sans-serif;
               color:${ECHARTS_THEME.textStyle.color}">
  <!-- the <svg> from cloudyali://brand-mark, verbatim -->
  <span>Generated <time datetime="ISO-8601">&lt;local time with zone, and UTC&gt;</time></span>
  <span style="color:${C.warning}">AI-generated — verify before acting on these figures.</span>
</header>
\`\`\`

Three things, and only three. Keep it to one line each — this is a stamp, not a preamble.

1. **The mark.**
2. **The real generation time**, in the reader's local zone and UTC. Read the clock; never write a
   placeholder or a rounded hour. An undated cost figure is unfalsifiable, and a wrong one is worse
   than none.
3. **The AI notice.**

Anything else you want to say about the data — what it covers, what it excludes, which figures are
not comparable — goes in the body or a short source line at the end, not in this stamp.

## The source line: scope and reliability, never machinery

Below the numbers, one short paragraph. It answers three questions and stops:

1. **What is in and out of scope?** \`Open wastage findings only; rightsizing and Savings Plan
   recommendations excluded.\`
2. **Which figures are estimates rather than billed amounts, and on what basis?** \`The $12.40
   secrets figure is an estimate: 31 × $0.40/mo list price.\`
3. **What window does the data cover?**

Then stop. It is a source line, not a methodology section.

There is a real distinction to hold here, because over-correcting is its own failure. Two things
look like "internal detail" and only one of them is:

- **How the system is built** — which internal component produced a finding, what it does not yet
  support, which upstream services were consulted, whether a section was assembled by hand. This
  has no reader value and does not belong in an artifact that is one share away from being public.
  \`the savings engine does not yet emit these findings itself\` is a product roadmap disclosure
  wearing the costume of a footnote.
- **How much a number can be trusted** — estimate versus billed, point-in-time versus continuously
  monitored, a match made on an identifier versus inferred. This is exactly what the reader needs
  and it stays.

The test is whether removing it changes what a reader would *do*. Knowing a figure is an estimate
changes what they do. Knowing which subsystem computed it does not.

So the fix is almost always a reframe rather than a deletion — state the reliability, drop the
organisational cause:

> ✗ Azure and GCP findings come from a manual sweep of the CloudYali inventory against the bills —
>   the savings engine does not yet emit these findings itself.
>
> ✓ Azure and GCP figures are point-in-time estimates.

Same warning to the reader. None of the org chart.

**And the part that carries real weight:** if a tool result carried a \`WARNING:\` line, that warning
belongs in the artifact too, in the body, in full. The chart is exactly where such a caveat gets
lost. Restate what the warning said; do not restate any explanation of *why* — the tools do not
give you one, and inventing a mechanism is worse than leaving the caveat bare.
`;
