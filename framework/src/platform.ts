import type { PocketCapabilityId } from "../../contracts/spec/platform-types.ts";

// Replaced by tools/build.ts for manifest-driven bundles. `typeof` keeps
// legacy and test builds valid until they opt into pocket.app.json.
declare const __POCKET_TARGET__: string;
declare const __POCKET_FEATURES__: Readonly<Partial<Record<PocketCapabilityId, boolean>>>;
declare const __POCKET_PIXEL_RATIO__: number;

export interface PocketPlatform {
  readonly target: string;
  /** Target raster samples per logical pixel. Use for dynamic texture producers. */
  readonly pixelRatio: number;
  /** Availability of APIs declared under engine.capabilities in pocket.app.json. */
  readonly features: Readonly<Partial<Record<PocketCapabilityId, boolean>>>;
}

const features = typeof __POCKET_FEATURES__ === "object" && __POCKET_FEATURES__ !== null
  ? Object.freeze({ ...__POCKET_FEATURES__ })
  : Object.freeze({});

/** Build-time host API availability. Permissions and live device state are separate APIs. */
export const platform: PocketPlatform = Object.freeze({
  target: typeof __POCKET_TARGET__ === "string" ? __POCKET_TARGET__ : "unknown",
  pixelRatio:
    typeof __POCKET_PIXEL_RATIO__ === "number" &&
      Number.isInteger(__POCKET_PIXEL_RATIO__) &&
      __POCKET_PIXEL_RATIO__ > 0
      ? __POCKET_PIXEL_RATIO__
      : 1,
  features,
});

// Literal calls are folded by the PocketJS compiler. Keeping this runtime
// lookup supports computed feature ids and non-manifest builds.
export function hasFeature(feature: PocketCapabilityId): boolean {
  return platform.features[feature] === true;
}
