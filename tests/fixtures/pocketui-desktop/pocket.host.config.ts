import { defineHostConfig } from "@pocketjs/framework/host-config";

// The PocketUI gallery on a desktop window that reports a pointer and its
// wheel (input.pointer, input.scroll) at raster density 1: what
// tests/pocketui-sim.test.ts drives with a pointer. No stock host contract
// lists input.scroll yet, so this one is a fixture.
export default defineHostConfig({
  host: "./pocket.host.json",
  app: {
    id: "dev.pocket-nexus.pocketui-desktop-test",
    title: "PocketUI Gallery",
    version: "0.1.0",
    entry: "main.tsx",
    output: "pocketui-desktop-test",
    framework: "solid",
    viewport: { dynamic: { default: [640, 400], min: [320, 240], max: [1600, 1200] } },
    features: ["text.glyphs.baked", "input.buttons", "input.pointer", "input.scroll", "display.viewport.live"],
  },
});
