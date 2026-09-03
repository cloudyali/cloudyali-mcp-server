// Shared types and helpers for the typed tool surface.
//
// Why typed tools replace search_actions + execute_action as the product:
// the search-then-execute pattern kept the catalog out of the context window,
// which was the right trade for a v0. But it makes the model do a lookup before
// it can do work, it cannot carry per-tool input validation, and it has no place
// to hang an outputSchema. Named tools fix all three. The raw pair stays behind
// a flag for the cases a catalog action exists but no tool wraps it yet.
//
// Every tool here is read-only. That is not a convention — `assertReadOnly` in
// index.ts checks it against the catalog at module load and throws if a tool
// ever points at a mutating action.

import type { JSONSchema } from "./json-schema.js";

export type ToolCall = {
  action: string;
  path_params?: Record<string, unknown>;
  query_params?: Record<string, unknown>;
  body?: unknown;
};

export type Presented = {
  /** Machine-readable result, returned as structuredContent. */
  structured: Record<string, unknown>;
  /**
   * Human/model-readable summary. Deliberately built from counts and totals
   * rather than tenant strings: resource names and tags are attacker-controllable
   * text, and keeping them out of the prose block is the cheap half of
   * prompt-injection defence. The full rows live in structuredContent, where
   * JSON escaping makes delimiter breakout impossible.
   */
  text: string;
};

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  /** True when the tool reaches the network. login and the API calls do. */
  openWorld?: boolean;
  /** Map validated arguments onto a catalog action call. */
  call(args: Record<string, unknown>): ToolCall;
  /** Turn the projected response body into structured output plus a summary. */
  present?(body: unknown, args: Record<string, unknown>): Presented;
};

// --- schema helpers ---------------------------------------------------------
// Small builders rather than a schema library: the shapes are simple, and a
// hand-rolled helper keeps `additionalProperties: false` impossible to forget,
// which is the property that actually matters (G5). A model that invents
// `customer_id` as an argument gets a hard rejection, not a silent drop.

export const str = (description: string, extra: Record<string, unknown> = {}): JSONSchema => ({
  type: "string",
  description,
  ...extra,
});

export const int = (description: string, extra: Record<string, unknown> = {}): JSONSchema => ({
  type: "integer",
  description,
  ...extra,
});

export const num = (description: string, extra: Record<string, unknown> = {}): JSONSchema => ({
  type: "number",
  description,
  ...extra,
});

export const bool = (description: string): JSONSchema => ({ type: "boolean", description });

export const enumStr = (description: string, values: readonly string[]): JSONSchema => ({
  type: "string",
  description,
  enum: [...values],
});

export const arrOf = (items: JSONSchema, description: string): JSONSchema => ({
  type: "array",
  description,
  items,
});

/** An object schema that always rejects unknown properties. */
export function obj(
  properties: Record<string, JSONSchema>,
  required: readonly string[] = [],
): JSONSchema {
  return {
    type: "object",
    properties,
    ...(required.length ? { required: [...required] } : {}),
    additionalProperties: false,
  };
}

// --- shared parameter fragments --------------------------------------------

export const PROVIDERS = ["aws", "gcp", "azure", "databricks", "fastly", "anthropic", "openai"] as const;

export const isoDate = (what: string): JSONSchema =>
  str(`${what} as YYYY-MM-DD.`, { pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

export const rfc3339 = (what: string): JSONSchema =>
  str(`${what} as an RFC3339 timestamp, e.g. 2026-08-01T00:00:00Z.`);

// --- presentation helpers ---------------------------------------------------

function asObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export function rowsOf(body: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(body)) return body;
  const o = asObject(body);
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  return [];
}

/**
 * Build the summary line for a list result, including a recovery hint when the
 * result is empty.
 *
 * Zero rows is where models thrash hardest — they tend to retry the same query
 * with one grouping changed, burning calls without learning anything. Naming
 * both the next action and the anti-pattern turns an empty result into a
 * directed step. Borrowed from Vantage's query-costs hint, which is the single
 * best idea in their server.
 */
export function listSummary(
  noun: string,
  rows: unknown[],
  opts: { total?: unknown; emptyHint: string } = { emptyHint: "" },
): string {
  if (rows.length === 0) {
    return `No ${noun} matched. ${opts.emptyHint}`.trim();
  }
  const total = typeof opts.total === "number" ? opts.total : undefined;
  const of = total !== undefined && total > rows.length ? ` of ${total}` : "";
  return `Returned ${rows.length}${of} ${noun}.`;
}

/** Standard closing note when a page is a subset of the whole. */
export function truncationNote(rows: unknown[], total: unknown, limit: unknown): string {
  if (typeof total !== "number" || typeof limit !== "number") return "";
  if (total <= rows.length) return "";
  return ` This is one page; ${total} match in total. Raise limit or page through with offset to see more — do not assume the returned rows are the complete set.`;
}
