import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog.js";
import { REDACTED_ACTIONS, RESPONSE_POLICY } from "./shapes.js";
import { shapeResponse } from "./execute.js";

describe("response policy coverage", () => {
  it("defines a policy for every catalog action", () => {
    const missing = CATALOG.filter((a) => !RESPONSE_POLICY[a.id]).map((a) => a.id);
    expect(missing, "actions with no response policy — add them to src/shapes.ts").toEqual([]);
  });

  it("defines no policy for an action that does not exist", () => {
    const ids = new Set(CATALOG.map((a) => a.id));
    const orphans = Object.keys(RESPONSE_POLICY).filter((id) => !ids.has(id));
    expect(orphans, "stale policies for removed actions").toEqual([]);
  });

  it("holds the redaction stopgap to exactly the actions we accepted it for", () => {
    // This list must shrink, never grow. Growing it means a new action shipped
    // without its field list being read. See the note in project.ts.
    expect(REDACTED_ACTIONS).toEqual([
      "anomalies.summary",
      "cost.aggregate",
      "cost.filter_parameters_for_budgets",
      "cost.report",
      "cost.spend",
      "inventory.stats",
      "recommendations.summary",
    ]);
  });

  it("puts every action carrying a Tier-1 or Tier-2 leak on a real allowlist", () => {
    for (const id of [
      "inventory.list",
      "inventory.search",
      "inventory.get",
      "inventory.history",
      "recommendations.list",
      "recommendations.get",
      "anomalies.list",
      "anomalies.get",
      "anomalies.preferences_get",
      "budgets.list",
      "budgets.get",
      "budgets.resources",
      "cost.filters",
    ]) {
      expect(RESPONSE_POLICY[id]?.kind, `${id} must not rely on redaction`).toBe("allowlist");
    }
  });
});

describe("shapeResponse: the reported leak, end to end", () => {
  it("strips customer_id from an inventory list response", () => {
    const body = {
      resources: [
        {
          customer_id: 210,
          resource_id: "i-0abc123",
          resource_name: "prod-web-01",
          cloud_provider: "aws",
          region: "us-east-1",
          tags: { env: "prod" },
          properties: { InstanceType: "m5.large", raw: "…" },
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    };
    const out = shapeResponse("inventory.list", body);
    const json = JSON.stringify(out);
    expect(json).not.toContain("customer_id");
    expect(json).not.toContain("210");
    expect(json).not.toContain("properties");
    expect(json).toContain("prod-web-01");
    expect(json).toContain("us-east-1");
  });

  it("strips the alert-channel credential blob", () => {
    const out = shapeResponse("anomalies.preferences_get", {
      id: "9f0c-uuid",
      customerId: 210,
      accountId: "123456789012",
      channel: "slack",
      channelConfig: { webhook_url: "https://hooks.slack.com/services/T00/B00/XXXX" },
      thresholdAmount: 100,
      enabled: true,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("hooks.slack.com");
    expect(json).not.toContain("channelConfig");
    expect(json).not.toContain("customerId");
    expect(json).toContain("slack"); // the channel type is still useful
    expect(json).toContain("100");
  });

  it("strips budget alert recipient emails", () => {
    const out = shapeResponse("budgets.get", {
      id: 7,
      customerId: 210,
      name: "Platform",
      amount: 5000,
      currentSpent: 4210,
      alerts: [{ id: 3, budgetId: 7, email: "finance@acme.com", thresholdType: "percent", thresholdValue: 80 }],
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("finance@acme.com");
    expect(json).not.toContain("customerId");
    expect(json).toContain("Platform");
    expect(json).toContain("4210");
  });

  it("strips engineer emails from the cost filter vocabulary", () => {
    const out = shapeResponse("cost.filters", {
      services: ["AmazonEC2"],
      regions: ["us-east-1"],
      users: ["alice@acme.com", "bob@acme.com"],
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("alice@acme.com");
    expect(json).toContain("AmazonEC2");
  });

  it("removes tenant keys from a redacted cost response while keeping the numbers", () => {
    const out = shapeResponse("cost.report", {
      chart_data: { series: [{ name: "AmazonEC2", points: [{ t: "2026-08-01", v: 1234.5 }] }] },
      summary: { total: 9876.5 },
      metadata: { processing_time: "412ms", record_count: 88123, interval: "daily" },
      customer_id: 210,
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("customer_id");
    expect(json).not.toContain("processing_time");
    expect(json).not.toContain("88123");
    expect(json).toContain("1234.5");
    expect(json).toContain("9876.5");
    expect(json).toContain("daily");
  });
});

describe("shapeResponse: fails closed", () => {
  it("withholds the body of an action with no policy rather than relaying it", () => {
    const out = shapeResponse("some.unmapped.action", { customer_id: 210, secret: "leak" }) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(out)).not.toContain("210");
    expect(String(out.note)).toMatch(/no response policy/i);
  });
});

describe("no catalog response can carry a tenant key", () => {
  // A blunt end-to-end sweep: feed every action a body salted with every leak
  // pattern we know of and assert none of it survives. This is the regression
  // test for the whole class, not just the fields we happened to think of.
  const salted = {
    customer_id: 210,
    customerId: 210,
    channelConfig: { webhook_url: "https://hooks.slack.com/services/T/B/x" },
    email: "someone@acme.com",
    changed_by: "someone@acme.com",
    properties: { raw: "provider blob" },
    users: ["engineer@acme.com"],
    processing_time: "412ms",
    // Detector and engine internals. zScore was allowlisted on the anomaly
    // shape and reached a user; the leak scanner could not see it, because it
    // reads descriptions and schemas rather than field names. This sweep does.
    zScore: 8.0,
    z_score: 8.0,
    engine_version: "v3",
    rule_id: "idle_ebs_v2",
    config_checksum: "abc123",
    rootCauseAnalysis: { top_driver: "internal" },
  };

  for (const action of CATALOG) {
    it(`${action.id} leaks nothing from a salted body`, () => {
      const json = JSON.stringify(shapeResponse(action.id, { ...salted }) ?? {});
      for (const needle of [
        "customer_id",
        "customerId",
        "channelConfig",
        "hooks.slack.com",
        "someone@acme.com",
        "engineer@acme.com",
        "provider blob",
        "processing_time",
        "zScore",
        "z_score",
        "engine_version",
        "rule_id",
        "config_checksum",
        "rootCauseAnalysis",
      ]) {
        expect(json, `${action.id} leaked ${needle}`).not.toContain(needle);
      }
    });
  }
});
