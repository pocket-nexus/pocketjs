import { defineHostConfig } from "@pocketjs/framework/host-config";
import theme from "./theme.json" with { type: "json" };

export default defineHostConfig({
  host: "psp",
  app: {
    id: "dev.pocket-nexus.text-cjk",
    title: "PocketJS: Text Lab",
    version: "0.1.0",
    entry: "main.tsx",
    output: "text-cjk-main",
    framework: "solid",
    viewport: { fixed: { logical: [480, 272], presentation: "integer-fit" } },
    features: ["text.glyphs.baked", "text.glyphs.streamed", "io.offload", "input.buttons"],
    theme,
  },
});
