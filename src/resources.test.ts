import { describe, expect, it } from "vitest";
import { RESOURCES, readResource } from "./resources.js";
import { TOOL_DEFS } from "./tools/index.js";

describe("MCP resources", () => {
  it("serves every advertised resource, at the type it advertised", () => {
    // The declared mimeType is the only signal a client has for whether to parse
    // or display; a JSON resource announced as markdown is one a client will
    // never JSON.parse.
    for (const r of RESOURCES) {
      const body = readResource(r.uri);
      expect(body.text.length, r.uri).toBeGreaterThan(200);
      expect(body.mimeType, r.uri).toBe(r.mimeType);
    }
  });

  it("serves the ECharts theme as parseable JSON with the palette intact", () => {
    const body = readResource("cloudyali://echarts-theme");
    expect(body.mimeType).toBe("application/json");
    const theme = JSON.parse(body.text);
    expect(theme.color).toHaveLength(6);
    // Canvas cannot resolve a CSS custom property — it draws nothing, silently.
    // Every value that reaches ECharts has to be a literal.
    expect(body.text).not.toMatch(/var\(/);
    for (const c of theme.color) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    // The Other bucket must stay out of the rotation or it lands on a real service.
    expect(theme.color).not.toContain(theme.cloudyali.other);
  });

  it("serves a brand mark that can be pasted straight into an artifact", () => {
    const body = readResource("cloudyali://brand-mark");
    expect(body.mimeType).toBe("image/svg+xml");
    expect(body.text.startsWith("<svg")).toBe(true);
    expect(body.text.trimEnd().endsWith("</svg>")).toBe(true);
    // No external reference: an artifact cannot fetch, so a linked asset is a
    // broken image in every context this is used.
    expect(body.text).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(body.text).not.toMatch(/<image|xlink:href/);
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

  it("builds the design guide from the theme, never from hexes typed twice", () => {
    // A palette copied into prose is a palette that drifts, and a chart in
    // almost-CloudYali colours reads as a bug in the product rather than as a
    // default. Every colour in the guide must appear in the theme.
    const guide = readResource("cloudyali://design").text;
    const theme = JSON.parse(readResource("cloudyali://echarts-theme").text);
    const known = new Set<string>([
      ...theme.color,
      ...Object.values(theme.cloudyali).flat() as string[],
      theme.textStyle.color,
      theme.tooltip.borderColor,
    ]);
    const quoted = [...guide.matchAll(/`(#[0-9a-f]{6})`/g)].map((m) => m[1]);
    expect(quoted.length).toBeGreaterThan(10);
    for (const hex of quoted) expect(known, `${hex} is in the guide but not in the theme`).toContain(hex);
  });

  it("states the three things every generated artifact must carry", () => {
    const guide = readResource("cloudyali://design").text;
    expect(guide).toMatch(/cloudyali:\/\/brand-mark/);
    expect(guide).toMatch(/generation time/i);
    expect(guide).toMatch(/AI-generated/);
    expect(guide).toMatch(/verify before acting/i);
    // A stamp, not a preamble — the instruction has to say so, or it grows.
    expect(guide).toMatch(/one line each/i);
  });

  it("tells the renderer to carry a tool WARNING into the artifact", () => {
    // This is the one that matters. A chart gets screenshotted into Slack and
    // the caveat stays behind in the transcript — which is exactly how a
    // silently-dropped filter becomes a number someone acts on.
    const guide = readResource("cloudyali://design").text;
    expect(guide).toMatch(/WARNING:/);
    expect(guide.replace(/\s+/g, " ")).toMatch(/inventing a mechanism is worse than leaving the caveat bare/);
  });

  it("keeps red out of the categorical ramp in the guide as well as the theme", () => {
    const guide = readResource("cloudyali://design").text;
    const theme = JSON.parse(readResource("cloudyali://echarts-theme").text);
    expect(theme.color).not.toContain(theme.cloudyali.increase);
    expect(guide).toMatch(/do not use these as series colours/i);
    expect(guide).toMatch(/red \u2192 teal/);
  });

  it("documents the dataset switch, including that empty is not zero", () => {
    // The tools warn at call time, but a model planning a reconciliation reads
    // this first. Both need to say it; the warning alone arrives too late to
    // change the plan.
    const text = readResource("cloudyali://filters").text;
    expect(text).toMatch(/resource_names.*changes.*where the answer comes from/is);
    expect(text).toMatch(/not evidence of zero spend/i);
    expect(text).toMatch(/billing lag/i);
    expect(text).toMatch(/match_confidence/);
  });

  it("describes the switch by what is observable, never by what is behind the API", () => {
    // This resource is where the leak was. It explained the mechanism -- storage
    // layout, refresh cadence, a retention window -- none of which the MCP can
    // see, all of which it had no business relaying. The behaviour survives; the
    // explanation does not. src/leak-scan.test.ts enforces the general rule; this
    // pins the specific passage that got it wrong.
    const text = readResource("cloudyali://filters").text;
    expect(text).toMatch(/not comparable/i);
    expect(text).toMatch(/would be invented/i);
    expect(text).not.toMatch(/view|refresh|table|column|seven months/i);
  });

  it("keeps the per-provider drop table and the dataset section consistent", () => {
    // Azure appears in both, saying opposite things: its usage_types filter
    // works, but its resource_types filter is dropped. If a future edit blurs
    // that into "Azure is fine" or "Azure is broken", the doc stops matching
    // filter-support.ts and the tools start contradicting the reference.
    const text = readResource("cloudyali://filters").text;
    expect(text).toMatch(/Azure is unaffected/i);
    expect(text).toMatch(/\| Azure \| `resource_types` \|/);
  });
});
