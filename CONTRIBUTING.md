# Contributing

Thanks for your interest in improving the CloudYali MCP server.

## Development setup

```bash
npm install        # also builds dist/ via the prepare script
npm run dev        # tsc --watch for iterative work
npm test           # vitest
npm run coverage   # vitest with coverage
```

Requires Node.js 20+.

### Exercising the login flow

The browser login flow opens `${PORTAL_URL}/cli-login`, which defaults to the
production console, so `npm run login` works out of the box. Set the
`PORTAL_URL` env var to override it.

## Tests are required

This project follows test-driven development (Red → Green → Refactor):

1. Write a failing test that pins the behavior you want.
2. Write the minimum code to make it pass.
3. Refactor with the suite green.

Every behavior change ships with a test. Name tests after the behavior, not the
implementation. Keep the suite green before opening a PR (`npm test`).

## Adding API actions

The exposed surface is **read-only by construction**. To add an endpoint:

- Add an entry to `src/catalog.ts` with `readOnly: true`.
- Only `GET` and read-style `POST` actions are permitted; write methods and
  account/customer/user/sync/marketplace/provisioning endpoints (enforced by
  `BLOCKED_PATH_PATTERNS`) are rejected at runtime.
- Add a test covering the new action's request construction.

## Pull requests

- Keep changes focused; one logical change per PR.
- Update `README.md` and `CHANGELOG.md` when behavior or configuration changes.
- Do not commit secrets or real tokens.

## Releasing

Maintainers publish to npm from a clean `main`:

```bash
npm version <patch|minor|major>
git push --follow-tags
```

The `npm version` step runs a hook (`scripts/sync-version.mjs`) that propagates
the new version into `server.json`, so both stay aligned. CI publishes the
tagged version (see `.github/workflows/publish.yml`).

## Roadmap

- MCPB bundle for Claude Desktop one-click install (no Node required). Parked for
  now — the npm / `npx` path is the current distribution.
