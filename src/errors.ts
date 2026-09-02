// What a user sees when a tool fails.
//
// The two failure paths that matter both produced something unusable. A non-2xx
// came back as `CloudYali returned HTTP 400. {"code":"...","message":"..."}` —
// a status number and a JSON blob pasted into prose. A transport failure came
// back as `Error: fetch failed`, which does not distinguish "you are offline"
// from "CloudYali is down" from "the configured URL is wrong".
//
// The standard here is higher than "readable", because the reader is usually a
// model that will act on it. Every message answers three questions:
//
//   1. What happened, in words rather than a status code.
//   2. Whose problem it is — the arguments, the session, the account, or the API.
//   3. What to do next, INCLUDING when the answer is "nothing, and do not
//      retry". That last one is load-bearing: the failure mode this codebase
//      keeps hitting is a model turning an error into a confident wrong answer,
//      or into a retry storm. A 404 reported as "none found" and a 500 retried
//      with one grouping changed are the same defect.
//
// The leak rules apply in full. These say what the reader observes and what to
// do; they never explain what the backend was doing when it failed, because
// this server reaches the API over HTTP and does not know.

// Field-level dropping is necessary but not sufficient: an upstream `message`
// can carry the same content if someone wraps a driver error into one. These
// patterns are checked on every error string that survives the allowlist, and a
// match replaces the whole string rather than redacting part of it — a partial
// redaction leaves you guessing which part was the sensitive half.
//
// The last three arrived late, and from the leak scanner rather than from
// review. Every other model-facing surface is forbidden storage internals, a
// tenant key and refresh/retention language; the error path was the one place
// that could still emit all three, because it relays a string the backend
// composed. An error message is the most likely place for a backend to explain
// itself, which makes it the least safe place to pass one through.
const LEAKY_ERROR_PATTERNS: RegExp[] = [
  /\bcolumn\s+"[^"]+"\s+does not exist/i,
  /\brelation\s+"[^"]+"\s+does not exist/i,
  /\bSQLSTATE\b/i,
  /^\s*(pq|pgx|sql):/i,
  /\b(SELECT|INSERT|UPDATE|DELETE)\b[^"]{0,80}\bFROM\b/i,
  /goroutine \d+ \[/,
  /\.go:\d+/,
  /\b(dial tcp|connection refused|no such host)\b/i,
  /\b[\w-]+\.(internal|local|svc\.cluster\.local)\b/i,
  /(postgres(ql)?|redis|amqp):\/\//i,
  /materiali[sz]ed view|matview|\bmv_[a-z_]+/i,
  /customer_?[iI][dD]/,
  /refreshed by|refresh job|retention window/i,
];

/**
 * Replace an error string that describes the backend with one that describes
 * the situation. Whole-string, not partial: a half-redacted message invites the
 * reader to guess at the redacted half.
 */
export function scrubErrorText(text: string): string {
  for (const re of LEAKY_ERROR_PATTERNS) {
    if (re.test(text)) {
      return "The CloudYali API rejected this request. Check the arguments against the tool schema; if they look right, the endpoint may not support this combination.";
    }
  }
  return text;
}

/** Fields trimErrorBody keeps. Anything the API sent that is useful is in here. */
type ErrorBody = Record<string, unknown>;

function apiSentence(body: ErrorBody | undefined): string {
  if (!body) return "";
  const msg = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "";
  const code = typeof body.code === "string" ? body.code : "";
  if (!msg && !code) return "";
  // "request failed" is trimErrorBody's placeholder for a body that carried
  // nothing allowlisted. Repeating it adds a sentence and no information.
  if (msg === "request failed" && !code) return "";
  // Scrubbed here as well as in trimErrorBody. Not redundant: this function is
  // exported and will eventually be called with a body somebody forgot to trim,
  // and a control that only works when its caller remembers is the failure this
  // codebase keeps repeating.
  const text = scrubErrorText(msg || code);
  return ` CloudYali said: ${text.replace(/\s+$/, "").replace(/\.?$/, ".")}`;
}

/**
 * Turn a non-2xx into something a reader can act on.
 *
 * `toolName` is included because an MCP client shows the message, not always
 * which call produced it, and a conversation that fired several tools needs to
 * know which one came back empty-handed.
 */
export function describeHttpFailure(status: number, body: unknown, toolName: string): string {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : undefined) as ErrorBody | undefined;
  const from = apiSentence(b);

  if (status === 400 || status === 422) {
    return (
      `${toolName} was rejected as invalid — the request never ran, so there is no result to report.${from}` +
      ` Check the arguments against the tool's schema. Dates and times are the usual cause: several endpoints take` +
      ` RFC 3339 in UTC ("2026-08-01T00:00:00Z") and reject a bare date outright. Fix the argument and call again;` +
      ` calling the same way a second time will fail the same way.`
    );
  }
  if (status === 401) {
    return (
      `${toolName} could not run: this session is not signed in to CloudYali, or its access has expired.${from}` +
      ` Run the \`login\` tool, complete the browser sign-in, then call again.`
    );
  }
  if (status === 403) {
    return (
      `${toolName} was refused: this CloudYali account is not permitted to read that.${from}` +
      ` This is an entitlement, not a bad argument — retrying, rephrasing or narrowing the query will not change it.` +
      ` Someone with access to the account settings has to grant it.`
    );
  }
  if (status === 404) {
    return (
      `${toolName} found no such record: the id does not exist in this account.${from}` +
      ` This is NOT an empty result — do not report it as "none found" or as a count of zero. Either the id is wrong,` +
      ` or it belongs to a different account. List the records first and take the id from there.`
    );
  }
  if (status === 408 || status === 504) {
    return (
      `${toolName} timed out: CloudYali did not finish the query in time, so nothing came back.${from}` +
      ` The window is usually the cause. Ask for a shorter date range, a coarser interval (monthly rather than daily),` +
      ` or fewer groupings, and try once. Repeating the same query unchanged will time out again.`
    );
  }
  if (status === 429) {
    return (
      `${toolName} was rate-limited by CloudYali — this is the server's limit, not this client's.${from}` +
      ` Wait about a minute before trying again, and make one broad request instead of many narrow ones.`
    );
  }
  if (status >= 500) {
    return (
      `${toolName} failed inside CloudYali (HTTP ${status}), and the request was already retried before you saw this.${from}` +
      ` Nothing about how the question was phrased caused it, so do not retry with the arguments changed — a different` +
      ` grouping or a shorter range will not fix a server-side failure, and a result assembled from whatever else` +
      ` succeeded would be incomplete without saying so. Report that this data could not be retrieved, and if it keeps` +
      ` happening, it is worth telling CloudYali support which tool and roughly when.`
    );
  }
  return (
    `${toolName} failed: CloudYali answered with HTTP ${status} and no result.${from}` +
    ` Treat this as no data rather than as an empty answer.`
  );
}

/** Node attaches the useful part of a network failure to `cause.code`. */
function causeCode(err: unknown): string {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return "";
}

/**
 * Did this failure happen on the wire, or is it a bug in this server?
 *
 * Worth separating, because describing a TypeError from our own code as "could
 * not reach CloudYali" sends whoever reads it to check their network for an hour
 * over a null dereference. Undici reports every transport fault as a TypeError
 * with the detail on `cause`, so the presence of a cause code — or an abort or
 * timeout name — is what distinguishes the two.
 */
export function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  if (causeCode(err) !== "") return true;
  return /fetch failed|network|socket hang up|ECONN|ETIMEDOUT/i.test(err.message);
}

/**
 * Turn a request that never reached CloudYali into something diagnosable.
 *
 * `fetch failed` is the whole message Node gives for DNS failure, a refused
 * connection and a TLS rejection alike, and none of those have the same fix.
 * The API URL is named because it is configurable, and a typo in it presents
 * exactly as an outage.
 */
export function describeTransportFailure(err: unknown, apiUrl: string, toolName: string): string {
  const name = err instanceof Error ? err.name : "";
  const code = causeCode(err);
  const raw = err instanceof Error ? err.message : String(err);
  const tail = ` (${raw})`;

  if (name === "TimeoutError" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
    return (
      `${toolName} timed out before CloudYali answered.${tail} Ask for a shorter date range, a coarser interval or` +
      ` fewer groupings. If a small query also times out, ${apiUrl} is slow or unreachable rather than the query being large.`
    );
  }
  if (name === "AbortError") {
    return `${toolName} was cancelled before it finished, so there is no result. Nothing was left half-done — this server only reads.`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return (
      `${toolName} could not reach CloudYali: the host in ${apiUrl} did not resolve.${tail} Either this machine has no` +
      ` working network or DNS right now, or CLOUDYALI_API_URL is pointing somewhere that does not exist. Nothing was sent.`
    );
  }
  if (code === "ECONNREFUSED") {
    return `${toolName} could not reach CloudYali: nothing accepted a connection at ${apiUrl}.${tail} Check that the URL is the one you meant. Nothing was sent.`;
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    return `${toolName} lost its connection to ${apiUrl} mid-request.${tail} The request may or may not have run; since this server only reads, calling again is safe.`;
  }
  if (code.startsWith("CERT_") || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN") {
    return `${toolName} refused the TLS certificate presented by ${apiUrl}.${tail} Nothing was sent. If you are pointing at a test environment, that is why; against production, stop and check the URL.`;
  }
  return (
    `${toolName} never reached CloudYali at ${apiUrl}.${tail} This is a network or configuration problem on this side,` +
    ` not a problem with the question — the request was not answered, so there is no data to report either way.`
  );
}
