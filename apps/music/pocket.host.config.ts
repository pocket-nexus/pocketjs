import { defineHostConfig } from "@pocketjs/framework/host-config";
import theme from "./theme.json" with { type: "json" };

export default defineHostConfig({
  hosts: ["psp", "psp-runtime", "vita", "web-app", "macos-embedded", "pocketbook"],
  app: {
    id: "dev.pocket-nexus.music",
    title: "PocketJS: Now Playing",
    version: "0.6.0",
    entry: "main.tsx",
    output: "music-main",
    framework: "solid",
    viewport: { fixed: { logical: [480, 272], presentation: "integer-fit" } },
    features: ["text.glyphs.baked", "input.buttons", "audio.pcm"],
    theme,
  },
});
