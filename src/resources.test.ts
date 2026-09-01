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

  it("documents the dataset switch, including that empty is not zero", () => {
    // The tools warn at call time, but a model planning a reconciliation reads
    // this first. Both need to say it; the warning alone arrives too late to
    // change the plan.
    const text = readResource("cloudyali://filters").text;
    expect(text).toMatch(/resource_names.*different materialized view/is);
    expect(text).toMatch(/not evidence of zero spend/i);
    expect(text).toMatch(/billing lag/i);
    expect(text).toMatch(/match_confidence/);
  });

  it("keeps the per-provider drop table and the dataset section consistent", () => {
    // Azure appears in both, saying opposite things: its usage_types filter
    // works, but its resource_types filter is dropped. If a future edit blurs
    // that into "Azure is fine" or "Azure is broken", the doc stops matching
    // filter-support.ts and the tools start contradicting the reference.
    const text = readResource("cloudyali://filters").text;
    expect(text).toMatch(/Azure.*meter_subcategory.*unaffected/is);
    expect(text).toMatch(/\| Azure \| `resource_types` \|/);
  });
});
