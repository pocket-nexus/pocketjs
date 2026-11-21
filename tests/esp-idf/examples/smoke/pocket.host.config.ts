import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  host: "./pocket.host.json",
  app: {
    id: "dev.pocket-nexus.idf-smoke",
    title: "ESP-IDF Smoke",
    version: "0.1.0",
    entry: "main.tsx",
    output: "idf-smoke",
    framework: "solid",
    viewport: { logical: [320, 240], presentation: "native" },
    features: ["input.buttons", "text.glyphs.baked"],
  },
});
