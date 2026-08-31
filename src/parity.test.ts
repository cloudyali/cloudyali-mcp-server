import { describe, expect, it } from "vitest";
import { CATALOG, READ_ONLY_CATALOG, findAction } from "./catalog.js";
import { buildQueryString, substitutePath } from "./request.js";

// M9 — MCP parity (US-032). Two guarantees are enforced statically here (the
// live numeric comparison against a running stack lives in the smoke/parity
// CI job — see scripts/smoke.mjs):
//   (a) ZERO catalog actions point at a removed endpoint. The old
//       /v1/recommendations/* surface is decommissioned (410) in the same
//       release (US-030); a public MCP must never target a 410.
//   (b) The recommendations category talks to the SAME /v1/savings/* endpoints
//       the UI and reports use — no bespoke query paths — so identical filters
//       produce identical URLs and therefore identical numbers by construction.

describe("M9 parity: no action targets a removed endpoint", () => {
  it("has zero catalog actions on the decommissioned /v1/recommendations surface", () => {
    const stale = CATALOG.filter((a) => /^\/v\d+\/recommendations(\/|$)/.test(a.path));
    expect(stale.map((a) => `${a.id} -> ${a.path}`)).toEqual([]);
  });
});

describe("M9 parity: recommendations category is the savings API", () => {
  it("routes every recommendations action to /v1/savings/*", () => {
    const recs = CATALOG.filter((a) => a.category === "recommendations");
    expect(recs.length).toBeGreaterThan(0);
    for (const a of recs) {
      expect(a.path.startsWith("/v1/savings/"), `${a.id} -> ${a.path}`).toBe(true);
    }
  });

  it("keeps the three read actions (list, summary, detail) reachable", () => {
    for (const id of ["recommendations.list", "recommendations.summary", "recommendations.get"]) {
      expect(findAction(id), id).toBeDefined();
      expect(READ_ONLY_CATALOG.map((a) => a.id)).toContain(id);
    }
  });
});

describe("M9 parity: MCP builds the same URL the UI calls", () => {
  it("list with identical filters yields the identical savings-opportunities URL", () => {
    const a = findAction("recommendations.list")!;
    const url = substitutePath(a, undefined) + buildQueryString(a, { provider: ["aws", "gcp"], minSavings: 25, state: ["identified"] });
    // Same path + same query the portal's list request uses (repeated array params).
    expect(url).toBe("/v1/savings/opportunities?provider=aws&provider=gcp&minSavings=25&state=identified");
  });

  it("summary honours the same filter set as list on the shared endpoint", () => {
    const a = findAction("recommendations.summary")!;
    const url = substitutePath(a, undefined) + buildQueryString(a, { provider: ["azure"], category: ["wastage"] });
    expect(url).toBe("/v1/savings/summary?provider=azure&category=wastage");
  });

  it("detail substitutes the id into the shared detail endpoint", () => {
    const a = findAction("recommendations.get")!;
    expect(substitutePath(a, { id: 4213 })).toBe("/v1/savings/opportunities/4213");
  });

  it("exposes no savings write — the transition action is withdrawn", () => {
    expect(findAction("recommendations.transition")).toBeUndefined();
  });
});
