import { describe, expect, it } from "vitest";
import { describeHttpFailure, describeTransportFailure, isTransportError } from "./errors.js";

const API = "https://api.example.com";

// The bar these have to clear is not "readable". The reader is usually a model
// that will act on the message, and the two ways that goes wrong are already
// documented in this repo: an error reported onward as a real answer, and an
// error answered with a retry that changes something irrelevant.

describe("an HTTP failure says whose problem it is", () => {
  it("400: the request never ran, and repeating it will not help", () => {
    const t = describeHttpFailure(400, { code: "invalid_period", message: "period must be RFC3339" }, "query_costs");
    expect(t).toContain("query_costs");
    expect(t).toMatch(/never ran/);
    expect(t).toMatch(/period must be RFC3339/);
    expect(t).toMatch(/fail the same way/);
  });

  it("401 points at the one action that fixes it", () => {
    expect(describeHttpFailure(401, {}, "list_budgets")).toMatch(/`login`/);
  });

  it("403 says retrying is pointless, because entitlement is not an argument", () => {
    const t = describeHttpFailure(403, {}, "get_tag_health");
    expect(t).toMatch(/retrying, rephrasing or narrowing the query will not change it/);
  });

  // The one that produced a wrong answer in the field, in its other form: an
  // empty projection reported as "none found". A 404 is a missing id, and a
  // missing id reported as zero records is the same lie.
  it("404 forbids reporting the miss as an empty result", () => {
    const t = describeHttpFailure(404, { message: "no such budget" }, "get_budget");
    expect(t).toMatch(/NOT an empty result/);
    expect(t).toMatch(/do not report it as "none found"/);
  });

  it("a timeout names the lever that actually shortens the query", () => {
    const t = describeHttpFailure(504, {}, "get_cost_breakdown");
    expect(t).toMatch(/shorter date range/);
    expect(t).toMatch(/coarser interval/);
  });

  it("429 distinguishes the server's limit from this client's", () => {
    expect(describeHttpFailure(429, {}, "query_costs")).toMatch(/not this client's/);
  });

  // Fanning out to 40 views produced 500s. A model that answers a 500 by
  // changing the grouping gets another 500 and, eventually, a partial answer it
  // presents as whole.
  it("5xx says the phrasing was never the cause", () => {
    const t = describeHttpFailure(500, {}, "run_cost_view");
    expect(t).toMatch(/already retried/);
    expect(t).toMatch(/do not retry with the arguments changed/);
    expect(t).toMatch(/would be incomplete/);
  });

  it("passes the API's own sentence through when there is one, and invents nothing when there is not", () => {
    expect(describeHttpFailure(400, { message: "bad dimension" }, "x")).toContain("CloudYali said: bad dimension.");
    // trimErrorBody's placeholder for a body that carried nothing allowlisted.
    expect(describeHttpFailure(500, { error: "request failed" }, "x")).not.toMatch(/CloudYali said/);
    expect(describeHttpFailure(500, undefined, "x")).not.toMatch(/CloudYali said/);
  });

  it("never dumps a JSON body into the prose", () => {
    for (const status of [400, 401, 403, 404, 408, 429, 500, 503, 418]) {
      const t = describeHttpFailure(status, { code: "c", message: "m", secret: { nested: true } }, "tool");
      expect(t, `status ${status}`).not.toMatch(/[{}]/);
      expect(t, `status ${status}`).not.toContain("nested");
    }
  });

  it("names the tool in every branch, since a client shows the message and not the call", () => {
    for (const status of [400, 401, 403, 404, 408, 429, 500, 418]) {
      expect(describeHttpFailure(status, {}, "get_spend_summary"), `status ${status}`).toContain("get_spend_summary");
    }
  });
});

describe("a request that never left is diagnosable", () => {
  const withCause = (msg: string, code: string) => {
    const e = new TypeError(msg);
    (e as { cause?: unknown }).cause = { code };
    return e;
  };

  // `fetch failed` is the entire message undici gives for DNS failure, a refused
  // connection and a TLS rejection alike, and none of them share a fix.
  it("separates DNS from a refused connection from TLS", () => {
    expect(describeTransportFailure(withCause("fetch failed", "ENOTFOUND"), API, "t")).toMatch(/did not resolve/);
    expect(describeTransportFailure(withCause("fetch failed", "ECONNREFUSED"), API, "t")).toMatch(/nothing accepted a connection/);
    expect(describeTransportFailure(withCause("fetch failed", "CERT_HAS_EXPIRED"), API, "t")).toMatch(/TLS certificate/);
  });

  it("names the configured URL, because a typo in it looks exactly like an outage", () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET"]) {
      expect(describeTransportFailure(withCause("fetch failed", code), API, "t")).toContain(API);
    }
  });

  it("says whether anything was sent, which decides whether calling again is safe", () => {
    expect(describeTransportFailure(withCause("fetch failed", "ENOTFOUND"), API, "t")).toMatch(/Nothing was sent/);
    expect(describeTransportFailure(withCause("socket hang up", "ECONNRESET"), API, "t")).toMatch(/calling again is safe/);
  });

  it("treats a timeout as a query-size problem first, and a reachability problem second", () => {
    const e = new Error("timed out");
    e.name = "TimeoutError";
    const t = describeTransportFailure(e, API, "get_cost_breakdown");
    expect(t).toMatch(/shorter date range/);
    expect(t).toMatch(/slow or unreachable rather than the query being large/);
  });
});

describe("a bug on this side is not reported as a network problem", () => {
  // Describing a TypeError from our own code as "could not reach CloudYali"
  // sends the reader to check their network for an hour over a null deref.
  it("does not classify a plain programming error as transport", () => {
    expect(isTransportError(new TypeError("x.map is not a function"))).toBe(false);
    expect(isTransportError(new Error("upstream exploded"))).toBe(false);
    expect(isTransportError("not even an error")).toBe(false);
  });

  it("does classify the shapes a real network fault arrives in", () => {
    const dns = new TypeError("fetch failed");
    (dns as { cause?: unknown }).cause = { code: "ENOTFOUND" };
    expect(isTransportError(dns)).toBe(true);

    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    expect(isTransportError(timeout)).toBe(true);

    expect(isTransportError(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("the error path cannot become the leak", () => {
  // Every other model-facing surface is scanned for these. The error path was
  // the one place that could still emit them, because it relays a string the
  // backend composed — and an error message is where a backend is most likely
  // to explain itself.
  const scrubbed = /rejected this request\. Check the arguments/;

  it("replaces a message describing storage, refresh or a tenant key", () => {
    for (const message of [
      'pq: relation "cur_data_daily" does not exist',
      "materialized view refresh failed",
      "no rows for customer_id 210",
      "the resources view was last refreshed by the nightly job",
      "queryService panic at cost_api.go:412",
    ]) {
      const t = describeHttpFailure(400, { message }, "query_costs");
      expect(t, message).toMatch(scrubbed);
      expect(t, message).not.toContain(message);
    }
  });

  it("leaves an ordinary API message intact — scrubbing everything would be its own bug", () => {
    const t = describeHttpFailure(400, { message: "group_by supports at most 4 dimensions" }, "query_costs");
    expect(t).toContain("group_by supports at most 4 dimensions");
  });
});
