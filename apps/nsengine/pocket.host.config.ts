import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  hosts: ["vita", "pocketbook", "ios-dev"],
  app: {
    id: "dev.pocket-nexus.nsengine",
    title: "PocketJS NS Engine",
    version: "0.1.0",
    entry: "main.tsx",
    output: "nsengine-main",
    framework: "solid",
    viewport: { fixed: { logical: [480, 272], presentation: "integer-fit" } },
    features: ["input.touch", "text.glyphs.baked"],
  },
});
