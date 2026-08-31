import { describe, expect, it } from "vitest";
import { Shape, project, projectBody } from "./project.js";

describe("project: the leak this was written to close", () => {
  it("drops customer_id from an inventory resource", () => {
    const shape: Shape = { resource_id: "value", resource_name: "value", region: "value" };
    const row = {
      customer_id: 210,
      resource_id: "i-0abc",
      resource_name: "prod-web-01",
      region: "us-east-1",
    };
    expect(project(row, shape)).toEqual({
      resource_id: "i-0abc",
      resource_name: "prod-web-01",
      region: "us-east-1",
    });
  });

  it("drops an alert-channel config blob even though its keys look innocuous", () => {
    const shape: Shape = { channel: "value", enabled: "value" };
    const prefs = {
      channel: "slack",
      enabled: true,
      channelConfig: { webhook_url: "https://hooks.slack.com/services/T/B/xxxx" },
      customerId: 210,
    };
    const out = project(prefs, shape) as Record<string, unknown>;
    expect(out).toEqual({ channel: "slack", enabled: true });
    expect(JSON.stringify(out)).not.toContain("hooks.slack.com");
  });

  it("drops PII from a budget alert list", () => {
    const shape: Shape = [{ thresholdType: "value", thresholdValue: "value" }];
    const alerts = [
      { id: 42, budgetId: 7, email: "finance@acme.com", thresholdType: "percent", thresholdValue: 80 },
    ];
    expect(project(alerts, shape)).toEqual([{ thresholdType: "percent", thresholdValue: 80 }]);
  });
});

describe("project: the allowlist cannot be widened by accident", () => {
  it('"value" refuses to emit an object, so a new nested struct cannot ride through', () => {
    const shape: Shape = { total: "value" };
    // The API grew `total` from a number into an object. Under a denylist this
    // would leak whatever is inside it; here it is simply dropped.
    expect(project({ total: { amount: 5, internal_ref: "x" } }, shape)).toEqual({});
  });

  it('"value" allows an array of primitives but not an array of objects', () => {
    expect(project({ tags: ["a", "b"] }, { tags: "value" })).toEqual({ tags: ["a", "b"] });
    expect(project({ tags: [{ k: "v" }] }, { tags: "value" })).toEqual({});
  });

  it('"map" keeps flat tag maps but strips nested values inside them', () => {
    const out = project({ tags: { env: "prod", nested: { a: 1 } } }, { tags: "map" });
    expect(out).toEqual({ tags: { env: "prod" } });
  });

  it("drops unknown keys at every depth, not just the top level", () => {
    const shape: Shape = { summary: { total: "value" } };
    const out = project({ summary: { total: 10, record_count: 99, processing_time: "3ms" } }, shape);
    expect(out).toEqual({ summary: { total: 10 } });
  });

  it("recurses through arrays of objects", () => {
    const shape: Shape = { rows: [{ service: "value", cost: "value" }] };
    const out = project(
      { rows: [{ service: "AmazonEC2", cost: 12.5, customer_id: 210 }], extra: "no" },
      shape,
    );
    expect(out).toEqual({ rows: [{ service: "AmazonEC2", cost: 12.5 }] });
  });
});

describe("project: absent vs null", () => {
  it("omits keys the API did not send rather than inventing nulls", () => {
    const out = project({ a: 1 }, { a: "value", b: "value" }) as Record<string, unknown>;
    expect(out).toEqual({ a: 1 });
    expect("b" in out).toBe(false);
  });

  it("preserves an explicit null, which is a real answer", () => {
    expect(project({ a: null }, { a: "value" })).toEqual({ a: null });
  });

  it("preserves a null where an object or array was expected", () => {
    expect(project({ page: null }, { page: { n: "value" } })).toEqual({ page: null });
    expect(project({ rows: null }, { rows: [{ n: "value" }] })).toEqual({ rows: null });
  });

  it("keeps an empty array as an empty array", () => {
    expect(project({ rows: [] }, { rows: [{ n: "value" }] })).toEqual({ rows: [] });
  });
});

describe("projectBody: envelopes and hostile bodies", () => {
  it("withholds a non-JSON body instead of relaying it", () => {
    const out = projectBody("<html><body>502 Bad Gateway from inventory-svc.prod.local</body></html>", {
      a: "value",
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("prod.local");
    expect(out.note).toMatch(/not JSON/i);
  });

  it("passes null and undefined through untouched", () => {
    expect(projectBody(null, { a: "value" })).toBeNull();
    expect(projectBody(undefined, { a: "value" })).toBeUndefined();
  });

  it("projects a top-level array body", () => {
    const out = projectBody([{ name: "b1", customerId: 210 }], [{ name: "value" }]);
    expect(out).toEqual([{ name: "b1" }]);
  });
});

describe("project: shape audit", () => {
  it("records the dot-path of every dropped field so gaps are observable", () => {
    const dropped = new Set<string>();
    project(
      { keep: 1, customer_id: 210, nested: { keep: 2, secret: "x" }, rows: [{ keep: 3, drop: 4 }] },
      { keep: "value", nested: { keep: "value" }, rows: [{ keep: "value" }] },
      { dropped },
    );
    expect([...dropped].sort()).toEqual(["customer_id", "nested.secret", "rows[0].drop"]);
  });

  it("records nothing when the shape covers the response completely", () => {
    const dropped = new Set<string>();
    project({ a: 1, b: "x" }, { a: "value", b: "value" }, { dropped });
    expect([...dropped]).toEqual([]);
  });
});
