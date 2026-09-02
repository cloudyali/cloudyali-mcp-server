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
import { costWarningsFor } from "../filter-support.js";

// The filter-group grammar is genuinely intricate and is documented once, as an
// MCP resource (see src/resources.ts), rather than pasted into six descriptions.
const FILTERS_HINT =
  "Filter groups, OR'd together. Every group must name exactly one cloud provider. Read the cloudyali://filters resource for the grammar before building one — an unrecognised key is ignored server-side and silently returns UNFILTERED data.";

const filters = arrOf({ type: "object" }, FILTERS_HINT);

const costTypeHint =
  'Which line-item types to sum, as {"inclusions": ["Usage", "Tax"]}. Omit to include everything. Discover the valid values for this account with list_filter_values.';


/**
 * Put the dropped-filter warning ahead of the numbers.
 *
 * Leading, not trailing: a caveat printed after a total is read as a footnote,
 * and the whole point is that the total is wrong.
 */
function prefixWarning(args: Record<string, unknown>, text: string): string {
  // Warnings go BEFORE the numbers, deliberately. A caveat appended after a
  // total has already been read is a caveat about a number the reader has
  // already believed.
  const warning = costWarningsFor(args);
  return warning ? `${warning}\n\n${text}` : text;
}

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
    present: (body, args) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const cur = (o.current ?? o.current_period) as Record<string, unknown> | undefined;
      const amount = cur?.total ?? cur?.amount ?? o.total;
      const change = (o.comparison ?? o.change) as Record<string, unknown> | undefined;
      const pct = change?.percent ?? change?.percentage;
      const parts = [
        amount !== undefined ? `Total spend: ${amount}.` : "Spend returned.",
        pct !== undefined ? `Change vs the previous period: ${pct}%.` : "",
      ].filter(Boolean);
      return { structured: o, text: prefixWarning(args, parts.join(" ")) };
    },
  },

  {
    name: "query_costs",
    title: "Aggregate costs grouped by dimension",
    description:
      "Ad-hoc cost aggregation: raw rows of (grouping fields, cost, timestamp). This is the workhorse for 'break down X by Y'. Prefer get_cost_breakdown when you want chart- or table-shaped output with top-N rollup; prefer get_spend_summary for a single headline number.",
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
      order_by: enumStr(
        "Field to sort by. The cost field is `amount`, not `cost`; any value outside the enum fails the whole request rather than being ignored.",
        ["amount", "account", "region", "service", "cloud_provider", "cost_type", "usage_type", "timestamp"],
      ),
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
        text: prefixWarning(args, listSummary("cost rows", rows, {
          emptyHint:
            "Widen the date range, or check the filter values with list_filter_values. Do not retry with only the grouping changed — if a broad query returns nothing, the filter or window is wrong, not the grouping." +
            (dims ? ` Current grouping: ${dims}.` : ""),
        })),
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
    present: (body, args) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const summary = o.summary as Record<string, unknown> | undefined;
      return {
        structured: o,
        text: prefixWarning(args, summary?.total !== undefined ? `Cost report returned. Total: ${summary.total}.` : "Cost report returned."),
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
    present: (body, args) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const counts = Object.entries(o)
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => `${k}: ${(v as unknown[]).length}`)
        .join(", ");
      return { structured: o, text: prefixWarning(args, counts ? `Filter values available — ${counts}.` : "No filter values returned.") };
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


// --- Cost views -------------------------------------------------------------
//
// A saved view is a question someone already decided was worth asking, and it
// answers two things query_costs cannot: the share of the WHOLE bill (the view
// carries its own denominator) and how fresh the underlying billing data is.

/** days is a hard enum server-side — 7, 30 or 90. Anything else is a 400, not a clamp. */
const viewDays = {
  type: "integer" as const,
  description: "Window length in days. Must be exactly 7, 30 or 90 — any other value is rejected outright, not rounded.",
  enum: [7, 30, 90],
};

/**
 * What the freshness watermark means for the number just reported.
 *
 * This is the only field in the whole server that can say a cost total is
 * incomplete. Partial ingestion surfaces here as an earlier watermark and never
 * as an error, so a half-ingested month otherwise reads as a real decline.
 */
function freshnessNote(freshness: unknown, end: unknown): string {
  if (freshness === null || freshness === undefined) {
    return " No billing data landed in this window at all — this is not a zero, it is an absence.";
  }
  if (typeof freshness !== "string" || typeof end !== "string") return "";
  const latest = freshness.slice(0, 10);
  // `end` is exclusive, so the last day the window covers is the day before it.
  const lastDay = new Date(`${end}T00:00:00Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  const expected = lastDay.toISOString().slice(0, 10);
  if (latest >= expected) return "";
  return ` Billing data only reaches ${latest}, short of the window's end (${expected}) — the total is incomplete, and a drop at the end of the series is missing data rather than reduced spend.`;
}

export const VIEW_TOOLS: ToolDef[] = [
  {
    name: "list_cost_views",
    title: "Saved cost views",
    description:
      "The curated cost views available, with the id needed to run one. Check here before building a query by hand — if a view already answers the question, running it gives the answer plus its share of the total bill, which query_costs cannot.",
    openWorld: true,
    inputSchema: obj({}),
    call: () => ({ action: "views.list" }),
    present: (body) => {
      const rows = (Array.isArray(body) ? body : rowsOf(body, "views")) as Record<string, unknown>[];
      return {
        structured: { views: rows, total: rows.length },
        text: rows.length
          ? `${rows.length} saved view(s): ${rows.map((v) => v.name).filter(Boolean).slice(0, 8).join(", ")}${rows.length > 8 ? ", …" : ""}. Run one with run_cost_view.`
          : "No saved cost views. Build the query directly with query_costs or get_cost_breakdown.",
      };
    },
  },

  {
    name: "run_cost_view",
    title: "Run a saved view",
    description:
      "Runs a saved view for this account and returns the daily series by group, per-group totals, the view total, and what share of the entire bill it represents. Use get_cost_view_detail for the resources behind it.",
    openWorld: true,
    inputSchema: obj(
      {
        id: str("View id, from list_cost_views.", { minLength: 1 }),
        days: viewDays,
        granularity: enumStr("Time bucket. Default day.", ["day", "week", "month"]),
      },
      ["id"],
    ),
    call: (a) => ({ action: "views.run", path_params: { id: a.id }, body: { days: a.days, granularity: a.granularity } }),
    present: (body) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const range = (o.range ?? {}) as Record<string, unknown>;
      const total = o.view_total;
      const share = o.share_of_total;
      const parts: string[] = [];
      if (typeof total === "number") {
        // The share is the reason to run a view rather than a query: the view
        // carries the full-bill denominator, so "$4200" becomes "$4200, a third
        // of the bill" — the version someone can act on.
        parts.push(
          typeof share === "number"
            ? `View total ${total.toFixed(2)} over ${range.days ?? "?"} days — ${(share * (share <= 1 ? 100 : 1)).toFixed(1)}% of the whole bill.`
            : `View total ${total.toFixed(2)} over ${range.days ?? "?"} days.`,
        );
      } else {
        parts.push("View ran.");
      }
      const groups = Object.keys((o.totals ?? {}) as Record<string, unknown>).length;
      if (groups) parts.push(`${groups} group(s).`);
      return { structured: o, text: parts.join(" ") + freshnessNote(o.data_freshness, range.end) };
    },
  },

  {
    name: "get_cost_view_detail",
    title: "Resources behind a saved view",
    description:
      "The same view at resource grain: (day, group, resource_id, cost) ordered by cost. The drill-down behind run_cost_view's chart.",
    openWorld: true,
    inputSchema: obj(
      {
        id: str("View id, from list_cost_views.", { minLength: 1 }),
        days: viewDays,
        limit: int("Max rows. Keep this small — the server's own ceiling is high enough to return more than anyone can read.", { minimum: 1, maximum: 1000 }),
        offset: int("Row offset, for paging.", { minimum: 0 }),
      },
      ["id"],
    ),
    call: (a) => ({ action: "views.detail", path_params: { id: a.id }, body: { days: a.days, limit: a.limit, offset: a.offset } }),
    present: (body) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const rows = rowsOf(body, "rows") as Record<string, unknown>[];
      const page = (o.pagination ?? {}) as Record<string, unknown>;
      if (rows.length === 0) {
        return { structured: o, text: "No rows for this view in that window. Try a longer days value, or run_cost_view first to confirm the view has any spend at all." };
      }
      // A null resource_id is a real answer — resourceless line items and the AI
      // providers have none. Reported as its own category so it is not read as a
      // lookup failure or quietly dropped from a sum.
      const noResource = rows.filter((r) => r.resource_id === null || r.resource_id === undefined).length;
      const parts = [`${rows.length} row(s) from offset ${page.offset ?? 0}.`];
      if (noResource > 0) {
        parts.push(
          `${noResource} carry no resource id — that is expected for resourceless line items and AI provider spend, not a lookup failure. Keep them in any total.`,
        );
      }
      return { structured: o, text: parts.join(" ") };
    },
  },
];
