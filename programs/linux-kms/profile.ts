import { defineProfile } from "../../framework/src/profile.ts";
/** Product example; physical modes are deployment facts, not renderer features. */
export default defineProfile({
  id: "product-linux-kms", platform: "linux", form: "embedded", tickHz: 60,
  display: { physicalViewport: [800, 600], logicalViewports: [[800, 600]], rasterDensity: 1, presentations: ["native"] },
  capabilities: ["input.buttons", "text.glyphs.baked"], roleCapabilities: {},
});
