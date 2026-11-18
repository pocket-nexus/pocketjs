import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  hosts: ["psp", "psp-runtime", "vita", "web-app", "macos-embedded", "pocketbook"],
  app: {
    id: "dev.pocket-nexus.devkit",
    title: "Pocket Devkit",
    version: "0.1.0",
    entry: "main.tsx",
    output: "devkit-main",
    framework: "solid",
    viewport: { fixed: { logical: [480, 272], presentation: "integer-fit" } },
    features: ["text.glyphs.baked", "input.buttons"],
  },
});
