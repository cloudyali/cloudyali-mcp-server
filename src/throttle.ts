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

const DEFAULT_RATE_PER_MINUTE = 60;
const DEFAULT_BURST = 10;
const DEFAULT_MAX_WAIT_MS = 10_000;

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

/**
 * A cap on requests in flight at once, which is a different thing from a cap on
 * requests per minute.
 *
 * The bucket bounds rate; burst still lets N requests leave together and sit on
 * the backend simultaneously. Asking this server to run all 40 saved cost views
 * did exactly that: ten concurrent multi-month aggregations, and the API
 * answered with 500s and timeouts. Rate was never the binding constraint —
 * simultaneity was.
 *
 * A tool description asking the model not to fan out is not a fix. It is advice
 * in the one place we control least, and the failure mode is a backend melting
 * for every tenant on that instance. So the queue is here, where fanning out
 * simply takes longer instead of failing.
 */
export class Semaphore {
  private readonly limit: number;
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  /** Test/debug view. */
  active(): number {
    return this.inFlight;
  }
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Process-wide bucket. This server is a single-user local process, so one bucket
// per process is one bucket per user, which is the unit we want to bound.
export const apiThrottle = new TokenBucket({
  ratePerMinute: envInt("CLOUDYALI_MCP_RATE_PER_MINUTE"),
  burst: envInt("CLOUDYALI_MCP_BURST"),
});

// Four is chosen against the heaviest call this server makes — a multi-month
// cost aggregation — not the lightest. At conversational pace nobody notices it;
// under fan-out it turns "40 at once, half of them 500" into "40 in sequence,
// all of them answered".
const DEFAULT_MAX_CONCURRENT = 4;

export const apiConcurrency = new Semaphore(envInt("CLOUDYALI_MCP_MAX_CONCURRENT") ?? DEFAULT_MAX_CONCURRENT);

