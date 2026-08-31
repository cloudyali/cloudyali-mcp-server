import { describe, expect, it } from "vitest";
import { RateLimitedError, TokenBucket } from "./throttle.js";

// A controllable clock: sleep() advances virtual time instead of real time, so
// these tests are deterministic and instant.
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("TokenBucket", () => {
  it("allows a full burst back-to-back from idle", async () => {
    const c = fakeClock();
    const b = new TokenBucket({ ratePerMinute: 60, burst: 5, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 5; i++) await b.take();
    expect(b.available()).toBeLessThan(1);
  });

  it("waits for a refill once the burst is spent", async () => {
    const c = fakeClock();
    const b = new TokenBucket({ ratePerMinute: 60, burst: 2, now: c.now, sleep: c.sleep });
    await b.take();
    await b.take();
    const before = c.now();
    await b.take(); // must wait ~1s at 60/min
    expect(c.now() - before).toBeGreaterThanOrEqual(1000);
  });

  it("refills over time up to the burst ceiling, never beyond", async () => {
    const c = fakeClock();
    const b = new TokenBucket({ ratePerMinute: 60, burst: 3, now: c.now, sleep: c.sleep });
    await b.take();
    await b.take();
    await b.take();
    c.advance(600_000); // ten minutes of idling
    expect(b.available()).toBe(3);
  });

  it("throws RateLimitedError rather than waiting past maxWaitMs", async () => {
    const c = fakeClock();
    const b = new TokenBucket({
      ratePerMinute: 6, // one token per 10s
      burst: 1,
      maxWaitMs: 2000,
      now: c.now,
      sleep: c.sleep,
    });
    await b.take();
    await expect(b.take()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("tells the model what to do differently instead of just failing", async () => {
    const c = fakeClock();
    const b = new TokenBucket({ ratePerMinute: 6, burst: 1, maxWaitMs: 0, now: c.now, sleep: c.sleep });
    await b.take();
    await expect(b.take()).rejects.toThrow(/fewer, broader calls/);
  });

  it("honours an abort signal while queued", async () => {
    const c = fakeClock();
    const b = new TokenBucket({ ratePerMinute: 60, burst: 1, now: c.now, sleep: c.sleep });
    await b.take();
    const ac = new AbortController();
    ac.abort();
    await expect(b.take(ac.signal)).rejects.toThrow(/aborted/i);
  });

  it("keeps serving later callers after one of them fails", async () => {
    const c = fakeClock();
    const b = new TokenBucket({ ratePerMinute: 60, burst: 1, maxWaitMs: 0, now: c.now, sleep: c.sleep });
    await b.take();
    await expect(b.take()).rejects.toBeInstanceOf(RateLimitedError); // fails, queue must survive
    c.advance(2000);
    await expect(b.take()).resolves.toBeUndefined();
  });

  it("clamps a nonsensical config instead of dividing by zero", async () => {
    const c = fakeClock();
    const b = new TokenBucket({ ratePerMinute: 0, burst: 0, now: c.now, sleep: c.sleep });
    expect(b.available()).toBeGreaterThanOrEqual(1);
    await expect(b.take()).resolves.toBeUndefined();
  });
});
