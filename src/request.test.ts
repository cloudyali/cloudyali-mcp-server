import { describe, expect, it } from "vitest";
import { buildQueryString, substitutePath } from "./request.js";
import { Action } from "./catalog.js";

function makeAction(overrides: Partial<Action>): Action {
  return {
    id: "test.action",
    method: "GET",
    path: "/v1/test",
    category: "cost",
    summary: "test",
    description: "test",
    readOnly: true,
    ...overrides,
  };
}

describe("buildQueryString", () => {
  it("returns empty string when no params are supplied", () => {
    expect(buildQueryString(makeAction({}), undefined)).toBe("");
    expect(buildQueryString(makeAction({}), {})).toBe("");
  });

  it("serializes params even when the action declares no queryParams", () => {
    // Regression: previously `!action.queryParams` silently dropped all params,
    // so anomalies.summary date filters were discarded and 90-day defaults
    // were presented as filtered results.
    const qs = buildQueryString(makeAction({}), { startDate: "2026-05-01", endDate: "2026-05-31" });
    expect(qs).toBe("?startDate=2026-05-01&endDate=2026-05-31");
  });

  it("serializes array values as repeated params by default", () => {
    const qs = buildQueryString(makeAction({}), { provider: ["aws", "gcp"] });
    expect(qs).toBe("?provider=aws&provider=gcp");
  });

  it("serializes array values comma-joined when the param declares serializeArray comma", () => {
    // Backend reads assignedUser via queryParams.Get() + strings.Split(",") —
    // repeated params silently drop all but the first user.
    const action = makeAction({
      queryParams: {
        assignedUser: {
          type: "array",
          items: { type: "integer" },
          description: "User IDs.",
          serializeArray: "comma",
        },
      },
    });
    const qs = buildQueryString(action, { assignedUser: [2, 3] });
    expect(qs).toBe("?assignedUser=2%2C3");
  });

  it("skips null and undefined values", () => {
    const qs = buildQueryString(makeAction({}), { a: null, b: undefined, c: 1 });
    expect(qs).toBe("?c=1");
  });

  it("percent-encodes keys and values", () => {
    const qs = buildQueryString(makeAction({}), { "a b": "c&d" });
    expect(qs).toBe("?a+b=c%26d");
  });
});

describe("substitutePath", () => {
  it("substitutes and encodes declared path params", () => {
    const action = makeAction({
      path: "/v1/recommendations/:id",
      pathParams: { id: { type: "integer", description: "ID", required: true } },
    });
    expect(substitutePath(action, { id: 42 })).toBe("/v1/recommendations/42");
  });

  it("throws on a missing required path param", () => {
    const action = makeAction({
      path: "/v1/recommendations/:id",
      pathParams: { id: { type: "integer", description: "ID", required: true } },
    });
    expect(() => substitutePath(action, {})).toThrow(/Missing required path param: id/);
  });
});
