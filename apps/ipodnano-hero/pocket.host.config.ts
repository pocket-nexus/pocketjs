import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  host: "ipodnano",
  app: {
    id: "dev.pocket-nexus.ipodnano.hero",
    title: "PocketJS: iPod nano MicroTS Hero",
    version: "0.6.0",
    entry: "main.tsx",
    output: "ipodnano-hero-main",
    framework: "solid",
    viewport: { fixed: { logical: [176, 132], presentation: "native" } },
    features: ["text.glyphs.baked", "input.buttons"],
    aot: true,
    model: "compiled",
  },
});
