// MCP resources: reference material the model can read on demand.
//
// The filter-group grammar is intricate enough that explaining it inline would
// add ~1.5KB to six different tool descriptions — paid on every tools/list, in
// every session, whether or not anyone builds a filter. As a resource it is
// fetched once, only when needed, and lives in one place instead of six.
//
// This is the structural idea worth taking from Vantage's server: put the DSL
// documentation in resources, not descriptions.

import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import { BRAND_MARK_SVG, ECHARTS_THEME } from "./brand/assets.js";
import { DESIGN_MD } from "./brand/design-resource.js";

const FILTERS_URI = "cloudyali://filters";
const GLOSSARY_URI = "cloudyali://glossary";
const DESIGN_URI = "cloudyali://design";
const THEME_URI = "cloudyali://echarts-theme";
const MARK_URI = "cloudyali://brand-mark";

const FILTERS_MD = `# CloudYali cost filter grammar

Filters are an **array of groups**. Groups are OR'd with each other; conditions
within a group are combined by that group's \`operator\`.

## The one rule that catches everyone

Every group **must** contain a \`cloud_providers\` condition naming **exactly one**
provider. A group without it is rejected with HTTP 400 "missing cloud provider".
To query two providers, send two groups.

## Shape

\`\`\`json
[
  {
    "operator": "AND",
    "cloud_providers": [{ "operator": "equals", "value": ["AWS"] }],
    "services":        [{ "operator": "equals", "value": ["AmazonEC2"] }],
    "regions":         [{ "operator": "not_equals", "value": ["us-west-2"] }]
  }
]
\`\`\`

- Group \`operator\`: \`"AND"\` or \`"OR"\`.
- Condition \`operator\`: \`"equals"\` or \`"not_equals"\`.
- \`value\` is **singular** and always an **array**.

## Dimensions

\`cloud_providers\`, \`accounts\`, \`regions\`, \`services\`, \`cost_types\`,
\`usage_types\`, \`resource_types\`, \`resource_names\`, \`resource_arns\`.

Tags use a different shape:

\`\`\`json
"tags": [{ "key": "env", "value": { "operator": "equals", "value": ["prod"] } }]
\`\`\`

## Dimensions the API silently ignores, per provider

Filtering is applied only where the provider's schema has a column for it. Where
it does not, **the condition is dropped with no error and a 200 response** — you
get provider-wide rows that look like a filtered answer.

| Provider | Silently ignored |
|---|---|
| AWS | \`usage_types\` |
| GCP | \`usage_types\`, \`resource_types\` |
| Azure | \`resource_types\` |
| Databricks | \`regions\`, \`resource_types\` |
| Anthropic | \`regions\`, \`cost_types\`, \`resource_types\`, \`resource_names\`, \`resource_arns\` |
| Fastly | \`cost_types\`, \`resource_types\`, \`resource_names\`, \`resource_arns\` |
| OpenAI | \`regions\`, \`cost_types\`, \`resource_types\`, \`resource_names\`, \`resource_arns\` |

The cost tools detect this and prefix a warning to their summary, so you do not
have to hold the table in mind. When you see that warning, either narrow the
returned rows yourself or move the dimension into \`group_by_dimensions\` and sum
the groups you want — do not report the raw total as filtered.

## \`resource_names\` silently changes which dataset answers

For AWS, GCP and Azure, adding a \`resource_names\` condition does not just narrow
the query — it re-points it at a **different materialized view**: the per-resource
billing view instead of the aggregate one. The base view has no resource column,
so there is nowhere else for the filter to go.

Both views are built from the same source table, but they are not the same data:

- **Different retention.** The AWS aggregate view keeps everything from the start
  of the month seven months back; the per-resource view keeps seven months to the
  day. Each window is fixed at the moment that view was last refreshed, and the
  two are refreshed by separate jobs that can fail independently. A month can
  therefore be fully populated in one and empty in the other.
- **No usage type.** The AWS and GCP per-resource views drop \`usage_type\` /
  \`sku_id\`. Grouping by usage type in this mode does not error — every row
  collapses into a single \`Unknown\` bucket. (Azure's per-resource view keeps
  \`meter_subcategory\`, so Azure is unaffected.)
- **Silent provider drop.** If the per-resource view has never been refreshed, the
  provider is omitted from the report entirely: HTTP 200, no rows, no mention.
  **An empty result is not evidence of zero spend.**

So the same question asked two ways returns two different numbers, and nothing in
the response says which view produced either. The cost tools detect the switch and
warn. When you see that warning:

- report the figure as a per-resource one, not as the same measurement as an
  unfiltered total;
- if it disagrees with an unfiltered total, **do not explain the gap as billing lag
  or as a partial month** — the cause is the dataset, and saying otherwise invents
  a reconciliation that does not exist;
- do not fall back to grouping by usage type on AWS or GCP, because that grouping
  is one of the things this mode breaks.

\`get_resource_costs\` reads the per-resource dataset too, and carries the same
caveat against \`query_costs\` and \`get_cost_breakdown\` totals. It also returns a
\`match_confidence\` per resource: \`high\` means the billing row carried the
resource's own identifier, \`medium\` means the join was made on resource name
(a same-named resource elsewhere may be included), and \`low\` means the cost was
inferred from labels on underlying Compute Engine resources. Only \`high\` should
be reported as a billed figure.

## Failure mode worth knowing

Unknown keys and unknown operators are **silently ignored** server-side. A filter
written with plural \`"values"\`, or operator \`"in"\`, does not error — it is
dropped, and you get **unfiltered provider-wide data** that looks like a valid
answer. If a number looks too large, suspect the filter before suspecting the
data.

Discover valid values for a dimension with \`list_filter_values\`; they are
account-specific.

## Inventory tag filters are a separate grammar

\`list_resources\` and \`search_resources\` take \`tags\` as
\`[{ key, operator, value: [...] }]\`, where \`operator\` is one of
\`equal\`, \`not_equal\`, \`exists\`, \`not_exists\`, \`empty\`, \`not_empty\`.
Note \`equal\`, not \`equals\` — the cost API and the inventory API differ here,
and the wrong spelling is silently dropped rather than rejected.
`;

const GLOSSARY_MD = `# CloudYali terms

**Opportunity** — a detected chance to save money on a specific resource. Has a
lifecycle state (identified → acknowledged → in_progress → implemented, or
ignored), a category, a risk level and an effort level. This MCP is read-only:
it can list and read opportunities but cannot move them through the lifecycle.

**Budget** — a spend target for a scope (accounts, services, tags) over a period,
with alert thresholds. \`currentSpent\` is spend so far in the active period.

**Anomaly** — a statistically unusual cost movement, carrying an expected cost, an
actual cost, the impact in dollars, a deviation percentage and a z-score.

**Cost type** — the line-item classification a charge falls under. AWS values
include Usage, DiscountedUsage, Tax, Credit, Discount, Refund, Fee, RIFee and the
SavingsPlan* family; GCP uses regular, tax, adjustment, rounding_error.

**Resource state** — \`active\`, \`deleted\`, or \`all\`. The default is \`all\`,
which **includes deleted resources**. Pass \`active\` when asking about what is
running now, or counts will be higher than expected.

**Timestamp caveat** — on inventory records, \`created_at\` is a true creation
time only when \`created_at_is_accurate\` is true. For Azure, GCP and unmapped
AWS types it is CloudYali's first-seen time, which is when the resource was
discovered, not when it was created. Check the flag before stating a creation
date.
`;

export const RESOURCES: Resource[] = [
  {
    uri: DESIGN_URI,
    name: "CloudYali chart style",
    description:
      "How to draw CloudYali data so it looks like CloudYali: the categorical palette, which colours are reserved for meaning, and the footer every generated artifact carries. Read before building any chart, dashboard or report.",
    mimeType: "text/markdown",
  },
  {
    uri: THEME_URI,
    name: "CloudYali ECharts theme",
    description:
      "The ECharts 5 theme object, colours resolved to literal hex. Register with echarts.registerTheme('cloudyali', theme). Fetch only when you are actually rendering with ECharts.",
    mimeType: "application/json",
  },
  {
    uri: MARK_URI,
    name: "CloudYali brand mark",
    description:
      "The CloudYali logo as inline SVG, for the footer of a generated artifact. Self-contained \u2014 it carries its own background, so it sits on a light or dark chart unchanged. Paste verbatim.",
    mimeType: "image/svg+xml",
  },
  {
    uri: FILTERS_URI,
    name: "Cost filter grammar",
    description:
      "How to build the filters argument for the cost tools, and the silent-drop failure mode to watch for. Read before constructing a filter.",
    mimeType: "text/markdown",
  },
  {
    uri: GLOSSARY_URI,
    name: "CloudYali glossary",
    description:
      "What opportunities, budgets, anomalies and cost types mean in CloudYali, plus two defaults that surprise people.",
    mimeType: "text/markdown",
  },
];

const BODIES: Record<string, { mimeType: string; text: string }> = {
  [FILTERS_URI]: { mimeType: "text/markdown", text: FILTERS_MD },
  [GLOSSARY_URI]: { mimeType: "text/markdown", text: GLOSSARY_MD },
  [DESIGN_URI]: { mimeType: "text/markdown", text: DESIGN_MD },
  // Pretty-printed rather than minified: this gets read as much as it gets pasted, and a model
  // that can see the structure is less likely to invent a key that does not exist.
  [THEME_URI]: { mimeType: "application/json", text: JSON.stringify(ECHARTS_THEME, null, 2) },
  [MARK_URI]: { mimeType: "image/svg+xml", text: BRAND_MARK_SVG },
};

export function readResource(uri: string): { uri: string; mimeType: string; text: string } {
  const body = BODIES[uri];
  if (!body) throw new Error(`Unknown resource: ${uri}`);
  return { uri, mimeType: body.mimeType, text: body.text };
}
