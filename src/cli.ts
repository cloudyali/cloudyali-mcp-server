// Shared entrypoint detection for the CLI bins (index.ts, login.ts).
//
// Returns true when the given module was launched directly (e.g. `node
// dist/index.js` or an npm bin shim) rather than imported by another module.
// realpath both sides: npm bin shims invoke the file through a symlink, so a
// plain `process.argv[1] === path` comparison would silently miss a direct run.
// Any failure (missing argv[1], nonexistent path) resolves to false.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isDirectRun(metaUrl: string): boolean {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl))
    );
  } catch {
    return false;
  }
}
