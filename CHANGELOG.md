# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-29

First public release.

### Added
- `search_actions`, `execute_action`, and `list_categories` tools over the
  read-only CloudYali API catalog (cost, budgets, recommendations, anomalies,
  and inventory).
- Browser-based CloudYali sign-in (`login` tool + `cloudyali-mcp-login` bin)
  with verification-code confirmation and automatic token refresh. Defaults to
  the production console; override with `PORTAL_URL`.
- Read-only enforcement: catalog allowlist, a `GET`/`POST` method gate, and a
  path denylist covering account-management, customer, user, sync, marketplace,
  and provisioning endpoints.
- npm packaging (Node.js 20+, runnable via `npx`) and `server.json` (MCP registry).
- Tool descriptions recognize the "cy" shorthand for CloudYali.
