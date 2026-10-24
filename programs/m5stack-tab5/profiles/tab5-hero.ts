import { defineProfile } from "@pocketjs/framework/profile";

/** Hero on the whole panel held in landscape (1280x720) at raster density 2. */
export default defineProfile({
  id: "tab5-hero",
  platform: "esp-idf",
  form: "takeover",
  tickHz: 60,
  display: {
    physicalViewport: [1280, 720],
    logicalViewports: [[640, 360]],
    presentations: ["native"],
    rasterDensity: 2,
  },
  capabilities: ["input.touch", "text.glyphs.baked"],
});
