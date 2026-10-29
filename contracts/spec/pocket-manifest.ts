import {
  PRESENTATION_MODES,
  type PresentationMode,
  type Viewport,
} from "./platform-types.ts";
import { appletSchema, type AppletDeclaration } from "./applet.ts";
import { modalityRequirementSchema, type ModalityRequirement } from "./modality.ts";
import { workerDeclarationSchema, type WorkerDeclaration } from "./worker.ts";

export const POCKET_MANIFEST_VERSION = 2 as const;
export const POCKET_MANIFEST_SCHEMA_ID = "https://pocketjs.dev/schema/pocket-2.json";

export type JsonPrimitive = boolean | number | string;
export type JsonValue = JsonPrimitive | null | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchemaObject {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly description?: string;
  /** Schema annotation; model/build resolution supplies runtime defaults. */
  readonly default?: JsonValue;
  readonly type?: "array" | "boolean" | "integer" | "number" | "object" | "string";
  readonly const?: JsonValue;
  readonly enum?: readonly JsonValue[];
  readonly anyOf?: readonly JsonSchema[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

export type JsonSchema = boolean | JsonSchemaObject;

export type PocketFramework = "solid" | "vue-vapor" | "octane";
export type KeyframeProps = Record<string, string | number>;
export type Keyframes = Record<string, KeyframeProps>;
/** Application animation content baked into the style table. */
export interface AnimationTheme {
  keyframes?: Record<string, Keyframes>;
  animation?: Record<string, string | { value: string; loop?: string | number }>;
}

export interface PocketManifestV2 {
  readonly $schema: typeof POCKET_MANIFEST_SCHEMA_ID;
  readonly pocket: typeof POCKET_MANIFEST_VERSION;
  readonly id: string;
  readonly title: string;
  readonly version: string;
  /** Who publishes the application; repacked programs record it. */
  readonly author?: string;
  /**
   * A square PNG, relative to this file. `pocket compile` stores it as each
   * variant's cover section; `pocket pack` uses it when no `--icon` is given.
   */
  readonly icon?: string;
  /**
   * Declares the package a Pocket Applet (contracts/spec/applet.ts): the
   * program a launcher runs, held to the applet rules at resolution and
   * build. Absent, the package is an ordinary app.
   */
  readonly applet?: AppletDeclaration;
  readonly engine: {
    readonly capabilities: {
      readonly requires: readonly string[];
      readonly enhances?: readonly string[];
    };
  };
  readonly app: {
    readonly entry: string;
    readonly output?: string;
    readonly framework: PocketFramework;
    /**
     * The path of a module or JSON file, relative to this file, whose default
     * export is the animation content. `readPocketManifest` replaces the path
     * with the content; a build plan and a package carry the content.
     */
    readonly theme?: string | AnimationTheme;
    /** Admit the complete Solid component graph to the AOT view subset. */
    readonly aot?: boolean;
    readonly model?: "rust" | "compiled";
    readonly recursionLimit?: number;
    /**
     * Core ticks per virtual second the package is compiled at, 1 through
     * 60; absent, 60. A host runs it at the largest cadence the rate is a
     * whole multiple of and advances the core by rate / cadence ticks per
     * frame (contracts/spec/admission.ts).
     */
    readonly tickHz?: number;
    readonly viewport: ManifestViewport;
    /** Additional UI output intent. Physical geometry remains target-owned. */
    readonly surfaces?: {
      readonly auxiliary: AuxiliarySurfaceSpec;
    };
    /**
     * Companion service names the app's svc adapters speak (the exact
     * strings it passes to `svcOpen`). Hosts derive their svc allowlist
     * and adapter wiring from the resolved plan's copy of this list —
     * never from app-name conventions (issue #295). Absent = the app
     * runs standalone everywhere; svcOpen answers false by default.
     */
    readonly companions?: readonly string[];
    /**
     * Alternative entry modules addressed to device modalities, tested in
     * order against the target's derived modality (contracts/spec/
     * modality.ts). The first match is the presentation a build compiles;
     * when none matches, `app.entry` with the app-level viewport, surfaces
     * and capabilities is the baseline presentation. Each presentation may
     * carry its own viewport, surfaces and output name, and adds its
     * capabilities to the app-level declaration.
     */
    readonly presentations?: readonly PresentationSpec[];
    /**
     * The modality the baseline `app.entry` serves. A device that meets no
     * presentation's requirement and not this one is refused at admission:
     * a touch-only application states `{ "touch": "primary" }` and a
     * button-only device never compiles it. Absent, the baseline serves
     * every device.
     */
    readonly modality?: ModalityRequirement;
  };
  /**
   * Execution domains beside the UI realm. `worker` runs its entry in a
   * second QuickJS runtime owned by the host (contracts/spec/worker.ts).
   */
  readonly domains?: {
    readonly worker?: WorkerDeclaration;
  };
}

/** One presentation: an entry module addressed to a device modality. */
export interface PresentationSpec {
  readonly id: string;
  readonly entry: string;
  readonly output?: string;
  readonly modality: ModalityRequirement;
  readonly viewport?: ManifestViewport;
  readonly surfaces?: {
    readonly auxiliary: AuxiliarySurfaceSpec;
  };
  /** Added to `engine.capabilities`; a presentation `requires` entry may
   *  promote an app-level `enhances` entry. */
  readonly capabilities?: {
    readonly requires?: readonly string[];
    readonly enhances?: readonly string[];
  };
}

/** An inclusive range of logical sizes. */
export interface ViewportRange {
  readonly min: Viewport;
  readonly max: Viewport;
}

/**
 * A fixed-screen viewport declaration (takeover/kiosk/embedded targets).
 * `logical` is one size, a list of sizes in preference order, or a range;
 * the resolver takes the first size the target lists.
 */
export interface FixedViewportSpec {
  readonly logical: Viewport | readonly Viewport[] | ViewportRange;
  readonly presentation: PresentationMode;
}

/** An auxiliary surface's fixed declaration: one size. */
export interface FixedSurfaceSpec {
  readonly logical: Viewport;
  readonly presentation: PresentationMode;
}

/**
 * An auxiliary surface the application lays out at any logical size from
 * `min` through `max`: the target presents its own auxiliary size when that
 * size lies in the range, at native presentation. The application reads the
 * size at run time (`auxiliaryViewport()`).
 */
export interface AdaptiveViewportSpec {
  readonly min: Viewport;
  readonly max: Viewport;
}

/** `fixed` requires the target's size; `adaptive` takes it. One of the two. */
export type AuxiliarySurfaceSpec =
  | { readonly fixed: FixedSurfaceSpec; readonly adaptive?: undefined }
  | { readonly adaptive: AdaptiveViewportSpec; readonly fixed?: undefined };

/** A dynamic-window viewport declaration (window/widget targets). */
export interface DynamicViewportSpec {
  readonly default: Viewport;
  readonly min?: Viewport;
  readonly max?: Viewport;
}

/**
 * Apps declare viewport intent per POLICY, not per target: `fixed` admits
 * on fixed-screen forms, `dynamic` on window forms; declaring both makes a
 * dual-nature app. The bare `{logical, presentation}` spelling remains
 * valid as shorthand for `{fixed: …}` (format-2 compatibility).
 */
export type ManifestViewport =
  | FixedViewportSpec
  | {
      readonly fixed?: FixedViewportSpec;
      readonly dynamic?: DynamicViewportSpec;
    };

export const animationThemeSchema = {
  type: "object", additionalProperties: false,
  properties: {
    keyframes: {
      type: "object", additionalProperties: {
        type: "object", additionalProperties: {
          type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
      },
    },
    animation: {
      type: "object", additionalProperties: {
        anyOf: [
          { type: "string" },
          { type: "object", additionalProperties: false, required: ["value"], properties: {
            value: { type: "string" }, loop: { anyOf: [{ type: "string" }, { type: "number" }] },
          } },
        ],
      },
    },
  },
} as const satisfies JsonSchema;

const capabilityIdSchema = {
  type: "string",
  pattern: "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$",
} as const satisfies JsonSchema;

const viewportSizeSchema = {
  type: "array",
  items: { type: "integer", minimum: 1 },
  minItems: 2,
  maxItems: 2,
} as const satisfies JsonSchema;

/** One auxiliary size. */
const fixedSurfaceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["logical", "presentation"],
  properties: {
    logical: viewportSizeSchema,
    presentation: { enum: PRESENTATION_MODES },
  },
} as const satisfies JsonSchema;

/** The primary fixed viewport: one size, a preference list or a range. */
const fixedViewportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["logical", "presentation"],
  properties: {
    logical: {
      anyOf: [
        viewportSizeSchema,
        { type: "array", items: viewportSizeSchema, minItems: 1, uniqueItems: true },
        {
          type: "object",
          additionalProperties: false,
          required: ["min", "max"],
          properties: { min: viewportSizeSchema, max: viewportSizeSchema },
        },
      ],
    },
    presentation: { enum: PRESENTATION_MODES },
  },
} as const satisfies JsonSchema;

const surfacesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["auxiliary"],
  properties: {
    auxiliary: {
      type: "object",
      additionalProperties: false,
      description: "Exactly one of fixed and adaptive (checked at resolution).",
      properties: {
        fixed: fixedSurfaceSchema,
        adaptive: {
          type: "object",
          additionalProperties: false,
          required: ["min", "max"],
          properties: { min: viewportSizeSchema, max: viewportSizeSchema },
        },
      },
    },
  },
} as const satisfies JsonSchema;

const entrySchema = {
  type: "string",
  minLength: 1,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+\\.tsx?$",
} as const satisfies JsonSchema;

const outputSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
} as const satisfies JsonSchema;

/** Policy variants: fixed and/or dynamic. An empty object is schema-valid
 *  but semantically caught by the resolver (viewport.fixedRequired /
 *  viewport.dynamicRequired). The bare fixed spelling is format-2
 *  compatibility. */
const manifestViewportSchema = {
  anyOf: [
    fixedViewportSchema,
    {
      type: "object",
      additionalProperties: false,
      properties: {
        fixed: fixedViewportSchema,
        dynamic: {
          type: "object",
          additionalProperties: false,
          required: ["default"],
          properties: {
            default: viewportSizeSchema,
            min: viewportSizeSchema,
            max: viewportSizeSchema,
          },
        },
      },
    },
  ],
} as const satisfies JsonSchema;

const presentationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "entry", "modality"],
  properties: {
    id: outputSchema,
    entry: entrySchema,
    output: outputSchema,
    modality: modalityRequirementSchema,
    viewport: manifestViewportSchema,
    surfaces: surfacesSchema,
    capabilities: {
      type: "object",
      additionalProperties: false,
      properties: {
        requires: { type: "array", items: capabilityIdSchema, uniqueItems: true },
        enhances: { type: "array", items: capabilityIdSchema, uniqueItems: true },
      },
    },
  },
} as const satisfies JsonSchema;

/** Strict format-2 application intent. Platform facts stay in target profiles. */
export const pocketManifestV2Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: POCKET_MANIFEST_SCHEMA_ID,
  title: "Pocket application manifest, format 2",
  type: "object",
  additionalProperties: false,
  required: ["$schema", "pocket", "id", "title", "version", "engine", "app"],
  properties: {
    $schema: { const: POCKET_MANIFEST_SCHEMA_ID },
    pocket: { const: POCKET_MANIFEST_VERSION },
    id: {
      type: "string",
      minLength: 3,
      pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$",
    },
    title: { type: "string", minLength: 1, maxLength: 128 },
    version: {
      type: "string",
      pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
    },
    author: { type: "string", minLength: 1, maxLength: 128 },
    icon: { type: "string", minLength: 1, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+\\.png$" },
    applet: appletSchema,
    engine: {
      type: "object",
      additionalProperties: false,
      required: ["capabilities"],
      properties: {
        capabilities: {
          type: "object",
          additionalProperties: false,
          required: ["requires"],
          properties: {
            requires: {
              type: "array",
              items: capabilityIdSchema,
              minItems: 1,
              uniqueItems: true,
            },
            enhances: {
              type: "array",
              items: capabilityIdSchema,
              uniqueItems: true,
            },
          },
        },
      },
    },
    domains: {
      type: "object",
      additionalProperties: false,
      properties: { worker: workerDeclarationSchema },
    },
    app: {
      type: "object",
      additionalProperties: false,
      required: ["entry", "framework", "viewport"],
      properties: {
        entry: entrySchema,
        output: outputSchema,
        framework: { enum: ["solid", "vue-vapor", "octane"] },
        theme: { type: "string", minLength: 1 },
        aot: { type: "boolean" },
        model: { enum: ["rust", "compiled"] },
        recursionLimit: { type: "integer", minimum: 1, default: 256 },
        tickHz: { type: "integer", minimum: 1, maximum: 60, default: 60 },
        surfaces: surfacesSchema,
        companions: {
          type: "array",
          items: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
          },
          uniqueItems: true,
        },
        viewport: manifestViewportSchema,
        presentations: {
          type: "array",
          items: presentationSchema,
          minItems: 1,
        },
        modality: modalityRequirementSchema,
      },
    },
  },
} as const satisfies JsonSchema;

/**
 * The schema `validatePocketManifest` applies: the published file schema,
 * with `app.theme` also accepting the content `readPocketManifest` loads in
 * place of the path. Packages embed that loaded form.
 */
export const loadedManifestSchema = {
  ...pocketManifestV2Schema,
  properties: {
    ...pocketManifestV2Schema.properties,
    app: {
      ...pocketManifestV2Schema.properties.app,
      properties: {
        ...pocketManifestV2Schema.properties.app.properties,
        theme: { anyOf: [animationThemeSchema, { type: "string", minLength: 1 }] },
      },
    },
  },
} as const satisfies JsonSchema;

export function generatePocketManifestV2Schema(): string {
  return JSON.stringify(pocketManifestV2Schema, null, 2) + "\n";
}
