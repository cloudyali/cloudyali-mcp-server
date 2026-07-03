import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRefreshTokenInvalid } from "./auth.js";

const h = vi.hoisted(() => ({
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  clearCredentials: vi.fn(),
}));

vi.mock("./tokenStore.js", () => ({
  loadCredentials: h.loadCredentials,
  saveCredentials: h.saveCredentials,
  clearCredentials: h.clearCredentials,
  nowEpochSeconds: () => 1000,
}));

type Creds = {
  email: string;
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresAt: number;
  savedAt: number;
};

function makeCreds(over: Partial<Creds> = {}): Creds {
  return {
    email: "user@example.com",
    accessToken: "stored-at",
    idToken: "id",
    refreshToken: "rt",
    expiresAt: 5000,
    savedAt: 1,
    ...over,
  };
}

// Cognito InitiateAuth response shapes.
function authOk(body: object): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function authErr(status: number, body: object): Response {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

// config.ts reads CLOUDYALI_JWT at import time, so re-import auth after setting
// the env to exercise the STATIC_JWT_OVERRIDE branch.
async function loadAuth(jwt?: string) {
  vi.resetModules();
  if (jwt === undefined) delete process.env.CLOUDYALI_JWT;
  else process.env.CLOUDYALI_JWT = jwt;
  return import("./auth.js");
}

const ORIGINAL_JWT = process.env.CLOUDYALI_JWT;
const REAL_FETCH = global.fetch;

beforeEach(() => {
  h.loadCredentials.mockReset();
  h.saveCredentials.mockReset();
  h.clearCredentials.mockReset();
});

afterEach(() => {
  if (ORIGINAL_JWT === undefined) delete process.env.CLOUDYALI_JWT;
  else process.env.CLOUDYALI_JWT = ORIGINAL_JWT;
  global.fetch = REAL_FETCH;
});

describe("isRefreshTokenInvalid", () => {
  it("returns true for Cognito NotAuthorizedException (revoked/expired refresh token)", () => {
    const err = Object.assign(new Error("Refresh Token has been revoked"), {
      name: "NotAuthorizedException",
    });
    expect(isRefreshTokenInvalid(err)).toBe(true);
  });

  it("returns true for UserNotFoundException (user deleted)", () => {
    const err = Object.assign(new Error("User does not exist."), {
      name: "UserNotFoundException",
    });
    expect(isRefreshTokenInvalid(err)).toBe(true);
  });

  it("returns false for transient network errors (credentials must be kept)", () => {
    expect(isRefreshTokenInvalid(new TypeError("fetch failed"))).toBe(false);
    expect(isRefreshTokenInvalid(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }))).toBe(false);
    expect(isRefreshTokenInvalid(undefined)).toBe(false);
  });
});

describe("getValidAccessToken: CLOUDYALI_JWT override", () => {
  it("returns the token verbatim and never reads the credentials file", async () => {
    const { getValidAccessToken } = await loadAuth("raw-token");
    expect(await getValidAccessToken()).toBe("raw-token");
    expect(h.loadCredentials).not.toHaveBeenCalled();
  });

  it("strips a leading 'Bearer ' prefix", async () => {
    const { getValidAccessToken } = await loadAuth("Bearer raw-token");
    expect(await getValidAccessToken()).toBe("raw-token");
  });
});

describe("getValidAccessToken: stored credentials", () => {
  it("throws an AuthError when no credentials are stored", async () => {
    h.loadCredentials.mockReturnValue(null);
    const { getValidAccessToken, AuthError } = await loadAuth();
    await expect(getValidAccessToken()).rejects.toBeInstanceOf(AuthError);
  });

  it("returns the stored token without refreshing when it is still valid", async () => {
    h.loadCredentials.mockReturnValue(makeCreds({ expiresAt: 5000 }));
    global.fetch = vi.fn() as unknown as typeof fetch;
    const { getValidAccessToken } = await loadAuth();
    expect(await getValidAccessToken()).toBe("stored-at");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refreshes an expired token via Cognito InitiateAuth and returns the new one", async () => {
    h.loadCredentials.mockReturnValue(makeCreds({ expiresAt: 1000 }));
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        authOk({ AuthenticationResult: { AccessToken: "fresh-at", IdToken: "fresh-id", ExpiresIn: 3600 } }),
      ) as unknown as typeof fetch;
    const { getValidAccessToken } = await loadAuth();
    expect(await getValidAccessToken()).toBe("fresh-at");
    expect(h.saveCredentials).toHaveBeenCalled();
  });

  it("forceRefresh bypasses the local expiry check", async () => {
    h.loadCredentials.mockReturnValue(makeCreds({ expiresAt: 5000 }));
    global.fetch = vi
      .fn()
      .mockResolvedValue(authOk({ AuthenticationResult: { AccessToken: "forced", ExpiresIn: 3600 } })) as unknown as typeof fetch;
    const { getValidAccessToken } = await loadAuth();
    expect(await getValidAccessToken({ forceRefresh: true })).toBe("forced");
  });

  it("clears credentials and throws when the refresh token is invalid", async () => {
    h.loadCredentials.mockReturnValue(makeCreds({ expiresAt: 1000 }));
    global.fetch = vi
      .fn()
      .mockResolvedValue(authErr(400, { __type: "NotAuthorizedException", message: "revoked" })) as unknown as typeof fetch;
    const { getValidAccessToken, AuthError } = await loadAuth();
    await expect(getValidAccessToken()).rejects.toBeInstanceOf(AuthError);
    expect(h.clearCredentials).toHaveBeenCalled();
  });

  it("keeps credentials on a transient refresh failure", async () => {
    h.loadCredentials.mockReturnValue(makeCreds({ expiresAt: 1000 }));
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;
    const { getValidAccessToken, AuthError } = await loadAuth();
    await expect(getValidAccessToken()).rejects.toBeInstanceOf(AuthError);
    expect(h.clearCredentials).not.toHaveBeenCalled();
  });

  it("bounds the Cognito refresh call with an abort signal (no unbounded hang)", async () => {
    // Every other network call in the server is time-bounded; the refresh call
    // that gates every authenticated request must be too, or a stalled Cognito
    // connection blocks the tool call for undici's ~5-minute default.
    h.loadCredentials.mockReturnValue(makeCreds({ expiresAt: 1000 }));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(authOk({ AuthenticationResult: { AccessToken: "fresh", ExpiresIn: 3600 } }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { getValidAccessToken } = await loadAuth();
    await getValidAccessToken();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("shares a single refresh across concurrent callers", async () => {
    h.loadCredentials.mockReturnValue(makeCreds({ expiresAt: 1000 }));
    let calls = 0;
    global.fetch = vi.fn(() => {
      calls += 1;
      return new Promise((r) =>
        setTimeout(() => r(authOk({ AuthenticationResult: { AccessToken: "shared", ExpiresIn: 3600 } })), 5),
      );
    }) as unknown as typeof fetch;
    const { getValidAccessToken } = await loadAuth();
    const [a, b] = await Promise.all([getValidAccessToken(), getValidAccessToken()]);
    expect(a).toBe("shared");
    expect(b).toBe("shared");
    expect(calls).toBe(1);
  });
});

describe("currentAuthSummary", () => {
  it("reports the env source when CLOUDYALI_JWT is set", async () => {
    const { currentAuthSummary } = await loadAuth("token");
    expect(currentAuthSummary()).toEqual({ source: "env" });
  });

  it("reports none when there are no credentials", async () => {
    h.loadCredentials.mockReturnValue(null);
    const { currentAuthSummary } = await loadAuth();
    expect(currentAuthSummary()).toEqual({ source: "none" });
  });

  it("reports the file source with email and expiry", async () => {
    h.loadCredentials.mockReturnValue(makeCreds({ expiresAt: 5000 }));
    const { currentAuthSummary } = await loadAuth();
    expect(currentAuthSummary()).toEqual({
      source: "file",
      email: "user@example.com",
      expiresAt: 5000,
    });
  });
});
