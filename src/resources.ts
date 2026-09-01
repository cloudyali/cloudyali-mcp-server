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

const FILTERS_URI = "cloudyali://filters";
const GLOSSARY_URI = "cloudyali://glossary";

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

const BODIES: Record<string, string> = {
  [FILTERS_URI]: FILTERS_MD,
  [GLOSSARY_URI]: GLOSSARY_MD,
};

export function readResource(uri: string): { uri: string; mimeType: string; text: string } {
  const text = BODIES[uri];
  if (!text) throw new Error(`Unknown resource: ${uri}`);
  return { uri, mimeType: "text/markdown", text };
}
