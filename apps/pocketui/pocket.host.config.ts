import { defineHostConfig } from "@pocketjs/framework/host-config";

// The PocketUI gallery (docs/POCKETUI.md): every part of @pocketjs/framework/ui
// on one page, in each theme it ships. One source for a PSP's buttons, the
// 3DS's touch screen, a phone's touch and a desktop window's pointer.
export default defineHostConfig({
  hosts: ["psp", "psp-runtime", "3ds-runtime", "ios-dev", "macos-widget", "web-app"],
  app: {
    id: "dev.pocket-nexus.pocketui",
    title: "PocketUI Gallery",
    version: "0.1.0",
    entry: "main.tsx",
    output: "pocketui-main",
    framework: "solid",
    viewport: {
      fixed: { logical: [[480, 272], [400, 240]], presentation: "native" },
      dynamic: { default: [640, 400], min: [320, 240], max: [1600, 1200] },
    },
    surfaces: { auxiliary: { adaptive: { min: [320, 240], max: [640, 720] } } },
    features: [
      "text.glyphs.baked",
      "input.buttons",
      "input.touch",
      "input.pointer",
      "input.scroll",
      "display.auxiliary",
      "input.touch.auxiliary",
      "display.viewport.live",
    ],
  },
});
