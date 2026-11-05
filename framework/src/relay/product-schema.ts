/** The restricted JSON Schema dialect product profiles use for local
 * args/value schemas. Schemas never cross the transport: each end installs
 * its own copy and rejects content it cannot evaluate.
 *
 * The supported keyword set is fixed at installation; an unknown keyword
 * rejects registration instead of being silently treated as `true` (the
 * extension design's fail-closed rule). Every object a product schema
 * validates is closed: `additionalProperties:false` is required, so the
 * public layer can attach one product sub-schema without opening a hole. */

import { RELAY_LIMITS } from "../../../contracts/spec/relay.ts";

export type RelayProductSchema = Record<string, unknown>;

const schemaKeys = new Set([
  "type", "properties", "required", "additionalProperties", "items", "additionalItems",
  "minItems", "maxItems", "minLength", "maxBytes", "minimum", "maximum", "pattern", "const", "enum",
]);

const literal = (value: unknown): boolean => value === null || typeof value === "string"
  || typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value));

/** Validate the schema language itself at installation time. */
export function checkRelayProductSchema(value: unknown, depth = 0): asserts value is RelayProductSchema {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > RELAY_LIMITS.jsonMaxDepth) {
    throw new Error("product schema must be an object within the depth limit");
  }
  const schema = value as RelayProductSchema;
  for (const key of Object.keys(schema)) if (!schemaKeys.has(key)) throw new Error(`unsupported schema keyword ${key}`);
  if (!["object", "array", "string", "integer", "boolean", "null"].includes(schema.type as string)) {
    throw new Error("product schema requires a supported type");
  }
  for (const key of ["minItems", "maxItems", "minLength", "maxBytes", "minimum", "maximum"]) {
    if (key in schema && (!Number.isSafeInteger(schema[key])
        || (!["minimum", "maximum"].includes(key) && (schema[key] as number) < 0))) throw new Error(`invalid ${key}`);
  }
  if ("minimum" in schema && "maximum" in schema && (schema.minimum as number) > (schema.maximum as number)) {
    throw new Error("inverted schema number bounds");
  }
  if ("minItems" in schema && "maxItems" in schema && (schema.minItems as number) > (schema.maxItems as number)) {
    throw new Error("inverted schema array bounds");
  }
  if ("const" in schema && !literal(schema.const)) throw new Error("schema const requires a JSON scalar");
  if ("enum" in schema && (!Array.isArray(schema.enum) || !schema.enum.length || !schema.enum.every(literal))) {
    throw new Error("schema enum requires JSON scalars");
  }
  if ("pattern" in schema) {
    if (typeof schema.pattern !== "string") throw new Error("schema pattern must be a string");
    new RegExp(schema.pattern);
  }
  if (schema.type === "object") {
    if (schema.additionalProperties !== false || !schema.properties || typeof schema.properties !== "object"
        || Array.isArray(schema.properties)) throw new Error("product objects must declare closed properties");
    const properties = schema.properties as Record<string, unknown>;
    if (schema.required !== undefined && (!Array.isArray(schema.required)
        || !schema.required.every(key => typeof key === "string" && Object.hasOwn(properties, key))
        || new Set(schema.required).size !== schema.required.length)) throw new Error("invalid schema required list");
    for (const child of Object.values(properties)) checkRelayProductSchema(child, depth + 1);
  } else if (schema.type === "array") {
    if (Array.isArray(schema.items)) {
      if (schema.additionalItems !== false || schema.minItems !== schema.items.length
          || schema.maxItems !== schema.items.length) throw new Error("schema tuples need exact bounds");
      for (const child of schema.items) checkRelayProductSchema(child, depth + 1);
    } else {
      if (schema.additionalItems !== undefined) throw new Error("additionalItems requires a tuple");
      checkRelayProductSchema(schema.items, depth + 1);
    }
  }
  const fields: Record<string, string[]> = {
    properties: ["object"], required: ["object"], additionalProperties: ["object"],
    items: ["array"], additionalItems: ["array"], minItems: ["array"], maxItems: ["array"],
    minLength: ["string"], maxBytes: ["string"], pattern: ["string"], minimum: ["integer"], maximum: ["integer"],
  };
  for (const [key, types] of Object.entries(fields)) {
    if (key in schema && !types.includes(schema.type as string)) throw new Error(`schema ${key} does not apply to ${schema.type}`);
  }
}
