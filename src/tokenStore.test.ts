import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// config.ts reads CLOUDYALI_CREDS_DIR at import time, so set it before the
// dynamic import below.
const dir = mkdtempSync(join(tmpdir(), "cloudyali-mcp-test-"));
process.env.CLOUDYALI_CREDS_DIR = dir;

const { loadCredentials, saveCredentials, clearCredentials } = await import("./tokenStore.js");
const { CREDENTIALS_FILE } = await import("./config.js");

const creds = {
  email: "user@example.com",
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: 1767225600,
  savedAt: 1767222000,
};

describe("tokenStore", () => {
  it("round-trips credentials and restricts file permissions to 0600", () => {
    saveCredentials(creds);
    expect(loadCredentials()).toEqual(creds);
    const mode = statSync(CREDENTIALS_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(CREDENTIALS_FILE, "utf8")).toContain("user@example.com");
  });

  it("returns null for a corrupt or incomplete credentials file", () => {
    writeFileSync(CREDENTIALS_FILE, "not json");
    expect(loadCredentials()).toBeNull();
    writeFileSync(CREDENTIALS_FILE, JSON.stringify({ email: "x" }));
    expect(loadCredentials()).toBeNull();
  });

  it("clearCredentials removes the file and tolerates a missing file", () => {
    saveCredentials(creds);
    clearCredentials();
    expect(loadCredentials()).toBeNull();
    expect(() => clearCredentials()).not.toThrow();
  });
});
