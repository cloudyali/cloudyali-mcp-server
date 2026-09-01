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
  enum?: string[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  default?: unknown;
};
