// Unit tests exercise the retry paths hundreds of times; the real token bucket
// would make them sleep for real. Swap in an effectively unlimited bucket so
// suites stay fast. throttle.test.ts constructs its own buckets and is unaffected.
import { TokenBucket, setApiThrottle } from "./src/throttle.js";

setApiThrottle(new TokenBucket({ ratePerMinute: 6_000_000, burst: 1_000_000 }));
