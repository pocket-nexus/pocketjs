import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Private exact-device profile for the iPod touch 4 running iOS 6.1.6.
 *
 * The display tuple is byte-identical to the iPhone 4S (320x480 logical at
 * density 2 on a 640x960 panel), and the host is the same legacy UIKit
 * runtime with the same base op table, so it shares host ABI 8 rather than
 * claiming a new protocol revision. The target id is what names the device.
 * The optional families ride on that table behind their capabilities:
 * io.offload, and ui.physics (ops 52..56), which the build compiles in for
 * an app whose plan resolved it. The guest is embedded in the same binary as
 * its host, so no bundle can meet a host without the ops its plan admitted.
 */
export const IPODTOUCH4_DEV_TARGET_ID = "ipodtouch4-dev";
export const IPODTOUCH4_DEV_HOST_ABI = 8;
export const IPODTOUCH4_LOGICAL_VIEWPORT = [320, 480] as const;
/** The same panel a quarter turn over: the host rotates its content view and
 *  presents 480x320 logical on the 960x640 drawable (hosts/ios-legacy/runtime.c). */
export const IPODTOUCH4_LANDSCAPE_VIEWPORT = [480, 320] as const;
export const IPODTOUCH4_PHYSICAL_VIEWPORT = [640, 960] as const;
export const IPODTOUCH4_RASTER_DENSITY = 2;

export const IPODTOUCH4_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [IPODTOUCH4_DEV_TARGET_ID]: {
      hostAbi: IPODTOUCH4_DEV_HOST_ABI,
      platform: "ios",
      form: "takeover",
      display: {
        physicalViewport: IPODTOUCH4_PHYSICAL_VIEWPORT,
        logicalViewports: [IPODTOUCH4_LOGICAL_VIEWPORT, IPODTOUCH4_LANDSCAPE_VIEWPORT],
        presentations: ["native"],
        rasterDensity: IPODTOUCH4_RASTER_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked", "io.offload", "ui.physics"],
    },
  }),
);

export function resolveIPodTouch4BuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: IPODTOUCH4_DEV_TARGET_ID },
    IPODTOUCH4_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket ipodtouch4: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
