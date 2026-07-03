// execute_action implementation: action lookup, read-only enforcement,
// request construction, auth header injection, and 401 refresh-retry.
// Kept separate from index.ts (which starts the MCP server on import) so
// this logic is unit-testable.

import { findAction, isBlockedAction, searchActions } from "./catalog.js";
import { getValidAccessToken } from "./auth.js";
import { buildQueryString, substitutePath } from "./request.js";
import { CLOUDYALI_API_URL, CONSOLE_URL, STATIC_JWT_OVERRIDE } from "./config.js";

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

export async function executeAction(args: {
  id: string;
  path_params?: Record<string, unknown>;
  query_params?: Record<string, unknown>;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<string> {
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

  const result = {
    request: {
      action_id: action.id,
      method: action.method,
      url,
    },
    status: res.status,
    ok: res.ok,
    body: parsed,
  };
  return JSON.stringify(result, null, 2);
}
