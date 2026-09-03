import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("catalog syntax", () => {
  it("parses without TypeScript diagnostics", () => {
    const source = readFileSync(new URL("./catalog.ts", import.meta.url), "utf8");
    const result = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.Node16 },
      fileName: "catalog.ts",
      reportDiagnostics: true,
    });
    const diagnostics = (result.diagnostics ?? []).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );

    expect(diagnostics).toEqual([]);
  });
});
