import { defineProfile } from "@pocketjs/framework/profile";

/**
 * Pocket Home and its applets on the Tab5 held in landscape. The picture is
 * the auxiliary surface, 640x360 at raster density 1, which the program
 * presents at 2x over the whole 1280x720 screen; the primary surface stays
 * off screen. A home control the program draws sends SELECT; the Tab5
 * keyboard on Ext.Port1, when one is attached, sends text events.
 */
export default defineProfile({
  id: "tab5-home",
  platform: "esp-idf",
  form: "takeover",
  tickHz: 30,
  display: {
    physicalViewport: [400, 240],
    logicalViewports: [[400, 240]],
    presentations: ["native"],
    rasterDensity: 1,
    auxiliary: {
      physicalViewport: [640, 360],
      logicalViewports: [[640, 360]],
      presentations: ["native"],
      rasterDensity: 1,
    },
  },
  capabilities: [
    "input.buttons",
    "input.text",
    "input.touch.auxiliary",
    "display.auxiliary",
    "text.glyphs.baked",
    "net.http",
    "link.companion",
    "system.wifi",
    "camera.qr",
    "camera.photo",
    "data.fs",
    "media.playback",
  ],
});
