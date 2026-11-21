import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  host: "3ds-runtime",
  app: {
    id: "dev.pocket-nexus.3ds-demo",
    title: "PocketJS: 3DS Dual Screen",
    version: "0.1.0",
    entry: "main.tsx",
    output: "pocket3ds-demo-main",
    framework: "solid",
    viewport: { fixed: { logical: [400, 240], presentation: "native" } },
    surfaces: { auxiliary: { fixed: { logical: [320, 240], presentation: "native" } } },
    features: [
      "text.glyphs.baked",
      "input.buttons",
      "display.auxiliary",
      "input.touch.auxiliary",
      "input.analog.left",
    ],
  },
});
