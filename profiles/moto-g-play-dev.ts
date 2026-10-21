import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "moto-g-play-dev",
  "platform": "android",
  "form": "takeover",
  "display": {
    "physicalViewport": [
      720,
      1600
    ],
    "logicalViewports": [
      [
        360,
        800
      ]
    ],
    "presentations": [
      "native"
    ],
    "rasterDensity": 2
  },
  "capabilities": [
    "input.buttons",
    "input.touch",
    "text.glyphs.baked",
    "io.offload"
  ],
  "tickHz": 60
});
