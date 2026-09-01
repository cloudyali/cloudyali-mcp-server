// Unit tests exercise the retry paths hundreds of times; the real token bucket
// would make them sleep for real. Swap in an effectively unlimited bucket so
// suites stay fast. throttle.test.ts constructs its own buckets and is unaffected.
import { TokenBucket, setApiThrottle } from "./src/throttle.js";

setApiThrottle(new TokenBucket({ ratePerMinute: 6_000_000, burst: 1_000_000 }));

// The login flow writes the portal URL and verification code to stderr for the
// CLI bin, where a human is watching a terminal. Under vitest that is ~50 lines
// of noise per run that buries real failures, so silence it here only.
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
  if (/^(Opening browser to|If it does not open|Verification code:)/.test(text)) return true;
  return (realStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stderr.write;
