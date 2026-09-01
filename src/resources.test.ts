import { describe, expect, it } from "vitest";
import { RESOURCES, readResource } from "./resources.js";
import { TOOL_DEFS } from "./tools/index.js";

describe("MCP resources", () => {
  it("serves every advertised resource", () => {
    for (const r of RESOURCES) {
      const body = readResource(r.uri);
      expect(body.text.length, r.uri).toBeGreaterThan(200);
      expect(body.mimeType).toBe("text/markdown");
    }
  });

  it("rejects an unknown URI rather than returning an empty document", () => {
    expect(() => readResource("cloudyali://nope")).toThrow(/Unknown resource/);
  });

  it("actually provides every resource a tool description points at", () => {
    // A description that references a resource we do not serve is worse than no
    // reference: the model burns a call discovering the gap.
    const uris = new Set(RESOURCES.map((r) => r.uri));
    for (const t of TOOL_DEFS) {
      const referenced = [
        ...t.description.matchAll(/cloudyali:\/\/[a-z]+/g),
        ...Object.values(t.inputSchema.properties ?? {}).flatMap((p) => [
          ...(p.description ?? "").matchAll(/cloudyali:\/\/[a-z]+/g),
        ]),
      ].map((m) => m[0]);
      for (const uri of referenced) {
        expect(uris.has(uri), `${t.name} references unserved resource ${uri}`).toBe(true);
      }
    }
  });

  it("documents the equal/equals divergence that silently drops filters", () => {
    const text = readResource("cloudyali://filters").text;
    expect(text).toMatch(/silently ignored/i);
    expect(text).toMatch(/equal.*not.*equals/is);
  });
});
