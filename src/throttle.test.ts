import { describe, expect, it } from "vitest";
import { RateLimitedError, Semaphore, TokenBucket } from "./throttle.js";

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

describe("the concurrency cap bounds requests in flight, which the rate bucket does not", () => {
  // Firing all 40 saved views at once got 500s and timeouts back. The bucket was
  // working exactly as designed — burst 10 means ten heavy aggregations leave
  // together and sit on the backend together. Rate was never the constraint.
  it("never runs more than the limit at once", async () => {
    const sem = new Semaphore(3);
    let peak = 0;
    let active = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const runs = Array.from({ length: 12 }, () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
      }),
    );
    await Promise.resolve();
    release();
    await Promise.all(runs);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("frees the slot when the call throws, or one failure would wedge the queue", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error("500"); })).rejects.toThrow("500");
    expect(sem.active()).toBe(0);
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("queues rather than rejecting, so fan-out is slower and not broken", async () => {
    const sem = new Semaphore(2);
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4, 5].map((n) => sem.run(async () => { order.push(n); })));
    expect(order.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
