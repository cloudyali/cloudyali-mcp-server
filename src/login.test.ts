import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  assertPortalReachable,
  awaitLogin,
  callbackHtml,
  clearLogin,
  currentLogin,
  formatExpiry,
  loginSuccessMessage,
  readJsonBody,
  startLogin,
  verificationCodeFromState,
} from "./login.js";
import { StoredCredentials, saveCredentials } from "./tokenStore.js";

// awaitLogin opens a browser (spawn) and persists credentials — stub both so the
// tests can drive the real local HTTP callback server without side effects.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const store = vi.hoisted(() => ({
  saveCredentials: vi.fn(),
  nowEpochSeconds: vi.fn(() => 1000),
}));
vi.mock("./tokenStore.js", () => ({
  saveCredentials: store.saveCredentials,
  nowEpochSeconds: store.nowEpochSeconds,
}));

const creds: StoredCredentials = {
  email: "user@example.com",
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: 1767225600, // 2026-01-01T00:00:00Z
  savedAt: 1767222000,
};

function reqFrom(body: string): IncomingMessage {
  const r = new Readable({ read() {} });
  r.push(body);
  r.push(null);
  return r as unknown as IncomingMessage;
}

describe("loginSuccessMessage", () => {
  it("includes the email and the expiry in both UTC and local time", () => {
    const msg = loginSuccessMessage(creds);
    expect(msg).toContain("user@example.com");
    // UTC alone forces the reader to do offset arithmetic to answer "do I need
    // to act soon"; local alone is ambiguous when the transcript is read from
    // somewhere else. Both, with the zone named.
    expect(msg).toMatch(/\bUTC\b/);
    expect(msg).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("collapses the repeated date when UTC and local fall on the same day", () => {
    // 09:10 UTC is 14:40 in Asia/Calcutta — same calendar day, so the date
    // should appear once, not twice.
    const msg = formatExpiry(Math.floor(Date.parse("2026-09-01T09:10:00Z") / 1000));
    expect(msg).toMatch(/UTC \(\d{2}:\d{2} /);
  });

  it("keeps both dates when local time rolls into the next day", () => {
    const msg = formatExpiry(Math.floor(Date.parse("2026-09-01T20:10:00Z") / 1000));
    const dates = msg.match(/\d{2} \w+ 2026/g) ?? [];
    expect(dates.length).toBeGreaterThanOrEqual(1);
  });

  it("degrades to words rather than 'Invalid Date' on a nonsense timestamp", () => {
    expect(formatExpiry(Number.NaN)).toBe("an unknown time");
  });

  it("falls back to a placeholder when email is missing", () => {
    expect(loginSuccessMessage({ ...creds, email: "" })).toContain("(unknown email)");
  });
});

describe("verificationCodeFromState", () => {
  it("derives a stable XXXX-XXXX code from the state value", () => {
    const code = verificationCodeFromState("a".repeat(32));
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(verificationCodeFromState("a".repeat(32))).toBe(code);
  });

  it("differs for different states", () => {
    expect(verificationCodeFromState("a".repeat(32))).not.toBe(verificationCodeFromState("b".repeat(32)));
  });
});

describe("callbackHtml", () => {
  it("renders a minimal page that clears the fragment and posts it to /token", () => {
    const html = callbackHtml();
    expect(html).toContain("CloudYali");
    expect(html).toContain("/token");
    expect(html).toContain("history.replaceState");
    expect(html).toContain("escapeHtml");
  });
});

describe("readJsonBody", () => {
  it("parses a JSON request body", async () => {
    await expect(readJsonBody(reqFrom('{"state":"abc","access_token":"at"}'))).resolves.toEqual({
      state: "abc",
      access_token: "at",
    });
  });

  it("rejects a body over the 64KB cap", async () => {
    const big = JSON.stringify({ x: "a".repeat(70 * 1024) });
    await expect(readJsonBody(reqFrom(big))).rejects.toThrow(/too large/);
  });

  it("rejects invalid JSON", async () => {
    await expect(readJsonBody(reqFrom("not json"))).rejects.toThrow();
  });
});

describe("assertPortalReachable", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("resolves when the portal responds (2xx/4xx are fine)", async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;
    await expect(assertPortalReachable()).resolves.toBeUndefined();
  });

  it("throws when the portal returns 5xx", async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 503 }) as unknown as typeof fetch;
    await expect(assertPortalReachable()).rejects.toThrow(/HTTP 503/);
  });

  it("throws when the portal is unreachable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    await expect(assertPortalReachable()).rejects.toThrow(/unreachable/);
  });
});

describe("awaitLogin (browser callback server)", () => {
  const spawnMock = vi.mocked(spawn);
  const savedCredentials = vi.mocked(saveCredentials);
  // The un-mocked fetch: used to POST to the real local callback server.
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() } as unknown as ChildProcess);
    savedCredentials.mockReset();
    store.nowEpochSeconds.mockReturnValue(1000);
    // assertPortalReachable() must pass so awaitLogin proceeds to bind the server.
    global.fetch = vi.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;
    // startLogin is idempotent by design — a pending session is returned rather
    // than starting a second listener. Good for the tool, bad for test isolation.
    clearLogin();
  });
  afterEach(() => {
    global.fetch = realFetch;
    clearLogin();
  });

  async function waitFor<T>(fn: () => T | undefined, tries = 400): Promise<T> {
    for (let i = 0; i < tries; i++) {
      const v = fn();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("waitFor: condition not met in time");
  }

  // The portal URL passed to openBrowser embeds our local redirect_uri + state.
  function spawnedUrl(): string | undefined {
    for (const call of spawnMock.mock.calls) {
      const args = call[1] as string[] | undefined;
      const url = args?.find((a) => typeof a === "string" && a.startsWith("http"));
      if (url) return url;
    }
    return undefined;
  }

  async function beginLogin(opts?: { signal?: AbortSignal; timeoutMs?: number }) {
    const promise = awaitLogin(opts?.timeoutMs ?? 4000, opts?.signal);
    // Swallow the eventual rejection in tests that don't await it directly.
    promise.catch(() => {});
    const url = await waitFor(spawnedUrl);
    const u = new URL(url);
    const redirect = new URL(u.searchParams.get("redirect_uri") as string);
    return { promise, state: u.searchParams.get("state") as string, port: Number(redirect.port) };
  }

  function postToken(port: number, body: Record<string, string>): Promise<Response> {
    return realFetch(`http://127.0.0.1:${port}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects a state mismatch as possible CSRF and does not save credentials", async () => {
    const { promise, port } = await beginLogin();
    const res = await postToken(port, { state: "not-the-expected-state", access_token: "a", refresh_token: "r" });
    expect(res.status).toBe(400);
    await expect(promise).rejects.toThrow(/CSRF/i);
    expect(savedCredentials).not.toHaveBeenCalled();
  });

  it("saves credentials and resolves on a valid callback", async () => {
    const { promise, state, port } = await beginLogin();
    await postToken(port, {
      state,
      access_token: "at",
      refresh_token: "rt",
      email: "user@example.com",
      expires_at: "2000",
    });
    const creds = await promise;
    expect(creds.accessToken).toBe("at");
    expect(creds.refreshToken).toBe("rt");
    expect(creds.expiresAt).toBe(2000);
    expect(savedCredentials).toHaveBeenCalledOnce();
  });

  it("falls back to now+3600 when expires_at is missing or unparseable", async () => {
    const { promise, state, port } = await beginLogin();
    await postToken(port, { state, access_token: "at", refresh_token: "rt", expires_at: "garbage" });
    const creds = await promise;
    expect(creds.expiresAt).toBe(1000 + 3600);
  });

  it("rejects as cancelled when the browser reports access_denied", async () => {
    const { promise, state, port } = await beginLogin();
    await postToken(port, { state, error: "access_denied" });
    await expect(promise).rejects.toThrow(/cancelled/i);
  });

  it("rejects a callback missing the tokens with a 400", async () => {
    const { promise, state, port } = await beginLogin();
    const res = await postToken(port, { state });
    expect(res.status).toBe(400);
    await expect(promise).rejects.toThrow(/access_token|refresh_token/);
  });

  it("rejects when the caller aborts the login", async () => {
    const controller = new AbortController();
    const { promise } = await beginLogin({ signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/i);
  });

  it("rejects with a pre-aborted signal without opening a browser", async () => {
    await expect(awaitLogin(4000, AbortSignal.abort())).rejects.toThrow(/aborted/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("times out when no callback arrives", async () => {
    const { promise } = await beginLogin({ timeoutMs: 80 });
    await expect(promise).rejects.toThrow(/Timed out/i);
  });
});

describe("startLogin: the two-phase session machine", () => {
  const spawnMock = vi.mocked(spawn);
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() } as unknown as ChildProcess);
    store.nowEpochSeconds.mockReturnValue(1000);
    global.fetch = vi.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;
    clearLogin();
  });
  afterEach(() => {
    global.fetch = realFetch;
    clearLogin();
  });

  function spawnedUrl(): string | undefined {
    for (const call of spawnMock.mock.calls) {
      const args = call[1] as string[] | undefined;
      const url = args?.find((a) => typeof a === "string" && a.startsWith("http"));
      if (url) return url;
    }
    return undefined;
  }

  function post(port: number, body: Record<string, string>): Promise<Response> {
    return realFetch(`http://127.0.0.1:${port}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (currentLogin()?.status !== "pending") return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("returns before the user has done anything — that is the whole point", async () => {
    const t0 = Date.now();
    const session = await startLogin(60_000);
    // A blocking call returned only after authorization, which put the
    // verification code on the wrong side of the decision it exists to inform.
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(session.status).toBe("pending");
    expect(session.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(session.portalUrl).toContain("/cli-login");
  });

  it("shows the user the same code the portal will display", async () => {
    // The check is worthless if the two are derived independently. Both come
    // from the state value, so a rogue process cannot produce a matching pair.
    const session = await startLogin(60_000);
    const url = new URL(session.portalUrl);
    const state = url.searchParams.get("state") as string;
    expect(session.code).toBe(verificationCodeFromState(state));
    expect(url.searchParams.get("code")).toBe(session.code);
  });

  it("binds the callback listener to loopback only", async () => {
    const session = await startLogin(60_000);
    const redirect = new URL(new URL(session.portalUrl).searchParams.get("redirect_uri") as string);
    expect(redirect.hostname).toBe("127.0.0.1");
  });

  it("is idempotent: a second call joins the pending session rather than opening another browser tab", async () => {
    const a = await startLogin(60_000);
    const b = await startLogin(60_000);
    expect(b).toBe(a);
    expect(b.code).toBe(a.code);
    // One browser open, not two.
    expect(spawnMock.mock.calls.length).toBe(1);
  });

  it("moves to done and exposes the credentials once the browser posts back", async () => {
    const session = await startLogin(60_000);
    const port = Number(new URL(new URL(session.portalUrl).searchParams.get("redirect_uri") as string).port);
    const state = new URL(session.portalUrl).searchParams.get("state") as string;

    const res = await post(port, {
      state,
      access_token: "at",
      refresh_token: "rt",
      email: "user@example.com",
      expires_at: "1767225600",
    });
    expect(res.status).toBe(200);
    await settle();

    const after = currentLogin();
    expect(after?.status).toBe("done");
    expect(after?.credentials?.email).toBe("user@example.com");
  });

  it("moves to failed on a state mismatch, and keeps the reason", async () => {
    const session = await startLogin(60_000);
    const port = Number(new URL(new URL(session.portalUrl).searchParams.get("redirect_uri") as string).port);

    await post(port, { state: "wrong", access_token: "a", refresh_token: "r" });
    await settle();

    const after = currentLogin();
    expect(after?.status).toBe("failed");
    expect(after?.error?.message).toMatch(/CSRF/i);
  });

  it("moves to failed when the user cancels in the browser", async () => {
    const session = await startLogin(60_000);
    const port = Number(new URL(new URL(session.portalUrl).searchParams.get("redirect_uri") as string).port);
    const state = new URL(session.portalUrl).searchParams.get("state") as string;

    await post(port, { state, error: "access_denied" });
    await settle();

    expect(currentLogin()?.status).toBe("failed");
    expect(currentLogin()?.error?.message).toMatch(/cancelled/i);
  });

  it("expires a stale pending session on read instead of waiting forever", async () => {
    // A session nobody finished must not block a later attempt.
    await startLogin(20);
    await new Promise((r) => setTimeout(r, 40));
    const after = currentLogin();
    expect(after?.status).toBe("failed");
    expect(after?.error?.message).toMatch(/timed out/i);
  });

  it("starts a fresh session after the previous one is cleared", async () => {
    const first = await startLogin(60_000);
    clearLogin();
    expect(currentLogin()).toBeNull();
    const second = await startLogin(60_000);
    expect(second.code).not.toBe(first.code);
    expect(spawnMock.mock.calls.length).toBe(2);
  });

  it("refuses to start when the portal is unreachable, before opening a tab", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    await expect(startLogin(60_000)).rejects.toThrow(/unreachable/);
    expect(spawnedUrl()).toBeUndefined();
    expect(currentLogin()).toBeNull();
  });

  it("aborts cleanly when the caller cancels", async () => {
    const ac = new AbortController();
    const session = await startLogin(60_000, ac.signal);
    ac.abort();
    await settle();
    expect(session.status).toBe("failed");
    expect(session.error?.message).toMatch(/aborted/i);
  });
});
