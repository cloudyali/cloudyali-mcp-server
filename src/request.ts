// URL construction for execute_action: path-param substitution and query
// string serialization. Kept free of MCP/server imports so it is unit-testable.

import { Action } from "./catalog.js";

export function substitutePath(action: Action, pathParams: Record<string, unknown> | undefined): string {
  let p = action.path;
  if (action.pathParams) {
    for (const name of Object.keys(action.pathParams)) {
      const v = pathParams?.[name];
      if (v === undefined || v === null || v === "") {
        throw new Error(`Missing required path param: ${name}`);
      }
      p = p.replace(`:${name}`, encodeURIComponent(String(v)));
    }
  }
  return p;
}

// All caller-supplied params are serialized, whether or not the action
// declares them — the declared queryParams are documentation plus
// serialization hints, not an allowlist (the backend ignores unknowns,
// and silently dropping params turns filtered queries into unfiltered ones).
//
// Arrays serialize as repeated params (?p=a&p=b) unless the declared param
// sets serializeArray: "comma" — some backend handlers read a single value
// and split on commas, so repeated params would drop all but the first.
export function buildQueryString(action: Action, queryParams: Record<string, unknown> | undefined): string {
  if (!queryParams) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(queryParams)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (action.queryParams?.[k]?.serializeArray === "comma") {
        sp.append(k, v.map(String).join(","));
      } else {
        for (const item of v) sp.append(k, String(item));
      }
    } else {
      sp.append(k, String(v));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}
