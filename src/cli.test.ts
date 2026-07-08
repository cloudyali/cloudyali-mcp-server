import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "./cli.js";

// isDirectRun compares the realpath of process.argv[1] against the realpath of
// the given module URL, so the tests set process.argv[1] to real, existing
// paths (this test file, the node binary) and restore it afterwards.
const ORIGINAL_ARGV1 = process.argv[1];
const THIS_FILE = fileURLToPath(import.meta.url);

afterEach(() => {
  process.argv[1] = ORIGINAL_ARGV1;
});

describe("isDirectRun", () => {
  it("returns true when argv[1] resolves to the module's own path", () => {
    process.argv[1] = THIS_FILE;
    expect(isDirectRun(import.meta.url)).toBe(true);
  });

  it("returns false when argv[1] is a different existing file", () => {
    process.argv[1] = process.execPath; // the node binary — a real, different path
    expect(isDirectRun(import.meta.url)).toBe(false);
  });

  it("returns false when argv[1] is unset", () => {
    delete process.argv[1];
    expect(isDirectRun(import.meta.url)).toBe(false);
  });

  it("returns false (does not throw) when argv[1] points at a nonexistent path", () => {
    process.argv[1] = "/no/such/file/definitely-missing";
    expect(isDirectRun(import.meta.url)).toBe(false);
  });
});
