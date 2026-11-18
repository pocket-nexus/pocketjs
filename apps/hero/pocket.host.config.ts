import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  hosts: [
    "psp",
    "psp-runtime",
    "vita",
    "web-app",
    "macos-widget",
    "macos-embedded",
    "pocketbook",
    "symbian-e7-dev",
  ],
  app: {
    id: "dev.pocket-nexus.hero",
    title: "PocketJS: Hero",
    version: "0.15.0",
    entry: "main.tsx",
    output: "hero-main",
    framework: "solid",
    viewport: {
      fixed: { logical: [480, 272], presentation: "integer-fit" },
      dynamic: { default: [640, 360], min: [360, 360], max: [640, 640] },
    },
    features: ["text.glyphs.baked", "input.buttons", "display.viewport.live"],
    aot: true,
    model: "compiled",
  },
});
