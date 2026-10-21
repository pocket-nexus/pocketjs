import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "ipodtouch4-dev",
  "platform": "ios",
  "form": "takeover",
  "display": {
    "physicalViewport": [
      640,
      960
    ],
    "logicalViewports": [
      [
        320,
        480
      ],
      [
        480,
        320
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
    "io.offload",
    "ui.physics"
  ],
  "tickHz": 60
});
