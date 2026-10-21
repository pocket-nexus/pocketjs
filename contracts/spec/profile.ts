// Profile identity contract, shared by application compilation and Runtime admission.
import type { JsonSchema } from "./pocket-manifest.ts";
import {
  PRESENTATION_MODES,
  TARGET_FORMS,
  type DisplayProfile,
  type TargetForm,
} from "./platform-types.ts";

/** Software facts promised by a program; no compiler, SDK, or build steps. */
export interface PocketProfile<C extends string = string> {
  readonly id: string;
  readonly platform: string;
  readonly form: TargetForm;
  readonly tickHz: number;
  readonly display: DisplayProfile;
  readonly capabilities: readonly C[];
  readonly roleCapabilities?: { readonly systemUI?: readonly C[] };
  /** Metadata only. Anything that changes app compilation or behavior belongs
   * in the hashed contract or requires separate versioned validation. */
  readonly hostExtension?: Readonly<Record<string, unknown>>;
}

export const PROFILE_HASH_ALGORITHM = "sha256" as const;
export const PROFILE_HASH_BYTES = 32;
export const PROFILE_HASH_FIELDS = [
  "id", "platform", "form", "tickHz", "display", "capabilities", "roleCapabilities",
] as const;

const viewport = {
  type: "array", items: { type: "integer", minimum: 1, maximum: 65535 },
  minItems: 2, maxItems: 2,
} as const satisfies JsonSchema;
const capabilities = {
  type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true,
} as const satisfies JsonSchema;
const fixedDisplay = {
  type: "object", additionalProperties: false,
  required: ["physicalViewport", "logicalViewports", "presentations", "rasterDensity"],
  properties: {
    physicalViewport: viewport,
    logicalViewports: { type: "array", items: viewport, minItems: 1, uniqueItems: true },
    presentations: {
      type: "array", items: { enum: PRESENTATION_MODES }, minItems: 1, uniqueItems: true,
    },
    rasterDensity: { type: "integer", minimum: 1, maximum: 255 },
  },
} as const satisfies JsonSchema;

/** This schema covers the data shape. The profile definition API also checks
 * capability/viewport relations and reserved command and built-in profile ids. */
export const pocketProfileSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "platform", "form", "tickHz", "display", "capabilities"],
  properties: {
    id: { type: "string", minLength: 1 },
    platform: { type: "string", minLength: 1 },
    form: { enum: TARGET_FORMS },
    tickHz: { type: "integer", minimum: 1, maximum: 240 },
    display: {
      ...fixedDisplay,
      properties: {
        ...fixedDisplay.properties,
        dynamicViewport: {
          type: "object", additionalProperties: false, required: ["min", "max"],
          properties: { min: viewport, max: viewport, acceptsFixed: { type: "boolean" } },
        },
        auxiliary: fixedDisplay,
      },
    },
    capabilities,
    roleCapabilities: {
      type: "object", additionalProperties: false, properties: { systemUI: capabilities },
    },
    hostExtension: { type: "object" },
  },
} as const satisfies JsonSchema;

/** Projection is exact identity, not a compatibility relation. Missing optional
 * fields stay absent. Arrays retain order, including capability lists. */
export function profileHashProjection(profile: PocketProfile): Omit<PocketProfile, "hostExtension"> {
  return {
    id: profile.id,
    platform: profile.platform,
    form: profile.form,
    tickHz: profile.tickHz,
    display: profile.display,
    capabilities: profile.capabilities,
    ...(profile.roleCapabilities === undefined ? {} : { roleCapabilities: profile.roleCapabilities }),
  };
}

/** SHA-256 consumes the UTF-8 bytes of this string without a BOM or newline.
 * Object keys use UTF-16 code-unit order; arrays keep declaration order. Numbers
 * use ECMAScript JSON serialization (-0 becomes 0); NaN/Infinity, sparse arrays,
 * undefined, non-JSON objects, cycles, and lone surrogates are rejected. Strings
 * have no Unicode normalization. These rules also govern future Rust/C/Python
 * consumers; the conformance vectors in tests/profile-contract.test.ts pin them.
 */
export function canonicalProfileJson(profile: PocketProfile): string {
  const ancestors = new Set<object>();
  const quote = (value: string): string => {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
      throw new TypeError("profile identity contains an unpaired surrogate");
    }
    return JSON.stringify(value);
  };
  const encode = (value: unknown): string => {
    if (value === null || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "string") return quote(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("profile identity contains a non-finite number");
      return JSON.stringify(value);
    }
    if (typeof value !== "object") throw new TypeError(`profile identity contains ${typeof value}`);
    if (ancestors.has(value)) throw new TypeError("profile identity contains a cycle");
    ancestors.add(value);
    let result: string;
    if (Array.isArray(value)) {
      result = `[${Array.from(value, encode).join(",")}]`;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("profile identity requires JSON objects");
      const record = value as Record<string, unknown>;
      result = `{${Object.keys(record).sort().map(key => `${quote(key)}:${encode(record[key])}`).join(",")}}`;
    }
    ancestors.delete(value);
    return result;
  };
  return encode(profileHashProjection(profile));
}
