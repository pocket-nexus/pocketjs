import { defineHostConfig } from "@pocketjs/framework/host-config";
import theme from "./theme.json" with { type: "json" };

export default defineHostConfig({
  host: "ipodtouch4-dev",
  app: {
    id: "dev.pocket-nexus.nexus-touch",
    title: "Pocket Nexus",
    version: "0.1.0",
    entry: "main.tsx",
    output: "nexus-touch-main",
    framework: "solid",
    viewport: { fixed: { logical: [320, 480], presentation: "native" } },
    features: ["input.touch", "ui.physics"],
    theme,
  },
});
