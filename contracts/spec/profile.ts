// Host contracts: what a host program promises, as JSON. The compiler
// bakes these facts into a package; a device admits a package when its own
// facts satisfy the package's (contracts/spec/admission.ts).
import type { JsonSchema } from "./pocket-manifest.ts";
import {
  ANIMATION_CLASSES,
  PRESENTATION_MODES,
  TARGET_FORMS,
  type AnimationClass,
  type PresentationMode,
  type TargetForm,
  type Viewport,
} from "./platform-types.ts";
import { WORKER_RESOURCES, type WorkerResourceKind } from "./worker.ts";

export const POCKET_PROFILE_FORMAT = "pocket-host/2" as const;
export const POCKET_PROFILE_SCHEMA_ID = "https://pocketjs.dev/schema/pocket-host-2.json";
/** The file a firmware release ships beside its binary. */
export const POCKET_PROFILE_FILE = "pocket.host.json";

/** One UI output's logical sizes, presentations and raster density. */
export interface ProfileSurface {
  readonly logicalViewports: readonly Viewport[];
  readonly presentations: readonly PresentationMode[];
  /** Raster samples per logical pixel for baked text, vectors and images. */
  readonly rasterDensity: number;
}

export interface ProfileDisplay extends ProfileSurface {
  /** What a changed frame costs this host (contracts/spec/animation.ts). */
  readonly animation: AnimationClass;
  /** Window and widget forms: any logical size in [min, max]; the logical
   *  viewports list the default size. `acceptsFixed` hosts fixed-viewport
   *  applications in a size-locked window. */
  readonly dynamicViewport?: {
    readonly min: Viewport;
    readonly max: Viewport;
    readonly acceptsFixed?: boolean;
  };
  /** A second fixed UI output presented with the primary one. */
  readonly auxiliary?: ProfileSurface;
}

/** A host program's facts. Admission compares the display, cadences and
 *  capabilities; the panel, worker table, limits and input parameters are
 *  runtime facts the exporter hands to the program. */
export interface PocketProfile<C extends string = string> {
  readonly $schema?: string;
  readonly format: typeof POCKET_PROFILE_FORMAT;
  readonly id: string;
  readonly platform: string;
  readonly form: TargetForm;
  /** Presented frames per second the host can drive. A package runs at the
   *  largest cadence its tick rate is a whole multiple of. */
  readonly cadences: readonly number[];
  readonly display: ProfileDisplay;
  /** Physical panel sizes in pixels. */
  readonly panel: {
    readonly primary: Viewport;
    readonly auxiliary?: Viewport;
  };
  /** Capability names; a set. */
  readonly capabilities: readonly C[];
  readonly roleCapabilities?: { readonly systemUI?: readonly C[] };
  /** Worker nodes the host provides, by kind: the most nodes of that kind
   *  one package may declare. */
  readonly worker?: { readonly nodes: Readonly<Partial<Record<WorkerResourceKind, number>>> };
  readonly limits?: {
    /** The largest `.pocket` the host loads. */
    readonly packageBytes?: number;
    /** The guest heap the host gives a package. */
    readonly heapBytes?: number;
  };
  readonly input?: {
    /** Simultaneous touch contacts the host reports. */
    readonly touchContacts?: number;
    /** Bits of a touch coordinate on the input wire (9 or 10). */
    readonly coordinateBits?: number;
  };
  /** The QuickJS engine ABI the program embeds (quickjs-bytecode.ts): the
   *  compiler then adds bytecode sections for it. `source` keeps the source
   *  sections beside them (the default) or drops them. */
  readonly bytecode?: { readonly engine: string; readonly source?: "keep" | "drop" };
  /** Metadata only; nothing reads it for compilation or admission. */
  readonly hostExtension?: Readonly<Record<string, unknown>>;
  /** The binding generation a release stamped; another one is refused. */
  readonly hostAbi?: number;
}

export const PROFILE_HASH_ALGORITHM = "sha256" as const;
export const PROFILE_HASH_BYTES = 32;
/** The fields the provenance hash covers. Admission does not compare it. */
export const PROFILE_HASH_FIELDS = [
  "id", "platform", "form", "cadences", "display", "capabilities", "roleCapabilities",
] as const;

export type ProfileHashProjection = Pick<PocketProfile, (typeof PROFILE_HASH_FIELDS)[number]>;

const viewport = {
  type: "array", items: { type: "integer", minimum: 1, maximum: 65535 },
  minItems: 2, maxItems: 2,
} as const satisfies JsonSchema;
const names = {
  type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true,
} as const satisfies JsonSchema;
const surface = {
  type: "object", additionalProperties: false,
  required: ["logicalViewports", "presentations", "rasterDensity"],
  properties: {
    logicalViewports: { type: "array", items: viewport, minItems: 1, uniqueItems: true },
    presentations: { type: "array", items: { enum: PRESENTATION_MODES }, minItems: 1, uniqueItems: true },
    rasterDensity: { type: "integer", minimum: 1, maximum: 255 },
  },
} as const satisfies JsonSchema;
const display = {
  ...surface,
  required: [...surface.required, "animation"],
  properties: {
    ...surface.properties,
    animation: { enum: ANIMATION_CLASSES },
    dynamicViewport: {
      type: "object", additionalProperties: false, required: ["min", "max"],
      properties: { min: viewport, max: viewport, acceptsFixed: { type: "boolean" } },
    },
    auxiliary: surface,
  },
} as const satisfies JsonSchema;
const cadences = {
  type: "array", items: { type: "integer", minimum: 1, maximum: 240 }, minItems: 1, uniqueItems: true,
} as const satisfies JsonSchema;
const roleCapabilities = {
  type: "object", additionalProperties: false, properties: { systemUI: names },
} as const satisfies JsonSchema;

/** The data shape of a pocket-host/2 document. framework/src/profile.ts
 *  adds the relations between fields. */
export const pocketProfileSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: POCKET_PROFILE_SCHEMA_ID,
  title: "Pocket profile, format 2",
  type: "object", additionalProperties: false,
  required: ["format", "id", "platform", "form", "cadences", "display", "panel", "capabilities"],
  properties: {
    $schema: { type: "string" },
    format: { const: POCKET_PROFILE_FORMAT },
    id: { type: "string", minLength: 1 },
    platform: { type: "string", minLength: 1 },
    form: { enum: TARGET_FORMS },
    cadences,
    display,
    panel: {
      type: "object", additionalProperties: false, required: ["primary"],
      properties: { primary: viewport, auxiliary: viewport },
    },
    capabilities: names,
    roleCapabilities,
    worker: {
      type: "object", additionalProperties: false, required: ["nodes"],
      properties: {
        nodes: {
          type: "object", additionalProperties: false,
          properties: Object.fromEntries(Object.keys(WORKER_RESOURCES).map(kind => [kind, { type: "integer", minimum: 0, maximum: 255 }])),
        },
      },
    },
    limits: {
      type: "object", additionalProperties: false,
      properties: {
        packageBytes: { type: "integer", minimum: 1 },
        heapBytes: { type: "integer", minimum: 1 },
      },
    },
    input: {
      type: "object", additionalProperties: false,
      properties: {
        touchContacts: { type: "integer", minimum: 1, maximum: 16 },
        coordinateBits: { enum: [9, 10] },
      },
    },
    bytecode: {
      type: "object", additionalProperties: false, required: ["engine"],
      properties: { engine: { type: "string", minLength: 1 }, source: { enum: ["keep", "drop"] } },
    },
    hostExtension: { type: "object" },
    hostAbi: { type: "integer", minimum: 1, maximum: 0xffff_ffff },
  },
} as const satisfies JsonSchema;

/** The profile a plan records: the document without its release stamp,
 * schema reference and metadata. */
export type CompiledProfile = Omit<PocketProfile, "$schema" | "hostAbi" | "hostExtension">;

/** Drop the fields that do not describe the host. */
export function compiledProfile(profile: PocketProfile): CompiledProfile {
  const { $schema: _schema, hostAbi: _hostAbi, hostExtension: _extension, ...compiled } = profile;
  return compiled;
}

export function generatePocketProfileSchema(): string {
  return JSON.stringify(pocketProfileSchema, null, 2) + "\n";
}

const byCodeUnit = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** The hashed fields. Capability lists and cadences are sets: sorted here.
 *  Missing optional fields stay absent; viewport lists keep their order. */
export function profileHashProjection(profile: ProfileHashProjection): ProfileHashProjection {
  const systemUI = profile.roleCapabilities?.systemUI;
  return {
    id: profile.id,
    platform: profile.platform,
    form: profile.form,
    cadences: [...profile.cadences].sort((left, right) => left - right),
    display: profile.display,
    capabilities: [...profile.capabilities].sort(byCodeUnit),
    ...(profile.roleCapabilities === undefined ? {} : {
      roleCapabilities: systemUI === undefined ? {} : { systemUI: [...systemUI].sort(byCodeUnit) },
    }),
  };
}

/** Canonical JSON text: object keys in UTF-16 code-unit order, arrays in
 * order, ECMAScript number serialization (-0 becomes 0). NaN/Infinity, sparse
 * arrays, undefined, non-JSON objects, cycles and lone surrogates are
 * rejected; strings have no Unicode normalization. */
export function canonicalJsonText(input: unknown): string {
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
  return encode(input);
}

/** The text the provenance hash covers: canonical JSON of the projection.
 * SHA-256 consumes its UTF-8 bytes without a BOM or newline.
 * tests/profile-contract.test.ts pins the rules for other consumers; the
 * hash is provenance, so each consumer computes it when it needs it. */
export function canonicalProfileJson(profile: ProfileHashProjection): string {
  return canonicalJsonText(profileHashProjection(profile));
}
