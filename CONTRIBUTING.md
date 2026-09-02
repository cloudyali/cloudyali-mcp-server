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

## Rebuilding is not enough — restart the client

The MCP client spawns this server once and keeps the process. `npm run build`
rewrites `dist/`; it does nothing to a process already running, which goes on
answering with the tool list and the pages it started with. From the outside that
is indistinguishable from a build that failed, and it has cost three rounds of
wrong diagnosis in a single day.

After a build, **restart the MCP client** before concluding anything about
whether a change worked.

`serverInfo.version` reports the live tool count — `0.1.0 (32 tools)` — so a
stale process is visible at a glance: compare it against what the client shows.
`src/build-freshness.test.ts` covers the other half, a `dist/` that has fallen
behind `src/`.

## What may leave this server

Everything that reaches a model — tool responses, tool descriptions, input schemas, resource bodies,
warning strings, error text — states what the reader needs and never how the backend works. No
internal component names, storage design, refresh cadence, table or column names, SQL, or internal
identifiers. Include instead what changes a reader's behaviour: whether a figure is an estimate,
whether two figures are comparable, how a record was matched.

The test: does removing it change what a reader would *do*?

Over-correcting is also a failure. A reader who cannot tell an estimate from a billed figure has
been failed too. Reframe rather than delete — state the reliability, drop the cause.

Two reasons this is enforced rather than advised. It has shipped twice, both times written by
someone trying to be helpful; explaining the mechanism feels like generosity and reads from outside
as a map. And this server reaches the API over HTTP like any other client, so it cannot keep such a
claim true — the knowledge came from reading the backend, and nothing will tell it when that stops
being accurate.

`src/leak-scan.test.ts` enforces it and fails the build. **If you add a surface that reaches a
model, add it to that scanner.** It also asserts the de-leaked text still carries the instructions
that change behaviour, so it cannot be satisfied by saying nothing.

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
