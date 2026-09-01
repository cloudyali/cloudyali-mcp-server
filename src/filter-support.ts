// Which filter dimensions the cost API actually applies, per provider.
//
// The backend builds each provider's WHERE clause from a ColumnMapping, and
// applies a dimension only when that provider defines a column for it:
//
//     if len(filter.UsageTypes) > 0 && columns.UsageTypeColumn != "" { … }
//
// When the column is empty the condition is skipped — with no error, no warning
// and a 200 response. You get provider-wide totals wearing the costume of a
// filtered answer, which is the worst possible failure mode: the number looks
// right, reconciles against nothing, and is only caught if you happen to have an
// independent figure to check it against.
//
// Reported from real use: filtering AWS by usage_types returned every EC2 usage
// type. Azure, whose mapping does define the column, filtered correctly. That
// difference is this table.
//
// The gaps are mostly schema limitations rather than bugs — AWS and GCP filter
// against resource-level matviews that have no usage_type/sku_id column, and
// several providers genuinely have no regions or resource types. The defect is
// that the API stays silent about it. We cannot fix the API from here, but we
// can refuse to pass a silent wrong answer to a model.
//
// Source of truth: awsColumns … openaiColumns in
// pkg/database/combinedcostrepo/v2_cost_filter.go. If a commented-out column is
// ever restored there, delete the matching entry here.

/** Filter keys that are silently dropped, keyed by lowercase provider name. */
export const UNSUPPORTED_FILTERS: Readonly<Record<string, readonly string[]>> = {
  aws: ["usage_types"],
  gcp: ["usage_types", "resource_types"],
  azure: ["resource_types"],
  databricks: ["regions", "resource_types"],
  anthropic: ["regions", "cost_types", "resource_types", "resource_names", "resource_arns"],
  fastly: ["cost_types", "resource_types", "resource_names", "resource_arns"],
  openai: ["regions", "cost_types", "resource_types", "resource_names", "resource_arns"],
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Pull the provider names out of a group's cloud_providers condition. */
function providersOf(group: Record<string, unknown>): string[] {
  const conds = group.cloud_providers;
  if (!Array.isArray(conds)) return [];
  const out: string[] = [];
  for (const c of conds) {
    const rec = asRecord(c);
    const value = rec?.value;
    if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string") out.push(v.toLowerCase());
    } else if (typeof value === "string") {
      out.push(value.toLowerCase());
    }
  }
  return out;
}

export type IgnoredFilter = { provider: string; dimension: string };

/**
 * Find filter dimensions the API will silently drop for the providers named in
 * the same group.
 *
 * Returns an empty array when the filter is fine, so the caller can stay quiet
 * in the common case — a warning printed on every call is a warning nobody
 * reads.
 */
export function findIgnoredFilters(filters: unknown): IgnoredFilter[] {
  if (!Array.isArray(filters)) return [];
  const found = new Map<string, IgnoredFilter>();

  for (const raw of filters) {
    const group = asRecord(raw);
    if (!group) continue;
    for (const provider of providersOf(group)) {
      const unsupported = UNSUPPORTED_FILTERS[provider];
      if (!unsupported) continue;
      for (const dimension of unsupported) {
        const present = group[dimension];
        if (Array.isArray(present) && present.length > 0) {
          found.set(`${provider}:${dimension}`, { provider, dimension });
        }
      }
    }
  }
  return [...found.values()];
}

/**
 * A sentence naming what was dropped, or "" when nothing was.
 *
 * Deliberately blunt about the consequence rather than hedging. "May not be
 * applied" invites the reader to assume it probably was; the point is that the
 * returned rows are provider-wide and the total is therefore too high.
 */
export function ignoredFilterWarning(
  ignored: IgnoredFilter[],
  opts: { allowGroupByAdvice?: boolean } = {},
): string {
  if (ignored.length === 0) return "";
  const parts = ignored.map((i) => `${i.dimension} on ${i.provider.toUpperCase()}`);
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

  // The group_by fallback is only sound while the query is still reading a view
  // that HAS the column. A resource_names filter moves AWS and GCP to a view
  // that does not, and there the grouping silently becomes one "Unknown" bucket
  // — so recommending it would hand the reader a second wrong answer dressed as
  // the fix for the first. costWarningsFor turns this off in that case.
  const remedy =
    opts.allowGroupByAdvice === false
      ? `Narrow client-side from these rows. `
      : `Either narrow client-side from these rows, or add the dimension to group_by and sum the ones you want. `;

  return (
    `WARNING: the CloudYali API does not support filtering by ${list}, and drops those conditions ` +
    `without reporting it. The rows below are UNFILTERED on ${
      ignored.length === 1 ? "that dimension" : "those dimensions"
    }, so any total is too high. ` +
    remedy +
    `Do not present this as a filtered figure.`
  );
}

/** Convenience: warning text for a filters argument, or "" if it is clean. */
export function filterWarningFor(filters: unknown): string {
  return ignoredFilterWarning(findIgnoredFilters(filters));
}

// ---------------------------------------------------------------------------
// The second silent behaviour: a resource_names filter changes the DATASET.
// ---------------------------------------------------------------------------
//
// Adding a resource_names condition does not just narrow the query. For AWS,
// GCP and Azure it re-points the whole aggregation at a different materialized
// view — the per-resource one — because the base view has no resource column to
// filter on:
//
//     if res, ok := ProviderResourcesAggMappings[provider]; ok &&
//        hasResourceNamesFilterForProvider(filters, provider) { return res }
//
// The two views are built from the same source table but are NOT the same
// dataset, and the differences are all invisible in a 200 response:
//
//   1. Different retention. The AWS base view keeps
//      `start_time >= date_trunc('month', CURRENT_DATE - 7 months)`; the
//      resources view keeps `start_time >= CURRENT_DATE - 7 months`. CURRENT_DATE
//      binds at REFRESH time, not query time, and the two are refreshed by
//      separate statements that can fail independently
//      (pkg/database/mv_refresher.go), so the windows drift apart between runs.
//      The same month can be populated in one view and empty in the other.
//
//   2. No usage_type. The AWS and GCP resources views drop usage_type / sku_id
//      entirely, so `group_by_dimensions: ["usage_type"]` degrades to "Unknown"
//      rather than erroring. Azure's resources view keeps meter_subcategory, so
//      Azure is unaffected — which is exactly what a user observed: the Azure
//      usage-type filter worked and the AWS one did not.
//
//   3. Silent provider drop. If the resources view has never been refreshed,
//      selectAggColumns returns skip=true and the provider is omitted from the
//      report — 200, no rows, no error, no mention of the provider
//      (v2_cost_aggr.go: "AWS resources MV not populated; skipping").
//
// So the same question asked two ways returns two different numbers and neither
// answer says which dataset produced it. A model has no way to notice; it will
// report both as fact and, asked to reconcile them, will invent a story about
// billing lag. Naming the switch is the only defence available from here.

/**
 * Providers whose cost aggregation is re-routed to a per-resource dataset when
 * a resource_names condition targets them.
 *
 * `losesUsageType` marks the ones whose per-resource view also drops the
 * usage-type column, which is what breaks the group_by workaround.
 */
export const RESOURCE_DATASET_PROVIDERS: Readonly<Record<string, { losesUsageType: boolean }>> = {
  aws: { losesUsageType: true },
  gcp: { losesUsageType: true },
  azure: { losesUsageType: false },
};

export type DatasetSwitch = { provider: string; losesUsageType: boolean };

/** Providers in this filter whose query will read the per-resource dataset. */
export function findDatasetSwitch(filters: unknown): DatasetSwitch[] {
  if (!Array.isArray(filters)) return [];
  const found = new Map<string, DatasetSwitch>();

  for (const raw of filters) {
    const group = asRecord(raw);
    if (!group) continue;
    // Only resource_names triggers the re-route. resource_arns does not — see
    // hasResourceNamesFilterForProvider, which inspects ResourceNames alone.
    const names = group.resource_names;
    if (!Array.isArray(names) || names.length === 0) continue;
    for (const provider of providersOf(group)) {
      const entry = RESOURCE_DATASET_PROVIDERS[provider];
      if (entry) found.set(provider, { provider, ...entry });
    }
  }
  return [...found.values()];
}

/** Grouping dimensions that resolve to the usage-type column. */
const USAGE_TYPE_DIMENSIONS = new Set(["usage_type", "usage_types"]);

function groupsByUsageType(groupBy: unknown): boolean {
  return Array.isArray(groupBy) && groupBy.some((d) => typeof d === "string" && USAGE_TYPE_DIMENSIONS.has(d.toLowerCase()));
}

/**
 * A sentence naming the dataset switch, or "" when none applies.
 *
 * Phrased as "these numbers came from a different table" rather than "results
 * may vary", because the reader needs to know not to reconcile this figure
 * against an unfiltered one — not merely to feel uncertain about it.
 */
export function datasetSwitchWarning(switched: DatasetSwitch[], groupBy?: unknown): string {
  if (switched.length === 0) return "";
  const names = switched.map((s) => s.provider.toUpperCase());
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  let text =
    `WARNING: filtering by resource_names makes the CloudYali API read a different dataset for ${list} — ` +
    `the per-resource billing view rather than the aggregate one. The two are refreshed separately and keep ` +
    `different retention windows, so totals from this call will not necessarily reconcile with the same query ` +
    `run without a resource_names filter, and a month can have rows in one and none in the other. ` +
    `Report this as a per-resource figure; do not present it as the same measurement as an unfiltered total, ` +
    `and if the two disagree do not explain the gap as billing lag — it is the dataset.`;

  const degraded = switched.filter((s) => s.losesUsageType).map((s) => s.provider.toUpperCase());
  if (degraded.length > 0 && groupsByUsageType(groupBy)) {
    text +=
      ` Also: the per-resource view for ${degraded.join(" and ")} has no usage-type column, so the requested ` +
      `usage_type grouping collapses into a single "Unknown" bucket instead of failing. Those grouped rows carry no usage-type meaning.`;
  }

  text +=
    ` If no rows come back at all, that is not evidence of zero spend: an unrefreshed per-resource view makes the ` +
    `API drop the provider from the report silently.`;
  return text;
}

/**
 * Every warning that applies to one cost call, joined.
 *
 * Composed rather than emitted separately because the two interact: the standard
 * advice for a dropped usage_types filter is "group by it instead", and that
 * advice is wrong precisely when a resource_names filter has moved the query to
 * a view with no usage-type column.
 */
export function costWarningsFor(args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const switched = findDatasetSwitch(a.filters);
  const usageTypeGone = switched.some((s) => s.losesUsageType);
  // query_costs calls the argument group_by_dimensions; the cost-report tool
  // calls it dimensions. Both mean the same thing to the backend.
  const groupBy = a.group_by_dimensions ?? a.dimensions;
  const parts = [
    ignoredFilterWarning(findIgnoredFilters(a.filters), { allowGroupByAdvice: !usageTypeGone }),
    datasetSwitchWarning(switched, groupBy),
  ].filter(Boolean);
  return parts.join("\n\n");
}
