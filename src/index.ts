#!/usr/bin/env node
// CloudYali MCP server.
//
// Exposes:
//   - search_actions: discover available CloudYali API endpoints
//   - execute_action: call one by id with params + body
//   - list_categories: quick orientation of available actions
//   - login: browser-based sign-in
//
// Designed for the search+execute pattern so the full catalog does not flood the
// model's context window. Tool definitions and dispatch live in handlers.ts so
// they are unit-testable; this file is only server wiring.
//
// Auth: a fresh Cognito access token is obtained on every API call.
// Precedence: CLOUDYALI_JWT env > stored credentials at ~/.cloudyali-mcp/credentials.json.
//
// Configuration (env vars):
//   CLOUDYALI_API_URL       Base URL of the CloudYali API (default https://api.cloudyali.io)
//   CLOUDYALI_JWT           Override: paste a Cognito access JWT, skips file/refresh logic.
//   PORTAL_URL              Portal that serves /cli-login (default https://console.cloudyali.io)
//   CLOUDYALI_CREDS_DIR     Override credentials directory (default ~/.cloudyali-mcp)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PACKAGE_VERSION } from "./config.js";
import { TOOLS, handleToolCall } from "./handlers.js";
import { isDirectRun } from "./cli.js";
import { RESOURCES, readResource } from "./resources.js";

export const server = new Server(
  {
    name: "cloudyali",
    version: PACKAGE_VERSION,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) =>
  handleToolCall(req.params.name, req.params.arguments, extra.signal),
);

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
  contents: [readResource(req.params.uri)],
}));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only connect the stdio transport when run directly (node dist/index.js / the
// cloudyali-mcp bin). Importing this module (e.g. in tests) registers the
// handlers but does not start the server.
if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    console.error("cloudyali-mcp failed to start:", err);
    process.exit(1);
  });
}
