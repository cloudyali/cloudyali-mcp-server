import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { CREDENTIALS_FILE } from "./config.js";

export type StoredCredentials = {
  email: string;
  // Cognito ID token. Optional: API auth uses the access token; this is kept
  // only when the login flow actually returned one.
  idToken?: string;
  accessToken: string;
  refreshToken: string;
  // Absolute epoch seconds when the *access* token expires (Cognito default 3600s lifetime).
  expiresAt: number;
  savedAt: number;
};

export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function loadCredentials(): StoredCredentials | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    const raw = readFileSync(CREDENTIALS_FILE, "utf8");
    const parsed = JSON.parse(raw) as StoredCredentials;
    if (!parsed.refreshToken || !parsed.accessToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: StoredCredentials): void {
  const dir = dirname(CREDENTIALS_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  try {
    chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {
    // best-effort; non-POSIX filesystems may not support chmod
  }
}

export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_FILE)) {
    try {
      unlinkSync(CREDENTIALS_FILE);
    } catch {
      // ignore
    }
  }
}
