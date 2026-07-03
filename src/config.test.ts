import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// config.ts resolves PORTAL_URL from process.env at import time, so each case
// sets the env and re-imports the module via vi.resetModules().
const ORIGINAL_PORTAL_URL = process.env.PORTAL_URL;

async function loadConfig() {
  vi.resetModules();
  return import("./config.js");
}

describe("PORTAL_URL", () => {
  beforeEach(() => {
    delete process.env.PORTAL_URL;
  });

  afterEach(() => {
    if (ORIGINAL_PORTAL_URL === undefined) delete process.env.PORTAL_URL;
    else process.env.PORTAL_URL = ORIGINAL_PORTAL_URL;
  });

  it("defaults to the production console URL when PORTAL_URL is unset", async () => {
    const { PORTAL_URL, CONSOLE_URL } = await loadConfig();
    expect(PORTAL_URL).toBe("https://console.cloudyali.io");
    expect(PORTAL_URL).toBe(CONSOLE_URL);
  });

  it("uses the PORTAL_URL override when set, trimming trailing slashes", async () => {
    process.env.PORTAL_URL = "https://portal.example.com/";
    const { PORTAL_URL } = await loadConfig();
    expect(PORTAL_URL).toBe("https://portal.example.com");
  });
});

describe("CLOUDYALI_API_URL", () => {
  const ORIGINAL_API = process.env.CLOUDYALI_API_URL;
  const ORIGINAL_LEGACY = process.env.QUERYSERVICE_URL;

  beforeEach(() => {
    delete process.env.CLOUDYALI_API_URL;
    delete process.env.QUERYSERVICE_URL;
  });

  afterEach(() => {
    if (ORIGINAL_API === undefined) delete process.env.CLOUDYALI_API_URL;
    else process.env.CLOUDYALI_API_URL = ORIGINAL_API;
    if (ORIGINAL_LEGACY === undefined) delete process.env.QUERYSERVICE_URL;
    else process.env.QUERYSERVICE_URL = ORIGINAL_LEGACY;
  });

  it("defaults to the production API URL when unset", async () => {
    const { CLOUDYALI_API_URL } = await loadConfig();
    expect(CLOUDYALI_API_URL).toBe("https://api.cloudyali.io");
  });

  it("ignores the removed QUERYSERVICE_URL legacy alias", async () => {
    process.env.QUERYSERVICE_URL = "https://internal.example";
    const { CLOUDYALI_API_URL } = await loadConfig();
    expect(CLOUDYALI_API_URL).toBe("https://api.cloudyali.io");
  });
});

describe("PACKAGE_VERSION", () => {
  it("is sourced from package.json, not hardcoded", async () => {
    const { PACKAGE_VERSION } = await loadConfig();
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
