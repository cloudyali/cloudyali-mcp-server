// A minimal JSON Schema type.
//
// The MCP SDK types inputSchema loosely, so this exists to give our own tool
// definitions something to check against — enough structure to catch a typo in
// a property name at compile time, without pulling in a schema library for
// shapes this simple.

export type JSONSchema = {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JSONSchema;
  // JSON Schema allows any JSON value here. days on the cost-view endpoints is an
  // integer enum (7 | 30 | 90), so restricting this to strings would have forced
  // either a wrong type on the wire or an unvalidated free integer.
  enum?: (string | number)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  default?: unknown;
};
