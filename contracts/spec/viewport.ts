// What an application states about its screens: the primary viewport it lays
// out at and the auxiliary surface it draws on. Physical geometry stays in
// the host contract; the build resolver (framework/compiler/app-plan.ts)
// picks the size a host presents and records it in the build plan.
import type { JsonSchema } from "./json-schema.ts";
import { PRESENTATION_MODES, type PresentationMode, type Viewport } from "./platform-types.ts";

/** An inclusive range of logical sizes. */
export interface ViewportRange {
  readonly min: Viewport;
  readonly max: Viewport;
}

/**
 * A fixed-screen viewport (takeover, kiosk and embedded forms). `logical` is
 * one size, a list of sizes in preference order, or a range; the resolver
 * takes the first size the host lists.
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
 * `min` through `max`: the host presents its own auxiliary size when that
 * size lies in the range, at native presentation. The application reads the
 * size at run time (`auxiliaryViewport()`).
 */
export interface AdaptiveViewportSpec {
  readonly min: Viewport;
  readonly max: Viewport;
}

/** `fixed` requires the host's size; `adaptive` takes it. One of the two. */
export type AuxiliarySurfaceSpec =
  | { readonly fixed: FixedSurfaceSpec; readonly adaptive?: undefined }
  | { readonly adaptive: AdaptiveViewportSpec; readonly fixed?: undefined };

/** Additional UI outputs beside the primary viewport. */
export interface SurfacesSpec {
  readonly auxiliary: AuxiliarySurfaceSpec;
}

/** A dynamic-window viewport (window and widget forms). */
export interface DynamicViewportSpec {
  readonly default: Viewport;
  readonly min?: Viewport;
  readonly max?: Viewport;
}

/**
 * The application's viewport per policy: `fixed` is hosted by fixed-screen
 * forms, `dynamic` by window forms; stating both serves both. The bare
 * `{logical, presentation}` spelling is shorthand for `{fixed: …}`.
 */
export type AppViewport =
  | FixedViewportSpec
  | {
      readonly fixed?: FixedViewportSpec;
      readonly dynamic?: DynamicViewportSpec;
    };

export const viewportSizeSchema = {
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

export const surfacesSchema = {
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

/** Policy variants: fixed and/or dynamic. An empty object is schema-valid
 *  and refused at resolution (viewport.fixedRequired /
 *  viewport.dynamicRequired). */
export const appViewportSchema = {
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
