import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "redmi-1s-dev",
  "platform": "android",
  "form": "takeover",
  "display": {
    "physicalViewport": [
      720,
      1280
    ],
    "logicalViewports": [
      [
        360,
        640
      ]
    ],
    "presentations": [
      "native"
    ],
    "rasterDensity": 2
  },
  "capabilities": [
    "input.touch",
    "text.glyphs.baked",
    "io.offload"
  ],
  "tickHz": 60
});
