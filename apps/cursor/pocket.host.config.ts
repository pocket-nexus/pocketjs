import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  hosts: ["psp", "psp-runtime", "vita", "web-app", "macos-embedded", "pocketbook"],
  app: {
    id: "dev.pocket-nexus.cursor",
    title: "PocketJS: Cursor",
    version: "0.6.0",
    entry: "main.tsx",
    output: "cursor-main",
    framework: "solid",
    viewport: { fixed: { logical: [480, 272], presentation: "integer-fit" } },
    features: ["text.glyphs.baked", "input.buttons", "input.cursor"],
  },
});
