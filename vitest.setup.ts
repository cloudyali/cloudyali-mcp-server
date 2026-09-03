// The login flow writes the portal URL and verification code to stderr for the
// CLI bin, where a human is watching a terminal. Under vitest that is ~50 lines
// of noise per run that buries real failures, so silence it here only.
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
  if (/^(Opening browser to|If it does not open|Verification code:)/.test(text)) return true;
  return (realStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stderr.write;
