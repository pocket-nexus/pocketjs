// PocketJS platform types: presentation modes, target forms,
// execution classes, and the views of a host contract the resolver reads.
// Guest bundles import some of these at run time (contracts/spec/modality.ts
// imports the target forms); the capability registry is
// contracts/spec/capabilities.ts, which guest code imports for types alone.

import type { AnimationClass } from "./animation.ts";
import type { CapabilityRegistry } from "./capabilities.ts";

export const PRESENTATION_MODES = ["fill", "fit", "integer-fit", "native", "stretch"] as const;
export type PresentationMode = (typeof PRESENTATION_MODES)[number];
export type Viewport = readonly [width: number, height: number];

/**
 * Shell posture of a target — a semantic FIELD, deliberately not encoded in
 * the target id (ids are labels; nothing may parse them):
 *
 * - "takeover":  the app owns the whole device (consoles, fullscreen).
 * - "window":    an ordinary OS window among others.
 * - "widget":    a small always-on-top ambient surface.
 * - "kiosk":     fullscreen on a host OS, single-purpose installation.
 * - "embedded":  a surface framed inside another runtime (a launcher tile,
 *                a screen mesh in a 3D scene).
 *
 * Forms split into two viewport POLICIES: window/widget viewports are
 * runtime variables (`display.dynamicViewport` required); every other form
 * has a fixed screen (`dynamicViewport` forbidden). Apps declare viewport
 * variants per policy, not per target.
 */
export const TARGET_FORMS = ["takeover", "window", "widget", "kiosk", "embedded"] as const;
export type TargetForm = (typeof TARGET_FORMS)[number];

/**
 * How an application artifact executes on a device — a semantic FIELD like
 * TargetForm, and the top-level split in admission machinery:
 *
 * - "guest": one portable bundle runs on the embedded JS engine of every
 *   stock host. Admission is the RUNTIME rule this file defines — every
 *   feature the plan turns on ⊆ target profile `capabilities`.
 * - "aot":   the same source is recompiled natively per device by an AOT
 *   compiler family. There is no hostAbi, no
 *   ops and no runtime capability check; admission is COMPILE-TIME — the
 *   compiler derives the app's demands and checks them against a BOARD
 *   PROFILE (data, not a guest target registry entry).
 *
 * The classes scale differently on purpose: guest targets stay an inventory
 * of real, golden-tested hosts (this registry); aot boards are open-ended
 * data files validated by schema plus a physical verifier, because the MCU
 * cross product (chip × panel × input × RAM) cannot be enumerated here.
 */
export const EXECUTION_CLASSES = ["guest", "aot"] as const;
export type ExecutionClass = (typeof EXECUTION_CLASSES)[number];

/** The forms whose logical viewport is a runtime variable. */
export const DYNAMIC_FORMS: readonly TargetForm[] = ["window", "widget"];

/** One output as the resolver reads it: the profile surface with its
 *  physical panel size (`panel` in the host contract). */
export interface FixedDisplayProfile {
  readonly physicalViewport: Viewport;
  readonly logicalViewports: readonly Viewport[];
  readonly presentations: readonly PresentationMode[];
  /**
   * Target raster samples per logical pixel for baked text, vectors, masks,
   * and target-selected image variants. This is a rendering contract, not an
   * API capability or a promise that presentation scale has the same value.
   */
  readonly rasterDensity: number;
}

export interface DisplayProfile extends FixedDisplayProfile {
  /**
   * Present exactly when the target's form is dynamic (window/widget): any
   * logical size within [min, max] is admissible, and the host resizes the
   * core live (`display.viewport.live`). `logicalViewports` then lists the
   * DEFAULT size a plan bakes assets for. `acceptsFixed` opts the target
   * into hosting fixed-viewport apps in a size-locked window (an app-form
   * host would set it; a widget shell is not a general app frame and
   * leaves it off).
   */
  readonly dynamicViewport?: {
    readonly min: Viewport;
    readonly max: Viewport;
    readonly acceptsFixed?: boolean;
  };
  /**
   * A simultaneously presented fixed-size UI output owned by the same
   * AppInstance. Present only when the target advertises display.auxiliary.
   * Its raster density matches the primary display until packages can carry
   * per-surface raster asset variants.
   */
  readonly auxiliary?: FixedDisplayProfile;
  /** What a changed frame costs the target (contracts/spec/animation.ts). */
  readonly animation: AnimationClass;
}

/** The resolver's view of a host contract (hosts/contract.ts
 *  `targetProfile`). */
export interface TargetProfile<C extends string = string> {
  /** Presented frames per second the host can drive. */
  readonly cadences: readonly number[];
  /** Generated UI binding generation; all profiles use the shared constant. */
  readonly hostAbi: number;
  /** Device/OS substrate ("psp", "vita", "macos", …). Queryable data — the
   *  target id is only a label. */
  readonly platform: string;
  /** Shell posture (see TARGET_FORMS). */
  readonly form: TargetForm;
  readonly display: DisplayProfile;
  /** Framework APIs implemented and tested by this stock host. */
  readonly capabilities: readonly C[];
  /** The host contract this view was made from. A view written directly
   *  (a test registry) has none; the resolver then reads the document's
   *  facts back from the view. */
  readonly source?: import("./profile.ts").PocketProfile<C>;
}

export type TargetRegistry<C extends string = string> = Readonly<Record<string, TargetProfile<C>>>;

export function defineTargetRegistry<
  C extends string,
  const T extends TargetRegistry<C>,
>(registry: T): T {
  return registry;
}

export type TargetId<T extends TargetRegistry> = Extract<keyof T, string>;

/** Registered capability ids and the targets resolution reads. A target
 * may list ids the registry does not know; an application resolved against
 * that target lists them in `features` like registered ones. */
export interface PlatformContractRegistry<
  C extends CapabilityRegistry = CapabilityRegistry,
  T extends TargetRegistry = TargetRegistry,
> {
  readonly capabilities: C;
  readonly targets: T;
}

export function definePlatformContractRegistry<
  const C extends CapabilityRegistry,
  const T extends TargetRegistry,
>(capabilities: C, targets: T): PlatformContractRegistry<C, T> {
  return { capabilities, targets };
}
