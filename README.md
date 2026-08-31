# CloudYali MCP server

MCP server that exposes the [CloudYali](https://cloudyali.io) API — cloud **cost
reports**, **budgets**, **savings recommendations**, **cost anomalies**, and
**resource inventory** — to Claude and other MCP-capable AI clients.
Browser-based sign-in with automatic token refresh; **hard-locked to read-only**
operations.

Ask things like *"which services cost us the most last month?"*,
*"are we on track against our budgets?"*, or *"any cost anomalies this week?"*
— the assistant discovers the right CloudYali API call and runs it for you.
See [What you can ask](#what-you-can-ask) for more.

Requires a CloudYali account (sign in at [console.cloudyali.io](https://console.cloudyali.io)).

## Setup

### 1. Get the code and build it

The server lives in the CloudYali monorepo under `mcp-servers/cloudyali`.
Requires Node.js 18+ and git on both platforms.

**macOS / Linux**

```bash
git clone https://github.com/cloudyali/rajgad.git
cd rajgad/mcp-servers/cloudyali
npm install          # installs deps and builds dist/ via the prepare script
ls dist/index.js && npm test   # verify the build
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/cloudyali/rajgad.git
cd rajgad\mcp-servers\cloudyali
npm install          # installs deps and builds dist\ via the prepare script
Test-Path dist\index.js; npm test   # verify the build
```

> **npm install (coming soon):** once published, the clone/build step disappears
> and every snippet below can use `npx -y @cloudyali/mcp-server` instead of
> `node <path>/dist/index.js`. The package is not on npm yet — build from source
> for now.

### 2. Register it with your MCP client

Use the **absolute path** to `dist/index.js` from step 1.

**Claude Code**

macOS / Linux:

```bash
claude mcp add cy -- node /path/to/rajgad/mcp-servers/cloudyali/dist/index.js
```

Windows:

```powershell
claude mcp add cy -- node C:\path\to\rajgad\mcp-servers\cloudyali\dist\index.js
```

> **Tip:** the name you register the server under becomes the tool prefix
> (`mcp__cy__search_actions`). A short name like `cy` keeps tool names readable.
> The tool descriptions recognize "CloudYali", "cy", and "cloud cost", so the
> assistant picks them up from natural phrasing either way.

Run `/mcp` to confirm `cy: connected`.

**Claude Desktop** — add to `claude_desktop_config.json`
(Settings → Developer → Edit Config; the file lives at
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and
`%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "cloudyali": {
      "command": "node",
      "args": ["/path/to/rajgad/mcp-servers/cloudyali/dist/index.js"]
    }
  }
}
```

On Windows, wrap with `cmd /c`:

```json
{
  "mcpServers": {
    "cloudyali": {
      "command": "cmd",
      "args": ["/c", "node", "C:\\path\\to\\rajgad\\mcp-servers\\cloudyali\\dist\\index.js"]
    }
  }
}
```

Restart Claude Desktop after editing the config.

**Other clients** — this is a standard stdio MCP server, so it runs in any
client that launches local MCP servers. Most (Cursor, Gemini CLI, Cline,
Windsurf, …) accept the same `mcpServers` block as Claude Desktop. Two common
ones use a different shape:

*OpenAI Codex CLI* — TOML in `~/.codex/config.toml`
(`%USERPROFILE%\.codex\config.toml` on Windows):

```toml
[mcp_servers.cloudyali]
command = "node"
args = ["/path/to/rajgad/mcp-servers/cloudyali/dist/index.js"]
```

*VS Code* — `.vscode/mcp.json`, where the top-level key is `servers` (not
`mcpServers`):

```json
{
  "servers": {
    "cloudyali": {
      "command": "node",
      "args": ["/path/to/rajgad/mcp-servers/cloudyali/dist/index.js"]
    }
  }
}
```

> **Web-based hosts** (ChatGPT, claude.ai in the browser) can't spawn a local
> process, so they can't use this stdio build — they'd need a remote HTTP MCP
> server (a separate hosted deployment), which isn't available yet.

### 3. Sign in

On your first data call you'll be prompted to authenticate. Run the **`login`**
tool — or just ask Claude to *"log in to CloudYali"*. It:

1. Opens your browser to the CloudYali console's authorize page (gated by the
   normal sign-in, including MFA/SSO).
2. Prints a short **verification code** — authorize only if the browser shows the
   same code.
3. Saves a refresh token to `~/.cloudyali-mcp/credentials.json`
   (`%USERPROFILE%\.cloudyali-mcp\credentials.json` on Windows). The file is
   created with mode `0600` on macOS/Linux; on Windows it is protected by your
   user profile's ACLs.

Tokens refresh automatically; you won't sign in again until the refresh token
itself expires. Tokens travel only in the browser URL fragment to a localhost
listener — never to a remote server or any server log.

**Non-interactive alternative:** set `CLOUDYALI_JWT` to a Cognito access token to
skip the browser flow entirely (useful for CI/headless use). Authentication is
identical in every client: browser `login` tool where a browser is available,
`CLOUDYALI_JWT` otherwise.

## What you can ask

**Cost**

- *"Break down last month's AWS bill by service."*
- *"Which five services cost us the most this month, across every cloud?"*
- *"Show daily GCP spend for June as a chart."*
- *"Compare this month's total spend to last month — what changed?"*

**Budgets**

- *"How are we tracking against our budgets?"*
- *"List all budgets with their amounts and periods."*
- *"Which resources drove the production budget's spend in June?"*
- *"Has the data-transfer budget fired any alerts in the last month?"*

**Recommendations**

- *"What are our top savings opportunities right now?"*
- *"List open recommendations for EBS volumes with more than $50/month savings."*
- *"How much could we save in total if we actioned every recommendation?"*
- *"Who is assigned to recommendation 123, and what's its status history?"*

**Anomalies**

- *"Any cost anomalies in the last 7 days?"*
- *"Summarize anomaly count and impact for the quarter."*
- *"Show the root cause breakdown for anomaly `<id>`."*

**Inventory**

- *"How many EC2 instances do we have, per region?"*
- *"Find all resources tagged environment=prod that are still active."*
- *"Search inventory for anything named 'prod-web'."*
- *"What did instance i-0abc123 cost last month?"*
- *"What changed on this security group's configuration recently?"*

**Prompting tips:** include a date range when you care about one (otherwise
sensible defaults apply — usually the last 30–90 days), name the cloud provider
if you want just one, and for filter values you're unsure about, ask the
assistant to *"list the available filters first"* (it will call `cost.filters`
or the inventory lookups). Spot-check important numbers against the console —
the data is identical; the assistant's aggregation choices may not match the
view you have in mind.

## Tools

| Tool | Purpose |
|---|---|
| `search_actions(query, category?, limit?)` | Find a read-only API action by natural-language query. |
| `execute_action(id, path_params?, query_params?, body?)` | Run an action by id. Returns `{ status, ok, body }`. |
| `list_categories()` | Overview: counts per category, base URL, auth source. |
| `login()` | Browser-based CloudYali sign-in. |

The catalog covers **Cost** (`cost.report`, `cost.aggregate`, `cost.spend`,
`cost.filters`, `cost.filter_parameters_for_budgets`), **Cost-savings
lifecycle** (`recommendations.list` — the opportunity queue with lifecycle
filters, `recommendations.summary` — KPI funnel + projected/realized savings,
`recommendations.get` — per-opportunity detail with runbook / why / provenance,
and `recommendations.transition` — the one write: acknowledge / start /
implement / ignore / un-ignore / revert), **Budgets**
(`budgets.list`, `.summary`, `.get`, `.resources`, `.history`,
`.config_history`, `.alert_history` — reads only; create/update/delete stay in
the portal), **Anomalies** (`anomalies.list`, `.summary`, `.get`,
`.preferences_get`), and
**Inventory** (`inventory.list`, `.search`, `.get`, `.stats`,
`.resource_costs`, `.history`, plus provider/type/region/account/tag lookups).

Call `search_actions` first to discover the right id.

## Configuration

All optional — the defaults point at CloudYali production.

| Env var | Default | Notes |
|---|---|---|
| `CLOUDYALI_API_URL` | `https://api.cloudyali.io` | Base URL of the CloudYali API. |
| `PORTAL_URL` | `https://console.cloudyali.io` | Portal that serves the browser login page (`/cli-login`). |
| `CLOUDYALI_JWT` | _(unset)_ | One-shot Cognito access-token override; bypasses the credentials file and login flow. |
| `CLOUDYALI_CREDS_DIR` | `~/.cloudyali-mcp` | Credentials directory override. |

Pass these via the `env` block of your MCP client config when overriding.

## Read-only by construction, with one allowlisted write

This server is read-only **except** for a single, explicitly allowlisted write:
the cost-savings lifecycle transition (`recommendations.transition`), so AI
agents can *act on* the savings model, not just query it (US-032). It appends
audit events + ledger records — it never deletes. Enforcement layers:

1. **Catalog** — no mutating endpoint is present in `src/catalog.ts` except the
   one allowlisted transition; account/customer/user/anomaly/preference writes
   simply have no entry to invoke.
2. **Write allowlist** — a non-`readOnly` action executes only if its id is in
   `WRITE_ALLOWLIST` **and** it is a `POST` to a `/v1/savings/` path. Everything
   else marked `readOnly: false` is rejected at runtime.
3. **Method allowlist** — only `GET` and `POST` actions execute; `PUT`/`DELETE`
   are always blocked.
4. **Path denylist** — account-management, customer, user-administration, sync,
   marketplace, and provisioning endpoints are blocked regardless of method or
   `readOnly` flag.

> **Security caveat:** these restrictions live in this client. The token it holds
> is a normal full-privilege CloudYali user token, so the guarantees protect
> against the *model* taking out-of-scope actions — not against anyone who can
> read `~/.cloudyali-mcp/credentials.json`. Protect that file like a password.
> Make all other state changes (anomaly dismissal, settings, assignments) in the
> portal at [console.cloudyali.io](https://console.cloudyali.io).

## Develop locally

From the monorepo:

```bash
cd rajgad/mcp-servers/cloudyali
npm install        # also builds dist/ via the prepare script
npm test           # vitest (catalog contract, param-shape, M9 parity)
npm run smoke      # boot dist/index.js over stdio + MCP handshake (npx smoke)
npm run dev        # tsc --watch
npm run login      # exercises the live browser login against the console
```

`npm run smoke` boots the built server exactly as `npx cloudyali-mcp` would,
performs the MCP handshake, and asserts the cost-savings lifecycle catalog is
reachable with zero decommissioned `/v1/recommendations` endpoints. Set
`CLOUDYALI_API_URL` (e.g. a docker-compose stack) to also run a live
`recommendations.list` call and confirm it hits `/v1/savings/opportunities`.

`npm run login` uses the production console by default; set `PORTAL_URL` to
override it (e.g. `PORTAL_URL=http://localhost:3000` against a local portal).

### Run your local build in a client

Point the client at the built entry file. The server runs `dist/`, so
**rebuild and reconnect after every change**.

macOS / Linux:

```bash
npm run build
claude mcp add cloudyali-dev -- node "$(pwd)/dist/index.js"
# after editing src/: npm run build, then reconnect (/mcp or restart the client)
```

Windows (PowerShell):

```powershell
npm run build
claude mcp add cloudyali-dev -- node "$PWD\dist\index.js"
# after editing src\: npm run build, then reconnect (/mcp or restart the client)
```

Add a read-only endpoint by appending to `src/catalog.ts` (`readOnly: true`) plus
a test. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Troubleshooting

- **"No credentials found"** — run the `login` tool (or `npm run login` locally).
- **"Token refresh failed … credentials have been cleared"** — the refresh token
  expired or was revoked. Sign in again.
- **"Token refresh failed … credentials were kept"** — transient network/Cognito
  error; just retry.
- **"Portal at … is unreachable"** — the console (or your `PORTAL_URL`) is down or
  not serving `/cli-login`; the login flow fails fast instead of hanging.
- **401s after login** — confirm `CLOUDYALI_API_URL` points at the same CloudYali
  environment you signed in to.
- **Client shows the server as failed/disconnected** — check that the `dist/`
  path in your client config is absolute and that `npm install` completed (it
  builds `dist/`); run `node <path>/dist/index.js` manually to see startup
  errors.

## License

[MIT](LICENSE) © CloudYali
