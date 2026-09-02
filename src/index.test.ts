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

describe("the design system is pushed, not left to be discovered", () => {
  // An artifact built from this server's data came back with none of the CloudYali
  // palette, no ECharts, no logo, no timestamp and no AI notice. Every one of those
  // rules was already written and correct — in cloudyali://design, a RESOURCE.
  // Resources are pull-only: tool definitions reach the model on every session, a
  // resource reaches it when something decides to read it, and nothing in the pushed
  // surface said the design system existed. Correct in isolation, inert in place.
  it("sends instructions in the initialize result", async () => {
    const { server } = await import("./index.js");
    const instructions = (server as unknown as { _instructions?: string })._instructions;
    expect(instructions, "no instructions: the design rules reach nobody").toBeTruthy();
  });

  it("names the design resource, ECharts and the theme, so one read is enough", async () => {
    const { SERVER_INSTRUCTIONS } = await import("./instructions.js");
    expect(SERVER_INSTRUCTIONS).toContain("cloudyali://design");
    expect(SERVER_INSTRUCTIONS).toContain("cloudyali://echarts-theme");
    expect(SERVER_INSTRUCTIONS).toMatch(/ECharts/);
    expect(SERVER_INSTRUCTIONS).toMatch(/AI-generated/);
  });

  it("references only URIs the server actually serves", async () => {
    const { SERVER_INSTRUCTIONS } = await import("./instructions.js");
    const { RESOURCES } = await import("./resources.js");
    const served = new Set(RESOURCES.map((r) => r.uri));
    const cited = SERVER_INSTRUCTIONS.match(/cloudyali:\/\/[a-z-]+/g) ?? [];
    expect(cited.length).toBeGreaterThan(0);
    for (const uri of cited) expect(served.has(uri), `instructions cite ${uri}, which is not served`).toBe(true);
  });

  // It goes into a system prompt on every session of every client that honours it.
  // Long enough to be ignored is the same as absent.
  it("stays short enough to be worth a client injecting it", async () => {
    const { SERVER_INSTRUCTIONS } = await import("./instructions.js");
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2000);
  });
});
