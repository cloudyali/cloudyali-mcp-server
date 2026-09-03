// Catalog of CloudYali API actions exposed via search_actions + execute_action.
//
// Each action has a stable `id` (used by execute_action), an HTTP method+path,
// a short description, optional path parameters, and a JSON-schema-ish shape
// for query/body params so Claude knows how to call it.

export type ParamShape = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  required?: boolean;
  enum?: string[];
  items?: { type: string };
  example?: unknown;
  // How array values serialize into the query string. "repeat" (default)
  // emits ?p=a&p=b; "comma" emits ?p=a,b for backend handlers that read a
  // single value and split on commas (e.g. assignedUser).
  serializeArray?: "repeat" | "comma";
};

export type Action = {
  id: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string; // path under /v1, may contain :param placeholders
  category: "cost" | "budgets" | "recommendations" | "anomalies" | "inventory" | "tags";
  summary: string;
  description: string;
  pathParams?: Record<string, ParamShape>;
  queryParams?: Record<string, ParamShape>;
  bodyParams?: Record<string, ParamShape>;
  bodyExample?: unknown;
  readOnly: boolean;
};

// Shared description for the `cost_type` body param on the v2 cost endpoints.
// Backend binds this to `struct { Inclusions []string }` (JSON {"inclusions":[...]}),
// NOT a bare string — a string 400s the whole request. Invalid entries are silently
// dropped (only the provider base type is summed), so listing the real values matters.
const COST_TYPE_DESC =
  'JSON object of the form {"inclusions": ["Usage", "Tax"]} selecting which line-item ' +
  "types to include in the cost sum. AWS values: Usage, DiscountedUsage, Tax, Credit, " +
  "Discount, BundledDiscount, Refund, Fee, RIFee, SavingsPlanRecurringFee, " +
  "SavingsPlanCoveredUsage, SavingsPlanNegation, SavingsPlanUpfrontFee. GCP values: " +
  "regular, tax, adjustment, rounding_error. Category literals also accepted: credits, " +
  "discounts, refunds, taxes. Invalid values are silently ignored (the query then sums " +
  "only the provider base type). Discover the live per-account list via cost.filters " +
  "(its `cost_type` response field). Omit to sum all cost types.";

// Shared description for the `filters` body param on the v2 cost endpoints.
// The real shape is group-based and REQUIRES a cloud_providers condition per group;
// the previously-documented "dimension/operator/values" shape does not exist and any
// filter built from it either 400s or is silently skipped (returning UNFILTERED data).
const FILTER_GROUP_DESC =
  "Array of filter groups (groups are OR'd together). Every group MUST include " +
  'cloud_providers: [{"operator":"equals","value":["AWS"]}] with exactly ONE provider ' +
  '(a group without it is rejected 400 "missing cloud provider"). Per-dimension ' +
  "conditions use a singular `value` array and operator equals|not_equals, e.g. " +
  'accounts|regions|services|cost_types|usage_types|resource_types|resource_names|' +
  'resource_arns: [{"operator":"equals","value":["..."]}]. Tags: ' +
  '[{"key":"env","value":{"operator":"equals","value":["prod"]}}]. Group-level ' +
  '"operator" is "AND" or "OR". WARNING: unknown keys or operators (e.g. plural ' +
  '"values", operator "in") are silently ignored server-side, returning UNFILTERED ' +
  "provider-wide data. Use cost.filters to discover valid dimension values.";

export const CATALOG: Action[] = [
  // -------------------- COST --------------------
  {
    id: "cost.report",
    method: "POST",
    path: "/v2/cost/report",
    category: "cost",
    summary: "Generate a cost report (chart or table format) across cloud providers",
    description:
      "Main cost report API. Returns chart-ready or table-ready data grouped by dimensions like account, region, service. Supports daily/weekly/monthly intervals, top-N aggregation, and cost-type breakdowns (usage, tax, credits, discounts, refunds, fees).",
    bodyParams: {
      start_time: { type: "string", description: "RFC3339 start time. Required — cost.report 400s if omitted (unlike cost.aggregate, it does not default the window).", required: true },
      end_time: { type: "string", description: "RFC3339 end time. Required — cost.report 400s if omitted.", required: true },
      dimensions: {
        type: "array",
        items: { type: "string" },
        description: "Grouping dimensions (max 4). Valid: account, region, service, cloud_provider, cost_type, usage_type.",
      },
      view_type: { type: "string", enum: ["daily", "weekly", "monthly"], description: "Time bucket granularity." },
      format: { type: "string", enum: ["full", "chart", "table"], description: "Response shape. Default: full." },
      top_n: { type: "integer", description: "Keep top N categories, aggregate rest as 'Others'." },
      cost_type: { type: "object", description: COST_TYPE_DESC },
      filters: {
        type: "array",
        description: FILTER_GROUP_DESC,
        items: { type: "object" },
      },
    },
    bodyExample: {
      start_time: "2025-04-01T00:00:00Z",
      end_time: "2025-05-01T00:00:00Z",
      dimensions: ["cloud_provider", "service"],
      view_type: "daily",
      format: "chart",
      top_n: 10,
      filters: [
        {
          operator: "AND",
          cloud_providers: [{ operator: "equals", value: ["AWS"] }],
          services: [{ operator: "equals", value: ["AmazonEC2"] }],
        },
      ],
    },
    readOnly: true,
  },
  {
    id: "cost.aggregate",
    method: "POST",
    path: "/v2/cost/aggr",
    category: "cost",
    summary: "Aggregate costs grouped by dimensions, with optional time interval",
    description:
      "Lower-level cost aggregation. Returns raw rows of (group_by columns, cost, timestamp). Use this when you need flexible grouping without the report formatting layer. For chart/table-ready output prefer cost.report.",
    bodyParams: {
      start_time: { type: "string", description: "RFC3339 start time. Defaults to 30 days ago if omitted." },
      end_time: { type: "string", description: "RFC3339 end time. Defaults to now if omitted." },
      filters: { type: "array", description: FILTER_GROUP_DESC, items: { type: "object" } },
      interval: { type: "string", enum: ["daily", "weekly", "monthly"], description: "Time bucket: daily, weekly, or monthly. Any other value silently disables the time series. Omit for no time series." },
      group_by_dimensions: {
        type: "array",
        items: { type: "string" },
        description: "Up to 4 dimensions: account, region, service, cloud_provider, cost_type, usage_type.",
      },
      group_by_hierarchy: { type: "boolean", description: "Build parent/child hierarchy across dimensions." },
      order_by: {
        type: "string",
        enum: ["amount", "account", "region", "service", "cloud_provider", "cost_type", "usage_type", "timestamp"],
        description:
          "Sort column, matching a selected alias. The cost column is `amount` — `cost` does not exist and fails the query. The backend validates only that the value is a bare SQL identifier before interpolating it into ORDER BY, so an unknown-but-well-formed name reaches Postgres and 500s.",
      },
      order_desc: { type: "boolean", description: "Sort descending." },
      count: { type: "integer", description: "Limit number of rows." },
      count_offset: { type: "integer", description: "Pagination offset." },
      cost_type: { type: "object", description: COST_TYPE_DESC },
    },
    readOnly: true,
  },
  {
    id: "cost.spend",
    method: "POST",
    path: "/v2/cost/spend",
    category: "cost",
    summary: "Get total spend with period-over-period comparison",
    description:
      "Returns current-period total cost, previous-period total, and the absolute + percent change. Useful for headline numbers and trend deltas.",
    bodyParams: {
      start_time: { type: "string", description: "RFC3339 start time for current period. Defaults to start of today (UTC) if omitted." },
      end_time: { type: "string", description: "RFC3339 end time for current period. Defaults to end of today (UTC) if omitted." },
      filters: { type: "array", description: FILTER_GROUP_DESC, items: { type: "object" } },
      cost_type: { type: "object", description: COST_TYPE_DESC },
    },
    readOnly: true,
  },
  {
    id: "cost.filters",
    method: "POST",
    path: "/v2/cost/filters",
    category: "cost",
    summary: "List available filter dimension values (accounts, regions, services, tags)",
    description:
      "Returns the set of available values for each filter dimension within a time window. Call this first to discover valid account IDs, region codes, service names, etc. before building a cost.report filter.",
    bodyParams: {
      start_date: { type: "string", description: "RFC3339 start time.", required: true },
      end_date: { type: "string", description: "RFC3339 end time.", required: true },
      filters: { type: "array", description: `Optional pre-filter to scope the returned values. ${FILTER_GROUP_DESC}`, items: { type: "object" } },
    },
    readOnly: true,
  },
  {
    id: "cost.filter_parameters_for_budgets",
    method: "GET",
    path: "/v1/cost/filter-parameters",
    category: "cost",
    summary: "Get the filter parameters used by the Budgets feature",
    description: "GET-style filter parameter listing used by the Budgets UI. Prefer cost.filters for general use.",
    readOnly: true,
  },

  // -------------------- BUDGETS --------------------
  {
    id: "budgets.list",
    method: "GET",
    path: "/v1/budgets",
    category: "budgets",
    summary: "List all budgets for the current customer",
    description:
      "Returns every configured budget with its amount, period, scope filters, and alert thresholds.",
    readOnly: true,
  },
  {
    id: "budgets.summary",
    method: "GET",
    path: "/v1/budgets/summary",
    category: "budgets",
    summary: "Get aggregate budget metrics across all budgets",
    description:
      "Dashboard rollup of budget COUNTS by health status: totalBudgets, healthyBudgets, warningBudgets, criticalBudgets, alertsBudgets. Does NOT include any dollar figures — for each budget's amount and current spend, use budgets.list.",
    readOnly: true,
  },
  {
    id: "budgets.get",
    method: "GET",
    path: "/v1/budgets/:id",
    category: "budgets",
    summary: "Get a single budget by numeric ID",
    description: "Full detail for one budget: amount, period, scope filters, and alert thresholds.",
    pathParams: {
      id: { type: "integer", description: "Budget ID.", required: true },
    },
    readOnly: true,
  },
  {
    id: "budgets.resources",
    method: "GET",
    path: "/v1/budgets/:id/resources",
    category: "budgets",
    summary: "List the resources contributing cost to a budget in a date range",
    description:
      "Per-resource cost attribution for one budget over [startDate, endDate). Both dates are required and endDate must be strictly after startDate. Paginated; returns resource metadata, tags, and cost per resource plus the period total.",
    pathParams: {
      id: { type: "integer", description: "Budget ID.", required: true },
    },
    queryParams: {
      startDate: { type: "string", description: "YYYY-MM-DD period start (inclusive).", required: true },
      endDate: { type: "string", description: "YYYY-MM-DD period end (exclusive). Must be after startDate.", required: true },
      page: { type: "integer", description: "Page number (1-based). Default 1." },
      size: { type: "integer", description: "Page size (1-1000). Default 200." },
    },
    readOnly: true,
  },
  {
    id: "budgets.history",
    method: "GET",
    path: "/v1/budgets/:id/history",
    category: "budgets",
    summary: "Get spend-vs-budget usage history for a budget",
    description:
      "Usage history (actual spend against the budgeted amount) over a date range. Defaults to the last month when dates are omitted or malformed.",
    pathParams: {
      id: { type: "integer", description: "Budget ID.", required: true },
    },
    queryParams: {
      startDate: { type: "string", description: "YYYY-MM-DD start date. Default: one month ago." },
      endDate: { type: "string", description: "YYYY-MM-DD end date. Default: today." },
    },
    readOnly: true,
  },
  {
    id: "budgets.config_history",
    method: "GET",
    path: "/v1/budgets/:id/config-history",
    category: "budgets",
    summary: "Get the configuration change history for a budget",
    description: "Audit log of edits to one budget's configuration (amount, period, filters, thresholds).",
    pathParams: {
      id: { type: "integer", description: "Budget ID.", required: true },
    },
    readOnly: true,
  },
  {
    id: "budgets.alert_history",
    method: "GET",
    path: "/v1/budgets/:id/alert-history",
    category: "budgets",
    summary: "Get the alert firing history for a budget",
    description:
      "Alerts triggered by one budget (threshold crossings) over a date range. Defaults to the last month when dates are omitted or malformed.",
    pathParams: {
      id: { type: "integer", description: "Budget ID.", required: true },
    },
    queryParams: {
      startDate: { type: "string", description: "YYYY-MM-DD start date. Default: one month ago." },
      endDate: { type: "string", description: "YYYY-MM-DD end date. Default: today." },
    },
    readOnly: true,
  },
  // NOTE: budget write endpoints (create: POST /v1/budgets, update: PUT
  // /v1/budgets/:id, delete: DELETE /v1/budgets/:id) are intentionally
  // excluded — see the policy comment near BLOCKED_PATH_PATTERNS below.

  // -------------------- RECOMMENDATIONS (cost-savings lifecycle) --------------------
  // Rewritten against the new cost-savings-lifecycle API (/v1/savings/*, US-032).
  // These are the SAME endpoints the portal UI and the weekly/monthly reports
  // consume, so an agent sees numbers identical-by-construction (M9 parity). The
  // old /v1/recommendations/* endpoints are decommissioned (410) in the same
  // release (US-030) — no catalog action points at them.
  {
    id: "recommendations.list",
    method: "GET",
    path: "/v1/savings/opportunities",
    category: "recommendations",
    summary: "List cost-savings opportunities (the lifecycle queue) with filters",
    description:
      "List cost-savings opportunities across clouds (AWS, GCP, Azure, plus schema-ready openai/anthropic). Each opportunity carries a lifecycle state (identified, acknowledged, in_progress, implemented, ignored, expired), a category/risk/effort, monthly USD savings, source attribution, and a derived `flagged` (no-longer-detected) marker. Filter by any dimension; results are server-paginated and sorted. This is the same endpoint the portal queue and reports use.",
    queryParams: {
      provider: {
        type: "array",
        items: { type: "string" },
        description: "Cloud providers: aws, gcp, azure, openai, anthropic, databricks. Repeated params.",
      },
      state: {
        type: "array",
        items: { type: "string" },
        description: "Lifecycle states: identified, acknowledged, in_progress, implemented, ignored, expired.",
      },
      category: {
        type: "array",
        items: { type: "string" },
        description: "Categories: wastage, rightsizing, commitment, other.",
      },
      risk: { type: "array", items: { type: "string" }, description: "Risk levels: low, medium, high." },
      effort: { type: "array", items: { type: "string" }, description: "Effort levels: low, medium, high." },
      account: { type: "array", items: { type: "string" }, description: "Account / project / subscription IDs. Repeated params." },
      region: { type: "array", items: { type: "string" }, description: "Region codes." },
      parent: { type: "array", items: { type: "string" }, description: "Parent resource UIDs (e.g. the volume behind a snapshot)." },
      assignee: {
        type: "array",
        items: { type: "string" },
        description: "Assigned user IDs, or the literal 'unassigned'. Repeated params.",
      },
      flagged: { type: "boolean", description: "true = only no-longer-detected (flagged) opportunities; false = only un-flagged." },
      minSavings: { type: "number", description: "Minimum monthly USD savings." },
      text: { type: "string", description: "Free-text (ILIKE) match on title / resource identity." },
      sort: {
        type: "string",
        enum: ["savings_desc", "savings_asc", "detected_desc", "detected_asc"],
        description: "Sort order. Default: savings_desc.",
      },
      limit: { type: "integer", description: "Max rows (1..1000). Default 25." },
      offset: { type: "integer", description: "Pagination offset. Default 0." },
    },
    readOnly: true,
  },
  {
    id: "recommendations.summary",
    method: "GET",
    path: "/v1/savings/summary",
    category: "recommendations",
    summary: "Get cost-savings KPIs (funnel, projected + realized savings)",
    description:
      "Single KPI source (US-018): the lifecycle funnel (counts per state), projected open-state savings sliced by category / bucket / provider, realized savings in the period (frozen ledger, ignores state filters), new/reopened occurrence counts, plus flagged and unconverted counts. Accepts the SAME filter set as recommendations.list. The period defaults to the current UTC month-to-date; override with from/to. This is the exact endpoint the dashboard and reports use — numbers match by construction.",
    queryParams: {
      provider: { type: "array", items: { type: "string" }, description: "Cloud providers filter (see recommendations.list)." },
      state: { type: "array", items: { type: "string" }, description: "Lifecycle states filter." },
      category: { type: "array", items: { type: "string" }, description: "Categories filter." },
      risk: { type: "array", items: { type: "string" }, description: "Risk levels filter." },
      effort: { type: "array", items: { type: "string" }, description: "Effort levels filter." },
      account: { type: "array", items: { type: "string" }, description: "Account IDs filter." },
      region: { type: "array", items: { type: "string" }, description: "Region codes filter." },
      parent: { type: "array", items: { type: "string" }, description: "Parent resource UID filter." },
      assignee: { type: "array", items: { type: "string" }, description: "Assignee filter (user IDs or 'unassigned')." },
      flagged: { type: "boolean", description: "Flagged (no-longer-detected) filter." },
      minSavings: { type: "number", description: "Minimum monthly USD savings." },
      text: { type: "string", description: "Free-text (ILIKE) filter." },
      from: { type: "string", description: "Realized/occurrence period start (RFC3339 or YYYY-MM-DD). Default: start of current UTC month." },
      to: { type: "string", description: "Realized/occurrence period end (RFC3339 or YYYY-MM-DD). Default: now." },
    },
    readOnly: true,
  },
  {
    id: "recommendations.get",
    method: "GET",
    path: "/v1/savings/opportunities/:id",
    category: "recommendations",
    summary: "Get one cost-savings opportunity by ID",
    description:
      "Detail for one opportunity: the opportunity row itself — resource identity and region, state, category, risk and effort, savings amount and currency, and detection timestamps. Narrative sections (provenance, why-evidence, runbook, id history, occurrences, timeline, ledger records) are not surfaced; see src/shapes.ts.",
    pathParams: {
      id: { type: "integer", description: "Opportunity ID (numeric).", required: true },
    },
    readOnly: true,
  },

  // -------------------- ANOMALIES --------------------
  {
    id: "anomalies.list",
    method: "GET",
    path: "/v1/anomalies",
    category: "anomalies",
    summary: "List cost anomalies with pagination and filtering",
    description:
      "List detected cost anomalies across clouds. Filter by date range, status, cloud provider, account, service, and cost impact. Default window is the last 90 days.",
    queryParams: {
      page: { type: "integer", description: "Page number (1-based)." },
      size: { type: "integer", description: "Page size (max 200, default 50)." },
      startDate: { type: "string", description: "YYYY-MM-DD start date." },
      endDate: { type: "string", description: "YYYY-MM-DD end date." },
      status: { type: "string", description: "Anomaly status filter." },
      cloudProvider: { type: "string", description: "Cloud provider filter (aws/gcp/azure/anthropic)." },
      accountId: { type: "string", description: "Account ID filter." },
      serviceName: { type: "string", description: "Service name filter." },
      sortBy: {
        type: "string",
        enum: ["anomaly_date", "detected_at", "cost_impact", "deviation_percentage", "expected_cost", "actual_cost"],
        description: "Column to sort by. Default: anomaly_date. Restricted to a fixed allowlist; other values fall back to anomaly_date.",
      },
      sortOrder: { type: "string", enum: ["asc", "desc"], description: "Sort direction. Default: desc." },
      minCostImpact: { type: "number", description: "Minimum cost impact in dollars." },
      maxCostImpact: { type: "number", description: "Maximum cost impact in dollars." },
    },
    readOnly: true,
  },
  {
    id: "anomalies.summary",
    method: "GET",
    path: "/v1/anomalies/summary",
    category: "anomalies",
    summary: "Get anomaly dashboard summary stats",
    description:
      "Returns top-level counts and impact totals for the anomaly dashboard. Defaults to the last 90 days when no dates are given.",
    queryParams: {
      startDate: { type: "string", description: "YYYY-MM-DD start date. Default: 90 days ago." },
      endDate: { type: "string", description: "YYYY-MM-DD end date. Default: today." },
    },
    readOnly: true,
  },
  {
    id: "anomalies.get",
    method: "GET",
    path: "/v1/anomalies/:id",
    category: "anomalies",
    summary: "Get a single anomaly by ID (UUID)",
    description: "Anomaly detail: provider, service, account, expected vs actual cost, impact, deviation percentage, plus detection timestamps. Detector internals are not surfaced; see src/shapes.ts.",
    pathParams: {
      id: { type: "string", description: "Anomaly UUID.", required: true },
    },
    readOnly: true,
  },
  {
    id: "anomalies.preferences_get",
    method: "GET",
    path: "/v1/anomalies/preferences",
    category: "anomalies",
    summary: "Whether anomaly alerting is enabled, per account",
    description: "Reports whether anomaly alerting is switched on for each account. Routing and thresholds are configured in the console and are not returned.",
    readOnly: true,
  },
  // NOTE: anomaly write endpoints (preferences_update, update_status, feedback)
  // are intentionally excluded — see the policy comment near BLOCKED_PATH_PATTERNS below.

  // -------------------- INVENTORY --------------------
  {
    id: "inventory.list",
    method: "POST",
    path: "/v1/inventory/resources",
    category: "inventory",
    summary: "List inventory resources across clouds, with filters",
    description:
      "Paginated list of cloud resources (EC2, S3, VMs, buckets, etc.) across AWS, GCP, Azure, Fastly, and Anthropic — with full configuration, tags, and console deep-links. Filter by provider, type, region, account, state, an active-during time range, and tags.",
    bodyParams: {
      cloud_provider: { type: "array", items: { type: "string" }, description: "Cloud providers: aws, azure, gcp, fastly, anthropic." },
      resource_type: { type: "array", items: { type: "string" }, description: "Resource types (e.g. AWS::EC2::Instance). See inventory.types for valid values." },
      region: { type: "array", items: { type: "string" }, description: "Region codes (e.g. us-east-1). See inventory.regions." },
      account_id: { type: "array", items: { type: "string" }, description: "Account / subscription / project IDs. See inventory.accounts." },
      state: { type: "string", enum: ["active", "deleted", "all"], description: "Resource state filter. Default: all." },
      start_time: { type: "string", description: "ISO 8601; include resources active during [start_time, end_time]." },
      end_time: { type: "string", description: "ISO 8601 end of the active-during range." },
      tags: { type: "array", items: { type: "object" }, description: "Tag filters: array of { key, operator, value } objects. `value` MUST be a string array (a scalar 400s the request). Valid operators: equal, not_equal, exists, not_exists, empty, not_empty — any other spelling (e.g. 'equals') is silently dropped server-side, returning UNFILTERED results. Max 20 filters, 50 values each." },
      limit: { type: "integer", description: "Results per page. Default 50, max 1000." },
      offset: { type: "integer", description: "Pagination offset. Default 0." },
    },
    readOnly: true,
  },
  {
    id: "inventory.search",
    method: "POST",
    path: "/v1/inventory/search",
    category: "inventory",
    summary: "Free-text search across all inventory resources",
    description:
      "Full-text search over resource IDs, names, and all properties/tags (trigram matching). Accepts the same filters as inventory.list. Use when you have a name or ID fragment rather than exact filters.",
    bodyParams: {
      query: { type: "string", description: "Search text (min 3 chars). Matches resource IDs, names, properties, and tags.", required: true },
      cloud_provider: { type: "array", items: { type: "string" }, description: "Cloud providers filter." },
      resource_type: { type: "array", items: { type: "string" }, description: "Resource types filter." },
      region: { type: "array", items: { type: "string" }, description: "Region codes filter." },
      account_id: { type: "array", items: { type: "string" }, description: "Account IDs filter." },
      state: { type: "string", enum: ["active", "deleted", "all"], description: "Resource state filter. Default: all (an absent/empty state includes deleted resources; pass 'active' to exclude them)." },
      tags: { type: "array", items: { type: "object" }, description: "Tag filters, same shape as inventory.list: array of { key, operator, value:[...] }. `value` must be a string array; operators outside equal/not_equal/exists/not_exists/empty/not_empty are silently dropped (unfiltered results)." },
      limit: { type: "integer", description: "Results per page. Default 50, max 200." },
      offset: { type: "integer", description: "Pagination offset. Default 0." },
    },
    bodyExample: { query: "prod-web", cloud_provider: ["aws"], state: "active" },
    readOnly: true,
  },
  {
    id: "inventory.get",
    method: "GET",
    path: "/v1/inventory/resource/:id",
    category: "inventory",
    summary: "Get a single inventory resource by its cloud-native ID",
    description:
      "Full detail for one resource: configuration, tags, display names, timestamps, and console URL. IMPORTANT: only works for IDs WITHOUT a slash — e.g. AWS i-.../vol-.../bucket names. GCP asset names (//compute.googleapis.com/...) and Azure IDs (/subscriptions/...) contain '/' and 404 here even URL-encoded; for those, use inventory.search or inventory.list with filters instead.",
    pathParams: {
      id: { type: "string", description: "Slash-free cloud-native resource ID (e.g. i-1234567890abcdef0). IDs containing '/' (GCP asset names, Azure resource IDs) are not retrievable via this endpoint.", required: true },
    },
    queryParams: {
      provider: { type: "string", enum: ["aws", "gcp", "azure", "fastly", "anthropic"], description: "Optional provider hint to disambiguate an ID that could exist in more than one cloud." },
    },
    readOnly: true,
  },
  {
    id: "inventory.stats",
    method: "GET",
    path: "/v1/inventory/stats",
    category: "inventory",
    summary: "Resource count aggregations by provider and type",
    description: "Active / deleted / total resource counts grouped by cloud provider and resource type.",
    queryParams: {
      provider: { type: "string", description: "Optional cloud-provider filter (aws/azure/gcp/fastly/anthropic)." },
    },
    readOnly: true,
  },
  {
    id: "inventory.tag_keys",
    method: "GET",
    path: "/v1/inventory/tags",
    category: "inventory",
    summary: "List distinct tag keys across all resources",
    description: "Returns the set of tag keys present on inventory resources, for building inventory.list tag filters.",
    queryParams: {
      limit: { type: "integer", description: "Max tag keys. Default 100, max 1000." },
    },
    readOnly: true,
  },
  {
    id: "inventory.tag_values",
    method: "GET",
    path: "/v1/inventory/tags/:key/values",
    category: "inventory",
    summary: "List distinct values for a given tag key",
    description: "Returns the distinct values observed for one tag key.",
    pathParams: {
      key: { type: "string", description: "Tag key name.", required: true },
    },
    queryParams: {
      limit: { type: "integer", description: "Max values. Default 100, max 1000." },
      provider: { type: "string", description: "Optional cloud-provider filter." },
    },
    readOnly: true,
  },
  {
    id: "facets.resolve",
    method: "POST",
    path: "/v1/facets",
    category: "cost",
    summary: "Filter vocabulary for a domain, narrowed by what is already selected",
    description:
      "Every dimension a domain offers with the values it actually has for this account, narrowed by the selections already made. Covers cost, inventory, anomalies and savings from one endpoint. A dimension the domain does not have is a 400, not a silent no-op.",
    bodyParams: {
      domain: { type: "string", description: "cost | inventory | anomalies | savings.", required: true },
      period: { type: "object", description: '{"from","to"} RFC3339, UTC only. Omit for all available history.' },
      selected: { type: "object", description: "Dimension -> chosen values. Narrows the others." },
      dimensions: { type: "array", description: "Limit the answer to these dimensions. Omit for all." },
      search: { type: "object", description: "Dimension -> substring, to reach values past the cap. Cost domain only." },
    },
    readOnly: true,
  },
  // --- Cost views -----------------------------------------------------------
  // A saved view is a question someone already decided was worth asking, which
  // makes it a better fit for this server than most raw endpoints. Read paths
  // only: the definitions are global/CloudYali-managed, so the mutating routes
  // edit what every customer sees.
  {
    id: "views.list",
    method: "GET",
    path: "/v1/views",
    category: "cost",
    summary: "The saved cost views available to this account",
    description:
      "Curated cost views: name, what each one covers, and its id for running. Definitions are CloudYali-managed and shared, not per-account.",
    readOnly: true,
  },
  {
    id: "views.run",
    method: "POST",
    path: "/v1/views/:id/results",
    category: "cost",
    summary: "Run a saved view over a window",
    description:
      "Runs a view's saved query for this account: daily series per group, per-group totals, the view total, its share of the whole bill, and the data-freshness watermark.",
    pathParams: { id: { type: "string", description: "View id from views.list.", required: true } },
    bodyParams: {
      days: { type: "integer", description: "Window length. Exactly 7, 30 or 90 — any other value is rejected." },
      granularity: { type: "string", description: "Time bucket: day, week or month. Default day." },
    },
    readOnly: true,
  },
  {
    id: "views.detail",
    method: "POST",
    path: "/v1/views/:id/results/detail",
    category: "cost",
    summary: "Resource-grain rows behind a view",
    description:
      "The same view at resource grain: a paginated table of (day, group, resource_id, cost), ordered by cost. The drill-down behind the chart.",
    pathParams: { id: { type: "string", description: "View id from views.list.", required: true } },
    bodyParams: {
      days: { type: "integer", description: "Window length. Exactly 7, 30 or 90." },
      limit: { type: "integer", description: "Max rows." },
      offset: { type: "integer", description: "Row offset, for paging." },
    },
    readOnly: true,
  },
  // --- Tag governance -------------------------------------------------------
  // The console has a whole Tag Governance page on these and the MCP had none of
  // it: list_tag_values answers "which values exist", which is discovery, not
  // governance. "How much of my spend is untagged, and who is worst" was
  // unreachable.
  {
    id: "tags.coverage",
    method: "POST",
    path: "/v1/tags/analytics/coverage",
    category: "tags",
    summary: "Tagged vs untagged spend, with the prior period for comparison",
    description:
      "Total, tagged and untagged cost for a window, the tagged percentage, how many distinct tag keys are in use, and the same figures for the preceding window of equal length.",
    bodyParams: {
      start_date: { type: "string", description: "YYYY-MM-DD. Defaults to 30 days ago." },
      end_date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
      filters: { type: "array", description: "Cost filter groups, same grammar as the cost tools." },
    },
    readOnly: true,
  },
  {
    id: "tags.cost_by_tag",
    method: "POST",
    path: "/v1/tags/analytics/cost-by-tag",
    category: "tags",
    summary: "Spend broken down by tag key and value",
    description:
      "Cost per (provider, tag key, tag value) with each row's share of the total. The cost tools cannot group by tag, so this is the only way to ask what a tag value costs.",
    bodyParams: {
      start_date: { type: "string", description: "YYYY-MM-DD. Defaults to 30 days ago." },
      end_date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
      filters: { type: "array", description: "Cost filter groups, same grammar as the cost tools." },
      limit: { type: "integer", description: "Max rows." },
      offset: { type: "integer", description: "Row offset, for paging." },
    },
    readOnly: true,
  },
  {
    id: "tags.health",
    method: "POST",
    path: "/v1/tags/analytics/health",
    category: "tags",
    summary: "Keys that nearly match a standard tag, and the resources carrying them",
    description:
      "Near-miss tag keys (Environment vs environment vs env) against the standard tag set, with the resources using each wrong spelling.",
    bodyParams: {
      start_date: { type: "string", description: "YYYY-MM-DD. Defaults to 30 days ago." },
      end_date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
      filters: { type: "array", description: "Cost filter groups, same grammar as the cost tools." },
    },
    readOnly: true,
  },
  {
    id: "tags.standard",
    method: "GET",
    path: "/v1/tags/standard",
    category: "tags",
    summary: "The customer's standard tag policy",
    description:
      "The tag keys this account has declared as standard, the values each permits, and whether the rule is active. This is the yardstick tags.health measures against.",
    readOnly: true,
  },
  {
    id: "inventory.providers",
    method: "GET",
    path: "/v1/inventory/providers",
    category: "inventory",
    summary: "List cloud providers present in inventory",
    description: "Returns the available cloud providers (aws, azure, gcp, fastly, anthropic).",
    readOnly: true,
  },
  {
    id: "inventory.types",
    method: "GET",
    path: "/v1/inventory/types",
    category: "inventory",
    summary: "List resource types with display names",
    description: "Returns resource types with system_name, human-readable display_name, and cloud_provider.",
    readOnly: true,
  },
  {
    id: "inventory.regions",
    method: "GET",
    path: "/v1/inventory/regions",
    category: "inventory",
    summary: "List regions with display names",
    description: "Returns region code (e.g. us-east-1) and display_name (e.g. US East (N. Virginia)).",
    readOnly: true,
  },
  {
    id: "inventory.accounts",
    method: "GET",
    path: "/v1/inventory/accounts",
    category: "inventory",
    summary: "List accounts / subscriptions / projects in inventory",
    description: "Returns account / subscription / project IDs with display names across connected clouds, for use as inventory.list filters.",
    readOnly: true,
  },
  {
    id: "inventory.resource_costs",
    method: "POST",
    path: "/v1/inventory/resource-costs",
    category: "inventory",
    summary: "Get cost data for specific inventory resources",
    description:
      "Per-resource cost for the given resource IDs over a time window. Returns total and daily costs per resource, plus a match confidence/method, and a no-data message when a resource has no attributable cost. Get the resource IDs from inventory.list or inventory.search.",
    bodyParams: {
      resource_ids: { type: "array", items: { type: "string" }, description: "Cloud-native resource IDs to fetch costs for.", required: true },
      start_time: { type: "string", description: "ISO 8601 start of the cost window." },
      end_time: { type: "string", description: "ISO 8601 end of the cost window." },
    },
    bodyExample: { resource_ids: ["i-1234567890abcdef0"], start_time: "2026-05-01T00:00:00Z", end_time: "2026-06-01T00:00:00Z" },
    readOnly: true,
  },
  {
    id: "inventory.history",
    method: "POST",
    path: "/v1/inventory/history",
    category: "inventory",
    summary: "Get configuration change history for a resource",
    description:
      "Version history and field-level diffs of one resource's configuration and tags over time, with change type (Create/Update/Delete) and who/what made each change. Not available for Anthropic or Fastly resources (the response's supports_history flag will be false).",
    bodyParams: {
      cloud_provider: { type: "string", enum: ["aws", "azure", "gcp", "fastly", "anthropic"], description: "Cloud provider of the resource.", required: true },
      resource_id: { type: "string", description: "Cloud-native resource ID.", required: true },
      account_id: { type: "string", description: "Account / subscription / project ID that owns the resource.", required: true },
      resource_type: { type: "string", description: "Resource type (optional; narrows the lookup)." },
      region: { type: "string", description: "Region code (optional; narrows the lookup)." },
      limit: { type: "integer", description: "Max versions to return. Default 10, max 100." },
      offset: { type: "integer", description: "Pagination offset. Default 0." },
    },
    bodyExample: { cloud_provider: "aws", resource_id: "i-1234567890abcdef0", account_id: "123456789012" },
    readOnly: true,
  },
];

// Policy: this MCP is read-only. Every mutation — account/customer/user CRUD,
// savings-lifecycle transitions, status updates, anomaly feedback, alert-
// preference writes, PUT/DELETE of any kind — is absent from CATALOG and, if
// ever added, is rejected at runtime by `isBlockedAction`. The guard is an
// allowlist on method plus an explicit readOnly flag plus the path denylist
// below, so a future addition has to defeat three checks rather than one.
// Make state changes via the portal at console.cloudyali.io.
//
// Path patterns that are always blocked, regardless of method or readOnly:
const BLOCKED_PATH_PATTERNS: RegExp[] = [
  /^\/v\d+\/account(\/|$)/i,     // /v1/account, /v1/account/registration/job
  /^\/v\d+\/accounts(\/|$)/i,    // /v1/accounts, /v1/accounts/:id, ...
  /^\/v\d+\/customer(\/|$)/i,    // /v1/customer (customer / tenant CRUD)
  /^\/v\d+\/users(\/|$)/i,       // user administration
  /\/sync(\/|$)/i,               // /accounts/:id/sync, /:id/sync-jobs (write trigger)
  /\/claim\//i,                  // marketplace claim/link
  /\/link(\/|$)/i,               // marketplace link
  /\/registration(\/|$)/i,       // any registration endpoint
];

// An action is blocked from the MCP if either:
//   - its method is anything other than GET or POST (allowlist — a widened
//     method union stays blocked without remembering to extend a denylist), or
//   - it's explicitly marked readOnly: false, or
//   - its path matches one of the BLOCKED_PATH_PATTERNS above.
export function isBlockedAction(a: Action): { blocked: boolean; reason?: string } {
  if (a.method !== "GET" && a.method !== "POST") {
    return { blocked: true, reason: `method ${a.method} is a write operation` };
  }
  if (!a.readOnly) {
    return { blocked: true, reason: "action is marked readOnly: false" };
  }
  for (const pat of BLOCKED_PATH_PATTERNS) {
    if (pat.test(a.path)) {
      return {
        blocked: true,
        reason: `path matches denylist pattern ${pat} (account / customer / user / sync / claim / registration endpoints are not exposed)`,
      };
    }
  }
  return { blocked: false };
}

// READ_ONLY_CATALOG: the actions actually reachable via search_actions /
// execute_action. Every entry is a read.
export const READ_ONLY_CATALOG: Action[] = CATALOG.filter((a) => {
  const block = isBlockedAction(a);
  if (block.blocked) {
    // A blocked entry in CATALOG is an authoring mistake — surface it loudly
    // (stderr is safe for a stdio MCP server) instead of silently filtering.
    process.stderr.write(
      `cloudyali-mcp: catalog entry "${a.id}" is excluded from the exposed surface: ${block.reason}\n`,
    );
  }
  return !block.blocked;
});

export function findAction(id: string): Action | undefined {
  return CATALOG.find((a) => a.id === id);
}

// Naive singularizer so a singular query term matches plural catalog wording
// (and vice-versa): "anomaly"/"anomalies" both normalize to "anomaly",
// "budgets" -> "budget". It is applied symmetrically to the query term and the
// searchable text, so same-word matches are unaffected even when the stemming
// is imperfect — the only requirement is that both sides normalize identically.
function singularizeWord(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`; // anomalies -> anomaly
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1); // budgets -> budget
  return w;
}

// Singularize every alphabetic run in a string, leaving separators (".", "_", " ") intact.
function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(/[a-z]+/g, singularizeWord);
}

export function searchActions(query: string, category?: string, limit = 10): Action[] {
  const q = query.trim().toLowerCase();
  const scored = READ_ONLY_CATALOG
    .filter((a) => !category || a.category === category)
    .map((a) => {
      const nId = normalizeForSearch(a.id);
      const nSummary = normalizeForSearch(a.summary);
      const haystack = normalizeForSearch(`${a.id} ${a.summary} ${a.description} ${a.path} ${a.category}`);
      let score = 0;
      if (!q) {
        score = 1;
      } else {
        for (const rawTerm of q.split(/\s+/)) {
          if (!rawTerm) continue;
          // Normalize the term the SAME way as the haystack (per alphabetic run),
          // so a punctuated token like "budgets.list" singularizes to "budget.list"
          // and still matches — asymmetric normalization would drop exact-id queries.
          const term = normalizeForSearch(rawTerm);
          if (nId.includes(term)) score += 5;
          if (nSummary.includes(term)) score += 3;
          if (haystack.includes(term)) score += 1;
        }
      }
      return { a, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.a);
  return scored;
}
