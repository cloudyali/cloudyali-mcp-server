import { describe, expect, it } from "vitest";
import { TOOL_DEFS, validateArgs } from "./index.js";
import { RESPONSE_POLICY } from "../shapes.js";
import { project } from "../project.js";

const tool = (n: string) => TOOL_DEFS.find((t) => t.name === n)!;
const shapeFor = (a: string) => {
  const p = RESPONSE_POLICY[a];
  if (p.kind !== "allowlist") throw new Error(`${a} not allowlisted`);
  return p.shape;
};

describe("days is a server-side enum, so it is rejected here rather than at the API", () => {
  // 7/30/90 is a hard set: anything else returns 400 unsupported_range. Until this
  // param existed the numeric branch of validateArgs ignored `enum` entirely, so
  // days:60 sailed through and failed one layer down, where the error names the
  // API rather than the argument.
  it("accepts the three allowed windows", () => {
    for (const days of [7, 30, 90]) {
      expect(validateArgs(tool("run_cost_view").inputSchema, { id: "v1", days })).toEqual({ id: "v1", days });
    }
  });

  it("rejects a plausible-but-invalid window, naming the allowed set", () => {
    expect(() => validateArgs(tool("run_cost_view").inputSchema, { id: "v1", days: 60 })).toThrow(
      /got 60\. Allowed: 7, 30, 90/,
    );
  });

  it("applies to the detail tool too", () => {
    expect(() => validateArgs(tool("get_cost_view_detail").inputSchema, { id: "v1", days: 45 })).toThrow(
      /Allowed: 7, 30, 90/,
    );
  });
});

describe("the freshness watermark is the only thing that can say a total is incomplete", () => {
  const t = tool("run_cost_view");
  const base = { view_total: 100, share_of_total: 0.25, totals: { a: 100 } };

  it("warns when billing data stops short of the window, and says what the dip is", () => {
    // Partial ingestion surfaces as an earlier watermark and never as an error, so
    // without this the last days of the series read as a genuine drop in spend.
    const out = t.present!(
      { ...base, range: { days: 30, start: "2026-08-03", end: "2026-09-02" }, data_freshness: "2026-08-28T00:00:00Z" },
      {},
    );
    expect(out.text).toMatch(/only reaches 2026-08-28/);
    expect(out.text).toMatch(/short of the window's end \(2026-09-01\)/);
    expect(out.text).toMatch(/missing data rather than reduced spend/);
  });

  it("stays quiet when the data reaches the end of the window", () => {
    const out = t.present!(
      { ...base, range: { days: 30, start: "2026-08-03", end: "2026-09-02" }, data_freshness: "2026-09-01T00:00:00Z" },
      {},
    );
    expect(out.text).not.toMatch(/incomplete|only reaches/);
  });

  it("calls a null watermark an absence, not a zero", () => {
    const out = t.present!({ ...base, range: { days: 7, end: "2026-09-02" }, data_freshness: null }, {});
    expect(out.text).toMatch(/not a zero, it is an absence/);
  });

  it("reports the share of the whole bill, which is the reason to run a view", () => {
    const out = t.present!({ ...base, range: { days: 30, end: "2026-09-02" }, data_freshness: "2026-09-01" }, {});
    expect(out.text).toMatch(/25\.0% of the whole bill/);
  });
});

describe("a missing resource id is an answer, not a gap", () => {
  const t = tool("get_cost_view_detail");
  it("counts the resourceless rows and says to keep them", () => {
    // Resourceless line items and AI provider spend legitimately have none. Read as
    // a lookup failure they get dropped from a sum, which quietly understates.
    const out = t.present!(
      {
        rows: [
          { day: "2026-09-01", group: "EC2", resource_id: "i-1", cost: 10 },
          { day: "2026-09-01", group: "Claude", resource_id: null, cost: 5 },
        ],
        pagination: { limit: 50, offset: 0, count: 2 },
      },
      {},
    );
    expect(out.text).toMatch(/1 carry no resource id/);
    expect(out.text).toMatch(/not a lookup failure/);
    expect(out.text).toMatch(/Keep them in any total/);
  });

  it("passes a null resource_id through the shape rather than dropping the row", () => {
    const out = project(
      { view_id: "v", rows: [{ day: "d", group: "g", resource_id: null, cost: 1 }], pagination: { limit: 1, offset: 0, count: 1 } },
      shapeFor("views.detail"),
    ) as { rows: Array<{ resource_id: unknown }> };
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].resource_id).toBeNull();
  });
});

describe("the view definition does not leak its internals", () => {
  it("drops query_spec and the audit columns", () => {
    // query_spec is an internal query DSL as a raw blob. A model runs a view by id;
    // it has no use for the compiled definition, and relaying it is the same rule
    // that keeps storage design out of every other response.
    const out = project(
      [{
        id: "v1", name: "Spend by service", description: "…", collection_tags: ["core"],
        default_chart_type: "bar", builtin: true,
        query_spec: { group_by: { kind: "billing_field", field: "product_service_code" }, filter: { op: "and", clauses: [] } },
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
      }],
      shapeFor("views.list"),
    );
    expect(JSON.stringify(out)).not.toMatch(/query_spec|product_service_code|created_at|updated_at/);
    expect(out).toEqual([{ id: "v1", name: "Spend by service", description: "…", collection_tags: ["core"], default_chart_type: "bar", builtin: true }]);
  });
});

describe("the view tools stay read-only", () => {
  it("maps each onto a read-only catalog action with a policy", () => {
    for (const n of ["list_cost_views", "run_cost_view", "get_cost_view_detail"]) {
      const t = tool(n);
      const call = t.call({ id: "v1" });
      expect(call.action, n).toMatch(/^views\./);
      expect(RESPONSE_POLICY[call.action], `${n} has no response policy`).toBeDefined();
    }
  });

  it("exposes no way to create, edit or delete a definition", () => {
    // The definitions are global and CloudYali-managed: a write here would change
    // what every customer sees, and the backend's admin guard for those routes is
    // still an open item.
    const names = TOOL_DEFS.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/create_cost_view|update_cost_view|delete_cost_view|save_cost_view/);
  });
});
