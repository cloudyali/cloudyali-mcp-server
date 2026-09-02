// Anomaly, inventory and orientation tools.

import {
  ToolDef,
  arrOf,
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

const TAG_FILTER_HINT =
  'Tag filters as [{ key, operator, value: [...] }]. `value` must be an array of strings. Valid operators: equal, not_equal, exists, not_exists, empty, not_empty — any other spelling (including "equals") is silently ignored and returns UNFILTERED results.';

const tags = arrOf({ type: "object" }, TAG_FILTER_HINT);

export const ANOMALY_TOOLS: ToolDef[] = [
  {
    name: "list_anomalies",
    title: "Detected cost anomalies",
    description:
      "Cost anomalies with expected vs actual cost, impact and deviation. Defaults to the last 90 days. Use get_anomaly_summary for counts and totals rather than the list.",
    openWorld: true,
    inputSchema: obj({
      startDate: isoDate("Window start"),
      endDate: isoDate("Window end"),
      status: str("Anomaly status filter."),
      cloudProvider: enumStr("Cloud provider filter.", PROVIDERS),
      accountId: str("Cloud account / subscription / project ID filter."),
      serviceName: str("Service name filter, e.g. AmazonEC2."),
      minCostImpact: num("Minimum cost impact in dollars."),
      maxCostImpact: num("Maximum cost impact in dollars."),
      sortBy: enumStr("Sort field.", [
        "anomaly_date",
        "detected_at",
        "cost_impact",
        "deviation_percentage",
        "z_score",
        "expected_cost",
        "actual_cost",
      ]),
      sortOrder: enumStr("Sort direction.", ["asc", "desc"]),
      page: int("Page number, 1-based.", { minimum: 1 }),
      size: int("Page size. Default 50, max 200.", { minimum: 1, maximum: 200 }),
    }),
    call: (a) => ({ action: "anomalies.list", query_params: a }),
    present: (body, args) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const rows = rowsOf(body, "anomalies");
      const total = (o.pagination as Record<string, unknown> | undefined)?.total;
      return {
        structured: o,
        text:
          listSummary("anomalies", rows, {
            total,
            emptyHint:
              "Widen the date range or lower minCostImpact. A quiet period is a normal result here — it does not mean the filter is wrong.",
          }) + truncationNote(rows, total, args.size ?? 50),
      };
    },
  },

  {
    name: "get_anomaly",
    title: "One anomaly",
    description:
      "Detail for a single anomaly: provider, service, account, expected vs actual cost, impact, deviation and z-score. The root-cause-analysis blob is not surfaced through the MCP.",
    openWorld: true,
    inputSchema: obj({ id: str("Anomaly UUID, from list_anomalies.", { minLength: 8 }) }, ["id"]),
    call: (a) => ({ action: "anomalies.get", path_params: { id: a.id } }),
    present: (body) => ({ structured: (body ?? {}) as Record<string, unknown>, text: "Anomaly detail returned." }),
  },

  {
    name: "get_anomaly_summary",
    title: "Anomaly counts and impact totals",
    description: "Dashboard rollup of anomalies for a window. Defaults to the last 90 days.",
    openWorld: true,
    inputSchema: obj({ startDate: isoDate("Window start"), endDate: isoDate("Window end") }),
    call: (a) => ({ action: "anomalies.summary", query_params: a }),
    present: (body) => ({ structured: (body ?? {}) as Record<string, unknown>, text: "Anomaly summary returned." }),
  },

  {
    name: "get_anomaly_alert_settings",
    title: "Anomaly alert configuration",
    description:
      "Which channels anomaly alerts go to and at what threshold. Channel types and thresholds only — recipient addresses and webhook URLs are never returned, because those are credentials. Read-only; change alerting in the console.",
    openWorld: true,
    inputSchema: obj({}),
    call: () => ({ action: "anomalies.preferences_get" }),
    present: (body) => ({
      structured: (body ?? {}) as Record<string, unknown>,
      text: "Alert settings returned. Recipients and webhook URLs are withheld by design.",
    }),
  },
];

/**
 * `created_at` is a true creation time only where the record says so. For Azure, GCP and unmapped
 * AWS types it is CloudYali's first-seen time — when the resource was discovered, not when it was
 * made. A model that reports it as a creation date states a fabricated fact with full confidence,
 * and the flag that would have stopped it sits unread in structured output.
 *
 * This used to live in a glossary resource. Nothing referenced it, so nothing fetched it, so it
 * never arrived — a caveat you have to look up before you know you need it is a caveat that does
 * not work. Here it rides along with the rows it applies to, and stays silent when they are exact.
 */
function ageCaveat(rows: unknown): string {
  const list = Array.isArray(rows) ? rows : [];
  const inexact = list.filter(
    (r) => (r as Record<string, unknown>)?.created_at_is_accurate === false,
  ).length;
  if (inexact === 0) return "";
  const which = inexact === list.length ? "These" : `${inexact} of these`;
  return ` ${which} carry a first-seen time in created_at, not a real creation time — do not report it as when the resource was created.`;
}

export const INVENTORY_TOOLS: ToolDef[] = [
  {
    name: "list_resources",
    title: "Cloud resources by filter",
    description:
      "Cloud resources across providers, filtered by provider, type, region, account, state or tag. Use search_resources when you have a name or ID fragment rather than exact filters.",
    openWorld: true,
    inputSchema: obj({
      cloud_provider: arrOf(enumStr("Cloud provider", PROVIDERS), "Filter by cloud provider."),
      resource_type: arrOf(str("Resource type, e.g. AWS::EC2::Instance."), "Filter by resource type. Discover valid values with list_inventory_facets."),
      region: arrOf(str("Region code, e.g. us-east-1."), "Filter by region."),
      account_id: arrOf(str("Account / subscription / project ID."), "Filter by account."),
      state: enumStr("Resource state. Default 'all', which includes deleted resources.", ["active", "deleted", "all"]),
      start_time: rfc3339("Include resources active at or after this time"),
      end_time: rfc3339("Include resources active at or before this time"),
      tags,
      limit: int("Results per page. Default 50, max 1000.", { minimum: 1, maximum: 1000 }),
      offset: int("Row offset, for paging.", { minimum: 0 }),
    }),
    call: (a) => ({ action: "inventory.list", body: a }),
    present: (body, args) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const rows = rowsOf(body, "resources");
      return {
        structured: o,
        text:
          listSummary("resources", rows, {
            total: o.total,
            emptyHint:
              "Check the resource_type and region spellings with list_inventory_facets, or set state to 'all'. Note that tag operators outside the documented set are ignored rather than rejected.",
          }) + truncationNote(rows, o.total, args.limit ?? 50) + ageCaveat(rows),
      };
    },
  },

  {
    name: "search_resources",
    title: "Free-text resource search",
    description:
      "Search resource IDs, names, properties and tags by text fragment. Use list_resources when you can express the query as exact filters — this is for when you only have a partial name or ID.",
    openWorld: true,
    inputSchema: obj(
      {
        query: str("Search text. At least 3 characters.", { minLength: 3 }),
        cloud_provider: arrOf(enumStr("Cloud provider", PROVIDERS), "Filter by cloud provider."),
        resource_type: arrOf(str("Resource type."), "Filter by resource type."),
        region: arrOf(str("Region code."), "Filter by region."),
        account_id: arrOf(str("Account ID."), "Filter by account."),
        state: enumStr("Resource state. Default 'all' includes deleted resources.", ["active", "deleted", "all"]),
        tags,
        limit: int("Results per page. Default 50, max 200.", { minimum: 1, maximum: 200 }),
        offset: int("Row offset.", { minimum: 0 }),
      },
      ["query"],
    ),
    call: (a) => ({ action: "inventory.search", body: a }),
    present: (body, args) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const rows = rowsOf(body, "resources");
      return {
        structured: o,
        text:
          listSummary("resources", rows, {
            total: o.total,
            emptyHint: "Try a shorter fragment, or drop the provider and type filters — search matches IDs, names, properties and tags.",
          }) + truncationNote(rows, o.total, args.limit ?? 50) + ageCaveat(rows),
      };
    },
  },

  {
    name: "get_resource",
    title: "One resource by cloud-native ID",
    description:
      "Full detail for one resource. Only works for IDs without a slash — EC2 instance IDs, volume IDs, bucket names. GCP asset names and Azure resource IDs contain slashes and cannot be fetched here; use search_resources for those.",
    openWorld: true,
    inputSchema: obj(
      {
        id: str("Slash-free cloud-native resource ID, e.g. i-1234567890abcdef0.", { minLength: 1 }),
        provider: enumStr("Optional provider hint, to disambiguate an ID that could exist in more than one cloud.", PROVIDERS),
      },
      ["id"],
    ),
    call: (a) => ({
      action: "inventory.get",
      path_params: { id: a.id },
      query_params: a.provider ? { provider: a.provider } : undefined,
    }),
    present: (body) => {
      const o = (body ?? {}) as Record<string, unknown>;
      return { structured: o, text: "Resource detail returned." + ageCaveat([o]) };
    },
  },

  {
    name: "get_resource_costs",
    title: "Cost attributed to specific resources",
    description:
      "Total and daily cost for named resources over a window, with a match confidence for each. Get the resource IDs from list_resources or search_resources first.",
    openWorld: true,
    inputSchema: obj(
      {
        resource_ids: arrOf(str("Cloud-native resource ID."), "Resources to price. Keep this list short — one call per handful, not per resource."),
        start_time: rfc3339("Start of the cost window"),
        end_time: rfc3339("End of the cost window"),
      },
      ["resource_ids"],
    ),
    call: (a) => ({ action: "inventory.resource_costs", body: a }),
    present: (body) => {
      const rows = rowsOf(body, "resources") as Record<string, unknown>[];
      const withData = rows.filter((r) => r?.has_cost_data === true).length;
      if (rows.length === 0) return { structured: (body ?? {}) as Record<string, unknown>, text: "No cost data returned for those resource IDs." };

      // match_confidence is the API telling us how the resource was joined to a
      // billing row, and it is not a formality. "high" means the billing record
      // carried the resource's own identifier. "medium" means GCP fell back to
      // matching on the short resource name — two resources with the same name
      // in different projects are indistinguishable. "low" means the cost was
      // attributed from GKE/Dataproc/Dataflow labels on the *underlying* Compute
      // Engine resources, which is an inference, not a billed line item.
      //
      // The number reads identically in all three cases. Left in structured
      // output alone it goes unread, and a labelled guess gets reported as a
      // charge — so the weakest match in the batch is named in the prose.
      const soft = rows.filter((r) => r.match_confidence === "medium" || r.match_confidence === "low");
      const lowest = soft.some((r) => r.match_confidence === "low") ? "low" : "medium";
      const caveat =
        soft.length === 0
          ? ""
          : ` ${soft.length} of them matched at ${lowest} confidence (match_method on each row says how): ` +
            (lowest === "low"
              ? `costs were attributed from labels on underlying Compute Engine resources rather than billed against the resource itself. Treat those as estimates and say so.`
              : `the join was made on resource name rather than the billing identifier, so a same-named resource in another project could be included. Say the figure is approximate.`);

      return {
        structured: (body ?? {}) as Record<string, unknown>,
        text:
          `Priced ${rows.length} resource(s); ${withData} had attributable cost. A resource with no cost data is normal — not every resource type is billed individually.` +
          caveat +
          ` These come from the API's per-resource costing, which is a different source from the one query_costs and get_cost_breakdown read: a total summed here will not necessarily match a total built there, and the two should not be reconciled.`,
      };
    },
  },

  {
    name: "get_resource_history",
    title: "Configuration change history for a resource",
    description:
      "Version history and field-level diffs for one resource's configuration and tags. Not available for Anthropic or Fastly resources — the response's supports_history flag says so.",
    openWorld: true,
    inputSchema: obj(
      {
        cloud_provider: enumStr("Cloud provider of the resource.", PROVIDERS),
        resource_id: str("Cloud-native resource ID."),
        account_id: str("Account / subscription / project ID that owns the resource."),
        resource_type: str("Resource type. Optional; narrows the lookup."),
        region: str("Region code. Optional; narrows the lookup."),
        limit: int("Maximum versions. Default 10, max 100.", { minimum: 1, maximum: 100 }),
        offset: int("Version offset.", { minimum: 0 }),
      },
      ["cloud_provider", "resource_id", "account_id"],
    ),
    call: (a) => ({ action: "inventory.history", body: a }),
    present: (body) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const rows = rowsOf(body, "versions");
      if (o.supports_history === false) {
        return { structured: o, text: "This provider does not record configuration history for that resource type." };
      }
      return {
        structured: o,
        text: listSummary("versions", rows, {
          emptyHint: "Check the account_id and resource_id match, and that the provider records history.",
        }),
      };
    },
  },

  {
    name: "get_inventory_stats",
    title: "Resource counts by provider and type",
    description: "Active, deleted and total resource counts grouped by cloud provider and resource type.",
    openWorld: true,
    inputSchema: obj({ provider: enumStr("Optional cloud-provider filter.", PROVIDERS) }),
    call: (a) => ({ action: "inventory.stats", query_params: a }),
    present: (body) => ({ structured: (body ?? {}) as Record<string, unknown>, text: "Inventory statistics returned." }),
  },

  {
    name: "list_inventory_facets",
    title: "Discover valid inventory filter values",
    description:
      "The providers, resource types, regions, accounts or tag keys present in the inventory. Call this before filtering list_resources — a misspelled resource type returns an empty result that looks like a real answer. For the values of one tag key, use list_tag_values.",
    openWorld: true,
    inputSchema: obj(
      {
        facet: enumStr("Which vocabulary to return.", ["providers", "resource_types", "regions", "accounts", "tag_keys"]),
        provider: enumStr("Optional provider filter. Applies to tag_keys only.", PROVIDERS),
        limit: int("Maximum values, for tag_keys. Default 100, max 1000.", { minimum: 1, maximum: 1000 }),
      },
      ["facet"],
    ),
    call: (a) => {
      const facet = String(a.facet);
      const action = {
        providers: "inventory.providers",
        resource_types: "inventory.types",
        regions: "inventory.regions",
        accounts: "inventory.accounts",
        tag_keys: "inventory.tag_keys",
      }[facet];
      return {
        action: action ?? "inventory.providers",
        query_params: facet === "tag_keys" ? { limit: a.limit } : undefined,
      };
    },
    present: (body, args) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const rows = rowsOf(body, "providers", "types", "regions", "accounts", "keys", "tags");
      return {
        structured: o,
        text: listSummary(`${args.facet} values`, rows, {
          emptyHint: "Nothing is recorded for that facet yet — inventory may not have synced.",
        }),
      };
    },
  },

  {
    name: "list_tag_values",
    title: "Values seen for one tag key",
    description:
      "Distinct values observed for a single tag key. Use list_inventory_facets with facet 'tag_keys' to find the key names first.",
    openWorld: true,
    inputSchema: obj(
      {
        key: str("Tag key name.", { minLength: 1 }),
        provider: enumStr("Optional cloud-provider filter.", PROVIDERS),
        limit: int("Maximum values. Default 100, max 1000.", { minimum: 1, maximum: 1000 }),
      },
      ["key"],
    ),
    call: (a) => ({
      action: "inventory.tag_values",
      path_params: { key: a.key },
      query_params: { provider: a.provider, limit: a.limit },
    }),
    present: (body, args) => {
      const o = (body ?? {}) as Record<string, unknown>;
      const rows = rowsOf(body, "values");
      return {
        structured: o,
        text: listSummary(`values for tag "${args.key}"`, rows, {
          emptyHint: "Check the key spelling with list_inventory_facets — tag keys are case-sensitive.",
        }),
      };
    },
  },
];
