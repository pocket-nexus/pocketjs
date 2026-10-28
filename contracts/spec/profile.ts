// Profile identity contract, shared by application compilation and Runtime admission.
import type { JsonSchema } from "./pocket-manifest.ts";
import {
  ANIMATION_CLASSES,
  PRESENTATION_MODES,
  TARGET_FORMS,
  type DisplayProfile,
  type PocketCapabilityId,
  type PresentationMode,
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

/** Native profile export masks. Assignments are append-only and do not follow
 * the capability registry's display order. These masks are derived convenience
 * data; canonical JSON remains the profile identity and admission contract. */
export const PROFILE_CAPABILITY_BITS = {
  "runtime.worker": 0x40000000n,
  "io.i2c": 0x80000000n,
  "io.uart": 0x100000000n,
  "input.analog.left": 0x00000001n,
  "input.analog.right": 0x00000002n,
  "input.buttons": 0x00000004n,
  "input.cursor": 0x00000008n,
  "input.ime": 0x00000010n,
  "input.pointer": 0x00000020n,
  "input.text": 0x00000040n,
  "input.touch": 0x00000080n,
  "input.touch.auxiliary": 0x00000100n,
  "ui.compositor-surfaces": 0x00000200n,
  "ui.physics": 0x00000400n,
  "audio.pcm": 0x00000800n,
  "media.playback": 0x00001000n,
  "io.offload": 0x00002000n,
  "net.http": 0x00004000n,
  "link.companion": 0x00008000n,
  "system.wifi": 0x00010000n,
  "camera.qr": 0x00020000n,
  "system.agent": 0x00040000n,
  // 0x00080000n was data.sqlite, retired in October 2026; the bit stays unassigned.
  "data.fs": 0x00100000n,
  "host.clipboard": 0x00200000n,
  "display.viewport.live": 0x00400000n,
  "display.auxiliary": 0x00800000n,
  "text.glyphs.baked": 0x01000000n,
  "text.glyphs.streamed": 0x02000000n,
  "text.glyphs.runtime": 0x04000000n,
  "text.layout.native": 0x08000000n,
  "text.layout.offload": 0x10000000n,
  "camera.photo": 0x20000000n,
} as const satisfies Readonly<Record<PocketCapabilityId, bigint>>;

/** Append-only native presentation mask assignments. */
export const PROFILE_PRESENTATION_BITS = {
  fill: 0x01, fit: 0x02, "integer-fit": 0x04, native: 0x08, stretch: 0x10,
} as const satisfies Readonly<Record<PresentationMode, number>>;

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
        animation: { enum: ANIMATION_CLASSES },
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
