import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  hosts: ["psp", "psp-runtime", "vita", "web-app", "macos-embedded", "pocketbook"],
  app: {
    id: "dev.pocket-nexus.vue.sfc.lab",
    title: "PocketJS: Vue SFC Feature Lab",
    version: "0.6.0",
    entry: "main.ts",
    output: "vue-sfc-lab-main",
    framework: "vue-vapor",
    viewport: { fixed: { logical: [480, 272], presentation: "integer-fit" } },
    features: ["text.glyphs.baked", "input.buttons"],
  },
});
