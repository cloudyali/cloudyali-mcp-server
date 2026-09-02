// Per-action response policy: what each catalog action is allowed to return.
//
// Two policies exist, and the split is evidence-based rather than arbitrary:
//
//   allowlist  We read the backing Go DTO field by field and know the complete
//              set. Every one of these carries at least one Tier-1 or Tier-2
//              leak (tenant key, PII, or alert-channel credentials), so an
//              exhaustive allowlist is both possible and necessary.
//
//   redact     The response is wide and nested and we have not enumerated it
//              against a live account. The audit found no tenant key, primary
//              key or PII in these, so a targeted deep key removal closes the
//              real risk without stripping cost data the product depends on.
//              Tracked debt — see the note in project.ts and the test in
//              shapes.test.ts that stops this list growing.
//
// A CI test asserts every catalog action appears here, so a new action cannot
// ship without someone deciding what it may return.

import type { Shape } from "./project.js";

export type ResponsePolicy =
  | { kind: "allowlist"; shape: Shape }
  | { kind: "redact"; reason: string };

// --- shared fragments -------------------------------------------------------

// A resource as the model should see it. Dropped from UnifiedResourceResponse:
// customer_id (the reported leak), properties (raw provider describe payload,
// and the largest volume of untrusted third-party text in the product), score
// (always null).
//
// Deliberate departure from the audit's classification: created_at_is_accurate
// and deleted_at_is_accurate are KEPT. They were filed as internal plumbing, but
// for Azure, GCP and unmapped AWS types the timestamps beside them are CloudYali
// first-seen values rather than real creation times. Dropping the flags would
// leave the model stating an ingest artefact as fact. The flags are not
// sensitive; the timestamps without them are misleading.
const RESOURCE: Shape = {
  cloud_provider: "value",
  account_id: "value",
  account_name: "value",
  resource_id: "value",
  resource_name: "value",
  arn: "value",
  resource_type: "value",
  resource_type_display: "value",
  region: "value",
  region_display: "value",
  tags: "map",
  console_url: "value",
  created_at: "value",
  deleted_at: "value",
  modified_at: "value",
  created_at_is_accurate: "value",
  deleted_at_is_accurate: "value",
};

const PAGINATION: Shape = {
  page: "value",
  size: "value",
  total: "value",
  totalPages: "value",
  total_pages: "value",
  hasNext: "value",
  has_next: "value",
};

// Dropped from OpportunityRow: customer_id, the sequential id, engine_version,
// rule_id, assigned_to_user_id, and the created_at/updated_at row-bookkeeping
// columns (first_detected_at / last_detected_at are the meaningful ones).
const OPPORTUNITY: Shape = {
  provider: "value",
  recommendation_type: "value",
  target_resource_uid: "value",
  target_resource_type: "value",
  target_resource_name: "value",
  target_region: "value",
  parent_resource_uid: "value",
  parent_resource_type: "value",
  state: "value",
  flagged: "value",
  occurrence: "value",
  account_id: "value",
  billing_account_id: "value",
  category: "value",
  risk: "value",
  effort: "value",
  source_name: "value",
  source_origin: "value",
  provider_native_id: "value",
  title: "value",
  description: "value",
  native_amount: "value",
  native_currency: "value",
  usd_amount: "value",
  fx_rate: "value",
  fx_date: "value",
  bucket: "value",
  first_detected_at: "value",
  occurrence_started_at: "value",
  last_detected_at: "value",
  assigned_at: "value",
  actions: "value",
};

// Dropped from AnomalyDTO: customerId, createdAt/updatedAt (detectedAt and
// anomalyDate are the meaningful timestamps), rootCauseAnalysis (an untyped
// blob). `id` is kept: it is a UUID, not a sequential key.
const ANOMALY: Shape = {
  id: "value",
  detectedAt: "value",
  accountId: "value",
  cloudProvider: "value",
  serviceName: "value",
  anomalyDate: "value",
  expectedCost: "value",
  actualCost: "value",
  costImpact: "value",
  deviationPercentage: "value",
  zScore: "value",
  status: "value",
};

// Dropped from budgetsrepo.Budget: customerId, the sequential id, filters[].id,
// filters[].budgetId, alerts[].id, alerts[].budgetId, alerts[].email (PII) and
// alerts[].lastNotificationDate (CloudYali's own notification bookkeeping).
//
// Note the consequence: with `id` gone the model cannot address a budget by key.
// That is correct for now — budgets.get takes an id the user supplies — and it
// is the gap the opaque-ID codec (G6) closes properly.
const BUDGET: Shape = {
  name: "value",
  amount: "value",
  period: "value",
  startDate: "value",
  status: "value",
  currentSpent: "value",
  filters: [{ filterType: "value", filterValues: "value" }],
  alerts: [{ thresholdType: "value", thresholdValue: "value" }],
};

export const RESPONSE_POLICY: Readonly<Record<string, ResponsePolicy>> = {
  // ---- cost -------------------------------------------------------------
  // Audited as carrying no tenant key, no primary key and no PII; the nested
  // chart/table structures are wide and unverified, so these redact.
  "cost.report": { kind: "redact", reason: "wide nested chart/table payload; audited clean of tenant keys and PII" },
  "cost.aggregate": { kind: "redact", reason: "dimension rows are open-ended by design (group_by is caller-chosen)" },
  "cost.spend": { kind: "redact", reason: "embeds CostAggregationV2Response rows" },
  "cost.filter_parameters_for_budgets": { kind: "redact", reason: "legacy GET filter listing, shape unverified" },

  // cost.filters IS fully known — and it is the one cost endpoint with a real
  // leak: `users` carries Databricks run_as_user values, i.e. engineer emails,
  // which are also selectable as a group-by dimension.
  "cost.filters": {
    kind: "allowlist",
    shape: {
      accounts: "value",
      account_names: "value",
      regions: "value",
      services: "value",
      tags: "value",
      cloud_providers: "value",
      cost_type: "value",
      resource_types: "value",
      resource_names: "value",
      resource_arns: "value",
      usage_types: "value",
      compute_types: "value",
    },
  },

  // ---- budgets ----------------------------------------------------------
  "budgets.list": { kind: "allowlist", shape: [BUDGET] },
  "budgets.get": { kind: "allowlist", shape: BUDGET },
  "budgets.summary": {
    kind: "allowlist",
    shape: {
      totalBudgets: "value",
      healthyBudgets: "value",
      warningBudgets: "value",
      criticalBudgets: "value",
      alertsBudgets: "value",
    },
  },
  "budgets.resources": {
    kind: "allowlist",
    shape: {
      budgetName: "value",
      periodStart: "value",
      periodEnd: "value",
      totalCost: "value",
      count: "value",
      pagination: PAGINATION,
      resources: [
        {
          resourceUid: "value",
          resourceName: "value",
          resourceType: "value",
          resourceTypeDisplay: "value",
          region: "value",
          regionDisplay: "value",
          cloudProvider: "value",
          accountId: "value",
          cost: "value",
          tags: "map",
        },
      ],
    },
  },
  "budgets.history": {
    kind: "allowlist",
    shape: [{ date: "value", amountSpent: "value", budgetAmount: "value", percentageUsed: "value" }],
  },
  "budgets.config_history": {
    kind: "allowlist",
    shape: [{ changeType: "value", fieldName: "value", oldValue: "value", newValue: "value" }],
  },
  "budgets.alert_history": {
    kind: "allowlist",
    shape: [
      {
        thresholdType: "value",
        thresholdValue: "value",
        currentSpend: "value",
        budgetAmount: "value",
        spendPercentage: "value",
        triggeredAt: "value",
      },
    ],
  },

  // ---- savings (catalog ids remain recommendations.* ) ------------------
  "recommendations.list": {
    kind: "allowlist",
    shape: { opportunities: [OPPORTUNITY], rows: [OPPORTUNITY], total: "value", count: "value", pagination: PAGINATION },
  },
  "recommendations.get": { kind: "allowlist", shape: OPPORTUNITY },
  "recommendations.summary": { kind: "redact", reason: "funnel counts and breakdowns; audited clean, keys are caller-chosen categories" },

  // ---- anomalies --------------------------------------------------------
  "anomalies.list": { kind: "allowlist", shape: { anomalies: [ANOMALY], pagination: PAGINATION } },
  "anomalies.get": { kind: "allowlist", shape: ANOMALY },
  "anomalies.summary": { kind: "redact", reason: "aggregate counts and impact totals; audited clean" },
  // The highest-severity item in the audit: channelConfig is an untyped JSONB
  // blob whose schema permits Slack and webhook URLs, i.e. bearer credentials.
  // Only the channel type survives.
  "anomalies.preferences_get": {
    kind: "allowlist",
    shape: { accountId: "value", channel: "value", thresholdAmount: "value", enabled: "value" },
  },

  // ---- inventory --------------------------------------------------------
  "inventory.list": {
    kind: "allowlist",
    shape: { resources: [RESOURCE], total: "value", limit: "value", offset: "value" },
  },
  "inventory.search": {
    kind: "allowlist",
    shape: { resources: [RESOURCE], total: "value", limit: "value", offset: "value" },
  },
  "inventory.get": { kind: "allowlist", shape: RESOURCE },
  "inventory.stats": { kind: "redact", reason: "counts keyed by provider and resource type; keys are data, not a fixed schema" },
  "inventory.tag_keys": { kind: "allowlist", shape: { keys: "value", tags: "value", total: "value", limit: "value" } },
  // --- Cost views -----------------------------------------------------------
  // query_spec is dropped: it is an internal query DSL as a raw JSON blob, and a
  // model runs a view by id rather than by reading its compiled definition.
  // created_at/updated_at are audit columns nobody reads.
  // The handler wraps the list: writeJSON(w, 200, map[string]any{"views": views}).
  // The single-view GET returns a bare View, which is where the array shape below
  // came from — I read the struct and assumed the list endpoint returned []View.
  // It does not, and an array shape against an object body projects to undefined,
  // so the tool reported "no saved cost views" for an account that has several.
  "views.list": {
    kind: "allowlist",
    shape: {
      views: [{ id: "value", name: "value", description: "value", collection_tags: "value", default_chart_type: "value", builtin: "value" }],
    },
  },
  "views.run": {
    kind: "allowlist",
    shape: {
      view_id: "value",
      range: { days: "value", granularity: "value", start: "value", end: "value" },
      cost_type: "value",
      // {kind, field} — which dimension the group keys are. Needed to say what the
      // groups mean; the keys themselves live in totals/series.
      group_by: { kind: "value", field: "value" },
      series: [{ day: "value", groups: "map" }],
      totals: "map",
      view_total: "value",
      share_of_total: "value",
      // The latest billing day actually present for this account in the window, or
      // null when there is none. Partial ingestion shows up here as an earlier
      // watermark rather than as an error, so this is the only field that can tell
      // a reader the total is incomplete.
      data_freshness: "value",
    },
  },
  "views.detail": {
    kind: "allowlist",
    shape: {
      view_id: "value",
      range: { days: "value", granularity: "value", start: "value", end: "value" },
      cost_type: "value",
      // resource_id is null for resourceless line items and AI providers — a real
      // value, not a gap. Passed through rather than dropped.
      rows: [{ day: "value", group: "value", resource_id: "value", cost: "value" }],
      pagination: { limit: "value", offset: "value", count: "value" },
    },
  },
  // --- Tag governance -------------------------------------------------------
  "tags.coverage": {
    kind: "allowlist",
    shape: {
      total_cost: "value", tagged_cost: "value", untagged_cost: "value", tagged_percentage: "value",
      unique_tag_keys: "value", standard_tag_keys: "value",
      prior_total_cost: "value", prior_tagged_cost: "value",
      prior_untagged_cost: "value", prior_tagged_percentage: "value",
    },
  },
  "tags.cost_by_tag": {
    kind: "allowlist",
    shape: {
      total: "value",
      data: [{ cloud_provider: "value", tag_key: "value", tag_value: "value", cost: "value", share_percentage: "value" }],
    },
  },
  "tags.health": {
    kind: "allowlist",
    shape: {
      total_affected: "value",
      // `count` is nullable by design: null means the count query failed, 0 means it
      // genuinely counted zero. Both pass through — collapsing them would turn a
      // failure into a clean bill of health.
      mismatched_keys: [{ standard_key: "value", actual_key: "value", count: "value" }],
      affected_resources: [{
        cloud_provider: "value", account: "value", service: "value",
        service_display: "value", standard_key: "value", actual_key: "value", resource_id: "value",
      }],
    },
  },
  // StandardTag carries customer_id — the exact field the screenshot that started
  // this project was showing. It is dropped here, along with the row's primary key
  // and its audit columns: none of them tell a reader anything about the policy.
  "tags.standard": { kind: "allowlist", shape: [{ key: "value", values: "value", status: "value" }] },
  "inventory.tag_values": { kind: "allowlist", shape: { key: "value", values: "value", total: "value", limit: "value" } },
  "inventory.providers": { kind: "allowlist", shape: { providers: "value" } },
  "inventory.types": {
    kind: "allowlist",
    shape: { types: [{ system_name: "value", display_name: "value", cloud_provider: "value" }] },
  },
  "inventory.regions": {
    kind: "allowlist",
    shape: { regions: [{ region: "value", display_name: "value", cloud_provider: "value" }] },
  },
  "inventory.accounts": {
    kind: "allowlist",
    shape: { accounts: [{ account_id: "value", display_name: "value", cloud_provider: "value" }] },
  },
  "inventory.resource_costs": {
    kind: "allowlist",
    shape: {
      resources: [
        {
          resource_id: "value",
          has_cost_data: "value",
          total_cost: "value",
          daily_costs: [{ date: "value", cost: "value" }],
          no_data_message: "value",
          match_confidence: "value",
          match_method: "value",
        },
      ],
      start_time: "value",
      end_time: "value",
    },
  },
  // Dropped from InventoryHistoryVersion: version_id (a raw resource_property.id),
  // changed_by (PII), config_checksum, and the per-version raw properties blob.
  "inventory.history": {
    kind: "allowlist",
    shape: {
      cloud_provider: "value",
      resource_id: "value",
      resource_type: "value",
      account_id: "value",
      account_name: "value",
      region: "value",
      returned_count: "value",
      has_more: "value",
      supports_history: "value",
      versions: [
        {
          version: "value",
          change_time: "value",
          change_type: "value",
          change_client: "value",
          tags: "map",
          diff_from_previous: [{ field: "value", old_value: "value", new_value: "value" }],
        },
      ],
    },
  },
};

/** Actions still on the redaction stopgap. Kept explicit so the list is visible. */
export const REDACTED_ACTIONS: readonly string[] = Object.entries(RESPONSE_POLICY)
  .filter(([, p]) => p.kind === "redact")
  .map(([id]) => id)
  .sort();
