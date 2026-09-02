import { describe, expect, it } from "vitest";
import { server } from "./index.js";

describe("index server wiring", () => {
  it("creates the MCP server without starting the stdio transport", () => {
    // Importing index.ts must register handlers but not connect a transport
    // (the isDirectRun guard keeps main() from running under the test runner).
    expect(server).toBeDefined();
  });
});

describe("the advertised version says how big the surface is", () => {
  it("appends the live tool count to the package version", async () => {
    // An MCP server is spawned once and stays resident, so a rebuilt-but-
    // unrestarted process keeps serving the old tool list and is indistinguishable
    // from a build that did not take. package.json's version does not move between
    // those states; the tool count does, and it is what is actually stale.
    const { server } = await import("./index.js");
    const info = (server as unknown as { _serverInfo: { name: string; version: string } })._serverInfo;
    expect(info.name).toBe("cloudyali");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+ \(\d+ tools\)$/);
    const { TOOLS } = await import("./handlers.js");
    expect(info.version).toContain(`(${TOOLS.length} tools)`);
  });
});
