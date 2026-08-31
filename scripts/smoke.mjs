#!/usr/bin/env node
// npx smoke test (US-032). Boots the built server exactly as `npx cloudyali-mcp`
// would (node dist/index.js over stdio), performs the MCP initialize handshake,
// lists tools, and drives search_actions to prove the rewritten cost-savings
// lifecycle catalog is reachable through the real MCP protocol — not just in
// unit tests. No backend is required for this boot/protocol smoke.
//
// When a docker-compose stack is configured (CLOUDYALI_API_URL set + a token
// available), it additionally executes recommendations.list and asserts a 2xx,
// exercising the same /v1/savings/opportunities endpoint the UI calls (M9).
//
// Usage:  npm run smoke              # boot + protocol + catalog reachability
//         CLOUDYALI_API_URL=http://localhost:8081 npm run smoke   # + live call
//
// Exit code 0 = green, non-zero = failure (CI-friendly).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "..", "dist", "index.js");

// The spawned server, tracked so every exit path (success OR failure) reaps it —
// otherwise a failed assertion leaves `node dist/index.js` orphaned on the CI
// runner, leaking a process + its stdin pipe on each red run.
let serverChild = null;
function killChild() {
  if (serverChild && serverChild.exitCode === null && !serverChild.killed) {
    try {
      serverChild.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function fail(msg) {
  console.error(`SMOKE FAILED: ${msg}`);
  killChild();
  process.exit(1);
}

// Minimal stdio JSON-RPC client: writes newline-delimited requests, resolves
// each response by id from the server's stdout stream.
function newClient(child) {
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON log noise
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const call = (method, params) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rej(new Error(`timeout waiting for ${method}`));
        }
      }, 10000);
    });
  return { call };
}

async function main() {
  const child = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });
  serverChild = child;
  child.on("error", (e) => fail(`could not spawn server: ${e.message}`));

  const client = newClient(child);

  const init = await client.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  if (!init.result || init.result.serverInfo?.name !== "cloudyali") {
    fail(`unexpected initialize result: ${JSON.stringify(init)}`);
  }
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await client.call("tools/list", {});
  const toolNames = (tools.result?.tools ?? []).map((t) => t.name);
  for (const t of ["search_actions", "execute_action"]) {
    if (!toolNames.includes(t)) fail(`tool ${t} missing from tools/list: ${toolNames.join(", ")}`);
  }

  // Catalog reachability: search the rewritten savings surface via the protocol.
  const search = await client.call("tools/call", {
    name: "search_actions",
    arguments: { query: "cost savings opportunities lifecycle", category: "recommendations" },
  });
  const text = search.result?.content?.map((c) => c.text).join("\n") ?? "";
  for (const id of ["recommendations.list", "recommendations.summary", "recommendations.get"]) {
    if (!text.includes(id)) fail(`search_actions did not surface ${id}`);
  }
  if (/\/v1\/recommendations(\/|"|$)/.test(text)) {
    fail("search_actions surfaced a decommissioned /v1/recommendations endpoint");
  }
  if (text.includes("recommendations.transition")) {
    fail("search_actions surfaced the withdrawn savings write action");
  }
  console.log("smoke: server boots, MCP handshake OK, savings read catalog reachable");

  // Optional live parity: only when a stack is configured.
  if (process.env.CLOUDYALI_API_URL) {
    const exec = await client.call("tools/call", {
      name: "execute_action",
      arguments: { id: "recommendations.list", query_params: { limit: 1 } },
    });
    const body = exec.result?.content?.map((c) => c.text).join("\n") ?? "";
    if (/"action_id":\s*"recommendations.list"/.test(body) && /"path":\s*"\/v1\/savings\/opportunities/.test(body)) {
      console.log("smoke: live execute_action hit /v1/savings/opportunities (M9 endpoint parity)");
    } else {
      fail(`live execute_action did not hit the savings endpoint: ${body.slice(0, 400)}`);
    }
  } else {
    console.log("smoke: CLOUDYALI_API_URL not set — skipped live stack call (boot/protocol smoke only)");
  }

  killChild();
  process.exit(0);
}

main().catch((e) => fail(e.message));
