import { defineProfile } from "../../framework/src/profile.ts";
/** The Anbernic RG DS Plus: two 1024x768 MIPI DSI panels on one RK3568 VOP2
 * (DSI-1 on top, DSI-2 below), a Goodix touch panel, the gamepad and the
 * buttons through evdev. Both surfaces raster at density 2: 512x384 logical
 * points on a 4-inch 1024x768 panel. */
export default defineProfile({
  id: "rg-ds-plus", platform: "linux", form: "takeover", tickHz: 60,
  display: {
    physicalViewport: [1024, 768], logicalViewports: [[512, 384]], rasterDensity: 2, presentations: ["native"],
    auxiliary: { physicalViewport: [1024, 768], logicalViewports: [[512, 384]], rasterDensity: 2, presentations: ["native"] },
  },
  capabilities: ["input.buttons", "input.touch.auxiliary", "display.auxiliary", "text.glyphs.baked"],
  roleCapabilities: {},
});
