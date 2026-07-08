import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./execute.js", () => ({ executeAction: vi.fn() }));
vi.mock("./login.js", () => ({
  awaitLogin: vi.fn(),
  loginSuccessMessage: vi.fn(() => "Logged in as user@example.com."),
}));

import { executeAction } from "./execute.js";
import { awaitLogin } from "./login.js";
import { AuthError } from "./auth.js";
import { READ_ONLY_CATALOG } from "./catalog.js";
import { TOOLS, handleToolCall } from "./handlers.js";

const mockExecute = vi.mocked(executeAction);
const mockLogin = vi.mocked(awaitLogin);

function textOf(result: Awaited<ReturnType<typeof handleToolCall>>): string {
  const first = result.content?.[0];
  return first && first.type === "text" ? first.text : "";
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TOOLS", () => {
  it("exposes exactly the four tools, in order", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "search_actions",
      "execute_action",
      "list_categories",
      "login",
    ]);
  });

  it("marks execute_action read-only and login open-world", () => {
    expect(TOOLS.find((t) => t.name === "execute_action")?.annotations?.readOnlyHint).toBe(true);
    expect(TOOLS.find((t) => t.name === "login")?.annotations?.openWorldHint).toBe(true);
  });

  it("annotates every tool with a readOnlyHint", () => {
    for (const t of TOOLS) {
      expect(typeof t.annotations?.readOnlyHint, `${t.name} readOnlyHint`).toBe("boolean");
    }
  });

  it("marks the two pure local reads as read-only and non-network", () => {
    for (const name of ["search_actions", "list_categories"]) {
      const a = TOOLS.find((t) => t.name === name)?.annotations;
      expect(a?.readOnlyHint, `${name} readOnlyHint`).toBe(true);
      expect(a?.openWorldHint, `${name} openWorldHint`).toBe(false);
    }
  });
});

describe("handleToolCall: search_actions", () => {
  it("returns matching actions with a count", async () => {
    const res = await handleToolCall("search_actions", { query: "inventory" });
    const body = JSON.parse(textOf(res));
    expect(body.count).toBeGreaterThan(0);
    expect(body.results.every((r: { id?: string }) => !!r.id)).toBe(true);
  });

  it("defaults the limit to 10 when it is not a number", async () => {
    const res = await handleToolCall("search_actions", { query: "cost", limit: "nope" });
    expect(JSON.parse(textOf(res)).count).toBeLessThanOrEqual(10);
  });

  it("clamps a negative limit to one result instead of inverting the slice", async () => {
    // 'cost' matches multiple actions; a raw negative limit would slice from the
    // end and return nearly all of them. Clamp must floor it to a single result.
    const res = await handleToolCall("search_actions", { query: "cost", limit: -1 });
    expect(JSON.parse(textOf(res)).count).toBe(1);
  });
});

describe("handleToolCall: list_categories", () => {
  it("returns per-category counts and the catalog total", async () => {
    const body = JSON.parse(textOf(await handleToolCall("list_categories", {})));
    expect(body.total).toBe(READ_ONLY_CATALOG.length);
    expect(body.by_category.inventory).toBeGreaterThan(0);
    expect(body.base_url).toContain("http");
    expect(body.mode).toBe("read-only");
  });
});

describe("handleToolCall: execute_action", () => {
  it("passes parsed args to executeAction and returns its text", async () => {
    mockExecute.mockResolvedValue('{"ok":true}');
    const res = await handleToolCall("execute_action", { id: "cost.spend", body: { x: 1 } });
    expect(mockExecute).toHaveBeenCalledWith({
      id: "cost.spend",
      path_params: undefined,
      query_params: undefined,
      body: { x: 1 },
    });
    expect(textOf(res)).toBe('{"ok":true}');
  });

  it("surfaces an AuthError with its hint as an error result", async () => {
    mockExecute.mockRejectedValue(new AuthError("No credentials found.", "Run login."));
    const res = await handleToolCall("execute_action", { id: "cost.spend" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("No credentials found.");
    expect(textOf(res)).toContain("Hint: Run login.");
  });

  it("surfaces a generic error", async () => {
    mockExecute.mockRejectedValue(new Error("boom"));
    const res = await handleToolCall("execute_action", { id: "cost.spend" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Error: boom");
  });
});

describe("handleToolCall: login", () => {
  it("returns a success message on login", async () => {
    mockLogin.mockResolvedValue({
      email: "user@example.com",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1,
      savedAt: 1,
    });
    const res = await handleToolCall("login", {});
    expect(textOf(res)).toContain("Logged in as user@example.com.");
    expect(textOf(res)).toContain("Retry");
  });

  it("returns an error result when login fails", async () => {
    mockLogin.mockRejectedValue(new Error("timed out"));
    const res = await handleToolCall("login", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Login failed: timed out");
  });
});

describe("handleToolCall: unknown tool", () => {
  it("returns an error for an unrecognized tool name", async () => {
    const res = await handleToolCall("nope", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Unknown tool: nope");
  });
});
