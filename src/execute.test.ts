import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.js", () => ({
  getValidAccessToken: vi.fn(),
  AuthError: class AuthError extends Error {
    hint?: string;
    constructor(message: string, hint?: string) {
      super(message);
      this.hint = hint;
    }
  },
}));
vi.mock("./config.js", () => ({
  CLOUDYALI_API_URL: "https://api.example.com",
  CONSOLE_URL: "https://console.example.com",
  STATIC_JWT_OVERRIDE: undefined,
}));

import { executeAction, requestWithRetry, trimErrorBody, shapeResponse } from "./execute.js";
import * as catalog from "./catalog.js";
import { getValidAccessToken } from "./auth.js";

const mockToken = vi.mocked(getValidAccessToken);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const noDelay = { retryDelayMs: () => 0 };

describe("executeAction", () => {
  beforeEach(() => {
    mockToken.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an unknown action id with suggestions", async () => {
    await expect(executeAction({ id: "nope.nothing" })).rejects.toThrow(/Unknown action id/);
  });

  it("returns the parsed body and status for a successful call", async () => {
    mockToken.mockResolvedValue("tok-1");
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { total: 42 }));

    const text = await executeAction({ id: "recommendations.summary" });
    const result = JSON.parse(text);
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ total: 42 });
  });

  it("serializes query_params for actions and sends the bearer token", async () => {
    mockToken.mockResolvedValue("tok-1");
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, {}));

    await executeAction({
      id: "anomalies.summary",
      query_params: { startDate: "2026-05-01", endDate: "2026-05-31" },
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe(
      "https://api.example.com/v1/anomalies/summary?startDate=2026-05-01&endDate=2026-05-31",
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  });

  it("force-refreshes and retries exactly once on a 401", async () => {
    mockToken.mockResolvedValueOnce("stale").mockResolvedValueOnce("fresh");
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(401, { message: "expired" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = JSON.parse(await executeAction({ id: "recommendations.summary" }));

    expect(result.status).toBe(200);
    expect(mockToken).toHaveBeenNthCalledWith(1, { forceRefresh: false });
    expect(mockToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    const retryInit = vi.mocked(fetch).mock.calls[1][1];
    expect((retryInit?.headers as Record<string, string>).Authorization).toBe("Bearer fresh");
  });

  it("returns the second 401 as a result instead of looping", async () => {
    mockToken.mockResolvedValue("tok");
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, { message: "no" }));

    const result = JSON.parse(await executeAction({ id: "recommendations.summary" }));
    expect(result.status).toBe(401);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("attaches an abort signal (request timeout) to each fetch", async () => {
    mockToken.mockResolvedValue("tok-1");
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, {}));

    await executeAction({ id: "recommendations.summary" });

    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it("threads the caller's abort signal through to fetch (cancellation propagates)", async () => {
    mockToken.mockResolvedValue("tok-1");
    const external = new AbortController();
    let captured: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation((_url, init) => {
      captured = (init as RequestInit).signal ?? undefined;
      return Promise.resolve(jsonResponse(200, {}));
    });

    await executeAction({ id: "recommendations.summary", signal: external.signal });

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);
    // Aborting the caller's signal aborts the (combined) signal handed to fetch.
    external.abort();
    expect(captured?.aborted).toBe(true);
  });

  it("throws for a blocked action and never issues an HTTP request", async () => {
    // Defense-in-depth: even a (hypothetically mis-cataloged) blocked action must
    // be stopped before any fetch — this is the layer advertised as read-only.
    const spy = vi.spyOn(catalog, "isBlockedAction").mockReturnValue({ blocked: true, reason: "test-blocked" });
    mockToken.mockResolvedValue("tok-1");

    await expect(executeAction({ id: "recommendations.summary" })).rejects.toThrow(/blocked/i);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("sends a JSON-stringified body and Content-Type for a POST action", async () => {
    mockToken.mockResolvedValue("tok-1");
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, {}));

    await executeAction({ id: "cost.report", body: { start_time: "s", end_time: "e" } });

    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ start_time: "s", end_time: "e" }));
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends an empty JSON object body when a POST action is called without a body", async () => {
    mockToken.mockResolvedValue("tok-1");
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, {}));

    await executeAction({ id: "cost.report" });

    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe("{}");
  });

  it("wraps a non-JSON error body as a capped error string", async () => {
    mockToken.mockResolvedValue("tok-1");
    // 400 is non-transient (no retry) and its body is not JSON.
    vi.mocked(fetch).mockResolvedValue(new Response("Bad Request: not json", { status: 400 }));

    const result = JSON.parse(await executeAction({ id: "recommendations.summary" }));
    expect(result.status).toBe(400);
    expect(result.ok).toBe(false);
    expect(result.body).toEqual({ error: "Bad Request: not json" });
  });

  it("echoes only the path template, never the substituted URL", async () => {
    mockToken.mockResolvedValue("tok-1");
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, {}));

    const result = JSON.parse(
      await executeAction({
        id: "anomalies.summary",
        query_params: { startDate: "2026-05-01", endDate: "2026-05-31" },
      }),
    );

    expect(result.request.path).toBe("/v1/anomalies/summary");
    expect(result.request.url).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("api.example.com");
    expect(JSON.stringify(result)).not.toContain("2026-05-01");
  });

  it("trims a non-2xx JSON body to the error-contract allowlist", async () => {
    mockToken.mockResolvedValue("tok-1");
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(500, {
        code: 500,
        message: "internal error",
        stack: "goroutine 1 [running]: main.leak(0xc000)",
        query: "SELECT * FROM cost_opportunity WHERE ...",
        huge: "x".repeat(5000),
      }),
    );

    const result = JSON.parse(await executeAction({ id: "recommendations.summary" }));
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ code: 500, message: "internal error" });
    expect(JSON.stringify(result)).not.toContain("goroutine");
    expect(JSON.stringify(result)).not.toContain("SELECT");
  });

  it("keeps transition-result retry fields on a 409 and passes 2xx bodies through", async () => {
    mockToken.mockResolvedValue("tok-1");
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(409, {
        error: "illegal transition",
        current_status: "identified",
        allowed_transitions: ["acknowledged", "ignored"],
        internal_hint: "should be dropped",
      }),
    );

    const result = JSON.parse(await executeAction({ id: "recommendations.summary" }));
    expect(result.body).toEqual({
      error: "illegal transition",
      current_status: "identified",
      allowed_transitions: ["acknowledged", "ignored"],
    });
  });
});

describe("requestWithRetry", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries a transient 5xx and returns the eventual success", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(503, { e: 1 }))
      .mockResolvedValueOnce(jsonResponse(502, { e: 2 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const res = await requestWithRetry("https://api.example.com/x", {}, noDelay);
    expect(res.status).toBe(200);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("retries a thrown network error and returns the eventual success", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const res = await requestWithRetry("https://api.example.com/x", {}, noDelay);
    expect(res.status).toBe(200);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("returns the last 5xx response after exhausting retries (does not throw)", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(503, { down: true }));

    const res = await requestWithRetry("https://api.example.com/x", {}, { ...noDelay, maxRetries: 2 });
    expect(res.status).toBe(503);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting retries on persistent network errors", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      requestWithRetry("https://api.example.com/x", {}, { ...noDelay, maxRetries: 2 }),
    ).rejects.toThrow(/fetch failed/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-transient 4xx", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(400, { bad: true }));

    const res = await requestWithRetry("https://api.example.com/x", {}, noDelay);
    expect(res.status).toBe(400);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("passes a fresh timeout signal on each attempt", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, {}));

    await requestWithRetry("https://api.example.com/x", {}, noDelay);

    const first = vi.mocked(fetch).mock.calls[0][1]?.signal;
    const second = vi.mocked(fetch).mock.calls[1][1]?.signal;
    expect(first).toBeInstanceOf(AbortSignal);
    expect(second).toBeInstanceOf(AbortSignal);
    expect(first).not.toBe(second);
  });

  it("stops immediately (no retry/backoff) when the caller aborts mid-request", async () => {
    const external = new AbortController();
    let calls = 0;
    vi.mocked(fetch).mockImplementation(() => {
      calls += 1;
      external.abort(); // caller cancels while the request is in flight
      return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
    });

    await expect(
      requestWithRetry("https://api.example.com/x", {}, { ...noDelay, signal: external.signal, maxRetries: 2 }),
    ).rejects.toThrow();
    // A cancelled call must not burn the retry budget.
    expect(calls).toBe(1);
  });

  it("does not attempt a request when the caller's signal is already aborted", async () => {
    await expect(
      requestWithRetry("https://api.example.com/x", {}, { ...noDelay, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("combines an external abort signal with the per-attempt timeout", async () => {
    const external = new AbortController();
    let captured: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation((_url, init) => {
      captured = (init as RequestInit).signal ?? undefined;
      return Promise.resolve(jsonResponse(200, {}));
    });

    await requestWithRetry("https://api.example.com/x", {}, { ...noDelay, signal: external.signal });

    // The signal handed to fetch is wired to the external signal: aborting the
    // caller aborts what fetch received.
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);
    external.abort();
    expect(captured?.aborted).toBe(true);
  });
});

describe("error bodies never carry database internals", () => {
  it("withholds a Postgres column error instead of relaying it", () => {
    // The report that prompted this: order_by:"cost" produced HTTP 500 with
    // `column "cost" does not exist` — schema disclosure wearing the costume of
    // a helpful error. pkg/svcerror puts the raw Go error in `details`.
    const out = trimErrorBody({
      code: "internal_error",
      message: "query failed",
      details: 'ERROR: column "cost" does not exist (SQLSTATE 42703)',
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("cost\\\" does not exist");
    expect(json).not.toContain("SQLSTATE");
    expect(json).not.toContain("details");
    expect(out.code).toBe("internal_error");
  });

  it("scrubs a driver error even when it arrives as `message`", () => {
    // Dropping the field is not enough on its own — anyone can wrap a driver
    // error into the authored message field.
    const out = trimErrorBody({ message: 'pq: relation "cur_data_daily" does not exist' });
    expect(String(out.message)).not.toContain("cur_data_daily");
    expect(String(out.message)).toMatch(/check the arguments/i);
  });

  it("scrubs a Go stack trace arriving as a bare string body", () => {
    const out = trimErrorBody("goroutine 42 [running]:\nmain.handler(/app/queryService/service/cur.go:118)");
    expect(String(out.error)).not.toContain("queryService");
    expect(String(out.error)).not.toContain("goroutine");
  });

  it("scrubs an internal hostname and a connection string", () => {
    expect(String(trimErrorBody({ message: "dial tcp inventory-svc.svc.cluster.local:5432" }).message))
      .not.toContain("cluster.local");
    expect(String(trimErrorBody({ message: "postgres://user@db/cy" }).message)).not.toContain("postgres://");
  });

  it("leaves an ordinary authored message alone", () => {
    const out = trimErrorBody({ code: "not_found", message: "No budget with that id." });
    expect(out.message).toBe("No budget with that id.");
  });

  it("keeps the savings retry contract intact", () => {
    const out = trimErrorBody({
      error: "illegal transition",
      current_status: "identified",
      allowed_transitions: ["acknowledged", "ignored"],
    });
    expect(out.allowed_transitions).toEqual(["acknowledged", "ignored"]);
    expect(out.current_status).toBe("identified");
  });
});

describe("a shape that does not fit its body is reported, not returned as empty", () => {
  // The failure this closes: views.list shipped with an array shape against an
  // object body. Projection produced undefined, the tool said "no saved cost
  // views", and that was passed on as fact about an account that had several.
  // Nothing anywhere said a projection had failed.
  it("returns an explicit error rather than silence when nothing survives", () => {
    const out = shapeResponse("views.list", [{ id: "a", name: "b" }]) as { error?: string };
    expect(out.error).toMatch(/does not match what the API returned/);
    expect(out.error).toMatch(/bug in this server, not an empty result/);
    expect(out.error).toMatch(/do not report it as "none found"/);
  });

  it("leaves a genuinely empty result alone", () => {
    // The guard must not cry wolf: an account with no views really does get
    // {views: []}, and that is an answer, not a fault.
    expect(shapeResponse("views.list", { views: [] })).toEqual({ views: [] });
  });

  it("says nothing when the body was empty to begin with", () => {
    for (const empty of [{}, [], null, undefined]) {
      const out = shapeResponse("views.list", empty) as { error?: string };
      expect(out?.error, JSON.stringify(empty)).toBeUndefined();
    }
  });

  // The views.list guard only fires when the WHOLE body collapses. facets.resolve
  // shipped with `dimensions: "map"` against a map of objects: domain and as_of
  // survived, dimensions emptied, and the result was a well-formed body saying
  // the account had no filterable dimensions at all. Half-right is the dangerous
  // half here — it reads as an answer.
  it("catches a single field collapsing inside an otherwise healthy body", () => {
    const out = shapeResponse("facets.resolve", {
      domain: "cost",
      as_of: "2026-08-31T00:00:00Z",
      dimensions: { service: { values: [{ value: "AmazonEC2", status: "active" }], truncated: false } },
    }) as { error?: string };
    expect(out.error).toBeUndefined();
  });

  it("names the field that emptied so the fix has an address", () => {
    const out = shapeResponse("budgets.get", {
      name: "prod",
      amount: 100,
      filters: [{ id: 1, budgetId: 2 }],
    }) as { error?: string };
    expect(out.error).toMatch(/filters\[0\]/);
    expect(out.error).toMatch(/do not report .* as empty or absent/);
  });

  it("still leaves a real empty container alone", () => {
    const out = shapeResponse("budgets.get", { name: "prod", amount: 100, filters: [] }) as { error?: string };
    expect(out.error).toBeUndefined();
  });
});
