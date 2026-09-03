import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./login.js", async () => {
  const actual = await vi.importActual<typeof import("./login.js")>("./login.js");
  return { ...actual, startLogin: vi.fn(), currentLogin: vi.fn(), clearLogin: vi.fn() };
});

vi.mock("./execute.js", async () => {
  const actual = await vi.importActual<typeof import("./execute.js")>("./execute.js");
  return { ...actual, executeAction: vi.fn(), executeActionRaw: vi.fn() };
});

import { ADVANCED_ENABLED, TOOLS, handleToolCall } from "./handlers.js";
import { TOOL_DEFS } from "./tools/index.js";
import { executeAction, executeActionRaw } from "./execute.js";
import { clearLogin, currentLogin, startLogin } from "./login.js";
import { AuthError } from "./auth.js";

const mockExecute = vi.mocked(executeAction);
const mockExecuteRaw = vi.mocked(executeActionRaw);
const mockStart = vi.mocked(startLogin);
const mockCurrent = vi.mocked(currentLogin);
const mockClear = vi.mocked(clearLogin);

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

  it("names this server as the culprit when the failure is ours, without a stack trace", async () => {
    // "Error: upstream exploded" was the whole message here. It reads like the
    // API misbehaved, which sends the reader to check CloudYali's status page
    // over a bug on this side.
    mockExecuteRaw.mockRejectedValue(new Error("upstream exploded"));
    const res = await handleToolCall("list_budgets", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("list_budgets");
    expect(textOf(res)).toMatch(/bug in this server/);
    expect(textOf(res)).toMatch(/upstream exploded/);
    expect(textOf(res)).not.toMatch(/\.ts:\d+/);
  });

  it("tells a network failure apart from a bug, and names the URL it could not reach", async () => {
    // Undici reports DNS failure, refused connections and TLS faults all as
    // `TypeError: fetch failed`; the part that differs is on `cause`.
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code: "ENOTFOUND" };
    mockExecuteRaw.mockRejectedValue(err);
    const res = await handleToolCall("list_budgets", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/did not resolve/);
    expect(textOf(res)).toMatch(/https:\/\/\S+/);
    expect(textOf(res)).not.toMatch(/bug in this server/);
  });
});

describe("login is two-phase, so the verification code reaches the user first", () => {
  const session = {
    code: "9E44-1E86",
    portalUrl: "https://console.example.com/cli-login?state=abc&code=9E44-1E86",
    startedAt: 0,
    expiresAt: Date.now() + 60_000,
    status: "pending" as const,
    done: Promise.resolve({} as never),
    cancel: () => {},
  };

  beforeEach(() => {
    mockStart.mockReset();
    mockCurrent.mockReset();
    mockClear.mockReset();
  });

  it("returns the code on the first call, before the user is asked to trust the page", async () => {
    // This is the whole point of the change. The code defends against a rogue
    // local process opening the browser with its own redirect_uri; it only
    // works if the user can compare before clicking Authorize. A blocking call
    // returned after that decision, and stderr is a log file under an MCP
    // client, not something anyone reads.
    mockCurrent.mockReturnValue(null);
    mockStart.mockResolvedValue({ ...session, done: new Promise(() => {}) } as never);

    const res = await handleToolCall("login", {});
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("9E44-1E86");
    expect(textOf(res)).toMatch(/before clicking Authorize/i);
    expect(textOf(res)).toContain(session.portalUrl);
  });

  it("tells the user what a code mismatch means", async () => {
    mockCurrent.mockReturnValue(null);
    mockStart.mockResolvedValue({ ...session, done: new Promise(() => {}) } as never);
    expect(textOf(await handleToolCall("login", {}))).toMatch(/did not come from this tool/i);
  });

  it("repeats the code while still waiting, instead of leaving the user guessing", async () => {
    mockCurrent.mockReturnValue({ ...session, done: new Promise(() => {}) } as never);
    const res = await handleToolCall("login", {});
    expect(textOf(res)).toContain("9E44-1E86");
    expect(textOf(res)).toMatch(/Still waiting/i);
  });

  it("reports success once the browser flow completes", async () => {
    mockCurrent.mockReturnValue({
      ...session,
      status: "done",
      credentials: { email: "user@example.com", accessToken: "a", refreshToken: "r", expiresAt: 1767225600, savedAt: 0 },
    } as never);
    const res = await handleToolCall("login", {});
    expect(textOf(res)).toContain("user@example.com");
    expect(textOf(res)).toMatch(/\bUTC\b/);
    expect(mockClear).toHaveBeenCalled();
  });

  it("surfaces a failure and invites a retry rather than dead-ending", async () => {
    mockCurrent.mockReturnValue({ ...session, status: "failed", error: new Error("state mismatch") } as never);
    const res = await handleToolCall("login", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/state mismatch/);
    expect(textOf(res)).toMatch(/Call login again/i);
  });

  it("reports a failure that lands during the poll window", async () => {
    // The session can settle to failed *while* the second call is waiting out
    // its short grace period. That branch must clear and report, not fall
    // through to "still waiting" and leave the user polling a dead session.
    let reject: (e: Error) => void = () => {};
    const done = new Promise<never>((_, r) => {
      reject = r;
    });
    done.catch(() => {});
    const live = { ...session, done } as Record<string, unknown>;
    mockCurrent.mockImplementation(() => live as never);
    setTimeout(() => {
      live.status = "failed";
      live.error = new Error("Login cancelled by the user in the browser.");
      reject(live.error as Error);
    }, 20);

    const res = await handleToolCall("login", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/cancelled by the user/i);
    expect(mockClear).toHaveBeenCalled();
  });

  it("explains an unreachable portal instead of surfacing a raw fetch error", async () => {
    mockCurrent.mockReturnValue(null);
    mockStart.mockRejectedValue(new Error("Portal at https://console.example.com is unreachable."));
    const res = await handleToolCall("login", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Could not start sign-in/);
    expect(textOf(res)).toMatch(/unreachable/);
  });

  it("does not block for minutes waiting on the browser", async () => {
    mockCurrent.mockReturnValue(null);
    mockStart.mockResolvedValue({ ...session, done: new Promise(() => {}) } as never);
    const t0 = Date.now();
    await handleToolCall("login", {});
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
