import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  hosts: ["psp", "web-app"],
  app: {
    id: "dev.pocket-nexus.text-offload",
    title: "Portable Text Layout",
    version: "0.1.0",
    entry: "main.tsx",
    output: "text-offload-main",
    framework: "solid",
    viewport: { fixed: { logical: [480, 272], presentation: "native" } },
    features: ["text.glyphs.baked", "input.buttons", "io.offload", "text.layout.offload"],
  },
});
