#!/usr/bin/env node
// Browser-based CLI login for the cloudyali MCP.
//
// Flow:
//   1. Generate a random `state` value and start a local HTTP listener on a free port.
//   2. Open the user's default browser to:
//        <PORTAL_URL>/cli-login?redirect_uri=http://localhost:<port>/callback&state=<state>
//   3. The portal renders an "Authorize CLI" page (behind its existing Amplify
//      Cognito auth, so the user signs in via the portal if not already).
//   4. On Authorize, the portal redirects the browser to:
//        http://localhost:<port>/callback#access_token=...&refresh_token=...&...&state=...
//      The tokens live in the URL fragment, so they never appear in any
//      server-side log.
//   5. Our /callback handler returns a tiny HTML page whose JS parses the
//      fragment and POSTs it to /token. The /token handler validates `state`,
//      saves the credentials, and shuts down the listener.

import { spawn } from "node:child_process";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { PORTAL_URL } from "./config.js";
import { nowEpochSeconds, saveCredentials, StoredCredentials } from "./tokenStore.js";
import { isDirectRun } from "./cli.js";

function openBrowser(url: string): void {
  // spawn with an argv array — never a shell string, so a hostile PORTAL_URL
  // can't smuggle shell metacharacters into a command.
  const platform = process.platform;
  const [cmd, args]: [string, string[]] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    process.stderr.write(
      `Could not open browser automatically. Open this URL manually:\n  ${url}\n`,
    );
  });
  child.unref();
}

// Short human-checkable code shown both in the terminal and on the portal's
// authorize page. A rogue local process can open the browser to /cli-login
// with its own redirect_uri, but it cannot print a matching code in a
// terminal the user trusts — users are told to authorize only when the codes
// match.
export function verificationCodeFromState(state: string): string {
  const digest = createHash("sha256").update(state).digest("hex").toUpperCase();
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}`;
}

/**
 * Render an expiry in UTC *and* the machine's local time.
 *
 * UTC alone is precise and useless: the person reading it is deciding whether
 * they need to act soon, and that means mental arithmetic against an offset
 * they may not know. Local alone is ambiguous in a transcript that may be read
 * from another timezone. Both, with the zone named, answers either question
 * without the reader converting anything.
 */
export function formatExpiry(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  if (!Number.isFinite(d.getTime())) return "an unknown time";

  const utc = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

  // Drop the repeated date when both land on the same calendar day, which is
  // the common case and the one where the extra text is pure noise.
  const sameDay = utc.slice(0, utc.indexOf(",")) === local.slice(0, local.indexOf(","));
  const localPart = sameDay ? local.slice(local.indexOf(",") + 2) : local;

  return `${utc} UTC (${localPart} ${zone})`;
}

export function loginSuccessMessage(creds: StoredCredentials): string {
  return `Logged in as ${creds.email || "(unknown email)"}. Access token expires ${formatExpiry(
    creds.expiresAt,
  )}, and refreshes automatically — you should not need to sign in again until the refresh token itself expires.`;
}

// Minimal page served at /callback: parse the token fragment, clear it from
// history before any network call, POST it to /token, and show a one-line
// status. No dynamic server-side values are interpolated into the page, so it
// needs no JS-string escaping; the only dynamic content (an error string) is
// HTML-escaped client-side.
export function callbackHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>CloudYali — CLI sign-in</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #202124; line-height: 1.55; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  p { color: #5f6368; margin: 0; }
  .err { color: #a8261c; word-break: break-word; }
</style>
</head>
<body>
  <h1 id="status">Finishing CloudYali sign-in…</h1>
  <p id="detail">Handing your session to the local CLI. You can close this tab once it confirms.</p>
<script>
(function () {
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function set(status, detail, isError) {
    document.getElementById('status').textContent = status;
    var d = document.getElementById('detail');
    d.innerHTML = detail;
    d.className = isError ? 'err' : '';
  }
  // Close the tab once the CLI has what it needs. window.close() only works on
  // a window script opened, and this one was opened by the OS handler — so
  // treat closing as an attempt, not a promise. If the browser refuses, say so
  // plainly rather than leaving a countdown that reached zero and did nothing.
  //
  // The countdown is cancellable on any interaction: the page is also the place
  // someone lands when they want to check what just happened, and pulling a tab
  // out from under a reader to save them one keystroke is a bad trade.
  function startAutoClose() {
    var left = 60;
    var el = document.getElementById('closing');
    var timer = null;

    function stop(message) {
      if (timer) { clearInterval(timer); timer = null; }
      if (el) el.textContent = message;
    }
    function tick() {
      if (el) el.textContent = 'Closing this tab in ' + left + 's.';
      if (left-- > 0) return;
      stop('Closing…');
      window.close();
      // Still here means the browser declined. Nothing is broken — the session
      // is saved either way — so this is information, not an error.
      setTimeout(function () { stop('Your browser will not let this tab close itself. You can close it.'); }, 300);
    }

    ['mousedown', 'keydown', 'touchstart'].forEach(function (evt) {
      window.addEventListener(evt, function () { stop('You can close this tab.'); }, { once: true });
    });

    tick();
    timer = setInterval(tick, 1000);
  }

  var data = Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)));
  // Clear the fragment before any network call so tokens never linger in history.
  history.replaceState(null, '', window.location.pathname);
  fetch('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).then(function (res) {
    if (data.error === 'access_denied') return set('Sign-in cancelled', 'You can close this tab.');
    if (res.ok) {
      set('You are signed in', 'The CLI has a valid session and will keep itself refreshed. <span id="closing"></span>');
      return startAutoClose();
    }
    return res.text().then(function (t) { set('Sign-in failed', escapeHtml(t || 'Unknown error.'), true); });
  }).catch(function (err) { set('Sign-in failed', escapeHtml(String(err)), true); });
})();
</script>
</body>
</html>`;
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, string>> {
  req.setEncoding("utf8");
  let buf = "";
  for await (const chunk of req) {
    buf += chunk;
    // Throwing breaks the loop and the async iterator tears the stream down.
    if (buf.length > 64 * 1024) throw new Error("body too large");
  }
  return JSON.parse(buf) as Record<string, string>;
}

function reply(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

// Fail fast when the portal is down instead of opening a dead browser tab
// and blocking the caller for the full login timeout.
export async function assertPortalReachable(): Promise<void> {
  let status: number | undefined;
  try {
    const res = await fetch(`${PORTAL_URL}/`, { method: "HEAD", signal: AbortSignal.timeout(3000) });
    status = res.status;
  } catch {
    throw new Error(
      `Portal at ${PORTAL_URL} is unreachable. Check your network connection, or set PORTAL_URL to a reachable portal that serves /cli-login.`,
    );
  }
  // 4xx is fine (SPAs often 404 HEAD requests); 5xx means the portal itself
  // is broken and the browser flow would dead-end.
  if (status >= 500) {
    throw new Error(
      `Portal at ${PORTAL_URL} returned HTTP ${status}. Fix the portal (or PORTAL_URL) before logging in.`,
    );
  }
}

/**
 * A sign-in that has been started and is waiting for the user to authorize.
 *
 * Two-phase on purpose. The verification code exists so the user can tell a
 * sign-in *they* started from one a rogue local process started — that process
 * can open the browser to /cli-login with its own redirect_uri and collect
 * full-account tokens if the user clicks through. The defence only works if the
 * user can see the code before deciding.
 *
 * The original flow printed it to stderr, which is a terminal for the CLI bin
 * but a log file nobody reads when the server runs under an MCP client. And the
 * tool result — the one channel the user does watch — arrived only after
 * authorization, too late to compare against. So the code has to come back from
 * the first call, before the browser decision, not after it.
 */
export type LoginSession = {
  /** The code to compare against the one on the portal page. */
  code: string;
  /** Where the browser was sent, for the case where it did not open. */
  portalUrl: string;
  startedAt: number;
  expiresAt: number;
  status: "pending" | "done" | "failed";
  credentials?: StoredCredentials;
  error?: Error;
  /** Settles when the browser flow finishes. Already has a catch attached. */
  done: Promise<StoredCredentials>;
  cancel(): void;
};

let current: LoginSession | null = null;

/** The in-flight sign-in, if any. Expired sessions are cleared on read. */
export function currentLogin(): LoginSession | null {
  if (current && current.status === "pending" && Date.now() > current.expiresAt) {
    current.cancel();
    current.status = "failed";
    current.error = new Error("Sign-in timed out waiting for browser authorization.");
  }
  return current;
}

export function clearLogin(): void {
  current?.cancel();
  current = null;
}

/**
 * Begin a sign-in: bind a loopback listener, open the browser, and return as
 * soon as the code is known. Does not wait for the user.
 */
export async function startLogin(
  timeoutMs = 5 * 60 * 1000,
  signal?: AbortSignal,
): Promise<LoginSession> {
  const existing = currentLogin();
  if (existing && existing.status === "pending") return existing;

  const expectedState = randomBytes(16).toString("hex");
  if (signal?.aborted) throw new Error("Login aborted by the caller before it started.");

  // Fail before opening a browser tab if the portal is down.
  await assertPortalReachable();

  let settle: (c: StoredCredentials) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const done = new Promise<StoredCredentials>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/callback") {
      reply(res, 200, callbackHtml(), "text/html; charset=utf-8");
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      try {
        const body = await readJsonBody(req);
        if (!body.state || body.state !== expectedState) {
          reply(res, 400, "state mismatch");
          fail(new Error("state mismatch — possible CSRF, login aborted"));
          server.close();
          return;
        }
        if (body.error === "access_denied") {
          reply(res, 200, "cancelled");
          fail(new Error("Login cancelled by the user in the browser."));
          setTimeout(() => server.close(), 200);
          return;
        }
        if (!body.access_token || !body.refresh_token) {
          reply(res, 400, "missing tokens in callback");
          fail(new Error("Portal did not return access_token/refresh_token"));
          server.close();
          return;
        }
        const expiresAt = Number.parseInt(body.expires_at ?? "0", 10);
        const stored: StoredCredentials = {
          email: body.email ?? "",
          accessToken: body.access_token,
          ...(body.id_token ? { idToken: body.id_token } : {}),
          refreshToken: body.refresh_token,
          expiresAt:
            Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : nowEpochSeconds() + 3600,
          savedAt: nowEpochSeconds(),
        };
        saveCredentials(stored);
        reply(res, 200, "ok");
        // Give the browser a beat to render the success page before we close.
        setTimeout(() => server.close(), 200);
        settle(stored);
        return;
      } catch (err) {
        reply(res, 500, String(err));
        fail(err instanceof Error ? err : new Error(String(err)));
        server.close();
        return;
      }
    }
    reply(res, 404, "not found");
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

  // 127.0.0.1, not localhost: the server binds IPv4-only, and on IPv6-first
  // systems `localhost` can resolve to ::1 with no fallback.
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const code = verificationCodeFromState(expectedState);
  const portalUrl = `${PORTAL_URL}/cli-login?redirect_uri=${encodeURIComponent(
    redirectUri,
  )}&state=${expectedState}&code=${encodeURIComponent(code)}`;

  const timer = setTimeout(() => {
    server.close();
    fail(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser login.`));
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  const onAbort = () => {
    server.close();
    fail(new Error("Login aborted by the caller."));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const session: LoginSession = {
    code,
    portalUrl,
    startedAt: Date.now(),
    expiresAt: Date.now() + timeoutMs,
    status: "pending",
    done,
    cancel() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      server.close();
    },
  };

  done.then(
    (creds) => {
      session.status = "done";
      session.credentials = creds;
      clearTimeout(timer);
    },
    (err: Error) => {
      session.status = "failed";
      session.error = err;
      clearTimeout(timer);
    },
  );

  // Still useful for the CLI bin, where stderr is a terminal the user reads.
  process.stderr.write(`Opening browser to ${portalUrl}\n`);
  process.stderr.write(
    `If it does not open automatically, paste that URL into a browser where you are signed in to ${PORTAL_URL}.\n`,
  );
  process.stderr.write(
    `Verification code: ${code} — only authorize if the browser page shows this exact code.\n`,
  );
  openBrowser(portalUrl);

  current = session;
  return session;
}

/**
 * Start a sign-in and wait for it to finish.
 *
 * The blocking form, kept for the `cloudyali-mcp-login` bin where the user is
 * watching a terminal. The MCP tool uses startLogin + polling instead, so the
 * code reaches the user before they are asked to trust the browser page.
 */
export async function awaitLogin(
  timeoutMs = 5 * 60 * 1000,
  signal?: AbortSignal,
): Promise<StoredCredentials> {
  const session = await startLogin(timeoutMs, signal);
  try {
    return await session.done;
  } finally {
    if (current === session) current = null;
  }
}

async function main() {
  try {
    const creds = await awaitLogin();
    process.stderr.write(`\n${loginSuccessMessage(creds)}\nCredentials saved.\n`);
  } catch (err) {
    console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Only run the CLI flow when this file is invoked directly (e.g.,
// `node dist/login.js` or the cloudyali-mcp-login bin). When imported by
// index.ts to expose login as an MCP tool, we just need the awaitLogin export.
if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
