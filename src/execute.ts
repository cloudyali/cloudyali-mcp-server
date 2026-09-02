// execute_action implementation: action lookup, read-only enforcement,
// request construction, auth header injection, and 401 refresh-retry.
// Kept separate from index.ts (which starts the MCP server on import) so
// this logic is unit-testable.

import { findAction, isBlockedAction, searchActions } from "./catalog.js";
import { getValidAccessToken } from "./auth.js";
import { buildQueryString, substitutePath } from "./request.js";
import { CLOUDYALI_API_URL, CONSOLE_URL, STATIC_JWT_OVERRIDE } from "./config.js";
import { apiThrottle } from "./throttle.js";
import { ProjectOptions, projectBody, redact } from "./project.js";
import { RESPONSE_POLICY } from "./shapes.js";

async function buildHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const token = await getValidAccessToken({ forceRefresh });
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

// Per-request wall-clock cap. Cost reports over wide windows can be slow, so
// keep this generous; the point is to never block the tool call forever.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// Retries beyond the first attempt, for transient failures only.
const DEFAULT_MAX_RETRIES = 2;

type RetryOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: (attempt: number) => number;
  // Caller cancellation (e.g. the MCP request's AbortSignal). Combined with the
  // per-attempt timeout so a cancelled tool call stops retrying/waiting promptly.
  signal?: AbortSignal;
};

// Combine abort signals: the returned signal aborts when ANY input aborts.
// Prefers the native AbortSignal.any (Node >=20.3 / >=18.17); falls back to a
// manual controller so the server still runs on older Node 20.x.
function anySignal(signals: AbortSignal[]): AbortSignal {
  const nativeAny = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof nativeAny === "function") return nativeAny(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

// 5xx, request-timeout, and rate-limit are worth retrying; everything else
// (2xx, 3xx, 4xx including 401) is the caller's to handle.
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function defaultBackoff(attempt: number): number {
  return 250 * 2 ** attempt; // 250ms, 500ms
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Don't let a pending backoff timer keep the process alive.
    if (typeof t.unref === "function") t.unref();
  });
}

// fetch with a per-attempt timeout and bounded retries on transient failures
// (network errors and 5xx/408/429). A fresh AbortSignal.timeout is created
// for every attempt so a slow first try doesn't eat the retry's budget.
export async function requestWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoff = opts.retryDelayMs ?? defaultBackoff;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // A caller cancellation is terminal — don't start (or retry) a request the
    // client has already abandoned; retrying would just burn the backoff budget.
    if (opts.signal?.aborted) {
      throw new Error("Request aborted by the caller.");
    }
    try {
      // Inside the retry loop on purpose: a retry is another request against the
      // same backend, and a 5xx-driven retry storm is precisely what we bound.
      await apiThrottle.take(opts.signal);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = opts.signal ? anySignal([timeout, opts.signal]) : timeout;
      const res = await fetch(url, { ...init, signal });
      if (isTransientStatus(res.status) && attempt < maxRetries) {
        await sleep(backoff(attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      // If the failure was the caller cancelling, stop now rather than sleeping
      // through backoff and re-issuing a request that will immediately abort.
      if (opts.signal?.aborted) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < maxRetries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  // Unreachable: the loop either returns a response or throws on the last
  // attempt. Present only to satisfy the type checker.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export type ActionResult = {
  request: { action_id: string; method: string; path: string };
  status: number;
  ok: boolean;
  body: unknown;
};

/**
 * Call a catalog action and return the shaped result as an object.
 *
 * The typed tools in src/tools consume this; `executeAction` below is the same
 * thing stringified, kept for the raw escape-hatch tool. Both go through the
 * same auth, throttle, retry and response-policy path — there is deliberately
 * no route to the API that skips the projection.
 */
export async function executeActionRaw(args: {
  id: string;
  path_params?: Record<string, unknown>;
  query_params?: Record<string, unknown>;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<ActionResult> {
  const action = findAction(args.id);
  if (!action) {
    const suggestions = searchActions(args.id, undefined, 5).map((a) => a.id);
    throw new Error(
      `Unknown action id "${args.id}". Try search_actions first. Closest matches: ${
        suggestions.length ? suggestions.join(", ") : "(none)"
      }`,
    );
  }

  const block = isBlockedAction(action);
  if (block.blocked) {
    throw new Error(
      `Action "${action.id}" (${action.method} ${action.path}) is blocked: ${block.reason}. This MCP server is hard-locked to read-only CloudYali data access. Make changes in the portal at ${CONSOLE_URL}.`,
    );
  }

  const url = `${CLOUDYALI_API_URL}${substitutePath(action, args.path_params)}${buildQueryString(action, args.query_params)}`;
  const init: RequestInit = {
    method: action.method,
    headers: await buildHeaders(),
  };

  if (action.method !== "GET") {
    init.body = JSON.stringify(args.body ?? {});
  }

  const retryOpts = { signal: args.signal };
  let res = await requestWithRetry(url, init, retryOpts);
  if (res.status === 401 && !STATIC_JWT_OVERRIDE) {
    // The local expiry check passed but the backend rejected the token
    // (clock skew, server-side revocation). Force one refresh and retry;
    // if the refresh token itself is dead this throws AuthError with a
    // login hint instead of looping on 401s.
    init.headers = await buildHeaders(true);
    res = await requestWithRetry(url, init, retryOpts);
  }
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // leave as string
  }

  const result: ActionResult = {
    request: {
      action_id: action.id,
      method: action.method,
      // The path TEMPLATE only (review note, GA/public build): the caller already
      // knows its own arguments, so echoing the fully-substituted URL (host +
      // path params + query values) back to an untrusted MCP client adds nothing
      // and leaks the deployment host and request internals verbatim.
      path: action.path,
    },
    status: res.status,
    ok: res.ok,
    // Both directions are filtered. Non-2xx bodies are trimmed to the API's
    // intentional error contract; 2xx bodies — which carry far more data — go
    // through the per-action response policy. Neither is relayed verbatim.
    body: res.ok ? shapeResponse(action.id, parsed) : trimErrorBody(parsed),
  };
  return result;
}

/** String form of executeActionRaw, for the raw execute_action tool. */
export async function executeAction(args: Parameters<typeof executeActionRaw>[0]): Promise<string> {
  return JSON.stringify(await executeActionRaw(args), null, 2);
}

// Set CLOUDYALI_MCP_SHAPE_AUDIT=1 to have every dropped field path written to
// stderr. That is how you close the gap on an action still using redaction:
// run a real query, read what was dropped, and promote it to an allowlist.
const SHAPE_AUDIT = process.env.CLOUDYALI_MCP_SHAPE_AUDIT === "1";

/**
 * Apply the action's response policy to a successful body.
 *
 * Fails closed: an action with no policy returns nothing but a pointer to the
 * fix. That is deliberate — the failure mode of this system is a new action
 * shipping without anyone deciding what it may expose, and a visible empty
 * result gets fixed while a silent passthrough does not.
 */
export function shapeResponse(actionId: string, parsed: unknown): unknown {
  const policy = RESPONSE_POLICY[actionId];
  const opts: ProjectOptions | undefined = SHAPE_AUDIT ? { dropped: new Set<string>() } : undefined;

  let out: unknown;
  if (!policy) {
    process.stderr.write(
      `cloudyali-mcp: no response policy for action "${actionId}"; body withheld. Add one in src/shapes.ts.\n`,
    );
    return { note: `No response policy is defined for "${actionId}", so its body was withheld.` };
  }
  out = policy.kind === "allowlist" ? projectBody(parsed, policy.shape, opts) : redact(parsed, opts);

  if (opts?.dropped?.size) {
    process.stderr.write(
      `cloudyali-mcp: shape audit ${actionId} dropped ${opts.dropped.size} path(s): ${[...opts.dropped]
        .sort()
        .join(", ")}\n`,
    );
  }
  return out;
}

// Longest error string relayed to the client per field.
const MAX_ERROR_FIELD_LEN = 300;

// Error-contract fields a client legitimately needs: the svcerror shape
// {code, message, details} plus the savings transition-result fields
// (error/current_status/allowed_transitions/missing) that drive retry UX.
// `details` is deliberately absent. pkg/svcerror puts the raw Go error there —
// `errorResponse.Error()` verbatim — so it is the channel that carries pgx and
// pq messages, SQLSTATE codes and column names straight into model context. A
// real report: order_by:"cost" produced `column "cost" does not exist`, which
// is schema disclosure dressed up as a helpful error. `message` is the API's
// intentional, authored text and stays.
const ERROR_FIELD_ALLOWLIST = [
  "code",
  "message",
  "error",
  "current_status",
  "allowed_transitions",
  "missing",
] as const;

// Field-level dropping is necessary but not sufficient: an upstream `message`
// can carry the same content if someone wraps a driver error into one. These
// patterns are checked on every error string that survives the allowlist, and a
// match replaces the whole string rather than redacting part of it — a partial
// redaction leaves you guessing which part was the sensitive half.
const LEAKY_ERROR_PATTERNS: RegExp[] = [
  /\bcolumn\s+"[^"]+"\s+does not exist/i,
  /\brelation\s+"[^"]+"\s+does not exist/i,
  /\bSQLSTATE\b/i,
  /^\s*(pq|pgx|sql):/i,
  /\b(SELECT|INSERT|UPDATE|DELETE)\b[^"]{0,80}\bFROM\b/i,
  /goroutine \d+ \[/,
  /\.go:\d+/,
  /\b(dial tcp|connection refused|no such host)\b/i,
  /\b[\w-]+\.(internal|local|svc\.cluster\.local)\b/i,
  /(postgres(ql)?|redis|amqp):\/\//i,
];

function scrubErrorText(text: string): string {
  for (const re of LEAKY_ERROR_PATTERNS) {
    if (re.test(text)) {
      return "The CloudYali API rejected this request. Check the arguments against the tool schema; if they look right, the endpoint may not support this combination.";
    }
  }
  return text;
}

// trimErrorBody reduces a non-2xx backend body to the allowlisted error-contract
// fields (review note, GA/public build): anything else — stack traces, driver
// errors, oversized payloads a misconfigured backend might emit — is dropped
// rather than relayed verbatim to an untrusted MCP client. Strings are capped;
// string arrays (allowed_transitions/missing) are kept as-is.
export function trimErrorBody(parsed: unknown): Record<string, unknown> {
  const cap = (s: string) =>
    s.length > MAX_ERROR_FIELD_LEN ? `${s.slice(0, MAX_ERROR_FIELD_LEN)}…` : s;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const src = parsed as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of ERROR_FIELD_ALLOWLIST) {
      const v = src[key];
      if (typeof v === "string" && v.length > 0) out[key] = cap(scrubErrorText(v));
      else if (typeof v === "number") out[key] = v;
      else if (Array.isArray(v) && v.every((e) => typeof e === "string")) out[key] = v;
    }
    if (Object.keys(out).length === 0) out.error = "request failed";
    return out;
  }
  if (typeof parsed === "string" && parsed.trim().length > 0) {
    return { error: cap(scrubErrorText(parsed.trim())) };
  }
  return { error: "request failed" };
}
