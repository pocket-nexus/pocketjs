import type { PocketCapabilityId } from "../../contracts/spec/platform-types.ts";
import { NET_MAX_RESPONSE_BYTES } from "../../contracts/spec/net.ts";

// Replaced by tools/build.ts for bundles built from a plan. `typeof` keeps
// legacy and test builds valid without one.
declare const __POCKET_TARGET__: string;
declare const __POCKET_FEATURES__: Readonly<Partial<Record<PocketCapabilityId, boolean>>>;
declare const __POCKET_PIXEL_RATIO__: number;
declare const __POCKET_HTTP_RESPONSE_BYTES__: number;

export interface PocketPlatform {
  readonly target: string;
  /** Target raster samples per logical pixel. Use for dynamic texture producers. */
  readonly pixelRatio: number;
  /** Availability of the features the application lists in `app.features`. */
  readonly features: Readonly<Partial<Record<PocketCapabilityId, boolean>>>;
  /** The largest response body one worker `http` request may ask for
   *  (`maxBytes`) on the target: its profile's `worker.http.responseBytes`,
   *  256 KiB on a host that states none. */
  readonly httpResponseBytes: number;
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
  httpResponseBytes:
    typeof __POCKET_HTTP_RESPONSE_BYTES__ === "number" &&
      Number.isInteger(__POCKET_HTTP_RESPONSE_BYTES__) &&
      __POCKET_HTTP_RESPONSE_BYTES__ >= NET_MAX_RESPONSE_BYTES
      ? __POCKET_HTTP_RESPONSE_BYTES__
      : NET_MAX_RESPONSE_BYTES,
});

// Literal calls are folded by the PocketJS compiler. Keeping this runtime
// lookup supports computed feature ids and builds without a plan.
export function hasFeature(feature: PocketCapabilityId): boolean {
  return platform.features[feature] === true;
}
