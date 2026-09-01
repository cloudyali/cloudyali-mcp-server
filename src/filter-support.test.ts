import { describe, expect, it } from "vitest";
import { UNSUPPORTED_FILTERS, filterWarningFor, findIgnoredFilters } from "./filter-support.js";

function group(provider: string, extra: Record<string, unknown> = {}) {
  return {
    operator: "AND",
    cloud_providers: [{ operator: "equals", value: [provider] }],
    ...extra,
  };
}

const usageTypes = { usage_types: [{ operator: "equals", value: ["EBS:VolumeUsage.gp3"] }] };

describe("the reported case", () => {
  it("warns that AWS usage_types is dropped", () => {
    // Real report: filtering AWS by usage_types returned every EC2 usage type,
    // and the caller only noticed because they had an independent YTD figure.
    const w = filterWarningFor([group("AWS", usageTypes)]);
    expect(w).toMatch(/usage_types on AWS/);
    expect(w).toMatch(/UNFILTERED/);
    expect(w).toMatch(/too high/);
  });

  it("stays silent for Azure, which applies the same filter correctly", () => {
    expect(filterWarningFor([group("Azure", usageTypes)])).toBe("");
  });

  it("tells the reader what to do instead of only what went wrong", () => {
    const w = filterWarningFor([group("AWS", usageTypes)]);
    expect(w).toMatch(/group_by/);
    expect(w).toMatch(/Do not present this as a filtered figure/);
  });
});

describe("findIgnoredFilters", () => {
  it("is quiet when every dimension is supported", () => {
    expect(findIgnoredFilters([group("AWS", { services: [{ operator: "equals", value: ["AmazonEC2"] }] })])).toEqual([]);
  });

  it("is quiet when an unsupported dimension is present but empty", () => {
    // An empty array is not a filter; warning about it would be noise.
    expect(findIgnoredFilters([group("AWS", { usage_types: [] })])).toEqual([]);
  });

  it("matches provider names case-insensitively", () => {
    for (const name of ["AWS", "aws", "Aws"]) {
      expect(findIgnoredFilters([group(name, usageTypes)]), name).toHaveLength(1);
    }
  });

  it("reports each provider/dimension pair once, across repeated groups", () => {
    const found = findIgnoredFilters([group("AWS", usageTypes), group("AWS", usageTypes)]);
    expect(found).toHaveLength(1);
  });

  it("collects across groups with different providers", () => {
    const found = findIgnoredFilters([
      group("AWS", usageTypes),
      group("GCP", { resource_types: [{ operator: "equals", value: ["x"] }] }),
    ]);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.provider).sort()).toEqual(["aws", "gcp"]);
  });

  it("lists multiple dropped dimensions in one sentence", () => {
    const w = filterWarningFor([
      group("OpenAI", {
        regions: [{ operator: "equals", value: ["us"] }],
        cost_types: [{ operator: "equals", value: ["usage"] }],
      }),
    ]);
    expect(w).toMatch(/ and /);
    expect(w).toMatch(/those dimensions/);
  });

  it("ignores an unknown provider rather than guessing", () => {
    expect(findIgnoredFilters([group("oracle", usageTypes)])).toEqual([]);
  });

  it("survives malformed filters without throwing", () => {
    for (const bad of [undefined, null, "filters", 42, [null], [{}], [{ cloud_providers: "AWS" }]]) {
      expect(() => findIgnoredFilters(bad)).not.toThrow();
      expect(findIgnoredFilters(bad)).toEqual([]);
    }
  });

  it("handles a scalar cloud_providers value as well as an array", () => {
    const g = { cloud_providers: [{ operator: "equals", value: "AWS" }], ...usageTypes };
    expect(findIgnoredFilters([g])).toHaveLength(1);
  });
});

describe("the matrix matches the backend column mappings", () => {
  it("covers every provider the tools accept", () => {
    for (const p of ["aws", "gcp", "azure", "databricks", "fastly", "anthropic", "openai"]) {
      expect(UNSUPPORTED_FILTERS[p], p).toBeDefined();
    }
  });

  it("marks resource_types unsupported everywhere except AWS", () => {
    // Only awsColumns defines ResourceTypeColumn; every other mapping leaves it
    // empty, so this is the widest gap in the table.
    for (const [p, dims] of Object.entries(UNSUPPORTED_FILTERS)) {
      if (p === "aws") expect(dims).not.toContain("resource_types");
      else expect(dims, p).toContain("resource_types");
    }
  });
});
