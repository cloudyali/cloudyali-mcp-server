import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "./index.js";
import { RESPONSE_POLICY } from "../shapes.js";
import { project } from "../project.js";

const tool = (n: string) => TOOL_DEFS.find((t) => t.name === n)!;
const shapeFor = (action: string) => {
  const p = RESPONSE_POLICY[action];
  if (p.kind !== "allowlist") throw new Error(`${action} is not allowlisted`);
  return p.shape;
};

describe("the standard tag policy does not carry the tenant key", () => {
  it("drops customer_id, the row id and the audit columns", () => {
    // StandardTag is `{id, customer_id, key, values, status, created_at, updated_at,
    // deleted_at}`. customer_id is the field in the screenshot this whole project
    // started from, so this is the one shape where a regression is not just a leak,
    // it is the same leak.
    const raw = [
      {
        id: 42,
        customer_id: 210,
        key: "env",
        values: ["prod", "staging"],
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
        deleted_at: null,
      },
    ];
    const out = project(raw, shapeFor("tags.standard"));
    expect(out).toEqual([{ key: "env", values: ["prod", "staging"], status: "active" }]);
    expect(JSON.stringify(out)).not.toMatch(/customer_id|210|created_at|deleted_at|\b42\b/);
  });
});

describe("get_tag_health keeps 'the count failed' distinct from 'zero'", () => {
  // The API is explicit that count is NULL when the count query failed and 0 only
  // when it genuinely counted zero — a distinction that exists because the count
  // query HAS failed in production and every mismatch came back as 0 with a 200,
  // which is a clean bill of health that nobody could tell was wrong.
  const t = tool("get_tag_health");

  it("says so when a count is missing, and says it is not zero", () => {
    const out = t.present!(
      {
        mismatched_keys: [
          { standard_key: "env", actual_key: "Environment", count: 12 },
          { standard_key: "env", actual_key: "ENV", count: null },
        ],
        affected_resources: [],
        total_affected: 12,
      },
      {},
    );
    expect(out.text).toMatch(/1 of them came back with no resource count/);
    expect(out.text).toMatch(/NOT zero resources/);
    expect(out.text).toMatch(/Do not report those as clean/);
  });

  it("stays quiet when every count came back", () => {
    const out = t.present!(
      { mismatched_keys: [{ standard_key: "env", actual_key: "Env", count: 0 }], affected_resources: [], total_affected: 0 },
      {},
    );
    expect(out.text).not.toMatch(/no resource count/);
  });

  it("passes a null count through the shape rather than collapsing it to 0", () => {
    const out = project(
      { total_affected: 1, mismatched_keys: [{ standard_key: "env", actual_key: "ENV", count: null }], affected_resources: [] },
      shapeFor("tags.health"),
    ) as { mismatched_keys: Array<{ count: unknown }> };
    expect(out.mismatched_keys[0].count).toBeNull();
  });
});

describe("get_tag_coverage answers the question people actually ask", () => {
  const t = tool("get_tag_coverage");

  it("leads with the level and then the direction", () => {
    // 60% is fine if it was 40% and alarming if it was 80%, so the trend is not
    // decoration — it is the half that tells you whether to act.
    const out = t.present!(
      { total_cost: 1000, tagged_cost: 600, untagged_cost: 400, tagged_percentage: 60, prior_tagged_percentage: 40 },
      {},
    );
    expect(out.text).toMatch(/60\.0% of \$1000\.00/);
    expect(out.text).toMatch(/\$400\.00 does not/);
    expect(out.text).toMatch(/Up 20\.0 points from 40\.0%/);
  });

  it("calls a flat period flat rather than inventing a trend", () => {
    expect(
      t.present!({ total_cost: 100, tagged_percentage: 60.01, prior_tagged_percentage: 60.0 }, {}).text,
    ).toMatch(/Flat against the previous period/);
  });

  it("points at tag health when key count dwarfs the standard set", () => {
    const out = t.present!({ total_cost: 100, tagged_percentage: 50, unique_tag_keys: 40, standard_tag_keys: 4 }, {});
    expect(out.text).toMatch(/spelling drift/);
    expect(out.text).toMatch(/get_tag_health/);
  });

  it("does not throw on a body with nothing in it", () => {
    for (const body of [{}, null, undefined, [], "nope"]) expect(() => t.present!(body, {})).not.toThrow();
  });
});

describe("the tag tools stay read-only and reachable", () => {
  it("maps every tag tool onto a read-only catalog action", () => {
    for (const name of ["get_tag_coverage", "get_cost_by_tag", "get_tag_health", "list_standard_tags"]) {
      const t = tool(name);
      expect(t, name).toBeDefined();
      expect(t.call({}).action, name).toMatch(/^tags\./);
      expect(RESPONSE_POLICY[t.call({}).action], `${name} has no response policy`).toBeDefined();
    }
  });

  it("tells the reader that list_standard_tags is the yardstick for get_tag_health", () => {
    // Reading health without the standard set is how "env is wrong" gets reported
    // for an account that never declared env in the first place.
    expect(tool("get_tag_health").description).toMatch(/standard/i);
    expect(tool("list_standard_tags").description).toMatch(/get_tag_health/);
    expect(tool("list_standard_tags").present!([], {}).text).toMatch(/no yardstick|No standard tags defined/i);
  });
});
