import { describe, expect, it } from "vitest";
import { server } from "./index.js";

describe("index server wiring", () => {
  it("creates the MCP server without starting the stdio transport", () => {
    // Importing index.ts must register handlers but not connect a transport
    // (the isDirectRun guard keeps main() from running under the test runner).
    expect(server).toBeDefined();
  });
});
