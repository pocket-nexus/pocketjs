import { defineProfile } from "@pocketjs/framework/profile";

/** Pocket Clear on the whole 720x1280 portrait panel at raster density 2. */
export default defineProfile({
  id: "tab5-clear",
  platform: "esp-idf",
  form: "takeover",
  tickHz: 30,
  display: {
    physicalViewport: [720, 1280],
    logicalViewports: [[360, 640]],
    presentations: ["native"],
    rasterDensity: 2,
  },
  capabilities: ["input.touch", "text.glyphs.baked"],
});
