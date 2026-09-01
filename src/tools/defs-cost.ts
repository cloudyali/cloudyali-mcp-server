// Cost, savings and budget tools.
//
// Description style, borrowed from Vantage's own tool-authoring guide: one or
// two sentences on what the tool returns, disambiguation against neighbouring
// tools where the names are confusable, and nothing else. Everything about what
// to pass belongs on the parameter, not in the prose — the model reads the
// schema, and restating it twice just costs context and drifts out of date.

import {
  ToolDef,
  arrOf,
  bool,
  enumStr,
  int,
  isoDate,
  listSummary,
  num,
  obj,
  rfc3339,
  rowsOf,
  str,
  truncationNote,
  PROVIDERS,
} from "./types.js";

// The filter-group grammar is genuinely intricate and is documented once, as an
// MCP resource (see src/resources.ts), rather than pasted into six descriptions.
const FILTERS_HINT =
  "Filter groups, OR'd together. Every group must name exactly one cloud provider. Read the cloudyali://filters resource for the grammar before building one — an unrecognised key is ignored server-side and silently returns UNFILTERED data.";

const filters = arrOf({ type: "object" }, FILTERS_HINT);

const costTypeHint =
  'Which line-item types to sum, as {"inclusions": ["Usage", "Tax"]}. Omit to include everything. Discover the valid values for this account with list_filter_values.';

export const COST_TOOLS: ToolDef[] = [
  {
    name: "get_spend_summary",
    title: "Total spend with period-over-period change",
    description:
      "Headline spend for a period, with the previous period's total and the change between them. Use this for 'how much did we spend' and 'is it up or down'. For a breakdown by service, account or region use get_cost_breakdown instead.",
    openWorld: true,
    inputSchema: obj({
      start_time: rfc3339("Start of the current period"),
      end_time: rfc3339("End of the current period"),
      filters,
      cost_type: { type: "object", description: costTypeHint },
    }),
    call: (a) => ({ action: "cost.spend", body: a }),
    present: (body) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const cur = (o.current ?? o.current_period) as Record<string, unknown> | undefined;
      const amount = cur?.total ?? cur?.amount ?? o.total;
      const change = (o.comparison ?? o.change) as Record<string, unknown> | undefined;
      const pct = change?.percent ?? change?.percentage;
      const parts = [
        amount !== undefined ? `Total spend: ${amount}.` : "Spend returned.",
        pct !== undefined ? `Change vs the previous period: ${pct}%.` : "",
      ].filter(Boolean);
      return { structured: o, text: parts.join(" ") };
    },
  },

  {
    name: "query_costs",
    title: "Aggregate costs grouped by dimension",
    description:
      "Ad-hoc cost aggregation: raw rows of (grouping columns, cost, timestamp). This is the workhorse for 'break down X by Y'. Prefer get_cost_breakdown when you want chart- or table-shaped output with top-N rollup; prefer get_spend_summary for a single headline number.",
    openWorld: true,
    inputSchema: obj({
      start_time: rfc3339("Start of the window. Defaults to 30 days ago"),
      end_time: rfc3339("End of the window. Defaults to now"),
      group_by_dimensions: arrOf(
        enumStr("Dimension", ["account", "region", "service", "cloud_provider", "cost_type", "usage_type"]),
        "Up to 4 dimensions to group by.",
      ),
      interval: enumStr(
        "Time bucket. Omit for no time series. Coarser buckets return far fewer rows — prefer monthly for long windows.",
        ["daily", "weekly", "monthly"],
      ),
      filters,
      cost_type: { type: "object", description: costTypeHint },
      order_by: str("Column to sort by."),
      order_desc: bool("Sort descending."),
      count: int("Maximum rows to return.", { minimum: 1, maximum: 1000 }),
      count_offset: int("Row offset, for paging.", { minimum: 0 }),
    }),
    call: (a) => ({ action: "cost.aggregate", body: a }),
    present: (body, args) => {
      const rows = Array.isArray(body) ? body : rowsOf(body, "rows", "data");
      const dims = (args.group_by_dimensions as string[] | undefined)?.join(", ");
      return {
        structured: { rows, row_count: rows.length },
        text: listSummary("cost rows", rows, {
          emptyHint:
            "Widen the date range, or check the filter values with list_filter_values. Do not retry with only the grouping changed — if a broad query returns nothing, the filter or window is wrong, not the grouping." +
            (dims ? ` Current grouping: ${dims}.` : ""),
        }),
      };
    },
  },

  {
    name: "get_cost_breakdown",
    title: "Cost report grouped by dimension, chart or table shaped",
    description:
      "Cost report with time bucketing and top-N rollup, shaped for charting or tabulation. Both start_time and end_time are required — unlike query_costs this does not default the window.",
    openWorld: true,
    inputSchema: obj(
      {
        start_time: rfc3339("Start of the report window"),
        end_time: rfc3339("End of the report window"),
        dimensions: arrOf(
          enumStr("Dimension", ["account", "region", "service", "cloud_provider", "cost_type", "usage_type"]),
          "Up to 4 grouping dimensions.",
        ),
        view_type: enumStr("Time bucket granularity.", ["daily", "weekly", "monthly"]),
        format: enumStr("Response shape.", ["full", "chart", "table"]),
        top_n: int("Keep the top N categories and roll the rest into 'Others'.", { minimum: 1 }),
        filters,
        cost_type: { type: "object", description: costTypeHint },
      },
      ["start_time", "end_time"],
    ),
    call: (a) => ({ action: "cost.report", body: a }),
    present: (body) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const summary = o.summary as Record<string, unknown> | undefined;
      return {
        structured: o,
        text: summary?.total !== undefined ? `Cost report returned. Total: ${summary.total}.` : "Cost report returned.",
      };
    },
  },

  {
    name: "list_filter_values",
    title: "Discover valid filter values",
    description:
      "The accounts, regions, services, tags and cost types present in the data for a window. Call this before building a filter — filter values are account-specific, and an unrecognised one is silently ignored rather than rejected, which returns unfiltered data that looks like a valid answer.",
    openWorld: true,
    inputSchema: obj(
      {
        start_date: rfc3339("Start of the window to look for values in"),
        end_date: rfc3339("End of the window"),
        filters,
      },
      ["start_date", "end_date"],
    ),
    call: (a) => ({ action: "cost.filters", body: a }),
    present: (body) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const counts = Object.entries(o)
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => `${k}: ${(v as unknown[]).length}`)
        .join(", ");
      return { structured: o, text: counts ? `Filter values available — ${counts}.` : "No filter values returned." };
    },
  },
];

export const SAVINGS_TOOLS: ToolDef[] = [
  {
    name: "list_savings_opportunities",
    title: "Cost-savings opportunities",
    description:
      "Open cost-savings opportunities across clouds, with the resource each one targets, the estimated saving, and its risk and effort. Read-only: the MCP cannot acknowledge, assign or implement an opportunity — do that in the CloudYali console.",
    openWorld: true,
    inputSchema: obj({
      provider: arrOf(enumStr("Cloud provider", PROVIDERS), "Filter by cloud provider."),
      state: arrOf(str("Lifecycle state, e.g. identified, acknowledged, in_progress, implemented, ignored."), "Filter by lifecycle state."),
      category: arrOf(str("Opportunity category, e.g. wastage, rightsizing, commitment."), "Filter by category."),
      risk: arrOf(str("Risk level."), "Filter by risk."),
      effort: arrOf(str("Implementation effort."), "Filter by effort."),
      account: arrOf(str("Cloud account / subscription / project ID."), "Filter by account."),
      region: arrOf(str("Region code."), "Filter by region."),
      parent: arrOf(str("Parent resource UID."), "Filter to opportunities under a parent resource."),
      flagged: bool("Only opportunities that have been flagged."),
      minSavings: num("Minimum monthly USD saving."),
      text: str("Free-text match against title, description and target resource."),
      sort: enumStr("Sort order.", ["savings_desc", "savings_asc", "detected_desc", "detected_asc"]),
      limit: int("Maximum rows. Default 50.", { minimum: 1, maximum: 500 }),
      offset: int("Row offset, for paging.", { minimum: 0 }),
    }),
    call: (a) => ({ action: "recommendations.list", query_params: a }),
    present: (body, args) => {
      const rows = rowsOf(body, "opportunities", "rows");
      const o = (body ?? {}) as Record<string, unknown>;
      const total = o.total ?? o.count;
      return {
        structured: { opportunities: rows, total: total ?? rows.length },
        text:
          listSummary("savings opportunities", rows, {
            total,
            emptyHint:
              "Lower minSavings, drop the state filter, or widen the provider list. A state filter is the most common reason for an empty result here.",
          }) + truncationNote(rows, total, args.limit ?? 50),
      };
    },
  },

  {
    name: "get_savings_summary",
    title: "Savings KPIs",
    description:
      "Rollup of savings opportunities: counts by state and category, and total projected and realized savings. Use this for 'how much could we save' rather than listing every opportunity.",
    openWorld: true,
    inputSchema: obj({
      provider: arrOf(enumStr("Cloud provider", PROVIDERS), "Filter by cloud provider."),
      state: arrOf(str("Lifecycle state."), "Filter by lifecycle state."),
      category: arrOf(str("Opportunity category."), "Filter by category."),
      risk: arrOf(str("Risk level."), "Filter by risk."),
      effort: arrOf(str("Implementation effort."), "Filter by effort."),
      account: arrOf(str("Cloud account ID."), "Filter by account."),
      region: arrOf(str("Region code."), "Filter by region."),
      minSavings: num("Minimum monthly USD saving."),
      from: isoDate("Restrict to opportunities detected on or after this date"),
      to: isoDate("Restrict to opportunities detected on or before this date"),
    }),
    call: (a) => ({ action: "recommendations.summary", query_params: a }),
    present: (body) => ({
      structured: (body ?? {}) as Record<string, unknown>,
      text: "Savings summary returned.",
    }),
  },

  {
    name: "get_savings_opportunity",
    title: "One savings opportunity",
    description:
      "Detail for a single opportunity: the resource it targets, its state, savings amount, risk and effort, and detection timestamps. Narrative sections — provenance, why-evidence, runbook, audit timeline — are not surfaced through the MCP.",
    openWorld: true,
    inputSchema: obj({ id: int("Opportunity ID, from list_savings_opportunities.", { minimum: 1 }) }, ["id"]),
    call: (a) => ({ action: "recommendations.get", path_params: { id: a.id } }),
    present: (body) => ({
      structured: (body ?? {}) as Record<string, unknown>,
      text: "Opportunity detail returned.",
    }),
  },
];

export const BUDGET_TOOLS: ToolDef[] = [
  {
    name: "list_budgets",
    title: "All budgets with current spend",
    description:
      "Every configured budget with its amount, period, scope and spend so far. Use get_budget_summary for counts by health status instead of the full list.",
    openWorld: true,
    inputSchema: obj({}),
    call: () => ({ action: "budgets.list" }),
    present: (body) => {
      const rows = Array.isArray(body) ? body : rowsOf(body, "budgets");
      return {
        structured: { budgets: rows },
        text: listSummary("budgets", rows, { emptyHint: "No budgets are configured for this account." }),
      };
    },
  },

  {
    name: "get_budget_summary",
    title: "Budget counts by health status",
    description:
      "How many budgets are healthy, warning, critical or alerting. Counts only — for the amount and spend of each budget use list_budgets.",
    openWorld: true,
    inputSchema: obj({}),
    call: () => ({ action: "budgets.summary" }),
    present: (body) => ({ structured: (body ?? {}) as Record<string, unknown>, text: "Budget summary returned." }),
  },

  {
    name: "get_budget",
    title: "One budget",
    description: "Full detail for a single budget: amount, period, scope filters and alert thresholds.",
    openWorld: true,
    inputSchema: obj({ id: int("Budget ID, from list_budgets.", { minimum: 1 }) }, ["id"]),
    call: (a) => ({ action: "budgets.get", path_params: { id: a.id } }),
    present: (body) => ({ structured: (body ?? {}) as Record<string, unknown>, text: "Budget detail returned." }),
  },

  {
    name: "get_budget_history",
    title: "Spend against a budget over time",
    description:
      "Actual spend versus the budgeted amount over a date range. For the resources driving that spend use get_budget_resources.",
    openWorld: true,
    inputSchema: obj(
      {
        id: int("Budget ID.", { minimum: 1 }),
        startDate: isoDate("Start date. Defaults to one month ago"),
        endDate: isoDate("End date. Defaults to today"),
      },
      ["id"],
    ),
    call: (a) => ({
      action: "budgets.history",
      path_params: { id: a.id },
      query_params: { startDate: a.startDate, endDate: a.endDate },
    }),
    present: (body) => {
      const rows = Array.isArray(body) ? body : rowsOf(body, "history");
      return {
        structured: { history: rows },
        text: listSummary("history points", rows, { emptyHint: "Widen the date range." }),
      };
    },
  },

  {
    name: "get_budget_resources",
    title: "Resources contributing to a budget",
    description:
      "Per-resource cost attribution for one budget over a period. Both dates are required and endDate must be after startDate.",
    openWorld: true,
    inputSchema: obj(
      {
        id: int("Budget ID.", { minimum: 1 }),
        startDate: isoDate("Period start, inclusive"),
        endDate: isoDate("Period end, exclusive. Must be after startDate"),
        page: int("Page number, 1-based.", { minimum: 1 }),
        size: int("Page size. Default 200.", { minimum: 1, maximum: 1000 }),
      },
      ["id", "startDate", "endDate"],
    ),
    call: (a) => ({
      action: "budgets.resources",
      path_params: { id: a.id },
      query_params: { startDate: a.startDate, endDate: a.endDate, page: a.page, size: a.size },
    }),
    present: (body, args) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const rows = rowsOf(body, "resources");
      const total = (o.count ?? (o.pagination as Record<string, unknown> | undefined)?.total) as unknown;
      return {
        structured: o,
        text:
          listSummary("resources", rows, {
            total,
            emptyHint: "No resources were attributed to this budget in that period. Check the date range.",
          }) + truncationNote(rows, total, args.size ?? 200),
      };
    },
  },
];
