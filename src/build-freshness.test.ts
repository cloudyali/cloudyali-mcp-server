import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// dist/ is committed, because the MCP client launches `node dist/index.js` directly — a fresh
// clone has to work without a build step. The cost of that convenience is a second copy of the
// program that can silently fall behind the first.
//
// It already has. The sign-in tab's auto-close was written, tested, reviewed and committed, and
// then did nothing at all for a day, because src/login.ts was committed without rebuilding. The
// server kept serving the previous page. Nothing was broken, no test failed, and the only symptom
// was a feature that quietly was not there — which is the worst shape a defect can take, because
// there is nothing to notice.
//
// Deliberately compiled and compared rather than checked by timestamp: `git clone` and `git
// checkout` rewrite mtimes, so an mtime rule is either flaky or so loose it catches nothing. This
// compiles src to a scratch directory and diffs the emitted JavaScript against what is committed,
// which is exact and answers the only question that matters — does dist correspond to this source?

const root = resolve(__dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "cy-dist-check-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function jsFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full, base));
    else if (entry.name.endsWith(".js")) out.push(relative(base, full));
  }
  return out;
}

describe("the committed dist matches the committed src", () => {
  it("compiles cleanly to a scratch directory", () => {
    expect(() =>
      execFileSync("npx", ["tsc", "--outDir", scratch], { cwd: root, stdio: "pipe" }),
    ).not.toThrow();
  });

  it("emits the same JavaScript that is checked in", () => {
    const distDir = join(root, "dist");
    expect(statSync(distDir).isDirectory()).toBe(true);

    const fresh = jsFiles(scratch);
    expect(fresh.length).toBeGreaterThan(10);

    const stale: string[] = [];
    const missing: string[] = [];
    for (const rel of fresh) {
      let committed: string;
      try {
        committed = readFileSync(join(distDir, rel), "utf8");
      } catch {
        missing.push(rel);
        continue;
      }
      if (committed !== readFileSync(join(scratch, rel), "utf8")) stale.push(rel);
    }

    expect(
      { stale, missing },
      "dist is out of step with src. Run `npm run build` and commit the result — the server " +
        "runs dist/index.js, so until you do, your change is not in the program that executes.",
    ).toEqual({ stale: [], missing: [] });
  });
});
