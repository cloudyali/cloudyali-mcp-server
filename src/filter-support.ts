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
export function ignoredFilterWarning(ignored: IgnoredFilter[]): string {
  if (ignored.length === 0) return "";
  const parts = ignored.map((i) => `${i.dimension} on ${i.provider.toUpperCase()}`);
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return (
    `WARNING: the CloudYali API does not support filtering by ${list}, and drops those conditions ` +
    `without reporting it. The rows below are UNFILTERED on ${
      ignored.length === 1 ? "that dimension" : "those dimensions"
    }, so any total is too high. ` +
    `Either narrow client-side from these rows, or add the dimension to group_by and sum the ones you want. ` +
    `Do not present this as a filtered figure.`
  );
}

/** Convenience: warning text for a filters argument, or "" if it is clean. */
export function filterWarningFor(filters: unknown): string {
  return ignoredFilterWarning(findIgnoredFilters(filters));
}
