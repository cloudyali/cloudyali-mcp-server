import { describe, expect, it } from "vitest";
import { TOOL_BY_NAME, TOOL_DEFS, validateArgs } from "./index.js";
import { RESPONSE_POLICY } from "../shapes.js";
import { project } from "../project.js";

const tool = (n: string) => TOOL_DEFS.find((t) => t.name === n)!;
const shapeFor = (a: string) => {
  const p = RESPONSE_POLICY[a];
  if (p.kind !== "allowlist") throw new Error(`${a} not allowlisted`);
  return p.shape;
};

// resolve_facets replaced list_filter_values (cost only) and four of the five
// facets list_inventory_facets served. The fifth — tag keys — is deliberately
// not a facets dimension, so it needed its own tool rather than a redirect to
// one that would answer 400.

describe("resolve_facets sends its narrowing arguments in the body", () => {
  // Every narrowing argument is a body field. If any of them leaked into the
  // query string the request would still succeed — unfiltered — and return a
  // full vocabulary that reads as a valid answer to a narrowed question.
  it("puts domain, selected, dimensions, search and period in the body", () => {
    const args = {
      domain: "cost",
      dimensions: ["service"],
      selected: { provider: ["aws"] },
      search: { service: "Elastic" },
      period: { from: "2026-08-01T00:00:00Z", to: "2026-08-31T00:00:00Z" },
    };
    const spec = tool("resolve_facets").call(validateArgs(tool("resolve_facets").inputSchema, args));
    expect(spec.action).toBe("facets.resolve");
    expect(spec.body).toEqual(args);
    expect(spec.query_params).toBeUndefined();
  });

  it("rejects a domain the endpoint does not have, naming the four it does", () => {
    expect(() => validateArgs(tool("resolve_facets").inputSchema, { domain: "budgets" })).toThrow(
      /Allowed: cost, inventory, anomalies, savings/,
    );
  });

  it("requires a domain — there is no default that is right for every surface", () => {
    expect(() => validateArgs(tool("resolve_facets").inputSchema, {})).toThrow(/Missing required argument "domain"/);
  });
});

describe("the facets response is projected, not passed through", () => {
  it("keeps the dimension map and drops everything else", () => {
    const value = project(
      {
        domain: "cost",
        as_of: "2026-08-31T00:00:00Z",
        customer_id: 210,
        dimensions: { service: { values: [{ value: "AmazonEC2", label: null, status: "active", internal_rank: 3 }], truncated: false } },
        query_ms: 42,
      },
      shapeFor("facets.resolve"),
    );
    expect(value).toEqual({
      domain: "cost",
      as_of: "2026-08-31T00:00:00Z",
      dimensions: { service: { values: [{ value: "AmazonEC2", label: null, status: "active" }], truncated: false } },
    });
  });
});

describe("list_tag_keys covers the one dimension facets does not", () => {
  it("routes to the inventory tag-key endpoint", () => {
    const spec = tool("list_tag_keys").call({ limit: 500 });
    expect(spec.action).toBe("inventory.tag_keys");
    expect(spec.query_params).toEqual({ limit: 500 });
  });

  it("points at resolve_facets for the dimensions it does not serve", () => {
    expect(tool("list_tag_keys").description).toMatch(/resolve_facets/);
  });

  // A page that exactly fills the limit is indistinguishable from a complete
  // one, and the caller has no total to compare against. Saying so is the only
  // thing standing between that and "this account has 100 tag keys".
  it("says a full page may not be the whole set", () => {
    const out = tool("list_tag_keys").present!({ keys: ["a", "b"] }, { limit: 2 });
    expect(out.text).toMatch(/not necessarily all of them/);
  });

  it("says nothing of the sort when the page is short", () => {
    const out = tool("list_tag_keys").present!({ keys: ["a"] }, { limit: 100 });
    expect(out.text).not.toMatch(/not necessarily all of them/);
  });
});

describe("the tools they replaced are gone, not shadowed", () => {
  it("no longer exposes list_filter_values or list_inventory_facets", () => {
    expect(TOOL_BY_NAME.has("list_filter_values")).toBe(false);
    expect(TOOL_BY_NAME.has("list_inventory_facets")).toBe(false);
  });

  // A dangling name in a description is worse than none: the model calls it,
  // gets "unknown tool", and has no idea what to call instead.
  it("leaves no reference to them in any model-facing description", () => {
    for (const t of TOOL_DEFS) {
      const text = t.description + JSON.stringify(t.inputSchema);
      expect(text, t.name).not.toMatch(/list_filter_values|list_inventory_facets/);
    }
  });
});
