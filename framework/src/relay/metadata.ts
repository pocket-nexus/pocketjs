/** Named-schema wrappers over the single relay metadata evaluator.
 *
 * The frame parser (frame.ts) validates the wire envelope; an L2 peer must
 * validate the op-specific metadata before acting on it. The evaluator and
 * the schema subset it implements live in metadata-schema.ts; this file only
 * binds names from RELAY_METADATA_SCHEMAS so callers never hold the table. */

import { RELAY_METADATA_SCHEMAS } from "../../../contracts/spec/relay.ts";
import { validateRelaySchema } from "./metadata-schema.ts";

/** Validate metadata against one named schema (e.g. "resource.get.request").
 * Returns null when the metadata satisfies the schema, or a fixed reason
 * string naming the first violated rule. */
export function validateRelayMetadata(schemaName: string, metadata: unknown): string | null {
  const schema = RELAY_METADATA_SCHEMAS[schemaName] as Record<string, unknown> | undefined;
  if (!schema) return `unknown schema ${schemaName}`;
  return validateRelaySchema(schema, metadata);
}

/** True when a named resource schema exists. */
export function hasRelayMetadataSchema(schemaName: string): boolean {
  return Object.prototype.hasOwnProperty.call(RELAY_METADATA_SCHEMAS, schemaName);
}
