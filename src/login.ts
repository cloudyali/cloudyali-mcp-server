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

export function loginSuccessMessage(creds: StoredCredentials): string {
  const expIso = new Date(creds.expiresAt * 1000).toISOString();
  return `Logged in as ${creds.email || "(unknown email)"}. Access token expires ${expIso}. Refresh happens automatically; you should not need to log in again until the refresh token itself expires.`;
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
  var data = Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)));
  // Clear the fragment before any network call so tokens never linger in history.
  history.replaceState(null, '', window.location.pathname);
  fetch('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).then(function (res) {
    if (data.error === 'access_denied') return set('Sign-in cancelled', 'You can close this tab.');
    if (res.ok) return set('You are signed in', 'The CLI has a valid session and will keep itself refreshed. You can close this tab.');
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

export async function awaitLogin(
  timeoutMs = 5 * 60 * 1000,
  signal?: AbortSignal,
): Promise<StoredCredentials> {
  const expectedState = randomBytes(16).toString("hex");

  // If the caller already cancelled (e.g. the MCP request was aborted before we
  // even reached the portal check), don't open a browser or bind a listener.
  if (signal?.aborted) {
    throw new Error("Login aborted by the caller before it started.");
  }

  await assertPortalReachable();

  return new Promise<StoredCredentials>((resolve, reject) => {
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
            reject(new Error("state mismatch — possible CSRF, login aborted"));
            server.close();
            return;
          }
          if (body.error === "access_denied") {
            reply(res, 200, "cancelled");
            reject(new Error("Login cancelled by the user in the browser."));
            setTimeout(() => server.close(), 200);
            return;
          }
          if (!body.access_token || !body.refresh_token) {
            reply(res, 400, "missing tokens in callback");
            reject(new Error("Portal did not return access_token/refresh_token"));
            server.close();
            return;
          }
          const expiresAt = Number.parseInt(body.expires_at ?? "0", 10);
          const stored: StoredCredentials = {
            email: body.email ?? "",
            accessToken: body.access_token,
            ...(body.id_token ? { idToken: body.id_token } : {}),
            refreshToken: body.refresh_token,
            expiresAt: Number.isFinite(expiresAt) && expiresAt > 0
              ? expiresAt
              : nowEpochSeconds() + 3600,
            savedAt: nowEpochSeconds(),
          };
          saveCredentials(stored);
          reply(res, 200, "ok");
          // Give the browser a beat to render the success page before we close.
          setTimeout(() => server.close(), 200);
          resolve(stored);
          return;
        } catch (err) {
          reply(res, 500, String(err));
          reject(err instanceof Error ? err : new Error(String(err)));
          server.close();
          return;
        }
      }
      reply(res, 404, "not found");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      // 127.0.0.1, not localhost: the server binds IPv4-only, and on
      // IPv6-first systems `localhost` can resolve to ::1 with no fallback.
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const code = verificationCodeFromState(expectedState);
      const portalUrl = `${PORTAL_URL}/cli-login?redirect_uri=${encodeURIComponent(redirectUri)}&state=${expectedState}&code=${encodeURIComponent(code)}`;

      process.stderr.write(`Opening browser to ${portalUrl}\n`);
      process.stderr.write(`If it does not open automatically, paste that URL into a browser where you are signed in to ${PORTAL_URL}.\n`);
      process.stderr.write(`Verification code: ${code} — only authorize if the browser page shows this exact code.\n`);
      openBrowser(portalUrl);
    });

    setTimeout(() => {
      server.close();
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser login.`));
    }, timeoutMs).unref();

    // Caller cancellation (client sent notifications/cancelled, or the transport
    // closed): stop the listener and reject instead of holding the browser flow
    // open for the full timeout.
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          server.close();
          reject(new Error("Login aborted by the caller."));
        },
        { once: true },
      );
    }
  });
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
