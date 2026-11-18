import { defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  hosts: ["symbian-e7-dev", "ipodtouch4-dev"],
  app: {
    id: "dev.pocket-nexus.clear",
    title: "Pocket Clear",
    version: "0.1.0",
    entry: "main.tsx",
    output: "clear-main",
    framework: "vue-vapor",
    viewport: {
      fixed: { logical: [[320, 480], [360, 800], [360, 640]], presentation: "native" },
      dynamic: { default: [360, 640], min: [360, 640], max: [360, 640] },
    },
    features: ["input.touch", "text.glyphs.baked", "io.offload"],
  },
});
