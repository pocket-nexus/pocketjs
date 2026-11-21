import { defineHostConfig } from "@pocketjs/framework/host-config";
import theme from "./theme.json" with { type: "json" };

export default defineHostConfig({
  hosts: ["web-app", "macos-widget", "symbian-e7-dev"],
  app: {
    id: "dev.pocket-nexus.note",
    title: "Pocket Note",
    version: "0.1.0",
    entry: "main.tsx",
    output: "note-main",
    framework: "solid",
    viewport: { dynamic: { default: [420, 560], min: [240, 180] } },
    features: [
      "text.glyphs.baked",
      "input.buttons",
      "input.text",
      "input.pointer",
      "input.ime",
      "host.clipboard",
      "display.viewport.live",
      "text.glyphs.runtime",
      "text.layout.native",
    ],
    theme,
    companions: ["note"],
  },
});
