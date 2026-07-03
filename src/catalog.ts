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
  category: "cost" | "budgets" | "recommendations" | "anomalies" | "inventory";
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
      order_by: { type: "string", description: "Sort column." },
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

  // -------------------- RECOMMENDATIONS --------------------
  {
    id: "recommendations.list",
    method: "GET",
    path: "/v1/recommendations",
    category: "recommendations",
    summary: "List cost-savings recommendations with filters",
    description:
      "List active recommendations across clouds (AWS, GCP, Azure, custom). Filter by provider, status, resource type, assignee, and minimum monthly savings. Sort by savings, ROI, or detection time.",
    queryParams: {
      provider: {
        type: "array",
        items: { type: "string" },
        description: "Cloud providers: aws, gcp, azure, custom. Pass an array; values are sent as repeated params.",
      },
      status: {
        type: "array",
        items: { type: "string" },
        description: "Statuses: new, working_on_it, done, dismissed.",
      },
      resourceType: {
        type: "array",
        items: { type: "string" },
        description: "Resource type filter (e.g., EbsVolume, Ec2Instance).",
      },
      assignedUser: {
        type: "array",
        items: { type: "integer" },
        description: "User IDs. Pass -1 to filter for unassigned.",
        serializeArray: "comma",
      },
      minSavings: { type: "number", description: "Minimum monthly savings ($). -1 = no filter." },
      sortBy: {
        type: "string",
        enum: ["savings_desc", "roi_desc", "detected_desc"],
        description: "Sort order.",
      },
      limit: { type: "integer", description: "Max rows. Default 50." },
      offset: { type: "integer", description: "Pagination offset." },
    },
    readOnly: true,
  },
  {
    id: "recommendations.summary",
    method: "GET",
    path: "/v1/recommendations/summary",
    category: "recommendations",
    summary: "Get aggregate recommendation analytics (totals, savings rollup)",
    description:
      "Returns counts by status, total potential savings, and savings by provider/resource-type. NOTE: provider and resourceType are honored only when a SINGLE value is given — passing multiple silently returns the all-providers/all-types rollup (unlike recommendations.list, which does true multi-value filtering). status is genuinely multi-value. Omit all filters for the unfiltered rollup.",
    queryParams: {
      provider: {
        type: "string",
        description: "Single cloud provider: aws, gcp, azure, databricks, or custom. Only ONE value is honored; the backend drops the filter (returns all providers) if given more than one.",
      },
      status: {
        type: "array",
        items: { type: "string" },
        description: "Statuses: new, working_on_it, done, dismissed. Multi-value (OR).",
      },
      resourceType: {
        type: "string",
        description: "Single resource type (e.g., EbsVolume, Ec2Instance). Only ONE value is honored; multiple values disable the filter.",
      },
      minSavings: { type: "number", description: "Minimum monthly savings ($). -1 = no filter." },
      assignedUser: {
        type: "array",
        items: { type: "integer" },
        description: "User IDs, or the single string 'unassigned'.",
        serializeArray: "comma",
      },
    },
    readOnly: true,
  },
  {
    id: "recommendations.filter_options",
    method: "GET",
    path: "/v1/recommendations/filter-options",
    category: "recommendations",
    summary: "List valid filter values for recommendation listing",
    description: "Returns the distinct resourceTypes, resourceLocations, and opportunityTypes present in this customer's recommendations, for building recommendations.list filters. Does NOT return providers, statuses, or users — use the documented provider/status enums, and recommendations.users for assignees.",
    readOnly: true,
  },
  {
    id: "recommendations.top_savings",
    method: "GET",
    path: "/v1/recommendations/top-savings",
    category: "recommendations",
    summary: "Get the top-N recommendations ranked by potential savings",
    description: "Convenience endpoint returning the highest-impact recommendations across all providers.",
    queryParams: {
      limit: { type: "integer", description: "Number of top recommendations to return. Default ~10." },
    },
    readOnly: true,
  },
  {
    id: "recommendations.get",
    method: "GET",
    path: "/v1/recommendations/:id",
    category: "recommendations",
    summary: "Get a single recommendation by numeric ID",
    description: "Full detail for one recommendation including savings, resource metadata, and current lifecycle state.",
    pathParams: {
      id: { type: "integer", description: "Recommendation ID.", required: true },
    },
    readOnly: true,
  },
  {
    id: "recommendations.history",
    method: "GET",
    path: "/v1/recommendations/:id/history",
    category: "recommendations",
    summary: "Get the status change history for a recommendation",
    description: "Audit log of status transitions and assignments for one recommendation.",
    pathParams: {
      id: { type: "integer", description: "Recommendation ID.", required: true },
    },
    readOnly: true,
  },
  {
    id: "recommendations.users",
    method: "GET",
    path: "/v1/recommendations/users",
    category: "recommendations",
    summary: "List users available for recommendation assignment",
    description: "Returns the set of users the current customer can assign recommendations to.",
    readOnly: true,
  },
  // NOTE: recommendation write endpoints (update_status, assign) are intentionally
  // excluded — see the policy comment near BLOCKED_PATH_PATTERNS below.

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
        enum: ["anomaly_date", "detected_at", "cost_impact", "deviation_percentage", "z_score", "expected_cost", "actual_cost"],
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
    description: "Full anomaly detail including root cause analysis breakdown.",
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
    summary: "Get current customer's anomaly alert preferences",
    description: "Read alert config: thresholds, notification channels, providers.",
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

// Policy: this MCP is read-only. Write endpoints (PUT/DELETE, status updates,
// status transitions, anomaly feedback, alert-preference writes) are not
// included in CATALOG at all — there is no entry to invoke. The runtime
// guard below (`isBlockedAction`) plus this path denylist exist as belt-and-
// braces protection against future catalog additions: anyone adding an
// action whose method or path looks mutating will see it filtered out and,
// if invoked by id, rejected with a specific reason. Make state changes via
// the portal at console.cloudyali.io.
//
// Path patterns that are always blocked, regardless of method or readOnly:
export const BLOCKED_PATH_PATTERNS: RegExp[] = [
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

export const READ_ONLY_CATALOG: Action[] = CATALOG.filter((a) => {
  const block = isBlockedAction(a);
  if (block.blocked) {
    // A blocked entry in CATALOG is an authoring mistake — surface it loudly
    // (stderr is safe for a stdio MCP server) instead of silently filtering.
    process.stderr.write(
      `cloudyali-mcp: catalog entry "${a.id}" is excluded from the read-only surface: ${block.reason}\n`,
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
