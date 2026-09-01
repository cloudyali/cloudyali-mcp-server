import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADVANCED_ENABLED is read once at module load, so the flag can only be
// exercised by importing a fresh copy of the module with the env already set.
//
// Worth its own file because the default-off assertion in handlers.test.ts is
// only half the contract. If someone renamed the variable, the escape hatch
// would be permanently unreachable and every existing test would still pass —
// they all assert the tools are *absent*.

async function loadWithAdvanced(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env.CLOUDYALI_MCP_ADVANCED;
  else process.env.CLOUDYALI_MCP_ADVANCED = value;

  vi.doMock("./execute.js", async () => {
    const actual = await vi.importActual<typeof import("./execute.js")>("./execute.js");
    return {
      ...actual,
      executeAction: vi.fn(async () => JSON.stringify({ ok: true, body: {} })),
      executeActionRaw: vi.fn(async () => ({
        request: { action_id: "x", method: "GET", path: "/v1/x" },
        status: 200,
        ok: true,
        body: {},
      })),
    };
  });

  return import("./handlers.js");
}

function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  const first = res.content?.[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
}

describe("CLOUDYALI_MCP_ADVANCED=1 restores the raw catalog interface", () => {
  const original = process.env.CLOUDYALI_MCP_ADVANCED;

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CLOUDYALI_MCP_ADVANCED;
    else process.env.CLOUDYALI_MCP_ADVANCED = original;
    vi.doUnmock("./execute.js");
    vi.resetModules();
  });

  it("advertises the proxy tools alongside the typed ones", async () => {
    const { TOOLS, ADVANCED_ENABLED } = await loadWithAdvanced("1");
    expect(ADVANCED_ENABLED).toBe(true);
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("search_actions");
    expect(names).toContain("execute_action");
    expect(names).toContain("list_categories");
    // The typed surface is not replaced by turning the hatch on.
    expect(names).toContain("list_budgets");
  });

  it("actually serves search_actions rather than refusing it", async () => {
    const { handleToolCall } = await loadWithAdvanced("1");
    const res = await handleToolCall("search_actions", { query: "inventory" });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(textOf(res));
    expect(body.count).toBeGreaterThan(0);
    expect(JSON.stringify(body.results)).toContain("inventory");
  });

  it("clamps the search limit, so a negative value cannot dump the catalog", async () => {
    // The mirror had this fix and the monorepo had regressed it: a raw negative
    // limit inverts searchActions' slice and returns nearly everything.
    const { handleToolCall } = await loadWithAdvanced("1");
    const res = await handleToolCall("search_actions", { query: "cost", limit: -5 });
    const body = JSON.parse(textOf(res));
    expect(body.count).toBeGreaterThan(0);
    expect(body.count).toBeLessThanOrEqual(100);
  });

  it("serves list_categories without leaking the signed-in email", async () => {
    // An orientation call should not put the user's address into model context.
    const { handleToolCall } = await loadWithAdvanced("1");
    const res = await handleToolCall("list_categories", {});
    const body = JSON.parse(textOf(res));
    expect(body.total).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/@/);
  });

  it("still refuses the proxy when the flag is any other value", async () => {
    for (const value of ["0", "true", "yes", ""]) {
      const { ADVANCED_ENABLED, TOOLS } = await loadWithAdvanced(value);
      expect(ADVANCED_ENABLED, `value ${JSON.stringify(value)}`).toBe(false);
      expect(TOOLS.map((t) => t.name), `value ${JSON.stringify(value)}`).not.toContain("execute_action");
    }
  });

  it("refuses the proxy when the flag is unset", async () => {
    const { ADVANCED_ENABLED, handleToolCall } = await loadWithAdvanced(undefined);
    expect(ADVANCED_ENABLED).toBe(false);
    const res = await handleToolCall("execute_action", { id: "budgets.list" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not enabled/);
  });
});
