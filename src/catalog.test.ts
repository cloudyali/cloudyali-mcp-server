import { describe, expect, it } from "vitest";
import { Action, CATALOG, READ_ONLY_CATALOG, findAction, isBlockedAction, searchActions } from "./catalog.js";

function makeAction(overrides: Partial<Action>): Action {
  return {
    id: "test.action",
    method: "GET",
    path: "/v1/test",
    category: "cost",
    summary: "test",
    description: "test",
    readOnly: true,
    ...overrides,
  };
}

describe("isBlockedAction", () => {
  it("blocks PUT and DELETE methods", () => {
    expect(isBlockedAction(makeAction({ method: "PUT" })).blocked).toBe(true);
    expect(isBlockedAction(makeAction({ method: "DELETE" })).blocked).toBe(true);
  });

  it("allows only GET and POST (method allowlist, not denylist)", () => {
    // Cast past the type union: a future Action type widened with PATCH must
    // still be blocked at runtime without remembering to extend a denylist.
    const patch = makeAction({ method: "PATCH" as Action["method"] });
    expect(isBlockedAction(patch).blocked).toBe(true);
  });

  it("blocks actions marked readOnly false", () => {
    expect(isBlockedAction(makeAction({ readOnly: false })).blocked).toBe(true);
  });

  it("blocks denylisted paths regardless of method", () => {
    expect(isBlockedAction(makeAction({ path: "/v1/accounts/7" })).blocked).toBe(true);
    expect(isBlockedAction(makeAction({ path: "/v1/accounts/7/sync" })).blocked).toBe(true);
    expect(isBlockedAction(makeAction({ path: "/v1/account/registration/job" })).blocked).toBe(true);
    expect(isBlockedAction(makeAction({ path: "/v1/users" })).blocked).toBe(true);
  });

  it("allows a plain read action", () => {
    expect(isBlockedAction(makeAction({})).blocked).toBe(false);
  });
});

describe("CATALOG read-only invariants", () => {
  it("contains only readOnly actions that pass the blocklist", () => {
    for (const a of CATALOG) {
      expect(a.readOnly, `${a.id} must be readOnly`).toBe(true);
      expect(isBlockedAction(a).blocked, `${a.id} must not be blocked`).toBe(false);
    }
    expect(READ_ONLY_CATALOG).toHaveLength(CATALOG.length);
  });

  it("contains only GET and POST methods", () => {
    for (const a of CATALOG) {
      expect(["GET", "POST"], `${a.id} method`).toContain(a.method);
    }
  });
});

describe("catalog ↔ backend contract", () => {
  it("recommendations.summary declares the filters its backend accepts", () => {
    const a = findAction("recommendations.summary");
    expect(a?.queryParams).toBeDefined();
    for (const p of ["provider", "status", "resourceType", "minSavings", "assignedUser"]) {
      expect(a?.queryParams?.[p], `queryParams.${p}`).toBeDefined();
    }
  });

  it("anomalies.summary declares startDate/endDate", () => {
    const a = findAction("anomalies.summary");
    expect(a?.queryParams?.startDate).toBeDefined();
    expect(a?.queryParams?.endDate).toBeDefined();
  });

  it("assignedUser params use comma serialization (backend splits on comma)", () => {
    expect(findAction("recommendations.list")?.queryParams?.assignedUser?.serializeArray).toBe("comma");
    expect(findAction("recommendations.summary")?.queryParams?.assignedUser?.serializeArray).toBe("comma");
  });

  it("cost.aggregate documents the interval values the backend matches", () => {
    // Backend matches only daily/weekly/monthly; 'day' silently drops the time series.
    const desc = findAction("cost.aggregate")?.bodyParams?.interval?.description ?? "";
    expect(desc).toMatch(/daily.*weekly.*monthly/);
    expect(desc).not.toMatch(/\bday\b/);
  });

  it("recommendations.list does not invite comma-separated multi-values (backend rejects them)", () => {
    const desc = findAction("recommendations.list")?.queryParams?.provider?.description ?? "";
    expect(desc.toLowerCase()).not.toContain("comma-separate");
  });

  it("cost cost_type is an object with an inclusions array, not a string (backend binds {inclusions:[]})", () => {
    // Backend CostType is `struct { Inclusions []string }`; a JSON string 400s the
    // whole request. All three cost POST actions that expose cost_type must type it
    // as an object and name the `inclusions` key.
    for (const id of ["cost.report", "cost.aggregate", "cost.spend"]) {
      const p = findAction(id)?.bodyParams?.cost_type;
      expect(p?.type, `${id} cost_type type`).toBe("object");
      expect(p?.description ?? "", `${id} cost_type description`).toContain("inclusions");
      // The fictional "unblended/amortized/net" values must be gone.
      expect((p?.description ?? "").toLowerCase(), `${id} stale values`).not.toContain("unblended");
    }
  });

  it("cost filters document the mandatory cloud_providers group (backend 400s without it)", () => {
    // ValidateCloudProviderFilters requires every filter group to carry a
    // cloud_providers condition with operator "equals" and one provider value.
    for (const id of ["cost.report", "cost.aggregate", "cost.spend", "cost.filters"]) {
      const desc = findAction(id)?.bodyParams?.filters?.description ?? "";
      expect(desc, `${id} filters description`).toContain("cloud_providers");
      // The fictional "dimension/operator/values" plural shape must be gone.
      expect(desc, `${id} stale filter shape`).not.toMatch(/dimension\/operator\/values/);
    }
  });

  it("recommendations.summary types provider/resourceType as single-value (backend drops multi-value)", () => {
    // Backend applies the summary provider/resourceType filter ONLY when exactly one
    // value is given; multiple values silently return the all-providers rollup. So
    // these must be single-value (string), unlike recommendations.list which does IN.
    const a = findAction("recommendations.summary");
    expect(a?.queryParams?.provider?.type, "summary provider type").toBe("string");
    expect(a?.queryParams?.resourceType?.type, "summary resourceType type").toBe("string");
    // status remains genuinely multi-value on the summary endpoint.
    expect(a?.queryParams?.status?.type, "summary status type").toBe("array");
    // The misleading "same filters as recommendations.list" claim must be gone.
    expect(a?.description ?? "").not.toContain("same filters as recommendations.list");
  });

  it("cost.report marks start_time/end_time required (backend 400s without them)", () => {
    const a = findAction("cost.report");
    expect(a?.bodyParams?.start_time?.required, "start_time required").toBe(true);
    expect(a?.bodyParams?.end_time?.required, "end_time required").toBe(true);
    // The fictional per-report defaults must be gone.
    expect((a?.bodyParams?.start_time?.description ?? "").toLowerCase()).not.toContain("30 days");
  });

  it("cost.aggregate documents its real start/end defaults (that is where defaulting lives)", () => {
    const a = findAction("cost.aggregate");
    expect((a?.bodyParams?.start_time?.description ?? "").toLowerCase()).toContain("30 days");
  });

  it("budgets.summary describes count fields only, not dollar amounts (backend returns no spend)", () => {
    const desc = findAction("budgets.summary")?.description ?? "";
    expect(desc).toContain("totalBudgets");
    // Backend returns only health counts — the old 'budgeted amount / actual spend' claim was false.
    expect(desc.toLowerCase()).not.toContain("actual spend");
    expect(desc.toLowerCase()).not.toContain("total budgeted amount");
  });

  it("recommendations.filter_options names the fields the backend actually returns", () => {
    const desc = findAction("recommendations.filter_options")?.description ?? "";
    expect(desc).toContain("opportunityTypes");
    expect(desc).toContain("resourceLocations");
    // It does NOT return providers/statuses/users — those claims must be gone.
    expect(desc.toLowerCase()).not.toContain("assignable users");
  });

  it("inventory.search state default is 'all', not 'active' (backend treats absent as all)", () => {
    const desc = findAction("inventory.search")?.bodyParams?.state?.description ?? "";
    expect(desc.toLowerCase()).not.toMatch(/default:\s*active/);
    expect(desc.toLowerCase()).toContain("all");
  });

  it("inventory.get exposes a provider hint and documents the slash-ID limitation", () => {
    const a = findAction("inventory.get");
    // provider query param disambiguates cross-cloud IDs (backend reads it).
    expect(a?.queryParams?.provider, "provider query param").toBeDefined();
    // GCP/Azure IDs contain '/' and cannot be fetched here — the docs must say so.
    const text = `${a?.description ?? ""} ${a?.pathParams?.id?.description ?? ""}`.toLowerCase();
    expect(text).toMatch(/gcp|azure|slash|\//);
  });

  it("inventory tags document that value is an array and bad operators are dropped (both list and search)", () => {
    for (const id of ["inventory.list", "inventory.search"]) {
      const desc = findAction(id)?.bodyParams?.tags?.description ?? "";
      expect(desc.toLowerCase(), `${id} tags value shape`).toContain("array");
    }
  });

  it("anomalies.list sortBy is a bounded enum, not a free-form string (backend concatenates it into ORDER BY)", () => {
    // sortBy flows verbatim into ORDER BY server-side; the catalog must not let the
    // model request an arbitrary (injectable) column. Every enum value must be a
    // known-safe column.
    const p = findAction("anomalies.list")?.queryParams?.sortBy;
    expect(Array.isArray(p?.enum), "sortBy must declare an enum").toBe(true);
    expect(p?.enum?.length ?? 0).toBeGreaterThan(0);
    const safeColumns = new Set([
      "anomaly_date",
      "detected_at",
      "cost_impact",
      "deviation_percentage",
      "z_score",
      "expected_cost",
      "actual_cost",
    ]);
    for (const v of p?.enum ?? []) {
      expect(safeColumns.has(v), `sortBy enum value "${v}" must be a known-safe column`).toBe(true);
    }
  });
});

describe("inventory catalog", () => {
  it("exposes read-only inventory list/search/get actions", () => {
    for (const id of ["inventory.list", "inventory.search", "inventory.get"]) {
      const a = findAction(id);
      expect(a, id).toBeDefined();
      expect(isBlockedAction(a!).blocked, `${id} must not be blocked`).toBe(false);
    }
  });

  it("does not block inventory.accounts despite the /accounts denylist", () => {
    // /v1/inventory/accounts must NOT match the anchored ^/v\d+/accounts pattern.
    const a = findAction("inventory.accounts");
    expect(a).toBeDefined();
    expect(isBlockedAction(a!).blocked).toBe(false);
  });

  it("inventory.list declares the filter body params its backend accepts", () => {
    const a = findAction("inventory.list");
    for (const p of ["cloud_provider", "resource_type", "region", "account_id", "state", "tags", "limit", "offset"]) {
      expect(a?.bodyParams?.[p], `bodyParams.${p}`).toBeDefined();
    }
  });

  it("inventory.search requires a query and is findable by category", () => {
    expect(findAction("inventory.search")?.bodyParams?.query?.required).toBe(true);
    const results = searchActions("resource", "inventory");
    expect(results.length).toBeGreaterThan(0);
    for (const a of results) expect(a.category).toBe("inventory");
  });

  it("exposes inventory.resource_costs with a required resource_ids body param", () => {
    const a = findAction("inventory.resource_costs");
    expect(a).toBeDefined();
    expect(isBlockedAction(a!).blocked, "resource_costs must not be blocked").toBe(false);
    expect(a?.bodyParams?.resource_ids?.required).toBe(true);
  });

  it("exposes inventory.history requiring cloud_provider, resource_id, and account_id", () => {
    const a = findAction("inventory.history");
    expect(a).toBeDefined();
    expect(isBlockedAction(a!).blocked, "history must not be blocked").toBe(false);
    for (const p of ["cloud_provider", "resource_id", "account_id"]) {
      expect(a?.bodyParams?.[p]?.required, `${p} must be required`).toBe(true);
    }
  });
});

describe("budgets catalog", () => {
  it("exposes read-only budget list/summary/get actions", () => {
    for (const id of ["budgets.list", "budgets.summary", "budgets.get"]) {
      const a = findAction(id);
      expect(a, id).toBeDefined();
      expect(isBlockedAction(a!).blocked, `${id} must not be blocked`).toBe(false);
    }
  });

  it("budgets.resources requires startDate and endDate (backend 400s without them)", () => {
    const a = findAction("budgets.resources");
    expect(a).toBeDefined();
    expect(a?.queryParams?.startDate?.required).toBe(true);
    expect(a?.queryParams?.endDate?.required).toBe(true);
    expect(a?.queryParams?.page).toBeDefined();
    expect(a?.queryParams?.size).toBeDefined();
  });

  it("budget history actions declare their optional date-range params", () => {
    for (const id of ["budgets.history", "budgets.alert_history"]) {
      const a = findAction(id);
      expect(a, id).toBeDefined();
      expect(a?.queryParams?.startDate, `${id} startDate`).toBeDefined();
      expect(a?.queryParams?.endDate, `${id} endDate`).toBeDefined();
    }
    expect(findAction("budgets.config_history")).toBeDefined();
  });

  it("does not expose budget create/update/delete", () => {
    // POST /v1/budgets creates a budget; PUT/DELETE /v1/budgets/:id mutate one.
    // Every cataloged budget action must be a GET.
    const budgetActions = CATALOG.filter((a) => a.path.startsWith("/v1/budgets"));
    expect(budgetActions.length).toBeGreaterThan(0);
    for (const a of budgetActions) {
      expect(a.method, `${a.id} must be GET`).toBe("GET");
    }
  });

  it("budget actions are findable via search with the budgets category", () => {
    const results = searchActions("budget", "budgets");
    expect(results.length).toBeGreaterThan(0);
    for (const a of results) expect(a.category).toBe("budgets");
  });
});

describe("handlers ↔ catalog contract", () => {
  it("search tool category enum covers every catalog category", async () => {
    const { TOOLS } = await import("./handlers.js");
    const search = TOOLS.find((t) => t.name === "search_actions");
    const schema = search?.inputSchema as {
      properties?: { category?: { enum?: string[] } };
    };
    const enumVals = schema?.properties?.category?.enum ?? [];
    for (const c of new Set(CATALOG.map((a) => a.category))) {
      expect(enumVals, `search_actions category enum must include "${c}"`).toContain(c);
    }
  });
});

describe("searchActions", () => {
  it("finds actions by id terms", () => {
    const results = searchActions("top savings recommendations");
    expect(results.map((a) => a.id)).toContain("recommendations.top_savings");
  });

  it("respects the category filter", () => {
    const results = searchActions("summary", "anomalies");
    expect(results.length).toBeGreaterThan(0);
    for (const a of results) expect(a.category).toBe("anomalies");
  });

  it("matches the singular 'anomaly' to the plural 'anomalies' actions", () => {
    // The action ids/summaries use the plural 'anomalies'; a user's singular
    // 'anomaly' must still find them (substring matching alone misses this).
    const ids = searchActions("anomaly").map((a) => a.id);
    expect(ids).toContain("anomalies.list");
    expect(ids).toContain("anomalies.summary");
  });

  it("surfaces anomaly actions for the phrase 'cost anomaly' (not only cost actions)", () => {
    const ids = searchActions("cost anomaly").map((a) => a.id);
    expect(ids.some((id) => id.startsWith("anomalies."))).toBe(true);
  });

  it("matches singular query terms to plural budget/recommendation ids", () => {
    expect(searchActions("budget").map((a) => a.id)).toContain("budgets.list");
    expect(searchActions("recommendation").map((a) => a.id)).toContain("recommendations.list");
  });

  it("still finds an action by its exact (plural, dotted) id", () => {
    // Normalization must be symmetric: a punctuated query token like 'budgets.list'
    // must match the id even though the internal 'budgets' run gets singularized.
    expect(searchActions("budgets.list").map((a) => a.id)).toContain("budgets.list");
    expect(searchActions("recommendations.summary").map((a) => a.id)).toContain("recommendations.summary");
    expect(searchActions("anomalies.list").map((a) => a.id)).toContain("anomalies.list");
  });
});
