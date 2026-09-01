// The typed tool surface: registry, argument validation, and dispatch.
//
// Every tool routes through executeActionRaw, so auth, throttling, retry and
// the response projection all still apply. There is deliberately no path to the
// API that skips them.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { executeActionRaw } from "../execute.js";
import { findAction, isBlockedAction } from "../catalog.js";
import type { JSONSchema } from "./json-schema.js";
import type { ToolDef } from "./types.js";
import { BUDGET_TOOLS, COST_TOOLS, SAVINGS_TOOLS } from "./defs-cost.js";
import { ANOMALY_TOOLS, INVENTORY_TOOLS } from "./defs-ops.js";

export const TOOL_DEFS: ToolDef[] = [
  ...COST_TOOLS,
  ...SAVINGS_TOOLS,
  ...BUDGET_TOOLS,
  ...ANOMALY_TOOLS,
  ...INVENTORY_TOOLS,
];

export const TOOL_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(TOOL_DEFS.map((t) => [t.name, t]));

// --- load-time invariants ---------------------------------------------------
// These run on import rather than in a test, so a violation cannot ship even if
// someone skips the suite. A server that would expose a write should refuse to
// start, not start and expose it.

function assertInvariants(): void {
  const seen = new Set<string>();
  for (const t of TOOL_DEFS) {
    if (seen.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
    seen.add(t.name);

    if (t.inputSchema.additionalProperties !== false) {
      throw new Error(`tool ${t.name}: inputSchema must set additionalProperties:false`);
    }

    // Every tool must resolve to a catalog action that is itself exposed. This
    // is what makes "the MCP is read-only" a checked property rather than a
    // claim: a tool pointing at a mutating action fails here, at import.
    const probe = t.call(sampleArgs(t.inputSchema));
    const action = findAction(probe.action);
    if (!action) throw new Error(`tool ${t.name}: unknown catalog action "${probe.action}"`);
    const blocked = isBlockedAction(action);
    if (blocked.blocked) throw new Error(`tool ${t.name}: action ${action.id} is blocked (${blocked.reason})`);
    if (!action.readOnly) throw new Error(`tool ${t.name}: action ${action.id} is not read-only`);
  }
}

/** Minimal arguments satisfying a schema's required fields, for the load-time probe. */
function sampleArgs(schema: JSONSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const p = schema.properties?.[key];
    if (!p) continue;
    out[key] =
      p.enum?.[0] ??
      (p.type === "integer" || p.type === "number" ? 1 : p.type === "boolean" ? true : p.type === "array" ? [] : "x");
  }
  return out;
}

assertInvariants();

// --- argument validation ----------------------------------------------------

export class ToolArgError extends Error {}

/**
 * Validate arguments against a tool's schema.
 *
 * Validation errors are the one place worth being generous: the schema is
 * already public, so a specific message leaks nothing and saves the model a
 * turn. Compare the terse internal errors elsewhere.
 */
export function validateArgs(schema: JSONSchema, raw: unknown): Record<string, unknown> {
  const args = (raw ?? {}) as Record<string, unknown>;
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new ToolArgError("Arguments must be an object.");
  }

  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      throw new ToolArgError(`Missing required argument "${key}".`);
    }
  }

  const known = Object.keys(schema.properties ?? {});
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const spec = schema.properties?.[key];
    if (!spec) {
      // additionalProperties:false, enforced rather than documented. A model
      // that invents a tenant argument gets told no, not silently ignored.
      throw new ToolArgError(
        `Unknown argument "${key}". Allowed: ${known.join(", ") || "(none)"}.`,
      );
    }
    out[key] = checkValue(key, value, spec);
  }
  return out;
}

function checkValue(key: string, value: unknown, spec: JSONSchema): unknown {
  const fail = (msg: string): never => {
    throw new ToolArgError(`Invalid value for "${key}": ${msg}`);
  };

  if (spec.type === "array") {
    if (!Array.isArray(value)) return fail(`expected an array, got ${typeof value}.`);
    if (spec.items) value.forEach((v, i) => checkValue(`${key}[${i}]`, v, spec.items as JSONSchema));
    return value;
  }
  if (spec.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail(`expected an object, got ${Array.isArray(value) ? "array" : typeof value}.`);
    }
    return value;
  }
  if (spec.type === "boolean") {
    if (typeof value !== "boolean") return fail(`expected true or false.`);
    return value;
  }
  if (spec.type === "integer" || spec.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) return fail(`expected a number.`);
    if (spec.type === "integer" && !Number.isInteger(value)) return fail(`expected a whole number.`);
    if (spec.minimum !== undefined && value < spec.minimum) return fail(`must be at least ${spec.minimum}.`);
    if (spec.maximum !== undefined && value > spec.maximum) return fail(`must be at most ${spec.maximum}.`);
    return value;
  }
  // string
  if (typeof value !== "string") return fail(`expected a string, got ${typeof value}.`);
  if (spec.enum && !spec.enum.includes(value)) {
    return fail(`got "${value}". Allowed: ${spec.enum.join(", ")}.`);
  }
  if (spec.minLength !== undefined && value.length < spec.minLength) {
    return fail(`must be at least ${spec.minLength} characters.`);
  }
  if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
    return fail(`does not match the expected format (${spec.pattern}).`);
  }
  return value;
}

// --- MCP surface ------------------------------------------------------------

export function toMcpTools(): Tool[] {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as unknown as Tool["inputSchema"],
    annotations: {
      title: t.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: t.openWorld ?? false,
    },
  }));
}

/** Strip undefined values so they never reach the query string as "undefined". */
function compact(o: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

export async function callTool(
  def: ToolDef,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const args = validateArgs(def.inputSchema, rawArgs);
  const spec = def.call(args);

  const res = await executeActionRaw({
    id: spec.action,
    path_params: compact(spec.path_params),
    query_params: compact(spec.query_params),
    body: spec.body ? compact(spec.body as Record<string, unknown>) : undefined,
    signal,
  });

  if (!res.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `CloudYali returned HTTP ${res.status}. ${JSON.stringify(res.body)}`,
        },
      ],
    };
  }

  const presented = def.present
    ? def.present(res.body, args)
    : { structured: (res.body ?? {}) as Record<string, unknown>, text: "Result returned." };

  return {
    content: [{ type: "text", text: presented.text }],
    structuredContent: presented.structured,
  };
}
