import { describe, expect, it } from "vitest";
import {
  UNSUPPORTED_FILTERS,
  costWarningsFor,
  datasetSwitchWarning,
  filterWarningFor,
  findDatasetSwitch,
  findIgnoredFilters,
} from "./filter-support.js";

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

// ---------------------------------------------------------------------------
// The dataset switch
// ---------------------------------------------------------------------------

describe("a resource_names filter changes which dataset answers", () => {
  const awsGroup = (extra: Record<string, unknown> = {}) => [
    {
      operator: "AND",
      cloud_providers: [{ operator: "equals", value: ["AWS"] }],
      ...extra,
    },
  ];

  it("detects the switch for AWS, GCP and Azure", () => {
    for (const provider of ["AWS", "GCP", "Azure"]) {
      const found = findDatasetSwitch([
        {
          operator: "AND",
          cloud_providers: [{ operator: "equals", value: [provider] }],
          resource_names: [{ operator: "equals", value: ["vol-1"] }],
        },
      ]);
      expect(found.map((f) => f.provider), provider).toEqual([provider.toLowerCase()]);
    }
  });

  it("leaves providers with no per-resource view alone", () => {
    // Databricks and the SaaS providers have one billing table each; there is no
    // second dataset to switch to, so no warning is owed.
    for (const provider of ["Databricks", "Fastly", "OpenAI", "Anthropic"]) {
      const found = findDatasetSwitch([
        {
          operator: "AND",
          cloud_providers: [{ operator: "equals", value: [provider] }],
          resource_names: [{ operator: "equals", value: ["x"] }],
        },
      ]);
      expect(found, provider).toEqual([]);
    }
  });

  it("stays quiet when there is no resource_names condition", () => {
    expect(findDatasetSwitch(awsGroup({ services: [{ operator: "equals", value: ["AmazonEC2"] }] }))).toEqual([]);
    expect(findDatasetSwitch(awsGroup({ resource_names: [] }))).toEqual([]);
  });

  it("does not fire on resource_arns, which the backend does not route on", () => {
    // hasResourceNamesFilterForProvider inspects ResourceNames only. Warning on
    // resource_arns would be a warning about something that did not happen —
    // and a warning that cries wolf is one the model learns to skip past.
    expect(findDatasetSwitch(awsGroup({ resource_arns: [{ operator: "equals", value: ["arn:aws:ec2:::vol/vol-1"] }] }))).toEqual([]);
  });

  it("names the provider and forbids inventing an explanation", () => {
    const text = datasetSwitchWarning(findDatasetSwitch(awsGroup({ resource_names: [{ operator: "equals", value: ["vol-1"] }] })));
    expect(text).toMatch(/AWS/);
    expect(text).toMatch(/NOT comparable/);
    expect(text).toMatch(/would be invented/i);
    // Naming the wrong explanations by name is what stops them being reached for.
    expect(text).toMatch(/billing lag/i);
  });

  it("says what the reader observes and never what is behind the API", () => {
    // The first version of this warning explained the mechanism, using vocabulary
    // that only exists inside the backend. The MCP talks to an HTTP API like any
    // other client: it cannot see that mechanism, so it cannot keep the claim
    // true, and relaying internal shape is the exact thing this server exists to
    // prevent. Behaviour survives; explanation does not.
    const text = datasetSwitchWarning(
      findDatasetSwitch(awsGroup({ resource_names: [{ operator: "equals", value: ["vol-1"] }] })),
      ["usage_type"],
    );
    expect(text).not.toMatch(/materiali[sz]ed|view\b|refresh|retention|table\b|column\b|schema/i);
  });

  it("says an empty result is not evidence of zero spend", () => {
    // The provider-skip path returns 200 with no rows. Without this line the
    // most likely reading of an empty response is "you spent nothing".
    const text = datasetSwitchWarning([{ provider: "aws", losesUsageType: true }]);
    expect(text).toMatch(/not evidence of zero spend|not.*zero spend/i);
  });

  it("warns that usage_type grouping collapses, but only when it is asked for", () => {
    const switched = [{ provider: "aws", losesUsageType: true }];
    expect(datasetSwitchWarning(switched, ["usage_type"])).toMatch(/Unknown/);
    expect(datasetSwitchWarning(switched, ["service"])).not.toMatch(/Unknown/);
    expect(datasetSwitchWarning(switched)).not.toMatch(/Unknown/);
  });

  it("does not claim Azure loses its usage type, because it does not", () => {
    // mv_azure_billing_data_resources keeps meter_subcategory. This asymmetry is
    // exactly what a user observed in the field, and getting it wrong here would
    // make the server contradict the API it is describing.
    const azure = [{ provider: "azure", losesUsageType: false }];
    expect(datasetSwitchWarning(azure, ["usage_type"])).not.toMatch(/Unknown/);
  });
});

describe("costWarningsFor composes the two warnings without contradicting itself", () => {
  const awsResourceFiltered = {
    filters: [
      {
        operator: "AND",
        cloud_providers: [{ operator: "equals", value: ["AWS"] }],
        resource_names: [{ operator: "equals", value: ["vol-1"] }],
        usage_types: [{ operator: "equals", value: ["VolumeUsage.gp3"] }],
      },
    ],
  };

  it("withdraws the group_by remedy when the dataset switch has broken it", () => {
    // The dropped-filter warning normally says "or add the dimension to group_by
    // and sum". Under a resource_names filter that dimension does not exist in
    // the view being read, so the advice would produce a second wrong answer.
    const text = costWarningsFor(awsResourceFiltered);
    expect(text).toMatch(/does not support filtering by usage_types/);
    expect(text).toMatch(/changes which source answers/i);
    expect(text).not.toMatch(/add the dimension to group_by/);
    expect(text).toMatch(/Narrow client-side/);
  });

  it("keeps the group_by remedy when only the filter was dropped", () => {
    const text = costWarningsFor({
      filters: [
        {
          operator: "AND",
          cloud_providers: [{ operator: "equals", value: ["AWS"] }],
          usage_types: [{ operator: "equals", value: ["VolumeUsage.gp3"] }],
        },
      ],
    });
    expect(text).toMatch(/add the dimension to group_by/);
    expect(text).not.toMatch(/changes which source answers/i);
  });

  it("reads the grouping argument under either of its two names", () => {
    const filters = awsResourceFiltered.filters;
    expect(costWarningsFor({ filters, group_by_dimensions: ["usage_type"] })).toMatch(/Unknown/);
    expect(costWarningsFor({ filters, dimensions: ["usage_type"] })).toMatch(/Unknown/);
  });

  it("stays silent on a clean query, and on no arguments at all", () => {
    expect(costWarningsFor({})).toBe("");
    expect(costWarningsFor(undefined)).toBe("");
    expect(
      costWarningsFor({
        filters: [
          {
            operator: "AND",
            cloud_providers: [{ operator: "equals", value: ["AWS"] }],
            services: [{ operator: "equals", value: ["AmazonEC2"] }],
          },
        ],
      }),
    ).toBe("");
  });

  it("survives junk in the filters argument", () => {
    for (const junk of [null, 42, "filters", [null], [{}], [{ cloud_providers: "AWS" }], {}]) {
      expect(() => costWarningsFor({ filters: junk }), JSON.stringify(junk)).not.toThrow();
    }
  });
});
