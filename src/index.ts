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
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { isDirectRun } from "./cli.js";
import { RESOURCES, readResource } from "./resources.js";

/**
 * The version the client sees, with the size of the surface it is actually
 * serving appended — `0.1.0 (31 tools)`.
 *
 * An MCP server is spawned once by the client and stays resident. Rebuilding
 * dist does nothing to the process already running, so a rebuilt-but-unrestarted
 * server keeps answering with the old tool list and looks, from the outside,
 * exactly like a build that did not work. That has now cost three rounds of
 * wrong diagnosis in a day, twice by me.
 *
 * package.json's version does not move between these changes, so it cannot tell
 * the two apart. The tool count does, and it is the thing that is stale in
 * practice: "31 tools" against a client showing 24 answers the question in one
 * glance, with no rebuild and nothing to run.
 *
 * Deliberately NOT a build timestamp or a commit hash: both change on every
 * build, and build-freshness.test.ts diffs a fresh compile against the committed
 * dist. A stamp would make that test fail on every single build — a guard broken
 * by the thing meant to help diagnose it.
 */
const SERVER_VERSION = `${PACKAGE_VERSION} (${TOOLS.length} tools)`;

export const server = new Server(
  {
    name: "cloudyali",
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
    // Clients MAY put this in the system prompt. It is the only push channel
    // this server has: tool definitions are pushed, resources are pulled, and a
    // rule about how to draw a chart is useless to a model that never thinks to
    // ask for it. See src/instructions.ts.
    instructions: SERVER_INSTRUCTIONS,
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
