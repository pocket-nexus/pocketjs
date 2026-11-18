import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  host: "ipodtouch-dev",
  app: {
    id: "dev.pocket-nexus.ipodtouch-demo",
    title: "PocketJS: iPod touch Hero",
    version: "0.1.0",
    entry: "main.tsx",
    output: "ipodtouch-demo-main",
    framework: "solid",
    viewport: { fixed: { logical: [320, 568], presentation: "native" } },
    features: ["input.touch", "text.glyphs.baked"],
  },
});
