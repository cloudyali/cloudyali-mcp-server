import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // The real token bucket would make the retry suites sleep for real. The bucket reads its
    // limits from the environment, so raising them here is enough — no setter, and no mutable
    // module-level binding for a swap that only ever happens in tests.
    // throttle.test.ts builds its own buckets and is unaffected.
    env: {
      CLOUDYALI_MCP_RATE_PER_MINUTE: "6000000",
      CLOUDYALI_MCP_BURST: "1000000",
    },
  },
});
