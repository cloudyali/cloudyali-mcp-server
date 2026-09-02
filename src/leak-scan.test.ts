import { describe, expect, it } from "vitest";
import { RESOURCES, readResource } from "./resources.js";
import { TOOL_DEFS } from "./tools/index.js";
import { costWarningsFor } from "./filter-support.js";
import { RESPONSE_POLICY } from "./shapes.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { describeHttpFailure, describeTransportFailure } from "./errors.js";

// The leak scanner (G13 in the hardening plan).
//
// This exists because I wrote the leak myself, in the course of building a guard against leaks.
// Explaining WHY two figures disagree, I reached for the backend's storage design and put
// "materialized view", "refreshed by separate jobs" and a retention window into a resource body
// and into a published artifact. Nishant caught it: the MCP reaches the API over HTTP like any
// other client, so it has no business describing what is behind it.
//
// Two separate reasons that was wrong, and both are why this file is a test rather than a note:
//
//   1. It is the exact failure this whole server exists to prevent. A customer_id in model
//      context and a table name in model context are the same defect wearing different clothes,
//      and the second one is easier to write because it feels like helpfulness.
//   2. It could not have been kept true. That knowledge came from reading backend source, not
//      from anything the API returns. If the backend changed tomorrow, the MCP would go on
//      asserting the old mechanism with total confidence and no way to notice.
//
// The rule this encodes: a warning says WHAT the reader observes and what to do about it. Never
// why. The mechanism belongs in source comments and backend tickets, which is where it now lives.

/** Vocabulary that only makes sense if you have seen inside the backend. */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/materiali[sz]ed view|matview|\bmv_[a-z_]+/i, "storage internals"],
  [/cur_data_daily|gcp_billing_data|azure_billing_data|_daily_costs\b|unified_resource\b/i, "table name"],
  [/\bORDER BY\b|\bWHERE clause\b|\bSELECT\b\s|\bJOIN\b|SQLSTATE|\bpq:|\bpgx:/i, "SQL"],
  [/postgres|squirrel|gorilla\/mux|negroni|goroutine|\.go\b|queryService|rajgad/i, "backend stack"],
  [/refreshed by|refresh job|separate jobs|retention window|last refreshed/i, "refresh/retention internals"],
  [/customer_id|customerId/i, "tenant key"],
  // How a number was decided is machinery, exactly like where it was stored.
  // z-score reached a user beside a $0.41 impact, where 8.0 reads as an
  // eight-sigma emergency over forty-one cents — accurate, unusable, and an
  // invitation to rank anomalies by a statistic instead of by dollars.
  [/z[-_ ]?score|\bsigma\b|standard deviation|engine_version|config_checksum|rootCauseAnalysis|\brule_id\b/i, "detector internals"],
];

/** Everything that actually reaches a model. Source comments do not — they are compiled away. */
function modelFacingText(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  // Clients may put this straight into the system prompt, which makes it the
  // single most model-facing string the server owns.
  out.push(["server instructions", SERVER_INSTRUCTIONS]);
  for (const r of RESOURCES) {
    out.push([`resource ${r.uri} body`, readResource(r.uri).text]);
    out.push([`resource ${r.uri} description`, r.description ?? ""]);
    out.push([`resource ${r.uri} name`, r.name ?? ""]);
  }
  for (const t of TOOL_DEFS) {
    out.push([`tool ${t.name} description`, t.description]);
    out.push([`tool ${t.name} title`, t.title ?? ""]);
    out.push([`tool ${t.name} inputSchema`, JSON.stringify(t.inputSchema)]);
  }
  // Every warning string, exercised rather than read: these are built at call time and are the
  // most likely place for an explanation to creep back in.
  const group = (extra: Record<string, unknown>) => [
    { operator: "AND", cloud_providers: [{ operator: "equals", value: ["AWS"] }], ...extra },
  ];
  const cases: Array<Record<string, unknown>> = [
    { filters: group({ usage_types: [{ operator: "equals", value: ["x"] }] }) },
    { filters: group({ resource_names: [{ operator: "equals", value: ["r"] }] }) },
    {
      filters: group({
        resource_names: [{ operator: "equals", value: ["r"] }],
        usage_types: [{ operator: "equals", value: ["x"] }],
      }),
      group_by_dimensions: ["usage_type"],
    },
  ];
  cases.forEach((c, i) => out.push([`runtime warning #${i + 1}`, costWarningsFor(c)]));
  // Failure messages are the surface most likely to reach for an explanation of
  // what went wrong underneath, which is exactly the thing this file forbids.
  // Exercised across every branch, with a body carrying the sort of text a
  // misbehaving backend actually emits.
  const leakyBody = {
    code: "pq: relation \"cur_data_daily\" does not exist",
    message: "materialized view refresh failed for customer_id 210",
  };
  for (const status of [400, 401, 403, 404, 408, 429, 500, 503, 418]) {
    out.push([`http failure ${status}`, describeHttpFailure(status, leakyBody, "query_costs")]);
    out.push([`http failure ${status} (bare)`, describeHttpFailure(status, undefined, "query_costs")]);
  }
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "CERT_HAS_EXPIRED", "UNKNOWN"]) {
    const e = new TypeError("fetch failed");
    (e as { cause?: unknown }).cause = { code };
    out.push([`transport failure ${code}`, describeTransportFailure(e, "https://api.example.com", "query_costs")]);
  }
  // Redaction reasons ship inside the withheld-body notice, so they are model-facing too.
  for (const [action, policy] of Object.entries(RESPONSE_POLICY)) {
    if (policy.kind === "redact") out.push([`redact reason for ${action}`, policy.reason]);
  }
  return out;
}

describe("nothing model-facing describes the backend", () => {
  const surfaces = modelFacingText();

  it("scans a surface big enough to be worth trusting", () => {
    expect(surfaces.length).toBeGreaterThan(60);
    expect(surfaces.some(([, t]) => t.length > 2000)).toBe(true);
  });

  for (const [pattern, label] of FORBIDDEN) {
    it(`leaks no ${label}`, () => {
      const found = surfaces
        .filter(([, text]) => pattern.test(text))
        .map(([where, text]) => `${where}: ${text.match(pattern)?.[0]} — "${(text.split("\n").find((l) => pattern.test(l)) ?? "").trim().slice(0, 120)}"`);
      expect(found, found.join("\n")).toEqual([]);
    });
  }

  it("still says the things that change behaviour", () => {
    // The scanner must not be satisfiable by saying nothing. These are the load-bearing
    // instructions the de-leaked text has to keep.
    const all = surfaces.map(([, t]) => t).join("\n");
    expect(all).toMatch(/not comparable/i);
    expect(all).toMatch(/would be invented/i);
    expect(all).toMatch(/not evidence of zero spend/i);
    expect(all).toMatch(/does not support filtering by/i);
  });
});
