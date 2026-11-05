/** Profile-owned REQUEST definitions. Schemas never cross the transport. */
import {
  RELAY_CODEC, RELAY_EFFECT, RELAY_ERROR, RELAY_LIMITS, RELAY_OP, RELAY_PRIVATE_OP,
  RELAY_PRIVATE_OPS_SCHEMA, RELAY_STATUS, RELAY_TYPE,
  type RelayPrivateOpDescriptor, type RelayPrivateOpDirection, type RelayProfileEntry, type RelayRxLimits,
} from "../../../contracts/spec/relay.ts";
import { prepareFrameBody, type RelayFrameBodyInput } from "./frame.ts";
import { validateRelaySchema } from "./metadata-schema.ts";
import { checkRelayProductSchema, type RelayProductSchema } from "./product-schema.ts";

export type RelayPrivateSchema = RelayProductSchema;

export interface RelayPrivateOp extends RelayPrivateOpDescriptor {
  args: RelayPrivateSchema;
  value: RelayPrivateSchema;
}

export const samePrivateProfile = (a: RelayProfileEntry, b: RelayProfileEntry): boolean =>
  a.name === b.name && a.version === b.version;

const directionMask = (direction: RelayPrivateOpDirection): number =>
  direction === "guest-to-provider" ? 1 : direction === "provider-to-guest" ? 2 : 3;
const directionOf = (mask: number): RelayPrivateOpDirection =>
  mask === 1 ? "guest-to-provider" : mask === 2 ? "provider-to-guest" : "bidirectional";
export const privateOpAllows = (op: RelayPrivateOpDescriptor, role: "guest" | "provider"): boolean =>
  (directionMask(op.direction) & (role === "guest" ? 1 : 2)) !== 0;

const sameIdentity = (a: RelayPrivateOpDescriptor, b: RelayPrivateOpDescriptor): boolean =>
  samePrivateProfile(a.profile, b.profile) && a.name === b.name
  && a.recovery === b.recovery && a.recoveryOp === b.recoveryOp;

/** Installed capabilities and selected bindings cannot change after HELLO. */
export function freezeRelayCopy<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (v: unknown): void => {
    if (v && typeof v === "object") {
      for (const child of Object.values(v)) freeze(child);
      Object.freeze(v);
    }
  };
  freeze(copy);
  return copy;
}

const hasRecoveryQuery = (op: RelayPrivateOpDescriptor, entries: readonly RelayPrivateOpDescriptor[]): boolean =>
  op.recovery !== "durable" || op.recoveryOp === RELAY_OP.OPERATION_STATUS || entries.some(query => query.name === op.recoveryOp
    && samePrivateProfile(query.profile, op.profile) && query.recovery === "idempotent"
    && (directionMask(query.direction) & directionMask(op.direction)) === directionMask(op.direction));

/** Validate both local offers and untrusted peer descriptors, including owners. */
export function validPrivateOps(
  profiles: readonly RelayProfileEntry[], entries: unknown, limits: RelayRxLimits,
): boolean {
  if (entries === undefined) return true;
  if (validateRelaySchema(RELAY_PRIVATE_OPS_SCHEMA, entries) !== null || !Array.isArray(profiles)) return false;
  const ops = entries as RelayPrivateOpDescriptor[];
  const seen = new Set<string>();
  for (const op of ops) {
    const key = JSON.stringify([op.profile.name, op.profile.version, op.name]);
    const prefix = `x.${op.profile.name}.`;
    if (seen.has(key) || !op.name.startsWith(prefix)
        || !/^[a-z][a-z0-9_.-]*$/.test(op.name.slice(prefix.length))
        || !profiles.some(profile => profile && samePrivateProfile(profile, op.profile))
        || !(op.maxWireBytes <= limits?.maxWireBytes) || !(op.maxObjectBytes <= limits?.maxObjectBytes)
        || (op.recovery !== "durable" && op.recoveryOp !== undefined) || !hasRecoveryQuery(op, ops)) return false;
    seen.add(key);
  }
  return true;
}

/** Direction and budgets can narrow; recovery and profile identity must match. */
export function intersectPrivateOps(
  offered: readonly RelayPrivateOpDescriptor[], supported: readonly RelayPrivateOpDescriptor[],
  profiles: readonly RelayProfileEntry[],
): RelayPrivateOpDescriptor[] {
  const selected: RelayPrivateOpDescriptor[] = [];
  for (const op of offered) {
    if (!profiles.some(profile => samePrivateProfile(profile, op.profile))) continue;
    const other = supported.find(candidate => sameIdentity(candidate, op));
    if (!other) continue;
    const mask = directionMask(op.direction) & directionMask(other.direction);
    if (!mask) continue;
    selected.push({ ...op, direction: directionOf(mask),
      maxWireBytes: Math.min(op.maxWireBytes, other.maxWireBytes),
      maxObjectBytes: Math.min(op.maxObjectBytes, other.maxObjectBytes) });
  }
  return selected.filter(op => hasRecoveryQuery(op, selected));
}

export function privateSelectionOffered(
  selected: readonly RelayPrivateOpDescriptor[], offered: readonly RelayPrivateOpDescriptor[],
): boolean {
  return selected.every(op => offered.some(original => sameIdentity(op, original)
    && (directionMask(op.direction) & directionMask(original.direction)) === directionMask(op.direction)
    && op.maxWireBytes <= original.maxWireBytes && op.maxObjectBytes <= original.maxObjectBytes));
}

/** The supported schema language is checked at installation, never guessed. */
const checkSchema: typeof checkRelayProductSchema = checkRelayProductSchema;

export function installPrivateOps(
  definitions: readonly RelayPrivateOp[], profiles: readonly RelayProfileEntry[], limits: RelayRxLimits,
): readonly RelayPrivateOp[] {
  if (!Array.isArray(definitions)) throw new Error("privateOps must be an array");
  if (definitions.length > RELAY_PRIVATE_OP.maxEntries) throw new Error("too many private ops");
  for (const definition of definitions) {
    checkSchema(definition.args);
    checkSchema(definition.value);
    for (const key of Object.keys(definition)) {
      if (!["profile", "name", "direction", "recovery", "recoveryOp", "maxWireBytes", "maxObjectBytes", "args", "value"].includes(key)) {
        throw new Error(`unknown private op registration field ${key}`);
      }
    }
  }
  // Serialization rejects cycles; installation is bounded independently of wire metadata.
  const source = JSON.stringify(definitions);
  if (new TextEncoder().encode(source).length > RELAY_PRIVATE_OP.maxSchemaBytes) throw new Error("private op schemas too large");
  const installed = freezeRelayCopy(definitions);
  const descriptors = installed.map(({ args, value, ...descriptor }) => {
    checkSchema(args);
    checkSchema(value);
    if (descriptor.recovery === "durable" && (value.type !== "object"
        || !(value.required as string[] | undefined)?.includes("receipt"))) {
      throw new Error("durable private ops require a receipt in the value schema");
    }
    return descriptor;
  });
  if (!validPrivateOps(profiles, descriptors, limits)) throw new Error("invalid private op registration");
  return installed;
}

export function privateDescriptors(definitions: readonly RelayPrivateOp[]): RelayPrivateOpDescriptor[] {
  return definitions.map(({ args: _args, value: _value, ...descriptor }) => descriptor);
}

const hex16 = { type: "string", pattern: "^[0-9a-f]{16}$" };
const hex32 = { type: "string", pattern: "^[0-9a-f]{32}$" };
const errorSchema = {
  type: "object", additionalProperties: false, required: ["code", "message"],
  properties: { code: { enum: Object.values(RELAY_ERROR) },
    message: { type: "string", minLength: 1, maxBytes: RELAY_LIMITS.errorMessageMaxBytes } },
};

/** The shared envelope stays closed. Only args/value use a product schema. */
function envelopeSchema(op: RelayPrivateOp | undefined, input: RelayFrameBodyInput): RelayPrivateSchema {
  const properties: Record<string, unknown> = { op: { const: input.metadata.op } };
  const required = ["op"];
  if (input.type === RELAY_TYPE.REQUEST) {
    properties.args = op!.args;
    required.push("args");
    if (op!.recovery !== "idempotent") {
      properties.opEpoch = hex16; properties.opId = hex32;
      required.push("opEpoch", "opId");
    }
  } else {
    required.push("status", "final");
    properties.status = { const: input.metadata.status };
    properties.final = { const: input.metadata.status !== RELAY_STATUS.ACCEPTED };
    if (input.metadata.status === RELAY_STATUS.OK) { properties.value = op!.value; required.push("value"); }
    else if (input.metadata.status === RELAY_STATUS.ERROR) {
      properties.error = errorSchema; required.push("error");
      properties.effect = { enum: Object.values(RELAY_EFFECT) };
      if ((input.metadata.error as { code?: string } | undefined)?.code === RELAY_ERROR.CANCELLED) required.push("effect");
    }
    if (op && op.recovery !== "idempotent" && input.metadata.status !== RELAY_STATUS.ACCEPTED) {
      properties.effect = { enum: Object.values(RELAY_EFFECT) }; required.push("effect");
    }
  }
  return { type: "object", additionalProperties: false, required, properties };
}

/** Validate and snapshot before queue admission. No product type enters P3. */
export function preparePrivateOp(
  op: RelayPrivateOp | undefined, input: RelayFrameBodyInput, limits: RelayRxLimits,
): { ok: true; metadata: Record<string, unknown> } | { ok: false; code: string } {
  if ((input.codec ?? RELAY_CODEC.NONE) !== RELAY_CODEC.NONE || (input.data?.length ?? 0) !== 0) {
    return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
  }
  if (!op && (input.type !== RELAY_TYPE.RESPONSE || input.metadata.status !== RELAY_STATUS.ERROR)) {
    return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
  }
  const maxWireBytes = Math.min(op?.maxWireBytes ?? limits.maxWireBytes, limits.maxWireBytes);
  const prepared = prepareFrameBody(input, { maxWireBytes, maxMetaBytes: limits.maxMetaBytes, codecs: [RELAY_CODEC.NONE] });
  if (!prepared.ok) return { ok: false, code: prepared.code === "WIRE_TOO_LARGE" || prepared.code === "META_TOO_LARGE"
    ? RELAY_ERROR.TOO_LARGE : RELAY_ERROR.INVALID };
  const metadata = JSON.parse(new TextDecoder().decode(prepared.body.meta)) as Record<string, unknown>;
  const invalid = validateRelaySchema(envelopeSchema(op, { ...input, metadata }), metadata);
  if (invalid) return { ok: false, code: RELAY_ERROR.INVALID };
  if (input.type === RELAY_TYPE.RESPONSE && op?.recovery !== "idempotent" && op) {
    if ((metadata.status === RELAY_STATUS.OK && metadata.effect !== RELAY_EFFECT.COMMITTED)
        || ((metadata.error as { code?: string } | undefined)?.code === RELAY_ERROR.CANCELLED && metadata.effect !== RELAY_EFFECT.NONE)
        || (metadata.status === RELAY_STATUS.ERROR && metadata.effect === RELAY_EFFECT.COMMITTED)) {
      return { ok: false, code: RELAY_ERROR.INVALID };
    }
  }
  const value = input.type === RELAY_TYPE.REQUEST ? metadata.args : metadata.value;
  if (value !== undefined && new TextEncoder().encode(JSON.stringify(value)).length
      > Math.min(op!.maxObjectBytes, limits.maxObjectBytes)) return { ok: false, code: RELAY_ERROR.TOO_LARGE };
  return { ok: true, metadata };
}

export function privateOpForStream(
  entries: readonly RelayPrivateOpDescriptor[], profile: RelayProfileEntry, limits: RelayRxLimits,
): RelayPrivateOpDescriptor[] {
  return entries.filter(op => samePrivateProfile(op.profile, profile)).map(op => ({ ...op,
    maxWireBytes: Math.min(op.maxWireBytes, limits.maxWireBytes),
    maxObjectBytes: Math.min(op.maxObjectBytes, limits.maxObjectBytes) }));
}
