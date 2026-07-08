# Security Policy

## Reporting a vulnerability

Please report security issues privately to **security@cloudyali.io**. Do not open
a public GitHub issue for a suspected vulnerability.

Include as much of the following as you can:

- A description of the issue and its impact.
- Steps to reproduce (a proof of concept if you have one).
- The affected version (`npm ls @cloudyali/mcp-server` or the commit SHA) and
  your OS / Node.js version.

We aim to acknowledge a report within **3 business days** and to provide a
remediation timeline after triage. We'll credit reporters who wish to be named
once a fix ships.

## Scope and threat model

This is a local, read-only stdio MCP server. A few notes that commonly come up:

- **Read-only by construction.** Only `GET` and read-style `POST` catalog actions
  are exposed; write methods and account/customer/user/sync/marketplace/
  provisioning endpoints are rejected at runtime (`BLOCKED_PATH_PATTERNS` in
  `src/catalog.ts`). Reports of a write path reaching the API are in scope.
- **Credential storage.** A refresh token is stored at
  `~/.cloudyali-mcp/credentials.json` (mode `0600`; directory `0700`). Tokens are
  never written to stdout or logs. Issues in the token-at-rest or the browser
  login flow (`src/login.ts`, `src/tokenStore.ts`) are in scope.
- **Public Cognito identifiers.** The Cognito user-pool ID and the SPA app
  client ID in `src/config.ts` are **not secrets** — they are public identifiers
  of a secret-less browser app client, exposed by design (as in any Amplify/
  Cognito SPA bundle). They grant nothing without a valid refresh token, so
  please don't file them as leaked credentials.
- **Transitive `npm audit` advisories.** Advisories in `express` / `hono` / `qs`
  come from the MCP SDK's HTTP-transport code path, which this **stdio** server
  never loads; `vitest` / `vite` / `esbuild` findings are dev-only. If you find a
  way to actually reach one of these from the shipped stdio path, that is in
  scope and we'd like to hear about it.
