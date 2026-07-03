// Cognito refresh + token-validation helpers.
//
// Login itself is handled by the browser flow in login.ts — it stashes
// access_token + refresh_token into the credentials store. Here we exchange a
// refresh token for a fresh access token with a single Cognito InitiateAuth
// call (REFRESH_TOKEN_AUTH on the secret-less SPA app client) — no SDK needed.

import { COGNITO_CLIENT_ID, COGNITO_USER_POOL_ID, STATIC_JWT_OVERRIDE } from "./config.js";
import {
  StoredCredentials,
  clearCredentials,
  loadCredentials,
  nowEpochSeconds,
  saveCredentials,
} from "./tokenStore.js";

// Cognito user-pool IDs are "<region>_<id>"; the IdP endpoint is regional.
const COGNITO_REGION = COGNITO_USER_POOL_ID.split("_")[0];
const COGNITO_IDP_URL = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;

// Wall-clock cap for the Cognito refresh call. Without it a stalled connection
// would block on undici's ~300s default, hanging every authenticated tool call.
const REFRESH_TIMEOUT_MS = 15_000;

// Cognito JSON-1.1 errors carry a typed `__type` (sometimes namespaced as
// "...#NotAuthorizedException"). Re-throw as an Error whose `.name` is that
// type so isRefreshTokenInvalid() can classify it the same way as before.
class CognitoError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

async function refreshSession(current: StoredCredentials): Promise<StoredCredentials> {
  const res = await fetch(COGNITO_IDP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: current.refreshToken },
    }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });

  const data = (await res.json().catch(() => ({}))) as {
    __type?: string;
    message?: string;
    AuthenticationResult?: { AccessToken?: string; IdToken?: string; ExpiresIn?: number };
  };

  const result = data.AuthenticationResult;
  if (!res.ok || !result?.AccessToken) {
    const name = (data.__type ?? "").split("#").pop() || "CognitoRefreshError";
    throw new CognitoError(name, data.message ?? `Cognito InitiateAuth failed (HTTP ${res.status})`);
  }

  // REFRESH_TOKEN_AUTH does not return a new refresh token; keep the stored one.
  const next: StoredCredentials = {
    email: current.email,
    accessToken: result.AccessToken,
    idToken: result.IdToken ?? current.idToken,
    refreshToken: current.refreshToken,
    expiresAt: nowEpochSeconds() + (result.ExpiresIn ?? 3600),
    savedAt: nowEpochSeconds(),
  };
  saveCredentials(next);
  return next;
}

function isExpired(creds: StoredCredentials): boolean {
  // Refresh ~60s before actual expiry to avoid mid-flight expiry on slow networks.
  return creds.expiresAt - 60 <= nowEpochSeconds();
}

// Errors that mean the refresh token itself is dead (revoked, expired,
// user deleted) — only these justify deleting stored credentials. Anything
// else (network failure, DNS, Cognito 5xx) must keep them so the next call
// can simply retry the refresh.
export function isRefreshTokenInvalid(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  return name === "NotAuthorizedException" || name === "UserNotFoundException";
}

export class AuthError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

// Concurrent tool calls hitting an expired token share one refresh instead
// of each paying a Cognito round-trip (and racing on the credentials file).
// Single-process assumption: a caller joining an inflight refresh gets that
// refresh's result even if the credentials file changed on disk meanwhile
// (e.g. a parallel `npm run login` in another terminal) — the next call
// re-reads the file, so any staleness lasts one call.
let inflightRefresh: Promise<StoredCredentials> | null = null;

function refreshShared(creds: StoredCredentials): Promise<StoredCredentials> {
  if (!inflightRefresh) {
    inflightRefresh = refreshSession(creds).finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

// Returns a fresh access JWT, refreshing transparently when needed.
// Precedence: CLOUDYALI_JWT env override > stored credentials > error.
// `forceRefresh` bypasses the local expiry check — used when the API
// returned 401 despite a locally-valid-looking token (clock skew,
// server-side revocation).
export async function getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  if (STATIC_JWT_OVERRIDE) {
    return STATIC_JWT_OVERRIDE.startsWith("Bearer ")
      ? STATIC_JWT_OVERRIDE.slice("Bearer ".length)
      : STATIC_JWT_OVERRIDE;
  }

  const creds = loadCredentials();
  if (!creds) {
    throw new AuthError(
      "No credentials found.",
      "Call the `login` tool (mcp__cloudyali__login) to sign in via the browser, or set CLOUDYALI_JWT to an access token.",
    );
  }

  if (!opts?.forceRefresh && !isExpired(creds)) return creds.accessToken;

  try {
    const refreshed = await refreshShared(creds);
    return refreshed.accessToken;
  } catch (err) {
    const message = `Token refresh failed: ${err instanceof Error ? err.message : String(err)}`;
    if (isRefreshTokenInvalid(err)) {
      clearCredentials();
      throw new AuthError(
        message,
        "The refresh token is no longer valid; stored credentials have been cleared. Call the `login` tool (mcp__cloudyali__login) to sign in again.",
      );
    }
    throw new AuthError(
      message,
      "Looks like a transient error (network/Cognito); stored credentials were kept. Retry the call, and run the `login` tool only if it keeps failing.",
    );
  }
}

export function currentAuthSummary(): { source: "env" | "file" | "none"; email?: string; expiresAt?: number } {
  if (STATIC_JWT_OVERRIDE) return { source: "env" };
  const creds = loadCredentials();
  if (!creds) return { source: "none" };
  return { source: "file", email: creds.email, expiresAt: creds.expiresAt };
}
