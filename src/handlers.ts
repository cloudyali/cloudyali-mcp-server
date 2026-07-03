// Tool definitions and the call dispatcher for the CloudYali MCP server.
// Kept separate from index.ts (which boots the stdio server on import) so this
// logic is unit-testable without starting a server.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { READ_ONLY_CATALOG, searchActions } from "./catalog.js";
import { AuthError, currentAuthSummary } from "./auth.js";
import { awaitLogin, loginSuccessMessage } from "./login.js";
import { executeAction } from "./execute.js";
import { CLOUDYALI_API_URL, CONSOLE_URL, PORTAL_URL } from "./config.js";

export const TOOLS: Tool[] = [
  {
    name: "search_actions",
    description:
      "Search the read-only CloudYali (\"cy\") API catalog for cloud cost, spend, budgets, savings recommendations, cost anomalies, and resource inventory. Use this for any CloudYali / cy / cloud-cost / FinOps / cloud-inventory question. Returns matching actions with their IDs, descriptions, and parameter schemas. Call this first to discover the right action, then call execute_action with the chosen id. Scope: cost reports/aggregation/spend/filters, budgets (list/summary/get/resources/history), recommendations (list/summary/top-savings/get/history), anomalies (list/summary/get/preferences-read), and inventory (resource list/search/detail plus provider/type/region/account/tag filters). All mutating endpoints (create/PUT/DELETE/status updates/assignments/feedback) AND all account / customer / user / sync / claim / registration endpoints are excluded — make those changes in the portal.",
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
        limit: { type: "integer", description: "Max results. Default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "execute_action",
    description:
      "Execute a read-only CloudYali API action by id. Use search_actions first to find the id and required params. Returns { status, ok, body } from the API. Write actions (PUT/DELETE/status updates) and account / customer / user / sync / claim / registration endpoints are hard-blocked and will return an error.",
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
          description: "Query string parameter values. Array values are serialized as repeated params, except params whose schema declares comma-joining (e.g. assignedUser).",
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
  },
  {
    name: "login",
    description:
      "Sign in to CloudYali. Opens the user's browser to the CloudYali portal, has them authorize this CLI, and saves a refresh token locally. Call this when execute_action returns 'No credentials found' or a token-refresh failure. The call blocks for up to 5 minutes while waiting for the user to authorize in the browser — that's expected, not a hang. Returns the authenticated email and access-token expiry on success.",
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

export async function handleToolCall(
  name: string,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  try {
    if (name === "search_actions") {
      const query = String(args.query ?? "");
      const category = args.category ? String(args.category) : undefined;
      const limit = typeof args.limit === "number" ? args.limit : 10;
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
      try {
        const creds = await awaitLogin(undefined, signal);
        return {
          content: [
            {
              type: "text",
              text: `${loginSuccessMessage(creds)} Retry the original tool call now.`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Login failed: ${err instanceof Error ? err.message : String(err)}. The browser may have timed out (5-minute window) or the portal at ${PORTAL_URL} may be unreachable.`,
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
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}
