// Tool definitions and the call dispatcher for the CloudYali MCP server.
// Kept separate from index.ts (which boots the stdio server on import) so this
// logic is unit-testable without starting a server.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { READ_ONLY_CATALOG, searchActions } from "./catalog.js";
import { AuthError, currentAuthSummary } from "./auth.js";
import { clearLogin, currentLogin, loginSuccessMessage, startLogin } from "./login.js";
import { executeAction } from "./execute.js";
import { CLOUDYALI_API_URL, CONSOLE_URL, PORTAL_URL } from "./config.js";
import { TOOL_BY_NAME, ToolArgError, callTool, toMcpTools } from "./tools/index.js";
import { RateLimitedError } from "./throttle.js";
import { describeTransportFailure, isTransportError } from "./errors.js";

const RAW_TOOLS: Tool[] = [
  {
    name: "search_actions",
    description:
      "Search the read-only CloudYali (\"cy\") API catalog for cloud cost, spend, budgets, cost-savings opportunities, cost anomalies, and resource inventory. Use this for any CloudYali / cy / cloud-cost / FinOps / cloud-inventory question. Returns matching actions with their IDs, descriptions, and parameter schemas. Call this first to discover the right action, then call execute_action with the chosen id. Scope: cost reports, aggregation, spend and filters; budgets; cost-savings opportunities; anomalies; and resource inventory. The figures match what the CloudYali portal shows. This server performs NO writes — every mutation is blocked, and administrative endpoints are not reachable at all. Make changes in the portal.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language search. Examples: 'cost trend last month', 'top savings recommendations', 'unresolved anomalies for AWS'.",
        },
        category: {
          type: "string",
          enum: ["cost", "budgets", "recommendations", "anomalies", "inventory"],
          description: "Optional category filter.",
        },
        limit: { type: "integer", description: "Max results. Default 10, clamped to 1–100." },
      },
      required: ["query"],
    },
    annotations: {
      title: "Search CloudYali actions",
      readOnlyHint: true,
      openWorldHint: false, // searches an in-memory catalog; no network
    },
  },
  {
    name: "execute_action",
    description:
      "Execute a read-only CloudYali API action by id. Use search_actions first to find the id and required params. Returns { status, ok, body } from the API. Writes and administrative endpoints are blocked and return an error.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Action id from search_actions, e.g. 'cost.report'." },
        path_params: {
          type: "object",
          description: "Path parameter values (e.g., { id: 42 } for /recommendations/:id).",
          additionalProperties: true,
        },
        query_params: {
          type: "object",
          description: "Query string parameter values. Array values are serialized as repeated params, except where the action's schema declares comma-joining.",
          additionalProperties: true,
        },
        body: {
          type: "object",
          description: "JSON body for POST/PUT requests. Ignored for GET/DELETE.",
          additionalProperties: true,
        },
      },
      required: ["id"],
    },
    annotations: {
      title: "Execute CloudYali action (read-only)",
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  {
    name: "list_categories",
    description:
      "Quick overview of the CloudYali (\"cy\") catalog: returns the counts of available actions per category, plus the configured base URL and auth source. Useful as a first orientation call when a user mentions CloudYali, cy, or cloud cost.",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      title: "List CloudYali catalog categories",
      readOnlyHint: true,
      openWorldHint: false, // reads local catalog + config only; no network
    },
  },
  {
    name: "login",
    description:
      "Sign in to CloudYali. Call once to start: a browser tab opens and this returns a verification code immediately. SHOW THAT CODE TO THE USER VERBATIM and tell them to authorize only if the browser page displays the same code — that check is what stops another program on their machine from stealing an authorization. Then call login again to complete. Returns quickly every time; it does not block waiting for the browser.",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      title: "Sign in to CloudYali",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

// The generic search_actions / execute_action pair is an escape hatch, not the
// product. It is the only route to a catalog action that no typed tool wraps
// yet, and its response still goes through the same projection — but it asks
// the model to do a catalog lookup before it can do work, and it cannot carry
// per-argument validation. Off unless explicitly enabled.
export const ADVANCED_ENABLED = process.env.CLOUDYALI_MCP_ADVANCED === "1";

const LOGIN_TOOL = RAW_TOOLS.filter((t) => t.name === "login");
const PROXY_TOOLS = RAW_TOOLS.filter((t) => t.name !== "login");

export const TOOLS: Tool[] = [
  ...toMcpTools(),
  ...LOGIN_TOOL,
  ...(ADVANCED_ENABLED ? PROXY_TOOLS : []),
];

export async function handleToolCall(
  name: string,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  try {
    const typed = TOOL_BY_NAME.get(name);
    if (typed) return await callTool(typed, rawArgs, signal);

    if ((name === "search_actions" || name === "execute_action" || name === "list_categories") && !ADVANCED_ENABLED) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `"${name}" is not enabled. Use the named CloudYali tools instead — call tools/list to see them. To re-enable the raw catalog interface, restart the server with CLOUDYALI_MCP_ADVANCED=1.`,
          },
        ],
      };
    }

    if (name === "search_actions") {
      const query = String(args.query ?? "");
      const category = args.category ? String(args.category) : undefined;
      // Clamp to a sane integer range: a raw negative limit would invert
      // searchActions' slice and leak nearly the whole catalog.
      const rawLimit = typeof args.limit === "number" ? Math.trunc(args.limit) : 10;
      const limit = Math.min(Math.max(1, rawLimit), 100);
      const matches = searchActions(query, category, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: matches.length,
                results: matches,
                hint: "Call execute_action with { id, path_params, query_params, body } to run an action.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "list_categories") {
      const counts: Record<string, number> = {};
      for (const a of READ_ONLY_CATALOG) counts[a.category] = (counts[a.category] ?? 0) + 1;
      const auth = currentAuthSummary();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: READ_ONLY_CATALOG.length,
                by_category: counts,
                base_url: CLOUDYALI_API_URL,
                auth,
                mode: "read-only",
                note: `This MCP is read-only. Make changes (status updates, settings, account and admin operations) in the portal at ${CONSOLE_URL}.`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "execute_action") {
      const id = String(args.id ?? "");
      const text = await executeAction({
        id,
        path_params: (args.path_params as Record<string, unknown> | undefined) ?? undefined,
        query_params: (args.query_params as Record<string, unknown> | undefined) ?? undefined,
        body: args.body,
        signal,
      });
      return { content: [{ type: "text", text }] };
    }

    if (name === "login") {
      // Two-phase on purpose. The verification code only defends against a
      // rogue local process if the user sees it *before* deciding whether to
      // trust the browser page. A blocking call returns after that decision,
      // and stderr — where the code used to go — is a log file under an MCP
      // client, not something anyone reads.
      const existing = currentLogin();

      if (existing?.status === "done" && existing.credentials) {
        const creds = existing.credentials;
        clearLogin();
        return {
          content: [{ type: "text", text: `${loginSuccessMessage(creds)} Retry the original tool call now.` }],
        };
      }

      if (existing?.status === "failed") {
        const message = existing.error?.message ?? "Sign-in failed.";
        clearLogin();
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Sign-in failed: ${message} Call login again to start over.`,
            },
          ],
        };
      }

      if (existing?.status === "pending") {
        // Give a fast user a moment to land, so the common case finishes on
        // this call rather than needing a third.
        await Promise.race([
          existing.done.catch(() => undefined),
          new Promise((r) => setTimeout(r, 3000).unref?.()),
        ]);
        const after = currentLogin();
        if (after?.status === "done" && after.credentials) {
          const creds = after.credentials;
          clearLogin();
          return {
            content: [{ type: "text", text: `${loginSuccessMessage(creds)} Retry the original tool call now.` }],
          };
        }
        if (after?.status === "failed") {
          const message = after.error?.message ?? "Sign-in failed.";
          clearLogin();
          return { isError: true, content: [{ type: "text", text: `Sign-in failed: ${message}` }] };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Still waiting for authorization.\n\n` +
                `Verification code: ${existing.code}\n\n` +
                `In the browser tab, check the page shows this exact code, then click Authorize. ` +
                `If no tab opened, go to:\n${existing.portalUrl}\n\n` +
                `Call login again once you have authorized.`,
            },
          ],
        };
      }

      try {
        const session = await startLogin(undefined, signal);
        return {
          content: [
            {
              type: "text",
              text:
                `Sign-in started — a browser tab should have opened.\n\n` +
                `Verification code: ${session.code}\n\n` +
                `Before clicking Authorize, check that the page shows this exact code. ` +
                `If it shows a different code, or none, the request did not come from this tool — cancel it.\n\n` +
                `If no tab opened, go to:\n${session.portalUrl}\n\n` +
                `Call login again once you have authorized.`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Could not start sign-in: ${err instanceof Error ? err.message : String(err)}. The portal at ${PORTAL_URL} may be unreachable.`,
            },
          ],
        };
      }
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  } catch (err) {
    if (err instanceof ToolArgError) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
    if (err instanceof AuthError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `${err.message}${err.hint ? `\nHint: ${err.hint}` : ""}`,
          },
        ],
      };
    }
    // The client bucket, not CloudYali's. Its own message already says what to
    // do, so do not bury it behind a bare "Error:".
    if (err instanceof RateLimitedError) {
      return { isError: true, content: [{ type: "text", text: `${name} was not sent. ${err.message}` }] };
    }
    if (isTransportError(err)) {
      return {
        isError: true,
        content: [{ type: "text", text: describeTransportFailure(err, CLOUDYALI_API_URL, name) }],
      };
    }
    // Anything left is this server misbehaving, and saying so is more useful
    // than a message that reads like the API's fault.
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `${name} failed inside the CloudYali MCP server itself, before or after the API call: ` +
            `${err instanceof Error ? err.message : String(err)}. This is a bug in this server, not a problem with ` +
            `the question — rephrasing will not help, and there is no result to report.`,
        },
      ],
    };
  }
}
