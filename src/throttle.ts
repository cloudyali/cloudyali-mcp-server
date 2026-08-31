// Client-side request throttling for outbound CloudYali API calls.
//
// Why this exists: the backend's own rate limiters are process-global, unkeyed,
// and cover only the databricks/fastly/anthropic/openai route families. Every
// route this MCP actually calls — cost, inventory, savings, budgets, anomalies —
// is unthrottled at the app layer. An agent in a retry loop can therefore issue
// hundreds of requests a minute and degrade the portal for other tenants sharing
// that task. This bucket is the polite-client half of the fix; per-customer
// limits in queryService are the other half.
//
// Behaviour: a token bucket that *waits* rather than failing, because a short
// delay is invisible to the caller while an error costs the model a turn and
// usually provokes a retry — the opposite of what we want. Waits are bounded:
// past MAX_WAIT_MS the call fails with a message that tells the model to make
// fewer, broader requests instead of hammering.

export type ThrottleOptions = {
  /** Sustained rate, requests per minute. */
  ratePerMinute?: number;
  /** Maximum burst — how many requests may go out back-to-back from idle. */
  burst?: number;
  /** Longest a single call will wait for a token before failing. */
  maxWaitMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_RATE_PER_MINUTE = 60;
export const DEFAULT_BURST = 10;
export const DEFAULT_MAX_WAIT_MS = 10_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Never let a pending throttle timer hold the process open.
    if (typeof t.unref === "function") t.unref();
  });
}

export class RateLimitedError extends Error {
  constructor(waitedMs: number) {
    super(
      `Request throttled: the client rate limit was still saturated after ${Math.round(
        waitedMs / 1000,
      )}s. Make fewer, broader calls — widen the date range or add groupings rather than issuing many narrow queries.`,
    );
    this.name = "RateLimitedError";
  }
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private tokens: number;
  private lastRefill: number;
  // Serializes waiters so N concurrent callers queue in arrival order instead of
  // all racing on the same token and stampeding the moment one is refilled.
  private tail: Promise<void> = Promise.resolve();

  constructor(opts: ThrottleOptions = {}) {
    const rate = Math.max(1, opts.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE);
    this.capacity = Math.max(1, opts.burst ?? DEFAULT_BURST);
    this.refillPerMs = rate / 60_000;
    this.maxWaitMs = Math.max(0, opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = t;
  }

  /** Milliseconds until one token is available. 0 when a token is free now. */
  private msUntilToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  /**
   * Resolves once a token has been taken. Throws RateLimitedError if that would
   * take longer than maxWaitMs, or rethrows the caller's abort reason if the
   * signal fires while waiting.
   */
  async take(signal?: AbortSignal): Promise<void> {
    const run = async () => {
      let waited = 0;
      for (;;) {
        if (signal?.aborted) throw new Error("Request aborted by the caller.");
        const wait = this.msUntilToken();
        if (wait === 0) {
          this.tokens -= 1;
          return;
        }
        if (waited + wait > this.maxWaitMs) throw new RateLimitedError(waited + wait);
        await this.sleep(wait);
        waited += wait;
      }
    };
    // Chain onto the queue, but don't let one caller's failure break the chain
    // for everyone behind it.
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Test/debug view of the current allowance. */
  available(): number {
    this.refill();
    return this.tokens;
  }
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Process-wide bucket. This server is a single-user local process, so one
// bucket per process is one bucket per user, which is the unit we want to bound.
// Exported as `let` so tests can swap in a permissive bucket via setApiThrottle;
// ESM live bindings mean importers always see the current one.
export let apiThrottle = new TokenBucket({
  ratePerMinute: envInt("CLOUDYALI_MCP_RATE_PER_MINUTE"),
  burst: envInt("CLOUDYALI_MCP_BURST"),
});

/** Replace the process-wide bucket. Intended for tests. */
export function setApiThrottle(b: TokenBucket): void {
  apiThrottle = b;
}
