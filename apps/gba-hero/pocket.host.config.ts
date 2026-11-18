import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  host: "gba",
  app: {
    id: "dev.pocket-nexus.gba.hero",
    title: "PocketJS: GBA MicroTS Hero",
    version: "0.6.0",
    entry: "main.tsx",
    output: "gba-hero-main",
    framework: "solid",
    viewport: { fixed: { logical: [240, 160], presentation: "native" } },
    features: ["text.glyphs.baked", "input.buttons"],
    aot: true,
    model: "compiled",
    tickHz: 30,
  },
});
