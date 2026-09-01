import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "./index.js";
import type { ToolDef } from "./types.js";

// Coverage showed only ~55% of the tools' present() functions ever ran. present()
// is not incidental formatting: it is where the summary text is built, and the
// rule that keeps attacker-controllable strings out of the prose block lives
// there. An untested present() is an untested security property.

const ARGS: Record<string, Record<string, unknown>> = {
  get_cost_breakdown: { start_time: "2026-08-01T00:00:00Z", end_time: "2026-08-31T00:00:00Z" },
  list_filter_values: { start_date: "2026-08-01T00:00:00Z", end_date: "2026-08-31T00:00:00Z" },
  get_savings_opportunity: { id: 1 },
  get_budget: { id: 1 },
  get_budget_history: { id: 1 },
  get_budget_resources: { id: 1, startDate: "2026-08-01", endDate: "2026-08-31" },
  get_anomaly: { id: "abcd1234-uuid" },
  search_resources: { query: "prod" },
  get_resource: { id: "i-0abc123" },
  get_resource_costs: { resource_ids: ["i-0abc123"] },
  get_resource_history: { cloud_provider: "aws", resource_id: "i-0abc", account_id: "123456789012" },
  list_inventory_facets: { facet: "providers" },
  list_tag_values: { key: "env" },
  query_costs: { group_by_dimensions: ["service"] },
};

// A marker that could only have come from the response body. Any tool whose
// summary reproduces it is putting tenant-controlled text into the narrative.
const MARK = "ZZ-TENANT-STRING-ZZ";

/**
 * A body shaped like the real thing, salted with MARK in every string position
 * a real response would carry customer-authored text.
 */
function populatedBody(): Record<string, unknown> {
  const row = {
    resource_id: MARK,
    resource_name: MARK,
    account_name: MARK,
    title: MARK,
    description: MARK,
    service: MARK,
    name: MARK,
    tags: { [MARK]: MARK },
    amount: 12.5,
    cost: 12.5,
    usd_amount: 99,
    total_cost: 42,
    has_cost_data: true,
    thresholdValue: 80,
    date: "2026-08-01",
    field: MARK,
    old_value: MARK,
    new_value: MARK,
  };
  return {
    // every envelope key any present() looks for
    resources: [row],
    opportunities: [row],
    anomalies: [row],
    rows: [row],
    data: [row],
    versions: [row],
    history: [row],
    budgets: [row],
    values: [MARK],
    providers: [MARK],
    types: [row],
    regions: [row],
    accounts: [row],
    keys: [MARK],
    tags: [MARK],
    services: [MARK],
    total: 1,
    count: 1,
    supports_history: true,
    summary: { total: 1234.5 },
    current: { total: 1000 },
    comparison: { percent: 12 },
    pagination: { total: 1 },
  };
}

/** The same envelope with every collection empty. */
function emptyBody(): Record<string, unknown> {
  const b = populatedBody();
  for (const [k, v] of Object.entries(b)) if (Array.isArray(v)) b[k] = [];
  b.total = 0;
  b.count = 0;
  b.pagination = { total: 0 };
  return b;
}

const withPresent = TOOL_DEFS.filter((t): t is ToolDef & { present: NonNullable<ToolDef["present"]> } =>
  typeof t.present === "function",
);

describe("every tool's present() runs and behaves", () => {
  it("covers most of the surface, so this file is worth trusting", () => {
    expect(withPresent.length).toBeGreaterThanOrEqual(20);
  });

  for (const t of withPresent) {
    const args = ARGS[t.name] ?? {};

    it(`${t.name}: returns structured output and a non-empty summary`, () => {
      const out = t.present(populatedBody(), args);
      expect(out.structured, `${t.name} structured`).toBeTypeOf("object");
      expect(out.text.length, `${t.name} text`).toBeGreaterThan(0);
    });

    it(`${t.name}: keeps response strings out of the summary`, () => {
      // The rows still reach the model in structuredContent, where JSON escaping
      // applies. The prose block — the part read as narrative — must be built
      // from counts and totals only.
      const out = t.present(populatedBody(), args);
      expect(out.text, `${t.name} leaked a body string into its summary`).not.toContain(MARK);
    });

    it(`${t.name}: survives an empty body without throwing`, () => {
      expect(() => t.present({}, args)).not.toThrow();
      expect(() => t.present(null, args)).not.toThrow();
      expect(() => t.present(undefined, args)).not.toThrow();
    });

    it(`${t.name}: survives a body of the wrong shape`, () => {
      // A misconfigured or changed backend should degrade, not crash the server.
      expect(() => t.present([], args)).not.toThrow();
      expect(() => t.present("a string", args)).not.toThrow();
      expect(() => t.present(42, args)).not.toThrow();
    });
  }
});

describe("empty results are directed, not just zero", () => {
  // Zero rows is where models thrash: the common failure is retrying the same
  // query with one grouping changed. Every list-shaped tool should name a next
  // action instead.
  const listTools = [
    "query_costs",
    "list_savings_opportunities",
    "list_budgets",
    "get_budget_history",
    "get_budget_resources",
    "list_anomalies",
    "list_resources",
    "search_resources",
    "get_resource_history",
    "list_inventory_facets",
    "list_tag_values",
  ];

  for (const name of listTools) {
    it(`${name}: says what to try next`, () => {
      const t = TOOL_DEFS.find((d) => d.name === name);
      expect(t, name).toBeDefined();
      const out = t!.present!(emptyBody(), ARGS[name] ?? {});
      expect(out.text, `${name} empty summary`).toMatch(/No .+ matched|does not record/i);
      // More than a bare negative: something actionable.
      expect(out.text.length, `${name} gave a bare "no results"`).toBeGreaterThan(40);
    });
  }

  it("query_costs names the retry anti-pattern explicitly", () => {
    const t = TOOL_DEFS.find((d) => d.name === "query_costs")!;
    const out = t.present!(emptyBody(), { group_by_dimensions: ["service"] });
    expect(out.text).toMatch(/not retry with only the grouping changed/i);
  });

  it("get_resource_history explains a provider that keeps no history", () => {
    const t = TOOL_DEFS.find((d) => d.name === "get_resource_history")!;
    const out = t.present!({ supports_history: false, versions: [] }, ARGS.get_resource_history);
    expect(out.text).toMatch(/does not record configuration history/i);
  });

  it("get_resource_costs names a low-confidence match instead of burying it", () => {
    // A GKE cluster's cost is inferred from labels on the underlying Compute
    // Engine VMs. The number looks identical to a billed charge, and left in
    // structuredContent alone the flag goes unread — so the estimate gets
    // reported as a bill.
    const t = TOOL_DEFS.find((d) => d.name === "get_resource_costs")!;
    const out = t.present!(
      {
        resources: [
          { resource_id: "a", has_cost_data: true, total_cost: 10, match_confidence: "high" },
          { resource_id: "b", has_cost_data: true, total_cost: 20, match_confidence: "low" },
        ],
      },
      ARGS.get_resource_costs,
    );
    expect(out.text).toMatch(/low confidence/i);
    expect(out.text).toMatch(/labels/i);
    expect(out.text).toMatch(/estimate/i);
  });

  it("get_resource_costs reports the weakest match in the batch, not the best", () => {
    const t = TOOL_DEFS.find((d) => d.name === "get_resource_costs")!;
    const medium = t.present!(
      {
        resources: [
          { resource_id: "a", has_cost_data: true, match_confidence: "high" },
          { resource_id: "b", has_cost_data: true, match_confidence: "medium" },
        ],
      },
      ARGS.get_resource_costs,
    );
    expect(medium.text).toMatch(/medium confidence/i);
    expect(medium.text).toMatch(/resource name/i);
    expect(medium.text).not.toMatch(/low confidence/i);
  });

  it("get_resource_costs stays quiet when every match was made on the billing id", () => {
    const t = TOOL_DEFS.find((d) => d.name === "get_resource_costs")!;
    const out = t.present!(
      { resources: [{ resource_id: "a", has_cost_data: true, match_confidence: "high" }] },
      ARGS.get_resource_costs,
    );
    expect(out.text).not.toMatch(/confidence/i);
  });

  it("get_resource_costs warns that its totals are a different dataset from query_costs", () => {
    // The reconciliation trap: per-resource costs and aggregate costs read
    // separately-refreshed materialized views. Summing here and comparing there
    // produces a gap that invites an invented explanation.
    const t = TOOL_DEFS.find((d) => d.name === "get_resource_costs")!;
    const out = t.present!({ resources: [{ resource_id: "a", has_cost_data: true }] }, ARGS.get_resource_costs);
    expect(out.text).toMatch(/refreshed separately/i);
    expect(out.text).toMatch(/query_costs/);
  });

  it("get_resource_costs distinguishes 'no data' from 'no such resource'", () => {
    const t = TOOL_DEFS.find((d) => d.name === "get_resource_costs")!;
    const out = t.present!(
      { resources: [{ resource_id: "i-1", has_cost_data: false }] },
      ARGS.get_resource_costs,
    );
    expect(out.text).toMatch(/0 had attributable cost/);
    expect(out.text).toMatch(/normal/i);
  });
});

describe("partial pages announce themselves", () => {
  it("list_resources warns when the page is a subset", () => {
    const t = TOOL_DEFS.find((d) => d.name === "list_resources")!;
    const out = t.present!({ resources: [{ resource_id: "i-1" }], total: 900 }, { limit: 1 });
    expect(out.text).toMatch(/900 match in total/);
    expect(out.text).toMatch(/do not assume/i);
  });

  it("stays quiet when the page is the whole set", () => {
    const t = TOOL_DEFS.find((d) => d.name === "list_resources")!;
    const out = t.present!({ resources: [{ resource_id: "i-1" }], total: 1 }, { limit: 50 });
    expect(out.text).not.toMatch(/in total/);
  });
});

describe("numbers that matter reach the summary", () => {
  it("get_spend_summary surfaces the total and the change", () => {
    const t = TOOL_DEFS.find((d) => d.name === "get_spend_summary")!;
    const out = t.present!({ current: { total: 4210.5 }, comparison: { percent: -12.4 } }, {});
    expect(out.text).toContain("4210.5");
    expect(out.text).toContain("-12.4");
  });

  it("get_cost_breakdown surfaces the report total when present", () => {
    const t = TOOL_DEFS.find((d) => d.name === "get_cost_breakdown")!;
    expect(t.present!({ summary: { total: 987.65 } }, {}).text).toContain("987.65");
  });

  it("list_filter_values reports how many values each dimension has", () => {
    const t = TOOL_DEFS.find((d) => d.name === "list_filter_values")!;
    const out = t.present!({ services: ["a", "b"], regions: ["c"] }, {});
    expect(out.text).toMatch(/services: 2/);
    expect(out.text).toMatch(/regions: 1/);
  });
});
