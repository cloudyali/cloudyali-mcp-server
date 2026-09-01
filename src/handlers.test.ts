import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./execute.js", async () => {
  const actual = await vi.importActual<typeof import("./execute.js")>("./execute.js");
  return { ...actual, executeAction: vi.fn(), executeActionRaw: vi.fn() };
});

import { ADVANCED_ENABLED, TOOLS, handleToolCall } from "./handlers.js";
import { TOOL_DEFS } from "./tools/index.js";
import { executeAction, executeActionRaw } from "./execute.js";
import { AuthError } from "./auth.js";

const mockExecute = vi.mocked(executeAction);
const mockExecuteRaw = vi.mocked(executeActionRaw);

function textOf(res: Awaited<ReturnType<typeof handleToolCall>>): string {
  const first = res.content?.[0];
  return first && first.type === "text" ? first.text : "";
}

describe("the advertised tool surface", () => {
  it("advertises every typed tool plus login", () => {
    const names = TOOLS.map((t) => t.name);
    for (const def of TOOL_DEFS) expect(names, `${def.name} missing`).toContain(def.name);
    expect(names).toContain("login");
  });

  it("hides the raw catalog proxy unless CLOUDYALI_MCP_ADVANCED is set", () => {
    // The default matters: search_actions/execute_action make the model do a
    // lookup before it can work, and carry no per-argument validation. They are
    // a fallback for actions no typed tool wraps, not the product.
    const names = TOOLS.map((t) => t.name);
    if (ADVANCED_ENABLED) {
      expect(names).toContain("execute_action");
    } else {
      expect(names).not.toContain("execute_action");
      expect(names).not.toContain("search_actions");
      expect(names).not.toContain("list_categories");
    }
  });

  it("marks login as the only open-world tool", () => {
    for (const t of TOOLS) {
      if (t.name === "login") {
        expect(t.annotations?.openWorldHint).toBe(true);
      } else {
        expect(t.annotations?.readOnlyHint, `${t.name} readOnlyHint`).toBe(true);
      }
    }
  });

  it("gives every advertised tool a description and an object input schema", () => {
    for (const t of TOOLS) {
      expect(t.description, `${t.name} description`).toBeTruthy();
      expect(t.inputSchema?.type, `${t.name} inputSchema`).toBe("object");
    }
  });
});

describe("dispatch", () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecuteRaw.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("routes a typed tool through executeActionRaw", async () => {
    mockExecuteRaw.mockResolvedValue({
      request: { action_id: "budgets.list", method: "GET", path: "/v1/budgets" },
      status: 200,
      ok: true,
      body: [{ name: "Platform", amount: 100 }],
    });
    const res = await handleToolCall("list_budgets", {});
    expect(mockExecuteRaw).toHaveBeenCalledOnce();
    expect(mockExecuteRaw.mock.calls[0][0].id).toBe("budgets.list");
    expect(res.structuredContent).toBeDefined();
  });

  it("returns a specific, actionable message for a bad argument", async () => {
    const res = await handleToolCall("get_budget", { id: "seven" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Invalid value for "id": expected a number/);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("rejects an invented argument instead of silently ignoring it", async () => {
    const res = await handleToolCall("list_budgets", { customer_id: 211 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Unknown argument "customer_id"/);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it("refuses a proxy tool by name when advanced mode is off, even if a client cached the old list", async () => {
    if (ADVANCED_ENABLED) return;
    for (const name of ["search_actions", "execute_action", "list_categories"]) {
      const res = await handleToolCall(name, { query: "cost" });
      expect(res.isError, name).toBe(true);
      expect(textOf(res), name).toMatch(/not enabled/);
      expect(textOf(res), name).toMatch(/CLOUDYALI_MCP_ADVANCED=1/);
    }
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("reports an unknown tool by name", async () => {
    const res = await handleToolCall("no_such_tool", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Unknown tool: no_such_tool/);
  });

  it("surfaces an AuthError with its hint so the model knows to call login", async () => {
    mockExecuteRaw.mockRejectedValue(new AuthError("No credentials found.", "Call the `login` tool."));
    const res = await handleToolCall("list_budgets", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/No credentials found/);
    expect(textOf(res)).toMatch(/Hint: Call the `login` tool./);
  });

  it("surfaces a generic failure without a stack trace", async () => {
    mockExecuteRaw.mockRejectedValue(new Error("upstream exploded"));
    const res = await handleToolCall("list_budgets", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Error: upstream exploded");
    expect(textOf(res)).not.toMatch(/\.ts:\d+/);
  });
});
