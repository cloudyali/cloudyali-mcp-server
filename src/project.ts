// Response projection: the allowlist that decides what a model is allowed to see.
//
// The bug this exists to close: execute_action used to relay every 2xx body from
// the CloudYali API verbatim into the model's context. Whatever the backend
// marshalled — internal tenant keys, sequential primary keys, alert-channel
// config holding webhook URLs, colleague email addresses, raw provider blobs —
// went straight into a conversation transcript. The error path already had an
// allowlist; the success path, which carries far more data, had none.
//
// The rule is allowlist, never denylist. A denylist is correct only until
// somebody adds a field; an allowlist is wrong only when somebody edits this
// file, which is a reviewable diff.
//
// Safety property worth preserving if you extend this: "value" can never emit an
// object. That means a new nested struct appearing in an API response cannot
// leak through a field that was only ever meant to hold a number — the most
// likely way an allowlist silently stops being one.

/**
 * A declarative description of the fields an action may return.
 *
 *   "value"    keep primitives (and arrays of primitives). Objects are dropped.
 *   "map"      keep a flat object of primitive values, e.g. resource tags.
 *   { … }      keep exactly these keys, recursing into each.
 *   [shape]    the value is an array; apply `shape` to every element.
 */
export type Shape = "value" | "map" | { readonly [key: string]: Shape } | readonly [Shape];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPrimitive(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

export type ProjectOptions = {
  /** Collects the dot-paths that were dropped, for the shape-audit mode. */
  dropped?: Set<string>;
};

function note(opts: ProjectOptions | undefined, path: string): void {
  if (opts?.dropped && path) opts.dropped.add(path);
}

function projectValue(input: unknown, path: string, opts?: ProjectOptions): unknown {
  if (isPrimitive(input)) return input;
  if (Array.isArray(input)) {
    // An array of primitives is fine; an array of objects under "value" is a
    // shape authoring mistake, and dropping it is the safe reading.
    if (input.every(isPrimitive)) return input;
    note(opts, `${path}[]`);
    return undefined;
  }
  note(opts, path);
  return undefined;
}

function projectMap(input: unknown, path: string, opts?: ProjectOptions): unknown {
  if (!isPlainObject(input)) {
    if (input !== undefined) note(opts, path);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (isPrimitive(v)) out[k] = v;
    else note(opts, `${path}.${k}`);
  }
  return out;
}

/**
 * Project `input` through `shape`, returning only allowlisted fields.
 *
 * Keys absent from the input are omitted rather than emitted as null, so the
 * model is never told a field exists but is empty when the API simply did not
 * send it. Keys present in the input but absent from the shape are dropped.
 */
export function project(input: unknown, shape: Shape, opts?: ProjectOptions, path = ""): unknown {
  if (shape === "value") return projectValue(input, path, opts);
  if (shape === "map") return projectMap(input, path, opts);

  if (Array.isArray(shape)) {
    if (!Array.isArray(input)) {
      if (input !== undefined && input !== null) note(opts, path);
      return input === null ? null : undefined;
    }
    const elem = shape[0] as Shape;
    return input.map((item, i) => project(item, elem, opts, `${path}[${i}]`));
  }

  // Object shape.
  if (!isPlainObject(input)) {
    if (input !== undefined && input !== null) note(opts, path);
    return input === null ? null : undefined;
  }
  const spec = shape as Record<string, Shape>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const sub = spec[k];
    if (sub === undefined) {
      note(opts, path ? `${path}.${k}` : k);
      continue;
    }
    const projected = project(v, sub, opts, path ? `${path}.${k}` : k);
    if (projected !== undefined) out[k] = projected;
  }
  return out;
}

/**
 * Project a whole response body, tolerating the two envelope shapes the
 * CloudYali API actually uses: a bare object/array, or `{ data: … }`.
 *
 * A body that is neither (an HTML error page, a bare string) is replaced with a
 * short marker rather than relayed — an unrecognised body is exactly the case
 * where passing it through is most likely to leak something.
 */
export function projectBody(body: unknown, shape: Shape, opts?: ProjectOptions): unknown {
  if (body === null || body === undefined) return body;
  if (typeof body === "string") {
    note(opts, "<non-json body>");
    return { note: "Response was not JSON; body withheld." };
  }
  return project(body, shape, opts);
}

// ---------------------------------------------------------------------------
// Redaction: the scoped stopgap for responses whose full field list we have not
// verified against a live account.
//
// An allowlist requires knowing every field a response can contain. For the
// inventory, budgets, savings and anomaly endpoints we do — those DTOs were read
// field by field, and every one of them carries a Tier-1 or Tier-2 leak, so they
// get a real allowlist. The cost endpoints are the opposite case: they were
// audited as carrying no tenant key, no primary key and no PII, but their nested
// chart/table structures are wide and were not fully enumerated, so authoring an
// allowlist from guesswork would strip real cost data — breaking the product to
// fix a leak that isn't there.
//
// So those get a deep key removal instead, and this is deliberately a denylist.
// It is tracked debt, not a pattern to copy: `RESPONSE_POLICY` names exactly
// which actions use it, and a test asserts the list does not grow. Close the gap
// by running the server with CLOUDYALI_MCP_SHAPE_AUDIT=1 against a real account,
// reading the dropped-path report, and promoting each action to an allowlist.

/** Key names that must never reach a model, matched at any depth. */
export const REDACT_KEYS: readonly string[] = [
  "customer_id",
  "customerId",
  "tenant_id",
  "tenantId",
  "org_id",
  "orgId",
  "channelConfig",
  "channel_config",
  "users",
  "email",
  "actor_email",
  "actor_name",
  "author_email",
  "author_name",
  "changed_by",
  "changedBy",
  "assigned_to_user_id",
  "actor_user_id",
  "author_user_id",
  "properties",
  "raw_payload",
  "rawPayload",
  "engine_version",
  "rule_id",
  "config_checksum",
  "savings_provenance",
  "evidence",
  "payload",
  "processing_time",
  "record_count",
];

const REDACT_SET = new Set(REDACT_KEYS.map((k) => k.toLowerCase()));

/**
 * Deep-remove every REDACT_KEYS entry from a body, preserving everything else.
 *
 * Depth is bounded: a cyclic or pathologically nested body is truncated rather
 * than blowing the stack, because an untrusted upstream should not be able to
 * crash the server with a deeply nested response.
 */
export function redact(input: unknown, opts?: ProjectOptions, path = "", depth = 0): unknown {
  if (depth > 64) {
    note(opts, `${path}<max depth>`);
    return undefined;
  }
  if (Array.isArray(input)) {
    return input.map((v, i) => redact(v, opts, `${path}[${i}]`, depth + 1));
  }
  if (!isPlainObject(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const p = path ? `${path}.${k}` : k;
    if (REDACT_SET.has(k.toLowerCase())) {
      note(opts, p);
      continue;
    }
    out[k] = redact(v, opts, p, depth + 1);
  }
  return out;
}
