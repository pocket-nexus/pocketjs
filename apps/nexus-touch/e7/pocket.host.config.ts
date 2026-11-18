import { defineHostConfig } from "@pocketjs/framework/host-config";
import theme from "./theme.json" with { type: "json" };

export default defineHostConfig({
  host: "symbian-e7-dev",
  app: {
    id: "dev.pocket-nexus.nexus-touch",
    title: "Pocket Nexus",
    version: "0.1.0",
    entry: "main.tsx",
    output: "nexus-touch-e7",
    framework: "solid",
    viewport: { dynamic: { default: [360, 640], min: [360, 640], max: [360, 640] } },
    features: ["input.touch", "ui.physics"],
    theme,
  },
});
