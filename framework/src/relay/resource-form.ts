/** Locally registered resource forms: the product schemas that constrain
 * the public `resource.get` / `resource.subscribe` args and a resource
 * success value.
 *
 * The wire stays closed: a form adds no field to ResourceRef and no new
 * top-level metadata key. Product request parameters occupy exactly one
 * object inside the existing `args`, under a key the profile chose at
 * registration (e.g. `{args:{accept,…,maxObjectBytes,…,term:{page:3}}}`).
 * The public schema validates first, relaxed for that one registered key;
 * the key's value then validates against the installed closed product
 * schema. Nothing about a form is negotiated or sent; each end installs
 * its own copy and rejects content the local form does not admit. */

import {
  RELAY_HANDSHAKE, RELAY_KIND, RELAY_METADATA_SCHEMAS, RELAY_OP,
  type RelayProfileEntry,
} from "../../../contracts/spec/relay.ts";
import { validateRelaySchema } from "./metadata-schema.ts";
import { checkRelayProductSchema, type RelayProductSchema } from "./product-schema.ts";
import { freezeRelayCopy, samePrivateProfile } from "./private-op.ts";

export interface RelayResourceForm {
  profile: RelayProfileEntry;
  /** One of the central RELAY_KIND values (1..8); forms cannot define kinds. */
  kind: number;
  /**
   * The single args key this form owns, e.g. "term". When set, the key may
   * appear on resource.get and (when `onSubscribe` is set)
   * resource.subscribe requests, and its object must satisfy `args`. The
   * key name must be a product token and cannot collide with a public key.
   * When unset the form registers a value schema only.
   */
  argsKey?: string;
  /** Closed schema for the product object carried at `args[argsKey]`. */
  args?: RelayProductSchema;
  /** Closed schema for successful codec-0 metadata or codec-1 JSON content. */
  value?: RelayProductSchema;
  /** A form with `value` must declare whether the content carrier may be absent. */
  valuePresence?: "required" | "optional";
  /** When true the argsKey applies to resource.subscribe as well as get. */
  onSubscribe?: boolean;
}

const PUBLIC_GET_KEYS = new Set(["accept", "maxObjectBytes", "ifRevision"]);
const PUBLIC_SUBSCRIBE_KEYS = new Set(["delivery", "namespace"]);
const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
const MAX_FORMS = 64;
const MAX_SCHEMA_BYTES = 65536;

export class RelayResourceForms {
  private readonly forms: readonly RelayResourceForm[];

  constructor(definitions: readonly RelayResourceForm[], profiles: readonly RelayProfileEntry[]) {
    if (!Array.isArray(definitions)) throw new Error("resourceForms must be an array");
    if (definitions.length > MAX_FORMS) throw new Error("too many resource forms");
    const seenIdentities = new Set<string>();
    const keyOwners = new Map<string, string>();
    /** Namespace-scope subscribes carry no ref/kind, so one onSubscribe
     * form per (profile, key) must resolve the product schema. */
    const subscribeKeyOwners = new Set<string>();
    for (const form of definitions) {
      for (const key of Object.keys(form)) {
        if (!["profile", "kind", "argsKey", "args", "value", "valuePresence", "onSubscribe"].includes(key)) {
          throw new Error(`unknown resource form field ${key}`);
        }
      }
      const profile = form.profile;
      const nameBytes = profile ? new TextEncoder().encode(profile.name).length : 0;
      if (!profile || typeof profile.name !== "string" || !nameBytes
          || nameBytes > RELAY_HANDSHAKE.profileNameMaxBytes
          || !Number.isSafeInteger(profile.version) || profile.version < 0 || profile.version > 0xffff
          || !profiles.some(candidate => samePrivateProfile(candidate, profile))) {
        throw new Error("resource form must bind to an installed profile");
      }
      if (!Number.isSafeInteger(form.kind) || form.kind < 1 || form.kind > 0xff
          || !Object.values(RELAY_KIND).includes(form.kind)) {
        throw new Error("resource form kind must be a defined RELAY_KIND");
      }
      if (form.argsKey !== undefined) {
        if (typeof form.argsKey !== "string" || !KEY_PATTERN.test(form.argsKey)
            || PUBLIC_GET_KEYS.has(form.argsKey) || PUBLIC_SUBSCRIBE_KEYS.has(form.argsKey)) {
          throw new Error("resource form argsKey must be a product token distinct from public keys");
        }
        if (!form.args || form.args.type !== "object") throw new Error("resource form args schema must be an object");
        checkRelayProductSchema(form.args);
        if (form.onSubscribe !== undefined && typeof form.onSubscribe !== "boolean") {
          throw new Error("resource form onSubscribe must be a boolean");
        }
        const owner = JSON.stringify([profile.name, profile.version]);
        const existing = keyOwners.get(form.argsKey);
        if (existing !== undefined && existing !== owner) {
          throw new Error(`resource form argsKey ${form.argsKey} claimed by two profiles`);
        }
        keyOwners.set(form.argsKey, owner);
        if (form.onSubscribe === true) {
          const scope = `${owner} ${form.argsKey}`;
          if (subscribeKeyOwners.has(scope)) {
            throw new Error(`resource form argsKey ${form.argsKey} registered for namespace subscribe twice in one profile`);
          }
          subscribeKeyOwners.add(scope);
        }
      } else if (form.args !== undefined || form.onSubscribe !== undefined) {
        throw new Error("resource form args/onSubscribe require argsKey");
      }
      if (form.value !== undefined) {
        if (form.valuePresence !== "required" && form.valuePresence !== "optional") {
          throw new Error("resource form valuePresence must be required or optional when value is set");
        }
        if (form.value.type !== "object") throw new Error("resource form value schema must be an object");
        checkRelayProductSchema(form.value);
      } else if (form.valuePresence !== undefined) {
        throw new Error("resource form valuePresence requires value");
      }
      const identity = JSON.stringify([profile.name, profile.version, form.kind]);
      if (seenIdentities.has(identity)) throw new Error("duplicate resource form for profile and kind");
      seenIdentities.add(identity);
    }
    if (new TextEncoder().encode(JSON.stringify(definitions)).length > MAX_SCHEMA_BYTES) {
      throw new Error("resource form schemas too large");
    }
    this.forms = freezeRelayCopy(definitions);
  }

  /** The form bound to a stream's selected profile and the ref's kind. */
  formFor(profile: RelayProfileEntry | undefined, kind: number): RelayResourceForm | undefined {
    if (!profile) return undefined;
    return this.forms.find(form => samePrivateProfile(form.profile, profile) && form.kind === kind);
  }

  /** The form owning an args key on a profile-bound stream. */
  formForKey(profile: RelayProfileEntry | undefined, argsKey: string): RelayResourceForm | undefined {
    if (!profile) return undefined;
    return this.forms.find(form => samePrivateProfile(form.profile, profile) && form.argsKey === argsKey);
  }

  /** The onSubscribe form owning an args key; a key shared with a get-only
   * form must not shadow it. */
  subscribeFormForKey(profile: RelayProfileEntry | undefined, argsKey: string): RelayResourceForm | undefined {
    if (!profile) return undefined;
    return this.forms.find(form => samePrivateProfile(form.profile, profile)
      && form.argsKey === argsKey && form.onSubscribe === true);
  }

  /** Layered request validation. The public L2 schema runs first; the one
   * registered product key is admitted into its closed args and validated
   * by the product schema in the same pass. An unknown key, a key without
   * a form, a key on the wrong op (get vs subscribe), or a type mismatch
   * returns a fixed reason string; null means the request is admitted. */
  validateRequest(
    op: typeof RELAY_OP.RESOURCE_GET | typeof RELAY_OP.RESOURCE_SUBSCRIBE,
    profile: RelayProfileEntry | undefined,
    metadata: unknown,
  ): string | null {
    const base = RELAY_METADATA_SCHEMAS[`${op}.request`] as Record<string, unknown>;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "metadata: expected object";
    const meta = metadata as { resource?: { kind?: number }; args?: Record<string, unknown> };
    const args = meta.args && typeof meta.args === "object" && !Array.isArray(meta.args)
      ? meta.args : undefined;
    let form: RelayResourceForm | undefined;
    if (op === RELAY_OP.RESOURCE_GET) {
      const kind = args && meta.resource && typeof meta.resource.kind === "number" ? meta.resource.kind : undefined;
      form = kind === undefined ? undefined : this.formFor(profile, kind);
    } else if (meta?.resource && typeof meta.resource.kind === "number") {
      form = this.formFor(profile, meta.resource.kind);
    } else if (args) {
      // Namespace-scope subscribe has no ref: resolve the onSubscribe form
      // through the one non-public args key. Two forms cannot share a key
      // with onSubscribe in one profile.
      for (const key of Object.keys(args)) {
        if (PUBLIC_SUBSCRIBE_KEYS.has(key)) continue;
        form = this.subscribeFormForKey(profile, key);
        break;
      }
    }
    // For a ref subscribe the kind-bound form must itself opt in.
    if (op === RELAY_OP.RESOURCE_SUBSCRIBE && form && meta?.resource && form.onSubscribe !== true) {
      form = undefined;
    }
    const admitKey = !!form?.argsKey && (op === RELAY_OP.RESOURCE_GET || form.onSubscribe === true);
    const schema = admitKey && form
      ? embedArgsKey(base, form.argsKey!, form.args!)
      : base;
    return validateRelaySchema(schema, metadata);
  }

  /** Validate one successful resource value against the form bound to
   * `profile` and `kind`. A required form rejects an absent content carrier;
   * an optional form accepts absence but validates every present value. */
  validateValue(profile: RelayProfileEntry | undefined, kind: number, value: unknown): string | null {
    const form = this.formFor(profile, kind);
    if (!form?.value) return null;
    if (value === undefined) {
      return form.valuePresence === "required" ? "resource value is required by the installed form" : null;
    }
    return validateRelaySchema(form.value, value);
  }
}

/** The public request schema with one extra closed property admitted into
 * `args`. additionalProperties stays false, so every other unknown key
 * still rejects. */
function embedArgsKey(base: Record<string, unknown>, key: string, productArgs: RelayProductSchema): Record<string, unknown> {
  const schema = JSON.parse(JSON.stringify(base)) as { properties: { args: { properties: Record<string, unknown> } } };
  schema.properties.args.properties[key] = productArgs;
  return schema;
}
