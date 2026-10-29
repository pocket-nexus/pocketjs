import { parsePocketProfile } from "../../framework/src/profile.ts";

export default parsePocketProfile({
  format: "pocket-profile/2",
  id: "native-program-fixture",
  platform: "symbian",
  form: "window",
  cadences: [60],
  display: {
    logicalViewports: [[640, 360]],
    dynamicViewport: { min: [360, 360], max: [640, 640] },
    presentations: ["native"],
    rasterDensity: 1,
    animation: "repaint",
  },
  panel: { primary: [640, 360] },
  capabilities: ["input.buttons", "input.touch", "display.viewport.live", "text.glyphs.baked", "ui.physics"],
});
