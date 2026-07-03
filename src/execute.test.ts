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

import { executeAction, requestWithRetry } from "./execute.js";
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

  it("returns a non-JSON response body as a raw string", async () => {
    mockToken.mockResolvedValue("tok-1");
    // 400 is non-transient (no retry) and its body is not JSON.
    vi.mocked(fetch).mockResolvedValue(new Response("Bad Request: not json", { status: 400 }));

    const result = JSON.parse(await executeAction({ id: "recommendations.summary" }));
    expect(result.status).toBe(400);
    expect(result.ok).toBe(false);
    expect(result.body).toBe("Bad Request: not json");
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
