#!/usr/bin/env node
// Boot smoke test: runs the built server exactly as `npx cloudyali-mcp` would
// (node dist/index.js over stdio), completes the MCP handshake, and drives the
// real protocol against a throwaway stub API.
//
// The point is not coverage — vitest has that. The point is that the guardrails
// survive the whole path. Every defence in this server is a string that has to
// reach the model through tools/call, and a unit test asserting present()
// returns the right sentence proves nothing about whether the sentence is still
// attached by the time it leaves the process. Twice now a control has been
// correct in isolation and inert in practice: the login verification code went
// to stderr, and this very script silently passed for weeks by asserting the
// existence of tools that had been moved behind a flag.
//
// So the assertions here are end-to-end and deliberately blunt:
//   1. The default tool surface is the typed one, and the raw proxy is NOT on it.
//   2. A cost call whose filter the API will silently drop carries the warning
//      out through the protocol, ahead of the numbers.
//   3. A resource_names filter carries the dataset-switch warning.
//   4. The advanced escape hatch still works when explicitly enabled.
//   5. Nothing in a tool result echoes an internal identifier.
//
// Usage:  npm run smoke
// Exit code 0 = green, non-zero = failure (CI-friendly).

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "..", "dist", "index.js");

const children = new Set();
let stub = null;

function cleanup() {
  for (const c of children) {
    if (c.exitCode === null && !c.killed) {
      try {
        c.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  children.clear();
  if (stub) {
    try {
      stub.close();
    } catch {
      /* already closed */
    }
    stub = null;
  }
}

function fail(msg) {
  console.error(`SMOKE FAILED: ${msg}`);
  cleanup();
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

// ---------------------------------------------------------------------------
// A stub CloudYali API.
//
// It answers every cost call with a body carrying an internal customer_id and a
// database column name — the two things the hardening exists to stop. If either
// reaches a tool result, the projection layer has regressed and the smoke is red.
// ---------------------------------------------------------------------------
const LEAK_MARKERS = ["customer_id", "210", "mv_cur_data_daily", "unblended_cost"];

function startStubApi() {
  return new Promise((res) => {
    const srv = createServer((req, reply) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        reply.writeHead(200, { "content-type": "application/json" });
        reply.end(
          JSON.stringify({
            customer_id: 210,
            internal_table: "mv_cur_data_daily",
            summary: { total: 39.78 },
            data: [
              { service: "AmazonEC2", cost: 39.78, unblended_cost: 39.78, customer_id: 210 },
            ],
            rows: [{ service: "AmazonEC2", cost: 39.78 }],
            resources: [
              { resource_id: "vol-0abc", has_cost_data: true, total_cost: 39.78, match_confidence: "high", customer_id: 210 },
              { resource_id: "gke-x", has_cost_data: true, total_cost: 4.92, match_confidence: "low", match_method: "labels", internal_table: "mv_cur_data_daily" },
            ],
          }),
        );
      });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, port: srv.address().port }));
  });
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

async function boot(env) {
  const child = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });
  children.add(child);
  child.on("error", (e) => fail(`could not spawn server: ${e.message}`));

  const client = newClient(child);
  const init = await client.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  assert(init.result?.serverInfo?.name === "cloudyali", `unexpected initialize result: ${JSON.stringify(init)}`);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { child, client };
}

const textOf = (r) => r.result?.content?.map((c) => c.text).join("\n") ?? "";

/** One AWS filter group, plus whatever extra conditions the case needs. */
const awsFilter = (extra) => [
  { operator: "AND", cloud_providers: [{ operator: "equals", value: ["AWS"] }], ...extra },
];

async function main() {
  const { srv, port } = await startStubApi();
  stub = srv;
  const apiEnv = {
    CLOUDYALI_API_URL: `http://127.0.0.1:${port}`,
    CLOUDYALI_JWT: "smoke-token",
    // A permissive bucket: the throttle is unit-tested on a virtual clock, and
    // making the smoke wait on real seconds only buys flakiness.
    CLOUDYALI_MCP_RATE_PER_MINUTE: "6000",
    CLOUDYALI_MCP_BURST: "100",
  };

  // -- 1. The default surface is the typed one -------------------------------
  const { client } = await boot(apiEnv);
  const tools = await client.call("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);

  for (const t of ["query_costs", "get_cost_breakdown", "list_budgets", "get_resource_costs", "login"]) {
    assert(names.includes(t), `typed tool ${t} missing from tools/list: ${names.join(", ")}`);
  }
  for (const t of ["search_actions", "execute_action", "list_categories"]) {
    assert(!names.includes(t), `raw proxy tool ${t} is advertised by default — it must be behind CLOUDYALI_MCP_ADVANCED`);
  }

  // -- 2. A silently-dropped filter warns, ahead of the numbers --------------
  const dropped = await client.call("tools/call", {
    name: "query_costs",
    arguments: {
      start_time: "2026-08-01T00:00:00Z",
      end_time: "2026-08-31T00:00:00Z",
      filters: awsFilter({ usage_types: [{ operator: "equals", value: ["VolumeUsage.gp3"] }] }),
    },
  });
  const droppedText = textOf(dropped);
  assert(/does not support filtering by usage_types/i.test(droppedText), `no dropped-filter warning: ${droppedText.slice(0, 300)}`);
  assert(
    droppedText.indexOf("WARNING") < droppedText.indexOf("39.78") || !droppedText.includes("39.78"),
    "the warning arrived after the total — a caveat read after the number is a caveat about a number already believed",
  );

  // -- 3. A resource_names filter warns about the dataset switch -------------
  const switched = await client.call("tools/call", {
    name: "query_costs",
    arguments: {
      start_time: "2026-08-01T00:00:00Z",
      end_time: "2026-08-31T00:00:00Z",
      filters: awsFilter({ resource_names: [{ operator: "equals", value: ["vol-0abc"] }] }),
      group_by_dimensions: ["usage_type"],
    },
  });
  const switchedText = textOf(switched);
  assert(/different dataset/i.test(switchedText), `no dataset-switch warning: ${switchedText.slice(0, 300)}`);
  assert(/zero spend/i.test(switchedText), "dataset-switch warning does not say an empty result is not zero spend");
  assert(/Unknown/.test(switchedText), "usage_type grouping under a resource filter did not warn that it collapses");

  // -- 4. Nothing echoes an internal identifier -----------------------------
  //
  // The WHOLE result, not just the prose: structuredContent is model context
  // too, and it is the half the projection layer exists to police. The stub
  // returns customer_id 210 and a matview name in every body, so a regression
  // in shapes.ts turns this red rather than shipping the screenshot that
  // started all of this.
  //
  // get_resource_costs is the load-bearing case: its present() returns the
  // shaped body wholesale, so it is the one tool where a regression in the
  // projection layer surfaces directly as tenant data in structuredContent.
  // (query_costs happens to rebuild its structured output from named fields, so
  // it would stay clean even with the projection torn out — a comforting green
  // that proves nothing. Checked by mutation, not by reading.)
  const priced = await client.call("tools/call", {
    name: "get_resource_costs",
    arguments: { resource_ids: ["vol-0abc", "gke-x"] },
  });
  const pricedText = textOf(priced);
  assert(/low confidence/i.test(pricedText), `get_resource_costs did not flag the low-confidence match: ${pricedText.slice(0, 300)}`);
  assert(/estimate/i.test(pricedText), "a label-inferred cost was not called an estimate");
  assert(/refreshed separately/i.test(pricedText), "get_resource_costs did not warn that its dataset differs from query_costs");

  for (const [label, res] of [["dropped-filter call", dropped], ["dataset-switch call", switched], ["resource-costs call", priced]]) {
    const whole = JSON.stringify(res.result ?? {});
    for (const marker of LEAK_MARKERS) {
      assert(!whole.includes(marker), `${label} leaked "${marker}" from the API body into the tool result`);
    }
  }

  // -- 5. A clean query says nothing --------------------------------------
  const clean = await client.call("tools/call", {
    name: "query_costs",
    arguments: {
      start_time: "2026-08-01T00:00:00Z",
      end_time: "2026-08-31T00:00:00Z",
      filters: awsFilter({ services: [{ operator: "equals", value: ["AmazonEC2"] }] }),
    },
  });
  assert(!/WARNING/.test(textOf(clean)), "a clean query emitted a warning — a warning on every call is one nobody reads");

  console.log("smoke: typed surface served, proxy hidden, filter + dataset warnings reach the model, no body leak");

  // -- 6. The advanced hatch still opens ------------------------------------
  const adv = await boot({ ...apiEnv, CLOUDYALI_MCP_ADVANCED: "1" });
  const advTools = await adv.client.call("tools/list", {});
  const advNames = (advTools.result?.tools ?? []).map((t) => t.name);
  for (const t of ["search_actions", "execute_action"]) {
    assert(advNames.includes(t), `CLOUDYALI_MCP_ADVANCED=1 did not restore ${t}`);
  }
  const search = await adv.client.call("tools/call", {
    name: "search_actions",
    arguments: { query: "cost savings opportunities lifecycle", category: "recommendations" },
  });
  const searchText = textOf(search);
  for (const id of ["recommendations.list", "recommendations.summary", "recommendations.get"]) {
    assert(searchText.includes(id), `search_actions did not surface ${id}`);
  }
  assert(!/\/v1\/recommendations(\/|"|$)/.test(searchText), "search_actions surfaced a decommissioned /v1/recommendations endpoint");
  assert(!searchText.includes("recommendations.transition"), "search_actions surfaced the withdrawn savings write action");

  console.log("smoke: advanced catalog reachable when explicitly enabled");

  cleanup();
  process.exit(0);
}

main().catch((e) => fail(e.stack ?? e.message));
