import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const COGNITO_USER_POOL_ID =
  process.env.COGNITO_USER_POOL_ID ?? "us-east-1_jofjWVzZ0";
export const COGNITO_CLIENT_ID =
  process.env.COGNITO_CLIENT_ID ?? "5seseo1otbep85p9mf6f73am6j";

// Base URL of the CloudYali API this server wraps.
export const CLOUDYALI_API_URL = (
  process.env.CLOUDYALI_API_URL ?? "https://api.cloudyali.io"
).replace(/\/+$/, "");

// Public web console — also serves the /cli-login page used by the browser
// login flow, and is referenced in user-facing messages that point at the UI
// for state changes.
export const CONSOLE_URL = "https://console.cloudyali.io";

// Portal that serves the browser-based CLI login flow (/cli-login). Defaults
// to the public console; override via the PORTAL_URL env var if needed.
export const PORTAL_URL = (
  process.env.PORTAL_URL ?? CONSOLE_URL
).replace(/\/+$/, "");

// One-shot override: paste a Cognito access JWT and skip the file/refresh logic.
export const STATIC_JWT_OVERRIDE = process.env.CLOUDYALI_JWT;

const CREDENTIALS_DIR =
  process.env.CLOUDYALI_CREDS_DIR ?? join(homedir(), ".cloudyali-mcp");
export const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json");

// Server version, read from package.json so it stays a single source of truth.
// Resolved relative to this module: dist/config.js -> ../package.json (package
// root); src/config.ts -> ../package.json under vitest. Both land on the root.
export const PACKAGE_VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw).version as string) ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
