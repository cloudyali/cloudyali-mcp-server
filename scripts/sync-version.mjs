// Propagates the package.json version into server.json so the two can never
// drift. Run automatically by the npm `version` lifecycle hook
// (see package.json "version" script), or manually: `node scripts/sync-version.mjs`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function patch(file, mutate) {
  const path = join(root, file);
  const json = JSON.parse(readFileSync(path, "utf8"));
  mutate(json);
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  console.log(`synced ${file} -> ${version}`);
}

patch("server.json", (s) => {
  s.version = version;
  if (Array.isArray(s.packages)) for (const p of s.packages) p.version = version;
});
