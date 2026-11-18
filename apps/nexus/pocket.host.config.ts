import { defineHostConfig } from "@pocketjs/framework/host-config";
import theme from "./theme.json" with { type: "json" };

export default defineHostConfig({
  host: "3ds-runtime",
  app: {
    id: "dev.pocket-nexus.nexus",
    title: "Pocket Nexus",
    version: "0.1.0",
    entry: "main.tsx",
    output: "nexus-main",
    framework: "solid",
    viewport: { fixed: { logical: [400, 240], presentation: "native" } },
    surfaces: { auxiliary: { fixed: { logical: [320, 240], presentation: "native" } } },
    features: [
      "text.glyphs.baked",
      "input.buttons",
      "display.auxiliary",
      "input.touch.auxiliary",
      "ui.physics",
    ],
    theme,
  },
});
